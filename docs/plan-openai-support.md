# Plan: Add Direct OpenAI Support

## Context

We already have a provider abstraction (`provider.ts`) with two implementations:
- `AnthropicProvider` — Anthropic Messages API via `@anthropic-ai/sdk`
- `OpenCodeZenProvider` — OpenAI-compatible Chat Completions via raw `fetch()`

This plan adds a third provider for **direct OpenAI API access** using the
official `openai` npm package and the **Responses API** — OpenAI's newer,
recommended API for agentic workloads.

### Why the Responses API (not Chat Completions)?

OpenAI recommends the Responses API for all new projects. Key reasons:

1. **Richer streaming events** — typed semantic events (`response.output_text.delta`,
   `response.output_item.added`, `response.function_call_arguments.delta`) instead of
   multiplexed `delta.tool_calls` arrays. Much cleaner to map to our `StreamEvent` types.
2. **Better tool calling support** — function calls are discrete items with their own
   lifecycle events, not bolted onto message deltas.
3. **Future-proof** — starting with GPT-5.4, tool calling is not supported in Chat
   Completions with `reasoning: none`. The Responses API is where OpenAI invests in
   agent features.
4. **Cleaner request shape** — `instructions` + `input` instead of a message array
   with `role: "system"`. Tool results are `function_call_output` items keyed by
   `call_id`.

We keep the existing `OpenCodeZenProvider` (Chat Completions) for Kimi K2.6 / third-party
OpenAI-compatible providers. The new `OpenAIProvider` is specifically for direct OpenAI
access via the Responses API.

### Target Model

| Model | ID | Context | Max Output | Input $/MTok | Cached $/MTok | Output $/MTok |
|-------|----|---------|------------|-------------|---------------|---------------|
| GPT-5.5 | `gpt-5.5` | 1,050,000 | 128,000 | $5.00 | $0.50 | $30.00 |

GPT-5.5 is the intended direct OpenAI model for this provider. Because it is a
reasoning model, the provider must preserve OpenAI reasoning output items across
turns by replaying the raw Responses API output items when available.

---

## Scope of Changes

### 1. Install the `openai` npm package

```bash
npm install openai
```

No other dependencies needed — the SDK handles SSE streaming, request signing,
and typed events out of the box.

### 2. Create `providers/openai.ts`

A new provider implementing the `Provider` interface using the `openai` SDK's
Responses API (`client.responses.create()`).

#### Request translation

Our `Provider.stream()` params map to the Responses API like this:

| Our param | Responses API field | Notes |
|-----------|-------------------|-------|
| `system` | `instructions` | Top-level string, not a message |
| `messages` | `input` | Array of items (see below) |
| `tools` | `tools` | `{ type: "function", ... }` format |
| `maxTokens` | `max_output_tokens` | |
| `model` | `model` | |

#### Message translation (`ProviderMessage[]` → Responses input items)

The Responses API uses a flat array of typed items instead of role-based messages:

| Our type | Responses API item |
|----------|-------------------|
| `UserMessage` with text | `{ type: "message", role: "user", content: [{ type: "input_text", text }] }` |
| `AssistantMessage` with text | `{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }` |
| `AssistantMessage` with tool_use | `{ type: "function_call", call_id, name, arguments }` |
| `UserMessage` with tool_result | `{ type: "function_call_output", call_id, output }` |

Key difference from Chat Completions: tool calls and their results are **top-level
items** in the input array, not nested inside messages.

#### Streaming event mapping

| Responses API event | Our `StreamEvent` |
|--------------------|-------------------|
| `response.output_text.delta` | `text_delta` (first one becomes `text_start`) |
| `response.output_item.added` (type `function_call`) | `tool_use_start` |
| `response.function_call_arguments.delta` | `tool_input_delta` |
| `response.output_item.done` | `block_stop` |
| `response.content_part.done` (text) | `block_stop` |

The SDK yields typed event objects we can switch on via `event.type`.

#### Usage extraction

The `response.completed` event (or the final response object) includes:

```ts
response.usage = {
  input_tokens: number,
  output_tokens: number,
  input_tokens_details: { cached_tokens: number },
  output_tokens_details: { reasoning_tokens: number },
}
```

Map to our `UsageInfo`:
- `inputTokens` = `input_tokens`
- `outputTokens` = `output_tokens`
- `cacheReadTokens` = `input_tokens_details.cached_tokens`
- `cacheCreationTokens` = 0 (OpenAI does automatic caching, no explicit write cost)

#### `finalMessage()` implementation

The `openai` SDK streams are async iterables. After iterating, we need the final
response to build `ProviderResponse`. Two options:

**Option A:** Accumulate content during iteration (like the OpenCode Zen provider does).
After the stream completes, reconstruct content blocks from accumulated text and
tool calls.

**Option B:** Use the SDK's stream helper if it provides a `finalResponse()` or similar
method.

Recommend **Option A** for consistency with how we already handle OpenCode Zen, and
because we need real-time accumulation for the TUI anyway.

### 3. Update `provider.ts`

- Add `"openai"` to the `ModelConfig.provider` union type
- Add model entry for `gpt-5.5`
- Add aliases: `"gpt5.5"`, `"5.5"`

```ts
"gpt-5.5": {
  id: "gpt-5.5",
  provider: "openai",
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  pricing: {
    inputPerMTok: 5.00,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.50,
    outputPerMTok: 30.00,
  },
},
```

### 4. Update `app.ts`

- Import `OpenAIProvider` from `./providers/openai`
- Add a lazy `openAIProvider` instance in the `getProvider()` factory
- Handle the new `"openai"` case in the switch

### 5. Update `tsconfig.json`

Add `providers/openai.ts` to the `include` array.

### 6. Update `package.json`

Add `openai` to dependencies.

### 7. Update `README.md`

Add OpenAI configuration section and model table entries.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `providers/openai.ts` | **Create** | OpenAI Responses API provider implementation |
| `provider.ts` | **Modify** | Add `"openai"` provider type, GPT-5.5 model, aliases |
| `app.ts` | **Modify** | Wire up OpenAI provider in factory |
| `tsconfig.json` | **Modify** | Add `providers/openai.ts` to include |
| `package.json` | **Modify** | Add `openai` dependency |
| `README.md` | **Modify** | Document OpenAI setup and models |

---

## Implementation Order

1. `npm install openai`
2. Add model configs and `"openai"` provider type to `provider.ts`
3. Implement `providers/openai.ts` — translate messages, stream, extract usage
4. Wire up in `app.ts`
5. Update `tsconfig.json`
6. `npm run lint`
7. Update `README.md`

---

## Key Differences from the OpenCode Zen Provider

| Aspect | OpenCode Zen (Chat Completions) | OpenAI (Responses API) |
|--------|---------------------------------|----------------------|
| SDK | Raw `fetch()` + manual SSE parsing | `openai` npm package |
| System prompt | `role: "system"` message | `instructions` param |
| Message format | Role-based messages array | Flat typed items array |
| Tool calls in history | `assistant.tool_calls[]` array | Top-level `function_call` items |
| Tool results in history | `role: "tool"` message | Top-level `function_call_output` item |
| Streaming events | SSE `data:` lines with `delta` objects | Typed semantic events |
| Tool call streaming | `delta.tool_calls[i].function.arguments` chunks | `response.function_call_arguments.delta` events |
| Stop reason | `finish_reason: "tool_calls"` | Presence of `function_call` items in output |
| Usage | `usage.prompt_tokens` / `completion_tokens` | `usage.input_tokens` / `output_tokens` with `details` |

These are distinct enough that a separate provider is the right approach, rather
than trying to parametrize the OpenCode Zen provider.

---

## Risks & Considerations

1. **New dependency** — Adding `openai` increases `node_modules` size. However it's
   well-maintained, has TypeScript types built in, and handles retry/streaming concerns
   that would be painful to reimplement.

2. **Responses API item model vs. our message model** — The Responses API uses a flat
   items array where tool calls and text are sibling items, not nested in messages. The
   translation from our `ProviderMessage[]` requires flattening assistant messages that
   contain both text and tool calls into separate items.

3. **`previous_response_id` chaining** — The Responses API supports chaining via
   `previous_response_id` instead of replaying the full conversation. This could save
   input tokens but changes the conversation model significantly. For v1, we replay
   full history (consistent with other providers). Chaining is a potential optimization
   for later.

4. **Automatic caching** — OpenAI does server-side prompt caching automatically (the
   cached token price is what they charge for cache hits). There's no explicit
   `cache_control` marker like Anthropic. Our cost computation handles this via the
   existing `cacheReadPerMTok` field.

5. **Reasoning continuity** — GPT-5.5 is a reasoning model. Raw Responses API
   output items, including reasoning items with `reasoning.encrypted_content`, must
   be persisted on assistant messages and replayed on follow-up requests.

6. **`store` parameter** — Responses are stored by default. We should set `store: false`
   to avoid retaining user data on OpenAI's servers, consistent with our privacy stance.
