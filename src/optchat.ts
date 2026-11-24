import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadOptChatConfig, type ResolvedOptChatConfig } from "./config.ts";

interface OptChatCapabilities {
  readonly connectedWindows?: boolean;
  readonly viewBudget?: number;
  readonly transientCustomTypes?: readonly string[];
  readonly foldTokens?: number;
  readonly foldAfterIdle?: (model: ExtensionContext["model"]) => number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cacheLifetimeMs(model: ExtensionContext["model"]): number | undefined {
  const tier = process.env["PI_CACHE_RETENTION"] === "long" ? "long" : "short";
  const seconds = model?.promptCache?.[tier];
  return seconds === undefined ? undefined : seconds * 1000;
}

function ensureProfileDir(memoryHome: string, profile: string): string {
  const dir = resolve(memoryHome, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  const instructionsPath = resolve(dir, "AGENTS.md");
  if (!existsSync(instructionsPath)) {
    writeFileSync(instructionsPath, `# ${profile}\n`);
  }
  return dir;
}

function resolveCompactor(
  ctx: ExtensionContext,
  config: ResolvedOptChatConfig,
):
  | {
      readonly provider: string;
      readonly model: string;
      readonly thinking: ResolvedOptChatConfig["thinking"];
    }
  | undefined {
  if (config.compactorProvider !== undefined && config.compactorModel !== undefined) {
    const found = ctx.modelRegistry
      .getAll()
      .find((m) => m.provider === config.compactorProvider && m.id === config.compactorModel);
    if (found !== undefined) {
      return {
        provider: found.provider,
        model: found.id,
        thinking: config.thinking,
      };
    }
  }
  if (ctx.model !== undefined) {
    return {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinking: config.thinking,
    };
  }
  return undefined;
}

function callExport(mod: unknown, name: string, source: string, args: unknown[]): unknown {
  if (!isRecord(mod)) throw new TypeError(`${source} did not return a module object`);
  const fn: unknown = Reflect.get(mod, name);
  if (typeof fn !== "function") throw new TypeError(`${source} does not export function ${name}`);
  return Reflect.apply(fn, undefined, args);
}

export default async function ypiOptChat(pi: ExtensionAPI): Promise<void> {
  const config = loadOptChatConfig();
  if (config === undefined) return;

  process.env["OPTCHAT_HOME"] = config.memoryHome;
  const profileDir = ensureProfileDir(config.memoryHome, config.profile);

  const optchatUrl = new URL("../vendor/optchat/src/index.ts", import.meta.url).href;
  const profilesUrl = new URL("../vendor/optchat/src/profiles.ts", import.meta.url).href;
  const optchatRaw: unknown = await import(optchatUrl);
  const profilesRaw: unknown = await import(profilesUrl);

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const hasBinding = entries.some(
      (entry) => entry.type === "custom" && entry.customType === "optchat.profile",
    );
    if (!hasBinding) {
      pi.appendEntry("optchat.profile", { name: config.profile });
    }
    const compactor = resolveCompactor(ctx, config);
    if (compactor === undefined) return;
    const loaded = callExport(profilesRaw, "loadConfig", profilesUrl, [profileDir]);
    const previous = isRecord(loaded) ? loaded : {};
    const subagent =
      ctx.model === undefined
        ? previous["subagent"]
        : { provider: ctx.model.provider, model: ctx.model.id, thinking: "off" };
    callExport(profilesRaw, "saveConfig", profilesUrl, [
      profileDir,
      {
        ...previous,
        compactor,
        ...(subagent !== undefined ? { subagent } : {}),
      },
    ]);
  });

  const capabilities: OptChatCapabilities = {
    connectedWindows: false,
    ...(config.viewBudget !== undefined ? { viewBudget: config.viewBudget } : {}),
    ...(config.foldTokens !== undefined ? { foldTokens: config.foldTokens } : {}),
    ...(config.foldOnCacheExpiry ? { foldAfterIdle: cacheLifetimeMs } : {}),
    ...(config.transientCustomTypes.length > 0
      ? { transientCustomTypes: config.transientCustomTypes }
      : {}),
  };
  await Promise.resolve(callExport(optchatRaw, "default", optchatUrl, [pi, capabilities]));
}
