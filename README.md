# pi-headroom

Unified, real-time [Headroom](https://github.com/headroom-ai/headroom) context-compression suite for [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

```text
⚡ Headroom: 42.1% (-28.4k · $0.09)
```

---

## Features

- **Multi-Provider Proxy Routing:** Automatically routes LLM requests through local Headroom proxy (`http://127.0.0.1:8787`) with zero-friction fallback to direct APIs when proxy is stopped:
  - **Google OAuth:** Native Cloud Code Assist / Antigravity wire streaming (`daily-cloudcode-pa.googleapis.com`) with browser `/login google` flow.
  - **OpenRouter:** OpenAI-compatible completions with automatic `x-headroom-base-url` forwarding.
  - **Opencode-Go, OpenAI, Anthropic, Moonshot AI:** Modular opt-in routing.
- **Live Statusline Badge:** Real-time token reduction percentage, tokens saved, and avoided cost in Pi's status bar.
- **Session-Level & Lifetime Tracking:** Automatically captures session baselines on start, computes session deltas, and provides disk-log fallback on proxy restart.
- **Cache-Compress-Retrieve (CCR) Tool:** Built-in `headroom_retrieve` agent tool allowing models to fetch exact uncompressed content on demand.
- **Custom Agent Status Tool:** `headroom_status` tool allowing agents to inspect compression metrics on demand.
- **Comprehensive Command Suite:** Full `/headroom` CLI for status, session reports, route toggling, format changes, and web dashboard access.

---

## Installation

### Method 1: Install via Pi Package Manager

```bash
pi install git:github.com/mastnacek/pi-headroom
```

### Method 2: Register Local Package in `settings.json`

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "D:/01_programovani/pi/plugins/pi-headroom"
  ]
}
```

---

## Slash Commands (`/headroom`)

| Command | Description |
| :--- | :--- |
| `/headroom status` | Full status report: proxy health, session savings, lifetime totals, active routes |
| `/headroom session` | Displays token savings, compression ratio, and cost avoided for active session |
| `/headroom savings` | Detailed breakdown of token reduction (schemas vs message compaction) |
| `/headroom route <provider> on\|off` | Toggle routing for `google`, `openrouter`, `openai`, `anthropic`, `moonshotai` |
| `/headroom scope <session\|lifetime>` | Switch statusline badge scope between current session and lifetime |
| `/headroom reset-session` | Reset active session baseline counter to current moment |
| `/headroom dashboard` | Open Headroom's web dashboard (`http://localhost:8787/dashboard`) in browser |
| `/headroom refresh` | Force immediate HTTP probe and update statusline |
| `/headroom on` \| `off` | Toggle statusline footer badge display |
| `/headroom format <compact\|normal\|detailed>` | Switch statusline badge rendering format |
| `/headroom port <number>` | Configure Headroom proxy port (default: `8787`) |
| `/headroom help` | Display interactive reference guide |

*Tip: Append `--global` to any command to persist settings across all future sessions.*

---

## Google OAuth (`/login google`)

Authenticate directly with your Google account (Antigravity or Gemini CLI clients):

```bash
/login google
```

When Headroom proxy is active, prompts are compressed by 30–60% before reaching Google Antigravity servers. If Headroom stops, requests automatically fall back to direct Google endpoints.

---

## Configuration

Stored under `.pi/headroom.json` (project-local) or `~/.pi/agent/headroom.json` (global):

```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8787,
  "pollIntervalMs": 10000,
  "format": "normal",
  "scope": "session",
  "showDollars": true,
  "showTokens": true,
  "showOffline": true,
  "prefix": "⚡",
  "routes": {
    "google": true,
    "openrouter": true,
    "opencode-go": true,
    "openai": false,
    "anthropic": false,
    "moonshotai": false
  },
  "registerRetrieveTool": true
}
```

---

## License

MIT © [mastnacek](https://github.com/mastnacek)
