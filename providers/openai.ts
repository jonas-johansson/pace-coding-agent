/**
 * OpenAI provider — uses the official `openai` npm package and the
 * Responses API for streaming tool-use conversations.
 *
 * Supports reasoning models (GPT-5.5, etc.) by capturing raw output items
 * — including reasoning items — and storing them on the AssistantMessage's
 * `providerMetadata` field. On subsequent requests, these are replayed
 * directly so the model can continue its chain of thought after tool calls.
 */

import OpenAI from "openai";
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
import type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
  FunctionTool,
} from "openai/resources/responses/responses";

// ── Provider metadata type ──────────────────────────────────────────────────

/**
 * Shape of the `providerMetadata` stored on AssistantMessages originating
 * from this provider. Contains the raw Responses API output items so that
 * reasoning items, messages, and function calls can be replayed verbatim.
 */
type OpenAIMetadata = {
  provider: "openai";
  outputItems: ResponseOutputItem[];
};

function isOpenAIMetadata(v: unknown): v is OpenAIMetadata {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).provider === "openai" &&
    Array.isArray((v as Record<string, unknown>).outputItems)
  );
}

// ── Message translation ─────────────────────────────────────────────────────

/**
 * Convert our provider-agnostic messages into Responses API input items.
 *
 * For assistant messages that carry `providerMetadata` from a previous
 * OpenAI response, we replay the raw output items directly — this preserves
 * reasoning items that reasoning models need for continuity. For messages
 * without metadata (e.g. from a different provider or a legacy session), we
 * translate from the ContentBlock format.
 */
function toResponsesInput(messages: ProviderMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "text") {
          items.push({
            role: "user",
            content: block.text,
          });
        } else {
          // tool_result → function_call_output
          const text = block.content.map((p) => p.text).join("\n");
          items.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: block.is_error ? `Error: ${text}` : text,
          });
        }
      }
    } else {
      // Assistant message — prefer raw output items if available
      if (isOpenAIMetadata(msg.providerMetadata)) {
        for (const item of msg.providerMetadata.outputItems) {
          items.push(item as ResponseInputItem);
        }
        continue;
      }

      // Fallback: translate from our ContentBlock format (no reasoning items)
      const textParts: string[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else {
          // Flush any accumulated text before the tool call
          if (textParts.length > 0) {
            items.push({
              role: "assistant",
              content: textParts.join("\n"),
            });
            textParts.length = 0;
          }

          items.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input),
          });
        }
      }

      // Flush remaining text
      if (textParts.length > 0) {
        items.push({
          role: "assistant",
          content: textParts.join("\n"),
        });
      }
    }
  }

  return items;
}

function toResponsesTools(tools: ToolDefinition[]): FunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function contentFromOutputItems(outputItems: ResponseOutputItem[]): ContentBlock[] {
  const content: ContentBlock[] = [];

  for (const item of outputItems) {
    if (item.type === "message") {
      const text = item.content
        .map((part) => {
          if (part.type === "output_text") return part.text;
          if (part.type === "refusal") return part.refusal;
          return "";
        })
        .join("");

      if (text) {
        content.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    }
  }

  return content;
}

// ── Provider implementation ─────────────────────────────────────────────────

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI();
  }

  async stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<ProviderStream> {
    const responseStream = this.client.responses.stream(
      {
        model: params.model,
        instructions: params.system,
        input: toResponsesInput(params.messages),
        tools: toResponsesTools(params.tools),
        max_output_tokens: params.maxTokens,
        parallel_tool_calls: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      { signal: params.signal },
    );

    return new OpenAIStream(responseStream);
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

/**
 * Accumulator state for a single tool call being streamed.
 */
type PendingToolCall = {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
};

class OpenAIStream implements ProviderStream {
  private inner: ReturnType<OpenAI["responses"]["stream"]>;

  // Accumulated state built up during iteration, consumed by finalMessage().
  private fullTextContent = "";
  private completedToolCalls: PendingToolCall[] = [];
  private pendingToolCallsByItemId = new Map<string, PendingToolCall>();
  private pendingToolCallsByCallId = new Map<string, PendingToolCall>();
  private pendingToolCallsByOutputIndex = new Map<number, PendingToolCall>();
  private outputItems: ResponseOutputItem[] = [];
  private usage: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  private hasToolCalls = false;
  private iterationDone = false;

  constructor(inner: ReturnType<OpenAI["responses"]["stream"]>) {
    this.inner = inner;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    let inTextBlock = false;
    const startedTools = new Set<string>();

    for await (const event of this.inner as AsyncIterable<ResponseStreamEvent>) {
      switch (event.type) {
        // ── Text output ──
        case "response.output_text.delta": {
          if (!inTextBlock) {
            inTextBlock = true;
            yield { type: "text_start", text: event.delta };
          } else {
            yield { type: "text_delta", text: event.delta };
          }
          this.fullTextContent += event.delta;
          break;
        }

        // ── Function call started ──
        case "response.output_item.added": {
          if (event.item.type === "function_call") {
            // Close any open text block
            if (inTextBlock) {
              inTextBlock = false;
              yield { type: "block_stop" };
            }

            this.hasToolCalls = true;
            const itemId = event.item.id ?? event.item.call_id;
            const callId = event.item.call_id;
            const name = event.item.name;

            const pending: PendingToolCall = { itemId, callId, name, arguments: "" };
            this.pendingToolCallsByItemId.set(itemId, pending);
            this.pendingToolCallsByCallId.set(callId, pending);
            this.pendingToolCallsByOutputIndex.set(event.output_index, pending);

            if (!startedTools.has(callId)) {
              startedTools.add(callId);
              yield { type: "tool_use_start", id: callId, name };
            }
          }
          break;
        }

        // ── Function call arguments delta ──
        case "response.function_call_arguments.delta": {
          const pending =
            this.pendingToolCallsByItemId.get(event.item_id) ??
            this.pendingToolCallsByOutputIndex.get(event.output_index);
          if (pending) {
            pending.arguments += event.delta;
            yield { type: "tool_input_delta", id: pending.callId, partialJson: event.delta };
          }
          break;
        }

        // ── Output item done ──
        case "response.output_item.done": {
          // Capture all completed output items (reasoning, messages, tool calls)
          this.outputItems.push(event.item);

          if (event.item.type === "function_call") {
            const itemId = event.item.id ?? event.item.call_id;
            const pending =
              this.pendingToolCallsByItemId.get(itemId) ??
              this.pendingToolCallsByCallId.get(event.item.call_id) ??
              this.pendingToolCallsByOutputIndex.get(event.output_index) ??
              { itemId, callId: event.item.call_id, name: event.item.name, arguments: "" };
            pending.arguments = event.item.arguments;
            this.completedToolCalls.push(pending);
            this.pendingToolCallsByItemId.delete(pending.itemId);
            this.pendingToolCallsByCallId.delete(pending.callId);
            this.pendingToolCallsByOutputIndex.delete(event.output_index);
            yield { type: "block_stop", id: pending.callId };
          }
          break;
        }

        // ── Text content part done ──
        case "response.content_part.done": {
          if (inTextBlock) {
            inTextBlock = false;
            yield { type: "block_stop" };
          }
          break;
        }

        // ── Response completed — extract usage ──
        case "response.completed": {
          const resp = event.response;
          if (resp.usage) {
            this.usage = {
              inputTokens: resp.usage.input_tokens,
              outputTokens: resp.usage.output_tokens,
              cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens ?? 0,
              cacheCreationTokens: 0,
            };
          }
          break;
        }

        default:
          break;
      }
    }

    // Close any still-open text block
    if (inTextBlock) {
      yield { type: "block_stop" };
    }

    // Move any remaining pending tool calls to completed. Normally OpenAI emits
    // response.output_item.done for each function call, but this preserves the
    // best-effort fallback behavior if a stream ends without those events.
    for (const [, tc] of this.pendingToolCallsByItemId) {
      this.completedToolCalls.push(tc);
    }
    this.pendingToolCallsByItemId.clear();
    this.pendingToolCallsByCallId.clear();
    this.pendingToolCallsByOutputIndex.clear();

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

    const content = contentFromOutputItems(this.outputItems);

    // Best-effort fallback for incomplete streams that produced text/tool deltas
    // but did not emit the corresponding response.output_item.done events.
    const hasOutputMessage = this.outputItems.some((item) => item.type === "message");
    if (!hasOutputMessage && this.fullTextContent) {
      content.unshift({ type: "text", text: this.fullTextContent });
    }

    const outputToolCallIds = new Set(
      this.outputItems
        .filter((item) => item.type === "function_call")
        .map((item) => item.call_id),
    );
    for (const tc of this.completedToolCalls) {
      if (outputToolCallIds.has(tc.callId)) continue;
      content.push({
        type: "tool_use",
        id: tc.callId,
        name: tc.name,
        input: parseToolArguments(tc.arguments),
      });
    }

    const stopReason: "end_turn" | "tool_use" =
      this.hasToolCalls ? "tool_use" : "end_turn";

    const metadata: OpenAIMetadata = {
      provider: "openai",
      outputItems: this.outputItems,
    };

    return {
      content,
      stopReason,
      usage: this.usage,
      providerMetadata: metadata,
    };
  }
}
