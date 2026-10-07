// 版本号契约：一次发布 = 一个语义化版本号（`MAJOR.MINOR.PATCH`），来源是 Git tag（形如 `v0.1.0`）。
// 展示层统一加 `v` 前缀。tag 就是发布的唯一标识，用来回答「线上跑的到底是哪一版」。
//
// 来源优先级：
//   1. APP_VERSION 环境变量 —— CI 用 tag 名去掉 `v` 注入；镜像里没有 .git，只有这条路可靠；
//   2. 本地 Git —— 由 `git describe --tags --long --dirty` 推导，让开发机上看到的版本号与发布版同构：
//      正好落在 tag 上得到 `0.1.0`，tag 之后 N 个提交得到 `0.1.0-N.g<提交号>`，工作区有未提交改动
//      时追加 `.dirty`。三种形态都是合法 semver，且 `0.1.0-N.gXXXX` 在语义化排序里小于 `0.1.0`，
//      与「这是 0.1.0 之后的提交」一致；
//   3. 兜底值 0.1.0-dev —— 既没有注入、也没有可达的语义化 tag 时，明确表示「这不是一次发布」。
//
// 注意：apps/web/lib/app-version.ts 是本文件的对应实现，两侧契约必须一致，各自的单测覆盖同一张用例表。
// 这里不做结果缓存：Docker 里走环境变量分支不会调用 Git，而本地开发需要跟随 HEAD / tag 实时变化。

import { execFileSync, type StdioOptions } from "node:child_process";

export type AppVersionSource = "env" | "git" | "fallback";

export type AppVersion = {
  /** 展示层统一加 `v` 前缀，这里存的是不带前缀的裸值，例如 0.1.0 或 0.1.0-3.g4c26573。 */
  version: string;
  /** 提交号（7 位）；版本号里没带提交号时为 null（例如构建注入的 0.1.0）。 */
  commit: string | null;
  source: AppVersionSource;
};

export const VERSION_ENV_KEY = "APP_VERSION";
export const FALLBACK_VERSION = "0.1.0-dev";

/** 契约内的三种形态：0.1.0 / 0.1.0-dirty / 0.1.0-3.g4c26573[.dirty]。 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-((?:\d+\.g[0-9a-f]{7,40})(?:\.dirty)?|dirty))?$/;
/** `git describe --tags --long --dirty` 的输出：v0.1.0-3-g4c26573[-dirty]。 */
const DESCRIBE_PATTERN = /^v?(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]{7,40})(-dirty)?$/;
const GIT_STDIO: StdioOptions = ["ignore", "pipe", "ignore"];

/** 去掉 `v`/`V` 前缀和首尾空白；空值返回 null，避免把空字符串当成有效注入。 */
export function normalizeVersion(raw: string | null | undefined): string | null {
  const value = raw?.trim().replace(/^v/i, "").trim();
  return value ? value : null;
}

/**
 * 由「基准版本 + 距 tag 的提交数 + 提交号」拼出版本号。
 *
 * 落在 tag 上时就是 tag 本身（工作区脏则追加 `-dirty`）；tag 之后有提交时，用 semver 的
 * 预发布段携带距离与提交号——既不改变版本排序语义，也不丢失「这是哪次提交」的可追溯性。
 */
export function formatVersion(base: string, commitsSince = 0, sha = "", dirty = false): string {
  const clean = base.trim().replace(/^v/i, "");
  const distance = Math.max(0, Math.floor(commitsSince) || 0);
  if (distance === 0) return dirty ? `${clean}-dirty` : clean;
  const short = sha.trim().slice(0, 7).toLowerCase();
  // 没有提交号就拼不出可追溯的预发布段，退回基准版本，避免生成 `0.1.0-3.g` 这种残段
  if (!short) return clean;
  return `${clean}-${distance}.g${short}${dirty ? ".dirty" : ""}`;
}

/** 把 `git describe` 的输出转成本项目的版本号；不是语义化 tag 时返回 null（交给兜底）。 */
export function formatDescribe(describe: string): string | null {
  const matched = DESCRIBE_PATTERN.exec(describe.trim());
  if (!matched) return null;
  const [, base, distance, sha, dirty] = matched;
  if (!base || !distance || !sha) return null;
  return formatVersion(base, Number(distance), sha, Boolean(dirty));
}

/** 从版本号里还原提交号，用于悬浮提示；版本号没带提交号（或不符合契约）时返回 null。 */
export function parseVersion(version: string): { commit: string } | null {
  const matched = VERSION_PATTERN.exec(version.trim());
  if (!matched) return null;
  const preRelease = (matched[4] ?? "").replace(/\.dirty$/, "");
  const sha = /(?:^|\.)g([0-9a-f]{7,40})$/.exec(preRelease)?.[1];
  return sha ? { commit: sha } : null;
}

/** `git describe --tags --long --dirty` 的一行输出；读不到仓库或没有可达 tag 时返回 null。 */
function readGitDescribe(): string | null {
  try {
    const output = String(execFileSync("git", ["describe", "--tags", "--long", "--dirty"], { cwd: process.cwd(), encoding: "utf8", stdio: GIT_STDIO })).trim();
    return output || null;
  } catch {
    // 镜像里没有 .git、宿主机没装 git、或者仓库里没有任何可达的 tag：
    // 交给上层走兜底版本号，不影响服务启动。
    return null;
  }
}

export type ResolveAppVersionOptions = {
  /** 默认 process.env；测试里注入受控环境。传入后不再回读 process.env。 */
  env?: Record<string, string | undefined>;
  /** 默认读取当前仓库的 `git describe`；测试里注入固定值。 */
  probeGit?: () => string | null;
};

export function resolveAppVersion(options: ResolveAppVersionOptions = {}): AppVersion {
  const injected = normalizeVersion((options.env ?? process.env)[VERSION_ENV_KEY]);
  if (injected) return describe(injected, "env");

  const described = (options.probeGit ?? readGitDescribe)();
  const fromGit = described ? formatDescribe(described) : null;
  if (fromGit) return describe(fromGit, "git");

  return describe(FALLBACK_VERSION, "fallback");
}

function describe(version: string, source: AppVersionSource): AppVersion {
  return { version, commit: parseVersion(version)?.commit ?? null, source };
}

/** 本进程对外报告的唯一版本号（/health、系统监控、MCP serverInfo 共用这一个来源）。 */
export const APP_VERSION = resolveAppVersion().version;
