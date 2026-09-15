import { config } from "../config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (levels[level] < levels[config().LOG_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
