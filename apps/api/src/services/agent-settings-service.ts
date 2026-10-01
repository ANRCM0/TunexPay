import { z } from "zod";
import { db } from "../db.js";
import { openSealed, seal } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

const ID = "agent-default";
const scopeSchema = z.enum(["READ", "OPERATE", "FINANCIAL"]);
const storedSchema = z.object({
  baseUrl: z.string().url().max(500),
  apiKey: z.string().max(2000),
  model: z.string().trim().min(1).max(120),
  maxScope: scopeSchema,
  maxSteps: z.number().int().min(1).max(8),
  instructions: z.string().max(4000),
}).strict();

const defaults = { baseUrl: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat", maxScope: "READ" as const, maxSteps: 4, instructions: "" };

export const agentSettingsInput = z.object({
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  baseUrl: z.string().url().max(500),
  apiKey: z.string().max(2000).nullable().optional(),
  model: z.string().trim().min(1).max(120),
  maxScope: scopeSchema,
  maxSteps: z.number().int().min(1).max(8),
  instructions: z.string().max(4000),
}).strict();

async function row() {
  return db.agentSettings.upsert({ where: { id: ID }, create: { id: ID, payloadEncrypted: seal(JSON.stringify(defaults)) }, update: {} });
}
function decode(value: string) { return storedSchema.parse(JSON.parse(openSealed(value))); }
export async function getAgentSettings() {
  const current = await row(); const value = decode(current.payloadEncrypted);
  return { enabled: current.enabled, revision: current.revision, baseUrl: value.baseUrl, model: value.model, maxScope: value.maxScope, maxSteps: value.maxSteps, instructions: value.instructions, apiKeyConfigured: Boolean(value.apiKey) };
}
export async function loadAgentRuntimeSettings() {
  const current = await row(); return { enabled: current.enabled, revision: current.revision, ...decode(current.payloadEncrypted) };
}
export async function saveAgentSettings(raw: unknown) {
  const input = agentSettingsInput.parse(raw);
  await row();
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM agent_settings WHERE id = ${ID} FOR UPDATE`;
    const current = await tx.agentSettings.findUnique({ where: { id: ID } });
    if (!current) throw new AppError("AGENT_SETTINGS_NOT_FOUND","Agent 配置不存在",404);
    if (current.revision !== input.revision) throw new AppError("AGENT_SETTINGS_CONFLICT","Agent 配置已变更，请重新加载",409);
    const previous = decode(current.payloadEncrypted);
    const apiKey = input.apiKey === null ? "" : input.apiKey || previous.apiKey;
    const url = new URL(input.baseUrl);
    if (url.username || url.password) throw new AppError("AGENT_BASE_URL_INVALID","模型地址不能包含用户名或密码",422);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new AppError("AGENT_BASE_URL_INSECURE","生产环境模型地址必须使用 HTTPS",422);
    if (input.enabled && !apiKey) throw new AppError("AGENT_API_KEY_REQUIRED","启用 Agent 前必须配置模型 API Key",422);
    const value = storedSchema.parse({ baseUrl: input.baseUrl.replace(/\/$/,""), apiKey, model: input.model, maxScope: input.maxScope, maxSteps: input.maxSteps, instructions: input.instructions });
    const updated = await tx.agentSettings.update({ where: { id: ID }, data: { enabled: input.enabled, payloadEncrypted: seal(JSON.stringify(value)), revision: { increment: 1 } } });
    return { enabled: updated.enabled, revision: updated.revision, baseUrl: value.baseUrl, model: value.model, maxScope: value.maxScope, maxSteps: value.maxSteps, instructions: value.instructions, apiKeyConfigured: Boolean(value.apiKey) };
  });
}
