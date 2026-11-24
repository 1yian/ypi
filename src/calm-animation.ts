import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  mixColors,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];

const WAVE_BARS = ["▁", "▂", "▃", "▄"] as const;
const WAKE_GLYPHS = ["≈", "≈", "~", "~", "·", "·"] as const;
const STAR_GLYPHS = ["·", "✧", "✦", "✧"] as const;

const HULL_RIGHT = "╲▁▁▁╱";
const HULL_LEFT = "╲▁▁▁╱";
const SAIL_RIGHT = "◿│◣";
const SAIL_LEFT = "◢│◺";
const HULL_WIDTH = 5;
const SAIL_WIDTH = 3;
const TICKS_PER_STEP = 3;

export const CALM_WIDGET_KEY = "ypi-calm-harbor";
export const CALM_TICK_MS = 140;

export interface CalmHarborAnimation {
  tick: () => void;
  reset: () => void;
  setPhase: (phase: string) => void;
  render: (width: number, theme: Theme) => string[];
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function starHash(index: number): number {
  return ((index + 17) * 2_654_435_761) % 997;
}

function swellHeight(column: number, ticks: number, hullCenter: number): number {
  const dist = Math.abs(column - hullCenter);
  const calmTrough = dist <= 3 ? 0 : Math.min(1, (dist - 3) / 4);
  const t = ticks * 0.22;
  const primary = Math.sin(column * 0.28 - t);
  const harmonic = Math.sin(column * 0.13 + t * 0.65);
  const combined = (primary * 0.62 + harmonic * 0.38 + 1) * 0.5;
  const level = Math.round(combined * calmTrough * (WAVE_BARS.length - 1));
  return Math.max(0, Math.min(WAVE_BARS.length - 1, level));
}

export function createCalmHarborAnimation(): CalmHarborAnimation {
  let ticks = 0;
  let lastSteppedTick = -1;
  let position = 0;
  let direction: 1 | -1 = 1;
  let startedAt = Date.now();
  let phase = "sailing";

  const reset = (): void => {
    ticks = 0;
    lastSteppedTick = -1;
    position = 0;
    direction = 1;
    startedAt = Date.now();
    phase = "sailing";
  };

  const setPhase = (nextPhase: string): void => {
    phase = nextPhase.trim() || "sailing";
  };

  const stepMotion = (span: number): void => {
    if (span <= 0) {
      position = 0;
      return;
    }
    if (position > span) position = span;
    if (ticks > 0 && ticks !== lastSteppedTick && ticks % TICKS_PER_STEP === 0) {
      lastSteppedTick = ticks;
      position += direction;
      if (position >= span) {
        position = span;
        direction = -1;
      } else if (position <= 0) {
        position = 0;
        direction = 1;
      }
    }
  };

  const tick = (): void => {
    ticks += 1;
  };

  const render = (width: number, theme: Theme): string[] => {
    if (width <= 0) return [];
    const margin = width >= 24 ? 1 : 0;
    const inner = Math.max(1, width - margin * 2);
    const pad = " ".repeat(margin);

    const deepWater = mixColors(theme.colors.dim, theme.colors.mdLink, 0.45);
    const brightWater = mixColors(theme.colors.mdLink, theme.colors.accent, 0.35);
    const bioGlow = theme.colors.accent;
    const sailMain = theme.colors.text;
    const hullTone = theme.colors.warning;
    const lanternGlow = mixColors(theme.colors.warning, theme.colors.accent, 0.35);
    const moonTone = mixColors(theme.colors.warning, theme.colors.text, 0.45);
    const starDim = theme.colors.dim;
    const starBright = mixColors(theme.colors.muted, theme.colors.text, 0.55);

    const elapsed = formatElapsed(Date.now() - startedAt);
    const whisperPlain =
      inner >= 44 ? `calm · ${phase} · ${elapsed}` : inner >= 28 ? `calm · ${elapsed}` : "";
    const whisperReserve = whisperPlain.length > 0 ? whisperPlain.length + 3 : 0;
    const seaWidth = Math.max(HULL_WIDTH, inner - whisperReserve);
    const span = Math.max(0, seaWidth - HULL_WIDTH);
    stepMotion(span);

    const hullLeft = Math.min(position, Math.max(0, seaWidth - HULL_WIDTH));
    const hullCenter = hullLeft + 2;
    const wakeLength = Math.min(WAKE_GLYPHS.length, Math.max(2, Math.floor(seaWidth / 7)));

    const renderWaterRow = (): string => {
      let row = "";
      for (let col = 0; col < seaWidth; col += 1) {
        if (col >= hullLeft && col < hullLeft + HULL_WIDTH) {
          const hullGlyph = (direction === 1 ? HULL_RIGHT : HULL_LEFT)[col - hullLeft] ?? "▁";
          row += theme.style(hullGlyph, { fg: hullTone });
          continue;
        }
        const wakeDist = direction === 1 ? hullLeft - col : col - (hullLeft + HULL_WIDTH - 1);
        if (wakeDist >= 1 && wakeDist <= wakeLength) {
          const decay = (wakeDist - 1) / Math.max(1, wakeLength - 1);
          const shimmer = (Math.sin(ticks * 0.55 - wakeDist * 0.9) + 1) * 0.5;
          const wakeGlyph = WAKE_GLYPHS[Math.min(WAKE_GLYPHS.length - 1, wakeDist - 1)] ?? "·";
          const wakeColor = mixColors(
            bioGlow,
            brightWater,
            Math.min(1, decay * 0.8 + (1 - shimmer) * 0.2),
          );
          row += theme.style(wakeGlyph, { fg: wakeColor });
          continue;
        }
        const level = swellHeight(col, ticks, hullCenter);
        const crestRatio = level / (WAVE_BARS.length - 1);
        const waveColor = mixColors(deepWater, brightWater, crestRatio);
        row += theme.style(WAVE_BARS[level] ?? WAVE_BARS[0], { fg: waveColor });
      }
      if (whisperPlain.length > 0) {
        const gap = Math.max(1, inner - seaWidth - whisperPlain.length);
        row += " ".repeat(gap) + theme.fg("dim", whisperPlain);
      }
      return truncateToWidth(pad + row, width, "");
    };

    if (inner < 12) {
      return [renderWaterRow()];
    }

    const sailLeft = hullLeft + 1;
    const renderSailRow = (): string => {
      const sailText = direction === 1 ? SAIL_RIGHT : SAIL_LEFT;
      const bowCol = direction === 1 ? sailLeft + SAIL_WIDTH : sailLeft - 1;
      let row = "";
      for (let col = 0; col < seaWidth; col += 1) {
        if (col >= sailLeft && col < sailLeft + SAIL_WIDTH) {
          const ch = sailText[col - sailLeft] ?? " ";
          const isMast = ch === "│";
          row += theme.style(ch, { fg: isMast ? hullTone : sailMain });
        } else if (col === bowCol && bowCol >= 0 && bowCol < seaWidth) {
          const pulse = Math.floor(ticks / 3) % 2 === 0 ? "•" : "·";
          row += theme.style(pulse, { fg: lanternGlow });
        } else {
          row += " ";
        }
      }
      return truncateToWidth(pad + row, width, "");
    };

    if (inner < 24) {
      return [renderSailRow(), renderWaterRow()];
    }

    const moonCol = Math.max(2, Math.min(seaWidth - 3, Math.floor(seaWidth * 0.78)));
    const pennantCol = sailLeft + 1;
    const renderSkyRow = (): string => {
      let row = "";
      for (let col = 0; col < seaWidth; col += 1) {
        if (col === pennantCol) {
          const flag = direction === 1 ? (ticks % 4 < 2 ? "›" : "»") : ticks % 4 < 2 ? "‹" : "«";
          row += theme.style(flag, { fg: bioGlow });
          continue;
        }
        if (col === moonCol) {
          row += theme.style("☾", { fg: moonTone });
          continue;
        }
        const hash = starHash(col);
        if (hash % 11 === 0 && Math.abs(col - moonCol) > 2 && Math.abs(col - pennantCol) > 2) {
          const twinklePhase = Math.floor((ticks + (hash % 17)) / 5) % STAR_GLYPHS.length;
          const glyph = STAR_GLYPHS[twinklePhase] ?? "·";
          const bright = twinklePhase === 2;
          row += theme.style(glyph, { fg: bright ? starBright : starDim });
          continue;
        }
        row += " ";
      }
      return truncateToWidth(pad + row, width, "");
    };

    const lines = [renderSkyRow(), renderSailRow(), renderWaterRow()];
    return lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
    );
  };

  return { tick, reset, setPhase, render };
}

export function createCalmHarborWidget(
  tui: TUI,
  theme: Theme,
  animation: CalmHarborAnimation,
): Component & { dispose: () => void } {
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed) return;
    animation.tick();
    tui.requestRender();
  }, CALM_TICK_MS);
  timer.unref();

  return {
    render: (width: number) => (disposed ? [] : animation.render(width, theme)),
    invalidate: () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}
