import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { approveAgentAction, listAgentActions, rejectAgentAction } from "../services/agent-approval-service.js";
import { getAgentSettings, saveAgentSettings } from "../services/agent-settings-service.js";
import { listAgentInbox } from "../services/agent-inbox-service.js";
import { runAgentTurn } from "../services/agent-runtime-service.js";
import { db } from "../db.js";
import { openSealed } from "../lib/crypto.js";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

export const agentAdminRoutes = new Hono<AppEnv>();
agentAdminRoutes.get("/agent/settings",async c=>c.json({data:await getAgentSettings()}));
agentAdminRoutes.post("/agent/settings",async c=>c.json({data:await saveAgentSettings(await c.req.json())}));
agentAdminRoutes.post("/agent/test",async c=>{
  const {text}=z.object({text:z.string().trim().min(1).max(4000)}).parse(await c.req.json());
  return c.json({data:{reply:await runAgentTurn("admin:test",text,"admin-console")}});
});
agentAdminRoutes.get("/agent/approvals", async c => {
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit"));
  return c.json({ data: await listAgentActions(limit) });
});
agentAdminRoutes.post("/agent/approvals/:id/approve", async c => c.json({ data: await approveAgentAction(c.req.param("id"), "admin-console") }));
agentAdminRoutes.post("/agent/approvals/:id/reject", async c => c.json({ data: await rejectAgentAction(c.req.param("id"), "admin-console") }));
agentAdminRoutes.get("/agent/inbox",async c=>c.json({data:await listAgentInbox(z.coerce.number().int().min(1).max(100).default(50).parse(c.req.query("limit")))}));
agentAdminRoutes.get("/agent/ingress/:id",async c=>{
  const row=await db.notificationInstance.findUnique({where:{id:c.req.param("id")}});
  if(!row||!["TELEGRAM","FEISHU_APP"].includes(row.plugin)) throw new AppError("AGENT_INGRESS_UNSUPPORTED","该通知实例不支持 Agent 对话入口",409);
  const path=row.plugin==="TELEGRAM"?"telegram":"feishu";
  return c.json({data:{url:`${config().API_PUBLIC_URL.replace(/\/$/,"")}/agent/${path}/${row.id}`,plugin:row.plugin}});
});
agentAdminRoutes.post("/agent/telegram/:id/register",async c=>{
  const row=await db.notificationInstance.findUnique({where:{id:c.req.param("id")}});
  if(!row||row.plugin!=="TELEGRAM"||row.archivedAt) throw new AppError("TELEGRAM_INSTANCE_NOT_FOUND","Telegram 通知实例不存在",404);
  const value=JSON.parse(openSealed(row.payloadEncrypted)) as Record<string,unknown>;
  if(value.agentEnabled!==true||!value.agentWebhookSecret) throw new AppError("TELEGRAM_AGENT_DISABLED","请先保存并启用 Telegram Agent 配置",409);
  const url=`${config().API_PUBLIC_URL.replace(/\/$/,"")}/agent/telegram/${row.id}`;
  const response=await fetch(`https://api.telegram.org/bot${String(value.botToken)}/setWebhook`,{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(10_000),headers:{"content-type":"application/json"},
    body:JSON.stringify({url,secret_token:String(value.agentWebhookSecret),allowed_updates:["message"],drop_pending_updates:false}),
  });
  const body=await response.json() as {ok?:boolean;description?:string};
  if(!response.ok||body.ok!==true) throw new AppError("TELEGRAM_WEBHOOK_REGISTER_FAILED",body.description||"Telegram Webhook 注册失败",502);
  return c.json({data:{url,registered:true}});
});
