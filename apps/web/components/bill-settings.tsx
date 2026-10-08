"use client";

import { Button, Checkbox, Form, Input, Select, Switch } from "@arco-design/web-react";
import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { ConfirmModal, LoadingState, Section } from "./common";

type Draft = {
  revision: number; enabled: boolean; collectorEnabled: boolean; appId: string; userId: string;
  gateway: string; qrContent: string; matchMode: "REMARK" | "AMOUNT";
  validSeconds: number; amountOffsetMax: number; pollSeconds: number;
  lookbackSeconds: number; overlapSeconds: number; lagSeconds: number;
};
type View = Draft & { privateKeyConfigured: boolean; publicKeyConfigured: boolean; watcherTokenConfigured: boolean; updatedAt: string };
const emptySecrets = { privateKey: "", publicKey: "", watcherToken: "" };
const emptyClear = { privateKey: false, publicKey: false, watcherToken: false };

// 匹配模式的选项文案与顺序保持原样：它解释的是「内置采集」和「外部 Watcher」两种接入方式，
// 换成更短的名字会让用户分不清该选哪个。
const MATCH_MODE_OPTIONS = [
  { label: "金额偏移（内置采集推荐）", value: "AMOUNT" },
  { label: "付款备注（仅外部 Watcher）", value: "REMARK" },
];

export function BillSettingsPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const { data, loading, error, reload } = useApi<View>("/channels/alipay-bill/settings");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState(emptySecrets);
  const [clear, setClear] = useState(emptyClear);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [confirmSecretClear, setConfirmSecretClear] = useState(false);
  const hasSecretClear = Object.values(clear).some(Boolean);
  const dirty = Boolean(draft && data && (
    Object.entries(draft).some(([key, value]) => data[key as keyof View] !== value) ||
    Object.values(secrets).some(Boolean) || hasSecretClear
  ));
  const requestReload = () => {
    if (saving) return;
    if (dirty) setConfirmReload(true);
    else void reload();
  };
  useEffect(() => {
    if (!data) return;
    const { privateKeyConfigured: _private, publicKeyConfigured: _public, watcherTokenConfigured: _token, updatedAt: _updated, ...values } = data;
    setDraft(values); setSecrets(emptySecrets); setClear(emptyClear);
  }, [data]);
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => current ? { ...current, [key]: value } : current); }
  async function save(confirmedClear = false) {
    if (!draft || saving) return;
    if (hasSecretClear && !confirmedClear) { setConfirmSecretClear(true); return; }
    setSaving(true); setNotice(null);
    try {
      await api("/channels/alipay-bill/settings", { method: "POST", body: JSON.stringify({ ...draft,
        privateKey: clear.privateKey ? null : secrets.privateKey,
        publicKey: clear.publicKey ? null : secrets.publicKey,
        watcherToken: clear.watcherToken ? null : secrets.watcherToken,
      }) });
      setSecrets(emptySecrets); setClear(emptyClear);
      setNotice({ ok: true, text: "已保存。新订单立即使用新配置，采集器会在当前页结束后切换，无需重启容器。" });
      await reload(); await onSaved();
    } catch (cause) { setNotice({ ok: false, text: cause instanceof Error ? cause.message : "保存失败" }); }
    finally { setSaving(false); }
  }
  return <Section title="支付宝账单收款配置" action={<span className="muted">数据库持久化 · 密钥加密 · 仅影响账单通道</span>} className="detail-section">
    {confirmReload && <ConfirmModal title="放弃未保存的账单配置？" copy="当前的配置修改和临时输入的密钥将丢失，并重新读取服务器已保存的内容。" danger confirmLabel="放弃并重新加载" onClose={() => setConfirmReload(false)} onConfirm={() => { setConfirmReload(false); void reload(); }} />}
    {confirmSecretClear && <ConfirmModal title="确认清除已保存密钥？" copy="你选择了清除已保存的密钥或令牌。保存后可能立即影响支付验签或账单采集，且无法从管理台恢复原密钥。" danger confirmLabel="确认清除并保存" working={saving} onClose={() => setConfirmSecretClear(false)} onConfirm={() => { setConfirmSecretClear(false); void save(true); }} />}
    {notice && <div className={`operation-notice ${notice.ok ? "ok" : "error"}`}>{notice.text}</div>}
    <LoadingState loading={loading} error={error}>
      {draft && data && /* Arco Form 负责提交与校验编排；字段本身仍是受控的本地草稿，
        这样才能在「重新加载（放弃未保存修改）」时把服务端值整体回灌到一处状态。 */
      <Form layout="vertical" onSubmit={() => void save()}>
        <fieldset className="bill-settings-fields" disabled={saving}>
          {/* 开关用 <label> 包住 Arco Switch：点击文字也能切换（与原来的自定义 Toggle 一致），
              同时给按钮一个明确的可访问名称，读屏不会只念「开关」。 */}
          <div className="bill-settings-switches">
            <label><Switch checked={draft.enabled} onChange={value => update("enabled", value)} aria-label="启用账单收款（接收新订单）" /><span>启用账单收款（接收新订单）</span></label>
            <label><Switch checked={draft.collectorEnabled} onChange={value => update("collectorEnabled", value)} aria-label="启用自动账单采集" /><span>启用自动账单采集</span></label>
          </div>
          <p className="muted">暂停新订单时可保留采集，用于确认已有订单。停止采集不会撤销已接收流水，也无法停用支付宝静态收款码。</p>
          <div className="bill-settings-grid">
            <label>支付宝 App ID<Input value={draft.appId} maxLength={40} onChange={value => update("appId", value)} autoComplete="off" /></label>
            <label>收款支付宝用户 ID<Input value={draft.userId} maxLength={32} placeholder="2088 开头的 16 位用户 ID" onChange={value => update("userId", value)} autoComplete="off" /></label>
            <label className="bill-settings-wide">支付宝官方网关<Input value={draft.gateway} onChange={value => update("gateway", value)} required /></label>
            <label className="bill-settings-wide">收款码内容<Input.TextArea rows={3} value={draft.qrContent} maxLength={4000} placeholder="填写从收款二维码解析出的完整内容，不是图片文件路径" onChange={value => update("qrContent", value)} /></label>
            <label>匹配模式<Select value={draft.matchMode} onChange={value => update("matchMode", value as Draft["matchMode"])} options={MATCH_MODE_OPTIONS} /></label>
            <NumberField label="识别有效期（秒）" value={draft.validSeconds} min={60} max={3600} onChange={value => update("validSeconds", value)} />
            <NumberField label="最大金额偏移（分）" value={draft.amountOffsetMax} min={0} max={99} onChange={value => update("amountOffsetMax", value)} />
            <NumberField label="查询间隔（秒）" value={draft.pollSeconds} min={3} max={3600} onChange={value => update("pollSeconds", value)} />
            <label>应用 RSA2 私钥（{data.privateKeyConfigured ? "已配置" : "未配置"}）<Input.TextArea rows={4} value={secrets.privateKey} disabled={clear.privateKey} autoComplete="off" spellCheck={false} placeholder="留空保留原密钥；支持 PEM 或 PKCS8 裸密钥" onChange={value => setSecrets(current => ({ ...current, privateKey: value }))} /></label>
            <label>支付宝 RSA2 公钥（{data.publicKeyConfigured ? "已配置" : "未配置"}）<Input.TextArea rows={4} value={secrets.publicKey} disabled={clear.publicKey} autoComplete="off" spellCheck={false} placeholder="不是应用公钥；留空保留原配置" onChange={value => setSecrets(current => ({ ...current, publicKey: value }))} /></label>
          </div>
          <details className="bill-settings-advanced"><summary>补拉参数、外部 Watcher 与密钥清除</summary>
            <div className="bill-settings-grid">
              <NumberField label="首次启动回看（秒）" value={draft.lookbackSeconds} min={300} max={86400} onChange={value => update("lookbackSeconds", value)} />
              <NumberField label="重复补拉窗口（秒）" value={draft.overlapSeconds} min={60} max={3600} onChange={value => update("overlapSeconds", value)} />
              <NumberField label="最新流水查询延迟（秒）" value={draft.lagSeconds} min={2} max={300} onChange={value => update("lagSeconds", value)} />
              <label>外部 Watcher 令牌（{data.watcherTokenConfigured ? "已配置" : "可选"}）<Input.Password value={secrets.watcherToken} disabled={clear.watcherToken} maxLength={200} autoComplete="new-password" placeholder="内置采集不需要；留空保留" onChange={value => setSecrets(current => ({ ...current, watcherToken: value }))} /></label>
            </div>
            <div className="bill-settings-switches">{(["privateKey", "publicKey", "watcherToken"] as const).map(key => <Checkbox key={key} checked={clear[key]} onChange={checked => setClear(current => ({ ...current, [key]: checked }))}>清除{key === "privateKey" ? "应用私钥" : key === "publicKey" ? "支付宝公钥" : "外部令牌"}</Checkbox>)}</div>
          </details>
          <p className="muted">已有账单支付记录或采集断点后，禁止直接更换账号、网关和收款码。密钥可轮换；清除必需密钥前请关闭相应开关。首次回看参数不会重置已有断点。</p>
          {hasSecretClear && <div className="dialog-warning" role="status">保存将清除选中的已保存密钥或令牌；请确认相关收款与采集能力不会因此中断。</div>}
          <div className="bill-settings-actions">
            <Button type="primary" htmlType="submit" loading={saving}>{saving ? "保存中…" : "保存账单配置"}</Button>
            <Button type="secondary" disabled={saving} onClick={requestReload}>重新加载{dirty ? "（有未保存修改）" : ""}</Button>
            <span className="muted">版本 {data.revision}</span>
          </div>
        </fieldset>
      </Form>}
    </LoadingState>
  </Section>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  // 保留 type=number + required/min/max 的原生约束：浏览器会在提交前拦住空值与越界值，
  // 与迁移前那批 <input type="number"> 的行为一致，不必再手写一套校验提示。
  return <label>{label}<Input type="number" value={String(value)} min={min} max={max} step={1} required onChange={next => onChange(Number(next))} /></label>;
}
