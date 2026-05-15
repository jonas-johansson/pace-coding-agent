# Agento Coding Agent

A barebones terminal-based coding agent.

Features:
- Interactive TUI with streaming responses
- Multi-provider: Anthropic, OpenAI, and OpenCode Zen (OpenAI-compatible)
- Tools: read, write, edit, bash, web_fetch, web_search
- MCP support: connect to external MCP servers (stdio and HTTP/SSE)
- Prompt caching and cost tracking
- Model switching at any time

## Getting started

Install dependencies:

```
npm install
```

Run:

```
tsx app.ts
```

## Configuration

### Anthropic (default)

Set your Anthropic API key:

```
export ANTHROPIC_API_KEY=sk-ant-...
```

### OpenAI

Set your OpenAI API key:

```
export OPENAI_API_KEY=sk-...
```

### OpenCode Zen (Kimi K2.6)

Set your OpenCode Zen API key:

```
export OPENCODE_ZEN_API_KEY=your-key-here
```

You can also use `OPENCODE_API_KEY` as an alternative. Optionally override the
base URL with `OPENCODE_ZEN_BASE_URL` (defaults to `https://opencode.ai/zen/v1`).

## MCP servers

Agento supports connecting to external MCP (Model Context Protocol) servers.
Both local stdio servers and remote HTTP/SSE servers are supported.

Configure servers in `~/.config/agento/mcp.json`:

```json
{
  "remote-api": {
    "type": "remote",
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer <YOUR_API_KEY>"
    },
    "enabled": true
  },
  "filesystem": {
    "type": "local",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "~"],
    "enabled": true
  }
}
```

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `type` | `"local"` or `"remote"` | Yes | Transport type |
| `command` | `string[]` | Yes (local) | Command and args to start the server |
| `environment` | `Record<string, string>` | No | Extra env vars for the local server |
| `url` | `string` | Yes (remote) | Server URL |
| `headers` | `Record<string, string>` | No | HTTP headers (e.g. `Authorization`) |
| `enabled` | `boolean` | No | Whether to connect on startup |
| `timeout` | `number` | No | Connection timeout in ms (default 5000) |

- **Remote HTTP** servers receive `Accept: application/json, text/event-stream` so
  Streamable HTTP/SSE responses are parsed correctly.
- **Local stdio** servers are spawned as subprocesses and communicate over
  line-delimited JSON-RPC on stdin/stdout.
- MCP tool names are prefixed with `mcp__<server>__` to avoid collisions.

Use `/mcp` in the TUI to list connected servers and their tools. Connection
errors are shown as error blocks in the TUI on startup.

## Models

| Model | Alias | Provider | Context |
|-------|-------|----------|---------|
| `claude-haiku-4-5` | `haiku` | Anthropic | 200K |
| `claude-sonnet-4-6` | `sonnet` | Anthropic | 1M |
| `claude-opus-4-6` | `opus` | Anthropic | 1M |
| `kimi-k2.6` | `kimi`, `k2.6` | OpenCode Zen | 262K |
| `kimi-k2.6-fw` | `kimi-fw`, `k2.6-fw` | Fireworks | 262K |
| `gpt-5.5` | `gpt5.5`, `5.5` | OpenAI | 1M |

The default model is `kimi-k2.6-fw` (Fireworks-hosted Kimi K2.6).

## Usage

### Shortcuts

- **Tab** — cycle to the next model
- **Escape** — cancel the current prompt
- **`!command`** — run a shell command directly (e.g., `!ls -la`)

### Slash commands

- `/new` — start a new conversation
- `/model` — list available models
- `/model <model-id>` — select a model (e.g., `/model kimi-k2.6`)
- `/model <alias>` — select a model by alias (e.g., `/model kimi`)
- `/mcp` — list connected MCP servers and their tools
- `/skills` — list available skills
- `/skill:<name>` — load and run a skill

## Development

Type check:

```
npm run lint
```

This runs `tsc --noEmit` and should produce no errors.
