import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  createActivityTracker,
  OPTCHAT_COMPACTING_EVENT,
  parseCompactingEvent,
  type ActivitySnapshot,
} from "./activity.ts";
import {
  ACTIVITY_TICK_MS,
  CALM_ACTIVITY_TICK_MS,
  phaseRailToken,
  renderActivityBorder,
} from "./activity-renderer.ts";
import { CALM_EVENT, LEGACY_CALM_EVENT, loadCalmPreference, parseCalmEvent } from "./calm-state.ts";

type Theme = ExtensionContext["ui"]["theme"];
type ForegroundToken = Parameters<Theme["fg"]>[0];

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface UsageLike {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly cost?: { readonly total?: number | undefined } | number | undefined;
}

interface TierRoute {
  readonly selected: string;
  readonly tier: string;
  readonly auto?: { readonly confidence?: number; readonly unsure: boolean };
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly position: number;
  readonly warn: boolean;
}

interface ToolLineState {
  args?: unknown;
  isPartial?: boolean | undefined;
  isError?: boolean | undefined;
  durationMs?: number | undefined;
  resultText?: string | undefined;
}

interface StatItem {
  readonly text: string;
  readonly priority: number;
  readonly short?: string;
}

interface YpiEditorCallbacks {
  readonly getTheme: () => Theme;
  readonly getThinkingLevel: () => string;
  readonly isCalmActive: () => boolean;
  readonly getActivitySnapshot: () => ActivitySnapshot;
  readonly getAnimationTick: () => number;
  readonly canInterruptAndSend: () => boolean;
  readonly onInterruptAndSend: (readEditorText: () => string, clearEditor: () => void) => boolean;
  readonly onContinueShortcut: () => void;
  readonly onCompactCommand: () => boolean;
  readonly onExportCommand: () => void;
}

const CONTINUE_MESSAGE_TYPE = "ypi-continue";
const MANUAL_CONTINUE_PROMPT = `<system-notice>
Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>`;

type PendingInterruptAction =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "continue" };

const FAST_MODE_KEY = "codex-fast-mode";
const TIERS_KEY = "pi-tiers";
const TOKENS_PER_SECOND_KEY = "tokens-per-second";
const HIDDEN_STATUS_KEYS = new Set([TOKENS_PER_SECOND_KEY, FAST_MODE_KEY, TIERS_KEY]);
const TIERS_PROVIDER = "tier";
const SPEED_RENDER_INTERVAL_MS = 250;
const GAP = "  ";
const ICON_DIR = "\uF07B";
const ICON_BRANCH = "\uE0A0";
const ICON_DIAMOND = "◆";
const ICON_CALM = "☾";
const CONTEXT_BAR_WIDTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(obj: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) return val.trim();
  }
  return undefined;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 100) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatCwd(cwd: string): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (home === undefined || home.length === 0) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function shortenPath(raw: string, cwd: string): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (cwd.length > 0 && raw.startsWith(`${cwd}/`)) {
    return raw.slice(cwd.length + 1);
  }
  if (home !== undefined && home.length > 0 && raw.startsWith(`${home}/`)) {
    return `~${raw.slice(home.length)}`;
  }
  return raw;
}

function sanitize(text: string): string {
  return text
    .replaceAll(/[\r\n\t]+/gu, " ")
    .replaceAll(/ +/gu, " ")
    .trim();
}

function shortModel(id: string): string {
  return id.replace(/^claude-/u, "").replace(/-(\d+)-(\d+)$/u, "-$1.$2");
}

function parseUsage(value: unknown): UsageLike | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input: readNumber(value["input"]),
    output: readNumber(value["output"]),
    cacheRead: readNumber(value["cacheRead"]),
    cacheWrite: readNumber(value["cacheWrite"]),
    cost:
      typeof value["cost"] === "number"
        ? value["cost"]
        : isRecord(value["cost"])
          ? { total: readNumber(value["cost"]["total"]) }
          : undefined,
  };
}

function addUsage(totals: Totals, usage: UsageLike | undefined): void {
  if (usage === undefined) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += typeof usage.cost === "number" ? usage.cost : (usage.cost?.total ?? 0);
}

function thinkingTokenForLevel(level: string): ForegroundToken {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "accent";
  }
}

function spread(left: string, right: string, width: number): string {
  const room = width - visibleWidth(left) - visibleWidth(right);
  if (right.length > 0 && room >= GAP.length) {
    return left + " ".repeat(room) + right;
  }
  return truncateToWidth(left, width, "…");
}

function contextBar(theme: Theme, percent: number | null, color: ForegroundToken): string {
  const ratio = percent === null ? 0 : Math.max(0, Math.min(1, percent / 100));
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
  const empty = Math.max(0, CONTEXT_BAR_WIDTH - filled);
  return (
    (filled > 0 ? theme.fg(color, "━".repeat(filled)) : "") +
    (empty > 0 ? theme.fg("borderMuted", "─".repeat(empty)) : "")
  );
}

function parseTierRoute(data: unknown): TierRoute | null {
  if (!isRecord(data)) return null;
  const selected = data["selected"];
  const tier = data["tier"];
  const provider = data["provider"];
  const model = data["model"];
  const thinking = data["thinking"];
  const position = data["position"];
  const warn = data["warn"];
  if (
    typeof selected !== "string" ||
    typeof tier !== "string" ||
    typeof provider !== "string" ||
    typeof model !== "string" ||
    typeof thinking !== "string" ||
    typeof position !== "number" ||
    typeof warn !== "boolean"
  ) {
    return null;
  }
  const autoRaw = data["auto"];
  const auto =
    isRecord(autoRaw) && typeof autoRaw["unsure"] === "boolean"
      ? {
          unsure: autoRaw["unsure"],
          ...(typeof autoRaw["confidence"] === "number"
            ? { confidence: autoRaw["confidence"] }
            : {}),
        }
      : undefined;
  return {
    selected,
    tier,
    provider,
    model,
    thinking,
    position,
    warn,
    ...(auto !== undefined ? { auto } : {}),
  };
}

function extractSearchSubject(args: unknown, cwd: string): string {
  const pattern = readString(args, ["pattern", "query"]);
  const path = readString(args, ["path"]);
  if (pattern !== undefined && path !== undefined) return `${pattern} in ${shortenPath(path, cwd)}`;
  if (pattern !== undefined) return pattern;
  return path === undefined ? "" : shortenPath(path, cwd);
}

function extractWebSearchSubject(args: unknown): string {
  if (isRecord(args) && Array.isArray(args["queries"])) {
    const first = args["queries"].find((item): item is string => typeof item === "string");
    if (first !== undefined) return sanitize(first);
  }
  return readString(args, ["query"]) ?? "";
}

function extractToolSubject(toolName: string, args: unknown, cwd: string): string {
  const lower = toolName.toLowerCase();
  if (lower === "read" || lower === "write" || lower === "edit") {
    const file = readString(args, ["path", "file_path", "filePath"]);
    return file === undefined ? "" : shortenPath(file, cwd);
  }
  if (lower === "bash") {
    const cmd = readString(args, ["command", "cmd"]);
    return cmd === undefined ? "" : sanitize(cmd.split("\n")[0] ?? "");
  }
  if (lower.includes("grep") || lower.includes("find")) return extractSearchSubject(args, cwd);
  if (lower === "web_search") return extractWebSearchSubject(args);
  if (lower === "fetch_content") return readString(args, ["url"]) ?? "";
  const fallback = readString(args, [
    "path",
    "url",
    "command",
    "pattern",
    "query",
    "title",
    "id",
    "name",
  ]);
  return fallback === undefined ? "" : sanitize(fallback);
}

function extractResultText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function summarizeToolMeta(state: ToolLineState): string | undefined {
  const parts: string[] = [];
  if (state.isPartial === true) {
    parts.push("running");
  } else {
    const duration = formatDuration(state.durationMs);
    if (duration !== undefined) parts.push(duration);
    if (state.resultText !== undefined && state.resultText.length > 0) {
      const lines = state.resultText.split("\n").length;
      if (state.isError === true) {
        parts.push(sanitize(state.resultText.split("\n")[0] ?? "error").slice(0, 48));
      } else if (lines > 1) {
        parts.push(`${lines} lines`);
      }
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function installHeader(ctx: ExtensionContext): void {
  ctx.ui.setHeader((_tui, theme) => ({
    invalidate: () => undefined,
    render(width: number): string[] {
      if (width <= 0) return [];
      const margin = width >= 24 ? 1 : 0;
      const inner = Math.max(1, width - margin * 2);
      const pad = " ".repeat(margin);
      const brand = theme.bold(theme.fg("accent", `${ICON_DIAMOND} ypi`));
      const cwd = theme.fg("muted", formatCwd(ctx.sessionManager.getCwd()));
      const modelLabel = ctx.model === undefined ? "" : theme.fg("dim", ctx.model.id);
      const top = spread(`${brand}  ${cwd}`, modelLabel, inner);
      const hint = truncateToWidth(
        theme.fg("dim", "/calm focus · /settings theme · ctrl+o expand tools"),
        inner,
        "…",
      );
      return [`${pad}${top}`, `${pad}${hint}`];
    },
  }));
}

function buildTierHeadVariants(
  theme: Theme,
  modelId: string,
  tierRoute: TierRoute | null,
): readonly string[] {
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);
  const route = tierRoute !== null && tierRoute.selected === modelId ? tierRoute : undefined;
  const arrow = dim(" → ");
  const autoStep =
    route?.auto !== undefined ? muted(route.auto.unsure ? "auto?" : "auto") + arrow : "";
  const tierName = theme.fg("text", route?.tier ?? modelId);
  const drop =
    route !== undefined && route.position > 1 ? theme.fg("warning", ` ↓${route.position}`) : "";
  const answering =
    route !== undefined
      ? theme.bold(theme.fg(route.warn ? "warning" : "accent", shortModel(route.model)))
      : dim("…");
  const effort =
    route !== undefined
      ? ` ${theme.fg(thinkingTokenForLevel(route.thinking), route.thinking)}`
      : "";
  const account = route !== undefined ? `${dim(" · ")}${muted(route.provider)}` : "";
  return [
    `${autoStep}${tierName}${drop}${arrow}${answering}${effort}${account}`,
    `${autoStep}${tierName}${drop}${arrow}${answering}${effort}`,
    `${tierName}${drop}${arrow}${answering}${effort}`,
    `${answering}${effort}`,
    answering,
  ];
}

function buildModelHeadVariants(
  ctx: ExtensionContext,
  theme: Theme,
  thinkingLevel: string,
  fastModeRaw: string,
  tierRoute: TierRoute | null,
): { readonly name: string; readonly variants: readonly string[] } {
  const model = ctx.model;
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);
  const id = model?.id ?? "no model";
  const name = theme.bold(theme.fg("accent", id));

  if (model?.provider === TIERS_PROVIDER) {
    return { name, variants: buildTierHeadVariants(theme, model.id, tierRoute) };
  }

  const provider = model === undefined ? "" : muted(model.provider);
  const thinking =
    model?.reasoning === false
      ? dim(`${ICON_DIAMOND} no thinking`)
      : `${dim(ICON_DIAMOND)} ${theme.fg(thinkingTokenForLevel(thinkingLevel), thinkingLevel)}`;
  const fast =
    fastModeRaw === "on"
      ? theme.fg("warning", "⚡fast")
      : fastModeRaw === "ultrafast"
        ? theme.fg("warning", "⚡ultrafast")
        : "";

  return {
    name,
    variants: [
      [name, provider, thinking, fast].filter((part) => part.length > 0).join(" "),
      [name, thinking, fast].filter((part) => part.length > 0).join(" "),
      `${name} ${thinking}`,
      name,
    ],
  };
}

function checkOAuthModel(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): boolean {
  const fn: unknown = Reflect.get(ctx.modelRegistry, "isUsingOAuth");
  if (typeof fn !== "function") return false;
  return Reflect.apply(fn, ctx.modelRegistry, [model]) === true;
}

function buildContextStat(
  theme: Theme,
  usage: NonNullable<ReturnType<ExtensionContext["getContextUsage"]>>,
): StatItem {
  const win = formatTokens(usage.contextWindow);
  const pct = usage.percent;
  const used = usage.tokens === null ? "?" : formatTokens(usage.tokens);
  const ratioText = `${used}/${win}`;
  const pctText = pct === null ? "" : ` ${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  const color: ForegroundToken =
    pct !== null && pct > 90 ? "error" : pct !== null && pct > 70 ? "warning" : "accent";
  const bar = contextBar(theme, pct, color);
  const labelColor: ForegroundToken = color === "accent" ? "muted" : color;
  return {
    text: `${bar} ${theme.fg(labelColor, `${ratioText}${pctText}`)}`,
    short: theme.fg(labelColor, `ctx ${ratioText}`),
    priority: 0,
  };
}

function buildTelemetryStats(
  ctx: ExtensionContext,
  theme: Theme,
  totals: Totals,
  usage: ReturnType<ExtensionContext["getContextUsage"]>,
  lastRate: number | undefined,
  streaming: boolean,
): readonly StatItem[] {
  const dim = (text: string) => theme.fg("dim", text);
  const muted = (text: string) => theme.fg("muted", text);
  const stats: StatItem[] = [];

  if (usage !== undefined) {
    stats.push(buildContextStat(theme, usage));
  }

  if (totals.input > 0 || totals.output > 0) {
    stats.push({
      text: dim(`↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`),
      priority: 3,
    });
  }

  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  if (totals.cacheRead > 0 && promptTokens > 0) {
    stats.push({
      text: dim(`cache ${Math.round((totals.cacheRead / promptTokens) * 100)}%`),
      priority: 4,
    });
  }

  const model = ctx.model;
  const isSubscription = model !== undefined && checkOAuthModel(ctx, model);
  if (totals.cost > 0 || isSubscription) {
    stats.push({
      text: muted(`$${totals.cost.toFixed(2)}${isSubscription ? " sub" : ""}`),
      priority: 1,
    });
  }

  if (lastRate !== undefined) {
    const rate = lastRate >= 100 ? lastRate.toFixed(0) : lastRate.toFixed(1);
    stats.push({
      text: (streaming ? theme.fg("accent", rate) : muted(rate)) + dim(" tok/s"),
      priority: 2,
    });
  }

  return stats;
}

function fitTelemetryStats(
  stats: readonly StatItem[],
  room: number,
): { readonly text: string; readonly count: number } {
  const shown: StatItem[] = [...stats];
  const joinText = () => shown.map((item) => item.text).join(GAP);
  while (shown.length > 0 && visibleWidth(joinText()) > room) {
    let worst = 0;
    for (let i = 1; i < shown.length; i += 1) {
      const cur = shown[i];
      const top = shown[worst];
      if (cur !== undefined && top !== undefined && cur.priority > top.priority) {
        worst = i;
      }
    }
    const target = shown[worst];
    if (target?.short !== undefined) {
      shown[worst] = { text: target.short, priority: target.priority };
    } else {
      shown.splice(worst, 1);
    }
  }
  return { text: joinText(), count: shown.length };
}

class YpiEditor extends CustomEditor {
  private readonly callbacks: YpiEditorCallbacks;
  private readonly kb: KeybindingsManager;

  public constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    callbacks: YpiEditorCallbacks,
  ) {
    super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
    this.callbacks = callbacks;
    this.kb = keybindings;
  }

  public override handleInput(data: string): void {
    if (this.kb.matches(data, "tui.input.submit") && !this.disableSubmit) {
      const trimmed = this.getText().trim();
      if (trimmed === "" && this.callbacks.canInterruptAndSend()) {
        const handled = this.callbacks.onInterruptAndSend(
          () => this.getText(),
          () => {
            this.setText("");
          },
        );
        if (handled) return;
      }
      if (trimmed === ".") {
        this.setText("");
        this.callbacks.onContinueShortcut();
        return;
      }
      if (trimmed === "/share" || trimmed === "/export" || trimmed.startsWith("/export ")) {
        this.callbacks.onExportCommand();
      }
      if (
        (trimmed === "/compact" || trimmed.startsWith("/compact ")) &&
        this.callbacks.onCompactCommand()
      ) {
        this.addToHistory(trimmed);
        this.setText("");
        return;
      }
    }
    super.handleInput(data);
  }

  private static gutterForWidth(width: number): number {
    return width >= 24 ? 3 : width >= 6 ? 2 : 0;
  }

  private static findBottomBorderIndex(lines: readonly string[]): number {
    for (let i = lines.length - 1; i >= 1; i -= 1) {
      const plain = stripTerminalSequences(lines[i] ?? "");
      if (plain.startsWith("─") || plain.includes("↓ ")) return i;
    }
    return lines.length - 1;
  }

  private isBashDraft(): boolean {
    return this.getText().trimStart().startsWith("!");
  }

  private railToken(): ForegroundToken {
    if (this.isBashDraft()) return "bashMode";
    const calm = this.callbacks.isCalmActive();
    const activeToken = phaseRailToken(this.callbacks.getActivitySnapshot().phase, calm);
    if (activeToken !== undefined) return activeToken;
    if (calm) return "mdLink";
    return thinkingTokenForLevel(this.callbacks.getThinkingLevel());
  }

  public override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    const base = super.renderTopBorder(width, hiddenLineCount);
    const stripped = stripTerminalSequences(base);
    const hasPiOverlay = stripped.replaceAll("─", "").trim().length > 0;
    if (hasPiOverlay) return truncateToWidth(base, width, "");

    return renderActivityBorder({
      width,
      theme: this.callbacks.getTheme(),
      snapshot: this.callbacks.getActivitySnapshot(),
      tick: this.callbacks.getAnimationTick(),
      calm: this.callbacks.isCalmActive(),
      hiddenLineCount,
    });
  }

  public override renderBottomBorder(width: number, hiddenLineCount: number): string {
    if (width <= 0) return "";
    const theme = this.callbacks.getTheme();
    const borderFn = (text: string) => theme.fg("borderMuted", text);

    let rightTag = "";
    if (hiddenLineCount > 0) {
      rightTag = ` ${theme.fg("muted", `↓ ${hiddenLineCount} more`)} `;
    } else if (this.isBashDraft()) {
      rightTag = ` ${theme.fg("bashMode", "! bash")} `;
    } else if (this.getText().length === 0 && this.callbacks.canInterruptAndSend() && width >= 44) {
      rightTag = ` ${theme.fg("accent", "enter interrupt & send")} `;
    } else if (this.getText().length === 0 && width >= 52) {
      rightTag = ` ${theme.fg("dim", "enter send · shift+enter newline")} `;
    }

    const tagWidth = visibleWidth(rightTag);
    const leadFill = Math.max(0, width - tagWidth - (tagWidth > 0 ? 1 : 0));
    const tail = tagWidth > 0 ? borderFn("─") : "";
    const line = borderFn("─".repeat(leadFill)) + rightTag + tail;
    return truncateToWidth(line, width, "");
  }

  public override render(width: number): string[] {
    const gutter = YpiEditor.gutterForWidth(width);
    if (gutter === 0) return super.render(width);

    const rightMargin = gutter === 3 ? 1 : 0;
    const innerWidth = Math.max(1, width - gutter - rightMargin);
    const rawLines = super.render(innerWidth);
    if (rawLines.length < 3) return rawLines;

    const theme = this.callbacks.getTheme();
    const lead = gutter === 3 ? " " : "";
    const trail = rightMargin === 1 ? " " : "";
    const token = this.railToken();
    const topPrefix = `${lead}${theme.fg(token, "╭")}${theme.fg("borderMuted", "─")}`;
    const bodyPrefix = `${lead}${theme.fg(token, "│")} `;
    const bottomPrefix = `${lead}${theme.fg(token, "╰")}${theme.fg("borderMuted", "─")}`;
    const acPrefix = " ".repeat(gutter);
    const bodyEnd = YpiEditor.findBottomBorderIndex(rawLines);

    return rawLines.map((line, idx) => {
      if (idx === 0) return truncateToWidth(topPrefix + line + trail, width, "");
      if (idx === bodyEnd) return truncateToWidth(bottomPrefix + line + trail, width, "");
      if (idx > bodyEnd) return truncateToWidth(acPrefix + line + trail, width, "");
      return truncateToWidth(bodyPrefix + line + trail, width, "");
    });
  }

  public override handleMouse(
    event: Parameters<CustomEditor["handleMouse"]>[0],
  ): ReturnType<CustomEditor["handleMouse"]> {
    const gutter = YpiEditor.gutterForWidth(event.width);
    if (gutter === 0) return super.handleMouse(event);
    const rightMargin = gutter === 3 ? 1 : 0;
    return super.handleMouse({
      ...event,
      x: Math.max(0, event.x - gutter),
      width: Math.max(1, event.width - gutter - rightMargin),
    });
  }
}

export default function ypiTui(pi: ExtensionAPI): void {
  let speed: { start: number; chars: number; lastRender: number } | undefined;
  let lastRate: number | undefined;
  let tierRoute: TierRoute | null = null;
  let requestFooterRender: (() => void) | undefined;
  let requestEditorRender: (() => void) | undefined;
  let invalidateStats: (() => void) | undefined;
  let calmActive = false;
  let stockExportRendering = false;
  let exportWindow = false;
  let optchatActive = false;
  let animationTick = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let tickerIntervalMs = 0;
  const queuedPrompts: string[] = [];
  let pendingInterruptAction: PendingInterruptAction | undefined;
  const toolRows = new Map<object, () => void>();

  const flushPendingInterruptAction = (): void => {
    const action = pendingInterruptAction;
    if (action === undefined) return;
    pendingInterruptAction = undefined;
    if (action.kind === "continue") {
      pi.sendMessage(
        {
          customType: CONTINUE_MESSAGE_TYPE,
          content: MANUAL_CONTINUE_PROMPT,
          display: false,
        },
        { triggerTurn: true },
      );
      return;
    }
    pi.sendUserMessage(action.text);
  };

  const requestAllRender = (): void => {
    requestEditorRender?.();
    requestFooterRender?.();
  };

  const repaintToolRows = (): void => {
    for (const invalidate of toolRows.values()) {
      invalidate();
    }
    requestAllRender();
  };

  const isHidingTools = (): boolean => calmActive && !stockExportRendering && !exportWindow;

  const stopTicker = (): void => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
      tickerIntervalMs = 0;
    }
  };

  const tickerSync: { run?: () => void } = {};

  const activity = createActivityTracker(() => {
    tickerSync.run?.();
  });

  const syncTicker = (): void => {
    const active = activity.snapshot().phase !== "idle";
    if (!active) {
      stopTicker();
      animationTick = 0;
      requestEditorRender?.();
      return;
    }
    const desiredMs = calmActive ? CALM_ACTIVITY_TICK_MS : ACTIVITY_TICK_MS;
    if (ticker !== undefined && tickerIntervalMs === desiredMs) {
      requestEditorRender?.();
      return;
    }
    stopTicker();
    tickerIntervalMs = desiredMs;
    ticker = setInterval(() => {
      animationTick += 1;
      requestEditorRender?.();
    }, desiredMs);
    ticker.unref();
    requestEditorRender?.();
  };

  tickerSync.run = syncTicker;

  const applyCalmEvent = (data: unknown): void => {
    const parsed = parseCalmEvent(data);
    if (parsed === undefined) return;
    if (parsed.active === calmActive && parsed.stockExportRendering === stockExportRendering) {
      return;
    }
    calmActive = parsed.active;
    stockExportRendering = parsed.stockExportRendering;
    syncTicker();
    repaintToolRows();
  };

  pi.events.on("ypi:optchat-active", (data: unknown) => {
    if (isRecord(data) && typeof data["active"] === "boolean") {
      optchatActive = data["active"];
    }
  });

  pi.events.on(OPTCHAT_COMPACTING_EVENT, (data: unknown) => {
    const parsed = parseCompactingEvent(data);
    if (parsed === undefined) return;
    if (parsed.active) {
      activity.startCompacting("optchat", parsed.detail);
    } else {
      activity.stopCompacting("optchat");
    }
  });

  pi.events.on("pi-tiers:route", (data: unknown) => {
    tierRoute = parseTierRoute(data);
    requestFooterRender?.();
  });

  pi.events.on(CALM_EVENT, applyCalmEvent);
  pi.events.on(LEGACY_CALM_EVENT, applyCalmEvent);

  const rememberToolRow = (context: { state: unknown; invalidate?: () => void }): void => {
    if (isRecord(context.state) && typeof context.invalidate === "function") {
      toolRows.set(context.state, context.invalidate);
    }
  };

  pi.registerToolRenderer((toolName, resolveNext): ToolRenderers => {
    const base = resolveNext();
    const emptyComponent: Component = {
      render: () => [],
      invalidate: () => undefined,
    };

    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        rememberToolRow(context);
        const state: ToolLineState = isRecord(context.state) ? context.state : {};
        state.args = args;
        state.isPartial = context.isPartial;
        state.isError = context.isError;
        state.durationMs = context.durationMs;

        if (isHidingTools()) {
          return emptyComponent;
        }

        if (context.expanded && base?.renderCall !== undefined) {
          const inner = base.renderCall(args, theme, context);
          if (base.renderShell === "self") return inner;
          const bgToken = context.isPartial
            ? "toolPendingBg"
            : context.isError
              ? "toolErrorBg"
              : "toolSuccessBg";
          const box = new Box(1, 0, (text) => theme.bg(bgToken, text));
          box.addChild(inner);
          return box;
        }

        return {
          render(width: number): string[] {
            if (isHidingTools()) return [];
            if (width <= 0) return [];
            const margin = width >= 24 ? " " : "";
            const rail = theme.fg("borderMuted", "│");
            const glyph =
              state.isPartial === true
                ? theme.fg("warning", "◐")
                : state.isError === true
                  ? theme.fg("error", "✗")
                  : theme.fg("success", "✓");
            const label = theme.bold(theme.fg("toolTitle", toolName));
            const subject = extractToolSubject(toolName, state.args, context.cwd);
            const meta = summarizeToolMeta(state);
            const parts = [
              `${margin}${rail} ${glyph} ${label}`,
              ...(subject.length > 0 ? [theme.fg("muted", subject)] : []),
              ...(meta !== undefined ? [theme.fg("dim", `· ${meta}`)] : []),
            ];
            return [truncateToWidth(parts.join(" "), width, theme.fg("dim", "…"))];
          },
          invalidate: () => undefined,
        };
      },
      renderResult(result, options, theme, context) {
        rememberToolRow(context);
        const state: ToolLineState = isRecord(context.state) ? context.state : {};
        state.isPartial = options.isPartial;
        state.isError = context.isError;
        state.durationMs = context.durationMs;
        state.resultText = extractResultText(result.content);

        if (isHidingTools()) {
          return emptyComponent;
        }

        if (options.expanded) {
          if (base?.renderResult !== undefined) {
            const inner = base.renderResult(result, options, theme, context);
            if (base.renderShell === "self") return inner;
            const bgToken = options.isPartial
              ? "toolPendingBg"
              : context.isError
                ? "toolErrorBg"
                : "toolSuccessBg";
            const box = new Box(1, 0, (text) => theme.bg(bgToken, text));
            box.addChild(inner);
            return box;
          }
          if (state.resultText.length > 0) {
            const box = new Box(1, 0, (text) =>
              theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
            );
            box.addChild(new Text(theme.fg("toolOutput", state.resultText), 0, 0));
            return box;
          }
        }
        return emptyComponent;
      },
    };
  });

  function installEditor(ctx: ExtensionContext): void {
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      requestEditorRender = () => {
        tui.requestRender();
      };
      return new YpiEditor(tui, editorTheme, keybindings, {
        getTheme: () => ctx.ui.theme,
        getThinkingLevel: () => pi.getThinkingLevel(),
        isCalmActive: () => calmActive,
        getActivitySnapshot: () => activity.snapshot(),
        getAnimationTick: () => animationTick,
        canInterruptAndSend: () => !ctx.isIdle() && ctx.hasPendingMessages(),
        onInterruptAndSend: (readEditorText, clearEditor) => {
          if (ctx.isIdle() || !ctx.hasPendingMessages()) return false;
          ctx.abort();
          const restored = readEditorText().trim();
          if (restored.length > 0) clearEditor();
          const promptText = restored.length > 0 ? restored : queuedPrompts.join("\n\n").trim();
          queuedPrompts.length = 0;
          if (promptText.length === 0) return false;
          pendingInterruptAction = { kind: "user", text: promptText };
          if (ctx.isIdle()) {
            queueMicrotask(flushPendingInterruptAction);
          }
          requestEditorRender?.();
          return true;
        },
        onContinueShortcut: () => {
          if (ctx.isIdle()) {
            pi.sendMessage(
              {
                customType: CONTINUE_MESSAGE_TYPE,
                content: MANUAL_CONTINUE_PROMPT,
                display: false,
              },
              { triggerTurn: true },
            );
            return;
          }
          pendingInterruptAction = { kind: "continue" };
          ctx.abort();
          if (ctx.isIdle()) {
            queueMicrotask(flushPendingInterruptAction);
          }
        },
        onCompactCommand: () => {
          if (!optchatActive) return false;
          pi.events.emit("ypi:optchat-fold", { ctx });
          return true;
        },
        onExportCommand: () => {
          exportWindow = true;
          repaintToolRows();
          setTimeout(() => {
            exportWindow = false;
            repaintToolRows();
          }, 0);
        },
      });
    });
  }

  function installFooter(ctx: ExtensionContext): void {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => {
        tui.requestRender();
      };
      const unsubscribeBranch = footerData.onBranchChange(() => {
        tui.requestRender();
      });
      let cache:
        | {
            readonly key: string;
            readonly totals: Totals;
            readonly usage: ReturnType<ExtensionContext["getContextUsage"]>;
            readonly name: string | undefined;
          }
        | undefined;
      invalidateStats = () => {
        cache = undefined;
      };

      const readStats = () => {
        const sm = ctx.sessionManager;
        const model = ctx.model;
        const key = JSON.stringify([
          sm.getSessionId(),
          sm.getLeafId(),
          model?.provider,
          model?.id,
          model?.contextWindow,
        ]);
        if (cache?.key === key) return cache;
        const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        for (const entry of sm.getEntries()) {
          if (entry.type === "message") {
            const msg: unknown = entry.message;
            if (isRecord(msg) && (msg["role"] === "assistant" || msg["role"] === "toolResult")) {
              addUsage(totals, parseUsage(msg["usage"]));
            }
          } else if (entry.type === "branch_summary" || entry.type === "compaction") {
            addUsage(totals, parseUsage(Reflect.get(entry, "usage")));
          } else if (isRecord(entry) && entry["type"] === "usage") {
            addUsage(totals, parseUsage(entry["usage"]));
          }
        }
        cache = { key, totals, usage: ctx.getContextUsage(), name: sm.getSessionName() };
        return cache;
      };

      const dim = (text: string) => theme.fg("dim", text);
      const muted = (text: string) => theme.fg("muted", text);

      const locationRows = (width: number): string[] => {
        const cwd = formatCwd(ctx.sessionManager.getCwd());
        const branch = footerData.getGitBranch();
        const sessionName = readStats().name;
        const calmPill = calmActive ? `${GAP}${theme.fg("mdLink", `${ICON_CALM} calm`)}` : "";
        const build = (pathText: string): string => {
          let row = `${theme.fg("accent", ICON_DIR)} ${theme.fg("text", pathText)}`;
          if (branch !== null && branch.length > 0) {
            row += `${GAP}${theme.fg("success", `${ICON_BRANCH} ${branch}`)}`;
          }
          if (sessionName !== undefined && sessionName.length > 0) {
            row += `${GAP}${muted(`• ${sanitize(sessionName)}`)}`;
          }
          return row + calmPill;
        };

        const segments = cwd.split("/");
        const fish = segments
          .map((part, i) =>
            i === segments.length - 1
              ? part
              : part.startsWith(".")
                ? part.slice(0, 2)
                : part.slice(0, 1),
          )
          .join("/");
        const candidates = [cwd, fish, segments.at(-1) ?? cwd];
        const fitLeft = (room: number): string => {
          const match = candidates
            .map((candidate) => build(candidate))
            .find((rendered) => visibleWidth(rendered) <= room);
          return match ?? truncateToWidth(build(candidates.at(-1) ?? cwd), room, dim("…"));
        };

        const statuses = [...footerData.getExtensionStatuses().entries()]
          .filter(([key]) => !HIDDEN_STATUS_KEYS.has(key))
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitize(text))
          .filter((text) => text.length > 0)
          .join(dim(" · "));
        if (statuses.length === 0) return [fitLeft(width)];
        const full = build(cwd);
        if (visibleWidth(full) + GAP.length + visibleWidth(statuses) <= width) {
          return [spread(full, statuses, width)];
        }
        return [fitLeft(width), truncateToWidth(statuses, width, dim("…"))];
      };

      const telemetryRows = (width: number): string[] => {
        const fastRaw = sanitize(footerData.getExtensionStatuses().get(FAST_MODE_KEY) ?? "");
        const { name, variants } = buildModelHeadVariants(
          ctx,
          theme,
          pi.getThinkingLevel(),
          fastRaw,
          tierRoute,
        );
        const head =
          variants.find((variant) => visibleWidth(variant) <= width) ??
          truncateToWidth(name, width, "…");

        const { totals, usage } = readStats();
        const stats = buildTelemetryStats(ctx, theme, totals, usage, lastRate, speed !== undefined);
        const beside = fitTelemetryStats(stats, width - visibleWidth(head) - GAP.length);
        const essential = stats.filter((item) => item.priority <= 1).length;
        if (beside.count >= essential) return [spread(head, beside.text, width)];
        const wrapped = fitTelemetryStats(stats, width).text;
        return wrapped.length > 0 ? [head, wrapped] : [head];
      };

      return {
        dispose() {
          unsubscribeBranch();
          requestFooterRender = undefined;
          invalidateStats = undefined;
        },
        invalidate() {
          cache = undefined;
        },
        render(width: number): string[] {
          if (width <= 0) return [];
          const margin = width >= 24 ? 1 : 0;
          const inner = Math.max(1, width - margin * 2);
          const pad = " ".repeat(margin);
          return [...locationRows(inner), ...telemetryRows(inner)].map((row) =>
            truncateToWidth(pad + row, width, ""),
          );
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    toolRows.clear();
    queuedPrompts.length = 0;
    pendingInterruptAction = undefined;
    exportWindow = false;
    calmActive = loadCalmPreference();
    activity.reset();
    stopTicker();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWorkingVisible(false);
    installHeader(ctx);
    installEditor(ctx);
    installFooter(ctx);
  });

  pi.on("input", (event) => {
    if (event.streamingBehavior !== undefined && event.text.trim().length > 0) {
      queuedPrompts.push(event.text);
      requestEditorRender?.();
    }
    return undefined;
  });

  pi.on("agent_start", () => {
    activity.startAgent();
  });

  pi.on("turn_start", () => {
    speed = { start: Date.now(), chars: 0, lastRender: 0 };
    activity.startTurn();
  });

  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    activity.onAssistantEvent(update.type);
    if (speed === undefined) return;
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
    speed.chars += update.delta.length;
    const now = Date.now();
    if (now - speed.lastRender < SPEED_RENDER_INTERVAL_MS) return;
    speed.lastRender = now;
    lastRate = speed.chars / 4 / Math.max(0.001, (now - speed.start) / 1000);
    requestFooterRender?.();
  });

  pi.on("message_end", (event) => {
    if (speed === undefined || event.message.role !== "assistant") return;
    const seconds = Math.max(0.001, (Date.now() - speed.start) / 1000);
    const usage = parseUsage(Reflect.get(event.message, "usage"));
    const tokens = usage?.output !== undefined && usage.output > 0 ? usage.output : speed.chars / 4;
    if (tokens > 0) lastRate = tokens / seconds;
    requestFooterRender?.();
  });

  pi.on("tool_execution_start", (event) => {
    activity.startTool(event.toolCallId, event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    activity.endTool(event.toolCallId);
  });

  pi.on("agent_settled", () => {
    speed = undefined;
    queuedPrompts.length = 0;
    activity.settleAgent();
    requestFooterRender?.();
    flushPendingInterruptAction();
  });

  pi.on("session_before_compact", () => {
    if (!optchatActive) {
      activity.startCompacting("pi");
    }
  });

  pi.on("session_compact", () => {
    activity.stopCompacting("pi");
    invalidateStats?.();
    requestAllRender();
  });

  pi.on("session_compact_failed", () => {
    activity.stopCompacting("pi");
    requestAllRender();
  });

  pi.on("session_tree", () => {
    invalidateStats?.();
    requestFooterRender?.();
  });

  pi.on("model_select", () => {
    requestFooterRender?.();
  });

  pi.on("thinking_level_select", () => {
    requestAllRender();
  });

  pi.on("session_shutdown", () => {
    activity.reset();
    stopTicker();
    toolRows.clear();
    queuedPrompts.length = 0;
    pendingInterruptAction = undefined;
  });
}
