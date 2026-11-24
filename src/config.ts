import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_FOLD_TOKENS = 150_000;

export const OptChatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  memoryHome: z.string().min(1).default("~/.pi/agent/optchat"),
  profile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
    .default("default"),
  compactorProvider: z.string().min(1).optional(),
  compactorModel: z.string().min(1).optional(),
  thinking: z.enum(THINKING_LEVELS).default("low"),
  mode: z.literal("fold").optional(),
  foldTokens: z.number().int().min(1000).optional(),
  foldOnCacheExpiry: z.boolean().default(true),
  viewBudget: z.number().int().min(16_000).max(128_000).optional(),
  transientCustomTypes: z.array(z.string().min(1)).default([]),
});

export interface ResolvedOptChatConfig {
  readonly configPath: string;
  readonly memoryHome: string;
  readonly profile: string;
  readonly compactorProvider: string | undefined;
  readonly compactorModel: string | undefined;
  readonly thinking: (typeof THINKING_LEVELS)[number];
  readonly foldTokens: number | undefined;
  readonly foldOnCacheExpiry: boolean;
  readonly viewBudget: number | undefined;
  readonly transientCustomTypes: readonly string[];
}

function expandPath(input: string, baseDir: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function findOptChatConfigPath(cwd: string = process.cwd()): string | undefined {
  const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? resolve(homedir(), ".pi", "agent");
  const candidates = [
    process.env["YPI_OPTCHAT_CONFIG"],
    resolve(cwd, ".pi", "optchat.json"),
    resolve(agentDir, "optchat.json"),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

export function loadOptChatConfig(
  cwd: string = process.cwd(),
  explicitPath?: string,
): ResolvedOptChatConfig | undefined {
  const configPath = explicitPath ?? findOptChatConfigPath(cwd);
  if (configPath === undefined || !existsSync(configPath)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = OptChatConfigSchema.parse(raw);
  if (!parsed.enabled) return undefined;
  const baseDir = dirname(configPath);
  return {
    configPath,
    memoryHome: expandPath(parsed.memoryHome, baseDir),
    profile: parsed.profile,
    compactorProvider: parsed.compactorProvider,
    compactorModel: parsed.compactorModel,
    thinking: parsed.thinking,
    foldTokens: parsed.mode === "fold" ? (parsed.foldTokens ?? DEFAULT_FOLD_TOKENS) : undefined,
    foldOnCacheExpiry: parsed.foldOnCacheExpiry,
    viewBudget: parsed.viewBudget,
    transientCustomTypes: parsed.transientCustomTypes,
  };
}
