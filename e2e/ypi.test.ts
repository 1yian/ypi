import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadOptChatConfig } from "../src/config.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tempDirs: string[] = [];

const PiFieldSchema = z.object({ extensions: z.array(z.string()) });
const StringRecordSchema = z.record(z.string(), z.string());
const PackageManifestSchema = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  pi: PiFieldSchema,
  dependencies: StringRecordSchema,
  peerDependencies: StringRecordSchema,
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

void test("package.json declares a valid pi-package manifest and every extension path resolves", () => {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = PackageManifestSchema.parse(raw);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.pi.extensions.length, 4);

  for (const rel of manifest.pi.extensions) {
    assert.equal(existsSync(resolve(ROOT, rel)), true, `missing extension path: ${rel}`);
  }

  for (const hostPkg of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies[hostPkg], "*");
    assert.equal(manifest.dependencies[hostPkg], undefined);
  }
});

void test("loadOptChatConfig resolves provider-agnostic compactor and fold settings cleanly", () => {
  const dir = makeTempDir("ypi-e2e-");
  const cfgPath = join(dir, "optchat.json");

  writeFileSync(
    cfgPath,
    JSON.stringify({
      enabled: true,
      memoryHome: "./mem",
      profile: "jarvis",
      compactorProvider: "tier",
      compactorModel: "compact",
      thinking: "low",
      mode: "fold",
      foldTokens: 120_000,
      foldOnCacheExpiry: true,
    }),
  );

  const loaded = loadOptChatConfig(dir, cfgPath);
  assert.ok(loaded !== undefined);
  assert.equal(loaded.profile, "jarvis");
  assert.equal(loaded.memoryHome, join(dir, "mem"));
  assert.equal(loaded.compactorProvider, "tier");
  assert.equal(loaded.compactorModel, "compact");
  assert.equal(loaded.foldTokens, 120_000);
  assert.equal(loaded.foldOnCacheExpiry, true);

  writeFileSync(cfgPath, JSON.stringify({ enabled: false }));
  assert.equal(loadOptChatConfig(dir, cfgPath), undefined);
});
