# ypi

A user-agnostic, provider-agnostic [Pi](https://pi.dev) harness bundle packaging:

- **`pi-tiers`** (`github:1yian/pi-tiers`) - model tier routing, fallback chains, cooldown rotation, and provider policies.
- **`pi-web-access`** - web search and content fetching.
- **`@ff-labs/pi-fff`** - fast git-aware fuzzy file finder and grep.
- **OptChat (`src/optchat.ts`)** - fold-mode session memory (`pi-optchat` 0.9.0 with fold-mode compaction and router-aware prompt cache marks) with a configurable compactor model or tier.
- **`ypi` + `ypi-light` themes (`themes/`)** - obsidian-ink dark palette with electric mint, soft violet, sky blue, amber, and coral accents designed to look sharp both in `herdr` and default terminals, plus a matching light theme for automatic light/dark switching.
- **Refined TUI (`src/tui.ts`)** - OpenCode / OMP-inspired left-rail composer, compact startup header, single-line collapsed tool rows (expandable with `ctrl+o` or click), pulsing working indicator, and responsive 2-row telemetry footer with `pi-tiers` route display, visual context bar, token totals, cache rate, cost, and live `tok/s`.
- **Calm Mode (`src/calm.ts`)** - `/calm` toggle (`on` / `off` / `status`) that hides tool call noise and collapsed thinking labels while sailing a theme-aware moonlit harbor animation above the composer whenever the agent is working.

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

## Configure OptChat (optional)

OptChat stays inactive until enabled in an `optchat.json` file. `ypi` checks, in order:

1. `YPI_OPTCHAT_CONFIG` environment variable
2. `<cwd>/.pi/optchat.json`
3. `<PI_CODING_AGENT_DIR>/optchat.json` (defaults to `~/.pi/agent/optchat.json`)

Copy `templates/optchat.example.json` to `~/.pi/agent/optchat.json`:

```json
{
  "enabled": true,
  "memoryHome": "~/.local/share/ypi/optchat",
  "profile": "default",
  "compactorProvider": "tier",
  "compactorModel": "compact",
  "thinking": "low",
  "mode": "fold",
  "foldTokens": 150000,
  "foldOnCacheExpiry": true
}
```

`compactorProvider` and `compactorModel` accept any provider and model registered in Pi (including `pi-tiers` virtual tiers like `tier` / `compact`). If omitted or unavailable, `ypi` falls back to the session's active model.

## Calm mode

Run `/calm` inside Pi to toggle focus mode (persisted to `~/.pi/agent/ypi-calm`, overridable via `YPI_CALM_FILE`):

- Hides tool execution rows (while preserving tool images) and collapsed thinking labels; everything stays in LLM context and `/export`.
- Replaces the default spinner row with a 3-row moonlit harbor sailboat animation tinted from your active Pi theme.
- Toggle back anytime with `/calm` (or `/calm off`) to immediately reveal every tool row in the transcript.

## Development

```bash
bun install
bun run check
```

## License

MIT. Vendored OptChat under `vendor/optchat/` retains its original MIT license and notices (`vendor/optchat/LICENSE`, `vendor/optchat/THIRD_PARTY_NOTICES.md`).
