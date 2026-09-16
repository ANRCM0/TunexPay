"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Status, time } from "./common";
import { BillSettingsPanel } from "./bill-settings";

type Collector = { enabled: boolean; status: string; cursorAt?: string; lastSuccessAt?: string; lastError?: string; nextPage?: number };

export function BillChannel() {
  const { data: collector, loading, error, reload } = useApi<Collector>("/channels/alipay-bill/collector", 10_000);
  return <>
    <PageHead eyebrow="Alipay Bill" title="账单收款配置" copy="个人收款码承接、流水识别与内置采集器；保存后动态生效，无需重启。" action={<Link className="button secondary" href="/channels">返回渠道状态</Link>} />
    <Section title="采集器状态" action={<button className="button secondary" onClick={() => void reload()}><RefreshCw size={13} />刷新</button>}>
      <LoadingState loading={loading} error={error}>
        {collector && <div className="detail-list">
          <Row label="运行状态" value={<Status value={collector.enabled ? "ACTIVE" : "DISABLED"} />} />
          <Row label="采集状态" value={collector.status} />
          <Row label="最后成功查询" value={collector.lastSuccessAt ? time(collector.lastSuccessAt) : "尚未查询成功"} />
          <Row label="采集断点" value={collector.cursorAt ? time(collector.cursorAt) : "—"} />
          <Row label="当前页码" value={collector.nextPage != null ? String(collector.nextPage) : "—"} />
          <Row label="最近错误" value={collector.lastError || "—"} error={Boolean(collector.lastError)} />
        </div>}
      </LoadingState>
    </Section>
    <BillSettingsPanel onSaved={reload} />
  </>;
}

function Row({ label, value, error = false }: { label: string; value: React.ReactNode; error?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={error ? "row-error" : ""}>{value}</strong></div>;
}
