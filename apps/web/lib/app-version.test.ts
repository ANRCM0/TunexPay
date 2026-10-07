import { describe, expect, it } from "vitest";
import { FALLBACK_VERSION, VERSION_ENV_KEY, formatDescribe, formatVersion, normalizeVersion, parseVersion, resolveAppVersion } from "./app-version";

// 这张用例表和 apps/api/src/tests/version.test.ts 一一对应：版本号是前后端共用的契约，
// 任何一侧改了格式都会让另一侧的同一组断言失败。

const sha = "4f48e61b0c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
const short = "4f48e61";
/** `git describe --tags --long` 在 v0.1.0 之后 3 个提交上的输出。 */
const described = `v0.1.0-3-g${short}`;

describe("normalizeVersion", () => {
  it("strips the v prefix and surrounding whitespace", () => {
    expect(normalizeVersion("  v0.1.0 ")).toBe("0.1.0");
    expect(normalizeVersion("V0.1.0")).toBe("0.1.0");
  });

  it("treats blank injections as absent so they cannot shadow a real version", () => {
    expect(normalizeVersion("")).toBeNull();
    expect(normalizeVersion("   ")).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    expect(normalizeVersion(null)).toBeNull();
  });

  it("keeps semantic versions intact", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });
});

describe("formatVersion", () => {
  it("uses the tag itself when the commit is exactly on it", () => {
    expect(formatVersion("0.1.0", 0, sha)).toBe("0.1.0");
  });

  it("carries commit distance and short sha after the tag", () => {
    expect(formatVersion("0.1.0", 3, sha)).toBe("0.1.0-3.g4f48e61");
  });

  it("marks uncommitted work so it cannot be mistaken for a release", () => {
    expect(formatVersion("0.1.0", 0, sha, true)).toBe("0.1.0-dirty");
    expect(formatVersion("0.1.0", 3, sha, true)).toBe("0.1.0-3.g4f48e61.dirty");
  });

  it("accepts a base that still carries the v prefix", () => {
    expect(formatVersion("v0.1.0", 0, sha)).toBe("0.1.0");
  });

  it("refuses to emit a half-built prerelease when the sha is missing", () => {
    // 宁可用基准版本，也不要拼出 `0.1.0-3.g` 这种残段
    expect(formatVersion("0.1.0", 3, "")).toBe("0.1.0");
  });
});

describe("formatDescribe", () => {
  it("turns git describe output into the version contract", () => {
    expect(formatDescribe(described)).toBe("0.1.0-3.g4f48e61");
    expect(formatDescribe("v0.1.0-0-g4f48e61")).toBe("0.1.0");
    expect(formatDescribe("v0.1.0-3-g4f48e61-dirty")).toBe("0.1.0-3.g4f48e61.dirty");
  });

  it("returns null for tags outside the contract so the caller can fall back", () => {
    // 旧版日期式 tag、以及 --always 在无 tag 时输出的裸提交号
    expect(formatDescribe("v20260830-4f48e61-0-g4f48e61")).toBeNull();
    expect(formatDescribe("4f48e61")).toBeNull();
    expect(formatDescribe("")).toBeNull();
  });
});

describe("parseVersion", () => {
  it("recovers the commit for hover details", () => {
    expect(parseVersion("0.1.0-3.g4f48e61")).toEqual({ commit: "4f48e61" });
    expect(parseVersion("0.1.0-3.g4f48e61.dirty")).toEqual({ commit: "4f48e61" });
  });

  it("returns null when the version carries no commit", () => {
    expect(parseVersion("0.1.0")).toBeNull();
    expect(parseVersion("0.1.0-dirty")).toBeNull();
    expect(parseVersion(FALLBACK_VERSION)).toBeNull();
  });

  it("returns null for versions outside the contract", () => {
    expect(parseVersion("1.2.3.4")).toBeNull();
    expect(parseVersion("20260830")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("resolveAppVersion", () => {
  it("prefers the injected build version and never shells out for git", () => {
    let probed = false;
    const resolved = resolveAppVersion({ env: { [VERSION_ENV_KEY]: "v0.1.0" }, probeGit: () => { probed = true; return described; } });
    expect(resolved).toEqual({ version: "0.1.0", commit: null, source: "env" });
    expect(probed).toBe(false);
  });

  it("accepts an injected version without the v prefix", () => {
    expect(resolveAppVersion({ env: { [VERSION_ENV_KEY]: "0.1.0" } }).version).toBe("0.1.0");
  });

  it("falls back to the local git checkout when nothing is injected", () => {
    expect(resolveAppVersion({ env: {}, probeGit: () => described })).toEqual({ version: "0.1.0-3.g4f48e61", commit: "4f48e61", source: "git" });
  });

  it("carries the dirty marker through to the reported version", () => {
    const resolved = resolveAppVersion({ env: {}, probeGit: () => `${described}-dirty` });
    expect(resolved.version).toBe("0.1.0-3.g4f48e61.dirty");
    expect(resolved.source).toBe("git");
  });

  it("degrades to a clearly non-release version instead of failing", () => {
    const resolved = resolveAppVersion({ env: {}, probeGit: () => null });
    expect(resolved).toEqual({ version: FALLBACK_VERSION, commit: null, source: "fallback" });
  });

  it("treats a non-semver tag as no tag at all instead of reporting it", () => {
    // 旧版日期式 tag 仍可能留在历史里，不能被当成发布版本号显示出去
    expect(resolveAppVersion({ env: {}, probeGit: () => "v20260830-4f48e61-0-g4f48e61" }).source).toBe("fallback");
  });

  it("ignores a blank injection and still tries git", () => {
    expect(resolveAppVersion({ env: { [VERSION_ENV_KEY]: "  " }, probeGit: () => described }).source).toBe("git");
  });
});
