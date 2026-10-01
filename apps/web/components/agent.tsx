"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "../lib/api";
import { LoadingState, PageHead, Section, Status, Toast, Toggle, time } from "./common";

type Settings = {
  revision: number; enabled: boolean; baseUrl: string; model: string; maxScope: "READ"|"OPERATE"|"FINANCIAL";
  maxSteps: number; instructions: string; apiKeyConfigured: boolean;
};
type Approval = {
  id: string; action: string; summary: string; requestedBy: string; status: string; expiresAt: string;
  approvedAt: string|null; rejectedAt: string|null; executedAt: string|null; lastError: string|null; createdAt: string;
};
type Inbox = { id:string; provider:string; instanceId:string; chatId:string; senderId:string; text:string; status:string; attempts:number; lastError:string|null; createdAt:string };

export function AgentPanel(){
  const {data:settings,loading,error,reload}=useApi<Settings>("/agent/settings");
  const {data:approvals,loading:approvalsLoading,error:approvalsError,reload:reloadApprovals}=useApi<Approval[]>("/agent/approvals",5000);
  const {data:inbox,loading:inboxLoading,error:inboxError,reload:reloadInbox}=useApi<Inbox[]>("/agent/inbox",5000);
  const [draft,setDraft]=useState<Settings|null>(null);
  const [apiKey,setApiKey]=useState("");
  const [clearKey,setClearKey]=useState(false);
  const [testText,setTestText]=useState("今天支付系统有什么需要我关注的吗？");
  const [testReply,setTestReply]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<{type:"ok"|"error";text:string}|null>(null);

  useEffect(()=>{ if(settings){setDraft(settings);setApiKey("");setClearKey(false);} },[settings]);

  async function save(event:React.FormEvent){
    event.preventDefault(); if(!draft)return; setBusy(true);setNotice(null);
    try{
      await api("/agent/settings",{method:"POST",body:JSON.stringify({
        revision:draft.revision,enabled:draft.enabled,baseUrl:draft.baseUrl,model:draft.model,maxScope:draft.maxScope,maxSteps:draft.maxSteps,instructions:draft.instructions,
        apiKey:clearKey?null:(apiKey||undefined),
      })});
      await reload(); setApiKey("");setClearKey(false);setNotice({type:"ok",text:"Agent 配置已保存。"});
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"保存失败"});}
    finally{setBusy(false);}
  }

  async function test(){
    setBusy(true);setNotice(null);setTestReply("");
    try{
      const result=await api<{data:{reply:string}}>("/agent/test",{method:"POST",body:JSON.stringify({text:testText})});
      setTestReply(result.data.reply);setNotice({type:"ok",text:"Agent 测试完成。"});
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"Agent 测试失败"});}
    finally{setBusy(false);}
  }

  async function decide(id:string,decision:"approve"|"reject"){
    if(decision==="approve"&&!window.confirm("批准后会立即执行该资金/异常动作。确认继续？"))return;
    setBusy(true);setNotice(null);
    try{
      await api(`/agent/approvals/${id}/${decision}`,{method:"POST",body:"{}"});
      await reloadApprovals();setNotice({type:"ok",text:decision==="approve"?"动作已批准并执行。":"动作已拒绝。"});
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"处理失败"});}
    finally{setBusy(false);}
  }

  return <>
    {notice&&<Toast type={notice.type} text={notice.text} onClose={()=>setNotice(null)}/>}
    <PageHead eyebrow="Agent & MCP" title="支付运维 Agent" copy="Agent 复用 MCP 工具权限；资金动作只生成审批请求，必须在这里人工批准后才执行。" />

    <Section title="Agent 模型配置">
      <LoadingState loading={loading} error={error}>{draft&&<form onSubmit={event=>void save(event)}>
        <fieldset className="settings-group" disabled={busy}>
          <div className="settings-group-head"><div><h3>OpenAI-compatible 模型</h3><p>支持 DeepSeek 等兼容 Chat Completions + tool calling 的接口。</p></div><Toggle checked={draft.enabled} onChange={enabled=>setDraft(current=>current?{...current,enabled}:current)} label="启用 Agent"/></div>
          <div className="settings-grid">
            <label>Base URL<input value={draft.baseUrl} onChange={event=>setDraft({...draft,baseUrl:event.target.value})} placeholder="https://api.deepseek.com"/></label>
            <label>模型<input value={draft.model} onChange={event=>setDraft({...draft,model:event.target.value})} placeholder="deepseek-chat"/></label>
            <label>最大工具权限<select value={draft.maxScope} onChange={event=>setDraft({...draft,maxScope:event.target.value as Settings["maxScope"]})}><option value="READ">READ · 只读</option><option value="OPERATE">OPERATE · 运维</option><option value="FINANCIAL">FINANCIAL · 可申请资金审批</option></select></label>
            <label>最大工具步数<input type="number" min={1} max={8} value={draft.maxSteps} onChange={event=>setDraft({...draft,maxSteps:Number(event.target.value)})}/></label>
            <label>API Key（{draft.apiKeyConfigured?"已配置，留空保留":"未配置"}）<input type="password" value={apiKey} autoComplete="new-password" onChange={event=>setApiKey(event.target.value)}/>{draft.apiKeyConfigured&&<span className="field-clear"><input type="checkbox" checked={clearKey} onChange={event=>setClearKey(event.target.checked)}/>清除已保存 Key</span>}</label>
          </div>
          <label>附加系统说明<textarea value={draft.instructions} rows={4} maxLength={4000} onChange={event=>setDraft({...draft,instructions:event.target.value})} placeholder="例如：优先关注业务 Webhook DEAD 和账单采集异常。"/></label>
          <div className="settings-actions"><button className="button" type="submit">{busy?"保存中…":"保存 Agent 配置"}</button></div>
        </fieldset>
      </form>}</LoadingState>
    </Section>

    <Section title="测试对话" action={<span className="muted">使用当前已保存配置</span>}>
      <div className="settings-group">
        <label>问题<textarea rows={3} value={testText} onChange={event=>setTestText(event.target.value)}/></label>
        <div className="settings-actions"><button className="button secondary" disabled={busy||!settings?.enabled} type="button" onClick={()=>void test()}>运行一次 Agent</button></div>
        {testReply&&<pre style={{whiteSpace:"pre-wrap",margin:0}}>{testReply}</pre>}
      </div>
    </Section>

    <Section title="待审批动作" action={<button className="link-button" type="button" onClick={()=>void reloadApprovals()}>刷新</button>}>
      <LoadingState loading={approvalsLoading} error={approvalsError} empty={!approvals?.length} emptyText="暂无 Agent 审批请求">
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>动作</th><th>说明</th><th>状态</th><th>到期</th><th></th></tr></thead>
          <tbody>{approvals?.map(row=><tr key={row.id}><td>{time(row.createdAt)}</td><td><code>{row.action}</code></td><td>{row.summary}{row.lastError&&<div className="row-error">{row.lastError}</div>}</td><td><Status value={row.status}/></td><td>{time(row.expiresAt)}</td><td>{row.status==="PENDING"&&<><button className="link-button" disabled={busy} onClick={()=>void decide(row.id,"approve")}>批准</button> <button className="link-button" disabled={busy} onClick={()=>void decide(row.id,"reject")}>拒绝</button></>}</td></tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>

    <Section title="Agent 收件箱" action={<button className="link-button" type="button" onClick={()=>void reloadInbox()}>刷新</button>}>
      <LoadingState loading={inboxLoading} error={inboxError} empty={!inbox?.length} emptyText="还没有 Telegram / 飞书 Agent 消息">
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>实例</th><th>消息</th><th>状态</th><th>尝试</th></tr></thead>
          <tbody>{inbox?.map(row=><tr key={row.id}><td>{time(row.createdAt)}</td><td>{row.provider}<div className="muted">{row.chatId}</div></td><td><code>{row.instanceId}</code></td><td>{row.text}{row.lastError&&<div className="row-error">{row.lastError}</div>}</td><td><Status value={row.status}/></td><td>{row.attempts}</td></tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
