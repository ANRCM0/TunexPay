// 版本号契约：一次发布 = 一个唯一版本号，格式 `<提交日期 YYYYMMDD>-<7 位提交号>`，例如 20260830-4f48e61。
// 日期取的是提交时间而不是构建时间，因此同一个提交无论重建多少次、在谁的机器上构建，版本号都相同；
// 不同提交必然不同。版本号因此可以当作发布的唯一标识，用来回答「线上跑的到底是哪一版」。
//
// 来源优先级：
//   1. APP_VERSION 环境变量 —— 由镜像构建（Docker build-arg / CI）注入，镜像里没有 .git，只有这条路可靠；
//   2. 本地 Git 提交信息 —— 开发机上 `npm run dev:api` 的场景，让本地看到的版本号和发布版同构；
//   3. 兜底值 0.1.0-dev —— 既没有注入也读不到 Git 时，明确表示「这不是一次发布」。
//
// 注意：apps/web/lib/app-version.ts 是本文件的对应实现，两侧契约必须一致，各自的单测覆盖同一张用例表。

import { execFileSync, type StdioOptions } from "node:child_process";

export type AppVersionSource = "env" | "git" | "fallback";

export type AppVersion = {
  /** 展示层统一加 `v` 前缀，这里存的是不带前缀的裸值，例如 20260830-4f48e61。 */
  version: string;
  /** 提交号（7 位）；无法从版本号里解析出来时为 null（例如手工注入的语义化版本）。 */
  commit: string | null;
  /** 提交日期 YYYY-MM-DD；同样可能为 null。 */
  date: string | null;
  source: AppVersionSource;
};

export const VERSION_ENV_KEY = "APP_VERSION";
export const FALLBACK_VERSION = "0.1.0-dev";

const VERSION_PATTERN = /^(\d{4})(\d{2})(\d{2})-([0-9a-f]{7,40})(?:-dirty)?$/;
const GIT_STDIO: StdioOptions = ["ignore", "pipe", "ignore"];

/** 去掉 `v`/`V` 前缀和首尾空白；空值返回 null，避免把空字符串当成有效注入。 */
export function normalizeVersion(raw: string | null | undefined): string | null {
  const value = raw?.trim().replace(/^v/i, "").trim();
  return value ? value : null;
}

/** 按 UTC 拼提交日期，避免构建机时区影响版本号。 */
export function formatVersion(commitDate: Date, sha: string, dirty = false): string {
  const month = String(commitDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(commitDate.getUTCDate()).padStart(2, "0");
  const stamp = `${commitDate.getUTCFullYear()}${month}${day}`;
  return `${stamp}-${sha.trim().slice(0, 7).toLowerCase()}${dirty ? "-dirty" : ""}`;
}

/** 从版本号里还原提交日期与提交号；不符合契约时返回 null。 */
export function parseVersion(version: string): { commit: string; date: string } | null {
  const matched = VERSION_PATTERN.exec(version.trim());
  if (!matched) return null;
  const [, year, month, day, sha] = matched;
  if (!year || !month || !day || !sha) return null;
  return { commit: sha, date: `${year}-${month}-${day}` };
}

export type GitFacts = { sha: string; commitDate: Date; dirty: boolean };

function git(args: string[]): string {
  return String(execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: GIT_STDIO }));
}

function readGitFacts(): GitFacts | null {
  try {
    const sha = git(["rev-parse", "HEAD"]).trim();
    const committedAt = Number(git(["show", "-s", "--format=%ct", "HEAD"]).trim());
    if (!sha || !Number.isFinite(committedAt) || committedAt <= 0) return null;
    // 只看已跟踪文件：未提交的构建产物、日志不该把一次发布标成 dirty。
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
    return { sha, commitDate: new Date(committedAt * 1000), dirty };
  } catch {
    // 镜像里没有 .git、或者宿主机没装 git：交给上层走兜底版本号，不影响服务启动。
    return null;
  }
}

export type ResolveAppVersionOptions = {
  /** 默认 process.env；测试里注入受控环境。传入后不再回读 process.env。 */
  env?: Record<string, string | undefined>;
  /** 默认读取当前仓库的 Git 状态；测试里注入固定值。 */
  probeGit?: () => GitFacts | null;
};

export function resolveAppVersion(options: ResolveAppVersionOptions = {}): AppVersion {
  const injected = normalizeVersion((options.env ?? process.env)[VERSION_ENV_KEY]);
  if (injected) return describe(injected, "env");

  const facts = (options.probeGit ?? readGitFacts)();
  if (facts) return describe(formatVersion(facts.commitDate, facts.sha, facts.dirty), "git");

  return describe(FALLBACK_VERSION, "fallback");
}

function describe(version: string, source: AppVersionSource): AppVersion {
  const parsed = parseVersion(version);
  return { version, commit: parsed?.commit ?? null, date: parsed?.date ?? null, source };
}

/** 本进程对外报告的唯一版本号（/health、系统监控、MCP serverInfo 共用这一个来源）。 */
export const APP_VERSION = resolveAppVersion().version;
