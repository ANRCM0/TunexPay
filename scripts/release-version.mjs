#!/usr/bin/env node
/**
 * TuneXPay release metadata contract.
 * Prepare: node scripts/release-version.mjs --set v1.0.2
 * Verify:  node scripts/release-version.mjs --check [v1.0.2]
 *
 * Tags are immutable release identifiers. This helper updates source manifests
 * BEFORE a commit/tag; tagged CI only validates, never rewrites an existing tag.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestSpecs = [
  ["package.json", "tuoxin-pay"],
  ["apps/api/package.json", "@tuoxin-pay/api"],
  ["apps/web/package.json", "@tuoxin-pay/web"],
];
const lockPath = "package-lock.json";
const lockSpecs = [
  ["", "tuoxin-pay"],
  ["apps/api", "@tuoxin-pay/api"],
  ["apps/web", "@tuoxin-pay/web"],
];
const releasePattern = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

function fail(message) {
  throw new Error(message);
}

function cleanVersion(raw) {
  const match = releasePattern.exec(raw ?? "");
  if (!match) {
    fail(`Invalid release version "${raw}". Use vMAJOR.MINOR.PATCH (optionally -rc.1), e.g. v1.0.2.`);
  }
  return match[1];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  } catch (error) {
    fail(`Cannot read valid JSON at ${path}: ${error.message}`);
  }
}

function metadata() {
  const manifests = manifestSpecs.map(([path, name]) => {
    const data = readJson(path);
    if (data.name !== name) fail(`Unexpected package name in ${path}: ${data.name}`);
    return { path, data };
  });
  const lock = readJson(lockPath);
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    fail("Expected npm lockfile v3 with root and workspace package records.");
  }
  for (const [key, name] of lockSpecs) {
    if (lock.packages[key]?.name !== name) {
      fail(`Unexpected package-lock.json packages[${JSON.stringify(key)}] name.`);
    }
  }
  if (lock.name !== "tuoxin-pay") fail("Unexpected package-lock.json root package.");
  return { manifests, lock };
}

function records({ manifests, lock }) {
  return [
    ...manifests.map(({ path, data }) => [path, data.version]),
    ["package-lock.json (root)", lock.version],
    ...lockSpecs.map(([key]) => [`package-lock.json packages[${JSON.stringify(key)}]`, lock.packages[key].version]),
  ];
}

function verify(all, expected) {
  const errors = records(all).filter(([, value]) => value !== expected);
  if (errors.length) {
    for (const [path, value] of errors) {
      console.error(`  ✗ ${path}: ${JSON.stringify(value)} (expected ${expected})`);
    }
    fail(`Release metadata mismatch. Run: npm run release:prepare -- v${expected}, commit all four files, then tag THAT commit.`);
  }
  console.log(`✓ All 7 release metadata fields match v${expected}.`);
}

function prepare(all, version) {
  for (const { data } of all.manifests) data.version = version;
  all.lock.version = version;
  for (const [key] of lockSpecs) all.lock.packages[key].version = version;
  // Keep the original npm lock dependency graph and integrity checksums intact.
  for (const { path, data } of all.manifests) {
    writeFileSync(resolve(process.cwd(), path), `${JSON.stringify(data, null, 2)}\n`);
  }
  writeFileSync(resolve(process.cwd(), lockPath), `${JSON.stringify(all.lock, null, 2)}\n`);
  verify(all, version);
  console.log(`Prepared v${version}. Review, commit and push the four files BEFORE creating/pushing tag v${version}.`);
}

function main(args) {
  if (args[0] === "--set" && args.length === 2) {
    prepare(metadata(), cleanVersion(args[1]));
  } else if (args[0] === "--check" && (args.length === 1 || args.length === 2)) {
    const all = metadata();
    verify(all, args[1] ? cleanVersion(args[1]) : cleanVersion(all.manifests[0].data.version));
  } else {
    fail("Usage: node scripts/release-version.mjs --set v1.0.2 | --check [v1.0.2]");
  }
}
try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Release version error: ${error.message}`);
  process.exitCode = 1;
}
