import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { openSealed } from "../lib/crypto.js";
import { runAgentTurn } from "./agent-runtime-service.js";
import { sendFeishuText, sendTelegramText } from "./agent-channel-service.js";

function configOf(payloadEncrypted:string){ return JSON.parse(openSealed(payloadEncrypted)) as Record<string,unknown>; }

export async function enqueueAgentMessage(input:{provider:"TELEGRAM"|"FEISHU";eventId:string;instanceId:string;conversationKey:string;chatId:string;senderId:string;text:string}) {
  try { return await db.agentInbox.create({ data: input }); }
  catch (cause) {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code==="P2002") return null;
    throw cause;
  }
}

export async function listAgentInbox(limit=50){
  return db.agentInbox.findMany({orderBy:{createdAt:"desc"},take:Math.min(100,Math.max(1,limit))});
}

export async function runAgentInbox(){
  await db.agentInbox.updateMany({where:{status:"PROCESSING",lockedUntil:{lt:new Date()}},data:{status:"PENDING",lockedUntil:null,nextAttemptAt:new Date(),lastError:"AGENT_WORKER_LEASE_EXPIRED"}});
  const task=await db.agentInbox.findFirst({where:{status:"PENDING",nextAttemptAt:{lte:new Date()}},orderBy:{createdAt:"asc"}});
  if(!task) return {claimed:0};
  const lockedUntil=new Date(Date.now()+120_000);
  const claimed=await db.agentInbox.updateMany({where:{id:task.id,status:"PENDING"},data:{status:"PROCESSING",lockedUntil,attempts:{increment:1}}});
  if(!claimed.count) return {claimed:0};
  try{
    const instance=await db.notificationInstance.findUnique({where:{id:task.instanceId}});
    if(!instance||!instance.enabled||instance.archivedAt) throw new Error("AGENT_NOTIFICATION_INSTANCE_UNAVAILABLE");
    const config=configOf(instance.payloadEncrypted);
    const reply=await runAgentTurn(task.conversationKey,task.text,`${task.provider.toLowerCase()}:${task.senderId}`);
    if(task.provider==="TELEGRAM") await sendTelegramText(config,task.chatId,reply);
    else await sendFeishuText(config,task.chatId,reply);
    await db.agentInbox.update({where:{id:task.id},data:{status:"SUCCESS",lockedUntil:null,lastError:null}});
    return {claimed:1,status:"SUCCESS"};
  }catch(cause){
    const message=cause instanceof Error?cause.message:String(cause);
    const attempts=task.attempts+1;
    await db.agentInbox.update({where:{id:task.id},data:{status:attempts>=3?"FAILED":"PENDING",lockedUntil:null,lastError:message.slice(0,500),nextAttemptAt:new Date(Date.now()+Math.min(300,15*2**task.attempts)*1000)}});
    return {claimed:1,status:"FAILED"};
  }
}
