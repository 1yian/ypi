import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_FOLD_TOKENS = 150_000;
const DEFAULT_COMPACTOR_PROVIDER = "tier";
const DEFAULT_COMPACTOR_MODEL = "compact";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const OptChatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  memoryHome: z.string().min(1).optional(),
  profile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
    .optional(),
  compactorProvider: z.string().min(1).optional(),
  compactorModel: z.string().min(1).optional(),
  thinking: ThinkingLevelSchema.default("low"),
  mode: z.enum(["fold", "tree"]).default("fold"),
  foldTokens: z.number().int().positive().optional(),
  foldOnCacheExpiry: z.boolean().default(true),
  viewBudget: z.number().int().positive().optional(),
  transientCustomTypes: z.array(z.string().min(1)).default([]),
});

type OptChatConfig = z.infer<typeof OptChatConfigSchema>;

export interface ResolvedOptChatConfig {
  readonly configPath: string | undefined;
  readonly memoryHome: string;
  readonly profile: string | undefined;
  readonly compactorProvider: string;
  readonly compactorModel: string;
  readonly thinking: OptChatConfig["thinking"];
  readonly foldTokens: number | undefined;
  readonly foldOnCacheExpiry: boolean;
  readonly viewBudget: number | undefined;
  readonly transientCustomTypes: readonly string[];
}

function resolveAgentDir(env: NodeJS.ProcessEnv): string {
  const configured = env["PI_CODING_AGENT_DIR"]?.trim();
  if (configured !== undefined && configured.length > 0) {
    return resolve(configured.replace(/^~(?=\/|$)/u, homedir()));
  }
  return join(homedir(), ".pi", "agent");
}

function expandPath(raw: string, baseDir: string): string {
  if (raw === "~" || raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2));
  }
  return resolve(baseDir, raw);
}

function isDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env["YPI_OPTCHAT"]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

function findOptChatConfigPath(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const agentDir = resolveAgentDir(env);
  const candidates = [
    env["YPI_OPTCHAT_CONFIG"]?.trim(),
    resolve(cwd, ".pi", "optchat.json"),
    resolve(agentDir, "optchat.json"),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && candidate.length > 0 && existsSync(candidate),
  );
}

export function loadOptChatConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOptChatConfig | undefined {
  if (isDisabledByEnv(env)) return undefined;

  const agentDir = resolveAgentDir(env);
  const defaultMemoryHome = join(agentDir, "ypi", "optchat");
  const configPath = explicitPath ?? findOptChatConfigPath(cwd, env);

  if (configPath === undefined || !existsSync(configPath)) {
    return {
      configPath: undefined,
      memoryHome: defaultMemoryHome,
      profile: undefined,
      compactorProvider: DEFAULT_COMPACTOR_PROVIDER,
      compactorModel: DEFAULT_COMPACTOR_MODEL,
      thinking: "low",
      foldTokens: DEFAULT_FOLD_TOKENS,
      foldOnCacheExpiry: true,
      viewBudget: undefined,
      transientCustomTypes: [],
    };
  }

  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = OptChatConfigSchema.parse(raw);
  if (!parsed.enabled) return undefined;

  const baseDir = dirname(configPath);
  const memoryHome =
    parsed.memoryHome === undefined ? defaultMemoryHome : expandPath(parsed.memoryHome, baseDir);

  return {
    configPath,
    memoryHome,
    profile: parsed.profile,
    compactorProvider: parsed.compactorProvider ?? DEFAULT_COMPACTOR_PROVIDER,
    compactorModel: parsed.compactorModel ?? DEFAULT_COMPACTOR_MODEL,
    thinking: parsed.thinking,
    foldTokens: parsed.mode === "fold" ? (parsed.foldTokens ?? DEFAULT_FOLD_TOKENS) : undefined,
    foldOnCacheExpiry: parsed.foldOnCacheExpiry,
    viewBudget: parsed.viewBudget,
    transientCustomTypes: parsed.transientCustomTypes,
  };
}
