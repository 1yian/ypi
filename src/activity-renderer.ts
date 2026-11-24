import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityPhase, ActivitySnapshot } from "./activity.ts";

type Theme = ExtensionContext["ui"]["theme"];
type ForegroundToken = Parameters<Theme["fg"]>[0];

export const ACTIVITY_TICK_MS = 65;
export const CALM_ACTIVITY_TICK_MS = 90;

const ICON_CALM = "☾";
const DWELL_STEPS = 3;

export interface ActivityBorderOptions {
  readonly width: number;
  readonly theme: Theme;
  readonly snapshot: ActivitySnapshot;
  readonly tick: number;
  readonly calm: boolean;
  readonly hiddenLineCount: number;
  readonly now?: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

export function phaseRailToken(phase: ActivityPhase, calm: boolean): ForegroundToken | undefined {
  if (phase === "idle") return undefined;
  if (phase === "thinking") return calm ? "mdLink" : "accent";
  if (phase === "working") return "mdLink";
  if (phase === "command") return "warning";
  return "thinkingMedium";
}

function phaseBaseColor(phase: Exclude<ActivityPhase, "idle">, theme: Theme, calm: boolean) {
  if (phase === "thinking") {
    return calm ? mixColors(theme.colors.accent, theme.colors.mdLink, 0.45) : theme.colors.accent;
  }
  if (phase === "working") return theme.colors.mdLink;
  if (phase === "command") return theme.colors.warning;
  return theme.colors.thinkingMedium;
}

function phaseLabelText(phase: Exclude<ActivityPhase, "idle">, compact: boolean): string {
  if (phase === "thinking") return "thinking";
  if (phase === "working") return "working";
  if (phase === "command") return compact ? "command" : "waiting for command";
  return "compacting";
}

function scannerCellIntensity(cell: number, cells: number, tick: number): number {
  const leg = cells + DWELL_STEPS;
  const cycle = leg * 2;
  const step = ((tick % cycle) + cycle) % cycle;
  const forward = step < leg;
  const offset = forward ? step : step - leg;
  const dir = forward ? 1 : -1;

  if (offset < cells) {
    const head = forward ? offset : cells - 1 - offset;
    const behind = (head - cell) * dir;
    if (behind === 0) return 1;
    if (behind > 0) return 0.56 ** behind;
    if (behind === -1) return 0.22;
    return 0;
  }

  const dwell = offset - cells + 1;
  const edge = forward ? cells - 1 : 0;
  const behind = (edge - cell) * dir + dwell * 0.85;
  if (behind <= 0) return 0;
  return Math.max(0, 0.9 * 0.56 ** behind);
}

function renderScanner(
  cells: number,
  tick: number,
  phase: Exclude<ActivityPhase, "idle">,
  theme: Theme,
  calm: boolean,
): string {
  const primary = phaseBaseColor(phase, theme, calm);
  const track = mixColors(theme.colors.borderMuted, theme.colors.dim, calm ? 0.22 : 0.34);
  const peak = mixColors(primary, theme.colors.text, calm ? 0.28 : 0.44);
  const idleGlyph = calm ? "·" : "▪";
  let output = "";

  for (let i = 0; i < cells; i += 1) {
    const intensity = scannerCellIntensity(i, cells, tick);
    if (intensity >= 0.72) {
      const ratio = (intensity - 0.72) / 0.28;
      output += theme.style("■", { fg: mixColors(primary, peak, ratio) });
    } else if (intensity >= 0.34) {
      output += theme.style("■", { fg: mixColors(track, primary, intensity) });
    } else if (intensity >= 0.12) {
      output += theme.style("▪", {
        fg: mixColors(track, primary, Math.min(1, intensity * 1.15)),
      });
    } else {
      output += theme.style(idleGlyph, { fg: track });
    }
  }

  return output;
}

function renderShimmerText(
  text: string,
  tick: number,
  phase: Exclude<ActivityPhase, "idle">,
  theme: Theme,
  calm: boolean,
): string {
  const primary = phaseBaseColor(phase, theme, calm);
  const base = mixColors(theme.colors.muted, primary, calm ? 0.28 : 0.38);
  const highlight = mixColors(primary, theme.colors.text, calm ? 0.42 : 0.58);
  const span = text.length + 14;
  const sweepPos = ((tick * (calm ? 0.34 : 0.44)) % span) - 4;
  let output = "";

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === " ") {
      output += " ";
      continue;
    }
    const dist = i - sweepPos;
    const glow = Math.exp(-(dist * dist) / 5.5);
    output += theme.style(ch, { fg: mixColors(base, highlight, glow) });
  }

  return output;
}

function buildRightVariants(theme: Theme, calm: boolean, elapsed: string): readonly string[] {
  if (calm) {
    return [
      ` ${theme.fg("mdLink", ICON_CALM)} ${theme.fg("dim", `calm · ${elapsed}`)} `,
      ` ${theme.fg("mdLink", ICON_CALM)} ${theme.fg("dim", elapsed)} `,
      ` ${theme.fg("dim", elapsed)} `,
      "",
    ];
  }
  return [` ${theme.fg("dim", `${elapsed} · esc`)} `, ` ${theme.fg("dim", elapsed)} `, ""];
}

export function renderActivityBorder(options: ActivityBorderOptions): string {
  const { width, theme, snapshot, tick, calm, hiddenLineCount } = options;
  if (width <= 0) return "";

  const border = (text: string) => theme.fg("borderMuted", text);

  if (snapshot.phase === "idle") {
    if (calm && width >= 18) {
      const badge = ` ${theme.fg("mdLink", ICON_CALM)} ${theme.fg("dim", "calm")} `;
      const fillCount = Math.max(0, width - 1 - visibleWidth(badge));
      return truncateToWidth(border("─") + badge + border("─".repeat(fillCount)), width, "");
    }
    return border("─".repeat(width));
  }

  const now = options.now ?? Date.now();
  const elapsed = formatElapsed(snapshot.startedAt > 0 ? now - snapshot.startedAt : 0);
  const cells = width >= 34 ? 8 : width >= 22 ? 6 : 4;
  const compact = width < 42;
  const scanner = renderScanner(cells, tick, snapshot.phase, theme, calm);
  const labelText = phaseLabelText(snapshot.phase, compact);
  const shimmer = renderShimmerText(labelText, tick, snapshot.phase, theme, calm);
  const detailText =
    snapshot.detail !== undefined && width >= 44 ? theme.fg("dim", ` · ${snapshot.detail}`) : "";

  const leftCandidates = [
    ` ${scanner}  ${shimmer}${detailText} `,
    ` ${scanner} ${shimmer} `,
    ` ${scanner} `,
  ];
  const left =
    leftCandidates.find((candidate) => visibleWidth(candidate) + 1 <= width) ??
    truncateToWidth(` ${scanner} `, width, "");

  const lead = width >= visibleWidth(left) + 2 ? border("─") : "";
  const leadWidth = visibleWidth(lead);
  const leftWidth = visibleWidth(left);
  const remaining = width - leadWidth - leftWidth;

  if (remaining <= 0) {
    return truncateToWidth(lead + left, width, "");
  }

  const rightVariants = buildRightVariants(theme, calm, elapsed);
  const right =
    rightVariants.find((variant) => {
      if (variant.length === 0) return true;
      return visibleWidth(variant) + 2 <= remaining;
    }) ?? "";

  const rightWidth = visibleWidth(right);
  const tail = rightWidth > 0 ? border("─") : "";
  const tailWidth = visibleWidth(tail);
  const midRoom = Math.max(0, remaining - rightWidth - tailWidth);

  if (hiddenLineCount > 0) {
    const overflow = ` ${theme.fg("muted", `↑ ${hiddenLineCount} more`)} `;
    const overflowWidth = visibleWidth(overflow);
    if (overflowWidth + 2 <= midRoom) {
      const leftFill = Math.floor((midRoom - overflowWidth) / 2);
      const rightFill = midRoom - overflowWidth - leftFill;
      const line =
        lead +
        left +
        border("─".repeat(leftFill)) +
        overflow +
        border("─".repeat(rightFill)) +
        right +
        tail;
      return truncateToWidth(line, width, "");
    }
  }

  const line = lead + left + border("─".repeat(midRoom)) + right + tail;
  return truncateToWidth(line, width, "");
}
