import { randomUUID } from "node:crypto";
import { Prisma, type ChannelInstance, type PaymentChannelCode } from "@prisma/client";
import { z } from "zod";
import { config, type Config } from "../config.js";
import { db } from "../db.js";
import { generateId, openSealed, seal } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { legacyChannelId, paymentChannelScope } from "../lib/channel-scope.js";
import { alipayTime, accountLogPage } from "../lib/alipay-account-log.js";
import { AlipayChannel } from "../channels/alipay.js";
import { paymentPlugins } from "../channels/plugins.js";
import { billIdentity, initialBillSettings, loadBillSettings, mergeBillSettings, publicBillSettings, type BillSettings } from "./bill-settings-service.js";

/**
 * 通道 ID 由运营在创建时填写：它是支付单、回执线索与采集进度共同引用的稳定标识，
 * 一旦承载过资金数据就不能再改，因此创建时校验格式、创建后不可修改。
 */
export const channelIdSchema = z.string().trim().min(3).max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "通道 ID 只能包含小写字母、数字与中划线，且必须以字母或数字开头");

export const channelInput = z.object({
  id: channelIdSchema.optional(),
  name: z.string().trim().min(1).max(120), enabled: z.boolean(),
  plugin: z.enum(["ALIPAY", "ALIPAY_BILL", "MOCK"]),
  revision: z.number().int().positive().optional(), settings: z.record(z.string(), z.unknown()),
}).strict();

/** 插件是内置的固定集合；创建通道时必须选一个真实存在的插件作为对接。 */
function assertKnownPlugin(plugin: PaymentChannelCode): void {
  if (!paymentPlugins[plugin]) throw new AppError("PLUGIN_NOT_FOUND", "所选支付插件不存在，请在「支付插件」页面确认可用插件", 422);
}

export function decodeChannel(row: ChannelInstance): BillSettings {
  try { return JSON.parse(openSealed(row.payloadEncrypted)) as BillSettings; }
  catch { throw new AppError("CHANNEL_SETTINGS_UNREADABLE", "通道配置无法解密，请核对加密密钥", 503); }
}

export function channelRuntime(settings: BillSettings): Config {
  return { ...config(), ALIPAY_APP_ID: settings.appId, ALIPAY_PRIVATE_KEY: settings.privateKey, ALIPAY_PUBLIC_KEY: settings.publicKey, ALIPAY_GATEWAY: settings.gateway,
    ALIPAY_BILL_ENABLED: settings.enabled, ALIPAY_BILL_QR_CONTENT: settings.qrContent };
}

export async function loadChannel(id: string) {
  const row = await db.channelInstance.findUnique({ where: { id } });
  if (!row) throw new AppError("CHANNEL_NOT_FOUND", "通道不存在", 404);
  return row;
}

/**
 * 解析一张支付单应该用哪个通道：优先用它自己绑定的 channelId；历史数据里 channelId 为空时，
 * 回落到同插件的既有默认通道（保持历史支付单仍可查单/退款）。
 *
 * 注意：归档通道允许在这里被解析出来 —— 归档只阻断新支付，不能让已经动过钱的历史支付单
 * 失去查单、关闭与原路退款的能力，否则保留密钥就没有意义了。
 */
export async function adapterForPayment(payment: { channel: PaymentChannelCode; channelId?: string | null }) {
  const id = payment.channelId || legacyChannelId(payment.channel);
  const row = await db.channelInstance.findUnique({ where: { id } });
  if (!row || row.plugin !== payment.channel) throw new AppError("CHANNEL_BINDING_INVALID", "支付单通道绑定异常", 409);
  // Disabling new orders must not prevent callbacks, queries, closure or refunds.
  return paymentPlugins[row.plugin].create(row.id, channelRuntime(decodeChannel(row)));
}

/**
 * 取一个「可用于新建支付」的通道：必须存在、插件匹配、未归档、已启用。
 * 归档通道在这里被明确拒绝，错误信息指向运营该做什么。
 */
export async function requireActiveChannel(channelId: string, plugin: PaymentChannelCode): Promise<ChannelInstance> {
  const row = await db.channelInstance.findUnique({ where: { id: channelId } });
  if (!row || row.plugin !== plugin) throw new AppError("CHANNEL_BINDING_INVALID", "支付单通道绑定异常", 409);
  if (row.archivedAt) throw new AppError("CHANNEL_ARCHIVED", "该通道已删除，不能再发起新支付，请为应用重新分配通道", 409);
  return row;
}

export async function publicChannel(row: ChannelInstance) {
  const settings = row.plugin === "ALIPAY_BILL" ? (await loadBillSettings(db, false, row.id)).settings : decodeChannel(row);
  const test = row.testPaymentNo ? await db.payment.findUnique({ where: { paymentNo: row.testPaymentNo }, select: { paymentNo: true, status: true, channelId: true, paidAt: true } }) : null;
  const status = verificationStatus(row, test);
  return { id: row.id, name: row.name, plugin: row.plugin, enabled: row.enabled, revision: row.revision,
    archivedAt: row.archivedAt,
    settings: publicBillSettings(settings, row.revision, row.updatedAt),
    checkStatus: status, checkMessage: row.checkRevision === row.revision ? row.checkMessage : "配置尚未检测", checkedAt: row.checkedAt,
    testPayment: test ? { ...test, currentRevision: row.testRevision === row.revision, cashierUrl: `${config().WEB_PUBLIC_URL}/cashier/${test.paymentNo}` } : null,
    webhookUrl: `${config().API_PUBLIC_URL}/api/v1/channels/alipay/webhook`,
    watcherUrl: `${config().API_PUBLIC_URL}/api/v1/channels/alipay-bill/${row.id}/flows`,
  };
}

type TestEvidence = { channelId: string | null; status: string; paidAt: Date | null } | null;
export function verificationStatus(row: ChannelInstance, test: TestEvidence): string {
  const current = row.checkRevision === row.revision ? row.checkStatus : "UNCHECKED";
  const failedAfterPayment = current === "FAILED" && (!test?.paidAt || !row.checkedAt || row.checkedAt >= test.paidAt);
  const paid = row.testRevision === row.revision && test?.channelId === row.id && test.status === "SUCCESS";
  return paid && row.plugin !== "MOCK" && !failedAfterPayment ? "PAYMENT_VERIFIED" : current;
}

export async function assertChannelVerified(row: ChannelInstance, client: Pick<Prisma.TransactionClient, "payment"> = db) {
  const test = row.testPaymentNo ? await client.payment.findUnique({ where: { paymentNo: row.testPaymentNo }, select: { channelId: true, status: true, paidAt: true } }) : null;
  if (!row.enabled || !["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(verificationStatus(row, test))) throw new AppError("CHANNEL_NOT_CHECKED", "通道尚未启用或当前配置未通过检测，请在后台重新检测", 409);
}

/**
 * 通道列表。默认只显示在用通道；归档通道（承载过资金数据后被删除的）不再出现，
 * 需要追溯时用 includeArchived 显式查看。
 */
export async function listChannels(includeArchived = false) {
  const rows = await db.channelInstance.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return Promise.all(rows.map(publicChannel));
}

export type DeletedChannel = {
  id: string;
  name: string;
  archived: boolean;
  /** 该通道承载过的资金数据计数；archived=false 时全为 0。 */
  retained: { payments: number; refunds: number };
};

/**
 * 删除通道。通道行里存着对接密钥，硬删会让历史支付单的查单、关闭与原路退款永久失效，
 * 所以分两条路径（与应用删除同构）：
 *
 *  - 有资金数据（支付单、退款、回执线索、采集进度）→ **归档**：打 archivedAt、停用、
 *    从列表与分配选项移除、不能再建新支付；行与密钥保留，历史单据仍可查单/退款，DBA 可还原。
 *  - 从未产生过资金数据 → 真删行。
 *
 * 被任何一个应用指定为收款通道时一律拒绝：否则应用会指向一个已消失的通道，新支付全部失败。
 */
export async function deleteChannel(id: string): Promise<DeletedChannel> {
  const row = await loadChannel(id);
  if (row.archivedAt) return { id: row.id, name: row.name, archived: true, retained: { payments: 0, refunds: 0 } };

  const assigned = await db.application.count({ where: { defaultChannelId: id, archivedAt: null } });
  if (assigned) {
    throw new AppError("CHANNEL_IN_USE", `仍有 ${assigned} 个应用使用该通道，请先在「支付通道 → 通道分配」里把它们改派到其他通道`, 409);
  }

  const scope = paymentChannelScope(id, row.plugin);
  const [payments, refunds, receipts, collector] = await Promise.all([
    db.payment.count({ where: scope }),
    // 退款要按同一口径统计（含历史 channelId 为空、归属原账号的支付单），
    // 否则提示里的「保留 N 笔退款」会少报，运营会误以为可以安全删除。
    db.refund.count({ where: { payment: scope } }),
    db.receipt.count({ where: { accountKey: id } }),
    db.billCollectorState.count({ where: { id } }),
  ]);
  const retained = { payments, refunds };

  if (!payments && !refunds && !receipts && !collector) {
    await db.channelInstance.delete({ where: { id } });
    return { id: row.id, name: row.name, archived: false, retained };
  }

  await db.channelInstance.update({ where: { id }, data: { archivedAt: new Date(), enabled: false } });
  return { id: row.id, name: row.name, archived: true, retained };
}

export function mergeChannelSettings(plugin: PaymentChannelCode, previous: BillSettings, raw: Record<string, unknown>, enabled: boolean) {
  if (plugin === "MOCK") return initialBillSettings(false);
  const { revision: _revision, updatedAt: _updated, privateKeyConfigured: _private, publicKeyConfigured: _public, watcherTokenConfigured: _watcher, ...fields } = raw;
  const next = mergeBillSettings(previous, { ...previous, ...fields, revision: 1,
    enabled: plugin === "ALIPAY_BILL" && enabled,
    collectorEnabled: plugin === "ALIPAY_BILL" ? fields.collectorEnabled ?? previous.collectorEnabled : false,
  });
  if (plugin === "ALIPAY" && enabled && (!/^\d{10,40}$/.test(next.appId) || !next.privateKey || !next.publicKey)) {
    throw new AppError("CHANNEL_CONFIG_INCOMPLETE", "请先填写支付宝 App ID、应用私钥和支付宝公钥", 422);
  }
  return next;
}

export async function saveChannel(raw: unknown, id?: string) {
  const input = channelInput.parse(raw);
  assertKnownPlugin(input.plugin);
  // 通道 ID 只允许在创建时指定；修改时一律沿用路径里的 id，避免把一张通道改成另一张的身份。
  const channelId = id || input.id || generateId("chn");
  // 保留 Serializable：revision 冲突检查依赖「锁住通道行之后再重读」，这次重读必须是加锁读才能看到
  // 最新已提交的 revision，否则并发保存可能都通过校验、互相覆盖配置。
  const row = await db.$transaction(async tx => {
    if (id) await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${id} FOR UPDATE`;
    const current = id ? await tx.channelInstance.findUnique({ where: { id } }) : null;
    if (id && !current) throw new AppError("CHANNEL_NOT_FOUND", "通道不存在", 404);
    if (current?.archivedAt) throw new AppError("CHANNEL_ARCHIVED", "该通道已删除，不能修改配置", 409);
    if (current && (input.revision !== current.revision || input.plugin !== current.plugin)) throw new AppError("CHANNEL_CONFIG_CONFLICT", "配置版本已变更或插件不匹配，请重新加载", 409);
    if (current?.checkLockedUntil && current.checkLockedUntil > new Date()) throw new AppError("CHANNEL_CHECK_RUNNING", "检测进行中，请完成后再保存", 409);
    const previous = current ? (current.plugin === "ALIPAY_BILL" ? (await loadBillSettings(tx, true, id)).settings : decodeChannel(current)) : initialBillSettings(false);
    const next = mergeChannelSettings(input.plugin, previous, input.settings, input.enabled);
    if (current && billIdentity(previous) !== billIdentity(next)) {
      const history = await tx.payment.count({ where: paymentChannelScope(current.id, current.plugin) });
      const state = await tx.billCollectorState.findUnique({ where: { id: current.id } });
      if (history || state) throw new AppError("CHANNEL_ACCOUNT_CHANGE_BLOCKED", "已有支付记录或采集进度，请为新账号创建独立通道；原通道仍可轮换密钥", 409);
    }
    if (input.plugin === "ALIPAY_BILL") {
      // Do not represent one receiving account as two independent amount pools.
      const siblings = await tx.channelInstance.findMany({ where: { plugin: "ALIPAY_BILL", id: { not: channelId }, archivedAt: null } });
      for (const sibling of siblings) {
        const other = (await loadBillSettings(tx, false, sibling.id)).settings;
        if ((next.userId && next.userId === other.userId) || (next.qrContent && next.qrContent === other.qrContent)) throw new AppError("BILL_ACCOUNT_DUPLICATED", "同一收款账号应共用一个通道，再分配给多个应用", 409);
      }
      await tx.billChannelSettings.upsert({ where: { id: channelId }, create: { id: channelId, payloadEncrypted: seal(JSON.stringify(next)) }, update: { payloadEncrypted: seal(JSON.stringify(next)), revision: { increment: 1 } } });
      await tx.billCollectorState.updateMany({ where: { id: channelId }, data: { nextRunAt: new Date() } });
    }
    const data = { name: input.name, enabled: input.enabled, payloadEncrypted: seal(JSON.stringify(next)), checkStatus: "UNCHECKED", checkRevision: null, checkMessage: null, checkedAt: null, testRevision: null };
    return current ? tx.channelInstance.update({ where: { id: channelId }, data: { ...data, revision: { increment: 1 } } })
      : tx.channelInstance.create({ data: { ...data, id: channelId, plugin: input.plugin } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return publicChannel(row);
}

export async function checkChannel(id: string, revision: number) {
  const lease = randomUUID();
  const claimed = await db.channelInstance.updateMany({ where: { id, revision, archivedAt: null, OR: [{ checkLockedUntil: null }, { checkLockedUntil: { lte: new Date() } }] }, data: { checkLease: lease, checkLockedUntil: new Date(Date.now() + 60_000) } });
  if (!claimed.count) throw new AppError("CHANNEL_CHECK_CONFLICT", "配置已变更或检测正在进行，请刷新后重试", 409);
  let status = "FAILED", message = "检测失败";
  try {
    const row = await loadChannel(id);
    const settings = row.plugin === "ALIPAY_BILL" ? (await loadBillSettings(db, false, id)).settings : decodeChannel(row);
    // Validation precedes all outbound requests, including legacy environment imports.
    mergeChannelSettings(row.plugin, settings, {}, true);
    if (row.plugin === "MOCK") {
      if (!config().MOCK_CHANNEL_ENABLED || !config().MOCK_CHANNEL_TOKEN) throw new AppError("MOCK_DISABLED", "请启用 Mock 并配置令牌");
      status = "SIMULATED"; message = "模拟插件配置正常；未验证真实收款";
    } else if (row.plugin === "ALIPAY_BILL" && !settings.collectorEnabled) {
      status = "NEEDS_PAYMENT"; message = "外部 Watcher 无法通过配置证明在线，请完成小额实付并等待流水匹配";
    } else {
      const adapter = new AlipayChannel(channelRuntime(settings));
      if (row.plugin === "ALIPAY") {
        await adapter.query(`txp_check_${randomUUID().replaceAll("-", "")}`);
        message = "真实查单接口、请求签名和响应验签通过；收款权限及回调请继续实付验收";
      } else {
        const end = new Date(Date.now() - 60_000);
        const response = await adapter.queryAccountLogs({ bill_user_id: settings.userId, start_time: alipayTime(new Date(end.getTime() - 300_000)), end_time: alipayTime(end), page_no: 1, page_size: 100 });
        accountLogPage(response, 1, 100);
        message = "真实账务查询和响应验签通过；收款码归属与到账匹配请继续实付验收";
      }
      status = "API_VERIFIED";
    }
  } catch (error) {
    const code = error instanceof AppError && /^[A-Z0-9_.-]{1,80}$/.test(error.code) ? error.code : "CHECK_FAILED";
    message = `检测未通过（${code}），请核对账号、密钥、接口权限与网络后重试`;
  } finally {
    await db.channelInstance.updateMany({ where: { id, revision, checkLease: lease }, data: { checkStatus: status, checkMessage: message, checkedAt: new Date(), checkRevision: revision, checkLease: null, checkLockedUntil: null } });
  }
  return publicChannel(await loadChannel(id));
}

export async function assignChannel(applicationId: string, channelId: string) {
  const row = await loadChannel(channelId);
  if (row.archivedAt) throw new AppError("CHANNEL_ARCHIVED", "该通道已删除，不能分配给应用", 409);
  if (!row.enabled) throw new AppError("CHANNEL_DISABLED", "请先启用通道", 409);
  const view = await publicChannel(row);
  if (!["API_VERIFIED", "PAYMENT_VERIFIED", "SIMULATED"].includes(view.checkStatus)) throw new AppError("CHANNEL_NOT_CHECKED", "请先通过接口检测或实付验收后再分配通道", 409);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM channel_instances WHERE id = ${channelId} FOR UPDATE`;
    const latest = await tx.channelInstance.findUniqueOrThrow({ where: { id: channelId } });
    if (!latest.enabled || latest.revision !== row.revision) throw new AppError("CHANNEL_CONFIG_CONFLICT", "通道配置已变更，请重新检测", 409);
    await assertChannelVerified(latest, tx);
    const app = await tx.application.findUnique({ where: { id: applicationId } });
    if (!app) throw new AppError("APPLICATION_NOT_FOUND", "应用不存在", 404);
    await tx.application.update({ where: { id: applicationId }, data: { defaultChannel: row.plugin, defaultChannelId: row.id, routingGroupId: null } });
    return { id: applicationId, defaultChannel: row.plugin, defaultChannelId: row.id, routingGroupId: null };
  });
}
