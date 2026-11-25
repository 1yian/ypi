import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  Theme,
  ToolExecutionComponent,
  type ExtensionUIContext,
  type ThemeBg,
  type ThemeColor,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  stripTerminalSequences,
  Text,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { createActivityTracker, OPTCHAT_COMPACTING_EVENT } from "../src/activity.ts";
import { renderActivityBorder } from "../src/activity-renderer.ts";
import { loadCalmPreference, saveCalmPreference } from "../src/calm-state.ts";
import { loadOptChatConfig } from "../src/config.ts";
import { buildPiLaunchPlan } from "../src/launch.ts";

const ROOT = resolve(import.meta.dirname, "..");

type EditorFactoryFn = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

const noop = () => undefined;
const identity = (text: string) => text;

interface InteractiveEditorComponent extends Component {
  readonly getText: () => string;
  readonly setText: (text: string) => void;
  readonly handleInput: (data: string) => void;
}

function isInteractiveEditor(value: unknown): value is InteractiveEditorComponent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "render") === "function" &&
    typeof Reflect.get(value, "getText") === "function" &&
    typeof Reflect.get(value, "setText") === "function" &&
    typeof Reflect.get(value, "handleInput") === "function"
  );
}

const StringArray = z.array(z.string());
const StringMap = z.record(z.string(), z.string());
const ColorValue = z.union([z.string(), z.number()]);
const ColorMap = z.record(z.string(), ColorValue);

const PackageManifestSchema = z.object({
  keywords: StringArray,
  dependencies: StringMap,
  peerDependencies: StringMap,
  pi: z.object({
    extensions: StringArray,
    themes: StringArray,
  }),
});

const ThemeFileSchema = z.object({
  name: z.string().min(1),
  appearance: z.enum(["dark", "light"]),
  vars: ColorMap,
  colors: ColorMap,
  export: z.object({
    pageBg: z.string(),
    cardBg: z.string(),
    infoBg: z.string(),
  }),
});

const FG_TOKENS: readonly ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
];

const BG_TOKENS: readonly ThemeBg[] = [
  "selectedBg",
  "searchMatchBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
];

function resolveThemeValue(
  raw: string | number,
  vars: Record<string, string | number>,
): string | number {
  let current = raw;
  let depth = 0;
  while (typeof current === "string" && current in vars && depth < 10) {
    current = vars[current] ?? current;
    depth += 1;
  }
  return current;
}

function resolveToken(
  token: string,
  colors: Record<string, string | number>,
  vars: Record<string, string | number>,
): string | number {
  const raw = colors[token];
  assert.ok(raw !== undefined, `missing theme token: ${token}`);
  return resolveThemeValue(raw, vars);
}

function buildThemeFromJson(filePath: string): Theme {
  const rawJson: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const parsed = ThemeFileSchema.parse(rawJson);

  const fgColors: Partial<Record<ThemeColor, string | number>> = {};
  for (const token of FG_TOKENS) {
    fgColors[token] = resolveToken(token, parsed.colors, parsed.vars);
  }
  const bgColors: Partial<Record<ThemeBg, string | number>> = {};
  for (const token of BG_TOKENS) {
    bgColors[token] = resolveToken(token, parsed.colors, parsed.vars);
  }

  const built: unknown = Reflect.construct(Theme, [
    fgColors,
    bgColors,
    "truecolor",
    { name: parsed.name, appearance: parsed.appearance },
  ]);
  assert.ok(built instanceof Theme, "expected Theme instance");
  return built;
}

function createHeadlessTerminal(): Terminal {
  return {
    start: noop,
    stop: noop,
    drainInput: () => Promise.resolve(),
    write: noop,
    columns: 90,
    rows: 30,
    kittyProtocolActive: false,
    moveBy: noop,
    hideCursor: noop,
    showCursor: noop,
    clearLine: noop,
    clearFromCursor: noop,
    clearScreen: noop,
    setTitle: noop,
    setProgress: noop,
    setProgramStatus: noop,
  };
}

interface CapturedUiState {
  workingVisible: boolean | undefined;
  hiddenThinkingLabel: string | undefined;
  editorFactory: EditorFactoryFn | undefined;
  readonly notifications: string[];
  readonly statuses: Map<string, string | undefined>;
  readonly widgets: Map<string, unknown>;
  readonly titles: string[];
  readonly terminalInputHandlers?: ((data: string) => unknown)[];
}

function createTestUiContext(theme: Theme, captured: CapturedUiState): ExtensionUIContext {
  let editorText = "";
  let toolsExpanded = false;
  return {
    select: () => Promise.resolve(undefined),
    confirm: () => Promise.resolve(false),
    input: () => Promise.resolve(undefined),
    notify(message: string) {
      captured.notifications.push(message);
    },
    onTerminalInput(handler) {
      captured.terminalInputHandlers?.push(handler);
      return () => {
        const idx = captured.terminalInputHandlers?.indexOf(handler) ?? -1;
        if (idx >= 0) captured.terminalInputHandlers?.splice(idx, 1);
      };
    },
    setStatus(key: string, text: string | undefined) {
      captured.statuses.set(key, text);
    },
    setWorkingMessage: noop,
    setWorkingVisible(visible: boolean) {
      captured.workingVisible = visible;
    },
    setWorkingIndicator: noop,
    setHiddenThinkingLabel(label?: string) {
      captured.hiddenThinkingLabel = label;
    },
    setWidget(key: string, content: unknown) {
      if (content === undefined) {
        captured.widgets.delete(key);
      } else {
        captured.widgets.set(key, content);
      }
    },
    setFooter: noop,
    setHeader: noop,
    setTitle(title: string) {
      captured.titles.push(title);
    },
    custom: () => Promise.reject(new Error("custom UI not used in headless test")),
    pasteToEditor(text: string) {
      editorText += text;
    },
    setEditorText(text: string) {
      editorText = text;
    },
    getEditorText: () => editorText,
    editor: () => Promise.resolve(undefined),
    addAutocompleteProvider: noop,
    setEditorComponent(factory: EditorFactoryFn | undefined) {
      captured.editorFactory = factory;
    },
    getEditorComponent: () => captured.editorFactory,
    theme,
    getAllThemes: () => [{ name: theme.name ?? "ypi", path: undefined }],
    getTheme: () => theme,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded: boolean) {
      toolsExpanded = expanded;
    },
  };
}

function assertBorderFitsWidths(theme: Theme, calm: boolean): void {
  const snapshots = [
    { phase: "idle" as const, detail: undefined, startedAt: 0, activeToolCount: 0 },
    { phase: "thinking" as const, detail: undefined, startedAt: 1000, activeToolCount: 0 },
    { phase: "working" as const, detail: undefined, startedAt: 1000, activeToolCount: 1 },
    { phase: "command" as const, detail: undefined, startedAt: 1000, activeToolCount: 1 },
    { phase: "compacting" as const, detail: "18k", startedAt: 1000, activeToolCount: 0 },
  ];

  for (const snapshot of snapshots) {
    for (const width of [12, 18, 24, 34, 48, 80, 140]) {
      for (let tick = 0; tick < 24; tick += 3) {
        const line = renderActivityBorder({
          width,
          theme,
          snapshot,
          tick,
          calm,
          hiddenLineCount: width >= 80 ? 2 : 0,
          now: 14_000,
        });
        assert.ok(
          visibleWidth(line) <= width,
          `border overflow at width ${width} (calm=${String(calm)}, phase=${snapshot.phase}): ${visibleWidth(line)}`,
        );
      }
    }
  }
}

void test("package.json declares a valid pi-package manifest and every extension and theme path resolves", () => {
  const rawPkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const pkg = PackageManifestSchema.parse(rawPkg);

  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.pi.extensions.length >= 6);
  assert.ok(pkg.pi.themes.includes("./themes"));

  for (const rel of pkg.pi.extensions) {
    const abs = resolve(ROOT, rel);
    assert.ok(existsSync(abs), `missing declared extension: ${rel}`);
  }

  for (const rel of pkg.pi.themes) {
    const abs = resolve(ROOT, rel);
    assert.ok(existsSync(abs), `missing declared theme directory: ${rel}`);
  }

  for (const hostPkg of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(pkg.dependencies[hostPkg], undefined, `${hostPkg} must not be in dependencies`);
    assert.equal(pkg.peerDependencies[hostPkg], "*", `${hostPkg} must be "*" in peerDependencies`);
  }
});

void test("bundled ypi and ypi-light themes resolve every variable and instantiate Pi Theme cleanly", () => {
  const dark = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
  assert.equal(dark.name, "ypi");
  assert.equal(dark.appearance, "dark");

  const light = buildThemeFromJson(join(ROOT, "themes", "ypi-light.json"));
  assert.equal(light.name, "ypi-light");
  assert.equal(light.appearance, "light");
});

void test("activity tracker distinguishes thinking, working, waiting for command, and compacting", () => {
  let changes = 0;
  const tracker = createActivityTracker(() => {
    changes += 1;
  });

  assert.equal(tracker.snapshot().phase, "idle");

  tracker.startAgent(1000);
  assert.equal(tracker.snapshot().phase, "thinking");

  tracker.onAssistantEvent("text_delta");
  assert.equal(tracker.snapshot().phase, "working");

  tracker.onAssistantEvent("thinking_delta");
  assert.equal(tracker.snapshot().phase, "thinking");

  tracker.startTool("call-1", "read", 2000);
  assert.equal(tracker.snapshot().phase, "working");

  tracker.startTool("call-2", "bash", 2500);
  assert.equal(tracker.snapshot().phase, "command");

  tracker.endTool("call-1");
  assert.equal(tracker.snapshot().phase, "command");

  tracker.endTool("call-2");
  assert.equal(tracker.snapshot().phase, "thinking");

  tracker.startCompacting("optchat", "18k", 3000);
  assert.equal(tracker.snapshot().phase, "compacting");
  assert.equal(tracker.snapshot().detail, "18k");

  tracker.stopCompacting("optchat");
  assert.equal(tracker.snapshot().phase, "thinking");
  assert.equal(tracker.snapshot().detail, undefined);

  tracker.settleAgent();
  assert.equal(tracker.snapshot().phase, "idle");

  tracker.startCompacting("optchat", "42k", 5000);
  assert.equal(tracker.snapshot().phase, "compacting");
  assert.equal(tracker.snapshot().detail, "42k");
  tracker.stopCompacting("optchat");
  assert.equal(tracker.snapshot().phase, "idle");
  assert.ok(changes >= 10);
});

void test("OpenCode/OMP activity border fits every width cleanly in both normal and calm zen modes", () => {
  const dark = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
  const light = buildThemeFromJson(join(ROOT, "themes", "ypi-light.json"));

  assertBorderFitsWidths(dark, false);
  assertBorderFitsWidths(dark, true);
  assertBorderFitsWidths(light, false);
  assertBorderFitsWidths(light, true);

  const thinkingLine = stripTerminalSequences(
    renderActivityBorder({
      width: 90,
      theme: dark,
      snapshot: { phase: "thinking", detail: undefined, startedAt: 1000, activeToolCount: 0 },
      tick: 3,
      calm: false,
      hiddenLineCount: 0,
      now: 14_000,
    }),
  );
  assert.ok(thinkingLine.includes("thinking"));
  assert.ok(thinkingLine.includes("0:13 · esc"));

  const commandLine = stripTerminalSequences(
    renderActivityBorder({
      width: 90,
      theme: dark,
      snapshot: { phase: "command", detail: undefined, startedAt: 1000, activeToolCount: 1 },
      tick: 4,
      calm: false,
      hiddenLineCount: 0,
      now: 9000,
    }),
  );
  assert.ok(commandLine.includes("waiting for command"));

  const compactLine = stripTerminalSequences(
    renderActivityBorder({
      width: 90,
      theme: dark,
      snapshot: { phase: "compacting", detail: "18k", startedAt: 1000, activeToolCount: 0 },
      tick: 5,
      calm: true,
      hiddenLineCount: 0,
      now: 5000,
    }),
  );
  assert.ok(compactLine.includes("compacting · 18k"));
  assert.ok(compactLine.includes("☾ calm · 0:04"));

  const dir = join(tmpdir(), `ypi-calm-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const prefFile = join(dir, "ypi-calm");
    assert.equal(loadCalmPreference(prefFile), false);
    saveCalmPreference(true, prefFile);
    assert.equal(loadCalmPreference(prefFile), true);
    saveCalmPreference(false, prefFile);
    assert.equal(loadCalmPreference(prefFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("Pi isolated extension loading hides all tool calls in calm mode, shows phases, and uses uniform editor rail strokes", async () => {
  const dir = join(tmpdir(), `ypi-pi-e2e-${Date.now()}`);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const prevCalmFile = process.env["YPI_CALM_FILE"];
  process.env["YPI_CALM_FILE"] = join(dir, "ypi-calm");

  try {
    initTheme("dark");
    const theme = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
    const eventBus = createEventBus();
    const loaded = await discoverAndLoadExtensions(
      [join(ROOT, "src", "tui.ts"), join(ROOT, "src", "calm.ts")],
      dir,
      agentDir,
      eventBus,
    );
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
      modelsPath: null,
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const sessionManager = SessionManager.inMemory(dir);
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      sessionManager,
      modelRegistry,
    );

    const sentMessages: {
      readonly customType: string;
      readonly content: unknown;
      readonly display: boolean;
      readonly triggerTurn: boolean | undefined;
    }[] = [];
    const sentUserMessages: string[] = [];
    let isIdleState = true;
    let queuedSteerText: string | undefined;
    let abortCount = 0;
    const editorHolder: { current: InteractiveEditorComponent | undefined } = {
      current: undefined,
    };

    runner.bindCore(
      {
        sendMessage(message, options) {
          sentMessages.push({
            customType: message.customType,
            content: message.content,
            display: message.display,
            triggerTurn: options?.triggerTurn,
          });
        },
        sendUserMessage(content) {
          sentUserMessages.push(typeof content === "string" ? content : JSON.stringify(content));
        },
        appendEntry: noop,
        setSessionName: noop,
        getSessionName: () => undefined,
        setLabel: noop,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: noop,
        refreshTools: noop,
        getCommands: () => [],
        setModel: () => Promise.resolve(false),
        getThinkingLevel: () => "medium",
        setThinkingLevel: noop,
        getSettings: () => ({}),
      },
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => isIdleState,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort() {
          abortCount += 1;
          if (queuedSteerText !== undefined && editorHolder.current !== undefined) {
            editorHolder.current.setText(queuedSteerText);
            queuedSteerText = undefined;
          }
        },
        shutdown: noop,
        hasPendingMessages: () => queuedSteerText !== undefined,
        getContextUsage: () => undefined,
        compact: noop,
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({
          selectedTools: [],
          cwd: dir,
          contextFiles: [],
          skills: [],
        }),
        executeTool: () => Promise.reject(new Error("not used")),
        getCallableTools: () => [],
      },
    );

    const captured: CapturedUiState = {
      workingVisible: undefined,
      hiddenThinkingLabel: "Thinking...",
      editorFactory: undefined,
      notifications: [],
      statuses: new Map(),
      widgets: new Map(),
      titles: [],
    };
    runner.setUIContext(createTestUiContext(theme, captured), "tui");

    await runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(captured.workingVisible, false);

    const baseRenderers: ToolRenderers = {
      renderCall: () => new Text("expanded base call", 0, 0),
      renderResult: () => new Text("expanded base output", 0, 0),
    };
    const resolvedTool = runner.resolveToolRenderers("bash", () => baseRenderers);
    assert.ok(resolvedTool !== undefined);

    const tui = new TuiMainScreen(createHeadlessTerminal());
    const toolRow = new ToolExecutionComponent(
      "bash",
      "tc-1",
      { command: "echo hello" },
      { showImages: false },
      resolvedTool,
      tui,
      dir,
    );
    toolRow.updateResult(
      { content: [{ type: "text", text: "hello\nworld" }], isError: false },
      false,
    );

    const normalToolLines = toolRow.render(80).map((line) => stripTerminalSequences(line));
    const joinedNormalTool = normalToolLines.join("\n");
    assert.ok(joinedNormalTool.includes("bash"));
    assert.ok(joinedNormalTool.includes("│"), "tool rail should use thin │ stroke");
    assert.ok(!joinedNormalTool.includes("┃"), "tool rail must not use thick ┃ stroke");

    const calmCommand = runner.getCommand("calm");
    assert.ok(calmCommand !== undefined);
    await calmCommand.handler("on", runner.createCommandContext());

    assert.deepEqual(
      captured.notifications,
      [],
      "/calm toggle must not spam chat with notifications",
    );
    assert.equal(captured.hiddenThinkingLabel, "");
    assert.deepEqual(
      toolRow.render(80),
      [],
      "existing tool row must hide immediately in calm mode",
    );

    toolRow.setExpanded(true);
    assert.deepEqual(toolRow.render(80), [], "expanded tool row must stay hidden in calm mode");

    assert.ok(captured.editorFactory !== undefined);
    const editorTheme: EditorTheme = {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    };
    const editorRaw: unknown = Reflect.apply(captured.editorFactory, undefined, [
      tui,
      editorTheme,
      new TuiKeybindingsManager(TUI_KEYBINDINGS),
    ]);
    assert.ok(isInteractiveEditor(editorRaw), "expected interactive editor component");
    editorHolder.current = editorRaw;

    const idleCalmLines = editorRaw.render(90).map((line) => stripTerminalSequences(line));
    const topIdle = idleCalmLines[0] ?? "";
    const bodyIdle = idleCalmLines[1] ?? "";
    const bottomIdle = idleCalmLines.at(-1) ?? "";
    assert.ok(topIdle.includes("╭"));
    assert.ok(topIdle.includes("☾ calm"));
    assert.ok(bodyIdle.includes("│"));
    assert.ok(!bodyIdle.includes("┃"), "editor rail must match thin ╭/╰ corners with │");
    assert.ok(bottomIdle.includes("╰"));

    editorRaw.setText(".");
    editorRaw.handleInput("\r");
    assert.equal(editorRaw.getText(), "", "'.' shortcut clears editor");
    assert.equal(sentMessages.length, 1, "'.' sends hidden continue message when idle");
    assert.equal(sentMessages[0]?.customType, "ypi-continue");
    assert.equal(sentMessages[0]?.display, false);
    assert.equal(sentMessages[0]?.triggerTurn, true);

    isIdleState = false;
    await runner.emit({ type: "agent_start" });
    const thinkingTop = stripTerminalSequences(editorRaw.render(90)[0] ?? "");
    assert.ok(thinkingTop.includes("thinking"));
    assert.ok(thinkingTop.includes("☾ calm"));

    queuedSteerText = "stop and do this instead";
    const queuedBottom = stripTerminalSequences(editorRaw.render(90).at(-1) ?? "");
    assert.ok(
      queuedBottom.includes("enter interrupt & send"),
      "bottom border hints double-enter interrupt when a message is queued",
    );

    editorRaw.setText("");
    editorRaw.handleInput("\r");
    assert.equal(abortCount, 1, "second enter while streaming with queued prompt aborts turn");
    assert.equal(editorRaw.getText(), "", "editor stays clear while waiting for turn settle");
    assert.equal(sentUserMessages.length, 0, "waits for agent_settled before sending");

    isIdleState = true;
    await runner.emit({ type: "agent_settled", aborted: true });
    assert.deepEqual(sentUserMessages, ["stop and do this instead"]);

    isIdleState = false;
    await runner.emit({ type: "agent_start" });
    await runner.emit({
      type: "tool_execution_start",
      toolCallId: "tc-2",
      toolName: "bash",
      args: { command: "sleep 1" },
    });
    const commandTop = stripTerminalSequences(editorRaw.render(90)[0] ?? "");
    assert.ok(commandTop.includes("waiting for command"));

    eventBus.emit(OPTCHAT_COMPACTING_EVENT, { active: true, detail: "24k" });
    const compactTop = stripTerminalSequences(editorRaw.render(90)[0] ?? "");
    assert.ok(compactTop.includes("compacting · 24k"));
    eventBus.emit(OPTCHAT_COMPACTING_EVENT, { active: false });

    editorRaw.setText(".");
    editorRaw.handleInput("\r");
    assert.equal(abortCount, 2, "'.' while streaming aborts current turn before continuing");

    await runner.emit({
      type: "tool_execution_end",
      toolCallId: "tc-2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "" }], details: undefined },
      isError: false,
    });
    isIdleState = true;
    await runner.emit({ type: "agent_settled", aborted: true });
    assert.equal(sentMessages.length, 2, "'.' sends hidden continue once aborted turn settles");

    const tierRenderer = runner.getEntryRenderer("pi-tiers");
    assert.ok(tierRenderer !== undefined, "ypi must register a pi-tiers entry renderer");
    const entryOptsCollapsed = {
      expanded: false,
      keyText: () => "",
      keyHint: () => "",
    };
    const entryOptsExpanded = {
      expanded: true,
      keyText: () => "",
      keyHint: () => "",
    };
    const routineEntry = {
      type: "custom" as const,
      id: "e-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-tiers",
      data: { text: "tier: auto → default (0.55)" },
    };
    const failoverEntry = {
      type: "custom" as const,
      id: "e-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-tiers",
      data: { text: "tier: anthropic could not be reached; this run continues on openai-codex" },
    };
    assert.equal(
      tierRenderer(routineEntry, entryOptsCollapsed, theme),
      undefined,
      "routine tier routing lines stay hidden when collapsed",
    );
    assert.equal(
      tierRenderer(failoverEntry, entryOptsCollapsed, theme),
      undefined,
      "failover notices stay hidden in calm mode when collapsed",
    );
    const expandedTier = tierRenderer(routineEntry, entryOptsExpanded, theme);
    assert.ok(expandedTier !== undefined, "expanded mode reveals tier routing entry");
    assert.ok(
      stripTerminalSequences(expandedTier.render(80)[0] ?? "").startsWith(" tier: auto"),
      "expanded tier entry renders with 1-column left padding",
    );

    await calmCommand.handler("off", runner.createCommandContext());
    assert.deepEqual(captured.notifications, [], "/calm off also stays quiet");
    assert.equal(captured.hiddenThinkingLabel, undefined);
    const restoredToolLines = toolRow.render(80).map((line) => stripTerminalSequences(line));
    assert.ok(restoredToolLines.length > 0, "tool row must reappear when calm mode turns off");
    assert.equal(
      tierRenderer(routineEntry, entryOptsCollapsed, theme),
      undefined,
      "routine tier lines stay hidden even outside calm mode",
    );
    const visibleFailover = tierRenderer(failoverEntry, entryOptsCollapsed, theme);
    assert.ok(
      visibleFailover !== undefined,
      "failover notice appears outside calm mode when collapsed",
    );

    await runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    if (prevCalmFile === undefined) {
      delete process.env["YPI_CALM_FILE"];
    } else {
      process.env["YPI_CALM_FILE"] = prevCalmFile;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("Pi OptChat extension disables subagents, inspector bar, and noisy status while keeping fold memory", async () => {
  const dir = join("/tmp", `ypi-oc-${Date.now().toString(36)}`);
  const agentDir = join(dir, "a");
  mkdirSync(agentDir, { recursive: true });
  const prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const prevOptchatHome = process.env["OPTCHAT_HOME"];
  const prevYpiOptchat = process.env["YPI_OPTCHAT"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  delete process.env["YPI_OPTCHAT"];

  try {
    initTheme("dark");
    const theme = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));
    const eventBus = createEventBus();
    const loaded = await discoverAndLoadExtensions(
      [join(ROOT, "src", "optchat.ts")],
      dir,
      agentDir,
      eventBus,
    );
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
      modelsPath: null,
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const sessionManager = SessionManager.inMemory(dir);
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      sessionManager,
      modelRegistry,
    );

    const activeTools = new Set<string>(["zoom", "date"]);
    runner.bindCore(
      {
        sendMessage: noop,
        sendUserMessage: noop,
        appendEntry(customType: string, data?: unknown) {
          sessionManager.appendCustomEntry(customType, data);
        },
        setSessionName: noop,
        getSessionName: () => undefined,
        setLabel: noop,
        getActiveTools: () => [...activeTools],
        getAllTools: () => [],
        setActiveTools(names: string[]) {
          activeTools.clear();
          for (const name of names) activeTools.add(name);
        },
        refreshTools: noop,
        getCommands: () => [],
        setModel: () => Promise.resolve(false),
        getThinkingLevel: () => "medium",
        setThinkingLevel: noop,
        getSettings: () => ({}),
      },
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: noop,
        shutdown: noop,
        hasPendingMessages: () => false,
        getContextUsage: () => undefined,
        compact: noop,
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({
          selectedTools: [],
          cwd: dir,
          contextFiles: [],
          skills: [],
        }),
        executeTool: () => Promise.reject(new Error("not used")),
        getCallableTools: () => [],
      },
    );

    const captured: CapturedUiState = {
      workingVisible: undefined,
      hiddenThinkingLabel: undefined,
      editorFactory: undefined,
      notifications: [],
      statuses: new Map(),
      widgets: new Map(),
      titles: [],
    };
    runner.setUIContext(createTestUiContext(theme, captured), "tui");

    const toolNames = new Set(runner.getAllRegisteredTools().map((entry) => entry.definition.name));
    assert.ok(toolNames.has("zoom"), "zoom memory tool must stay registered");
    assert.ok(toolNames.has("date"), "date memory tool must stay registered");
    assert.ok(!toolNames.has("spawn"), "spawn subagent tool must not be registered");
    assert.ok(!toolNames.has("models"), "models subagent tool must not be registered");
    assert.ok(!toolNames.has("tell"), "tell subagent tool must not be registered");

    const zoomTool = runner.getToolDefinition("zoom");
    assert.ok(zoomTool !== undefined);
    assert.ok(
      !zoomTool.description.toLowerCase().includes("subagent"),
      "zoom tool description must not mention subagents",
    );

    assert.equal(runner.getCommand("complete"), undefined);
    assert.equal(runner.getCommand("tell-main"), undefined);
    assert.ok(runner.getCommand("fold") !== undefined);
    assert.ok(runner.getCommand("optchat") !== undefined);
    assert.equal(runner.getShortcuts({}).size, 0, "inspector shortcut must not be bound");

    await runner.emit({ type: "session_start", reason: "startup" });

    assert.deepEqual(
      captured.notifications,
      [],
      "startup must not emit error or noisy OptChat banner notifications",
    );
    assert.equal(
      captured.widgets.has("optchat-agents"),
      false,
      "below-editor Agents/Usage/Activity bar must not mount",
    );
    assert.equal(
      captured.statuses.get("optchat"),
      undefined,
      "empty session should not clutter footer with OptChat status",
    );
    assert.equal(captured.titles.length, 0, "must not overwrite terminal tab title");

    const beforeStart = await runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "hello" },
      {
        selectedTools: [],
        cwd: dir,
        contextFiles: [],
        skills: [],
      },
    );
    const builtPrompt = beforeStart.systemPromptOptions.customPrompt ?? "";
    assert.ok(builtPrompt.includes("zoom(id, n)"), "memory view navigation must stay in prompt");
    assert.ok(!builtPrompt.toLowerCase().includes("subagent"), "prompt must not mention subagents");
    assert.ok(!builtPrompt.includes("models()"), "prompt must not mention models()");
    assert.ok(
      !builtPrompt.includes("[OptChat status]"),
      "prompt must not mention [OptChat status]",
    );

    await runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    if (prevAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
    }
    if (prevOptchatHome === undefined) {
      delete process.env["OPTCHAT_HOME"];
    } else {
      process.env["OPTCHAT_HOME"] = prevOptchatHome;
    }
    if (prevYpiOptchat === undefined) {
      delete process.env["YPI_OPTCHAT"];
    } else {
      process.env["YPI_OPTCHAT"] = prevYpiOptchat;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("loadOptChatConfig defaults OptChat on with tier/compact at 256k fold tokens and supports overrides and opt-out", () => {
  const dir = join(tmpdir(), `ypi-e2e-${Date.now()}`);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    const defaults = loadOptChatConfig(dir, undefined, { PI_CODING_AGENT_DIR: agentDir });
    assert.ok(defaults !== undefined);
    assert.equal(defaults.profile, undefined);
    assert.equal(defaults.compactorProvider, "tier");
    assert.equal(defaults.compactorModel, "compact");
    assert.equal(defaults.thinking, "low");
    assert.equal(defaults.foldTokens, 256_000);
    assert.equal(defaults.foldOnCacheExpiry, true);

    assert.equal(
      loadOptChatConfig(dir, undefined, { PI_CODING_AGENT_DIR: agentDir, YPI_OPTCHAT: "0" }),
      undefined,
    );

    const configPath = join(dir, "optchat.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        memoryHome: join(dir, "mem"),
        profile: "assistant",
        compactorProvider: "tier",
        compactorModel: "compact",
        thinking: "low",
        mode: "fold",
        foldTokens: 150_000,
        foldOnCacheExpiry: true,
      }),
    );

    const resolved = loadOptChatConfig(dir, configPath, { PI_CODING_AGENT_DIR: agentDir });
    assert.ok(resolved !== undefined);
    assert.equal(resolved.profile, "assistant");
    assert.equal(resolved.compactorProvider, "tier");
    assert.equal(resolved.compactorModel, "compact");
    assert.equal(resolved.foldTokens, 150_000);
    assert.equal(resolved.foldOnCacheExpiry, true);

    writeFileSync(configPath, JSON.stringify({ enabled: false }));
    assert.equal(loadOptChatConfig(dir, configPath, { PI_CODING_AGENT_DIR: agentDir }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("buildPiLaunchPlan wires bundled extensions, avoids duplicates, and respects flags", () => {
  const dir = join(tmpdir(), `ypi-launch-e2e-${Date.now()}`);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  try {
    const clean = buildPiLaunchPlan(["-p", "hello"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(clean.kind, "exec");
    assert.ok(clean.args.includes("--use-theme"));
    assert.ok(clean.args.includes("ypi"));
    assert.ok(clean.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(clean.args.some((arg) => arg.endsWith("src/tui.ts")));
    assert.ok(clean.args.some((arg) => arg.endsWith("src/calm.ts")));
    assert.ok(
      clean.args.findIndex((arg) => arg.endsWith("src/tui.ts")) <
        clean.args.findIndex((arg) => arg.endsWith("pi-tiers/src/index.ts")),
      "core ypi extensions must load before bundled pi-tiers so ypi entry renderers take precedence",
    );
    assert.deepEqual(clean.args.slice(-2), ["-p", "hello"]);

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: ["npm:pi-web-access@0.48.0", "git:github.com/1yian/pi-tiers@main"],
      }),
    );
    const deduped = buildPiLaunchPlan(["--use-theme", "ypi-light"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.ok(!deduped.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(!deduped.args.some((arg) => arg.endsWith("pi-web-access/dist")));
    assert.ok(deduped.args.some((arg) => arg.endsWith("@ff-labs/pi-fff/src/index.ts")));
    assert.ok(deduped.args.some((arg) => arg.endsWith("src/tui.ts")));
    assert.equal(
      deduped.args.filter((arg) => arg === "--use-theme").length,
      1,
      "must not duplicate user --use-theme",
    );

    const isolated = buildPiLaunchPlan(["--isolated", "-c"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.ok(isolated.args.includes("--no-extensions"));
    assert.ok(isolated.args.some((arg) => arg.endsWith("pi-tiers/src/index.ts")));
    assert.ok(!isolated.args.includes("--isolated"));

    const autoExitPlan = buildPiLaunchPlan(["--auto-exit=1500", "do task"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(autoExitPlan.kind, "exec");
    assert.equal(autoExitPlan.env?.["YPI_AUTO_EXIT"], "1500");
    assert.ok(!autoExitPlan.args.includes("--auto-exit=1500"));
    assert.equal(autoExitPlan.args.at(-1), "do task");

    const passthrough = buildPiLaunchPlan(["auth", "status"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.deepEqual(passthrough.args, ["auth", "status"]);

    const help = buildPiLaunchPlan(["--ypi-help"], {
      packageRoot: ROOT,
      cwd: dir,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(help.kind, "help");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("YPI_AUTO_EXIT shuts down unattended interactive turns and cancels on operator intervention", async () => {
  const dir = join(tmpdir(), `ypi-auto-exit-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const prevAutoExit = process.env["YPI_AUTO_EXIT"];
  const prevAutoExitMs = process.env["YPI_AUTO_EXIT_MS"];
  const prevCalmFile = process.env["YPI_CALM_FILE"];
  process.env["YPI_AUTO_EXIT"] = "1";
  process.env["YPI_AUTO_EXIT_MS"] = "60";
  process.env["YPI_CALM_FILE"] = join(dir, "calm");

  try {
    const theme = buildThemeFromJson(resolve(ROOT, "themes/ypi.json"));
    const loaded = await discoverAndLoadExtensions(
      [resolve(ROOT, "src/tui.ts")],
      dir,
      join(dir, "agent"),
      createEventBus(),
    );
    assert.deepEqual(loaded.errors, []);

    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      allowModelNetwork: false,
      modelsPath: null,
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const sessionManager = SessionManager.inMemory(dir);
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      sessionManager,
      modelRegistry,
    );

    const state = { isIdle: true, shutdowns: 0 };
    runner.bindCore(
      {
        sendMessage: noop,
        sendUserMessage: noop,
        appendEntry: noop,
        setSessionName: noop,
        getSessionName: () => undefined,
        setLabel: noop,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: noop,
        refreshTools: noop,
        getCommands: () => [],
        setModel: () => Promise.resolve(false),
        getThinkingLevel: () => "medium",
        setThinkingLevel: noop,
        getSettings: () => ({}),
      },
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => state.isIdle,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: noop,
        shutdown() {
          state.shutdowns += 1;
        },
        hasPendingMessages: () => false,
        getContextUsage: () => undefined,
        compact: noop,
        getSystemPrompt: () => "",
        getSystemPromptOptions: () => ({
          selectedTools: [],
          cwd: dir,
          contextFiles: [],
          skills: [],
        }),
        executeTool: () => Promise.reject(new Error("not used")),
        getCallableTools: () => [],
      },
    );

    const captured: CapturedUiState = {
      workingVisible: undefined,
      hiddenThinkingLabel: undefined,
      editorFactory: undefined,
      notifications: [],
      statuses: new Map(),
      widgets: new Map(),
      titles: [],
      terminalInputHandlers: [],
    };
    const uiCtx = createTestUiContext(theme, captured);
    runner.setUIContext(uiCtx, "tui");

    await runner.emit({ type: "session_start", reason: "startup" });

    state.isIdle = false;
    await runner.emit({ type: "agent_start" });
    state.isIdle = true;
    await runner.emit({ type: "agent_settled", aborted: true });
    await delay(90);
    assert.equal(state.shutdowns, 0, "aborted turn must not trigger auto-exit");

    uiCtx.setEditorText("wait check one more thing");
    state.isIdle = false;
    await runner.emit({ type: "agent_start" });
    state.isIdle = true;
    await runner.emit({ type: "agent_settled", aborted: false });
    await delay(90);
    assert.equal(state.shutdowns, 0, "non-empty editor draft must not trigger auto-exit");
    uiCtx.setEditorText("");

    state.isIdle = false;
    await runner.emit({ type: "agent_start" });
    state.isIdle = true;
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.ok(
      (captured.statuses.get("ypi-auto-exit") ?? "").includes("exiting"),
      "countdown status should show during grace window",
    );
    for (const handler of captured.terminalInputHandlers ?? []) {
      handler(" ");
    }
    await delay(90);
    assert.equal(state.shutdowns, 0, "pressing a key during grace window must cancel auto-exit");
    assert.equal(captured.statuses.get("ypi-auto-exit"), undefined);

    state.isIdle = false;
    await runner.emit({ type: "agent_start" });
    state.isIdle = true;
    await runner.emit({ type: "agent_settled", aborted: false });
    for (const handler of captured.terminalInputHandlers ?? []) {
      handler("\u001B[O");
      handler("\u001B[<35;10;10M");
    }
    await delay(90);
    assert.equal(
      state.shutdowns,
      1,
      "unattended turn must auto-exit cleanly despite focus/mouse ANSI events",
    );

    await runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    if (prevAutoExit === undefined) delete process.env["YPI_AUTO_EXIT"];
    else process.env["YPI_AUTO_EXIT"] = prevAutoExit;
    if (prevAutoExitMs === undefined) delete process.env["YPI_AUTO_EXIT_MS"];
    else process.env["YPI_AUTO_EXIT_MS"] = prevAutoExitMs;
    if (prevCalmFile === undefined) delete process.env["YPI_CALM_FILE"];
    else process.env["YPI_CALM_FILE"] = prevCalmFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

interface OptChatHarness {
  readonly runner: ExtensionRunner;
  readonly sessionManager: SessionManager;
  readonly captured: CapturedUiState;
  readonly runTurn: (
    userText: string,
    replyText: string,
  ) => Promise<{
    readonly userId: string;
    readonly assistantId: string;
    readonly contextText: string;
  }>;
  readonly zoom: (id: number, n?: number) => Promise<string>;
}

async function createOptChatHarness(
  dir: string,
  agentDir: string,
  sessionManager: SessionManager,
  theme: Theme,
): Promise<OptChatHarness> {
  const eventBus = createEventBus();
  const loaded = await discoverAndLoadExtensions(
    [join(ROOT, "src", "optchat.ts")],
    dir,
    agentDir,
    eventBus,
  );
  assert.deepEqual(loaded.errors, []);

  const modelRuntime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    dir,
    sessionManager,
    modelRegistry,
  );
  const activeTools = new Set<string>(["zoom", "date"]);
  let lastSystemPrompt = "";
  runner.bindCore(
    {
      sendMessage: noop,
      sendUserMessage: noop,
      appendEntry(customType: string, data?: unknown) {
        sessionManager.appendCustomEntry(customType, data);
      },
      setSessionName: noop,
      getSessionName: () => undefined,
      setLabel: noop,
      getActiveTools: () => [...activeTools],
      getAllTools: () => [],
      setActiveTools(names: string[]) {
        activeTools.clear();
        for (const name of names) activeTools.add(name);
      },
      refreshTools: noop,
      getCommands: () => [],
      setModel: () => Promise.resolve(false),
      getThinkingLevel: () => "medium",
      setThinkingLevel: noop,
      getSettings: () => ({}),
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: noop,
      shutdown: noop,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      compact: noop,
      getSystemPrompt: () => lastSystemPrompt,
      getSystemPromptOptions: () => ({
        selectedTools: [],
        cwd: dir,
        contextFiles: [],
        skills: [],
      }),
      executeTool: () => Promise.reject(new Error("not used")),
      getCallableTools: () => [],
    },
  );

  const captured: CapturedUiState = {
    workingVisible: undefined,
    hiddenThinkingLabel: undefined,
    editorFactory: undefined,
    notifications: [],
    statuses: new Map(),
    widgets: new Map(),
    titles: [],
  };
  runner.setUIContext(createTestUiContext(theme, captured), "tui");

  const runTurn = async (userText: string, replyText: string) => {
    const now = Date.now();
    await runner.emitInput(userText, undefined, "interactive");
    const before = await runner.emitBeforeAgentStart(
      { messageType: "user", prompt: userText },
      { selectedTools: [], cwd: dir, contextFiles: [], skills: [] },
    );
    lastSystemPrompt = before.systemPromptOptions.customPrompt ?? "";
    await runner.emit({ type: "agent_start" });

    const userMsg = {
      role: "user" as const,
      content: [{ type: "text" as const, text: userText }],
      timestamp: now,
    };
    const userId = sessionManager.appendMessage(userMsg);
    await runner.emitMessageEnd({ type: "message_end", message: userMsg });

    const contextMessages = await runner.emitContext([
      { role: "system", content: lastSystemPrompt, timestamp: 0 },
      userMsg,
    ]);
    const contextText = contextMessages
      .map((m) => {
        if (!("content" in m)) return "";
        if (typeof m.content === "string") return m.content;
        if (!Array.isArray(m.content)) return "";
        return m.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      })
      .join("\n---\n");

    const assistantMsg = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: replyText }],
      api: "anthropic-messages" as const,
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: now + 1,
    };
    const assistantId = sessionManager.appendMessage(assistantMsg);
    await runner.emitMessageEnd({ type: "message_end", message: assistantMsg });
    await runner.emit({ type: "agent_settled", aborted: false });

    return { userId, assistantId, contextText };
  };

  const zoom = async (id: number, n = 1) => {
    const def = runner.getToolDefinition("zoom");
    assert.ok(def !== undefined, "zoom tool must exist");
    const toolCtx = runner.createToolContext("zoom-call", undefined);
    const out = await def.execute("zoom-call", { id, n }, undefined, undefined, toolCtx);
    return out.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  };

  return { runner, sessionManager, captured, runTurn, zoom };
}

void test("Pi /tree rewind, /fork isolation, and named-profile pre-session history stay synced with OptChat memory", async () => {
  const dir = join("/tmp", `ypi-rw-${Date.now().toString(36)}`);
  const agentDir = join(dir, "a");
  const sessionsDir = join(dir, "s");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const prevOptchatHome = process.env["OPTCHAT_HOME"];
  const prevYpiOptchat = process.env["YPI_OPTCHAT"];
  const prevYpiOptchatConfig = process.env["YPI_OPTCHAT_CONFIG"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  delete process.env["YPI_OPTCHAT"];
  delete process.env["YPI_OPTCHAT_CONFIG"];

  const activeHarnesses = new Set<OptChatHarness>();
  const startHarness = async (
    sessionManager: SessionManager,
    theme: Theme,
    event:
      | { readonly type: "session_start"; readonly reason: "startup" | "resume" }
      | {
          readonly type: "session_start";
          readonly reason: "fork";
          readonly previousSessionFile?: string;
        },
  ): Promise<OptChatHarness> => {
    const h = await createOptChatHarness(dir, agentDir, sessionManager, theme);
    activeHarnesses.add(h);
    await h.runner.emit(event);
    return h;
  };
  const stopHarness = async (
    h: OptChatHarness,
    reason: "quit" | "fork" = "quit",
  ): Promise<void> => {
    if (!activeHarnesses.delete(h)) return;
    await h.runner.emit({ type: "session_shutdown", reason });
  };

  try {
    initTheme("dark");
    const theme = buildThemeFromJson(join(ROOT, "themes", "ypi.json"));

    const s1 = SessionManager.create(dir, sessionsDir);
    const h1 = await startHarness(s1, theme, { type: "session_start", reason: "startup" });

    const t1 = await h1.runTurn("alpha-prompt", "alpha-answer");
    const t2 = await h1.runTurn("beta-prompt", "beta-answer");
    const t3 = await h1.runTurn("gamma-prompt", "gamma-answer");

    assert.equal(h1.captured.statuses.get("optchat"), "memory · 6 msgs");
    const z4 = await h1.zoom(4, 1);
    assert.ok(z4.includes("gamma-prompt"));

    const oldLeaf = s1.getLeafId();
    s1.branch(t1.assistantId);
    await h1.runner.emit({
      type: "session_tree",
      oldLeafId: oldLeaf,
      newLeafId: t1.assistantId,
    });

    assert.equal(h1.captured.statuses.get("optchat"), "memory · 2 msgs");
    const z0 = await h1.zoom(0, 1);
    assert.ok(z0.includes("alpha-prompt"));
    await assert.rejects(h1.zoom(2, 1), /No line 2\+1/u);

    const t2Alt = await h1.runTurn("delta-prompt", "delta-answer");
    assert.ok(t2Alt.contextText.includes("alpha-prompt"));
    assert.ok(t2Alt.contextText.includes("alpha-answer"));
    assert.equal(t2Alt.contextText.includes("beta-prompt"), false);
    assert.equal(t2Alt.contextText.includes("gamma-prompt"), false);
    assert.equal(h1.captured.statuses.get("optchat"), "memory · 4 msgs");

    s1.branch(t3.assistantId);
    await h1.runner.emit({
      type: "session_tree",
      oldLeafId: t2Alt.assistantId,
      newLeafId: t3.assistantId,
    });
    assert.equal(h1.captured.statuses.get("optchat"), "memory · 6 msgs");
    const z4Restored = await h1.zoom(4, 1);
    const z2Restored = await h1.zoom(2, 1);
    assert.ok(z4Restored.includes("gamma-prompt"));
    assert.equal(z2Restored.includes("delta-prompt"), false);

    s1.resetLeaf();
    await h1.runner.emit({
      type: "session_tree",
      oldLeafId: t3.assistantId,
      newLeafId: null,
    });
    assert.equal(h1.captured.statuses.get("optchat"), undefined);
    await assert.rejects(h1.zoom(0, 1), /No line 0\+1/u);

    s1.branch(t2.assistantId);
    await h1.runner.emit({
      type: "session_tree",
      oldLeafId: null,
      newLeafId: t2.assistantId,
    });
    assert.equal(h1.captured.statuses.get("optchat"), "memory · 4 msgs");
    const s1File = s1.getSessionFile();
    assert.ok(s1File !== undefined);
    await stopHarness(h1, "fork");

    const s2 = SessionManager.open(s1File, sessionsDir);
    const forkedFile = s2.createBranchedSession(t1.assistantId);
    assert.ok(forkedFile !== undefined);
    const h2 = await startHarness(s2, theme, {
      type: "session_start",
      reason: "fork",
      previousSessionFile: s1File,
    });

    assert.equal(h2.captured.statuses.get("optchat"), "memory · 2 msgs");
    const z0Fork = await h2.zoom(0, 1);
    assert.ok(z0Fork.includes("alpha-prompt"));
    await assert.rejects(h2.zoom(2, 1), /No line 2\+1/u);

    const t2Fork = await h2.runTurn("fork-prompt", "fork-answer");
    assert.ok(t2Fork.contextText.includes("alpha-prompt"));
    assert.equal(t2Fork.contextText.includes("beta-prompt"), false);
    await stopHarness(h2);

    const s1Resumed = SessionManager.open(s1File, sessionsDir);
    const h1Resumed = await startHarness(s1Resumed, theme, {
      type: "session_start",
      reason: "resume",
    });
    assert.equal(h1Resumed.captured.statuses.get("optchat"), "memory · 4 msgs");
    const z2Resumed = await h1Resumed.zoom(2, 1);
    assert.ok(z2Resumed.includes("beta-prompt"));
    await stopHarness(h1Resumed);

    const namedConfigPath = join(dir, "named-optchat.json");
    writeFileSync(
      namedConfigPath,
      JSON.stringify({
        enabled: true,
        memoryHome: join(dir, "named-mem"),
        profile: "jarvis",
        mode: "fold",
        foldTokens: 256_000,
      }),
    );
    process.env["YPI_OPTCHAT_CONFIG"] = namedConfigPath;

    const priorSession = SessionManager.create(dir, sessionsDir);
    const priorHarness = await startHarness(priorSession, theme, {
      type: "session_start",
      reason: "startup",
    });
    await priorHarness.runTurn("prior-session-q", "prior-session-a");
    assert.equal(priorHarness.captured.statuses.get("optchat"), "memory · 2 msgs");
    await stopHarness(priorHarness);

    const nextSession = SessionManager.create(dir, sessionsDir);
    const nextHarness = await startHarness(nextSession, theme, {
      type: "session_start",
      reason: "startup",
    });
    assert.equal(nextHarness.captured.statuses.get("optchat"), "memory · 2 msgs");

    const nt1 = await nextHarness.runTurn("current-q1", "current-a1");
    const nt2 = await nextHarness.runTurn("current-q2", "current-a2");
    assert.equal(nextHarness.captured.statuses.get("optchat"), "memory · 6 msgs");

    nextSession.branch(nt1.assistantId);
    await nextHarness.runner.emit({
      type: "session_tree",
      oldLeafId: nt2.assistantId,
      newLeafId: nt1.assistantId,
    });
    assert.equal(nextHarness.captured.statuses.get("optchat"), "memory · 4 msgs");
    const nz0 = await nextHarness.zoom(0, 1);
    const nz2 = await nextHarness.zoom(2, 1);
    assert.ok(nz0.includes("prior-session-q"));
    assert.ok(nz2.includes("current-q1"));
    await assert.rejects(nextHarness.zoom(4, 1), /No line 4\+1/u);

    nextSession.resetLeaf();
    await nextHarness.runner.emit({
      type: "session_tree",
      oldLeafId: nt1.assistantId,
      newLeafId: null,
    });
    assert.equal(nextHarness.captured.statuses.get("optchat"), "memory · 2 msgs");
    const nz0Root = await nextHarness.zoom(0, 1);
    assert.ok(nz0Root.includes("prior-session-q"));
    await assert.rejects(nextHarness.zoom(2, 1), /No line 2\+1/u);

    await stopHarness(nextHarness);
  } finally {
    for (const h of activeHarnesses) {
      await stopHarness(h);
    }
    if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
    if (prevOptchatHome === undefined) delete process.env["OPTCHAT_HOME"];
    else process.env["OPTCHAT_HOME"] = prevOptchatHome;
    if (prevYpiOptchat === undefined) delete process.env["YPI_OPTCHAT"];
    else process.env["YPI_OPTCHAT"] = prevYpiOptchat;
    if (prevYpiOptchatConfig === undefined) delete process.env["YPI_OPTCHAT_CONFIG"];
    else process.env["YPI_OPTCHAT_CONFIG"] = prevYpiOptchatConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
