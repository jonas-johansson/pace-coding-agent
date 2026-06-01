/**
 * Provider-agnostic types and model configuration.
 */

// ── Content blocks ───────────────────────────────────────────────────────────

export type TextBlock = {
  type: "text";
  text: string;
};

export type ImageBlock = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

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

export type ContentBlock = TextBlock | ToolUseBlock;

// ── Messages ─────────────────────────────────────────────────────────────────

export type UserMessage = {
  role: "user";
  content: Array<TextBlock | ImageBlock | ToolResultContent>;
};

export type AssistantMessage = {
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
  /**
   * Provider-specific metadata needed to faithfully continue conversations.
   * Examples: Anthropic raw content blocks, OpenAI Responses output items,
   * OpenCode Zen reasoning_content.
   */
  providerMetadata?: unknown;
};

export type ProviderMessage = UserMessage | AssistantMessage;

// ── Streaming events ─────────────────────────────────────────────────────────

export type TextStartEvent = {
  type: "text_start";
  text: string;
};

export type TextDeltaEvent = {
  type: "text_delta";
  text: string;
};

export type ReasoningStartEvent = {
  type: "reasoning_start";
  text: string;
};

export type ReasoningDeltaEvent = {
  type: "reasoning_delta";
  text: string;
};

export type ToolUseStartEvent = {
  type: "tool_use_start";
  id: string;
  name: string;
};

export type ToolInputDeltaEvent = {
  type: "tool_input_delta";
  id: string;
  partialJson: string;
};

export type BlockStopEvent = {
  type: "block_stop";
  id?: string;
};

export type StreamEvent =
  | TextStartEvent
  | TextDeltaEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ToolUseStartEvent
  | ToolInputDeltaEvent
  | BlockStopEvent;

// ── Usage / response ─────────────────────────────────────────────────────────

export type UsageInfo = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type ProviderResponse = {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use";
  usage: UsageInfo;
  providerMetadata?: unknown;
};

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

export type ProviderId = "anthropic" | "opencode" | "openai" | "fireworks" | "lmstudio";

export type PricingConfig = {
  inputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
};

export type ModelMetadata = {
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  pricing: PricingConfig;
  longContextPricing?: {
    inputTokenThreshold: number;
    pricing: PricingConfig;
  };
};

export type ModelConfig = ModelMetadata & {
  /** Full user-facing model id: provider/model. */
  id: string;
  /** Provider id parsed from the full model id. */
  provider: ProviderId;
  /** Model id sent to the provider API. */
  providerModel: string;
};

const ZERO_PRICING: PricingConfig = {
  inputPerMTok: 0,
  cacheWritePerMTok: 0,
  cacheReadPerMTok: 0,
  outputPerMTok: 0,
};

export const MODEL_METADATA: Record<string, ModelMetadata> = {
  "anthropic/claude-haiku-4-5": {
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
  "anthropic/claude-sonnet-4-6": {
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
  "anthropic/claude-opus-4-6": {
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
  "opencode/kimi-k2.6": {
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
  "fireworks/kimi-k2.6": {
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
  "opencode/gpt-5.5": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 5.00,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 30.00,
    },
    longContextPricing: {
      inputTokenThreshold: 272_000,
      pricing: {
        inputPerMTok: 10.00,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: 1.00,
        outputPerMTok: 45.00,
      },
    },
  },
  "openai/gpt-5.5": {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    pricing: {
      inputPerMTok: 5.00,
      cacheWritePerMTok: 0,
      cacheReadPerMTok: 0.50,
      outputPerMTok: 30.00,
    },
    longContextPricing: {
      inputTokenThreshold: 272_000,
      pricing: {
        inputPerMTok: 10.00,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: 1.00,
        outputPerMTok: 45.00,
      },
    },
  },
  "lmstudio/google/gemma-4-26b-a4b": {
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  "lmstudio/qwen/qwen3.6-35b-a3b": {
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
};

const PROVIDER_IDS = new Set<ProviderId>([
  "anthropic",
  "opencode",
  "openai",
  "fireworks",
  "lmstudio",
]);

export function parseModelId(id: string): { id: string; provider: ProviderId; providerModel: string } | undefined {
  const slashIndex = id.indexOf("/");
  if (slashIndex <= 0 || slashIndex === id.length - 1) return undefined;

  const provider = id.slice(0, slashIndex);
  if (!PROVIDER_IDS.has(provider as ProviderId)) return undefined;

  return {
    id,
    provider: provider as ProviderId,
    providerModel: id.slice(slashIndex + 1),
  };
}

const DEFAULT_MODEL_METADATA_BY_PROVIDER: Record<ProviderId, ModelMetadata> = {
  anthropic: {
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  opencode: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  openai: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  fireworks: {
    contextWindow: 128_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
  lmstudio: {
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    supportsImages: true,
    pricing: ZERO_PRICING,
  },
};

export function getModelConfig(id: string): ModelConfig | undefined {
  const parsed = parseModelId(id);
  if (!parsed) return undefined;

  const metadata = MODEL_METADATA[id] ?? DEFAULT_MODEL_METADATA_BY_PROVIDER[parsed.provider];
  return { ...metadata, ...parsed };
}

function createModels(): Record<string, ModelConfig> {
  return Object.fromEntries(
    Object.keys(MODEL_METADATA).map((id) => {
      const config = getModelConfig(id);
      if (!config) {
        throw new Error(`Invalid built-in model id: ${id}`);
      }
      return [id, config];
    }),
  );
}

export const MODELS: Record<string, ModelConfig> = createModels();

export const AVAILABLE_MODEL_IDS = Object.keys(MODELS);

export const DEFAULT_MODEL_ID = "opencode/kimi-k2.6";
