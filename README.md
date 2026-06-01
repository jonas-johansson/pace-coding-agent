# Pace

**A really nice terminal-based coding agent.**

![alt text](docs/screenshot-1.png)

![alt text](docs/screenshot-2.png)

## Quick start

```
npm install
tsx src/app.ts
```

Set at least one API key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...    # anthropic/* models
export OPENAI_API_KEY=sk-...           # openai/* models
export OPENCODE_ZEN_API_KEY=...        # opencode/* models via OpenCode Zen
export FIREWORKS_API_KEY=...           # fireworks/* models
```

## Features

- Interactive TUI
- Sessions
- Undo
- Bash, web search, web fetch, read, write, edit
- Paste image for vision models
- MCP
- Skills
- AGENTS.md
- Mouse support (scroll, select to copy)
- Slash commands
- Tables
- Token usage and cost in your currency

## Models

Switch models at any time with **Tab** or `/model <model-id>`. Model IDs use the full `provider/model` string.

| Model ID |
|---|
| `anthropic/claude-haiku-4-5` |
| `anthropic/claude-sonnet-4-6` |
| `anthropic/claude-opus-4-6` |
| `anthropic/claude-opus-4-7` |
| `anthropic/claude-opus-4-8` |
| `opencode/claude-haiku-4-5` |
| `opencode/claude-sonnet-4-6` |
| `opencode/claude-opus-4-6` |
| `opencode/claude-opus-4-7` |
| `opencode/claude-opus-4-8` |
| `opencode/kimi-k2.6` |
| `opencode/gpt-5.5` |
| `fireworks/kimi-k2.6` |
| `openai/gpt-5.5` |

## Keyboard shortcuts

| Key | Action |
|---|---|
| **Tab** / **Shift+Tab** | Cycle models forward / backward |
| **Escape** | Cancel the running prompt |
| **Ctrl+V** | Paste image from clipboard |
| **Ctrl+C** | Clear input, or press twice to exit |
| **Shift+Enter** | Insert a newline |
| **`!command`** | Run a shell command directly (e.g. `!ls -la`) |

## Slash commands

| Command | What it does |
|---|---|
| `/new` | Start a fresh conversation |
| `/model <model-id>` | Switch model (or list models without args) |
| `/sessions` | List saved sessions for this project |
| `/resume <id>` | Resume a saved session |
| `/undo` | Rewind to before the last user message |
| `/skills` | List available skills |
| `/skill:<name>` | Run a skill |
| `/mcp` | List connected MCP servers and tools |

## File and image references

- **`@filename`** — mention a project file (autocomplete with Tab)
- **`@image(./path.png)`** — attach an image inline
- Bare image paths like `./screenshot.png` are also auto-detected

## Configuration

Pace reads global configuration from `~/.config/pace/config.json`.

Choose the startup model and the models that **Tab** / **Shift+Tab** cycle through with full `provider/model` IDs:

```json
{
  "defaultModel": "opencode/gpt-5.5",
  "cycleModels": [
    "opencode/gpt-5.5",
    "opencode/kimi-k2.6",
    "openai/gpt-5.5"
  ]
}
```

To display estimated costs in a specific currency, configure a USD conversion rate, display format, and how many fraction digits:

```json
{
  "cost": {
    "conversionRate": 10,
    "format": "{amount} kr",
    "fractionDigits": 1
  }
}
```

If `fractionDigits` is omitted, Pace uses dynamic precision similar to the default USD display.

## MCP servers

Configure external tool servers in `~/.config/pace/mcp.json`:

```json
{
  "filesystem": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "~"],
    "enabled": true
  },
  "remote-api": {
    "type": "remote",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer <token>" },
    "enabled": true
  }
}
```

MCP tools show up as `mcp__<server>__<tool>` and the agent uses them automatically when relevant.

## Development

Type check:

```
npm run lint
```
