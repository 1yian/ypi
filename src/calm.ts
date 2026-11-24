import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  CALM_WIDGET_KEY,
  createCalmHarborAnimation,
  createCalmHarborWidget,
} from "./calm-animation.ts";
import {
  isCalmActive,
  loadCalmPreference,
  saveCalmPreference,
  setCalmActive,
} from "./calm-state.ts";

const YPI_CALM_EVENT = "ypi:calm";
const LEGACY_CALM_EVENT = "firstmate:calm-presentation";

function phaseForTool(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes("read") || lower.includes("ls")) return "reading";
  if (lower.includes("edit") || lower.includes("write")) return "editing";
  if (
    lower.includes("grep") ||
    lower.includes("find") ||
    lower.includes("search") ||
    lower.includes("fetch")
  ) {
    return "searching";
  }
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) return "running";
  return "working";
}

export default function ypiCalm(pi: ExtensionAPI): void {
  let running = false;
  let widgetShown = false;
  const animation = createCalmHarborAnimation();

  const syncHarborWidget = (ui: ExtensionUIContext, force = false): void => {
    const show = running && isCalmActive();
    if (show === widgetShown && !(force && !show)) return;
    widgetShown = show;
    if (show) {
      ui.setWorkingVisible(false);
      ui.setWidget(CALM_WIDGET_KEY, (tui, theme) => createCalmHarborWidget(tui, theme, animation), {
        placement: "aboveEditor",
      });
    } else {
      ui.setWidget(CALM_WIDGET_KEY, undefined);
      ui.setWorkingVisible(true);
    }
  };

  const apply = (ui: ExtensionUIContext, next: boolean): void => {
    setCalmActive(next);
    const payload = { active: next, stockExportRendering: false };
    pi.events.emit(YPI_CALM_EVENT, payload);
    pi.events.emit(LEGACY_CALM_EVENT, payload);
    ui.setHiddenThinkingLabel(next ? "" : undefined);
    syncHarborWidget(ui, true);
  };

  pi.on("session_start", (_event, ctx) => {
    running = false;
    widgetShown = false;
    animation.reset();
    const initial = loadCalmPreference();
    if (ctx.hasUI) {
      apply(ctx.ui, initial);
    } else {
      setCalmActive(initial);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    running = true;
    animation.reset();
    animation.setPhase("thinking");
    if (ctx.hasUI) syncHarborWidget(ctx.ui);
  });

  pi.on("turn_start", () => {
    animation.setPhase("thinking");
  });

  pi.on("tool_execution_start", (event) => {
    animation.setPhase(phaseForTool(event.toolName));
  });

  pi.on("tool_execution_end", () => {
    animation.setPhase("thinking");
  });

  pi.on("agent_settled", (_event, ctx) => {
    running = false;
    if (ctx.hasUI) syncHarborWidget(ctx.ui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    running = false;
    if (ctx.hasUI) syncHarborWidget(ctx.ui);
  });

  pi.registerCommand("calm", {
    description:
      "Toggle calm focus mode (hides tool noise and sails a moonlit harbor while working)",
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status") {
        ctx.ui.notify(`Calm mode is ${isCalmActive() ? "on" : "off"}`, "info");
        return Promise.resolve();
      }
      const next = arg === "on" ? true : arg === "off" ? false : !isCalmActive();
      try {
        saveCalmPreference(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save calm preference: ${message}`, "error");
        return Promise.resolve();
      }
      apply(ctx.ui, next);
      ctx.ui.notify(next ? "Calm mode on" : "Calm mode off", "info");
      return Promise.resolve();
    },
  });
}
