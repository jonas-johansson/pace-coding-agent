/**
 * Provider abstraction layer.
 *
 * Defines a common interface that both Anthropic and OpenAI-compatible
 * providers implement, so the rest of the app can work against a single
 * set of types regardless of the upstream API.
 */

// ── Normalised content blocks ────────────────────────────────────────────────

export type TextBlock = {
  type: "text";
  text: string;
};

export type ImageBlock = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded image data. */
  data: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ContentBlock = TextBlock | ToolUseBlock;

// ── Tool result (sent back to the model) ─────────────────────────────────────

export type ToolResultPart = {
  type: "text";
  text: string;
};

export type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: ToolResultPart[];
  is_error?: boolean;
};

// ── Messages ─────────────────────────────────────────────────────────────────

export type UserMessage = {
  role: "user";
  content: (TextBlock | ImageBlock | ToolResultContent)[];
};

export type AssistantMessage = {
  role: "assistant";
  content: ContentBlock[];
  /** Opaque provider-specific data, serialized as-is for session persistence. */
  providerMetadata?: unknown;
};

export type ProviderMessage = UserMessage | AssistantMessage;

// ── Usage ────────────────────────────────────────────────────────────────────

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// ── Streaming events ─────────────────────────────────────────────────────────

export type StreamTextStart = {
  type: "text_start";
  text: string;
};

export type StreamTextDelta = {
  type: "text_delta";
  text: string;
};

export type StreamToolUseStart = {
  type: "tool_use_start";
  id: string;
  name: string;
};

export type StreamToolInputDelta = {
  type: "tool_input_delta";
  id: string;
  partialJson: string;
};

export type StreamBlockStop = {
  type: "block_stop";
  id?: string;
};

export type StreamEvent =
  | StreamTextStart
  | StreamTextDelta
  | StreamToolUseStart
  | StreamToolInputDelta
  | StreamBlockStop;

// ── Provider response (after stream completes) ──────────────────────────────

export type ProviderResponse = {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
  usage: UsageInfo;
  /** Opaque provider-specific data to carry on the AssistantMessage. */
  providerMetadata?: unknown;
};

// ── Stream handle ────────────────────────────────────────────────────────────

export type ProviderStream = {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
  finalMessage(): Promise<ProviderResponse>;
};

// ── Tool definition (provider-agnostic) ──────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

// ── Provider interface ───────────────────────────────────────────────────────

export interface Provider {
  stream(params: {
    model: string;
    system: string;
    messages: ProviderMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<ProviderStream>;
}

// ── Model configuration ─────────────────────────────────────────────────────

export type ModelConfig = {
  id: string;
  provider: "anthropic" | "opencode-zen" | "openai" | "fireworks";
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  pricing: {
    inputPerMTok: number;
    cacheWritePerMTok: number;
    cacheReadPerMTok: number;
    outputPerMTok: number;
  };
};

export const MODELS: Record<string, ModelConfig> = {
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 1,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.10,
      outputPerMTok: 5,
    },
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 3,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.30,
      outputPerMTok: 15,
    },
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 5,
      cacheWritePerMTok: 6.25,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 25,
    },
  },
  "kimi-k2.6": {
    id: "kimi-k2.6",
    provider: "opencode-zen",
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.16,
      outputPerMTok: 4.00,
    },
  },
  "kimi-k2.6-fw": {
    id: "kimi-k2.6-fw",
    provider: "fireworks",
    contextWindow: 262_144,
    maxOutputTokens: 32_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 0.95,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.16,
      outputPerMTok: 4.00,
    },
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    provider: "openai",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 5.00,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 30.00,
    },
  },
};

export const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  kimi: "kimi-k2.6",
  "k2.6": "kimi-k2.6",
  "kimi-fw": "kimi-k2.6-fw",
  "k2.6-fw": "kimi-k2.6-fw",
  "gpt5.5": "gpt-5.5",
  "5.5": "gpt-5.5",
};

export const AVAILABLE_MODEL_IDS = Object.keys(MODELS);

export const DEFAULT_MODEL_ID = "kimi-k2.6";

export function resolveModelId(input: string): string | undefined {
  if (input in MODELS) return input;
  return MODEL_ALIASES[input.toLowerCase()];
}
