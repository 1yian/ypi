export type ActivityPhase = "idle" | "thinking" | "working" | "command" | "compacting";

type CompactingSource = "pi" | "optchat";

export const OPTCHAT_COMPACTING_EVENT = "ypi:optchat-compacting";

interface CompactingEventPayload {
  readonly active: boolean;
  readonly detail?: string;
}

export interface ActivitySnapshot {
  readonly phase: ActivityPhase;
  readonly detail: string | undefined;
  readonly startedAt: number;
  readonly activeToolCount: number;
}

interface ActivityTracker {
  snapshot: () => ActivitySnapshot;
  reset: () => void;
  startAgent: (now?: number) => void;
  startTurn: (now?: number) => void;
  onAssistantEvent: (eventType: string) => void;
  startTool: (toolCallId: string, toolName: string, now?: number) => void;
  endTool: (toolCallId: string) => void;
  settleAgent: () => void;
  startCompacting: (source: CompactingSource, detail?: string, now?: number) => void;
  stopCompacting: (source: CompactingSource) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCompactingEvent(data: unknown): CompactingEventPayload | undefined {
  if (!isRecord(data) || typeof data["active"] !== "boolean") return undefined;
  const rawDetail = data["detail"];
  const detail =
    typeof rawDetail === "string" && rawDetail.trim().length > 0 ? rawDetail.trim() : undefined;
  return detail === undefined ? { active: data["active"] } : { active: data["active"], detail };
}

function isCommandTool(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  return (
    lower === "bash" ||
    lower === "shell" ||
    lower === "powershell" ||
    lower === "exec" ||
    lower === "run_long" ||
    lower === "terminal" ||
    lower.endsWith("_bash") ||
    lower.endsWith("_shell") ||
    lower.endsWith("_exec")
  );
}

export function createActivityTracker(onChange?: () => void): ActivityTracker {
  let agentRunning = false;
  let turnPhase: "thinking" | "working" = "thinking";
  let startedAt = 0;
  let compactDetail: string | undefined;
  const activeTools = new Map<string, string>();
  const compactingSources = new Set<CompactingSource>();

  const derivePhase = (): ActivityPhase => {
    if (compactingSources.size > 0) return "compacting";
    if (!agentRunning) return "idle";
    for (const toolName of activeTools.values()) {
      if (isCommandTool(toolName)) return "command";
    }
    if (activeTools.size > 0) return "working";
    return turnPhase;
  };

  const notifyIfChanged = (prevPhase: ActivityPhase, prevDetail: string | undefined): void => {
    const nextPhase = derivePhase();
    const nextDetail = nextPhase === "compacting" ? compactDetail : undefined;
    if (nextPhase !== prevPhase || nextDetail !== prevDetail) {
      onChange?.();
    }
  };

  const ensureStartedAt = (now: number): void => {
    if (startedAt === 0) {
      startedAt = now;
    }
  };

  const reset = (): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    agentRunning = false;
    turnPhase = "thinking";
    startedAt = 0;
    compactDetail = undefined;
    activeTools.clear();
    compactingSources.clear();
    notifyIfChanged(prevPhase, prevDetail);
  };

  const startAgent = (now = Date.now()): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    agentRunning = true;
    turnPhase = "thinking";
    activeTools.clear();
    startedAt = now;
    notifyIfChanged(prevPhase, prevDetail);
  };

  const startTurn = (now = Date.now()): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    agentRunning = true;
    turnPhase = "thinking";
    ensureStartedAt(now);
    notifyIfChanged(prevPhase, prevDetail);
  };

  const onAssistantEvent = (eventType: string): void => {
    if (!agentRunning) return;
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    if (eventType === "thinking_start" || eventType === "thinking_delta") {
      turnPhase = "thinking";
    } else if (
      eventType === "text_start" ||
      eventType === "text_delta" ||
      eventType === "toolcall_start" ||
      eventType === "toolcall_delta"
    ) {
      turnPhase = "working";
    }
    notifyIfChanged(prevPhase, prevDetail);
  };

  const startTool = (toolCallId: string, toolName: string, now = Date.now()): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    agentRunning = true;
    ensureStartedAt(now);
    activeTools.set(toolCallId, toolName);
    notifyIfChanged(prevPhase, prevDetail);
  };

  const endTool = (toolCallId: string): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    activeTools.delete(toolCallId);
    if (activeTools.size === 0 && agentRunning) {
      turnPhase = "thinking";
    }
    notifyIfChanged(prevPhase, prevDetail);
  };

  const settleAgent = (): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    agentRunning = false;
    activeTools.clear();
    turnPhase = "thinking";
    if (compactingSources.size === 0) {
      startedAt = 0;
    }
    notifyIfChanged(prevPhase, prevDetail);
  };

  const startCompacting = (source: CompactingSource, detail?: string, now = Date.now()): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    compactingSources.add(source);
    if (detail !== undefined && detail.trim().length > 0) {
      compactDetail = detail.trim();
    }
    ensureStartedAt(now);
    notifyIfChanged(prevPhase, prevDetail);
  };

  const stopCompacting = (source: CompactingSource): void => {
    const prevPhase = derivePhase();
    const prevDetail = prevPhase === "compacting" ? compactDetail : undefined;
    compactingSources.delete(source);
    if (source === "optchat") {
      compactingSources.delete("pi");
    }
    if (compactingSources.size === 0) {
      compactDetail = undefined;
      if (!agentRunning) {
        startedAt = 0;
      }
    }
    notifyIfChanged(prevPhase, prevDetail);
  };

  const snapshot = (): ActivitySnapshot => {
    const phase = derivePhase();
    return {
      phase,
      detail: phase === "compacting" ? compactDetail : undefined,
      startedAt,
      activeToolCount: activeTools.size,
    };
  };

  return {
    snapshot,
    reset,
    startAgent,
    startTurn,
    onAssistantEvent,
    startTool,
    endTool,
    settleAgent,
    startCompacting,
    stopCompacting,
  };
}
