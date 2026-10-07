import { describe, expect, it } from "vitest";
import { APP_VERSION, FALLBACK_VERSION, VERSION_ENV_KEY, formatVersion, normalizeVersion, parseVersion, resolveAppVersion, type GitFacts } from "../lib/version.js";

// 这张用例表和 apps/web/lib/app-version.test.ts 一一对应：版本号是前后端共用的契约，
// 任何一侧改了格式都会让另一侧的同一组断言失败。

const sha = "4f48e61b0c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
const facts: GitFacts = { sha, commitDate: new Date("2026-08-30T02:15:00Z"), dirty: false };

describe("normalizeVersion", () => {
  it("strips the v prefix and surrounding whitespace", () => {
    expect(normalizeVersion("  v20260830-4f48e61 ")).toBe("20260830-4f48e61");
    expect(normalizeVersion("V20260830-4f48e61")).toBe("20260830-4f48e61");
  });

  it("treats blank injections as absent so they cannot shadow a real version", () => {
    expect(normalizeVersion("")).toBeNull();
    expect(normalizeVersion("   ")).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    expect(normalizeVersion(null)).toBeNull();
  });

  it("keeps semantic versions intact", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
  });
});

describe("formatVersion", () => {
  it("formats commit date and short sha", () => {
    expect(formatVersion(facts.commitDate, sha)).toBe("20260830-4f48e61");
  });

  it("uses UTC so the build machine timezone cannot change the version", () => {
    // 23:30Z 在东八区已经是 8/31 07:30：如果按构建机本地时区格式化，这里会得到 20260831。
    expect(formatVersion(new Date("2026-08-30T23:30:00Z"), sha)).toBe("20260830-4f48e61");
  });

  it("marks uncommitted builds so they cannot be mistaken for a release", () => {
    expect(formatVersion(facts.commitDate, sha, true)).toBe("20260830-4f48e61-dirty");
  });
});

describe("parseVersion", () => {
  it("recovers date and commit", () => {
    expect(parseVersion("20260830-4f48e61")).toEqual({ commit: "4f48e61", date: "2026-08-30" });
    expect(parseVersion("20260830-4f48e61-dirty")).toEqual({ commit: "4f48e61", date: "2026-08-30" });
  });

  it("returns null for versions outside the contract", () => {
    expect(parseVersion("0.1.0-dev")).toBeNull();
    expect(parseVersion("20260830")).toBeNull();
  });
});

describe("resolveAppVersion", () => {
  it("prefers the injected build version and never shells out for git", () => {
    let probed = false;
    const resolved = resolveAppVersion({ env: { [VERSION_ENV_KEY]: "v20260830-4f48e61" }, probeGit: () => { probed = true; return facts; } });
    expect(resolved).toEqual({ version: "20260830-4f48e61", commit: "4f48e61", date: "2026-08-30", source: "env" });
    expect(probed).toBe(false);
  });

  it("falls back to the local git checkout when nothing is injected", () => {
    expect(resolveAppVersion({ env: {}, probeGit: () => facts })).toEqual({ version: "20260830-4f48e61", commit: "4f48e61", date: "2026-08-30", source: "git" });
  });

  it("carries the dirty marker through to the reported version", () => {
    expect(resolveAppVersion({ env: {}, probeGit: () => ({ ...facts, dirty: true }) }).version).toBe("20260830-4f48e61-dirty");
  });

  it("degrades to a clearly non-release version instead of failing", () => {
    expect(resolveAppVersion({ env: {}, probeGit: () => null })).toEqual({ version: FALLBACK_VERSION, commit: null, date: null, source: "fallback" });
  });
});

describe("APP_VERSION", () => {
  it("is a non-empty version string of the documented shape", () => {
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(APP_VERSION.startsWith("v")).toBe(false);
  });
});
