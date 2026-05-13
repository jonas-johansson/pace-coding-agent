/**
 * OpenCode Zen provider — OpenAI-compatible Chat Completions API.
 *
 * Uses raw fetch() + SSE parsing to stream responses from
 * https://opencode.ai/zen/v1/chat/completions
 */

import type {
  Provider,
  ProviderStream,
  ProviderResponse,
  ProviderMessage,
  ContentBlock,
  StreamEvent,
  ToolDefinition,
  UsageInfo,
} from "../provider";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

// ── OpenAI-compatible types (minimal) ────────────────────────────────────────

type OaiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OaiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OaiTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OaiStreamDelta = {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type OaiStreamChoice = {
  index: number;
  delta: OaiStreamDelta;
  finish_reason: string | null;
};

type OaiStreamChunk = {
  id: string;
  object: string;
  choices: OaiStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  } | null;
};

// ── Message translation ─────────────────────────────────────────────────────

function toOaiMessages(system: string, messages: ProviderMessage[]): OaiMessage[] {
  const result: OaiMessage[] = [{ role: "system", content: system }];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Flatten user content. Text blocks become a single string.
      // Tool results become separate role:"tool" messages.
      const textParts: string[] = [];
      const toolResults: { tool_call_id: string; content: string; is_error?: boolean }[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          // tool_result
          const text = block.content.map((p) => p.text).join("\n");
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: block.is_error ? `Error: ${text}` : text,
          });
        }
      }

      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }

      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        });
      }
    } else {
      // assistant
      const textParts: string[] = [];
      const toolCalls: OaiToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          // tool_use
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OaiMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      };
      result.push(assistantMsg);
    }
  }

  return result;
}

function toOaiTools(tools: ToolDefinition[]): OaiTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ── SSE line parser ─────────────────────────────────────────────────────────

async function* parseSseLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    // Keep the last potentially-incomplete line in the buffer.
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("data: ")) {
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    const payload = buffer.trim().slice(6);
    if (payload !== "[DONE]") yield payload;
  }
}

// ── Provider implementation ─────────────────────────────────────────────────

export class OpenCodeZenProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    const key = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
    if (!key) {
      throw new Error(
        "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
      );
    }
    this.apiKey = key;
    this.baseUrl = process.env.OPENCODE_ZEN_BASE_URL ?? DEFAULT_BASE_URL;
  }

  async stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<ProviderStream> {

    const body = {
      model: params.model,
      messages: toOaiMessages(params.system, params.messages),
      tools: toOaiTools(params.tools),
      max_tokens: params.maxTokens,
      stream: true,
      // Include usage in the streamed response
      stream_options: { include_usage: true },
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenCode Zen request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("OpenCode Zen response has no body");
    }

    return new OpenCodeZenStream(response.body.getReader());
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

/**
 * Accumulator state for a single tool call being streamed.
 */
type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

class OpenCodeZenStream implements ProviderStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  // Accumulated state built up during iteration, consumed by finalMessage().
  private finishReason: string | null = null;
  private fullTextContent = "";
  private completedToolCalls: PendingToolCall[] = [];
  private pendingToolCalls = new Map<number, PendingToolCall>();
  private usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private iterationDone = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    // Track which tool call indices have already emitted a "tool_use_start".
    const startedTools = new Set<number>();
    // Track if we're in a text block to emit block_stop when transitioning.
    let inTextBlock = false;

    for await (const line of parseSseLines(this.reader)) {
      let chunk: OaiStreamChunk;
      try {
        chunk = JSON.parse(line) as OaiStreamChunk;
      } catch {
        continue;
      }

      // Capture usage if present (usually on the last chunk)
      if (chunk.usage) {
        this.usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreationTokens: 0,
        };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      // ── Text content ──
      if (delta.content != null && delta.content !== "") {
        if (!inTextBlock) {
          inTextBlock = true;
          yield { type: "text_start", text: delta.content };
        } else {
          yield { type: "text_delta", text: delta.content };
        }
        this.fullTextContent += delta.content;
      }

      // ── Tool calls ──
      if (delta.tool_calls) {
        // If we were in a text block, close it before starting tool calls.
        if (inTextBlock) {
          inTextBlock = false;
          yield { type: "block_stop" };
        }

        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let pending = this.pendingToolCalls.get(idx);

          if (!pending) {
            pending = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            this.pendingToolCalls.set(idx, pending);
          }

          // Update fields if present
          if (tc.id) pending.id = tc.id;
          if (tc.function?.name) pending.name = tc.function.name;
          if (tc.function?.arguments) pending.arguments += tc.function.arguments;

          if (!startedTools.has(idx) && pending.name) {
            startedTools.add(idx);
            yield { type: "tool_use_start", id: pending.id, name: pending.name };
          }

          if (tc.function?.arguments) {
            yield { type: "tool_input_delta", partialJson: tc.function.arguments };
          }
        }
      }
    }

    // Close any open text block
    if (inTextBlock) {
      yield { type: "block_stop" };
    }

    // Close any open tool call blocks
    for (const _idx of startedTools) {
      yield { type: "block_stop" };
    }

    // Move pending tool calls to completed
    for (const [, tc] of this.pendingToolCalls) {
      this.completedToolCalls.push(tc);
    }

    this.iterationDone = true;
  }

  async finalMessage(): Promise<ProviderResponse> {
    // If the caller didn't fully consume the iterator, drain it.
    if (!this.iterationDone) {
      const iter = this[Symbol.asyncIterator]();
      while (!(await iter.next()).done) {
        // drain
      }
    }

    const content: ContentBlock[] = [];

    if (this.fullTextContent) {
      content.push({ type: "text", text: this.fullTextContent });
    }

    for (const tc of this.completedToolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.arguments);
      } catch {
        input = tc.arguments;
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    const stopReason: "end_turn" | "tool_use" =
      this.finishReason === "tool_calls" ? "tool_use" : "end_turn";

    return {
      content,
      stopReason,
      usage: this.usage,
    };
  }
}
