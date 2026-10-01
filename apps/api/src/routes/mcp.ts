import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types.js";
import { config } from "../config.js";
import { safeEqual } from "../lib/crypto.js";
import { executeTool, toolCatalog, type ToolScope } from "../mcp/tools.js";

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

function bearer(header: string | undefined) {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

function scopeFor(token: string): ToolScope | null {
  const cfg = config();
  if (cfg.MCP_FINANCIAL_TOKEN && safeEqual(token, cfg.MCP_FINANCIAL_TOKEN)) return "FINANCIAL";
  if (cfg.MCP_OPERATE_TOKEN && safeEqual(token, cfg.MCP_OPERATE_TOKEN)) return "OPERATE";
  if (cfg.MCP_TOKEN && safeEqual(token, cfg.MCP_TOKEN)) return "READ";
  return null;
}

export const mcpRoutes = new Hono<AppEnv>();
mcpRoutes.get("/", c => c.json({ error: "MCP uses authenticated Streamable HTTP POST requests." }, 405, { Allow: "POST" }));

mcpRoutes.post("/", async c => {
  const cfg = config();
  if (!cfg.MCP_ENABLED) return c.json({ error: "Not found" }, 404);
  const token = bearer(c.req.header("authorization"));
  const scope = scopeFor(token);
  if (!scope) return c.json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });

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
      protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:"TuneXPay",version:"0.2.0"},
      instructions:`TuneXPay MCP scope=${scope}. READ is query-only. OPERATE may run safe operational recovery/check actions. FINANCIAL tools only create short-lived human approval requests; they never move money directly.`,
    }),200,{"MCP-Protocol-Version":protocolVersion,"Cache-Control":"no-store"});
  }
  if(request.method==="tools/list") return c.json(result(id,{tools:toolCatalog(scope)}),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
  if(request.method==="tools/call"){
    try{
      const call=argsOf(request.params);
      const output=await executeTool(call.name,call.arguments,{scope,actor:`mcp:${scope.toLowerCase()}`});
      return c.json(result(id,textResult(output)),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
    }catch(cause){
      const message=cause instanceof Error?cause.message:"TOOL_FAILED";
      return c.json(result(id,{isError:true,content:[{type:"text",text:message}]}),200,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
    }
  }
  return c.json(error(id,-32601,"Method not found"),404,{"MCP-Protocol-Version":CURRENT_PROTOCOL,"Cache-Control":"no-store"});
});
