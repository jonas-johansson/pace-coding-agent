# Agento Coding Agent

A barebones terminal-based coding agent.

Features:
- Interactive TUI with streaming responses
- Multi-provider: Anthropic, OpenAI, and OpenCode Zen (OpenAI-compatible)
- Tools: read, write, edit, bash, web_fetch, web_search
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

## Models

| Model | Alias | Provider | Context |
|-------|-------|----------|---------|
| `claude-haiku-4-5` | `haiku` | Anthropic | 200K |
| `claude-sonnet-4-6` | `sonnet` | Anthropic | 1M |
| `claude-opus-4-6` | `opus` | Anthropic | 1M |
| `kimi-k2.6` | `kimi`, `k2.6` | OpenCode Zen | 262K |
| `gpt-5.5` | `gpt5.5`, `5.5` | OpenAI | 1M |

The default model is `claude-haiku-4-5`.

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

## Development

Type check:

```
npm run lint
```

This runs `tsc --noEmit` and should produce no errors.
