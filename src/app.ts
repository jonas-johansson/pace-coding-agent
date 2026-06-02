import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve, extname } from "path";
import { Tui } from "./tui";
import { sessionToRenderBlocks } from "./session-view";
import { reasoningDisplayContent, reasoningDisplayTitle, reasoningTitle } from "./reasoning";
import {
  appendTurnDraftEntry,
  commitTurnDraft,
  createAssistantEntry,
  createProjectKey,
  createSession,
  createToolResultEntry,
  createTurnDraft,
  createUserEntry,
  getActivePath,
  isTurnDraftEmpty,
  listSessions,
  loadSession,
  saveSession,
  sessionToProviderMessages,
  undoLastUserTurn,
  type ContentBlock as SessionContentBlock,
  type Session,
  type SessionListItem,
  type ThinkingBlock,
} from "./session";
import { initHighlighter } from "./syntax";
import {
  tools,
  visualizeToolTitle,
  visualizeToolPartialTitle,
  formatToolResultBody,
  truncateToolOutputIfNeeded,
  isAbortError,
  getProviderToolDefinitions,
  setCurrentSkills,
} from "./tool";
import {
  discoverSkills,
  findSkill,
  loadSkillContent,
  formatSkillsSystemPromptBlock,
  formatSkillsListing,
} from "./skill";
import type {
  Provider,
  ProviderStream,
  ContentBlock as ProviderContentBlock,
  ToolUseBlock,
  ToolResultContent,
  ImageBlock,
} from "./provider";
import {
  MODELS,
  AVAILABLE_MODEL_IDS,
  DEFAULT_MODEL_ID,
  getModelConfig,
  getModelVariant,
  parseModelSelection,
  formatModelSelection,
  type ModelConfig,
  type ModelSelection,
  type ModelVariant,
} from "./models";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenCodeZenProvider } from "./providers/opencode-zen";
import { OpenAIProvider } from "./providers/openai";
import { FireworksProvider } from "./providers/fireworks";
import { LmStudioProvider } from "./providers/lmstudio";
import { readClipboardImage, type SupportedImageMediaType } from "./clipboard";
import { sendDesktopNotification } from "./notify";
import { onEvent } from "./events";
import { loadPaceConfig } from "./config";
import {
  initMcpServers,
  shutdownMcpServers,
  formatMcpListing,
  getConnectedMcpServers,
} from "./mcp-tools";

/**
 * Attempts to read AGENTS.md from the current working directory.
 * Returns the file contents as a string, or null if the file does not exist.
 */
async function loadAgentsFile(): Promise<string | null> {
  try {
    const filePath = join(process.cwd(), "AGENTS.md");
    const contents = await readFile(filePath, "utf-8");
    return contents;
  } catch {
    return null;
  }
}

function formatCwd(cwd: string): string {
  const home = homedir();
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

async function getProjectFiles(): Promise<string[]> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      `rg --files --hidden -g '!node_modules/' -g '!.git/' -g '!dist/' -g '!build/' -g '!coverage/' -g '!.next/' -g '!vendor/'`,
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// ── Provider instances (lazily created) ──────────────────────────────────────

let anthropicProvider: AnthropicProvider | undefined;
let openCodeZenProvider: OpenCodeZenProvider | undefined;
let openCodeZenAnthropicProvider: AnthropicProvider | undefined;
let openCodeZenOpenAIProvider: OpenAIProvider | undefined;
let openAIProvider: OpenAIProvider | undefined;
let fireworksProvider: FireworksProvider | undefined;
let lmStudioProvider: LmStudioProvider | undefined;

function getProvider(config: ModelConfig): Provider {
  switch (config.provider) {
    case "anthropic":
      if (!anthropicProvider) anthropicProvider = new AnthropicProvider();
      return anthropicProvider;
    case "opencode":
      if (config.providerModel.startsWith("claude-")) {
        if (!openCodeZenAnthropicProvider) {
          const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
          if (!apiKey) {
            throw new Error(
              "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
            );
          }
          openCodeZenAnthropicProvider = new AnthropicProvider({
            apiKey,
            baseURL: process.env.OPENCODE_ZEN_ANTHROPIC_BASE_URL ?? "https://opencode.ai/zen",
          });
        }
        return openCodeZenAnthropicProvider;
      }
      if (config.providerModel.startsWith("gpt-")) {
        // GPT-5.x models on OpenCode Zen are served via the OpenAI Responses
        // API (not Chat Completions), which is required to surface reasoning.
        // Reuse the OpenAIProvider pointed at the Zen base URL.
        if (!openCodeZenOpenAIProvider) {
          const apiKey = process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY;
          if (!apiKey) {
            throw new Error(
              "Missing API key for OpenCode Zen. Set the OPENCODE_ZEN_API_KEY or OPENCODE_API_KEY environment variable.",
            );
          }
          openCodeZenOpenAIProvider = new OpenAIProvider({
            apiKey,
            baseURL: process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1",
          });
        }
        return openCodeZenOpenAIProvider;
      }
      if (!openCodeZenProvider) openCodeZenProvider = new OpenCodeZenProvider();
      return openCodeZenProvider;
    case "openai":
      if (!openAIProvider) openAIProvider = new OpenAIProvider();
      return openAIProvider;
    case "fireworks":
      if (!fireworksProvider) fireworksProvider = new FireworksProvider();
      return fireworksProvider;
    case "lmstudio":
      if (!lmStudioProvider) lmStudioProvider = new LmStudioProvider();
      return lmStudioProvider;
  }
}

// ── Model state ──────────────────────────────────────────────────────────────

let currentModelId: string = DEFAULT_MODEL_ID;
const lastVariantByModelId = new Map<string, string>();
let cycleModelSelections: ModelSelection[] = [
  { modelId: "opencode/kimi-k2.6" },
  { modelId: "opencode/claude-opus-4-8" },
];
let activeSession = createSession(process.cwd(), currentModelId);

type ResolvedModelVariant = ModelVariant & { id: string };

function currentModelConfig(): ModelConfig {
  return getModelConfig(currentModelId) ?? MODELS[DEFAULT_MODEL_ID];
}

function currentModelVariantId(): string | undefined {
  const remembered = lastVariantByModelId.get(currentModelId);
  if (remembered && getModelVariant(currentModelId, remembered)) {
    return remembered;
  }
  return undefined;
}

function currentModelVariant(): ResolvedModelVariant | undefined {
  const variantId = currentModelVariantId();
  const variant = getModelVariant(currentModelId, variantId);
  return variant && variantId ? { ...variant, id: variantId } : undefined;
}

function formatCurrentModelSelection(): string {
  return formatModelSelection({ modelId: currentModelId, variantId: currentModelVariantId() });
}

function selectModel(modelId: string, explicitVariantId?: string) {
  currentModelId = modelId;
  const model = currentModelConfig();
  const variants = model.variants ?? {};
  const rememberedVariantId = lastVariantByModelId.get(modelId);
  const nextVariantId = explicitVariantId
    ?? (rememberedVariantId && variants[rememberedVariantId] ? rememberedVariantId : undefined)
    ?? model.defaultVariant;

  if (nextVariantId && variants[nextVariantId]) {
    lastVariantByModelId.set(modelId, nextVariantId);
  } else {
    lastVariantByModelId.delete(modelId);
  }

  const currentVariantId = currentModelVariantId();
  activeSession = {
    ...activeSession,
    currentModelId,
    currentModelVariant: currentVariantId,
    updatedAt: new Date().toISOString(),
  };
  tui.setModel(formatCurrentModelSelection());
  updateContextInfo();
}

function selectModelSelection(selection: ModelSelection) {
  selectModel(selection.modelId, selection.variantId);
}

function cancelPrompt() {
  if (!promptRunning || !currentAbortController) return;
  currentAbortController.abort();
}

const tui = new Tui({
  onSubmit: handleUserInput,
  onTab: cycleModel,
  onShiftTab: cycleModelReverse,
  onCycleVariant: cycleModelVariant,
  onEscape: cancelPrompt,
  onPasteImage: handlePasteImage,
  slashCommands: () => [
    { label: "/new", detail: "Start a new conversation", kind: "command", insertText: "/new " },
    { label: "/exit", detail: "Exit the application", kind: "command", insertText: "/exit " },
    { label: "/quit", detail: "Exit the application", kind: "command", insertText: "/quit " },
    { label: "/model", detail: "Show or switch model", kind: "command", insertText: "/model " },
    { label: "/models", detail: "Open the model picker (Ctrl+O)", kind: "command", insertText: "/models", executeOnAccept: true },
    { label: "/variant", detail: "Show or switch model variant", kind: "command", insertText: "/variant " },
    { label: "/variants", detail: "List model variants", kind: "command", insertText: "/variants", executeOnAccept: true },
    { label: "/sessions", detail: "Open the session picker", kind: "command", insertText: "/sessions", executeOnAccept: true },
    { label: "/resume", detail: "Resume a session by id", kind: "command", insertText: "/resume " },
    { label: "/undo", detail: "Undo the last user turn", kind: "command", insertText: "/undo" },
    { label: "/skills", detail: "List available skills", kind: "command", insertText: "/skills " },
    { label: "/skill:<name>", detail: "Load and run a skill", kind: "command", insertText: "/skill:" },
    { label: "/mcp", detail: "List connected MCP servers and tools", kind: "command", insertText: "/mcp" },
  ],
  fileSuggestions: getProjectFiles,
  modelOverlay: {
    list: () => AVAILABLE_MODEL_IDS.map((id) => {
      const config = MODELS[id];
      return {
        id,
        contextWindow: config.contextWindow,
        supportsImages: config.supportsImages,
        inputPerMTok: config.pricing.inputPerMTok,
        outputPerMTok: config.pricing.outputPerMTok,
      };
    }),
    initialSelected: () => Array.from(new Set(cycleModelSelections.map((selection) => selection.modelId))),
    onPick: (id) => selectModel(id),
    onCycleChange: (ids) => {
      cycleModelSelections = (ids.length > 0 ? ids : AVAILABLE_MODEL_IDS).map((modelId) => ({ modelId }));
    },
  },
  sessionOverlay: {
    onPick: (id) => {
      void resumeSessionById(id);
    },
  },
  model: DEFAULT_MODEL_ID,
  cwd: process.cwd(),
});

let promptRunning = false;
let currentAbortController: AbortController | null = null;
let lastInputTokens = 0;
let lastOutputTokens = 0;
let lastCacheReadTokens = 0;
let lastCacheCreationTokens = 0;
let accumulatedCost = 0;

// ── Image attachment state ───────────────────────────────────────────────────

type ImageAttachment = {
  mediaType: SupportedImageMediaType;
  data: string; // base64
  rawSize: number; // raw bytes before base64
  label: string; // e.g. "clipboard-1", "screenshot.png"
};

let pendingImages: ImageAttachment[] = [];
let clipboardCounter = 0;
let pasteInFlight = false;

/** Maximum raw bytes per image (Anthropic binding constraint). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Anthropic total request limit in bytes. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** Image file extensions we recognize. */
const IMAGE_EXTENSIONS: Record<string, SupportedImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Pattern matching @image(<path>) references in user input. */
const IMAGE_REF_PATTERN = /@image\(([^)]+)\)/g;

/** Pattern matching bare image file paths at word boundaries. */
const BARE_IMAGE_PATH_PATTERN = /(?:^|\s)((?:\.{0,2}\/|~\/)[^\s]+\.(?:jpg|jpeg|png|gif|webp))(?=\s|$)/gi;

/** Pattern matching @filename references (e.g. @file.txt, @src/foo.ts). */
const FILE_REF_PATTERN = /@([\w./\-]+\.\w+)/g;

function estimateBase64Size(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

function expandHomePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/** Estimate total base64 image payload already present in the conversation. */
function estimateExistingImagePayload(): number {
  let total = 0;
  for (const msg of sessionToProviderMessages(activeSession)) {
    if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "image") {
          total += block.data.length;
        }
      }
    }
  }
  return total;
}

/** Estimate total pending + new image payload in base64 bytes. */
function estimatePendingImagePayload(): number {
  let total = 0;
  for (const img of pendingImages) {
    total += estimateBase64Size(img.rawSize);
  }
  return total;
}

function mimeFromExtension(filePath: string): SupportedImageMediaType | null {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

function computeCallCost(
  config: ModelConfig,
  totalInputTokens: number,
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): number {
  const pricing = config.longContextPricing && totalInputTokens > config.longContextPricing.inputTokenThreshold
    ? config.longContextPricing.pricing
    : config.pricing;

  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWritePerMTok +
    (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

function updateContextInfo() {
  const config = currentModelConfig();
  const usedTokens = lastInputTokens + lastOutputTokens;
  tui.setContextInfo({
    usedTokens,
    contextWindow: config.contextWindow,
    cacheReadTokens: lastCacheReadTokens,
    cacheCreationTokens: lastCacheCreationTokens,
  });
  tui.setCost(accumulatedCost);
}

function refreshSessionStatsFromSession() {
  const activePath = getActivePath(activeSession);
  let lastAssistantEntry;

  for (let i = activePath.length - 1; i >= 0; i -= 1) {
    const entry = activePath[i];
    if (entry.type === "assistant") {
      lastAssistantEntry = entry;
      break;
    }
  }

  lastInputTokens = lastAssistantEntry?.tokensIn ?? 0;
  lastOutputTokens = lastAssistantEntry?.tokensOut ?? 0;
  lastCacheReadTokens = lastAssistantEntry?.cacheReadTokens ?? 0;
  lastCacheCreationTokens = lastAssistantEntry?.cacheCreationTokens ?? 0;
  accumulatedCost = activeSession.entries.reduce(
    (sum, entry) => sum + (entry.type === "assistant" ? entry.cost : 0),
    0,
  );
  updateContextInfo();
}

function clearPendingInputState() {
  pendingImages = [];
  clipboardCounter = 0;
  tui.setImageCount(0);
}

function activateSession(session: Session) {
  activeSession = session;
  currentModelId = getModelConfig(activeSession.currentModelId) ? activeSession.currentModelId : DEFAULT_MODEL_ID;
  if (getModelVariant(currentModelId, activeSession.currentModelVariant)) {
    lastVariantByModelId.set(currentModelId, activeSession.currentModelVariant as string);
  }
  activeSession = { ...activeSession, currentModelId, currentModelVariant: currentModelVariantId() };

  tui.setModel(formatCurrentModelSelection());
  clearPendingInputState();
  rebuildTuiFromSession();
  refreshSessionStatsFromSession();
}

async function resumeSessionById(sessionId: string) {
  const session = await loadSession(createProjectKey(process.cwd()), sessionId);
  activateSession(session);
}

function refreshCwd() {
  tui.setCwd(process.cwd());
}

function rebuildTuiFromSession() {
  tui.setBlocks(sessionToRenderBlocks(activeSession));
}

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function modelSelectionMatchesCurrent(selection: ModelSelection): boolean {
  return selection.modelId === currentModelId
    && (selection.variantId === undefined || selection.variantId === currentModelVariantId());
}

function cycleModel() {
  const selections = cycleModelSelections;
  const currentIndex = selections.findIndex(modelSelectionMatchesCurrent);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selections.length;
  selectModelSelection(selections[nextIndex]);
}

function cycleModelReverse() {
  const selections = cycleModelSelections;
  const currentIndex = selections.findIndex(modelSelectionMatchesCurrent);
  const prevIndex = currentIndex === -1 ? selections.length - 1 : (currentIndex - 1 + selections.length) % selections.length;
  selectModelSelection(selections[prevIndex]);
}

function cycleModelVariant() {
  const variants = Object.keys(currentModelConfig().variants ?? {});
  if (variants.length === 0) {
    tui.setStatus(`${currentModelId} has no variants`);
    return;
  }

  const currentVariant = currentModelVariantId();
  const currentIndex = currentVariant ? variants.indexOf(currentVariant) : -1;
  const nextVariant = variants[(currentIndex + 1) % variants.length];
  lastVariantByModelId.set(currentModelId, nextVariant);
  activeSession = {
    ...activeSession,
    currentModelId,
    currentModelVariant: nextVariant,
    updatedAt: new Date().toISOString(),
  };
  tui.setModel(formatCurrentModelSelection());
  tui.setStatus(`Variant: ${formatCurrentModelSelection()}`);
}

function formatModelList() {
  return cycleModelSelections.map(formatModelSelection).join("\n");
}

function formatVariantList() {
  const variants = currentModelConfig().variants ?? {};
  const entries = Object.entries(variants);
  if (entries.length === 0) {
    return `${currentModelId} has no variants.`;
  }

  const currentVariant = currentModelVariantId();
  return [
    `Current model: ${currentModelId}`,
    `Current variant: ${currentVariant ?? "none"}`,
    "",
    "Available variants:",
    ...entries.map(([id, variant]) => {
      const marker = id === currentVariant ? "*" : "-";
      return `${marker} ${id}${variant.label ? ` — ${variant.label}` : ""}`;
    }),
    "",
    "Usage: /variant <variant>",
  ].join("\n");
}

function applyConfiguredModels(config: { defaultModel?: string; cycleModels?: string[] }) {
  if (config.cycleModels) {
    const parsed = config.cycleModels.map((modelSelection) => ({ raw: modelSelection, parsed: parseModelSelection(modelSelection) }));
    const invalid = parsed.filter((entry) => !entry.parsed).map((entry) => entry.raw);
    if (invalid.length > 0) {
      throw new Error(`Invalid cycleModels entries. Expected provider/model or provider/model:variant ids for supported providers: ${invalid.join(", ")}`);
    }
    cycleModelSelections = parsed.map((entry) => entry.parsed as ModelSelection);
  }

  if (config.defaultModel !== undefined) {
    const selection = parseModelSelection(config.defaultModel);
    if (!selection) {
      throw new Error(`Invalid defaultModel. Expected provider/model or provider/model:variant for a supported provider: ${config.defaultModel}`);
    }
    selectModelSelection(selection);
  } else if (!cycleModelSelections.some((selection) => selection.modelId === currentModelId)) {
    selectModelSelection(cycleModelSelections[0]);
  }
}

function formatSessionList(sessions: SessionListItem[]): string {
  if (sessions.length === 0) {
    return `No sessions for ${formatCwd(process.cwd())}.`;
  }

  const rows = sessions.map((session) => {
    const marker = session.id === activeSession.id ? " *" : "";
    return [
      `\`${session.id}\`${marker}`,
      formatSessionTimestamp(session.updatedAt),
      String(session.entryCount),
      escapeTableCell(session.currentModelId),
      escapeTableCell(session.title ?? ""),
    ];
  });

  return [
    `Project: ${formatCwd(process.cwd())}`,
    "",
    "| Session | Updated | Entries | Model | Title |",
    "|---|---|---:|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "Use `/resume <session-id>` to resume a session. `*` marks the active session.",
  ].join("\n");
}

function formatSessionTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

async function handleCommand(command: string): Promise<boolean> {
  const [name, ...args] = command.split(/\s+/);

  switch (name) {
    case "/new":
      activateSession(createSession(process.cwd(), currentModelId));
      return true;
    case "/exit":
    case "/quit": {
      await shutdownMcpServers();
      tui.stop();
      process.exit(0);
    }
    case "/model": {
      const requestedModel = args[0];
      if (!requestedModel) {
        tui.addBlock({
          role: "assistant",
          title: "Model",
          content: `Current model: ${formatCurrentModelSelection()}\n\nCycle models:\n${formatModelList()}\n\nUsage: /model <model-id>[:variant]`,
        });
        return true;
      }

      const resolved = parseModelSelection(requestedModel);
      if (!resolved) {
        tui.addBlock({
          role: "error",
          title: "Unknown model",
          content: `Unknown model: ${requestedModel}\n\nUse a full model id in the form provider/model or provider/model:variant.\n\nCycle models:\n${formatModelList()}`,
        });
        return true;
      }

      selectModelSelection(resolved);
      tui.addBlock({ role: "assistant", title: "Model", content: `Model changed to ${formatCurrentModelSelection()}.` });
      return true;
    }
    case "/models": {
      tui.openModelOverlay();
      return true;
    }
    case "/variants":
    case "/variant": {
      const requestedVariant = args[0];
      if (!requestedVariant) {
        tui.addBlock({ role: "assistant", title: "Variants", content: formatVariantList() });
        return true;
      }

      if (!getModelVariant(currentModelId, requestedVariant)) {
        tui.addBlock({
          role: "error",
          title: "Unknown variant",
          content: `Unknown variant for ${currentModelId}: ${requestedVariant}\n\n${formatVariantList()}`,
        });
        return true;
      }

      lastVariantByModelId.set(currentModelId, requestedVariant);
      activeSession = {
        ...activeSession,
        currentModelId,
        currentModelVariant: requestedVariant,
        updatedAt: new Date().toISOString(),
      };
      tui.setModel(formatCurrentModelSelection());
      tui.addBlock({ role: "assistant", title: "Variant", content: `Variant changed to ${formatCurrentModelSelection()}.` });
      return true;
    }
    case "/sessions": {
      const sessions = await listSessions(process.cwd());
      tui.openSessionOverlay(sessions.map((session) => ({
        id: session.id,
        updatedAt: session.updatedAt,
        entryCount: session.entryCount,
        currentModelId: session.currentModelId,
        title: session.title,
        isActive: session.id === activeSession.id,
      })));
      return true;
    }
    case "/resume": {
      const sessionId = args[0];
      if (!sessionId) {
        tui.addBlock({ role: "error", title: "Error", content: "Usage: /resume <session-id>" });
        return true;
      }

      await resumeSessionById(sessionId);
      return true;
    }
    case "/undo": {
      const previousActiveEntryId = activeSession.activeEntryId;
      const nextSession = undoLastUserTurn(activeSession);

      if (nextSession.activeEntryId === previousActiveEntryId) {
        tui.addBlock({ role: "assistant", title: "Undo", content: "No user turn to undo." });
        return true;
      }

      activeSession = nextSession;
      await saveSession(activeSession);
      rebuildTuiFromSession();
      refreshSessionStatsFromSession();
      tui.addBlock({ role: "assistant", title: "Undo", content: "Rewound to before the last user message." });
      return true;
    }
    case "/skills": {
      const skills = await discoverSkills();
      tui.addBlock({
        role: "assistant",
        title: "Skills",
        content: formatSkillsListing(skills),
      });
      return true;
    }
    case "/mcp": {
      tui.addBlock({
        role: "assistant",
        title: "MCP Servers",
        content: formatMcpListing(),
      });
      return true;
    }
    default: {
      // Handle /skill:<name> [args]
      if (name && name.startsWith("/skill:")) {
        const skillName = name.slice("/skill:".length);
        if (!skillName) {
          tui.addBlock({ role: "error", title: "Error", content: "Usage: /skill:<name> [arguments]" });
          return true;
        }

        const skills = await discoverSkills();
        const skill = findSkill(skills, skillName);
        if (!skill) {
          tui.addBlock({
            role: "error",
            title: "Unknown skill",
            content: `Unknown skill: ${skillName}\n\nUse /skills to see available skills.`,
          });
          return true;
        }

        let content = await loadSkillContent(skill);
        const skillArgs = args.join(" ");
        if (skillArgs) {
          content = content.replaceAll("$ARGUMENTS", skillArgs);
        }

        // Inject the skill content as a user message and prompt
        if (promptRunning) {
          tui.setStatus("Agent is still running");
          return true;
        }

        promptRunning = true;
        tui.setRunning(true, "reasoning");
        const startTime = Date.now();

        try {
          const displayText = skillArgs
            ? `/skill:${skillName} ${skillArgs}`
            : `/skill:${skillName}`;
          await prompt(displayText, [{ type: "text", text: content }]);
        } catch (error: unknown) {
          tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
        } finally {
          promptRunning = false;
          tui.setRunning(false, "idle");
          if (!tui.isFocused) {
            const elapsedSec = Math.round((Date.now() - startTime) / 1000);
            sendDesktopNotification("Pace", `Agent finished in ${elapsedSec}s.`);
          }
        }

        return true;
      }

      tui.addBlock({ role: "error", title: "Unknown command", content: `Unknown command: ${name}` });
      return true;
    }
  }
}

async function handlePasteImage(): Promise<void> {
  if (pasteInFlight) return;
  pasteInFlight = true;

  try {
    const clipboardImage = await readClipboardImage();
    if (!clipboardImage) {
      // No image on clipboard — do nothing silently
      return;
    }

    if (clipboardImage.data.length > MAX_IMAGE_BYTES) {
      tui.setStatus("Image too large (max 5 MB)");
      return;
    }

    const base64Data = clipboardImage.data.toString("base64");
    const encodedSize = base64Data.length;
    const existingPayload = estimateExistingImagePayload();
    const pendingPayload = estimatePendingImagePayload();

    if (existingPayload + pendingPayload + encodedSize > MAX_REQUEST_BYTES) {
      tui.setStatus("Total image payload too large — consider /new");
      return;
    }

    clipboardCounter += 1;
    const attachment: ImageAttachment = {
      mediaType: clipboardImage.mediaType,
      data: base64Data,
      rawSize: clipboardImage.data.length,
      label: `clipboard-${clipboardCounter}`,
    };

    pendingImages.push(attachment);
    tui.setImageCount(pendingImages.length);
  } catch {
    // Clipboard subprocess failure — swallow silently
  } finally {
    pasteInFlight = false;
  }
}

type ParsedUserInput = {
  displayText: string;
  contentBlocks: (ImageBlock | { type: "text"; text: string })[];
  error?: string;
};

function stripExistingFileRef(fullMatch: string, rawPath: string): string {
  if (rawPath.startsWith("image(")) return fullMatch;
  const filePath = resolve(expandHomePath(rawPath));
  if (existsSync(filePath)) {
    return rawPath;
  }
  return fullMatch;
}

async function parseUserInput(raw: string): Promise<ParsedUserInput> {
  const images: ImageAttachment[] = [...pendingImages];
  let displayText = raw;
  let modelText = raw;

  // Replace @file references with bare file names if the file exists
  displayText = displayText.replace(/(?<!\S)@([^\s]+)/g, stripExistingFileRef);
  modelText = modelText.replace(/(?<!\S)@([^\s]+)/g, stripExistingFileRef);

  // Process @image(...) references
  const imageRefMatches = Array.from(raw.matchAll(IMAGE_REF_PATTERN));
  for (const match of imageRefMatches) {
    const rawPath = match[1].trim();
    const filePath = resolve(expandHomePath(rawPath));
    const mime = mimeFromExtension(filePath);

    if (!mime) {
      return { displayText: raw, contentBlocks: [], error: `Unsupported image format: ${rawPath}` };
    }

    if (!existsSync(filePath)) {
      return { displayText: raw, contentBlocks: [], error: `Image not found: ${rawPath}` };
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_IMAGE_BYTES) {
        return { displayText: raw, contentBlocks: [], error: `Image too large: ${rawPath} (max 5 MB)` };
      }

      const data = await readFile(filePath);
      const label = rawPath.split("/").pop() ?? rawPath;
      images.push({
        mediaType: mime,
        data: data.toString("base64"),
        rawSize: data.length,
        label,
      });

      // Remove @image(...) from model text, replace with label in display
      modelText = modelText.replace(match[0], "");
      displayText = displayText.replace(match[0], `[Image: ${label}]`);
    } catch {
      return { displayText: raw, contentBlocks: [], error: `Failed to read image: ${rawPath}` };
    }
  }

  // Process bare image file paths
  const bareMatches = Array.from(modelText.matchAll(BARE_IMAGE_PATH_PATTERN));
  for (const match of bareMatches) {
    const rawPath = match[1].trim();
    const filePath = resolve(expandHomePath(rawPath));
    const mime = mimeFromExtension(filePath);

    if (!mime || !existsSync(filePath)) {
      continue; // Not a valid image path — leave as text
    }

    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_IMAGE_BYTES) {
        return { displayText: raw, contentBlocks: [], error: `Image too large: ${rawPath} (max 5 MB)` };
      }

      const data = await readFile(filePath);
      const label = rawPath.split("/").pop() ?? rawPath;
      images.push({
        mediaType: mime,
        data: data.toString("base64"),
        rawSize: data.length,
        label,
      });
      // Bare paths are left in model text — just attach the image in addition
    } catch {
      // Silently skip unreadable bare paths
    }
  }

  // Replace @file.txt mentions with just file.txt when the file exists
  for (const match of Array.from(modelText.matchAll(FILE_REF_PATTERN))) {
    const rawPath = match[1];
    const filePath = resolve(expandHomePath(rawPath));
    if (existsSync(filePath)) {
      modelText = modelText.replace(match[0], rawPath);
      displayText = displayText.replace(match[0], rawPath);
    }
  }

  // Check aggregate size
  const existingPayload = estimateExistingImagePayload();
  let newPayload = 0;
  for (const img of images) {
    newPayload += estimateBase64Size(img.rawSize);
  }
  if (existingPayload + newPayload > MAX_REQUEST_BYTES) {
    return { displayText: raw, contentBlocks: [], error: "Total image payload too large. Start /new or remove images." };
  }

  // Build content blocks — images before text (Anthropic recommendation)
  const contentBlocks: (ImageBlock | { type: "text"; text: string })[] = [];

  for (const img of images) {
    contentBlocks.push({
      type: "image" as const,
      mediaType: img.mediaType,
      data: img.data,
    });
  }

  // Add display labels for clipboard images
  for (const img of pendingImages) {
    displayText = `[Image: ${img.label}] ${displayText}`;
  }

  const cleanedModelText = modelText.replace(/\s+/g, " ").trim();
  if (cleanedModelText) {
    contentBlocks.push({ type: "text" as const, text: cleanedModelText });
  }

  return { displayText: displayText.trim(), contentBlocks };
}

function ensureToolBlock(
  toolBlocks: Map<string, number>,
  toolUseId: string,
  toolName: string,
): number {
  const existing = toolBlocks.get(toolUseId);
  if (existing !== undefined) {
    return existing;
  }

  const id = tui.addBlock({
    role: "tool",
    title: visualizeToolTitle(toolName, {}),
    content: "",
    state: "running",
  });
  toolBlocks.set(toolUseId, id);
  return id;
}

function isToolUseBlock(block: ProviderContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function makeToolErrorResult(toolUseId: string, text: string): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: true,
    content: [{ type: "text", text }],
  };
}

async function executeToolUseBlock(
  contentBlock: ToolUseBlock,
  toolBlocks: Map<string, number>,
  signal: AbortSignal,
): Promise<ToolResultContent> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const toolToExecute = tools.find((tool) => tool.name === contentBlock.name);
  const blockId = ensureToolBlock(toolBlocks, contentBlock.id, contentBlock.name);

  if (!toolToExecute) {
    const errorText = `Couldn't find tool ${contentBlock.name}`;
    tui.updateBlock(blockId, { content: errorText, state: "error" });
    return makeToolErrorResult(contentBlock.id, errorText);
  }

  const inputParseResult = toolToExecute.inputSchema.safeParse(contentBlock.input);
  if (!inputParseResult.success) {
    const errorText =
      `Input did not match schema:\n${JSON.stringify(inputParseResult.error.issues, null, 2)}\n\n` +
      `Received input:\n${JSON.stringify(contentBlock.input, null, 2)}`;

    tui.updateBlock(blockId, {
      title: visualizeToolTitle(contentBlock.name, contentBlock.input),
      content: errorText,
      state: "error",
    });

    return makeToolErrorResult(
      contentBlock.id,
      `Input did not match schema: ${JSON.stringify(inputParseResult.error.issues)}`,
    );
  }

  tui.updateBlock(blockId, { title: visualizeToolTitle(contentBlock.name, inputParseResult.data) });
  tui.setStatus(`Using tool: ${contentBlock.name}`);

  try {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const rawToolOutput = await toolToExecute.execute(inputParseResult.data, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const toolOutput = toolToExecute.truncateOutput === false
      ? rawToolOutput
      : await truncateToolOutputIfNeeded(rawToolOutput, contentBlock.name, contentBlock.id);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const showContent = toolToExecute.showContent !== false || toolOutput.is_error;
    tui.updateBlock(blockId, {
      content: showContent ? formatToolResultBody(toolOutput) : "",
      state: toolOutput.is_error ? "error" : "done",
    });

    return {
      type: "tool_result",
      tool_use_id: contentBlock.id,
      content: toolOutput.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => ({ type: "text" as const, text: p.text })),
      ...(toolOutput.is_error && { is_error: true }),
    };
  } catch (error: unknown) {
    if (isAbortError(error)) throw error;
    const errorText = formatError(error);
    tui.updateBlock(blockId, { content: errorText, state: "error" });
    return makeToolErrorResult(contentBlock.id, errorText);
  } finally {
    refreshCwd();
  }
}

async function executeToolUseBatch(
  toolUseBlocks: ToolUseBlock[],
  toolBlocks: Map<string, number>,
  signal: AbortSignal,
  onComplete: (toolUseId: string, result: ToolResultContent) => void,
): Promise<ToolResultContent[]> {
  const hasExclusiveTool = toolUseBlocks.some((contentBlock) => {
    const toolToExecute = tools.find((tool) => tool.name === contentBlock.name);
    return toolToExecute?.concurrency !== "safe";
  });

  const runOne = async (contentBlock: ToolUseBlock): Promise<ToolResultContent> => {
    const result = await executeToolUseBlock(contentBlock, toolBlocks, signal);
    onComplete(contentBlock.id, result);
    return result;
  };

  if (hasExclusiveTool) {
    const results: ToolResultContent[] = [];
    for (const contentBlock of toolUseBlocks) {
      results.push(await runOne(contentBlock));
    }
    return results;
  }

  return Promise.all(toolUseBlocks.map((contentBlock) => runOne(contentBlock)));
}

async function handleUserInput(userMessage: string) {
  if (userMessage.startsWith("/")) {
    await handleCommand(userMessage.trim());
    return;
  }

  if (userMessage.startsWith("!")) {
    const command = userMessage.slice(1).trim();
    if (!command) {
      tui.addBlock({ role: "error", title: "Error", content: "No command provided after `!`." });
      return;
    }

    const bashTool = tools.find((t) => t.name === "bash");
    if (!bashTool) {
      tui.addBlock({ role: "error", title: "Error", content: "bash tool not found." });
      return;
    }

    tui.addBlock({ role: "user", content: userMessage });

    const blockId = tui.addBlock({ role: "tool", title: `bash: ${command}`, content: "", state: "running" });

    try {
      const rawOutput = await bashTool.execute({ command }, undefined);
      const output = await truncateToolOutputIfNeeded(rawOutput, "bash");
      const content = formatToolResultBody(output);
      tui.updateBlock(blockId, { content, state: output.is_error ? "error" : "done" });
    } catch (error: unknown) {
      tui.updateBlock(blockId, { content: formatError(error), state: "error" });
    } finally {
      refreshCwd();
    }

    return;
  }

  if (promptRunning) {
    tui.setStatus("Agent is still running");
    return;
  }

  promptRunning = true;
  tui.setRunning(true, "reasoning");

  const startTime = Date.now();

  try {
    // Parse user input for images
    const parsed = await parseUserInput(userMessage);

    if (parsed.error) {
      tui.addBlock({ role: "error", title: "Error", content: parsed.error });
      // Keep pending images so the user can fix text or change model
      promptRunning = false;
      tui.setRunning(false, "idle");
      return;
    }

    const hasImages = parsed.contentBlocks.some((b) => b.type === "image");

    // Check model vision capability
    if (hasImages && !currentModelConfig().supportsImages) {
      tui.addBlock({
        role: "error",
        title: "Error",
        content: `Current model does not support image input: ${currentModelId}`,
      });
      // Keep pending images so the user can switch model
      promptRunning = false;
      tui.setRunning(false, "idle");
      return;
    }

    // Check existing image payload in conversation history
    if (hasImages) {
      const existingPayload = estimateExistingImagePayload();
      if (existingPayload > MAX_REQUEST_BYTES * 0.8) {
        tui.addBlock({
          role: "error",
          title: "Error",
          content: "Conversation image payload is too large. Start /new or use fewer images.",
        });
        promptRunning = false;
        tui.setRunning(false, "idle");
        return;
      }
    }

    // Clear pending images on successful parse
    pendingImages = [];
    tui.setImageCount(0);

    await prompt(parsed.displayText, parsed.contentBlocks);
  } catch (error: unknown) {
    tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
  } finally {
    promptRunning = false;
    tui.setRunning(false, "idle");
    if (!tui.isFocused) {
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      sendDesktopNotification("Pace", `Agent finished in ${elapsedSec}s.`);
    }
  }
}

async function prompt(
  displayText: string,
  contentBlocks?: (ImageBlock | { type: "text"; text: string })[],
) {
  tui.addBlock({ role: "user", content: displayText });
  const turnDraft = createTurnDraft(activeSession);
  let turnDraftCommitted = false;

  const commitAndSaveTurnDraft = async () => {
    if (turnDraftCommitted) {
      return;
    }

    activeSession = commitTurnDraft(activeSession, turnDraft);
    turnDraftCommitted = true;
    await saveSession(activeSession);
  };

  appendTurnDraftEntry(turnDraft, createUserEntry({
    content: contentBlocks && contentBlocks.length > 0
      ? contentBlocks
      : [{ type: "text", text: displayText }],
  }));

  const abortController = new AbortController();
  currentAbortController = abortController;
  const signal = abortController.signal;

  let assistantMessagePushed = false;
  let anyAssistantMessagePushed = false;
  let pendingToolUseIds: string[] = [];
  let currentToolUseOrder: string[] = [];
  let completedToolResults = new Map<string, ToolResultContent>();
  let acceptToolResults = true;
  let currentToolBlocks = new Map<string, number>();

  const appendToolResultToDraft = (toolResult: ToolResultContent) => {
    appendTurnDraftEntry(turnDraft, createToolResultEntry({
      toolUseId: toolResult.tool_use_id,
      content: toolResult.content,
      ...(toolResult.is_error && { isError: true }),
    }));
  };

  const [agentsFileContents, skills] = await Promise.all([
    loadAgentsFile(),
    discoverSkills(),
  ]);

  // Update the skill tool with the current set of skills
  setCurrentSkills(skills);

  const baseSystem = `You are Pace, a highly capable coding agent designed to assist with software development tasks.\n\nCurrent working directory: ${formatCwd(process.cwd())}\n\nCurrent date (YYYY-MM-DD): ${new Date().toISOString().split("T")[0]}\n\nWhen operating on files or directories in the current working directory, use relative paths rather than absolute paths.\n\nWhen listing files, use \`/bin/ls -1\` to show only filenames (one per line, no icons or extra info). Only add flags like \`-la\` if the user explicitly asks for more details.\n\nWhen searching files with Bash, prefer \`rg\`/\`rg --files\` over \`grep -R\`, \`find .\`, or \`ls -R\` because ripgrep respects \`.gitignore\`; do not run unbounded recursive searches, and if \`rg\` is unavailable explicitly exclude \`node_modules\`, \`.git\`, \`dist\`, \`build\`, \`coverage\`, \`.next\`, and \`vendor\`.`;

  // Build system text: base → skills → MCP → AGENTS.md
  const skillsBlock = formatSkillsSystemPromptBlock(skills);
  let systemText = baseSystem;
  if (skillsBlock) {
    systemText += `\n\n---\n\n${skillsBlock}`;
  }

  // Mention active MCP servers so the model knows they're available
  const mcpServers = getConnectedMcpServers();
  if (mcpServers.length > 0) {
    const mcpLines = mcpServers.map(
      (s) => `  - ${s.name} (${s.tools.length} tool${s.tools.length === 1 ? "" : "s"})`,
    );
    systemText +=
      `\n\n---\n\nAvailable MCP servers:\n${mcpLines.join("\n")}\n\n` +
      `MCP tools are named mcp__<server>__<tool>. Use them when they are relevant to the task.`;
  }

  if (agentsFileContents) {
    systemText += `\n\n---\n\n# Project-specific instructions (from AGENTS.md)\n\n${agentsFileContents}`;
  }

  const modelConfig = currentModelConfig();
  const modelVariant = currentModelVariant();
  const provider = getProvider(modelConfig);
  const toolDefs = getProviderToolDefinitions();

  try {
    while (true) {
      tui.setStatus("Thinking");

      const stream: ProviderStream = await provider.stream({
        model: modelConfig.providerModel,
        system: systemText,
        messages: sessionToProviderMessages(activeSession, turnDraft),
        tools: toolDefs,
        maxTokens: modelConfig.maxOutputTokens,
        ...(modelVariant?.providerOptions && { providerOptions: modelVariant.providerOptions }),
        signal,
      });

      let currentTextBlockId: number | undefined;
      let accText = "";
      let currentReasoningBlockId: number | undefined;
      let accReasoning = "";
      let currentReasoningTitle: string | undefined;
      const reasoningBlocks: ThinkingBlock[] = [];
      const finishReasoningBlock = () => {
        if (currentReasoningBlockId === undefined) {
          return;
        }

        if (accReasoning) {
          reasoningBlocks.push({ type: "thinking", thinking: accReasoning });
        }

        tui.updateBlock(currentReasoningBlockId, {
          title: reasoningDisplayTitle(accReasoning),
          collapsed: true,
        });
        currentReasoningBlockId = undefined;
        accReasoning = "";
        currentReasoningTitle = undefined;
      };
      const streamingTools = new Map<string, { name: string; inputJson: string }>();
      const toolBlocks = new Map<string, number>();
      currentToolBlocks = toolBlocks;

      for await (const event of stream) {
        switch (event.type) {
          case "text_start": {
            finishReasoningBlock();
            accText = event.text;
            currentTextBlockId = tui.addBlock({
              role: "assistant",
              content: accText,
            });
            tui.setStatus("Streaming response");
            break;
          }

          case "text_delta": {
            finishReasoningBlock();
            accText += event.text;
            if (currentTextBlockId === undefined) {
              currentTextBlockId = tui.addBlock({
                role: "assistant",
                content: accText,
              });
            } else {
              tui.updateBlock(currentTextBlockId, accText);
            }
            tui.setStatus("Streaming response");
            break;
          }

          case "reasoning_start": {
            currentTextBlockId = undefined;
            accText = "";
            accReasoning = event.text;
            currentReasoningTitle = reasoningTitle(accReasoning) ?? undefined;
            currentReasoningBlockId = tui.addBlock({
              role: "reasoning",
              title: reasoningDisplayTitle(accReasoning),
              content: reasoningDisplayContent(accReasoning),
              collapsed: false,
            });
            tui.setStatus("Reasoning");
            break;
          }

          case "reasoning_delta": {
            currentTextBlockId = undefined;
            accText = "";
            accReasoning += event.text;
            const discoveredTitle = reasoningTitle(accReasoning);
            if (discoveredTitle && discoveredTitle !== currentReasoningTitle) {
              currentReasoningTitle = discoveredTitle;
            }
            if (currentReasoningBlockId === undefined) {
              currentReasoningBlockId = tui.addBlock({
                role: "reasoning",
                title: reasoningDisplayTitle(accReasoning),
                content: reasoningDisplayContent(accReasoning),
                collapsed: false,
              });
            } else {
              tui.updateBlock(currentReasoningBlockId, {
                content: reasoningDisplayContent(accReasoning),
                title: reasoningDisplayTitle(accReasoning),
              });
            }
            tui.setStatus("Thinking");
            break;
          }

          case "tool_use_start": {
            streamingTools.set(event.id, { name: event.name, inputJson: "" });
            currentTextBlockId = undefined;
            accText = "";
            finishReasoningBlock();
            ensureToolBlock(toolBlocks, event.id, event.name);
            tui.setStatus(`Preparing tool: ${event.name}`);
            break;
          }

          case "tool_input_delta": {
            const state = streamingTools.get(event.id);
            if (state) {
              state.inputJson += event.partialJson;
              const id = ensureToolBlock(toolBlocks, event.id, state.name);
              tui.updateBlock(id, { title: visualizeToolPartialTitle(state.name, state.inputJson) });
            }
            break;
          }

          case "block_stop": {
            if (event.id) {
              streamingTools.delete(event.id);
            } else {
              finishReasoningBlock();
              currentTextBlockId = undefined;
              accText = "";
            }
            break;
          }
        }
      }

      finishReasoningBlock();

      const response = await stream.finalMessage();

      // Update usage tracking
      lastCacheReadTokens = response.usage.cacheReadTokens;
      lastCacheCreationTokens = response.usage.cacheCreationTokens;
      lastInputTokens = response.usage.inputTokens;
      lastOutputTokens = response.usage.outputTokens;

      const callCost = computeCallCost(
        modelConfig,
        response.usage.inputTokens,
        // For cost: use inputTokens minus cache tokens for the base input cost
        response.usage.inputTokens - response.usage.cacheCreationTokens - response.usage.cacheReadTokens,
        response.usage.cacheCreationTokens,
        response.usage.cacheReadTokens,
        response.usage.outputTokens,
      );
      accumulatedCost += callCost;

      updateContextInfo();

      const assistantContent: SessionContentBlock[] = [...reasoningBlocks, ...response.content];
      appendTurnDraftEntry(turnDraft, createAssistantEntry({
        content: assistantContent,
        provider: modelConfig.provider,
        modelId: modelConfig.id,
        ...(modelVariant?.id !== undefined && { modelVariant: modelVariant.id }),
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheCreationTokens: response.usage.cacheCreationTokens,
        cost: callCost,
        ...(response.providerMetadata !== undefined && { providerMetadata: response.providerMetadata }),
      }));
      assistantMessagePushed = true;
      anyAssistantMessagePushed = true;

      // Collect and execute tool calls. Results are returned as one grouped
      // user message so every tool_use in this assistant turn is answered
      // together, even when execution happens in parallel.
      const toolUseBlocks = response.content.filter(isToolUseBlock);
      pendingToolUseIds = toolUseBlocks.map((block) => block.id);
      currentToolUseOrder = pendingToolUseIds;
      completedToolResults = new Map<string, ToolResultContent>();
      acceptToolResults = true;

      if (toolUseBlocks.length > 0) {
        const toolResults = await executeToolUseBatch(
          toolUseBlocks,
          toolBlocks,
          signal,
          (toolUseId, toolResult) => {
            if (!acceptToolResults) return;
            completedToolResults.set(toolUseId, toolResult);
            pendingToolUseIds = pendingToolUseIds.filter((id) => id !== toolUseId);
          },
        );

        for (const toolResult of toolResults) {
          appendToolResultToDraft(toolResult);
        }
        currentToolUseOrder = [];
        completedToolResults = new Map<string, ToolResultContent>();
      }

      if (toolUseBlocks.length > 0 || response.stopReason === "tool_use") {
        assistantMessagePushed = false;
        pendingToolUseIds = [];
        continue;
      }

      break;
    }

    await commitAndSaveTurnDraft();
  } catch (error: unknown) {
    if (isAbortError(error)) {
      acceptToolResults = false;
      // Mark any in-progress tool blocks as cancelled
      for (const [toolUseId, blockId] of currentToolBlocks) {
        if (pendingToolUseIds.includes(toolUseId)) {
          tui.updateBlock(blockId, { content: "Cancelled", state: "error" });
        }
      }

      if (assistantMessagePushed && pendingToolUseIds.length > 0) {
        for (const toolUseId of currentToolUseOrder) {
          const toolResult = completedToolResults.get(toolUseId)
            ?? makeToolErrorResult(toolUseId, "Cancelled by user");
          appendToolResultToDraft(toolResult);
        }
      }

      if (anyAssistantMessagePushed && !isTurnDraftEmpty(turnDraft)) {
        await commitAndSaveTurnDraft();
      }

      tui.addBlock({
        role: "assistant",
        title: "Cancelled",
        content: "Prompt execution cancelled.",
      });
      return;
    }
    if (!turnDraftCommitted && !isTurnDraftEmpty(turnDraft)) {
      await commitAndSaveTurnDraft();
    }
    throw error;
  } finally {
    currentAbortController = null;
  }
}

const exampleTable = `| Command | Description |
|---|---|
| /new | Start a new conversation, clearing all history and context. |
| /model <model-id>[:variant] | Switch to a different model. Use without arguments to list available models. |
| /variant [variant] | Show or switch the current model's variant. |
| /sessions | List saved sessions for the current project. |
| /resume <session-id> | Resume a saved session by id. |
| /undo | Rewind to before the last user message. |
| /skills | List discovered skills available in the current directory. |
| /mcp | List connected MCP servers and their tools. |
| /skill:<name> [args] | Run a discovered skill with optional arguments. Use /skills to see available skills.`;

async function main() {
  tui.start();

  try {
    const paceConfig = await loadPaceConfig();
    tui.setCostDisplayConfig(paceConfig.cost);
    applyConfiguredModels(paceConfig);
  } catch (error) {
    tui.addBlock({ role: "error", title: "Pace config", content: formatError(error) });
  }

  updateContextInfo();

  // Initialise Shiki in the background. The hand-rolled tokenizer remains
  // active until the promise resolves, then Shiki takes over automatically.
  initHighlighter().catch(() => {
    // Non-fatal — hand-rolled highlighting stays active.
  });

  // tui.addBlock({
  //   role: "assistant",
  //   title: "Example table below",
  //   content: exampleTable
  // });

  onEvent("rate-limit-retry", (event) => {
    const seconds = (event.waitMs / 1000).toFixed(1);
    tui.setStatus(`Rate limited on ${new URL(event.url).hostname}, retrying in ${seconds}s… (${event.attempt}/${event.maxRetries})`);
  });

  // Initialize MCP servers
  try {
    const { connected, errors } = await initMcpServers();
    if (connected.length > 0) {
      const serverNames = connected.map((s) => s.name).join(", ");
      const totalTools = connected.reduce((sum, s) => sum + s.tools.length, 0);
      tui.setStatus(`MCP: connected to ${connected.length} server(s) (${totalTools} tools): ${serverNames}`);
    }
    for (const err of errors) {
      tui.addBlock({
        role: "error",
        title: `MCP: ${err.name}`,
        content: err.error,
      });
    }
  } catch {
    // MCP init errors are already handled above; don't crash the app.
  }
}

process.on("uncaughtException", (error: unknown) => {
  tui.addBlock({ role: "error", title: "Uncaught exception", content: formatError(error) });
  tui.setRunning(false, "idle");
});

process.on("unhandledRejection", (reason: unknown) => {
  tui.addBlock({ role: "error", title: "Unhandled rejection", content: formatError(reason) });
  tui.setRunning(false, "idle");
});

main();
