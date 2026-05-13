import { readFile } from "fs/promises";
import { join } from "path";
import { Tui } from "./tui";
import {
  tools,
  visualizeToolTitle,
  visualizeToolPartialTitle,
  formatToolResultBody,
  isAbortError,
  getProviderToolDefinitions,
} from "./tool";
import type {
  Provider,
  ProviderMessage,
  ProviderStream,
  ContentBlock,
  ToolUseBlock,
  ToolResultContent,
  UserMessage,
  AssistantMessage,
} from "./provider";
import {
  MODELS,
  MODEL_ALIASES,
  AVAILABLE_MODEL_IDS,
  DEFAULT_MODEL_ID,
  resolveModelId,
  type ModelConfig,
} from "./provider";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenCodeZenProvider } from "./providers/opencode-zen";
import { OpenAIProvider } from "./providers/openai";

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

// ── Provider instances (lazily created) ──────────────────────────────────────

let anthropicProvider: AnthropicProvider | undefined;
let openCodeZenProvider: OpenCodeZenProvider | undefined;
let openAIProvider: OpenAIProvider | undefined;

function getProvider(config: ModelConfig): Provider {
  switch (config.provider) {
    case "anthropic":
      if (!anthropicProvider) anthropicProvider = new AnthropicProvider();
      return anthropicProvider;
    case "opencode-zen":
      if (!openCodeZenProvider) openCodeZenProvider = new OpenCodeZenProvider();
      return openCodeZenProvider;
    case "openai":
      if (!openAIProvider) openAIProvider = new OpenAIProvider();
      return openAIProvider;
  }
}

// ── Model state ──────────────────────────────────────────────────────────────

let currentModelId: string = DEFAULT_MODEL_ID;

function currentModelConfig(): ModelConfig {
  return MODELS[currentModelId];
}

function cancelPrompt() {
  if (!promptRunning || !currentAbortController) return;
  currentAbortController.abort();
}

const tui = new Tui({ onSubmit: handleUserInput, onTab: cycleModel, onEscape: cancelPrompt, model: DEFAULT_MODEL_ID, cwd: process.cwd() });

let promptRunning = false;
let currentAbortController: AbortController | null = null;
let lastInputTokens = 0;
let lastOutputTokens = 0;
let lastCacheReadTokens = 0;
let lastCacheCreationTokens = 0;
let accumulatedCost = 0;

// ── Conversation state (provider-agnostic) ───────────────────────────────────

const messages: ProviderMessage[] = [];

function computeCallCost(
  config: ModelConfig,
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  outputTokens: number,
): number {
  const pricing = config.pricing;
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

function refreshCwd() {
  tui.setCwd(process.cwd());
}

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function cycleModel() {
  const ids = AVAILABLE_MODEL_IDS;
  const currentIndex = ids.indexOf(currentModelId);
  const nextIndex = (currentIndex + 1) % ids.length;
  currentModelId = ids[nextIndex];
  tui.setModel(currentModelId);
  updateContextInfo();
}

function formatModelList() {
  const aliasLookup = new Map<string, string[]>();
  for (const [alias, modelId] of Object.entries(MODEL_ALIASES)) {
    const existing = aliasLookup.get(modelId) ?? [];
    existing.push(alias);
    aliasLookup.set(modelId, existing);
  }

  return AVAILABLE_MODEL_IDS
    .map((modelId) => {
      const aliases = aliasLookup.get(modelId);
      return aliases ? `${modelId} (${aliases.join(", ")})` : modelId;
    })
    .join("\n");
}

function handleCommand(command: string): boolean {
  const [name, ...args] = command.split(/\s+/);

  switch (name) {
    case "/new":
      messages.length = 0;
      lastInputTokens = 0;
      lastOutputTokens = 0;
      lastCacheReadTokens = 0;
      lastCacheCreationTokens = 0;
      accumulatedCost = 0;
      tui.clearBlocks();
      updateContextInfo();
      return true;
    case "/model": {
      const requestedModel = args[0];
      if (!requestedModel) {
        tui.addBlock({
          role: "assistant",
          title: "Model",
          content: `Current model: ${currentModelId}\n\nAvailable models:\n${formatModelList()}\n\nUsage: /model <model-id>`,
        });
        return true;
      }

      const resolved = resolveModelId(requestedModel);
      if (!resolved) {
        tui.addBlock({
          role: "error",
          title: "Unknown model",
          content: `Unknown model: ${requestedModel}\n\nAvailable models:\n${formatModelList()}`,
        });
        return true;
      }

      currentModelId = resolved;
      tui.setModel(currentModelId);
      updateContextInfo();
      tui.addBlock({ role: "assistant", title: "Model", content: `Model changed to ${currentModelId}.` });
      return true;
    }
    default:
      tui.addBlock({ role: "error", title: "Unknown command", content: `Unknown command: ${name}` });
      return true;
  }
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

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
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
    const toolOutput = await toolToExecute.execute(inputParseResult.data, signal);
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
  onComplete: (toolUseId: string) => void,
): Promise<ToolResultContent[]> {
  const hasExclusiveTool = toolUseBlocks.some((contentBlock) => {
    const toolToExecute = tools.find((tool) => tool.name === contentBlock.name);
    return toolToExecute?.concurrency !== "safe";
  });

  const runOne = async (contentBlock: ToolUseBlock): Promise<ToolResultContent> => {
    const result = await executeToolUseBlock(contentBlock, toolBlocks, signal);
    onComplete(contentBlock.id);
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
    handleCommand(userMessage.trim());
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
      const output = await bashTool.execute({ command }, undefined);
      const content = output.content.map((p) => (p.type === "text" ? p.text : "")).join("\n").trimEnd();
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
  tui.setRunning(true, "thinking");

  try {
    await prompt(userMessage);
  } catch (error: unknown) {
    tui.addBlock({ role: "error", title: "Error", content: formatError(error) });
  } finally {
    promptRunning = false;
    tui.setRunning(false, "idle");
  }
}

async function prompt(userMessage: string) {
  tui.addBlock({ role: "user", content: userMessage });

  const userMsg: UserMessage = {
    role: "user",
    content: [{ type: "text", text: userMessage }],
  };
  messages.push(userMsg);

  const abortController = new AbortController();
  currentAbortController = abortController;
  const signal = abortController.signal;

  let assistantMessagePushed = false;
  let anyAssistantMessagePushed = false;
  let pendingToolUseIds: string[] = [];
  let currentToolBlocks = new Map<string, number>();

  const agentsFileContents = await loadAgentsFile();

  const baseSystem = `You are Agento, a highly capable coding agent designed to assist with software development tasks.\n\nCurrent working directory: ${process.cwd()}\n\nWhen listing files, use \`/bin/ls -1\` to show only filenames (one per line, no icons or extra info). Only add flags like \`-la\` if the user explicitly asks for more details.`;
  const systemText = agentsFileContents
    ? `${baseSystem}\n\n---\n\n# Project-specific instructions (from AGENTS.md)\n\n${agentsFileContents}`
    : baseSystem;

  const modelConfig = currentModelConfig();
  const provider = getProvider(modelConfig);
  const toolDefs = getProviderToolDefinitions();

  try {
    while (true) {
      tui.setStatus("Thinking");

      const stream: ProviderStream = await provider.stream({
        model: modelConfig.id,
        system: systemText,
        messages,
        tools: toolDefs,
        maxTokens: modelConfig.maxOutputTokens,
        signal,
      });

      let currentTextBlockId: number | undefined;
      let accText = "";
      const streamingTools = new Map<string, { name: string; inputJson: string }>();
      const toolBlocks = new Map<string, number>();
      currentToolBlocks = toolBlocks;

      for await (const event of stream) {
        switch (event.type) {
          case "text_start": {
            accText = event.text;
            currentTextBlockId = tui.addBlock({
              role: "assistant",
              content: accText,
            });
            tui.setStatus("Streaming response");
            break;
          }

          case "text_delta": {
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

          case "tool_use_start": {
            streamingTools.set(event.id, { name: event.name, inputJson: "" });
            currentTextBlockId = undefined;
            accText = "";
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
              currentTextBlockId = undefined;
              accText = "";
            }
            break;
          }
        }
      }

      const response = await stream.finalMessage();

      // Update usage tracking
      lastCacheReadTokens = response.usage.cacheReadTokens;
      lastCacheCreationTokens = response.usage.cacheCreationTokens;
      lastInputTokens = response.usage.inputTokens;
      lastOutputTokens = response.usage.outputTokens;

      accumulatedCost += computeCallCost(
        modelConfig,
        // For cost: use inputTokens minus cache tokens for the base input cost
        response.usage.inputTokens - response.usage.cacheCreationTokens - response.usage.cacheReadTokens,
        response.usage.cacheCreationTokens,
        response.usage.cacheReadTokens,
        response.usage.outputTokens,
      );

      updateContextInfo();

      // Push assistant message to conversation
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: response.content,
        ...(response.providerMetadata !== undefined && {
          providerMetadata: response.providerMetadata,
        }),
      };
      messages.push(assistantMsg);
      assistantMessagePushed = true;
      anyAssistantMessagePushed = true;

      // Collect and execute tool calls. Results are returned as one grouped
      // user message so every tool_use in this assistant turn is answered
      // together, even when execution happens in parallel.
      const toolUseBlocks = response.content.filter(isToolUseBlock);
      pendingToolUseIds = toolUseBlocks.map((block) => block.id);

      if (toolUseBlocks.length > 0) {
        const toolResults = await executeToolUseBatch(
          toolUseBlocks,
          toolBlocks,
          signal,
          (toolUseId) => {
            pendingToolUseIds = pendingToolUseIds.filter((id) => id !== toolUseId);
          },
        );

        const toolResultMsg: UserMessage = {
          role: "user",
          content: toolResults,
        };
        messages.push(toolResultMsg);
      }

      if (response.stopReason === "tool_use") {
        assistantMessagePushed = false;
        pendingToolUseIds = [];
        continue;
      }

      break;
    }
  } catch (error: unknown) {
    if (isAbortError(error)) {
      // Mark any in-progress tool blocks as cancelled
      for (const [toolUseId, blockId] of currentToolBlocks) {
        if (pendingToolUseIds.includes(toolUseId)) {
          tui.updateBlock(blockId, { content: "Cancelled", state: "error" });
        }
      }

      if (assistantMessagePushed && pendingToolUseIds.length > 0) {
        const toolResultMsg: UserMessage = {
          role: "user",
          content: pendingToolUseIds.map((toolUseId) => makeToolErrorResult(toolUseId, "Cancelled by user")),
        };
        messages.push(toolResultMsg);
      } else if (!anyAssistantMessagePushed) {
        messages.pop();
      }

      tui.addBlock({
        role: "assistant",
        title: "Cancelled",
        content: "Prompt execution cancelled.",
      });
      return;
    }
    throw error;
  } finally {
    currentAbortController = null;
  }
}

async function main() {
  tui.start();
  updateContextInfo();
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
