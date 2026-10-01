"use client";

import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { CopyValue, LoadingState, Modal, PageHead, Section, Status, Toast, Toggle, time } from "./common";

type Scope = "READ" | "OPERATE" | "FINANCIAL";
type Tool = { name:string; description:string; inputSchema:Record<string,unknown>; scope:Scope };
type Client = {
  id:string; name:string; tokenPrefix:string; scope:Scope; allowedTools:string[]; enabled:boolean; revision:number;
  expiresAt:string|null; lastUsedAt:string|null; createdAt:string; updatedAt:string;
};
type Audit = {
  id:string; clientId:string|null; clientName:string; scope:Scope; tool:string; argumentsSummary:unknown;
  success:boolean; durationMs:number; errorCode:string|null; requestId:string|null; ipAddress:string|null; createdAt:string;
};
type Approval = {
  id:string; clientId:string|null; action:string; summary:string; requestedBy:string; status:string; expiresAt:string;
  approvedAt:string|null; rejectedAt:string|null; executedAt:string|null; lastError:string|null; createdAt:string;
};
type Info = { enabled:boolean; endpoint:string; legacyReadTokenConfigured:boolean };

const rank:Record<Scope,number>={READ:0,OPERATE:1,FINANCIAL:2};
const scopeCopy:Record<Scope,string>={
  READ:"只读查询",
  OPERATE:"查询 + 安全运维动作",
  FINANCIAL:"运维 + 创建需要人工批准的资金动作",
};

function eligibleTools(tools:Tool[]|null|undefined,scope:Scope){ return (tools??[]).filter(tool=>rank[tool.scope]<=rank[scope]); }

function ToolPicker({tools,scope,selected,onChange}:{tools:Tool[]|null|undefined;scope:Scope;selected:string[];onChange:(value:string[])=>void}){
  const eligible=eligibleTools(tools,scope);
  const groups=(["READ","OPERATE","FINANCIAL"] as Scope[]).map(group=>[group,eligible.filter(tool=>tool.scope===group)] as const).filter(([,items])=>items.length);
  const set=new Set(selected);
  return <div className="settings-events">{groups.flatMap(([group,items])=>[
    <div className="muted" key={`head-${group}`} style={{gridColumn:"1 / -1",marginTop:6}}><strong>{group}</strong> · {scopeCopy[group]}</div>,
    ...items.map(tool=><label className="event-option" key={tool.name}>
      <input type="checkbox" checked={set.has(tool.name)} onChange={event=>{
        const next=new Set(selected); if(event.target.checked)next.add(tool.name);else next.delete(tool.name); onChange([...next]);
      }}/>
      <span><strong>{tool.name}</strong><em>{tool.description}</em></span>
    </label>)
  ])}</div>;
}

function ClientCard({client,tools,busy,onBusy,onNotice,reload,onToken}:{client:Client;tools:Tool[]|null|undefined;busy:boolean;onBusy:(v:boolean)=>void;onNotice:(v:{type:"ok"|"error";text:string}|null)=>void;reload:()=>Promise<void>;onToken:(token:string,name:string)=>void}){
  const [name,setName]=useState(client.name),[scope,setScope]=useState<Scope>(client.scope),[enabled,setEnabled]=useState(client.enabled);
  const [expiresAt,setExpiresAt]=useState(client.expiresAt?new Date(client.expiresAt).toISOString().slice(0,16):"");
  const [allowed,setAllowed]=useState(client.allowedTools);
  useEffect(()=>{setName(client.name);setScope(client.scope);setEnabled(client.enabled);setExpiresAt(client.expiresAt?new Date(client.expiresAt).toISOString().slice(0,16):"");setAllowed(client.allowedTools);},[client]);
  function changeScope(next:Scope){setScope(next);const eligible=new Set(eligibleTools(tools,next).map(t=>t.name));setAllowed(current=>current.filter(name=>eligible.has(name)));}

  async function save(){
    onBusy(true);onNotice(null);
    try{
      await api(`/mcp/clients/${client.id}`,{method:"POST",body:JSON.stringify({
        revision:client.revision,name,scope,enabled,allowedTools:allowed,expiresAt:expiresAt?new Date(expiresAt).toISOString():null,
      })});
      await reload();onNotice({type:"ok",text:`${name} 权限已保存。`});
    }catch(cause){onNotice({type:"error",text:cause instanceof Error?cause.message:"保存失败"});}finally{onBusy(false);}
  }
  async function rotate(){
    if(!window.confirm(`轮换「${client.name}」的 MCP Token？旧 Token 会立即失效。`))return;
    onBusy(true);onNotice(null);
    try{
      const result=await api<{data:{client:Client;token:string}}>(`/mcp/clients/${client.id}/rotate`,{method:"POST",body:"{}"});
      onToken(result.data.token,client.name);await reload();
    }catch(cause){onNotice({type:"error",text:cause instanceof Error?cause.message:"轮换失败"});}finally{onBusy(false);}
  }
  return <fieldset className="settings-group" disabled={busy}>
    <div className="settings-group-head"><div><h3>{client.name}</h3><p><code>{client.tokenPrefix}</code> · 上次使用 {time(client.lastUsedAt)}</p></div><Toggle checked={enabled} onChange={setEnabled} label="允许访问"/></div>
    <div className="settings-grid">
      <label>名称<input value={name} maxLength={120} onChange={e=>setName(e.target.value)}/></label>
      <label>最大 Scope<select value={scope} onChange={e=>changeScope(e.target.value as Scope)}><option value="READ">READ</option><option value="OPERATE">OPERATE</option><option value="FINANCIAL">FINANCIAL-request</option></select></label>
      <label>有效期（空=不过期）<input type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}/></label>
    </div>
    <div className="settings-group-head"><div><h3>Tool Allowlist</h3><p>Scope 只是上限；真正暴露给外部 Agent 的工具还必须在这里被勾选。</p></div></div>
    <ToolPicker tools={tools} scope={scope} selected={allowed} onChange={setAllowed}/>
    <div className="settings-actions"><button className="button" type="button" onClick={()=>void save()}>保存权限</button><button className="button secondary" type="button" onClick={()=>void rotate()}>轮换 Token</button></div>
  </fieldset>;
}

export function McpAccessPanel(){
  const {data:info,loading:infoLoading,error:infoError}=useApi<Info>("/mcp/info");
  const {data:tools,loading:toolsLoading,error:toolsError}=useApi<Tool[]>("/mcp/tools");
  const {data:clients,loading,error,reload}=useApi<Client[]>("/mcp/clients");
  const {data:audits,loading:auditsLoading,error:auditsError,reload:reloadAudits}=useApi<Audit[]>("/mcp/audits?limit=100",5000);
  const {data:approvals,loading:approvalsLoading,error:approvalsError,reload:reloadApprovals}=useApi<Approval[]>("/mcp/approvals",5000);
  const [name,setName]=useState("Hermes"),[scope,setScope]=useState<Scope>("READ"),[enabled,setEnabled]=useState(true),[expiresAt,setExpiresAt]=useState("");
  const [allowed,setAllowed]=useState<string[]>([]);
  const [issued,setIssued]=useState<{token:string;name:string}|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<{type:"ok"|"error";text:string}|null>(null);
  const eligible=useMemo(()=>eligibleTools(tools,scope),[tools,scope]);
  useEffect(()=>{ if(tools?.length&&!allowed.length)setAllowed(eligible.map(tool=>tool.name)); },[tools,scope]);

  function changeScope(next:Scope){setScope(next);setAllowed(eligibleTools(tools,next).map(tool=>tool.name));}
  async function create(event:React.FormEvent){
    event.preventDefault();setBusy(true);setNotice(null);
    try{
      const result=await api<{data:{client:Client;token:string}}>("/mcp/clients",{method:"POST",body:JSON.stringify({
        name,scope,enabled,allowedTools:allowed,expiresAt:expiresAt?new Date(expiresAt).toISOString():null,
      })});
      setIssued({token:result.data.token,name:result.data.client.name});await reload();setNotice({type:"ok",text:"MCP 客户端已创建。Token 只会显示这一次。"});
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"创建失败"});}finally{setBusy(false);}
  }
  async function decide(id:string,decision:"approve"|"reject"){
    if(decision==="approve"&&!window.confirm("批准后会立即调用 TuneXPay 原有支付服务执行该动作。确认继续？"))return;
    setBusy(true);setNotice(null);
    try{await api(`/mcp/approvals/${id}/${decision}`,{method:"POST",body:"{}"});await reloadApprovals();setNotice({type:"ok",text:decision==="approve"?"已批准并执行。":"已拒绝。"});}
    catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"处理失败"});}finally{setBusy(false);}
  }

  return <>
    {notice&&<Toast type={notice.type} text={notice.text} onClose={()=>setNotice(null)}/>}
    {issued&&<Modal title="MCP Token 仅显示一次" onClose={()=>setIssued(null)}>
      <p className="dialog-copy">把它保存到 {issued.name} 的 MCP 配置中。TuneXPay 只保存哈希，关闭后无法再次查看明文。</p>
      <div className="credential-secret"><code>{issued.token}</code><CopyValue value={issued.token} label="复制 Token"/></div>
      {info?.endpoint&&<><p className="dialog-copy">Streamable HTTP Endpoint</p><div className="credential-secret"><code>{info.endpoint}</code><CopyValue value={info.endpoint} label="复制地址"/></div></>}
      <div className="dialog-actions"><button className="button" type="button" onClick={()=>setIssued(null)}>我已保存</button></div>
    </Modal>}

    <PageHead eyebrow="MCP Access" title="MCP / Agent Access" copy="TuneXPay 不运行 Agent；这里只给 Codex、Hermes、OpenClaw、DSH 等外部 Agent 发放 MCP 权限和工具。" />

    <Section title="MCP Endpoint">
      <LoadingState loading={infoLoading} error={infoError}>{info&&<div className="settings-group">
        <div><strong>{info.enabled?"MCP 已启用":"MCP 未启用"}</strong><p className="muted">环境变量里的旧 MCP_TOKEN 仍保留为兼容的 READ-only 凭证；新 Agent 请使用下面的独立客户端。</p></div>
        <div className="credential-secret"><code>{info.endpoint}</code><CopyValue value={info.endpoint} label="复制地址"/></div>
      </div>}</LoadingState>
    </Section>

    <Section title="创建外部 Agent 凭证">
      <LoadingState loading={toolsLoading} error={toolsError}>
        <form onSubmit={event=>void create(event)}><fieldset className="settings-group" disabled={busy}>
          <div className="settings-grid">
            <label>客户端名称<input value={name} maxLength={120} placeholder="Hermes / Codex / OpenClaw" onChange={e=>setName(e.target.value)}/></label>
            <label>最大 Scope<select value={scope} onChange={e=>changeScope(e.target.value as Scope)}><option value="READ">READ</option><option value="OPERATE">OPERATE</option><option value="FINANCIAL">FINANCIAL-request</option></select></label>
            <label>有效期（空=不过期）<input type="datetime-local" value={expiresAt} onChange={e=>setExpiresAt(e.target.value)}/></label>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="创建后立即启用"/>
          <div className="settings-group-head"><div><h3>允许的工具</h3><p>默认选择当前 Scope 下所有工具；可以收窄成某个 Agent 的最小权限集合。</p></div></div>
          <ToolPicker tools={tools} scope={scope} selected={allowed} onChange={setAllowed}/>
          <div className="settings-actions"><button className="button" type="submit">生成独立 MCP Token</button></div>
        </fieldset></form>
      </LoadingState>
    </Section>

    <Section title="MCP 客户端" action={<button className="link-button" onClick={()=>void reload()} type="button">刷新</button>}>
      <LoadingState loading={loading} error={error} empty={!clients?.length} emptyText="还没有外部 Agent 客户端">
        {clients?.map(client=><ClientCard key={client.id} client={client} tools={tools} busy={busy} onBusy={setBusy} onNotice={setNotice} reload={reload} onToken={(token,name)=>setIssued({token,name})}/>)}
      </LoadingState>
    </Section>

    <Section title="资金 / 状态动作审批" action={<span className="muted">FINANCIAL 工具只能创建这里的待审批请求</span>}>
      <LoadingState loading={approvalsLoading} error={approvalsError} empty={!approvals?.length} emptyText="暂无待审批或历史动作">
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>动作</th><th>说明</th><th>状态</th><th>到期</th><th></th></tr></thead>
          <tbody>{approvals?.map(row=><tr key={row.id}><td>{time(row.createdAt)}</td><td><code>{row.clientId??row.requestedBy}</code></td><td><code>{row.action}</code></td><td>{row.summary}{row.lastError&&<div className="row-error">{row.lastError}</div>}</td><td><Status value={row.status}/></td><td>{time(row.expiresAt)}</td><td>{row.status==="PENDING"&&<><button className="link-button" disabled={busy} onClick={()=>void decide(row.id,"approve")}>批准</button> <button className="link-button" disabled={busy} onClick={()=>void decide(row.id,"reject")}>拒绝</button></>}</td></tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>

    <Section title="MCP Tool 调用审计" action={<button className="link-button" onClick={()=>void reloadAudits()} type="button">刷新</button>}>
      <LoadingState loading={auditsLoading} error={auditsError} empty={!audits?.length} emptyText="还没有 MCP Tool 调用">
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>客户端</th><th>Scope</th><th>Tool</th><th>结果</th><th>耗时</th><th>来源</th></tr></thead>
          <tbody>{audits?.map(row=><tr key={row.id}><td>{time(row.createdAt)}</td><td>{row.clientName}<div className="mono muted">{row.clientId??"legacy env"}</div></td><td><code>{row.scope}</code></td><td><code>{row.tool}</code>{row.errorCode&&<div className="row-error">{row.errorCode}</div>}</td><td><Status value={row.success?"SUCCESS":"FAILED"}/></td><td>{row.durationMs} ms</td><td>{row.ipAddress??"—"}<div className="mono muted">{row.requestId??"—"}</div></td></tr>)}</tbody>
        </table></div>
      </LoadingState>
    </Section>
  </>;
}
