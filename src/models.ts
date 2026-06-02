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

export type ModelVariant = {
  id: string;
  /** Human-readable provider-native wording, e.g. "reasoning effort: high". */
  label?: string;
  description?: string;
  /** Provider-native request options applied when this variant is selected. */
  providerOptions: Record<string, unknown>;
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
  defaultVariant?: string;
  variants?: Record<string, ModelVariant>;
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

const OPENAI_ENCRYPTED_REASONING_INCLUDE = ["reasoning.encrypted_content"];

function openAIReasoningEffortVariant(effort: "none" | "low" | "medium" | "high" | "xhigh"): ModelVariant {
  return {
    id: effort,
    label: `reasoning effort: ${effort}`,
    providerOptions: {
      reasoning: { effort, summary: "auto" },
      include: OPENAI_ENCRYPTED_REASONING_INCLUDE,
    },
  };
}

const GPT_5_5_REASONING_VARIANTS: Record<string, ModelVariant> = {
  none: openAIReasoningEffortVariant("none"),
  low: openAIReasoningEffortVariant("low"),
  medium: openAIReasoningEffortVariant("medium"),
  high: openAIReasoningEffortVariant("high"),
  xhigh: openAIReasoningEffortVariant("xhigh"),
};

function anthropicAdaptiveThinkingVariant(effort: "low" | "medium" | "high" | "xhigh" | "max"): ModelVariant {
  return {
    id: effort,
    label: `adaptive thinking effort: ${effort}`,
    providerOptions: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    },
  };
}

const ANTHROPIC_NOTHINK_VARIANT: ModelVariant = {
  id: "nothink",
  label: "thinking: disabled",
  providerOptions: { thinking: { type: "disabled" } },
};

const ANTHROPIC_ADAPTIVE_THINKING_VARIANTS: Record<string, ModelVariant> = {
  nothink: ANTHROPIC_NOTHINK_VARIANT,
  adaptive: {
    id: "adaptive",
    label: "adaptive thinking",
    providerOptions: { thinking: { type: "adaptive", display: "summarized" } },
  },
  low: anthropicAdaptiveThinkingVariant("low"),
  medium: anthropicAdaptiveThinkingVariant("medium"),
  high: anthropicAdaptiveThinkingVariant("high"),
  xhigh: anthropicAdaptiveThinkingVariant("xhigh"),
  max: anthropicAdaptiveThinkingVariant("max"),
};

const ANTHROPIC_BUDGET_THINKING_VARIANTS: Record<string, ModelVariant> = {
  nothink: ANTHROPIC_NOTHINK_VARIANT,
  "thinking-8k": {
    id: "thinking-8k",
    label: "thinking budget: 8k",
    providerOptions: { thinking: { type: "enabled", budget_tokens: 8_192, display: "summarized" } },
  },
  "thinking-max": {
    id: "thinking-max",
    label: "thinking budget: max",
    providerOptions: { thinking: { type: "enabled", budget_tokens: 15_999, display: "summarized" } },
  },
};

export const MODEL_METADATA: Record<string, ModelMetadata> = {
  "anthropic/claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsImages: true,
    defaultVariant: "thinking-8k",
    variants: ANTHROPIC_BUDGET_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "thinking-8k",
    variants: ANTHROPIC_BUDGET_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "adaptive",
    variants: ANTHROPIC_ADAPTIVE_THINKING_VARIANTS,
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
    defaultVariant: "medium",
    variants: GPT_5_5_REASONING_VARIANTS,
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
    defaultVariant: "medium",
    variants: GPT_5_5_REASONING_VARIANTS,
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

export type ModelSelection = {
  modelId: string;
  variantId?: string;
};

export function getModelVariant(modelId: string, variantId: string | undefined): ModelVariant | undefined {
  if (!variantId) return undefined;
  return getModelConfig(modelId)?.variants?.[variantId];
}

export function formatModelSelection(selection: ModelSelection): string {
  return selection.variantId ? `${selection.modelId}:${selection.variantId}` : selection.modelId;
}

export function parseModelSelection(input: string): ModelSelection | undefined {
  const exactModel = getModelConfig(input);
  if (exactModel) return { modelId: exactModel.id };

  const lastColonIndex = input.lastIndexOf(":");
  if (lastColonIndex === -1) return undefined;

  const modelId = input.slice(0, lastColonIndex);
  const variantId = input.slice(lastColonIndex + 1);
  const model = getModelConfig(modelId);
  if (!model || !variantId || !model.variants?.[variantId]) return undefined;

  return { modelId: model.id, variantId };
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
