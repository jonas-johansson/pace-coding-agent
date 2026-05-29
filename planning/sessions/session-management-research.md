# Session Management in Pi, Claude Code, and OpenCode

Date: 2026-05-28

This report summarizes how three terminal coding agents handle conversation/session persistence, loading/resuming, replay/branching, UI affordances, provider/model switching, shell escapes, and message/tool representation.

## Executive summary

| Area | Pi | Claude Code | OpenCode |
|---|---|---|---|
| Persistence unit | JSONL session file with a tree of entries | Local JSONL transcript per project/session | SQLite-backed session/project data with normalized session/message/part tables |
| Save behavior | Auto-saves to `~/.pi/agent/sessions/` by working directory | Continuously saves to `~/.claude/projects/<project>/<session-id>.jsonl` | Continuously saves messages, token/cost metadata, file history, and session metadata |
| Resume/load | `pi -c`, `pi -r`, `--session <path\|id>`, `/resume` | `claude --continue`, `--resume`, `--resume <id\|name>`, `/resume`, `--from-pr` | `opencode -c`, `--session`, `/sessions` (`/resume`, `/continue`), `opencode session list` |
| Branching/replay | Strongest native tree model: `/tree` jumps to any entry and continues; `/fork` and `/clone` create new files | `/branch` / `--fork-session`; `/rewind` checkpoint-based rollback/summarization | `--fork` when continuing/resuming; compaction creates child sessions; undo/redo uses Git for file changes |
| Session UI | TUI with message stream, editor, footer; `/resume` picker; `/tree` visual branch navigator | `/resume` picker with grouping/preview/search; named sessions; branch grouping | TUI session list, Ctrl+A provider/model dialog in current keybind docs, `/sessions`, `/export`, `/undo`, `/redo` |
| Model/provider switching | Multi-provider; `/model`, Ctrl+P scoped cycling, `--provider`, `--model`, `--models`; model changes are stored as entries | Anthropic/Claude model selection; `/model`, `--model`, `ANTHROPIC_MODEL`, settings; resumed sessions keep saved model | 75+ providers via AI SDK/Models.dev; `/connect`, `/models`, `--model provider/model`, config `model`; model/provider stored in session/message metadata |
| Shell escape | `!command` runs and sends output to model; `!!command` runs without sending output | Built-in `Bash` tool; current public issue references `! <command>` shell escape behavior, but official docs emphasize Bash tool behavior and permissions | `!command` runs shell command and adds output as a tool result |
| Message schema | Publicly documented: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary` | Official docs disclose transcript JSONL lines for message/tool/metadata entries but not full stable schema | Public source schema: messages have `role: user|assistant`; parts include `text`, `reasoning`, `tool-invocation`, `file`, etc.; tool invocation states `call`, `partial-call`, `result` |

## 1. Pi

### 1.1 Storage and lifecycle

Pi treats sessions as first-class, local, editable artifacts. Conversations auto-save under:

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

The path bucket is derived from the working directory by replacing `/` with `-`. Pi documents that sessions are JSONL files and that each line is a JSON object with a `type` field. The first line is a `session` header; subsequent entries form a tree through `id` / `parentId` links. Existing legacy sessions are auto-migrated on load to the current format.

Important CLI/session flags:

```bash
pi -c                  # Continue most recent session
pi -r                  # Browse and select a session
pi --no-session        # Ephemeral mode; do not save
pi --session <path|id> # Use a specific session file or session ID
pi --fork <path|id>    # Fork a session into a new session file
pi --session-dir <dir> # Custom session storage directory
```

### 1.2 Session UI

Pi's interactive UI is structured around four regions:

- startup header: shortcuts, context files, prompt templates, skills, extensions;
- messages: user messages, assistant responses, tool calls/results, notifications, errors, extension UI;
- editor: input area; border indicates thinking level;
- footer: working directory, session name, token/cache usage, cost, context usage, current model.

Relevant slash commands:

| Command | Purpose |
|---|---|
| `/resume` | Browse/select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set display name |
| `/session` | Show session file, ID, messages, tokens, cost |
| `/tree` | Navigate the current session tree |
| `/fork` | New session from a previous user message |
| `/clone` | Duplicate current active branch into a new session |
| `/compact [prompt]` | Summarize older context |
| `/export [file]` | Export session to HTML |
| `/share` | Upload private GitHub gist with shareable HTML link |

The `/resume` picker supports typing search, Ctrl+P path display toggle, Ctrl+S sort toggle, Ctrl+N named-session filter, Ctrl+R rename, and Ctrl+D delete. If available, deletion uses the `trash` CLI.

### 1.3 Branching, replay, and context rebuilding

Pi has the most explicit replay/branching model of the three tools:

- Every entry has an `id` and `parentId`.
- The active position is a leaf in the tree.
- `/tree` can jump to any prior point and continue in the same file.
- Selecting a previous user/custom message moves the leaf to the selected message's parent, places the text back in the editor, and lets the user edit/resubmit, creating a new branch.
- Selecting an assistant/tool/compaction entry moves the leaf to that entry and continues from there.
- `/fork` and `/clone` create separate session files.
- When switching branches via `/tree`, Pi can summarize the abandoned branch and attach a branch summary at the new position.

Context construction is deterministic: Pi walks from the active leaf back to the root, extracts model/thinking settings, handles compaction entries by emitting summaries plus kept messages, and converts branch/custom message entries into LLM context.

### 1.4 Message and entry schema

Pi documents the session file format in detail.

Core message roles:

- `user`: content string or text/image blocks.
- `assistant`: text/thinking/tool-call blocks plus `api`, `provider`, `model`, `usage`, `stopReason`, optional error.
- `toolResult`: `toolCallId`, `toolName`, content blocks, `isError`, optional tool-specific details.

Pi-specific message roles:

- `bashExecution`: stores command, output, exit code, cancellation/truncation flags, optional full output path, and `excludeFromContext` for hidden `!!` commands.
- `custom`: extension-defined messages, optionally displayed in the TUI.
- `branchSummary`: summary for a branch left behind.
- `compactionSummary`: summary produced during compaction.

Entry types include:

- `session` header;
- `message` entries wrapping an `AgentMessage`;
- `model_change` entries for mid-session model switching;
- `thinking_level_change` entries;
- `compaction` entries;
- `branch_summary` entries;
- `custom` extension state entries that do not enter LLM context;
- `custom_message` extension context entries;
- `label` bookmarks;
- `session_info` name/display metadata.

This is a strong design for replay because it separates tree topology, messages, model changes, compaction boundaries, branch summaries, and extension state.

### 1.5 Provider/model switching

Pi is multi-provider. The CLI exposes:

```bash
--provider <name>       # anthropic, openai, google, etc.
--model <pattern>       # supports provider/id and :thinking suffix
--api-key <key>
--thinking <level>      # off, minimal, low, medium, high, xhigh
--models <patterns>     # comma-separated scoped models for Ctrl+P cycling
--list-models [search]
```

Interactive commands include `/model` and `/scoped-models`. Because Pi stores `model_change` and `thinking_level_change` entries in the session tree, replay/context reconstruction can recover which model/thinking level applied at a point in the conversation.

### 1.6 Shell commands

Pi supports two editor prefixes:

- `!command`: run shell command and send output to the model.
- `!!command`: run shell command without sending output to the model.

The `!!` behavior is represented in persisted session data by `BashExecutionMessage.excludeFromContext: true`.

Built-in tools include `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. Pi's own docs state it intentionally avoids built-in MCP, sub-agents, permission popups, plan mode, to-dos, and background bash; those are expected to be implemented through extensions/packages or external tools.

## 2. Claude Code

### 2.1 Storage and lifecycle

Claude Code defines a session as a saved conversation tied to a project directory. Sessions are stored locally and continuously saved. Official documentation places transcripts at:

```text
~/.claude/projects/<project>/<session-id>.jsonl
```

`<project>` is derived from the working directory path. Each transcript line is a JSON object representing a message, tool use, or metadata entry. `CLAUDE_CONFIG_DIR` changes the base directory. Local files are removed after 30 days by default, configurable through `cleanupPeriodDays`. Transcript writes can be suppressed with `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, and non-interactive mode supports `--no-session-persistence`.

Resume/load entry points:

| Command | Behavior |
|---|---|
| `claude --continue` / `claude -c` | Resume the most recent session in current directory |
| `claude --resume` / `claude -r` | Open session picker |
| `claude --resume <name-or-id>` | Resume by name or ID |
| `claude --from-pr <number>` | Resume session linked to a pull request |
| `/resume` | Switch to a different conversation inside an active session |

Sessions created via `claude -p` or the Agent SDK do not appear in the interactive picker, but can be resumed by session ID.

### 2.2 Session picker and UI

The `/resume` picker is more sophisticated than a simple list:

- shows current worktree sessions by default;
- Ctrl+W widens to all worktrees of the repository;
- Ctrl+A widens to all projects on the machine;
- Ctrl+B filters to current git branch;
- `/` or typing enters search;
- Space / Ctrl+V previews session content;
- Ctrl+R renames the highlighted session;
- grouped forked sessions can be expanded/collapsed with arrows.

Rows show name if set, otherwise summary or first prompt, time since activity, message count, and git branch. Selecting an unrelated project copies a `cd` plus resume command rather than resuming in-place.

Session naming is supported at startup (`claude -n auth-refactor`), during a session (`/rename auth-refactor`), and in the picker (Ctrl+R).

### 2.3 Branching, rewind, and context management

Claude Code supports separate-branch sessions rather than Pi-style in-file tree navigation:

- `/branch [name]` creates a branch of the current conversation and switches into it; alias `/fork` unless fork-subagent behavior is enabled.
- CLI: `claude --continue --fork-session` or `--resume ... --fork-session`.
- The original remains unchanged and available through `/resume`.
- Permissions approved only for the original session do not carry over to the branch.
- If the same session is resumed in two terminals without forking, messages from both terminals interleave into one transcript.
- `/rewind` can roll conversation and/or code back to a checkpoint, or summarize from a selected message.

Context-management commands:

| Command | Behavior |
|---|---|
| `/clear [name]` | Start a new conversation with empty context; previous conversation remains resumable |
| `/compact [instructions]` | Summarize current conversation to free context |
| `/context [all]` | Visualize context usage and optimization suggestions |
| `/export [filename]` | Export current conversation as plain text |

### 2.4 Message/tool representation

Official docs disclose the storage location and JSONL nature but do not publish a stable complete schema comparable to Pi's session-format page. The official statement is that each JSONL line is a JSON object for a message, tool use, or metadata entry.

Tooling is explicit and permissioned. The tools reference lists `Bash` as a built-in tool that executes shell commands and requires permission. Other tools include subagents (`Agent`), file writes/edits, reads, search, web search/fetch, notebooks, etc. Exports render messages and tool outputs as readable text.

Practical implication: a robust Claude Code transcript parser should be defensive and version-tolerant. Unlike Pi, where the public docs define `AgentMessage` and entry unions, Claude Code's transcript format should be treated as an implementation detail unless using an official SDK/API surface.

### 2.5 Provider/model switching

Claude Code's model configuration is centered on Claude models and provider-specific deployment names/aliases. It supports:

- `/model <alias|name>` during a session;
- `/model` picker, with confirmation when the conversation already has output because the next response re-reads full history without cached context;
- `claude --model <alias|name>` at startup;
- `ANTHROPIC_MODEL=<alias|name>` environment variable;
- persistent settings field `model`;
- managed restrictions through `availableModels`.

As of the referenced docs, `/model` saves the choice as the default for new sessions when pressing Enter or when using `/model <name>` directly; pressing `s` switches only for the current session. Resumed sessions keep the model they were using when the transcript was saved, unless that model has been retired.

### 2.6 Shell commands

Official documentation emphasizes the `Bash` tool rather than a stable public `!` shell-escape reference. The Bash tool behavior is:

- each command runs in a separate process;
- `cd` in the main session carries over within allowed project/additional directories;
- environment variables from `export` do not persist across commands;
- aliases/functions from shell startup files are captured at session start;
- default timeout is two minutes, with configurable limits;
- default output limit is 30,000 characters; larger output is saved to a file in the session directory with a preview;
- long-running processes can be run in the background with `run_in_background: true` and managed through `/tasks`.

There is public evidence in the Anthropic `claude-code` GitHub issue tracker that recent versions support a `! <command>` shell escape, with a required space after `!`, and that `/bash` may be used as a workaround in some terminal environments. However, because the current official docs above do not foreground this as the primary interface, treat `!` behavior as version/terminal-sensitive when designing compatibility.

## 3. OpenCode

### 3.1 Storage and lifecycle

OpenCode manages conversations as sessions that include messages, token usage, cost, file changes, tool calls/results, title, timestamps, and parent-session metadata. Its session lifecycle includes:

1. creation at startup, Ctrl+N/new conversation, auto-compact, or spawned task session;
2. active conversation appends messages, tracks tokens/cost, records file changes, generates title after first exchange;
3. optional auto-compaction near context limit;
4. persistence to storage.

The older Mintlify session-management docs describe SQLite storage at `$HOME/.opencode/opencode.db`; the current OpenCode docs say session and application data is stored under:

```text
~/.local/share/opencode/
```

with project-specific session/message data under `project/<project-slug>/storage/` for Git repositories and `project/global/storage/` otherwise. Current source shows a channel database path under the global data directory (`opencode.db` or channel-specific DB), with WAL mode, migrations, foreign keys, and Drizzle SQLite schema.

TUI/CLI load controls:

```bash
opencode                  # start TUI
opencode [project]        # TUI for project
opencode -c               # continue last session
opencode --session <id>   # continue session by ID
opencode --fork           # fork when continuing/resuming
opencode run --continue ...
opencode run --session <id> ...
```

Session management CLI:

```bash
opencode session list --format table|json
opencode session delete <sessionID>
opencode export [sessionID] --sanitize
opencode import <file-or-share-url>
opencode stats --models --project ...
```

### 3.2 Session UI

OpenCode's TUI supports:

- file references via `@` fuzzy search;
- shell commands via `!`;
- slash commands;
- leader-key shortcuts, defaulting to Ctrl+X in docs;
- external editor for composing messages;
- Markdown export;
- undo/redo that also reverts/restores file changes using Git.

Relevant slash commands:

| Command | Behavior |
|---|---|
| `/connect` | Add provider/API key |
| `/compact` (`/summarize`) | Compact current session |
| `/details` | Toggle tool execution details |
| `/editor` | Compose in `$EDITOR` |
| `/export` | Export current conversation to Markdown and open in editor |
| `/models` | List/select models |
| `/new` (`/clear`) | Start a new session |
| `/sessions` (`/resume`, `/continue`) | List/switch sessions |
| `/share` / `/unshare` | Share/unshare current session |
| `/thinking` | Toggle display of reasoning blocks |
| `/undo` / `/redo` | Remove/restore recent message and associated file changes |

Current keybind docs expose `session_list`, `session_fork`, `session_rename`, `session_delete`, `session_compact`, `model_provider_list`, `model_list`, recent/favorite model cycling, agent cycling, and variant cycling.

### 3.3 Compaction and replay/branching

OpenCode uses compaction as a major long-session mechanism:

- token usage is monitored;
- at about 95% of model context window, auto-compact can trigger;
- AI generates a summary preserving decisions, technical context, current state, and background;
- a new session is spawned with `parent_id` / parent session metadata;
- original session is preserved;
- manual compaction is available through `/compact`.

OpenCode supports forking via CLI flags when continuing/resuming. It also supports import/export of JSON session data, sharing, and undo/redo of message/file state. It does not document Pi-style in-file arbitrary tree navigation in the referenced docs; branching is closer to child-session/fork semantics.

### 3.4 SQLite/source schema

Current OpenCode source defines session-related SQLite tables. Key fields from `SessionTable` include:

- `id`, `project_id`, `workspace_id`, `parent_id`;
- `slug`, `directory`, `path`, `title`, `version`, `share_url`;
- summary file/diff counts;
- aggregate `cost`, token counters (`tokens_input`, `tokens_output`, `tokens_reasoning`, cache read/write);
- `revert` data for rollback;
- `permission`, `agent`;
- `model` JSON with `{ id, providerID, variant? }`;
- timestamps plus compact/archive times.

Messages are normalized:

- `MessageTable`: `id`, `session_id`, timestamps, JSON `data`.
- `PartTable`: `id`, `message_id`, `session_id`, timestamps, JSON `data`.
- `TodoTable`: per-session todo state.
- `SessionMessageTable`: typed session messages with JSON data.

OpenCode message schema in current source:

- message `role` is `user` or `assistant`;
- `parts` can be `text`, `reasoning`, `tool-invocation`, `source-url`, `file`, `step-start`;
- tool invocation states are `call`, `partial-call`, and `result`;
- assistant metadata stores system prompt strings, `modelID`, `providerID`, cwd/root path, cost, summary flag, and token counters including cache read/write;
- metadata includes per-tool timing/title/snapshot data and optional errors.

This design favors efficient querying and UI rendering over human-editable transcript files.

### 3.5 Provider/model switching

OpenCode is broad-provider by design. It uses AI SDK and Models.dev and documents support for 75+ providers plus local models.

Provider/model flow:

- `/connect` adds a provider and credentials.
- `opencode auth login` configures API keys in `~/.local/share/opencode/auth.json` and loads environment or `.env` keys at startup.
- `/models` lists/selects available models.
- `--model provider/model` selects a model for TUI or `run`.
- config `model` sets default, e.g. `"anthropic/claude-sonnet-4-5"`.
- config can customize provider model options.
- variants/reasoning can be cycled, with `ctrl+t` documented for model variants.

OpenCode persists current model selection at the session level and provider/model/cost/tokens at assistant-message metadata level.

### 3.6 Shell commands

OpenCode has an explicit TUI shell escape:

```text
!ls -la
```

The command output is added to the conversation as a tool result. This is very similar to Pi's `!` path, except the referenced docs do not mention Pi's hidden `!!` equivalent.

## 4. Cross-agent design comparison

### 4.1 Persistence tradeoffs

| Design | Strengths | Weaknesses |
|---|---|---|
| Pi JSONL tree | Human-readable, append-friendly, easy to copy/share, explicit branch topology, excellent replay semantics | Requires custom indexing/listing for scale; concurrent writers can be tricky; querying across sessions is less efficient than DB |
| Claude JSONL transcript | Simple local transcript, easy to export/inspect, per-project isolation | Full schema is not officially stable; branch topology is session-level rather than in-file tree; cleanup retention may surprise tooling |
| OpenCode SQLite | Fast listing/querying/stats, normalized messages/parts, robust transactions/migrations, good for multi-UI/server use | Less human-editable; backup/sync/export require tooling; schema migrations add compatibility surface |

### 4.2 Branch/replay models

- **Pi**: best native replay model. The session file is a tree. Replaying context is a graph traversal from leaf to root. Model/thinking changes and compactions are entries in that tree.
- **Claude Code**: branch is a new session. Rewind/checkpointing handles rollback. Good UX for named branches and branch groups in picker, but transcript format is less documented.
- **OpenCode**: child/fork sessions and compaction sessions. Strong storage for metadata and file state, but docs emphasize switching/compaction over arbitrary historical tree replay.

### 4.3 Message representation patterns

Common patterns:

1. User and assistant turns are durable objects.
2. Tool calls/results are persisted, not just rendered.
3. Token/cost accounting is stored near assistant/model metadata.
4. Context-compaction boundaries are first-class enough to preserve continuity.
5. File-change state matters for coding agents, especially for undo/redo or rollback.

Divergences:

- Pi separates `toolResult` and `bashExecution` as explicit message roles and stores extension entries.
- OpenCode uses assistant/user messages with typed parts, including `tool-invocation` parts whose state progresses from call to result.
- Claude Code exposes a transcript but not a full stable schema in public docs; use official commands/SDK where possible.

### 4.4 Model/provider state

Good patterns observed:

- **Persist active model with the session**: Claude Code resumed sessions keep their saved model; Pi stores `model_change`; OpenCode stores session model JSON and assistant metadata.
- **Support session-only vs default switching**: Claude Code differentiates session-only picker key from default-saving switch; Pi has scoped model cycling; OpenCode config sets default while CLI overrides per run.
- **Record provider/model on assistant output**: Pi and OpenCode both store provider/model on assistant messages, enabling cost attribution and replay analysis.

### 4.5 Shell escape behavior

| Agent | Shell input | Context behavior | Persistence signal |
|---|---|---|---|
| Pi | `!command` / `!!command` | `!` sends output to model; `!!` excludes output | `bashExecution`, `excludeFromContext` |
| Claude Code | Bash tool; public issue references `! <command>` | Bash tool results enter transcript/context; output may be truncated and full output saved in session dir | JSONL message/tool/metadata entries; exact schema not public |
| OpenCode | `!command` | output added as tool result | message parts/tool invocation result in DB |

## 5. Recommendations for Agento-style session management

If building or improving a coding agent, combine the best ideas:

1. **Use an append-only event log as source of truth.** Pi's JSONL tree is excellent for auditability and replay. If SQLite is needed for speed, treat it as an index/cache or store immutable event rows.
2. **Make branch topology explicit.** Store `id`, `parentId`, active leaf, branch names/labels, and branch summaries. This makes `/tree`, replay, fork, and rewind clean.
3. **Persist model/provider changes as timeline events.** Also stamp assistant messages with provider/model/variant, token usage, and cost.
4. **Represent tool calls as structured records.** Include call ID, tool name, args, result, error flag, timing, truncation, full-output path, and whether it should enter model context.
5. **Distinguish display history from model context.** Pi's `excludeFromContext` for `!!` commands and `custom` vs `custom_message` split are useful patterns.
6. **Support both resumable and ephemeral modes.** Provide `--no-session` / `--no-session-persistence` for privacy-sensitive tasks.
7. **Build a session picker with scope controls.** At minimum: current project, all worktrees, all projects, named-session filter, search, preview, rename, delete.
8. **Implement compaction as an event, not destructive mutation.** Store summary, first kept entry/message, tokens before, and generated metadata. Original messages should remain recoverable unless user purges.
9. **Expose export/import.** Human-readable Markdown/HTML plus machine-readable JSON is ideal. Sanitized export is important for sharing.
10. **Be explicit with shell escapes.** Use `!` for visible/context-included output and consider `!!` for hidden output. Persist that decision so replay/context construction is deterministic.
11. **Have a data retention/purge story.** Claude Code's documented cleanup period and project purge command are useful precedents.
12. **Keep schema versioned.** Pi's session header `version` and auto-migration path are a good model.

## 6. Source notes

The sources below were consulted on 2026-05-28. Some tools evolve quickly; always verify against the installed version.

### Pi

- Pi usage docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md
- Pi sessions docs: https://pi.dev/docs/latest/sessions
- Pi session format docs: https://pi.dev/docs/latest/session-format
- Pi providers docs: https://pi.dev/docs/latest/providers

### Claude Code

- Manage sessions: https://code.claude.com/docs/en/sessions
- Commands: https://code.claude.com/docs/en/commands.md
- CLI reference: https://code.claude.com/docs/en/cli-reference.md
- Model configuration: https://code.claude.com/docs/en/model-config.md
- Tools reference / Bash behavior: https://code.claude.com/docs/en/tools-reference.md
- Public issue mentioning `! <command>` shell escape behavior: https://github.com/anthropics/claude-code/issues/36966

### OpenCode

- TUI docs: https://opencode.ai/docs/tui/
- CLI docs: https://opencode.ai/docs/cli/
- Models docs: https://opencode.ai/docs/models/
- Providers docs: https://opencode.ai/docs/providers/
- Config docs: https://opencode.ai/docs/config/
- Troubleshooting/storage docs: https://opencode.ai/docs/troubleshooting/
- Session management docs: https://opencode-ai-opencode.mintlify.app/features/session-management
- Current source schema: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.sql.ts
- Current message schema source: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message.ts
