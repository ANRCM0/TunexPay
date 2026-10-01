import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { db } from "../db.js";
import { openSealed, safeEqual } from "../lib/crypto.js";
import { enqueueAgentMessage } from "../services/agent-inbox-service.js";
import { loadAgentRuntimeSettings } from "../services/agent-settings-service.js";
import { splitIds } from "../services/agent-channel-service.js";

function runtimeConfig(payloadEncrypted:string){ return JSON.parse(openSealed(payloadEncrypted)) as Record<string,unknown>; }
async function instance(id:string,plugin:string){
  const row=await db.notificationInstance.findUnique({where:{id}});
  if(!row||row.archivedAt||!row.enabled||row.plugin!==plugin) return null;
  return {row,config:runtimeConfig(row.payloadEncrypted)};
}
function enabled(value:unknown){ return value===true||value==="true"; }

export const agentIngressRoutes=new Hono<AppEnv>();

agentIngressRoutes.post("/telegram/:id",async c=>{
  if(!(await loadAgentRuntimeSettings()).enabled) return c.json({ok:false},503);
  const found=await instance(c.req.param("id"),"TELEGRAM"); if(!found||!enabled(found.config.agentEnabled)) return c.json({ok:false},404);
  const secret=String(found.config.agentWebhookSecret??"");
  const provided=c.req.header("x-telegram-bot-api-secret-token")??"";
  if(!secret||!safeEqual(secret,provided)) return c.json({ok:false},401);
  const body=z.object({update_id:z.union([z.number(),z.string()]),message:z.object({text:z.string().optional(),chat:z.object({id:z.union([z.number(),z.string()])}),from:z.object({id:z.union([z.number(),z.string()])}).optional()}).optional()}).passthrough().parse(await c.req.json());
  if(!body.message?.text) return c.json({ok:true});
  const chatId=String(body.message.chat.id), senderId=String(body.message.from?.id??"");
  const allowedChats=splitIds(found.config.agentAllowedChatIds); if(!allowedChats.size) allowedChats.add(String(found.config.chatId??""));
  const allowedUsers=splitIds(found.config.agentAllowedUserIds);
  if(!allowedChats.has(chatId)||(allowedUsers.size&&!allowedUsers.has(senderId))) return c.json({ok:true});
  await enqueueAgentMessage({provider:"TELEGRAM",eventId:String(body.update_id),instanceId:found.row.id,conversationKey:`telegram:${found.row.id}:${chatId}`,chatId,senderId,text:body.message.text});
  return c.json({ok:true});
});

agentIngressRoutes.post("/feishu/:id",async c=>{
  const found=await instance(c.req.param("id"),"FEISHU_APP"); if(!found||!enabled(found.config.agentEnabled)) return c.json({code:0});
  const body=await c.req.json<Record<string,unknown>>();
  const topToken=typeof body.token==="string"?body.token:"";
  const header=(body.header&&typeof body.header==="object"?body.header:{}) as Record<string,unknown>;
  const token=topToken||String(header.token??"");
  const expected=String(found.config.verificationToken??"");
  if(!expected||!safeEqual(expected,token)) return c.json({code:1,msg:"unauthorized"},401);
  if(typeof body.challenge==="string") return c.json({challenge:body.challenge});
  if(!(await loadAgentRuntimeSettings()).enabled) return c.json({code:0});
  if(String(header.event_type??"")!=="im.message.receive_v1") return c.json({code:0});
  const event=(body.event&&typeof body.event==="object"?body.event:{}) as Record<string,unknown>;
  const message=(event.message&&typeof event.message==="object"?event.message:{}) as Record<string,unknown>;
  const sender=(event.sender&&typeof event.sender==="object"?event.sender:{}) as Record<string,unknown>;
  const senderId=(sender.sender_id&&typeof sender.sender_id==="object"?sender.sender_id:{}) as Record<string,unknown>;
  if(String(message.message_type??"")!=="text") return c.json({code:0});
  let text=""; try{ const parsed=JSON.parse(String(message.content??"{}")) as {text?:string}; text=parsed.text??""; }catch{}
  if(!text) return c.json({code:0});
  const chatId=String(message.chat_id??""), openId=String(senderId.open_id??"");
  const allowedChats=splitIds(found.config.agentAllowedChatIds), allowedUsers=splitIds(found.config.agentAllowedOpenIds);
  if(!allowedChats.size&&found.config.receiveIdType==="chat_id") allowedChats.add(String(found.config.receiveId??""));
  if(!allowedUsers.size&&found.config.receiveIdType==="open_id") allowedUsers.add(String(found.config.receiveId??""));
  if((allowedChats.size&&!allowedChats.has(chatId))||(allowedUsers.size&&!allowedUsers.has(openId))) return c.json({code:0});
  await enqueueAgentMessage({provider:"FEISHU",eventId:String(header.event_id??message.message_id??Date.now()),instanceId:found.row.id,conversationKey:`feishu:${found.row.id}:${chatId}`,chatId,senderId:openId,text});
  return c.json({code:0});
});
