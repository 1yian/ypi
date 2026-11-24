import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  CALM_EVENT,
  LEGACY_CALM_EVENT,
  loadCalmPreference,
  saveCalmPreference,
} from "./calm-state.ts";

export default function ypiCalm(pi: ExtensionAPI): void {
  let calmActive = false;

  const apply = (ui: ExtensionUIContext | undefined, next: boolean): void => {
    calmActive = next;
    const payload = { active: next, stockExportRendering: false };
    pi.events.emit(CALM_EVENT, payload);
    pi.events.emit(LEGACY_CALM_EVENT, payload);
    ui?.setHiddenThinkingLabel(next ? "" : undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    const initial = loadCalmPreference();
    apply(ctx.hasUI ? ctx.ui : undefined, initial);
  });

  pi.registerCommand("calm", {
    description: "Toggle calm zen mode (hides all tool calls and softens the interface)",
    handler: (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "status") {
        ctx.ui.notify(`Calm mode is ${calmActive ? "on" : "off"}`, "info");
        return Promise.resolve();
      }
      const next = arg === "on" ? true : arg === "off" ? false : !calmActive;
      try {
        saveCalmPreference(next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save calm preference: ${message}`, "error");
        return Promise.resolve();
      }
      apply(ctx.hasUI ? ctx.ui : undefined, next);
      ctx.ui.notify(next ? "Calm mode on" : "Calm mode off", "info");
      return Promise.resolve();
    },
  });
}
