import type { AgentSettledEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_AUTO_EXIT_DELAY_MS = 2500;
const AUTO_EXIT_STATUS_KEY = "ypi-auto-exit";

function parseAutoExitDelayMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env["YPI_AUTO_EXIT"]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "0" || raw === "false" || raw === "off") {
    return undefined;
  }
  const msOverride = env["YPI_AUTO_EXIT_MS"]?.trim();
  if (msOverride !== undefined && msOverride.length > 0 && /^\d+$/u.test(msOverride)) {
    return Number(msOverride);
  }
  if (raw === "1" || raw === "true" || raw === "on") {
    return DEFAULT_AUTO_EXIT_DELAY_MS;
  }
  const msMatch = /^(\d+)(?:ms)?$/u.exec(raw);
  if (msMatch?.[1] !== undefined) {
    return Number(msMatch[1]);
  }
  return undefined;
}

function isUserKeyInput(data: string): boolean {
  if (data.length === 0) return false;
  if (data === "\u001B[I" || data === "\u001B[O") return false;
  if (data.startsWith("\u001B[<") || data.startsWith("\u001B[M")) return false;
  if (data.startsWith("\u001B[?") || data.startsWith("\u001B]") || data.startsWith("\u001BP")) {
    return false;
  }
  return true;
}

export interface AutoExitController {
  readonly onSessionStart: (ctx: ExtensionContext) => void;
  readonly onInput: () => void;
  readonly onAgentStart: () => void;
  readonly onAgentSettled: (
    event: AgentSettledEvent,
    ctx: ExtensionContext,
    dispatchedFollowUp: boolean,
  ) => void;
  readonly onSessionShutdown: () => void;
}

export function createAutoExitController(
  readDelayMs: () => number | undefined = () => parseAutoExitDelayMs(process.env),
): AutoExitController {
  let activeCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubTerminalInput: (() => void) | undefined;
  let hasRun = false;
  let pausedByUser = false;

  const clearCountdown = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (activeCtx?.hasUI === true) {
      activeCtx.ui.setStatus(AUTO_EXIT_STATUS_KEY, undefined);
    }
  };

  const cleanup = (): void => {
    clearCountdown();
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    activeCtx = undefined;
    hasRun = false;
    pausedByUser = false;
  };

  const tryShutdown = (ctx: ExtensionContext): void => {
    clearCountdown();
    if (pausedByUser) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (ctx.hasUI && ctx.ui.getEditorText().trim().length > 0) return;
    ctx.shutdown();
  };

  return {
    onSessionStart(ctx) {
      cleanup();
      activeCtx = ctx;
      if (!ctx.hasUI) return;
      unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
        if (timer === undefined || !isUserKeyInput(data)) return undefined;
        pausedByUser = true;
        clearCountdown();
        return undefined;
      });
    },
    onInput() {
      clearCountdown();
    },
    onAgentStart() {
      hasRun = true;
      pausedByUser = false;
      clearCountdown();
    },
    onAgentSettled(event, ctx, dispatchedFollowUp) {
      clearCountdown();
      const delayMs = readDelayMs();
      if (delayMs === undefined) return;
      if (!hasRun || event.aborted || dispatchedFollowUp || pausedByUser) return;
      if (ctx.hasPendingMessages()) return;
      if (ctx.hasUI && ctx.ui.getEditorText().trim().length > 0) return;

      if (delayMs === 0) {
        tryShutdown(ctx);
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.setStatus(AUTO_EXIT_STATUS_KEY, "exiting… (any key to stay)");
      }
      timer = setTimeout(() => {
        timer = undefined;
        tryShutdown(ctx);
      }, delayMs);
      timer.unref();
    },
    onSessionShutdown() {
      cleanup();
    },
  };
}
