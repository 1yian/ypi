import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
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
    onTerminalInput: () => noop,
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

    await calmCommand.handler("off", runner.createCommandContext());
    assert.deepEqual(captured.notifications, [], "/calm off also stays quiet");
    assert.equal(captured.hiddenThinkingLabel, undefined);
    const restoredToolLines = toolRow.render(80).map((line) => stripTerminalSequences(line));
    assert.ok(restoredToolLines.length > 0, "tool row must reappear when calm mode turns off");

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
