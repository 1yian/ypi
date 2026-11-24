import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface BundledExtension {
  readonly id: string;
  readonly relativePath: string;
  readonly packageHints: readonly string[];
}

export interface LaunchOptions {
  readonly packageRoot?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LaunchPlan {
  readonly kind: "help" | "exec";
  readonly piBin: string;
  readonly args: readonly string[];
}

const PASSTHROUGH_SUBCOMMANDS = new Set([
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
  "config",
  "auth",
  "mcp",
]);

const BUNDLED_PACKAGES: readonly BundledExtension[] = [
  {
    id: "pi-tiers",
    relativePath: "node_modules/pi-tiers/src/index.ts",
    packageHints: ["pi-tiers"],
  },
  {
    id: "pi-web-access",
    relativePath: "node_modules/pi-web-access/dist",
    packageHints: ["pi-web-access"],
  },
  {
    id: "pi-fff",
    relativePath: "node_modules/@ff-labs/pi-fff/src/index.ts",
    packageHints: ["@ff-labs/pi-fff", "pi-fff"],
  },
];

const CORE_EXTENSIONS: readonly string[] = ["src/optchat.ts", "src/tui.ts", "src/calm.ts"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveAgentDir(env: NodeJS.ProcessEnv): string {
  const configured = env["PI_CODING_AGENT_DIR"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured.replace(/^~(?=\/|$)/u, homedir()));
  }
  return join(homedir(), ".pi", "agent");
}

function readConfiguredPackageSources(settingsPath: string): readonly string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) return [];
    const sources: string[] = [];
    for (const entry of parsed["packages"]) {
      if (typeof entry === "string") {
        sources.push(entry);
      } else if (isRecord(entry) && typeof entry["source"] === "string") {
        sources.push(entry["source"]);
      }
    }
    return sources;
  } catch {
    return [];
  }
}

function hasAnySourceMatch(sources: readonly string[], hints: readonly string[]): boolean {
  return sources.some((source) => {
    const lower = source.toLowerCase();
    return hints.some((hint) => lower.includes(hint.toLowerCase()));
  });
}

function hasFlag(argv: readonly string[], names: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") break;
    if (names.includes(arg)) return true;
    for (const name of names) {
      if (name.startsWith("--") && arg.startsWith(`${name}=`)) return true;
    }
  }
  return false;
}

function stripYpiFlags(argv: readonly string[]): {
  readonly isolated: boolean;
  readonly showYpiHelp: boolean;
  readonly rest: readonly string[];
} {
  let isolated = false;
  let showYpiHelp = false;
  const rest: string[] = [];
  let afterDoubleDash = false;
  for (const arg of argv) {
    if (arg === "--") {
      afterDoubleDash = true;
      rest.push(arg);
      continue;
    }
    if (!afterDoubleDash && arg === "--isolated") {
      isolated = true;
      continue;
    }
    if (!afterDoubleDash && arg === "--ypi-help") {
      showYpiHelp = true;
      continue;
    }
    rest.push(arg);
  }
  return { isolated, showYpiHelp, rest };
}

export function formatYpiHelp(): string {
  return [
    "ypi - Pi with pi-tiers, pi-web-access, pi-fff, OptChat, ypi themes, TUI, and /calm",
    "",
    "Usage:",
    "  ypi [ypi-options] [pi-options...] [prompt...]",
    "",
    "ypi options:",
    "  --isolated          Disable global Pi extensions and load only ypi's bundle",
    "  --ypi-help          Show this help (use --help for full Pi CLI help)",
    "",
    "Environment:",
    "  YPI_THEME           Initial theme override (default: ypi, or ypi-light/ypi)",
    "  YPI_ISOLATED=1      Same as --isolated",
    "  YPI_PI_BIN          Path to pi executable (default: pi)",
    "  YPI_OPTCHAT_CONFIG  Explicit path to optchat.json",
    "  YPI_CALM_FILE       Explicit path for persisted /calm state",
  ].join("\n");
}

function readEnvString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value !== undefined && value.length > 0 ? value : fallback;
}

function collectExtensionArgs(
  packageRoot: string,
  ignoreGlobalSettings: boolean,
  configuredSources: readonly string[],
): string[] {
  if (hasAnySourceMatch(configuredSources, ["1yian/ypi", "/ypi"])) return [];
  const args: string[] = [];
  for (const pkg of BUNDLED_PACKAGES) {
    if (ignoreGlobalSettings || !hasAnySourceMatch(configuredSources, pkg.packageHints)) {
      const abs = resolve(packageRoot, pkg.relativePath);
      if (existsSync(abs)) args.push("-e", abs);
    }
  }
  for (const rel of CORE_EXTENSIONS) {
    const abs = resolve(packageRoot, rel);
    if (existsSync(abs)) args.push("-e", abs);
  }
  return args;
}

function collectThemeArgs(
  packageRoot: string,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
): string[] {
  const themesDir = resolve(packageRoot, "themes");
  if (hasFlag(rest, ["--no-themes"]) || !existsSync(themesDir)) return [];
  const args = ["--theme", themesDir];
  if (!hasFlag(rest, ["--use-theme"])) {
    args.push("--use-theme", readEnvString(env, "YPI_THEME", "ypi"));
  }
  return args;
}

export function buildPiLaunchPlan(
  argv: readonly string[],
  options: LaunchOptions = {},
): LaunchPlan {
  const env = options.env ?? process.env;
  const piBin = readEnvString(env, "YPI_PI_BIN", "pi");
  const packageRoot = options.packageRoot ?? resolve(import.meta.dirname, "..");
  const cwd = options.cwd ?? process.cwd();

  const { isolated: isolatedFlag, showYpiHelp, rest } = stripYpiFlags(argv);
  if (showYpiHelp) {
    return { kind: "help", piBin, args: [] };
  }

  const first = rest[0];
  if (
    (first !== undefined && PASSTHROUGH_SUBCOMMANDS.has(first)) ||
    hasFlag(rest, ["--help", "-h", "--version", "-v"])
  ) {
    return { kind: "exec", piBin, args: rest };
  }

  const isolated = isolatedFlag || env["YPI_ISOLATED"] === "1" || env["YPI_ISOLATED"] === "true";
  const userDisabledExtensions = hasFlag(rest, ["--no-extensions", "-ne"]);
  const ignoreGlobalSettings = isolated || userDisabledExtensions;

  const configuredSources = ignoreGlobalSettings
    ? []
    : [
        ...readConfiguredPackageSources(join(resolveAgentDir(env), "settings.json")),
        ...readConfiguredPackageSources(join(cwd, ".pi", "settings.json")),
      ];

  const injected: string[] = [
    ...(isolated && !userDisabledExtensions ? ["--no-extensions"] : []),
    ...collectExtensionArgs(packageRoot, ignoreGlobalSettings, configuredSources),
    ...collectThemeArgs(packageRoot, rest, env),
  ];

  return {
    kind: "exec",
    piBin,
    args: [...injected, ...rest],
  };
}
