"use client";
import { Button, Checkbox, Form, Input, Select, Switch } from "@arco-design/web-react";
import { useState } from "react";
import { api, useApi } from "../lib/api";
import { statusText } from "./common";
import type { Channel } from "./channels";

export type PluginOption = { code: string; name: string; description: string; capabilities: string[] };

const defaults: Record<string, string | number | boolean> = {
  appId: "", userId: "", gateway: "https://openapi.alipay.com/gateway.do", qrContent: "",
  collectorEnabled: false, matchMode: "AMOUNT", validSeconds: 300, amountOffsetMax: 99,
  pollSeconds: 10, lookbackSeconds: 3600, overlapSeconds: 300, lagSeconds: 15,
};

// 网关是签名与证书校验的地址，枚举成固定选项可以避免手工输错——填错网关的后果是
// 支付全部失败，而且报错只会表现为验签不过，很难从现象定位到是地址写错了。
const GATEWAY_OPTIONS = [
  { label: "生产环境", value: "https://openapi.alipay.com/gateway.do" },
  { label: "沙箱环境", value: "https://openapi-sandbox.dl.alipaydev.com/gateway.do" },
  { label: "旧版沙箱", value: "https://openapi.alipaydev.com/gateway.do" },
];

const MATCH_MODE_OPTIONS = [
  { label: "金额偏移（内置采集推荐）", value: "AMOUNT" },
  { label: "付款备注（仅外部 Watcher）", value: "REMARK" },
];

// [字段, 标签, 最小值, 最大值]：六组几乎相同的数字输入，用表格驱动一次写完，
// 免得校验参数在复制粘贴中写岔（min/max 必须与实际采集器的容忍范围一致）。
const ADVANCED_FIELDS = [
  ["validSeconds", "识别有效期（秒）", 60, 3600],
  ["amountOffsetMax", "最大金额偏移（分）", 0, 99],
  ["pollSeconds", "采集间隔（秒）", 3, 3600],
  ["overlapSeconds", "重叠补拉（秒）", 60, 3600],
  ["lagSeconds", "采集延迟（秒）", 2, 300],
  ["lookbackSeconds", "首次回看（秒）", 300, 86400],
] as const;

type SecretKey = "privateKey" | "publicKey" | "watcherToken";

const SECRET_LABELS: Record<SecretKey, string> = { privateKey: "应用私钥", publicKey: "支付宝公钥", watcherToken: "Watcher 令牌" };

export function ChannelEditor({ plugin, channel, plugins, onSaved, onClose }: { plugin?: string; channel?: Channel; plugins: PluginOption[]; onSaved: () => Promise<void>; onClose: () => void }) {
  const creating = !channel;
  // 创建时必须显式选择插件作为对接；修改时插件不可改（通道 ID 与插件是支付单的绑定身份）。
  const [selectedPlugin, setSelectedPlugin] = useState(channel?.plugin || plugin || "");
  const [channelId, setChannelId] = useState("");
  const [name, setName] = useState(channel?.name || "");
  const [enabled, setEnabled] = useState(channel?.enabled || false);
  const [settings, setSettings] = useState({ ...defaults, ...channel?.settings });
  const [secrets, setSecrets] = useState({ privateKey: "", publicKey: "", watcherToken: "" });
  const [clear, setClear] = useState({ privateKey: false, publicKey: false, watcherToken: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, value: string | number | boolean) => setSettings(previous => ({ ...previous, [key]: value }));
  const activePlugin = channel?.plugin || selectedPlugin;

  // 表单值由本地状态持有（而不是交给 Form 的 store）：编辑态的默认值来自远端通道对象，
  // 密钥、清除标记、采集参数又互相关联，保持单一数据源比拼装 field 绑定更不容易出错。
  // 因此这里用 Form 承担「提交语义 + 版式」，字段约束仍走控件声明（required/min/max）与提交时的显式校验。
  async function submit() {
    if (!activePlugin) { setError("请先选择要对接的支付插件"); return; }
    setSaving(true);
    setError("");
    try {
      await api(channel ? `/channel-instances/${channel.id}` : "/channel-instances", {
        method: "POST",
        body: JSON.stringify({
          ...(creating && channelId.trim() ? { id: channelId.trim() } : {}),
          name, enabled, plugin: activePlugin, revision: channel?.revision,
          settings: {
            ...settings,
            privateKey: clear.privateKey ? null : secrets.privateKey,
            publicKey: clear.publicKey ? null : secrets.publicKey,
            watcherToken: clear.watcherToken ? null : secrets.watcherToken,
          },
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  // 密钥维护的清除项随插件变化：账单通道额外维护 Watcher 令牌。
  const clearKeys: SecretKey[] = activePlugin === "ALIPAY_BILL" ? ["privateKey", "publicKey", "watcherToken"] : ["privateKey", "publicKey"];

  return <div>
    {channel && activePlugin === "ALIPAY_BILL" && <CollectorStatus id={channel.id} />}

    <Form layout="vertical" onSubmit={() => void submit()}>
      <fieldset className="bill-settings-fields" disabled={saving}>
        {error && <div role="alert" className="operation-notice error">{error}</div>}

        <section className="bill-settings-section">
          <div className="bill-settings-section-head">
            <h3>基础配置</h3>
            <p>选择对接的支付插件，并给通道一个全局唯一的 ID。</p>
          </div>
          <div className="bill-settings-grid">
            {/* 没有绑定 Form 的 field：label 不会自动关联到控件，用 aria-label 补上可访问名称 */}
            <Form.Item label="对接插件" required>
              <Select
                aria-label="对接插件"
                value={activePlugin || undefined}
                placeholder="请选择支付插件"
                disabled={!creating || saving}
                onChange={(value) => setSelectedPlugin(String(value))}
                options={plugins.map(item => ({ label: `${item.name}（${item.code}）`, value: item.code }))}
              />
            </Form.Item>
            {creating
              ? <Form.Item label="通道 ID（可选）" extra={<span className="muted">只能用小写字母、数字与中划线；创建后不可修改，接口与对账会引用它。</span>}>
                <Input aria-label="通道 ID（可选）" value={channelId} disabled={saving} maxLength={60} placeholder="留空自动生成，例如 alipay-shop1" autoComplete="off" spellCheck={false} onChange={(value) => setChannelId(value)} />
              </Form.Item>
              : <Form.Item label="通道 ID" extra={<span className="muted">通道 ID 创建后不可修改。</span>}>
                <Input aria-label="通道 ID" value={channel.id} readOnly disabled />
              </Form.Item>}
            <Form.Item label="通道名称" required>
              <Input aria-label="通道名称" value={name} disabled={saving} required maxLength={120} placeholder="例如：支付宝 · 工作室" onChange={(value) => setName(value)} />
            </Form.Item>
            <Form.Item label="启用新订单">
              <Switch aria-label="启用新订单" checked={enabled} disabled={saving} onChange={(value) => setEnabled(value)} />
            </Form.Item>
          </div>
        </section>

        {activePlugin && activePlugin !== "MOCK" && <section className="bill-settings-section">
          <div className="bill-settings-section-head">
            <h3>支付凭证</h3>
            <p>支付宝开放平台应用参数。密钥留空时会保留已经保存的值。</p>
          </div>
          <div className="bill-settings-grid">
            <Form.Item label="支付宝 App ID">
              <Input aria-label="支付宝 App ID" value={String(settings.appId)} disabled={saving} autoComplete="off" maxLength={40} onChange={(value) => update("appId", value)} />
            </Form.Item>
            <Form.Item label="官方网关">
              <Select aria-label="官方网关" value={String(settings.gateway)} disabled={saving} options={GATEWAY_OPTIONS} onChange={(value) => update("gateway", String(value))} />
            </Form.Item>
            {(["privateKey", "publicKey"] as const).map(key => <Form.Item
              key={key}
              className="bill-settings-wide"
              label={`${key === "privateKey" ? "应用 RSA2 私钥" : "支付宝 RSA2 公钥"}（${settings[`${key}Configured`] ? "已配置" : "未配置"}）`}
            >
              <Input.TextArea
                aria-label={key === "privateKey" ? "应用 RSA2 私钥" : "支付宝 RSA2 公钥"}
                rows={4}
                value={secrets[key]}
                disabled={clear[key] || saving}
                autoComplete="off"
                spellCheck={false}
                placeholder="留空保留原密钥"
                onChange={(value) => setSecrets(previous => ({ ...previous, [key]: value }))}
              />
            </Form.Item>)}
          </div>

          <details className="bill-settings-advanced">
            <summary>密钥维护</summary>
            <div className="bill-settings-switches">
              {clearKeys.map(key => <Checkbox
                key={key}
                checked={clear[key]}
                disabled={saving}
                onChange={(checked) => setClear(previous => ({ ...previous, [key]: checked }))}
              >清除{SECRET_LABELS[key]}</Checkbox>)}
            </div>
          </details>
        </section>}

        {activePlugin === "ALIPAY_BILL" && <section className="bill-settings-section">
          <div className="bill-settings-section-head">
            <h3>账单采集</h3>
            <p>用于个人收款码到账识别与账单匹配。默认参数适合大多数部署。</p>
          </div>
          <div className="bill-settings-grid">
            <Form.Item label="收款用户 ID">
              <Input aria-label="收款用户 ID" value={String(settings.userId)} disabled={saving} maxLength={32} placeholder="2088 开头的 16 位 ID" onChange={(value) => update("userId", value)} />
            </Form.Item>
            <Form.Item label="启用该通道的自动账单采集">
              <Switch aria-label="启用该通道的自动账单采集" checked={Boolean(settings.collectorEnabled)} disabled={saving} onChange={(value) => update("collectorEnabled", value)} />
            </Form.Item>
            <Form.Item className="bill-settings-wide" label="收款码内容">
              <Input.TextArea aria-label="收款码内容" rows={3} maxLength={4000} value={String(settings.qrContent)} disabled={saving} placeholder="二维码解析后的完整内容" onChange={(value) => update("qrContent", value)} />
            </Form.Item>
            <Form.Item label="匹配方式">
              <Select aria-label="匹配方式" value={String(settings.matchMode)} disabled={saving} options={MATCH_MODE_OPTIONS} onChange={(value) => update("matchMode", String(value))} />
            </Form.Item>
            <Form.Item label={`外部 Watcher 令牌（${settings.watcherTokenConfigured ? "已配置" : "未配置"}）`}>
              <Input
                aria-label="外部 Watcher 令牌"
                type="password"
                value={secrets.watcherToken}
                disabled={clear.watcherToken || saving}
                autoComplete="new-password"
                maxLength={200}
                placeholder="不用内置采集时可留空"
                onChange={(value) => setSecrets(previous => ({ ...previous, watcherToken: value }))}
              />
            </Form.Item>
            <p className="muted bill-settings-wide">官方账务接口不下发付款备注，内置采集器只能使用金额匹配；备注匹配需要外部 Watcher。</p>
          </div>

          <details className="bill-settings-advanced">
            <summary>高级采集参数</summary>
            <div className="bill-settings-grid">
              {ADVANCED_FIELDS.map(([key, label, min, max]) => <Form.Item key={key} label={label} required>
                {/* 保留原生 number 输入：浏览器会按 min/max/step 拦住越界值，与迁移前的校验完全一致 */}
                <Input
                  aria-label={label}
                  type="number"
                  required
                  min={min}
                  max={max}
                  step={1}
                  value={String(Number(settings[key]))}
                  disabled={saving}
                  onChange={(value) => update(key, Number(value))}
                />
              </Form.Item>)}
            </div>
          </details>
        </section>}

        {activePlugin === "MOCK" && <section className="bill-settings-section"><p className="muted">模拟通道仍受服务器 Mock 开关和令牌控制，仅用于开发测试，不用于真实收款。</p></section>}

        {channel && activePlugin === "ALIPAY_BILL" && <p className="channel-check-detail">此通道的 Watcher 地址：<code>{channel.watcherUrl}</code></p>}
        <p className="muted">保存后请重新检测。已有交易的通道不能更换账号或网关；如需切换收款账号，请创建新通道后重新分配。</p>
        <div className="bill-settings-actions">
          <Button type="primary" htmlType="submit">{saving ? "保存中…" : "保存通道"}</Button>
          <Button type="secondary" disabled={saving} onClick={onClose}>取消</Button>
        </div>
      </fieldset>
    </Form>
  </div>;
}

function CollectorStatus({ id }: { id: string }) {
  const { data, error } = useApi<{ status: string; lastError?: string; lastSuccessAt?: string }>(`/channel-instances/${id}/collector`, 10_000);
  return <p className="channel-check-detail">采集器：{error || (data ? statusText(data.status) : "加载中…")}{data?.lastError && ` · ${data.lastError}`}{data?.lastSuccessAt && ` · 最近成功 ${new Date(data.lastSuccessAt).toLocaleString("zh-CN")}`}</p>;
}
