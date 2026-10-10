import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import type { ToolScope } from "../mcp/tools.js";

type AuditInput = {
  clientId: string | null;
  clientName: string;
  scope: ToolScope;
  tool: string;
  arguments: unknown;
  success: boolean;
  durationMs: number;
  errorCode?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

function summarize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => summarize(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (/secret|token|password|authorization|api.?key|private.?key/i.test(key)) out[key] = "[redacted]";
    else out[key] = summarize(item, depth + 1);
  }
  return out;
}

function jsonSummary(value: unknown): Prisma.InputJsonValue | undefined {
  const safe = summarize(value);
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) > 8_000) return { truncated: true } as Prisma.InputJsonValue;
  return JSON.parse(encoded) as Prisma.InputJsonValue;
}

export async function recordMcpAudit(input: AuditInput) {
  return db.mcpAuditLog.create({ data: {
    clientId: input.clientId,
    clientName: input.clientName.slice(0,120),
    scope: input.scope,
    tool: input.tool.slice(0,100),
    argumentsSummary: jsonSummary(input.arguments),
    success: input.success,
    durationMs: Math.max(0, Math.min(4_294_967_295, Math.round(input.durationMs))),
    errorCode: input.errorCode?.slice(0,80) || null,
    requestId: input.requestId?.slice(0,64) || null,
    ipAddress: input.ipAddress?.slice(0,64) || null,
    userAgent: input.userAgent?.slice(0,500) || null,
  } });
}

export async function listMcpAudits(raw: unknown) {
  const input = z.object({
    clientId: z.string().max(64).optional(),
    tool: z.string().max(100).optional(),
    success: z.enum(["true","false"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(raw);
  return db.mcpAuditLog.findMany({
    where: {
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.success ? { success: input.success === "true" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
  });
}
