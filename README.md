# ypi

A user-agnostic, provider-agnostic [Pi](https://pi.dev) harness bundle packaging:

- **`pi-tiers`** (`github:1yian/pi-tiers`) - model tier routing, fallback chains, cooldown rotation, and provider policies.
- **`pi-web-access`** - web search and content fetching.
- **`@ff-labs/pi-fff`** - fast git-aware fuzzy file finder and grep.
- **OptChat (`src/optchat.ts`)** - fold-mode session memory (`pi-optchat` 0.9.0 with fold-mode compaction and router-aware prompt cache marks) with a configurable compactor model or tier.
- **`ypi` + `ypi-light` themes (`themes/`)** - obsidian-ink dark palette with electric mint, soft violet, sky blue, amber, and coral accents designed to look sharp both in `herdr` and default terminals, plus a matching light theme for automatic light/dark switching.
- **Refined TUI (`src/tui.ts`)** - OpenCode / OMP-inspired uniform left-rail composer (`╭`/`│`/`╰`), compact startup header, single-line collapsed tool rows (expandable with `ctrl+o` or click), live Knight Rider luminous scanner with phase shimmer (`thinking`, `working`, `waiting for command`, `compacting`), and responsive 2-row telemetry footer with `pi-tiers` route display, visual context bar, token totals, cache rate, cost, and live `tok/s`.
- **Calm Mode (`src/calm.ts`)** - `/calm` toggle (`on` / `off` / `status`) that hides all tool calls (including expanded rows) and collapsed thinking labels, and softens the composer rail and activity scanner into a serene zen presentation.

No hardcoded user paths, no hardcoded providers, no orchestrator coupling. Bring your own providers, tiers, and model credentials.

## Install

### Run as a command (`ypi`)

```bash
git clone https://github.com/1yian/ypi.git
cd ypi && bun install
ln -sf "$PWD/src/bin.ts" ~/.local/bin/ypi
```

Then just launch Pi with the full `ypi` bundle, theme, TUI, and `/calm` anywhere:

```bash
ypi
ypi -c
ypi --isolated
ypi --ypi-help
```

All standard `pi` flags and subcommands (`ypi -p ...`, `ypi --model ...`, `ypi auth ...`) pass straight through. `ypi` automatically skips re-loading `pi-tiers`, `pi-web-access`, or `@ff-labs/pi-fff` if you already have them in `~/.pi/agent/settings.json`, or run `ypi --isolated` to disable global Pi extensions and load only `ypi`.

### Or install as a Pi package

```bash
pi install git:github.com/1yian/ypi
```

Or add it directly to `~/.pi/agent/settings.json`:

```json
{
  "theme": "ypi",
  "packages": ["git:github.com/1yian/ypi"]
}
```

For automatic terminal light/dark switching, set `"theme": "ypi-light/ypi"` (or pick `ypi` in `/settings`).

## Configure tiers

Copy `templates/tiers.example.json` to `~/.pi/agent/tiers.json` and edit the provider/model chains for whatever providers you authenticate with Pi (`anthropic`, `openai`, `openai-codex`, `google`, `openrouter`, etc.).

## OptChat & `/compact` (enabled by default)

OptChat fold-mode memory is **on by default** in `ypi`:

- **Default compactor:** `tier/compact` (`thinking: "low"`), falling back cleanly to the session's active model if no `compact` tier is configured.
- **Auto-fold:** keeps prompt caches warm across turns and auto-folds at **256k tokens or the model's context limit, whichever is lower**, or when the prompt cache expires (`foldOnCacheExpiry: true`).
- **Immediate `/compact`:** running `/compact` immediately flushes and settles the current conversation into OptChat's zoomable memory tree using the configured compactor and resets the active prompt window.
- **Zero lock collisions:** each session automatically binds to its own session-scoped OptChat profile under `~/.pi/agent/ypi/optchat/profiles/` (persisted across `ypi -c` / `ypi -r`, cleaned up on exit for `--no-session`).
- **Memory-only (no subagent chrome):** OptChat's background subagents (`spawn` / `tell` / `models`), below-editor Agents/Usage/Activity inspector bar, and `f6` shortcut are disabled in `ypi` so you only get fold-mode memory (`zoom`, `date`, `/compact`, `/fold`).

To pin a persistent named profile (for example, a long-lived assistant) or customize settings, create `<cwd>/.pi/optchat.json` or `~/.pi/agent/optchat.json` (or set `YPI_OPTCHAT_CONFIG`):

```json
{
  "enabled": true,
  "memoryHome": "~/.local/share/ypi/optchat",
  "profile": "default",
  "compactorProvider": "tier",
  "compactorModel": "compact",
  "thinking": "low",
  "mode": "fold",
  "foldTokens": 256000,
  "foldOnCacheExpiry": true
}
```

Set `"enabled": false` or `YPI_OPTCHAT=0` to disable OptChat.

## Calm mode

Run `/calm` inside Pi to toggle zen focus mode (persisted to `~/.pi/agent/ypi-calm`, overridable via `YPI_CALM_FILE`):

- Hides all tool execution rows (including expanded views, while keeping everything in LLM context and `/export`) and hides collapsed thinking labels.
- Shifts the composer rail and OpenCode-style top-rail luminous scanner to a slower, softer twilight breath with a right-aligned `☾ calm` indicator that never clips at any width.
- Toggle back anytime with `/calm` (or `/calm off`) quietly (no chat spam) to immediately reveal every tool row in the transcript.

## Composer shortcuts

- **Double-Enter while streaming:** first Enter queues a steering message; pressing Enter again on the empty editor interrupts the running turn and sends your queued message immediately.
- **`.` + Enter:** sends a hidden continuation nudge (no visible chat message) to get the agent to continue or respond; interrupts first if streaming.

## Development

```bash
bun install
bun run check
```

`bun run check` enforces `oxfmt`, `oxlint --type-aware --max-warnings 0`, `tsc --noEmit`, `knip --treat-config-hints-as-errors`, `depcruise src e2e`, and `node --test e2e/*.test.ts`.

## License

MIT. Vendored OptChat under `vendor/optchat/` retains its original MIT license and notices (`vendor/optchat/LICENSE`, `vendor/optchat/THIRD_PARTY_NOTICES.md`).
