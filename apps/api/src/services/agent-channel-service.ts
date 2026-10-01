import { z } from "zod";

export function splitIds(value: unknown): Set<string> {
  return new Set(String(value ?? "").split(",").map(item => item.trim()).filter(Boolean));
}

export async function sendTelegramText(config: Record<string, unknown>, chatId: string, text: string) {
  const botToken = z.string().parse(config.botToken);
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method:"POST", redirect:"manual", signal:AbortSignal.timeout(10_000),
    headers:{"content-type":"application/json"}, body:JSON.stringify({chat_id:chatId,text:text.slice(0,4000)}),
  });
  if(!response.ok) throw new Error(`TELEGRAM_AGENT_SEND_${response.status}`);
}

async function feishuToken(config: Record<string, unknown>) {
  const appId=z.string().parse(config.appId), appSecret=z.string().parse(config.appSecret);
  const response=await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(10_000),headers:{"content-type":"application/json"},body:JSON.stringify({app_id:appId,app_secret:appSecret}),
  });
  const body=await response.json() as { code?:number; tenant_access_token?:string };
  if(!response.ok||body.code!==0||!body.tenant_access_token) throw new Error("FEISHU_AGENT_TOKEN_FAILED");
  return body.tenant_access_token;
}

export async function sendFeishuText(config: Record<string, unknown>, chatId: string, text: string) {
  const token=await feishuToken(config);
  const target=new URL("https://open.feishu.cn/open-apis/im/v1/messages"); target.searchParams.set("receive_id_type","chat_id");
  const response=await fetch(target,{
    method:"POST",redirect:"manual",signal:AbortSignal.timeout(10_000),
    headers:{"content-type":"application/json",authorization:`Bearer ${token}`},
    body:JSON.stringify({receive_id:chatId,msg_type:"text",content:JSON.stringify({text:text.slice(0,4000)})}),
  });
  const body=await response.json() as { code?:number };
  if(!response.ok||body.code!==0) throw new Error("FEISHU_AGENT_SEND_FAILED");
}
