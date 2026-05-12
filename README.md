# Agento Coding Agent

A barebones terminal-based coding agent.

Features:
- CLI
- Anthropic models
- Interactive mode
- Tools: write, read, edit, bash
- Streaming: agent messages, tool use, tool result
- Color: agent, human, tool use

## Development

Install dependencies: `npm install`

Type check: `npm run lint`

## Getting started

Run: `tsx app.ts`

Shortcuts:
- Press `Tab` to cycle to the next model

Slash commands:
- `/new` starts a new conversation
- `/model` lists available models
- `/model <model-id>` selects the model for subsequent prompts
- `/model <alias>` selects a model by alias (e.g., `haiku`, `sonnet`, `opus`)
