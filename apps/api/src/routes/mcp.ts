import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { APP_VERSION } from "../lib/version.js";
import { executeTool, toolCatalog } from "../mcp/tools.js";
import { authenticateMcpToken } from "../services/mcp-client-service.js";
import { recordMcpAudit } from "../services/mcp-audit-service.js";

type RpcId = string | number | null;
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: unknown };
const CURRENT_PROTOCOL = "2026-07-28";
const SUPPORTED_PROTOCOLS = new Set([CURRENT_PROTOCOL, "2025-11-25", "2025-06-18", "2025-03-26"]);

function result(id: RpcId, value: unknown) { return { jsonrpc: "2.0" as const, id, result: value }; }
function error(id: RpcId, code: number, message: string, data?: unknown) { return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } }; }
function textResult(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function argsOf(params: unknown): { name: string; arguments: unknown } {
  const parsed = z.object({ name: z.string(), arguments: z.unknown().optional() }).parse(params);
  return { name: parsed.name, arguments: parsed.arguments ?? {} };
}
function bearer(header: string | undefined) { return header?.startsWith("Bearer ") ? header.slice(7) : ""; }
function clientIp(cf:string|undefined,forwarded:string|undefined,real:string|undefined){ return (cf||forwarded?.split(",")[0]||real)?.trim()||null; }

export const mcpRoutes = new Hono<AppEnv>();
mcpRoutes.get("/", c => c.json({ error: "MCP uses authenticated Streamable HTTP POST requests." }, 405, { Allow: "POST" }));

mcpRoutes.post("/", async c => {
  if (!config().MCP_ENABLED) return c.json({ error: "Not found" }, 404);
  const principal = await authenticateMcpToken(bearer(c.req.header("authorization")));
  if (!principal) return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

  let request: RpcRequest;
  try { request = await c.req.json<RpcRequest>(); }
  catch { return c.json(error(null,-32700,"Parse error"),400); }
  const id=request.id??null;
  if(request.jsonrpc!=="2.0"||typeof request.method!=="string") return c.json(error(id,-32600,"Invalid Request"),400);

  if(request.method==="notifications/initialized") return c.body(null,202);
  if(request.method==="ping") return c.json(result(id,{}),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
  if(request.method==="initialize"){
    const parsed=z.object({protocolVersion:z.string().optional()}).passthrough().safeParse(request.params);
    const requested=parsed.success?parsed.data.protocolVersion:undefined;
    const protocolVersion=requested&&SUPPORTED_PROTOCOLS.has(requested)?requested:CURRENT_PROTOCOL;
    return c.json(result(id,{
      protocolVersion,
      capabilities:{tools:{listChanged:false}},
      serverInfo:{name:"TuneXPay",version:APP_VERSION},
      instructions:`TuneXPay MCP client=${principal.name}, scope=${principal.scope}. Tool availability is restricted by this client's allowlist. FINANCIAL tools only create short-lived human approval requests and never move money directly.`,
    }),200,{"MCP-Protocol-Version":protocolVersion,"Cache-Control":"no-store"});
  }
  if(request.method==="tools/list") {
    return c.json(result(id,{tools:toolCatalog(principal.scope,principal.allowedTools)}),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
  }
  if(request.method==="tools/call"){
    const call=argsOf(request.params);
    const started=Date.now();
    try{
      const output=await executeTool(call.name,call.arguments,{
        scope:principal.scope,actor:principal.actor,clientId:principal.clientId,allowedTools:principal.allowedTools,
      });
      await recordMcpAudit({
        clientId:principal.clientId,clientName:principal.name,scope:principal.scope,tool:call.name,arguments:call.arguments,
        success:true,durationMs:Date.now()-started,requestId:c.get("requestId")||null,
        ipAddress:clientIp(c.req.header("cf-connecting-ip"),c.req.header("x-forwarded-for"),c.req.header("x-real-ip")),
        userAgent:c.req.header("user-agent")||null,
      }).catch(auditError=>log("error","mcp_audit.write_failed",{requestId:c.get("requestId"),error:auditError instanceof Error?auditError.message:String(auditError)}));
      return c.json(result(id,textResult(output)),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
    }catch(cause){
      const message=cause instanceof Error?cause.message:"TOOL_FAILED";
      const code=typeof cause==="object"&&cause&&"code" in cause?String((cause as {code?:unknown}).code??"TOOL_FAILED"):"TOOL_FAILED";
      await recordMcpAudit({
        clientId:principal.clientId,clientName:principal.name,scope:principal.scope,tool:call.name,arguments:call.arguments,
        success:false,durationMs:Date.now()-started,errorCode:code,requestId:c.get("requestId")||null,
        ipAddress:clientIp(c.req.header("cf-connecting-ip"),c.req.header("x-forwarded-for"),c.req.header("x-real-ip")),
        userAgent:c.req.header("user-agent")||null,
      }).catch(auditError=>log("error","mcp_audit.write_failed",{requestId:c.get("requestId"),error:auditError instanceof Error?auditError.message:String(auditError)}));
      return c.json(result(id,{isError:true,content:[{type:"text",text:message}]}),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
    }
  }
  return c.json(error(id,-32601,"Method not found"),404,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
});
