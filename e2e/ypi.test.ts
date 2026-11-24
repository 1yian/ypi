import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { z } from "zod";
import { createCalmHarborAnimation } from "../src/calm-animation.ts";
import { loadCalmPreference, saveCalmPreference } from "../src/calm-state.ts";
import { loadOptChatConfig } from "../src/config.ts";
import { buildPiLaunchPlan } from "../src/launch.ts";

const ROOT = resolve(import.meta.dirname, "..");

const StringArray = z.array(z.string());
const StringMap = z.record(z.string(), z.string());
const ColorValue = z.union([z.string(), z.number()]);
const ColorMap = z.record(z.string(), ColorValue);

const PackageManifestSchema = z.object({
  keywords: StringArray,
  dependencies: StringMap,
  peerDependencies: StringMap,
  pi: z.object({
    extensions: StringArray,
    themes: StringArray,
  }),
});

const ThemeFileSchema = z.object({
  name: z.string().min(1),
  appearance: z.enum(["dark", "light"]),
  vars: ColorMap,
  colors: ColorMap,
  export: z.object({
    pageBg: z.string(),
    cardBg: z.string(),
    infoBg: z.string(),
  }),
});

const FG_TOKENS: readonly ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
];

const BG_TOKENS: readonly ThemeBg[] = [
  "selectedBg",
  "searchMatchBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
];

function resolveThemeValue(
  raw: string | number,
  vars: Record<string, string | number>,
): string | number {
  let current = raw;
  let depth = 0;
  while (typeof current === "string" && current in vars && depth < 10) {
    current = vars[current] ?? current;
    depth += 1;
  }
  return current;
}

function resolveToken(
  token: string,
  colors: Record<string, string | number>,
  vars: Record<string, string | number>,
): string | number {
  const raw = colors[token];
  assert.ok(raw !== undefined, `missing theme token: ${token}`);
  return resolveThemeValue(raw, vars);
}

function buildThemeFromJson(filePath: string): Theme {
  const rawJson: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const parsed = ThemeFileSchema.parse(rawJson);

  const fgColors: Partial<Record<ThemeColor, string | number>> = {};
  for (const token of FG_TOKENS) {
    fgColors[token] = resolveToken(token, parsed.colors, parsed.vars);
  }
  const bgColors: Partial<Record<ThemeBg, string | number>> = {};
  for (const token of BG_TOKENS) {
    bgColors[token] = resolveToken(token, parsed.colors, parsed.vars);
  }

  const built: unknown = Reflect.construct(Theme, [
    fgColors,
    bgColors,
    "truecolor",
    { name: parsed.name, appearance: parsed.appearance },
  ]);
  assert.ok(built instanceof Theme, "expected Theme instance");
  return built;
}

void test("package.json declares a valid pi-package manifest and every extension and theme path resolves", () => {
  const rawPkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const pkg = PackageManifestSchema.parse(rawPkg);

  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.pi.extensions.length >= 6);
  assert.ok(pkg.pi.themes.includes("./themes"));

  for (const rel of pkg.pi.extensions) {
    const abs = resolve(ROOT, rel);
    assert.ok(existsSync(abs), `missing declared extension: ${rel}`);
  }

  for (const rel of pkg.pi.themes) {
    const abs = resolve(ROOT, rel);
    assert.ok(existsSync(abs), `missing declared theme directory: ${rel}`);
  }

  for (const hostPkg of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(pkg.dependencies[hostPkg], undefined, `${hostPkg} must not be in dependencies`);
    assert.equal(pkg.peerDependencies[hostPkg], "*", `${hostPkg} must be "*" in peerDependencies`);
  }
});

void test("bundled ypi and ypi-light themes resolve every variable and instantiate Pi Theme cleanly", () => {
  const dark = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
  assert.equal(dark.name, "ypi");
  assert.equal(dark.appearance, "dark");

  const light = buildThemeFromJson(join(ROOT, "themes", "ypi-light.json"));
  assert.equal(light.name, "ypi-light");
  assert.equal(light.appearance, "light");
});

void test("calm harbor animation fits every terminal width cleanly and persists calm preference", () => {
  const theme = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
  const animation = createCalmHarborAnimation();
  animation.setPhase("reading");

  for (const width of [10, 18, 28, 48, 80, 120]) {
    for (let step = 0; step < 12; step += 1) {
      animation.tick();
      const lines = animation.render(width, theme);
      assert.ok(lines.length > 0 && lines.length <= 3, `unexpected row count at width ${width}`);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `line exceeded width ${width}: ${visibleWidth(line)}`,
        );
      }
    }
  }

  const widePlain = animation
    .render(90, theme)
    .map((line) => stripTerminalSequences(line))
    .join("\n");
  assert.ok(widePlain.includes("☾"), "wide frame should render the crescent moon");
  assert.ok(widePlain.includes("╲▁▁▁╱"), "wide frame should render the sailboat hull");
  assert.ok(widePlain.includes("calm · reading"), "wide frame should show the quiet status phase");

  const dir = join(tmpdir(), `ypi-calm-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const prefFile = join(dir, "ypi-calm");
    assert.equal(loadCalmPreference(prefFile), false);
    saveCalmPreference(true, prefFile);
    assert.equal(loadCalmPreference(prefFile), true);
    saveCalmPreference(false, prefFile);
    assert.equal(loadCalmPreference(prefFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("loadOptChatConfig resolves provider-agnostic compactor and fold settings cleanly", () => {
  const dir = join(tmpdir(), `ypi-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const configPath = join(dir, "optchat.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        memoryHome: join(dir, "mem"),
        profile: "assistant",
        compactorProvider: "tier",
        compactorModel: "compact",
        thinking: "low",
        mode: "fold",
        foldTokens: 150_000,
        foldOnCacheExpiry: true,
      }),
    );

    const resolved = loadOptChatConfig(dir, configPath);
    assert.ok(resolved !== undefined);
    assert.equal(resolved.profile, "assistant");
    assert.equal(resolved.compactorProvider, "tier");
    assert.equal(resolved.compactorModel, "compact");
    assert.equal(resolved.foldTokens, 150_000);
    assert.equal(resolved.foldOnCacheExpiry, true);

    writeFileSync(configPath, JSON.stringify({ enabled: false }));
    assert.equal(loadOptChatConfig(dir, configPath), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("buildPiLaunchPlan wires bundled extensions, avoids duplicates, and respects flags", () => {
  const dir = join(tmpdir(), `ypi-launch-e2e-${Date.now()}`);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    const clean = buildPiLaunchPlan(["-p", "hello"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(clean.kind, "exec");
    assert.ok(clean.args.includes("--use-theme"));
    assert.ok(clean.args.includes("ypi"));
    assert.ok(clean.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(clean.args.some((arg) => arg.endsWith("src/tui.ts")));
    assert.ok(clean.args.some((arg) => arg.endsWith("src/calm.ts")));
    assert.deepEqual(clean.args.slice(-2), ["-p", "hello"]);

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-web-access@0.48.0", "git:github.com/1yian/pi-tiers@main"],
      }),
    );
    const deduped = buildPiLaunchPlan(["--use-theme", "ypi-light"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.ok(!deduped.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(!deduped.args.some((arg) => arg.endsWith("pi-web-access/dist")));
    assert.ok(deduped.args.some((arg) => arg.endsWith("@ff-labs/pi-fff/src/index.ts")));
    assert.ok(deduped.args.some((arg) => arg.endsWith("src/tui.ts")));
    assert.equal(
      deduped.args.filter((arg) => arg === "--use-theme").length,
      1,
      "must not duplicate user --use-theme",
    );

    const isolated = buildPiLaunchPlan(["--isolated", "-c"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.ok(isolated.args.includes("--no-extensions"));
    assert.ok(isolated.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(!isolated.args.includes("--isolated"));

    const passthrough = buildPiLaunchPlan(["auth", "status"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.deepEqual(passthrough.args, ["auth", "status"]);

    const help = buildPiLaunchPlan(["--ypi-help"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(help.kind, "help");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
