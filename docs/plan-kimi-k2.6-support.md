# Plan: Add Kimi K2.6 Support via OpenCode Zen

## Context

The codebase is currently **Anthropic-only** — it uses the `@anthropic-ai/sdk` for all LLM interactions. The API client, message format, tool definitions, streaming protocol, and cost tracking are all tightly coupled to the Anthropic Messages API.

**Kimi K2.6** is Moonshot AI's latest model (1T MoE, 32B active parameters) with 262K context, multimodal input, strong coding/agent capabilities, and tool calling support. It's available on **OpenCode Zen** at `https://opencode.ai/zen/v1/chat/completions` using the **OpenAI-compatible Chat Completions** format — a fundamentally different API from Anthropic's Messages API.

This means we can't simply "add another model string" to `AVAILABLE_MODELS`. We need a **provider abstraction** to support two different API protocols side by side.

---

## Scope of Changes

### 1. Introduce a Provider Abstraction Layer

**Problem:** `app.ts` directly calls `ant.messages.stream(...)` with Anthropic-specific types everywhere — messages, content blocks, tool definitions, streaming events, usage/pricing.

**Solution:** Create a `provider.ts` module that defines a common interface both providers implement.

```ts
// provider.ts

type ProviderMessage = { role: "user" | "assistant"; content: ContentBlock[] };
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface StreamEvent {
  type: "text_delta" | "tool_use_start" | "tool_input_delta" | "content_block_stop" | "message_done";
  // ... normalized fields
}

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ProviderResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
  usage: UsageInfo;
}

interface Provider {
  stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncIterable<StreamEvent> & { finalMessage(): Promise<ProviderResponse> };
}
```

Create two implementations:
- `AnthropicProvider` — wraps the existing `@anthropic-ai/sdk` logic (mostly a refactor of what's in `app.ts` today)
- `OpenCodeZenProvider` — uses `fetch()` to call the OpenAI-compatible chat completions endpoint with SSE streaming

### 2. Add the OpenCode Zen Provider (OpenAI-Compatible Chat Completions)

**New file: `providers/opencode-zen.ts`** (or a more general `providers/openai-compat.ts`)

Key implementation details:
- **Endpoint:** `https://opencode.ai/zen/v1/chat/completions`
- **Auth:** Bearer token via `OPENCODE_ZEN_API_KEY` environment variable (or similar)
- **Model ID:** `kimi-k2.6`
- **Request format:** Standard OpenAI Chat Completions with `tools` array (function type)
- **Streaming:** SSE (`stream: true`) with `data: {...}` lines containing `delta` objects
- **Tool calling:** Uses `tool_calls` array in assistant messages, `role: "tool"` for results
- **No native prompt caching** — Kimi K2.6 via OpenCode Zen supports cached reads ($0.16/MTok) but no explicit cache_control like Anthropic

**Translation layer needed for:**

| Concept | Anthropic Format | OpenAI-Compatible Format |
|---------|-----------------|------------------------|
| System prompt | `system` param (array of blocks with `cache_control`) | `messages[0]` with `role: "system"` |
| Tool definitions | `tools` with `input_schema` | `tools` with `type: "function"`, `function.parameters` |
| Tool use in response | `content[].type === "tool_use"` with `id`, `name`, `input` | `message.tool_calls[].function` with `id`, `name`, `arguments` (JSON string) |
| Tool results | `role: "user"`, `content: [{ type: "tool_result", tool_use_id, content }]` | `role: "tool"`, `tool_call_id`, `content` (string) |
| Streaming events | `content_block_start`, `content_block_delta`, `content_block_stop` | `chat.completion.chunk` with `delta.content` or `delta.tool_calls` |
| Stop reason | `stop_reason: "tool_use"` or `"end_turn"` | `finish_reason: "tool_calls"` or `"stop"` |
| Usage | `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` | `usage.prompt_tokens`, `usage.completion_tokens` (cache info may not be available) |

### 3. Update the Model Registry (`app.ts`)

Expand the model configuration to include provider information:

```ts
type ModelConfig = {
  id: string;
  provider: "anthropic" | "opencode-zen";
  contextWindow: number;
  pricing: {
    inputPerMTok: number;
    cacheWritePerMTok: number;
    cacheReadPerMTok: number;
    outputPerMTok: number;
  };
  maxOutputTokens?: number;
};

const MODELS: Record<string, ModelConfig> = {
  "claude-haiku-4-5":  { provider: "anthropic", contextWindow: 200_000, pricing: { ... } },
  "claude-sonnet-4-6": { provider: "anthropic", contextWindow: 1_000_000, pricing: { ... } },
  "claude-opus-4-6":   { provider: "anthropic", contextWindow: 1_000_000, pricing: { ... } },
  "kimi-k2.6":         { provider: "opencode-zen", contextWindow: 262_144, pricing: {
    inputPerMTok: 0.95,
    cacheWritePerMTok: 0,      // No explicit cache write
    cacheReadPerMTok: 0.16,
    outputPerMTok: 4.00,
  }},
};

const MODEL_ALIASES: Record<string, string> = {
  "haiku": "claude-haiku-4-5",
  "sonnet": "claude-sonnet-4-6",
  "opus": "claude-opus-4-6",
  "kimi": "kimi-k2.6",
  "k2.6": "kimi-k2.6",
};
```

### 4. Update the Tool Definition Export (`tool.ts`)

Currently `tool.ts` exports `toolsTransformedToAnthropicStyle` — a single Anthropic-specific format. We need to also produce OpenAI-compatible tool definitions:

```ts
// OpenAI-compatible format
export const toolsTransformedToOpenAIStyle = tools.map(t => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.inputSchema),
  },
}));
```

The provider abstraction can choose which format to use internally.

### 5. Refactor the Streaming Loop (`app.ts`)

The `prompt()` function's streaming loop needs to work against the provider abstraction rather than Anthropic SDK types directly. The main changes:

- Replace `ant.messages.stream(...)` with `provider.stream(...)`
- Replace Anthropic-specific event type checks (`content_block_start`, `content_block_delta`, etc.) with normalized events
- Replace `response.content` (Anthropic blocks) with normalized content blocks
- Replace `Anthropic.ToolUseBlock` type checks with provider-agnostic tool use detection

The **TUI interaction** (addBlock, updateBlock, tool visualization) should remain unchanged — the provider layer normalizes everything before it reaches the UI.

### 6. Conversation State Management

**Critical difference:** Anthropic and OpenAI use different message formats. We have two options:

**Option A (Recommended): Dual message format**
- Keep the conversation in a provider-agnostic internal format
- Serialize to the target provider's format on each API call
- This naturally supports model switching mid-conversation (though cross-provider switching mid-conversation could lose nuance)

**Option B: Lock provider per conversation**
- When a conversation starts, lock it to the current provider
- Switching models to a different provider requires `/new`
- Simpler but more limiting

Recommend **Option A** with a warning/reset when switching between providers mid-conversation.

### 7. Authentication / Configuration

Add support for the OpenCode Zen API key:

- Read from `OPENCODE_ZEN_API_KEY` environment variable (or `OPENCODE_API_KEY`)
- The Anthropic SDK already reads `ANTHROPIC_API_KEY` automatically
- Show a helpful error if the user tries to use `kimi-k2.6` without the key set

### 8. SSE Streaming Client

The Anthropic SDK handles SSE streaming internally. For OpenCode Zen, we need a lightweight SSE parser since we're using raw `fetch()`. Implementation options:

- **Minimal custom SSE parser** — parse `data:` lines from a ReadableStream (< 50 lines of code)
- **Use a library** like `eventsource-parser` — adds a dependency but battle-tested

Recommend the minimal custom approach to keep dependencies small, since the OpenAI SSE format is simple.

### 9. Update `tsconfig.json`

If we add new files (e.g., `provider.ts`, `providers/anthropic.ts`, `providers/opencode-zen.ts`), add them to the `include` array.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `provider.ts` | **Create** | Provider interface + types + factory function |
| `providers/anthropic.ts` | **Create** | Anthropic provider implementation (extracted from `app.ts`) |
| `providers/opencode-zen.ts` | **Create** | OpenCode Zen (OpenAI-compatible) provider implementation |
| `app.ts` | **Modify** | Replace direct Anthropic SDK usage with provider abstraction; expand model registry |
| `tool.ts` | **Modify** | Add OpenAI-compatible tool format export |
| `tsconfig.json` | **Modify** | Add new files to `include` |
| `package.json` | **Possibly modify** | May not need new deps if we hand-roll SSE parsing |

---

## Implementation Order

1. **Define the provider interface** (`provider.ts`) — types and contracts
2. **Extract Anthropic provider** (`providers/anthropic.ts`) — refactor existing code, ensure nothing breaks
3. **Run `npm run lint`** — verify the refactor compiles clean
4. **Add OpenAI-compatible tool format** (`tool.ts`)
5. **Implement OpenCode Zen provider** (`providers/opencode-zen.ts`) — SSE streaming, tool call translation, usage extraction
6. **Wire up the provider factory in `app.ts`** — model registry selects provider, `prompt()` uses abstraction
7. **Run `npm run lint`** — verify everything compiles
8. **Manual testing** — test with both Anthropic models and Kimi K2.6

---

## Key Risks & Considerations

1. **Streaming fidelity:** OpenAI-compatible streaming sends tool call arguments as incremental `delta.tool_calls[i].function.arguments` chunks. We need to accumulate these per-tool-call index, similar to how we accumulate `input_json_delta` for Anthropic.

2. **Multiple tool calls:** Both APIs support parallel tool calls but serialize them differently. Kimi K2.6's `tool_calls` array may contain multiple entries — we need to handle accumulating input for each by index.

3. **Usage reporting accuracy:** OpenCode Zen may or may not report cache read/write tokens in the same way. The cost computation should gracefully handle missing cache fields.

4. **Token counting for context gauge:** The Anthropic SDK gives detailed token breakdowns. OpenAI-compatible endpoints give `prompt_tokens` + `completion_tokens`. The context gauge will be less detailed for Kimi but still functional.

5. **Error handling:** OpenAI-compatible error responses have a different format (`{ error: { message, type, code } }`) than Anthropic's SDK exceptions. The provider layer needs to normalize these.

6. **No explicit prompt caching control:** Anthropic supports `cache_control: { type: "ephemeral" }` markers. OpenCode Zen/Kimi has automatic server-side caching. We just omit cache control for this provider.

7. **Max output tokens:** Kimi K2.6 supports up to 66K output tokens (per CloudPrice) vs. the current hardcoded `max_tokens: 16_000`. The provider config should allow per-model max output token settings.
