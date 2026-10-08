"use client";

import { Button, DatePicker, Descriptions, Form, Input, Select, Switch, Table } from "@arco-design/web-react";
import type { ColumnProps } from "@arco-design/web-react/es/Table";
import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import { retainAllowedTools } from "../lib/form-safety";
import { sortRows, type SortColumn } from "../lib/sort";
import { ConfirmModal, CopyValue, LoadingState, Modal, PageHead, RowAction, Section, Status, Toast, sortValueProps, time, toLocalDateTimeInput } from "./common";
import { ListCard, ListPage, Pager, ToolbarNote, ToolbarSpacer, sortHeader, useClientPager, useTableSort } from "./list";

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

// Scope 选项沿用原来的展示文案：FINANCIAL 带 -request 后缀，提醒这一类动作只会创建待审批请求。
const SCOPE_OPTIONS = [
  { label: "READ", value: "READ" },
  { label: "OPERATE", value: "OPERATE" },
  { label: "FINANCIAL-request", value: "FINANCIAL" },
];

function eligibleTools(tools:Tool[]|null|undefined,scope:Scope){ return (tools??[]).filter(tool=>rank[tool.scope]<=rank[scope]); }

// DatePicker 回传 "YYYY-MM-DD HH:mm"，toLocalDateTimeInput 回传 "YYYY-MM-DDTHH:mm"。
// 两种形式都按本地时间解析：ES 只保证带 T 的形式是本地时间，所以先把空格换成 T。
function toIsoOrNull(value:string):string|null {
  return value ? new Date(value.replace(" ", "T")).toISOString() : null;
}
function toPickerDate(value:string):Date|undefined {
  return value ? new Date(value.replace(" ", "T")) : undefined;
}

/**
 * 工具选择表：勾选行即加入 Tool Allowlist。
 *
 * 原来按 Scope 分组的标题（"READ · 只读查询"）搬到了 Scope 列里，
 * 说明文案一字未改；用表而不是复选框清单，是为了和其余三张表保持同一套版式。
 */
function ToolPicker({tools,scope,selected,onChange}:{tools:Tool[]|null|undefined;scope:Scope;selected:string[];onChange:(value:string[])=>void}){
  const rows=useMemo(()=>eligibleTools(tools,scope).sort((a,b)=>rank[a.scope]-rank[b.scope]),[tools,scope]);
  const columns:ColumnProps<Tool>[]=[
    {title:"Tool",dataIndex:"name",width:220,render:(_:unknown,tool:Tool)=><code>{tool.name}</code>},
    {title:"Scope",dataIndex:"scope",width:250,render:(_:unknown,tool:Tool)=><><code>{tool.scope}</code><div className="muted">{scopeCopy[tool.scope]}</div></>},
    {title:"说明",dataIndex:"description"},
  ];
  return <Table<Tool>
    className="list-table"
    columns={columns}
    data={rows}
    rowKey="name"
    pagination={false}
    borderCell={false}
    rowSelection={{selectedRowKeys:selected,onChange:(keys)=>onChange(keys.map(String))}}
    noDataElement={<div className="empty compact">当前 Scope 下没有可用工具</div>}
  />;
}

/** 客户端编辑表单：从表格的「编辑」进来，保存后关掉弹窗并提示。 */
function ClientEditor({client,tools,busy,onBusy,onDirtyChange,onNotice,reload,onSaved,onCancel}:{client:Client;tools:Tool[]|null|undefined;busy:boolean;onBusy:(v:boolean)=>void;onDirtyChange:(v:boolean)=>void;onNotice:(v:{type:"ok"|"error";text:string}|null)=>void;reload:()=>Promise<void>;onSaved:()=>void;onCancel:()=>void}){
  const [name,setName]=useState(client.name),[scope,setScope]=useState<Scope>(client.scope),[enabled,setEnabled]=useState(client.enabled);
  const [expiresAt,setExpiresAt]=useState(toLocalDateTimeInput(client.expiresAt));
  const [allowed,setAllowed]=useState(client.allowedTools);
  const [fieldError,setFieldError]=useState("");
  const dirty=name!==client.name || scope!==client.scope || enabled!==client.enabled || expiresAt!==toLocalDateTimeInput(client.expiresAt) || JSON.stringify([...allowed].sort())!==JSON.stringify([...client.allowedTools].sort());
  useEffect(()=>{onDirtyChange(dirty);},[dirty,onDirtyChange]);
  useEffect(()=>{setName(client.name);setScope(client.scope);setEnabled(client.enabled);setExpiresAt(toLocalDateTimeInput(client.expiresAt));setAllowed(client.allowedTools);},[client]);
  function changeScope(next:Scope){setScope(next);const eligible=new Set(eligibleTools(tools,next).map(t=>t.name));setAllowed(current=>current.filter(value=>eligible.has(value)));}

  async function save(){
    if(busy) return;
    if(!name.trim()){setFieldError("请填写客户端名称");return;}
    if(expiresAt && (!Number.isFinite(Date.parse(expiresAt.replace(" ","T"))) || Date.parse(expiresAt.replace(" ","T"))<=Date.now())){setFieldError("有效期必须晚于当前时间；留空表示不过期");return;}
    setFieldError("");onBusy(true);onNotice(null);
    try{
      await api(`/mcp/clients/${client.id}`,{method:"POST",body:JSON.stringify({
        revision:client.revision,name,scope,enabled,allowedTools:allowed,expiresAt:toIsoOrNull(expiresAt),
      })});
      onNotice({type:"ok",text:`${name} 权限已保存（${allowed.length} 个 Tool）。`});onSaved();
      void reload().catch(()=>onNotice({type:"error",text:"权限已保存，但列表刷新失败，请稍后点击刷新。"}));
    }catch(cause){onNotice({type:"error",text:cause instanceof Error?cause.message:"保存失败"});}finally{onBusy(false);}
  }

  return <Form layout="vertical" onSubmit={()=>void save()}>
    <fieldset className="settings-group" disabled={busy}>
      {/* 组头保留原来的名称、Token 前缀与上次使用时间，并把「允许访问」开关留在这里 */}
      <div className="settings-group-head">
        <div><h3>{client.name}</h3><p><code>{client.tokenPrefix}</code> · 上次使用 {time(client.lastUsedAt)}</p></div>
        <label style={{display:"inline-flex",alignItems:"center",gap:8}}><Switch checked={enabled} onChange={setEnabled} aria-label="允许访问"/><span>允许访问</span></label>
      </div>
      <div className="settings-grid">
        <label>名称<Input value={name} maxLength={120} onChange={setName}/></label>
        <label>最大 Scope<Select value={scope} onChange={value=>changeScope(value as Scope)} options={SCOPE_OPTIONS}/></label>
        <label>有效期（空=不过期）<DatePicker value={toPickerDate(expiresAt)} showTime format="YYYY-MM-DD HH:mm" style={{width:"100%"}} onChange={value=>setExpiresAt(value??"")}/></label>
      </div>
      <div className="settings-group-head"><div><h3>Tool Allowlist</h3><p>Scope 只是上限；真正暴露给外部 Agent 的工具还必须在这里被勾选。</p></div></div>
      <ToolPicker tools={tools} scope={scope} selected={allowed} onChange={setAllowed}/>
      <p className="muted" role="status">已授权 {allowed.length} / {eligibleTools(tools,scope).length} 个工具{allowed.length===0?"（当前客户端没有可调用的工具）":""}。{dirty?"修改尚未保存。":"当前配置与服务器一致。"}</p>
      {fieldError&&<div className="operation-notice error" role="alert">{fieldError}</div>}
      <div className="settings-actions"><Button type="primary" htmlType="submit" loading={busy} disabled={!dirty||busy}>{busy?"保存中…":dirty?"保存权限":"没有需要保存的修改"}</Button><Button type="secondary" disabled={busy} onClick={onCancel}>取消</Button></div>
    </fieldset>
  </Form>;
}

// 审批表：状态列展示审批状态，排序按状态枚举码。
const APPROVAL_COLUMNS: SortColumn<Approval>[] = [
  { key: "createdAt", label: "时间", type: "date" },
  { key: "requester", label: "来源", accessor: (row) => row.clientId ?? row.requestedBy },
  { key: "action", label: "动作" },
  { key: "summary", label: "说明" },
  { key: "status", label: "状态" },
  { key: "expiresAt", label: "到期", type: "date" },
];

// 调用审计表：与操作审计同理，「结果」列按布尔值排序而不是状态码文本。
const MCP_AUDIT_COLUMNS: SortColumn<Audit>[] = [
  { key: "createdAt", label: "时间", type: "date" },
  { key: "clientName", label: "客户端" },
  { key: "scope", label: "Scope" },
  { key: "tool", label: "Tool" },
  { key: "success", label: "结果", accessor: (row) => (row.success ? 1 : 0), type: "number" },
  { key: "durationMs", label: "耗时", type: "number" },
  { key: "ipAddress", label: "来源", accessor: (row) => row.ipAddress ?? "" },
];

export function McpAccessPanel(){
  const {data:info,loading:infoLoading,error:infoError}=useApi<Info>("/mcp/info");
  const {data:tools,loading:toolsLoading,error:toolsError}=useApi<Tool[]>("/mcp/tools");
  const {data:clients,loading,error,reload}=useApi<Client[]>("/mcp/clients");
  const {data:audits,loading:auditsLoading,error:auditsError,reload:reloadAudits}=useApi<Audit[]>("/mcp/audits?limit=100",5000);
  const {data:approvals,loading:approvalsLoading,error:approvalsError,reload:reloadApprovals}=useApi<Approval[]>("/mcp/approvals",5000);
  const { sort: approvalSort, onSort: onApprovalSort } = useTableSort<Approval>();
  const { sort: auditSort, onSort: onAuditSort } = useTableSort<Audit>();
  const approvalRows = useMemo(() => sortRows(approvals ?? [], APPROVAL_COLUMNS, approvalSort), [approvals, approvalSort]);
  const auditRows = useMemo(() => sortRows(audits ?? [], MCP_AUDIT_COLUMNS, auditSort), [audits, auditSort]);
  const approvalPager = useClientPager(approvalRows, 20);
  const auditPager = useClientPager(auditRows, 20);
  const clientPager = useClientPager(clients ?? [], 20);
  const [name,setName]=useState("Hermes"),[scope,setScope]=useState<Scope>("READ"),[enabled,setEnabled]=useState(true),[expiresAt,setExpiresAt]=useState("");
  const [allowed,setAllowed]=useState<string[]>([]);
  const [issued,setIssued]=useState<{token:string;name:string}|null>(null);
  // 编辑、轮换、审批三件事各自需要一次确认：分别用三个状态驱动弹窗，避免用 window.confirm 这种浏览器原生对话框
  const [editing,setEditing]=useState<Client|null>(null);
  const [editingDirty,setEditingDirty]=useState(false);
  const [confirmDiscardEditing,setConfirmDiscardEditing]=useState(false);
  const requestCloseEditing=()=>{if(busy)return;if(editingDirty)setConfirmDiscardEditing(true);else setEditing(null);};
  const [rotating,setRotating]=useState<Client|null>(null);
  const [deciding,setDeciding]=useState<{row:Approval;decision:"approve"|"reject"}|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<{type:"ok"|"error";text:string}|null>(null);
  const eligible=useMemo(()=>eligibleTools(tools,scope),[tools,scope]);
  // 最小权限原则：异步加载工具列表或清空选择后，都不能悄悄恢复成「全部允许」。

  function changeScope(next:Scope){setScope(next);setAllowed(current=>retainAllowedTools(current,eligibleTools(tools,next).map(tool=>tool.name)));}
  async function create(){
    setBusy(true);setNotice(null);
    try{
      const result=await api<{data:{client:Client;token:string}}>("/mcp/clients",{method:"POST",body:JSON.stringify({
        name,scope,enabled,allowedTools:allowed,expiresAt:toIsoOrNull(expiresAt),
      })});
      setIssued({token:result.data.token,name:result.data.client.name});setNotice({type:"ok",text:"MCP 客户端已创建。Token 只会显示这一次。"});void reload().catch(()=>setNotice({type:"error",text:"MCP 客户端已创建，但列表刷新失败；请先保存新 Token，不要重复创建。"}));
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"创建失败"});}finally{setBusy(false);}
  }
  async function rotate(client:Client){
    setBusy(true);setNotice(null);
    try{
      const result=await api<{data:{client:Client;token:string}}>(`/mcp/clients/${client.id}/rotate`,{method:"POST",body:"{}"});
      setRotating(null);setIssued({token:result.data.token,name:client.name});setNotice({type:"ok",text:"Token 已轮换，旧 Token 立即失效。请立即保存新 Token。"});void reload().catch(()=>setNotice({type:"error",text:"Token 已轮换，但客户端列表刷新失败。请保存显示的新 Token，不要再次轮换。"}));
    }catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"轮换失败"});}finally{setBusy(false);}
  }
  async function decide(id:string,decision:"approve"|"reject"){
    setBusy(true);setNotice(null);
    try{await api(`/mcp/approvals/${id}/${decision}`,{method:"POST",body:"{}"});setDeciding(null);setNotice({type:"ok",text:decision==="approve"?"已批准并执行。":"已拒绝。"});void reloadApprovals().catch(()=>setNotice({type:"error",text:"审批动作已经提交，但列表刷新失败，请手动刷新，不要重复审批。"}));}
    catch(cause){setNotice({type:"error",text:cause instanceof Error?cause.message:"处理失败"});}finally{setBusy(false);}
  }

  const clientColumns:ColumnProps<Client>[]=[
    {title:"客户端",dataIndex:"name",render:(_:unknown,client:Client)=><><strong>{client.name}</strong><div className="id-line"><span className="mono muted">{client.tokenPrefix}</span></div></>},
    {title:"最大 Scope",dataIndex:"scope",width:250,render:(_:unknown,client:Client)=><><code>{client.scope}</code><div className="muted">{scopeCopy[client.scope]}</div></>},
    {title:"工具",dataIndex:"allowedTools",width:150,render:(_:unknown,client:Client)=><>{client.allowedTools.length} 个<div className="muted">当前 Scope 共 {eligibleTools(tools,client.scope).length} 个</div></>},
    {title:"状态",dataIndex:"enabled",width:110,render:(_:unknown,client:Client)=><Status value={client.enabled?"ACTIVE":"DISABLED"}/>},
    {title:"有效期",dataIndex:"expiresAt",width:180,render:(_:unknown,client:Client)=>client.expiresAt?time(client.expiresAt):"不过期"},
    {title:"上次使用",dataIndex:"lastUsedAt",width:180,render:(_:unknown,client:Client)=>time(client.lastUsedAt)},
    {title:"操作",dataIndex:"actions",width:180,render:(_:unknown,client:Client)=><>
      <RowAction disabled={busy} onClick={()=>{setEditingDirty(false);setEditing(client);}}>编辑</RowAction>{" "}
      <RowAction disabled={busy} onClick={()=>setRotating(client)}>轮换 Token</RowAction>
    </>},
  ];

  const approvalColumns:ColumnProps<Approval>[]=[
    {title:sortHeader(APPROVAL_COLUMNS[0],approvalSort,onApprovalSort),dataIndex:"createdAt",width:180,render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[0])}>{time(row.createdAt)}</span>},
    {title:sortHeader(APPROVAL_COLUMNS[1],approvalSort,onApprovalSort),dataIndex:"requester",width:170,render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[1])}><code>{row.clientId??row.requestedBy}</code></span>},
    {title:sortHeader(APPROVAL_COLUMNS[2],approvalSort,onApprovalSort),dataIndex:"action",width:180,render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[2])}><code>{row.action}</code></span>},
    {title:sortHeader(APPROVAL_COLUMNS[3],approvalSort,onApprovalSort),dataIndex:"summary",render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[3])}>{row.summary}{row.lastError&&<div className="row-error">{row.lastError}</div>}</span>},
    {title:sortHeader(APPROVAL_COLUMNS[4],approvalSort,onApprovalSort),dataIndex:"status",width:130,render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[4])}><Status value={row.status}/></span>},
    {title:sortHeader(APPROVAL_COLUMNS[5],approvalSort,onApprovalSort),dataIndex:"expiresAt",width:180,render:(_:unknown,row:Approval)=><span {...sortValueProps(row,APPROVAL_COLUMNS[5])}>{time(row.expiresAt)}</span>},
    {title:"操作",dataIndex:"actions",width:140,render:(_:unknown,row:Approval)=>row.status==="PENDING"?<>
      <RowAction disabled={busy} onClick={()=>setDeciding({row,decision:"approve"})}>批准</RowAction>{" "}
      <RowAction disabled={busy} danger onClick={()=>setDeciding({row,decision:"reject"})}>拒绝</RowAction>
    </>:null},
  ];

  const auditColumns:ColumnProps<Audit>[]=[
    {title:sortHeader(MCP_AUDIT_COLUMNS[0],auditSort,onAuditSort),dataIndex:"createdAt",width:180,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[0])}>{time(row.createdAt)}</span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[1],auditSort,onAuditSort),dataIndex:"clientName",width:180,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[1])}>{row.clientName}<div className="mono muted">{row.clientId??"legacy env"}</div></span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[2],auditSort,onAuditSort),dataIndex:"scope",width:130,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[2])}><code>{row.scope}</code></span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[3],auditSort,onAuditSort),dataIndex:"tool",width:220,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[3])}><code>{row.tool}</code>{row.errorCode&&<div className="row-error">{row.errorCode}</div>}</span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[4],auditSort,onAuditSort),dataIndex:"success",width:130,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[4])}><Status value={row.success?"SUCCESS":"FAILED"}/></span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[5],auditSort,onAuditSort),dataIndex:"durationMs",width:110,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[5])}>{row.durationMs} ms</span>},
    {title:sortHeader(MCP_AUDIT_COLUMNS[6],auditSort,onAuditSort),dataIndex:"ipAddress",width:180,render:(_:unknown,row:Audit)=><span {...sortValueProps(row,MCP_AUDIT_COLUMNS[6])}>{row.ipAddress??"—"}<div className="mono muted">{row.requestId??"—"}</div></span>},
  ];

  return <>
    {notice&&<Toast type={notice.type} text={notice.text} onClose={()=>setNotice(null)}/>}
    {issued&&<Modal title="MCP Token 仅显示一次" onClose={()=>setIssued(null)} dismissible={false}>
      <p className="dialog-copy">把它保存到 {issued.name} 的 MCP 配置中。TuneXPay 只保存哈希，关闭后无法再次查看明文。</p>
      <div className="credential-secret"><code>{issued.token}</code><CopyValue value={issued.token} label="复制 Token"/></div>
      {info?.endpoint&&<><p className="dialog-copy">Streamable HTTP Endpoint</p><div className="credential-secret"><code>{info.endpoint}</code><CopyValue value={info.endpoint} label="复制地址"/></div></>}
      <div className="dialog-actions"><Button type="primary" onClick={()=>setIssued(null)}>我已保存</Button></div>
    </Modal>}

    {confirmDiscardEditing&&<ConfirmModal title="放弃 MCP 权限修改？" copy="所选工具、Scope、访问开关和有效期尚未保存，离开后本次修改将丢失。" danger confirmLabel="放弃修改" onClose={()=>setConfirmDiscardEditing(false)} onConfirm={()=>{setConfirmDiscardEditing(false);setEditingDirty(false);setEditing(null);}}/>}
    {editing&&<Modal title={`编辑客户端 · ${editing.name}`} onClose={requestCloseEditing} dismissible={!busy}>
      <ClientEditor client={editing} tools={tools} busy={busy} onBusy={setBusy} onDirtyChange={setEditingDirty} onNotice={setNotice} reload={reload} onSaved={()=>{setEditing(null);setEditingDirty(false);}} onCancel={requestCloseEditing}/>
    </Modal>}

    {rotating&&<ConfirmModal
      title={`轮换「${rotating.name}」的 MCP Token`}
      copy="旧 Token 会立即失效，正在使用它的 Agent 会立刻被拒绝。"
      warning="请先确认新的 Token 已经能写进 Agent 配置：这里一旦轮换，旧 Token 无法恢复。"
      danger
      confirmLabel="轮换 Token"
      working={busy}
      onClose={()=>{ if(!busy)setRotating(null); }}
      onConfirm={()=>void rotate(rotating)}
    />}

    {deciding&&<ConfirmModal
      title={deciding.decision==="approve"?`批准动作 · ${deciding.row.action}`:`拒绝动作 · ${deciding.row.action}`}
      copy={deciding.decision==="approve"?"批准后会立即调用 TuneXPay 原有支付服务执行该动作。确认继续？":"拒绝后该动作不会执行，需要时请让客户端重新发起审批。"}
      warning="批准即代表你已核对动作说明里的金额与对象；执行后管理台不提供撤销入口。"
      danger={deciding.decision==="approve"}
      confirmLabel={deciding.decision==="approve"?"批准并执行":"拒绝"}
      working={busy}
      onClose={()=>{ if(!busy)setDeciding(null); }}
      onConfirm={()=>void decide(deciding.row.id,deciding.decision)}
    />}

    <PageHead eyebrow="MCP Access" title="MCP / Agent Access" copy="TuneXPay 不运行 Agent；这里只给 Codex、Hermes、OpenClaw、DSH 等外部 Agent 发放 MCP 权限和工具。" />

    <Section title="MCP Endpoint">
      <LoadingState loading={infoLoading} error={infoError} stale={Boolean(info)}>{info&&/* 服务信息用 Descriptions：标签与值的对齐交给组件库，长 Endpoint 由 credential-secret 负责换行 */<Descriptions
        column={1}
        border
        data={[
          { label: "运行状态", value: <strong>{info.enabled?"MCP 已启用":"MCP 未启用"}</strong> },
          { label: "Streamable HTTP Endpoint", value: <div className="credential-secret"><code>{info.endpoint}</code><CopyValue value={info.endpoint} label="复制地址"/></div> },
          { label: "旧凭证兼容", value: <span className="muted">环境变量里的旧 MCP_TOKEN 仍保留为兼容的 READ-only 凭证；新 Agent 请使用下面的独立客户端。</span> },
        ]}
      />}</LoadingState>
    </Section>

    <ListPage>
      <ListCard toolbar={<><strong>创建外部 Agent 凭证</strong><ToolbarNote>Token 只在创建时显示一次</ToolbarNote></>}>
        <LoadingState loading={toolsLoading} error={toolsError}>
          <Form layout="vertical" onSubmit={()=>void create()}><fieldset className="settings-group" disabled={busy}>
            <div className="settings-grid">
              <label>客户端名称<Input required value={name} maxLength={120} placeholder="Hermes / Codex / OpenClaw" onChange={setName}/></label>
              <label>最大 Scope<Select value={scope} onChange={value=>changeScope(value as Scope)} options={SCOPE_OPTIONS}/></label>
              <label>有效期（空=不过期）<DatePicker value={toPickerDate(expiresAt)} showTime format="YYYY-MM-DD HH:mm" style={{width:"100%"}} onChange={value=>setExpiresAt(value??"")}/></label>
            </div>
            <label style={{display:"inline-flex",alignItems:"center",gap:8}}><Switch checked={enabled} onChange={setEnabled} aria-label="创建后立即启用"/><span>创建后立即启用</span></label>
            <div className="settings-group-head"><div><h3>允许的工具</h3><p>默认不授权任何工具。请明确勾选这个 Agent 需要调用的工具。</p></div></div>
            <p className="muted">默认不授权任何工具。请只勾选这个客户端确实需要的 Tool；切换 Scope 不会自动增加权限。</p>
       <ToolPicker tools={tools} scope={scope} selected={allowed} onChange={setAllowed}/>
            <p className="muted" role="status">将授权 {allowed.length} / {eligible.length} 个工具。{allowed.length===0?"当前客户端将无法调用任何工具。":""}</p>
            <div className="settings-actions"><Button type="primary" htmlType="submit" loading={busy}>生成独立 MCP Token</Button></div>
          </fieldset></Form>
        </LoadingState>
      </ListCard>
    </ListPage>

    {/* 相邻两张 ListPage 之间没有现成的外边距规则（admin.css 已冻结），用外层 div 补 16px */}
    <div style={{ marginTop: 16 }}>
      <ListPage>
        <LoadingState loading={loading} error={error} stale={Boolean(clients)} empty={!clients?.length} emptyText="还没有外部 Agent 客户端">
          <ListCard
            toolbar={<><strong>MCP 客户端</strong><ToolbarNote>共 {clients?.length ?? 0} 个</ToolbarNote><ToolbarSpacer/><Button size="small" onClick={()=>void reload()}>刷新</Button></>}
            pagination={<Pager total={clientPager.total} page={clientPager.page} pageSize={clientPager.pageSize} onChange={clientPager.setPage} onPageSizeChange={clientPager.setPageSize}/>}
          >
            <Table<Client> className="list-table" columns={clientColumns} data={clientPager.rows} rowKey="id" pagination={false} borderCell={false} loading={false} noDataElement={<div className="empty compact">还没有外部 Agent 客户端</div>}/>
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>

    <div style={{ marginTop: 16 }}>
      <ListPage>
        <LoadingState loading={approvalsLoading} error={approvalsError} stale={Boolean(approvals)} empty={!approvals?.length} emptyText="暂无待审批或历史动作">
          <ListCard
            toolbar={<><strong>资金 / 状态动作审批</strong><ToolbarNote>FINANCIAL 工具只能创建这里的待审批请求</ToolbarNote></>}
            pagination={<Pager total={approvalPager.total} page={approvalPager.page} pageSize={approvalPager.pageSize} onChange={approvalPager.setPage} onPageSizeChange={approvalPager.setPageSize}/>}
          >
            <Table<Approval> className="list-table" columns={approvalColumns} data={approvalPager.rows} rowKey="id" pagination={false} borderCell={false} loading={false} noDataElement={<div className="empty compact">没有待审批或历史动作</div>}/>
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>

    <div style={{ marginTop: 16 }}>
      <ListPage>
        <LoadingState loading={auditsLoading} error={auditsError} empty={!audits?.length} emptyText="还没有 MCP Tool 调用">
          <ListCard
            toolbar={<><strong>MCP Tool 调用审计</strong><ToolbarNote>共 {auditRows.length} 次调用</ToolbarNote><ToolbarSpacer/><Button size="small" onClick={()=>void reloadAudits()}>刷新</Button></>}
            pagination={<Pager total={auditPager.total} page={auditPager.page} pageSize={auditPager.pageSize} onChange={auditPager.setPage} onPageSizeChange={auditPager.setPageSize}/>}
          >
            <Table<Audit> className="list-table" columns={auditColumns} data={auditPager.rows} rowKey="id" pagination={false} borderCell={false} loading={false} noDataElement={<div className="empty compact">还没有 MCP Tool 调用</div>}/>
          </ListCard>
        </LoadingState>
      </ListPage>
    </div>
  </>;
}
