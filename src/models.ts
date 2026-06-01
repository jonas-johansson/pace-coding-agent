/**
 * Model metadata and provider-qualified model id helpers.
 */

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
  "anthropic/claude-opus-4-7": {
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
  "anthropic/claude-opus-4-8": {
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
  "opencode/claude-haiku-4-5": {
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
  "opencode/claude-sonnet-4-6": {
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
  "opencode/claude-opus-4-6": {
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
  "opencode/claude-opus-4-7": {
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
  "opencode/claude-opus-4-8": {
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
  // "lmstudio/google/gemma-4-26b-a4b": {
  //   contextWindow: 32_768,
  //   maxOutputTokens: 8_192,
  //   supportsImages: true,
  //   pricing: ZERO_PRICING,
  // },
  // "lmstudio/qwen/qwen3.6-35b-a3b": {
  //   contextWindow: 32_768,
  //   maxOutputTokens: 8_192,
  //   supportsImages: true,
  //   pricing: ZERO_PRICING,
  // },
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
