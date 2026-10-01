import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { generateId, randomSecret, safeEqual, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { toolNamesForScope, type ToolScope } from "../mcp/tools.js";

const scopeSchema = z.enum(["READ", "OPERATE", "FINANCIAL"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scope: scopeSchema.default("READ"),
  allowedTools: z.array(z.string().min(1).max(100)).max(64).optional(),
  enabled: z.boolean().default(true),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();
const updateSchema = createSchema.extend({ revision: z.number().int().positive() });

function parseAllowed(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function normalizeTools(scope: ToolScope, value: string[] | undefined, fallback?: string[]) {
  const eligible = new Set(toolNamesForScope(scope));
  const source = value ?? fallback ?? [...eligible];
  const unique = [...new Set(source)];
  const invalid = unique.filter(name => !eligible.has(name));
  if (invalid.length) throw new AppError("MCP_TOOL_SCOPE_INVALID", `工具超出 ${scope} 权限：${invalid.join(", ")}`, 422);
  return unique;
}
function parseExpiry(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date <= new Date()) throw new AppError("MCP_EXPIRY_INVALID", "有效期必须是未来时间", 422);
  return date;
}
function issueToken() {
  const token = `txm_${randomSecret(32)}`;
  return { token, tokenHash: sha256(token), tokenPrefix: `${token.slice(0, 12)}…` };
}
function view(row: { id:string; name:string; tokenPrefix:string; scope:string; allowedTools:unknown; enabled:boolean; revision:number; expiresAt:Date|null; lastUsedAt:Date|null; createdAt:Date; updatedAt:Date }) {
  return { ...row, allowedTools: parseAllowed(row.allowedTools) };
}

export type McpPrincipal = {
  clientId: string | null;
  name: string;
  scope: ToolScope;
  allowedTools: string[] | null;
  actor: string;
  legacy: boolean;
};

export async function authenticateMcpToken(token: string): Promise<McpPrincipal | null> {
  const cfg = config();
  if (cfg.MCP_TOKEN && safeEqual(token, cfg.MCP_TOKEN)) {
    return { clientId: null, name: "legacy-env-read", scope: "READ", allowedTools: null, actor: "mcp:legacy-env-read", legacy: true };
  }
  if (!token.startsWith("txm_") || token.length < 36) return null;
  const row = await db.mcpClient.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || !row.enabled || (row.expiresAt && row.expiresAt <= new Date())) return null;
  if (!row.lastUsedAt || row.lastUsedAt.getTime() < Date.now() - 60_000) {
    await db.mcpClient.updateMany({ where: { id: row.id, revision: row.revision }, data: { lastUsedAt: new Date() } });
  }
  return {
    clientId: row.id, name: row.name, scope: scopeSchema.parse(row.scope),
    allowedTools: parseAllowed(row.allowedTools), actor: `mcp:${row.id}`, legacy: false,
  };
}

export async function listMcpClients() {
  const rows = await db.mcpClient.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(view);
}

export async function createMcpClient(raw: unknown) {
  const input = createSchema.parse(raw);
  const credentials = issueToken();
  const allowedTools = normalizeTools(input.scope, input.allowedTools);
  const row = await db.mcpClient.create({
    data: {
      id: generateId("mcp"), name: input.name, tokenHash: credentials.tokenHash, tokenPrefix: credentials.tokenPrefix,
      scope: input.scope, allowedTools, enabled: input.enabled, expiresAt: parseExpiry(input.expiresAt),
    },
  });
  return { client: view(row), token: credentials.token };
}

export async function updateMcpClient(id: string, raw: unknown) {
  const input = updateSchema.parse(raw);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM mcp_clients WHERE id = ${id} FOR UPDATE`;
    const current = await tx.mcpClient.findUnique({ where: { id } });
    if (!current) throw new AppError("MCP_CLIENT_NOT_FOUND", "MCP 客户端不存在", 404);
    if (current.revision !== input.revision) throw new AppError("MCP_CLIENT_CONFLICT", "客户端配置已变更，请刷新后重试", 409);
    const allowedTools = normalizeTools(input.scope, input.allowedTools, parseAllowed(current.allowedTools));
    const row = await tx.mcpClient.update({
      where: { id },
      data: {
        name: input.name, scope: input.scope, allowedTools, enabled: input.enabled,
        expiresAt: parseExpiry(input.expiresAt), revision: { increment: 1 },
      },
    });
    return view(row);
  });
}

export async function rotateMcpClientToken(id: string) {
  const credentials = issueToken();
  const row = await db.mcpClient.update({
    where: { id },
    data: { tokenHash: credentials.tokenHash, tokenPrefix: credentials.tokenPrefix, revision: { increment: 1 } },
  }).catch(() => { throw new AppError("MCP_CLIENT_NOT_FOUND", "MCP 客户端不存在", 404); });
  return { client: view(row), token: credentials.token };
}

export async function setMcpClientEnabled(id: string, enabled: boolean) {
  const row = await db.mcpClient.update({
    where: { id },
    data: { enabled, revision: { increment: 1 } },
  }).catch(() => { throw new AppError("MCP_CLIENT_NOT_FOUND", "MCP 客户端不存在", 404); });
  return view(row);
}
