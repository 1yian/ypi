import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadOptChatConfig, type ResolvedOptChatConfig } from "./config.ts";

interface OptChatCapabilities {
  readonly connectedWindows?: boolean;
  readonly subagents?: boolean;
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

function callExport(mod: unknown, name: string, source: string, args: unknown[]): unknown {
  if (!isRecord(mod)) throw new TypeError(`${source} did not return a module object`);
  const fn: unknown = Reflect.get(mod, name);
  if (typeof fn !== "function") throw new TypeError(`${source} does not export function ${name}`);
  return Reflect.apply(fn, undefined, args);
}

function sessionProfileName(sessionId: string): string {
  const cleaned = sessionId.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "");
  const suffix = cleaned.length > 0 ? cleaned.slice(0, 20) : Date.now().toString(36);
  return `s-${suffix}`;
}

function findBoundProfile(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === "optchat.profile") {
      const data: unknown = entry.data;
      if (isRecord(data) && typeof data["name"] === "string" && data["name"].length > 0) {
        return data["name"];
      }
    }
  }
  return undefined;
}

function ensureProfileDir(
  profilesRaw: unknown,
  profilesUrl: string,
  memoryHome: string,
  profile: string,
): string {
  const dir = resolve(memoryHome, "profiles", profile);
  if (!existsSync(dir)) {
    callExport(profilesRaw, "createProfile", profilesUrl, [profile]);
    return dir;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(dir, "config.json"))) {
    const defaults: unknown = isRecord(profilesRaw) ? Reflect.get(profilesRaw, "defaults") : {};
    callExport(profilesRaw, "saveConfig", profilesUrl, [dir, isRecord(defaults) ? defaults : {}]);
  }
  if (!existsSync(resolve(dir, "AGENTS.md"))) {
    writeFileSync(resolve(dir, "AGENTS.md"), `# ${profile}\n`);
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
  if (ctx.model !== undefined) {
    return {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinking: config.thinking,
    };
  }
  return undefined;
}

export default async function ypiOptChat(pi: ExtensionAPI): Promise<void> {
  const config = loadOptChatConfig();
  if (config === undefined) return;

  process.env["OPTCHAT_HOME"] = config.memoryHome;
  const optchatUrl = new URL("../vendor/optchat/src/index.ts", import.meta.url).href;
  const profilesUrl = new URL("../vendor/optchat/src/profiles.ts", import.meta.url).href;
  const optchatRaw: unknown = await import(optchatUrl);
  const profilesRaw: unknown = await import(profilesUrl);

  let ephemeralProfileDir: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    const bound = findBoundProfile(ctx);
    const profileName =
      bound ?? config.profile ?? sessionProfileName(ctx.sessionManager.getSessionId());
    const profileDir = ensureProfileDir(profilesRaw, profilesUrl, config.memoryHome, profileName);
    const isEphemeral =
      bound === undefined &&
      config.profile === undefined &&
      ctx.sessionManager.getSessionFile() === undefined;
    ephemeralProfileDir = isEphemeral ? profileDir : undefined;

    if (bound === undefined) {
      pi.appendEntry("optchat.profile", { name: profileName });
    }
    const compactor = resolveCompactor(ctx, config);
    if (compactor === undefined) return;
    const loaded = callExport(profilesRaw, "loadConfig", profilesUrl, [profileDir]);
    const previous = isRecord(loaded) ? loaded : {};
    callExport(profilesRaw, "saveConfig", profilesUrl, [
      profileDir,
      {
        ...previous,
        compactor,
      },
    ]);
  });

  const capabilities: OptChatCapabilities = {
    connectedWindows: false,
    subagents: false,
    ...(config.viewBudget !== undefined ? { viewBudget: config.viewBudget } : {}),
    ...(config.foldTokens !== undefined ? { foldTokens: config.foldTokens } : {}),
    ...(config.foldOnCacheExpiry ? { foldAfterIdle: cacheLifetimeMs } : {}),
    ...(config.transientCustomTypes.length > 0
      ? { transientCustomTypes: config.transientCustomTypes }
      : {}),
  };
  await Promise.resolve(callExport(optchatRaw, "default", optchatUrl, [pi, capabilities]));

  pi.on("session_shutdown", () => {
    if (ephemeralProfileDir === undefined) return;
    try {
      rmSync(ephemeralProfileDir, { recursive: true, force: true });
    } catch {
      return;
    }
    ephemeralProfileDir = undefined;
  });
}
