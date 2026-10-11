import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "release-version.mjs");

function writeJson(dir, relative, obj) {
  const absolute = join(dir, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(obj, null, 2) + "\n");
}
function fixture(versions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tunex-release-"));
  const root = versions.root ?? "1.0.1";
  const api = versions.api ?? root;
  const web = versions.web ?? root;
  const lockRoot = versions.lockRoot ?? root;
  writeJson(dir, "package.json", { name: "tuoxin-pay", version: root, private: true, workspaces: ["apps/*"] });
  writeJson(dir, "apps/api/package.json", { name: "@tuoxin-pay/api", version: api, private: true });
  writeJson(dir, "apps/web/package.json", { name: "@tuoxin-pay/web", version: web, private: true });
  writeJson(dir, "package-lock.json", {
    name: "tuoxin-pay",
    version: lockRoot,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "tuoxin-pay", version: versions.lockRootPackage ?? lockRoot },
      "apps/api": { name: "@tuoxin-pay/api", version: versions.lockApi ?? api },
      "apps/web": { name: "@tuoxin-pay/web", version: versions.lockWeb ?? web },
      "node_modules/dependency": { version: "0.1.0", integrity: "sha512-kept" },
    },
  });
  return dir;
}
function invoke(dir, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
}
function read(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

test("check verifies all seven manifest and lockfile versions", () => {
  const dir = fixture();
  try {
    const byRoot = invoke(dir, "--check");
    assert.equal(byRoot.status, 0, byRoot.stderr);
    const byTag = invoke(dir, "--check", "v1.0.1");
    assert.equal(byTag.status, 0, byTag.stderr);
    assert.match(byTag.stdout, /All 7 release metadata fields match v1\.0\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set synchronizes three package files and four lock fields without changing dependency versions", () => {
  const dir = fixture({ root: "1.0.0", api: "0.1.0", web: "0.1.0", lockRoot: "0.1.0" });
  try {
    const before = read(dir, "package-lock.json").packages["node_modules/dependency"];
    const prepared = invoke(dir, "--set", "v1.0.2");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(invoke(dir, "--check", "v1.0.2").status, 0);
    for (const path of ["package.json", "apps/api/package.json", "apps/web/package.json"]) {
      assert.equal(read(dir, path).version, "1.0.2");
    }
    const lock = read(dir, "package-lock.json");
    assert.equal(lock.version, "1.0.2");
    for (const path of ["", "apps/api", "apps/web"]) assert.equal(lock.packages[path].version, "1.0.2");
    assert.deepEqual(lock.packages["node_modules/dependency"], before);
    const second = invoke(dir, "--set", "v1.0.2");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(invoke(dir, "--check").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check fails closed when a workspace or lockfile disagrees with release tag", () => {
  const dir = fixture({ api: "1.0.0", lockApi: "1.0.0", lockRootPackage: "0.1.0" });
  try {
    const result = invoke(dir, "--check", "v1.0.1");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /apps\/api\/package\.json/);
    assert.match(result.stderr, /package-lock\.json/);
    assert.match(result.stderr, /release:prepare/);
    assert.notEqual(invoke(dir, "--check").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid or injection-like tag names never mutate release files", () => {
  const dir = fixture();
  try {
    const before = readFileSync(join(dir, "package.json"), "utf8");
    for (const invalid of ["v1.0", "v01.2.3", "v1.2.3+metadata", "v1.2.3;echo hacked", "", "v1.2.3-"]) {
      const result = invoke(dir, "--set", invalid);
      assert.notEqual(result.status, 0, invalid);
      assert.equal(readFileSync(join(dir, "package.json"), "utf8"), before);
    }
    assert.notEqual(invoke(dir, "--check", "v1.0.2").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown package identity is rejected before any file is edited", () => {
  const dir = fixture();
  try {
    const mismatched = read(dir, "apps/api/package.json");
    mismatched.name = "unexpected-app";
    writeJson(dir, "apps/api/package.json", mismatched);
    assert.notEqual(invoke(dir, "--set", "v1.0.2").status, 0);
    assert.equal(read(dir, "package.json").version, "1.0.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
