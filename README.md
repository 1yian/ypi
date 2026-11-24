# ypi

A user-agnostic, provider-agnostic Pi harness package bundling four extensions in one install:

- [`pi-tiers`](https://github.com/1yian/pi-tiers) - model tier routing, fallback chains, cooldowns, and directory/remote provider rules.
- [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) - web search, page fetching, and content extraction.
- [`@ff-labs/pi-fff`](https://www.npmjs.com/package/@ff-labs/pi-fff) - fast git-aware fuzzy file search and grep.
- **OptChat (fold mode)** - conversation memory with a configurable compactor provider/model/tier and router-aware prompt cache marks (based on MIT-licensed `pi-optchat` 0.9.0).

## Install

```bash
pi install git:github.com/1yian/ypi
```

Or try it for one session without changing settings:

```bash
pi -e git:github.com/1yian/ypi
```

## Configure

All configuration is opt-in and provider-agnostic:

1. **Model tiers (`~/.pi/agent/tiers.json`):** copy `templates/tiers.example.json` and fill in whichever providers and models you use (Anthropic, OpenAI, Google Vertex, OpenRouter, local models, etc.).
2. **OptChat memory (`~/.pi/agent/optchat.json` or `<project>/.pi/optchat.json` or `YPI_OPTCHAT_CONFIG`):** copy `templates/optchat.example.json` and set `"enabled": true`.
   - `compactorProvider` and `compactorModel` accept any provider/model in your Pi registry, including a `pi-tiers` virtual tier such as `"compactorProvider": "tier", "compactorModel": "compact"`.
   - If omitted or unavailable, compaction falls back cleanly to the session's active model.
   - `"mode": "fold"` keeps a plain prompt-cached transcript and folds into memory when context passes `foldTokens` (default `150000`) or after prompt cache expiry (`foldOnCacheExpiry: true`).
