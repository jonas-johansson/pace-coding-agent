# New Feature: Sessions

## Goal

It should be possible to exit the coding agent and resume a session later on, picking up
right where we left off. Sessions are persisted to local storage, bound to a project
identity, can be listed and resumed by id, support undo, and provide observability so a
user can look through the session data to see what happened after the fact.

We don't care about backwards compatibility yet because the coding agent is still in
development. The session schema carries a `version` field anyway so we can detect old data.

## Requirements

- Exit and resume a session exactly where we left off.
- List sessions and resume an existing session by id.
- Sessions are bound to a project identity.
- Session data is persisted to local storage, only after a turn ends.
- Sessions have an id.
- Undo: rewind conversation history to before the last user message. We do **not** undo
  side-effects such as file modifications.
- A session is a tree of entries. At any given time there is an active leaf
  (`activeEntryId`); the conversation history is constructed by traversing up through the
  parents from that active leaf.
- Streaming: the UI shows updated information live while the model is streaming.
- Session data is provider-agnostic, but carries opaque provider metadata (e.g. Claude
  thinking signatures, OpenAI reasoning items).
- Session entries are conceptually immutable and form an append-only timeline. While
  streaming we have partial data, so there is a mutable turn draft/buffer (see below) that
  is frozen into immutable entries at turn end.
- Observability: a user can browse session data after the fact.

## Data shape

Implemented as flat discriminated unions on a `type` field (not class inheritance), to
match the existing codebase style (`ContentBlock`, `StreamEvent`, `ProviderMessage` in
`provider.ts` are all discriminated unions).

```ts
// ---- Content blocks (persisted) ----
type TextBlock      = { type: "text"; text: string };
type ThinkingBlock  = { type: "thinking"; thinking: string }; // display-only; signature lives in providerMetadata
type ToolUseBlock   = { type: "tool_use"; id: string; name: string; input: unknown };
type ImageBlock     = { type: "image"; mediaType: string; data: string }; // base64
type ToolResultPart = { type: "text"; text: string } | ImageBlock;

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ImageBlock;

// ---- Entries (flat discriminated union) ----
type BaseEntry = {
  id: string;            // uuid
  parentId: string | null;
  timestamp: string;     // ISO 8601, e.g. 2026-05-28T13:23:21.176Z
};

type UserEntry = BaseEntry & {
  type: "user";
  content: (TextBlock | ImageBlock)[];
};

type AssistantEntry = BaseEntry & {
  type: "assistant";
  content: ContentBlock[];       // text + display-only thinking + tool_use
  provider: string;              // e.g. "anthropic", "openai"
  modelId: string;               // e.g. "claude-opus-4", "gpt-5"
  modelVariant?: string;         // e.g. "high", "max"
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;      // mirrors UsageInfo in provider.ts
  cacheCreationTokens?: number;
  cost: number;                  // USD snapshot; tokens are the source of truth
  providerMetadata?: unknown;    // OPAQUE; source of truth for replay (signatures / reasoning items)
};

type ToolResultEntry = BaseEntry & {
  type: "tool_result";
  toolUseId: string;             // links back to a ToolUseBlock.id
  content: ToolResultPart[];     // text + images
  isError?: boolean;
};

type SessionEntry = UserEntry | AssistantEntry | ToolResultEntry;

// ---- Session ----
type Session = {
  version: number;               // schema version, starts at 1
  id: string;                    // uuid
  projectKey: string;            // deterministic filesystem-safe cwd key; storage bucket
  cwd: string;                   // original cwd, for display
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  currentModelId: string;         // selected model to restore on resume
  title?: string;
  activeEntryId: string | null;  // null for a fresh, empty session
  entries: SessionEntry[];
};
```

## Storage

- Layout: `~/.agento/sessions/<projectKey>/<sessionId>.json` (reuses the existing
  `~/.agento` root already used for tool-outputs).
- One JSON file per session, rewritten in full at each turn end using temp-file + rename so
  crashes do not leave a partially written session file.
- Listing: scan the project directory and read each session's metadata (id / title /
  updatedAt). No separate index file to keep in sync. Corrupt/unreadable session files are
  reported or skipped without crashing the listing.
- The in-memory turn draft/buffer is never written to disk until it is frozen at turn end.

## LLM context generation

### Message history

1. Traverse session entries from the active entry up the tree to the root.
2. Reverse to chronological order.
3. Filter to message-bearing entries.
4. Convert to the provider's native format.

### Tool-result re-grouping (important transform)

Because `ToolResultEntry` is now a first-class entry (one entry per tool result), the
conversion step must **collapse consecutive `ToolResultEntry`s into a single provider
`UserMessage`** whose content is an array of `tool_result` blocks. This matches how
`provider.ts` represents tool results today (folded into a user message) and satisfies
providers like Anthropic that require tool results batched into one user turn. This is the
one non-trivial transform in context generation; it is easy to get wrong.

## Undo

Walk `activeEntryId` back past the most recent `UserEntry` to that user entry's parent,
and set the parent as the new `activeEntryId`. Old entries remain in the tree (immutable,
still observable / branchable). Persist the updated session. We do not undo side-effects
such as file modifications.

## Streaming model

A single user prompt can produce multiple persisted entries before the turn is complete:
`UserEntry -> AssistantEntry(tool_use) -> ToolResultEntry(s) -> AssistantEntry -> ...`.
So the mutable in-flight state is a **turn draft/buffer**, not just one assistant draft
entry.

Streaming `StreamEvent`s (`provider.ts`) mutate the current assistant draft within that
turn buffer (accumulating text, thinking, partial tool-use input). Tool execution appends
tool-result drafts to the same buffer. The UI reads the buffer live. When the full turn ends
with no further tool-use continuation, the buffer is frozen into immutable `SessionEntry`s
and the session is persisted. The turn buffer is the single sanctioned place for mutation,
which keeps "entries are immutable" honest while still supporting live streaming.

---

## Key decisions

### Project identity = exact cwd
Key sessions by the exact `process.cwd()` value. **No git detection.** There is zero git
code in the repo today, so this avoids a whole subsystem. Tradeoff: opening from a
subdirectory of a repo produces a separate session bucket. Git root detection can be
layered in later without changing the storage shape (it only changes how `projectKey` is
computed).

`projectKey` is a deterministic filesystem-safe encoding of the cwd, not a raw
slash-replacement. A hash or base64url-style encoding avoids path separator issues,
collisions such as `/a-b` vs `/a/b`, and overly long directory names.

### Flat discriminated unions, not class inheritance
The original draft used pseudo-inheritance (`Message : SessionEntry`). The implementation
uses discriminated unions on `type`, matching the existing codebase and TS narrowing.

### Tool results are first-class entries
Each tool result is its own `ToolResultEntry` with `id` / `parentId` / `timestamp` and a
`toolUseId` linking back to the originating `tool_use` block. Chosen for observability and
the tree model. Cost: context generation must re-group consecutive results into one
provider user message (see above). The current code folds results into a `UserMessage`;
this is a deliberate divergence in the persisted model.

Because active history is reconstructed by walking `activeEntryId -> parentId`, multiple
tool results from the same assistant turn must still be linked into one linear active path.
When a batch yields multiple `ToolResultEntry`s, chain them in execution/result order:
first result parent = assistant entry, second result parent = first result, etc. The next
assistant continuation points at the final tool-result entry. Otherwise only the last tool
result would be reachable from the active leaf.

### Thinking / reasoning: providerMetadata is the source of truth
`providerMetadata` (opaque, per assistant entry) is what gets replayed to the provider for
reasoning continuity (Anthropic stores raw content blocks incl. thinking + `signature`;
OpenAI stores raw output items incl. encrypted reasoning). We also keep a **display-only**
`ThinkingBlock` (thinking text, no signature) for observability and the TUI. We deliberately
do **not** store the signature in the `ThinkingBlock`, to avoid duplicating it in two places
where it could drift. Cross-provider resume already degrades gracefully in the providers
(they fall back to translating from content blocks when metadata is absent or from another
provider), losing only reasoning continuity.

### Tokens are truth; cost is a snapshot
Store raw `tokensIn` / `tokensOut` / cache token counts (source of truth). `cost` is derived
from model pricing (`MODELS` in `provider.ts`), which can change over time, so it is stored
as a snapshot, not authoritative.

After undo, context-token display should derive from the active path. Cost display should
remain actual spend across all session entries, including entries on undone branches,
because undo does not undo API calls.

### Selected model is session state
Each `AssistantEntry` stores the model that produced that response, but the currently
selected model is also session state. Persist `Session.currentModelId` so resume restores
the model the user had selected, even before the next assistant entry exists.

### Persist after turn end, one JSON file per session
Simple and matches the "persist after a turn ends" requirement. Full-file rewrite at turn
end (not an append log), written atomically with temp-file + rename. Listing scans the
directory rather than maintaining an index, to avoid a sync point that can drift.

### Session schema carries a version field
`version` starts at 1. No backwards-compat handling yet, but the field lets us detect and
reject/ignore old data.

### TUI renders a rebuildable ViewModel, not Session JSON
The persisted `Session` is the durable conversation truth, but the TUI does not render the
JSON shape directly. It renders an ephemeral, mutable `RenderBlock` / ViewModel projection
of the active session path plus the current in-memory draft.

This keeps the existing imperative streaming UI model (`addBlock`, `updateBlock`, mutable
collapse state, running tool state, spinner rendering) while preserving a clean persisted
schema. The ViewModel is disposable: after a completed turn, undo, resume, or session
switch, clearing it and rebuilding from `Session.entries` must reproduce the same
conversation display, minus ephemeral details.

Persisted session data must not contain display fields such as `collapsed`, `running`,
spinner state, viewport state, partial tool-input titles, or TUI block ids. User interaction
state such as manually expanded/collapsed reasoning or tool blocks lives only in memory and
is keyed by stable rebuildable display keys, not by numeric TUI ids. Example keys:

```ts
entry:<entryId>
entry:<assistantEntryId>:block:<index>
tool:<toolUseId>
draft:<draftId>:block:<index>
```

An `entries -> RenderBlock[]` builder is required for resume and should also be used for
undo, `/new`, and session switching. Tool display reconstruction combines a `ToolUseBlock`
with the matching `ToolResultEntry.toolUseId`: the tool-use block creates the title, the
tool-result entry supplies content and done/error state. A missing result means "running"
only for the live draft; resumed persisted history should not invent running state.

---

## Open questions
- Title generation: when/how is `Session.title` set (first user message, model summary,
  manual)?
- Branching/forking UX: the tree model supports it, but the interaction is unspecified.
- Git-based project identity as a later enhancement (see decision above).
