/**
 * Anthropic provider — wraps the @anthropic-ai/sdk to implement the
 * Provider interface.
 */

import Anthropic from "@anthropic-ai/sdk";
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

// ── Message translation ─────────────────────────────────────────────────────

function toAnthropicMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg): Anthropic.MessageParam => {
    if (msg.role === "user") {
      const content: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        // tool_result
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content.map((p) => ({ type: "text" as const, text: p.text })),
          ...(block.is_error && { is_error: true }),
        };
      });
      return { role: "user", content };
    }

    // assistant
    const content: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      // tool_use
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    });
    return { role: "assistant", content };
  });
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      result.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    // ignore other block types
  }
  return result;
}

// ── Provider implementation ─────────────────────────────────────────────────

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  async stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<ProviderStream> {
    const systemPrompt: Anthropic.TextBlockParam[] = [
      {
        type: "text" as const,
        text: params.system,
        cache_control: { type: "ephemeral" as const },
      },
    ];

    const anthropicStream = await this.client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: systemPrompt,
        messages: toAnthropicMessages(params.messages),
        tools: toAnthropicTools(params.tools),
        cache_control: { type: "ephemeral" },
      },
      { signal: params.signal },
    );

    return new AnthropicStream(anthropicStream);
  }
}

// ── Stream adapter ──────────────────────────────────────────────────────────

class AnthropicStream implements ProviderStream {
  private innerStream: ReturnType<Anthropic["messages"]["stream"]>;

  constructor(inner: ReturnType<Anthropic["messages"]["stream"]>) {
    this.innerStream = inner;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of this.innerStream) {
      const mapped = this.mapEvent(event);
      if (mapped) yield mapped;
    }
  }

  private mapEvent(event: Anthropic.MessageStreamEvent): StreamEvent | null {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          return { type: "text_start", text: block.text ?? "" };
        }
        if (block.type === "tool_use") {
          return { type: "tool_use_start", id: block.id, name: block.name };
        }
        return null;
      }

      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          return { type: "text_delta", text: delta.text };
        }
        if (delta.type === "input_json_delta") {
          return { type: "tool_input_delta", partialJson: delta.partial_json };
        }
        return null;
      }

      case "content_block_stop":
        return { type: "block_stop" };

      default:
        return null;
    }
  }

  async finalMessage(): Promise<ProviderResponse> {
    const response = await this.innerStream.finalMessage();

    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

    const usage: UsageInfo = {
      inputTokens: response.usage.input_tokens + cacheCreationTokens + cacheReadTokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens,
      cacheCreationTokens,
    };

    const stopReason: "end_turn" | "tool_use" =
      response.stop_reason === "tool_use" ? "tool_use" : "end_turn";

    return {
      content: fromAnthropicContent(response.content),
      stopReason,
      usage,
    };
  }
}
