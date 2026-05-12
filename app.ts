import Anthropic from "@anthropic-ai/sdk";
import assert from "assert";
import { readFile } from "fs/promises";
import { join } from "path";
import { Tui } from "./tui";
import { tools, toolsTransformedToAnthropicStyle, visualizeToolTitle, visualizeToolPartialTitle, formatToolResultBody, isAbortError } from "./tool";

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

const AVAILABLE_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
] as const;

const MODEL_ALIASES: Record<string, (typeof AVAILABLE_MODELS)[number]> = {
  "haiku": "claude-haiku-4-5",
  "sonnet": "claude-sonnet-4-6",
  "opus": "claude-opus-4-6",
};

const MODEL_CONTEXT_WINDOW: Record<(typeof AVAILABLE_MODELS)[number], number> = {
  "claude-haiku-4-5": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-6": 1_000_000,
};

const DEFAULT_MODEL = "claude-haiku-4-5";

let currentModel: (typeof AVAILABLE_MODELS)[number] = DEFAULT_MODEL;

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];
function cancelPrompt() {
  if (!promptRunning || !currentAbortController) return;
  currentAbortController.abort();
}

const tui = new Tui({ onSubmit: handleUserInput, onTab: cycleModel, onEscape: cancelPrompt, model: DEFAULT_MODEL, cwd: process.cwd() });

let promptRunning = false;
let currentAbortController: AbortController | null = null;
let lastInputTokens = 0;
let lastOutputTokens = 0;
let lastCacheReadTokens = 0;
let lastCacheCreationTokens = 0;

function updateContextInfo() {
  const contextWindow = MODEL_CONTEXT_WINDOW[currentModel];
  // The used tokens represent the context size of the *last* API call.
  // input_tokens from the API already includes the full conversation history
  // (including cache_creation_input_tokens and cache_read_input_tokens),
  // so adding output_tokens gives us the total context size.
  const usedTokens = lastInputTokens + lastOutputTokens;
  tui.setContextInfo({
    usedTokens,
    contextWindow,
    cacheReadTokens: lastCacheReadTokens,
    cacheCreationTokens: lastCacheCreationTokens,
  });
}

function refreshCwd() {
  tui.setCwd(process.cwd());
}

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function resolveModel(input: string): (typeof AVAILABLE_MODELS)[number] | undefined {
  if (AVAILABLE_MODELS.includes(input as (typeof AVAILABLE_MODELS)[number])) {
    return input as (typeof AVAILABLE_MODELS)[number];
  }
  return MODEL_ALIASES[input.toLowerCase()];
}

function cycleModel() {
  const currentIndex = AVAILABLE_MODELS.indexOf(currentModel);
  const nextIndex = (currentIndex + 1) % AVAILABLE_MODELS.length;
  currentModel = AVAILABLE_MODELS[nextIndex];
  tui.setModel(currentModel);
  updateContextInfo();
}

function formatModelList() {
  const aliasLookup = new Map<string, string[]>();
  for (const [alias, modelId] of Object.entries(MODEL_ALIASES)) {
    const existing = aliasLookup.get(modelId) ?? [];
    existing.push(alias);
    aliasLookup.set(modelId, existing);
  }

  return AVAILABLE_MODELS
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
      tui.clearBlocks();
      updateContextInfo();
      tui.addBlock({
        role: "assistant",
        title: "Agento",
        content: `## New Conversation Started!

Your chat history has been cleared and you're ready to start fresh.

### Quick Reminders
- **Enter** to send messages
- **Ctrl+J** or **Shift+Enter** for newlines
- **Arrow keys** to move cursor in input
- **Alt+Up/Down** to scroll messages
- **Tab** to switch models
- Use **/model** to select a specific model
- **ESC** to cancel the current operation
- **Ctrl+C** to exit`,
      });
      return true;
    case "/model": {
      const requestedModel = args[0];
      if (!requestedModel) {
        tui.addBlock({
          role: "assistant",
          title: "Model",
          content: `Current model: ${currentModel}\n\nAvailable models:\n${formatModelList()}\n\nUsage: /model <model-id>`,
        });
        return true;
      }

      const resolved = resolveModel(requestedModel);
      if (!resolved) {
        tui.addBlock({
          role: "error",
          title: "Unknown model",
          content: `Unknown model: ${requestedModel}\n\nAvailable models:\n${formatModelList()}`,
        });
        return true;
      }

      currentModel = resolved;
      tui.setModel(currentModel);
      updateContextInfo();
      tui.addBlock({ role: "assistant", title: "Model", content: `Model changed to ${currentModel}.` });
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
  messages.push({ role: "user", content: [{ type: "text", text: userMessage }] });

  const abortController = new AbortController();
  currentAbortController = abortController;
  const signal = abortController.signal;

  // Track whether we've pushed an assistant message yet (for cleanup on cancel)
  let assistantMessagePushed = false;
  // Track tool_use IDs from the current assistant response that need tool_results
  let pendingToolUseIds: string[] = [];
  // Track the current set of tool blocks for UI updates on cancel
  let currentToolBlocks = new Map<string, number>();

  // Load AGENTS.md once per prompt invocation so that changes to the file
  // are picked up on the next user message without restarting the agent.
  const agentsFileContents = await loadAgentsFile();

  // Build the system prompt, optionally appending AGENTS.md instructions.
  // We use an explicit cache_control breakpoint on the system prompt so it
  // is always cached across turns. The top-level cache_control on the
  // request body handles automatic caching of the growing conversation.
  const baseSystem = `You are Agento, a highly capable coding agent designed to assist with software development tasks.\n\nCurrent working directory: ${process.cwd()}\n\nWhen listing files, use \`/bin/ls -1\` to show only filenames (one per line, no icons or extra info). Only add flags like \`-la\` if the user explicitly asks for more details.`;
  const systemText = agentsFileContents
    ? `${baseSystem}\n\n---\n\n# Project-specific instructions (from AGENTS.md)\n\n${agentsFileContents}`
    : baseSystem;
  const systemPrompt: Anthropic.TextBlockParam[] = [
    {
      type: "text" as const,
      text: systemText,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  try {
    while (true) {
      tui.setStatus("Thinking");

      const stream = await ant.messages.stream(
        {
          model: currentModel,
          max_tokens: 16_000,
          system: systemPrompt,
          messages,
          tools: toolsTransformedToAnthropicStyle,
          // Automatic caching: the API places a cache breakpoint on the last
          // cacheable block so the growing conversation prefix is reused.
          cache_control: { type: "ephemeral" },
        },
        { signal },
      );

      let currentContentBlockIndex = -1;
      let currentTextBlockId: number | undefined;
      let currentToolUseId: string | undefined;
      let currentToolName: string | undefined;
      let accInputJson = "";
      let accText = "";
      const toolBlocks = new Map<string, number>();
      currentToolBlocks = toolBlocks;

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            assert(currentContentBlockIndex === -1);
            currentContentBlockIndex = event.index;
            currentTextBlockId = undefined;
            currentToolUseId = undefined;
            currentToolName = undefined;
            accInputJson = "";
            accText = "";

            const contentBlock = event.content_block;
            if (contentBlock.type === "text") {
              accText = contentBlock.text ?? "";
              currentTextBlockId = tui.addBlock({
                role: "assistant",
                content: accText,
              });
              tui.setStatus("Streaming response");
            } else if (contentBlock.type === "tool_use") {
              currentToolUseId = contentBlock.id;
              currentToolName = contentBlock.name;
              ensureToolBlock(toolBlocks, contentBlock.id, contentBlock.name);
              tui.setStatus(`Preparing tool: ${contentBlock.name}`);
            }
            break;
          }

          case "content_block_delta":
            switch (event.delta.type) {
              case "text_delta":
                accText += event.delta.text;
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

              case "input_json_delta": {
                accInputJson += event.delta.partial_json;
                if (currentToolUseId && currentToolName) {
                  const id = ensureToolBlock(toolBlocks, currentToolUseId, currentToolName);
                  tui.updateBlock(id, { title: visualizeToolPartialTitle(currentToolName, accInputJson) });
                }
                break;
              }
            }
            break;

          case "content_block_stop":
            assert(event.index === currentContentBlockIndex);
            currentContentBlockIndex = -1;
            currentTextBlockId = undefined;
            currentToolUseId = undefined;
            currentToolName = undefined;
            accInputJson = "";
            accText = "";
            break;
        }
      }

      const response = await stream.finalMessage();
      // The API's input_tokens, cache_creation_input_tokens, and
      // cache_read_input_tokens together represent the total input tokens
      // for the *current* request (the full conversation context).
      // We store the latest values (not cumulative) so the context gauge
      // reflects the actual current context window usage.
      lastCacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
      lastCacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;
      lastInputTokens =
        response.usage.input_tokens +
        lastCacheCreationTokens +
        lastCacheReadTokens;
      lastOutputTokens = response.usage.output_tokens;
      updateContextInfo();
      messages.push({ role: "assistant", content: response.content });
      assistantMessagePushed = true;

      // Collect all tool_use IDs from this response
      const allToolUseIds = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => block.id);
      pendingToolUseIds = [...allToolUseIds];

      for (const contentBlock of response.content) {
        if (contentBlock.type === "text") {
          continue;
        }

        if (contentBlock.type !== "tool_use") {
          tui.addBlock({
            role: "error",
            title: "Unhandled content block",
            content: JSON.stringify(contentBlock, null, 2),
          });
          continue;
        }

        const toolToExecute = tools.find((tool) => tool.name === contentBlock.name);
        if (!toolToExecute) {
          throw new Error(`Couldn't find tool ${contentBlock.name}`);
        }

        const blockId = ensureToolBlock(toolBlocks, contentBlock.id, contentBlock.name);

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
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: contentBlock.id,
                is_error: true,
                content: [{ type: "text", text: `Input did not match schema: ${JSON.stringify(inputParseResult.error.issues)}` }],
              },
            ],
          });
          pendingToolUseIds = pendingToolUseIds.filter((id) => id !== contentBlock.id);
          continue;
        }

        tui.updateBlock(blockId, { title: visualizeToolTitle(contentBlock.name, inputParseResult.data) });
        tui.setStatus(`Using tool: ${contentBlock.name}`);

        try {
          const toolOutput = await toolToExecute.execute(inputParseResult.data, signal);
          const showContent = toolToExecute.showContent !== false || toolOutput.is_error;
          tui.updateBlock(blockId, {
            content: showContent ? formatToolResultBody(toolOutput) : "",
            state: toolOutput.is_error ? "error" : "done",
          });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: contentBlock.id,
                content: toolOutput.content,
                ...(toolOutput.is_error && { is_error: true }),
              },
            ],
          });
          pendingToolUseIds = pendingToolUseIds.filter((id) => id !== contentBlock.id);
        } catch (error: unknown) {
          if (isAbortError(error)) throw error;
          const errorText = formatError(error);
          tui.updateBlock(blockId, { content: errorText, state: "error" });
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: contentBlock.id,
                is_error: true,
                content: [{ type: "text", text: errorText }],
              },
            ],
          });
          pendingToolUseIds = pendingToolUseIds.filter((id) => id !== contentBlock.id);
        } finally {
          refreshCwd();
        }
      }

      if (response.stop_reason === "tool_use") {
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
        // Push synthetic tool_results for any outstanding tool_use IDs
        // to keep the messages array valid for the API
        for (const toolUseId of pendingToolUseIds) {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseId,
                is_error: true,
                content: [{ type: "text", text: "Cancelled by user" }],
              },
            ],
          });
        }
      } else if (!assistantMessagePushed) {
        // We were still streaming (no assistant message pushed yet).
        // Remove the user message we pushed at the top of prompt() so
        // the conversation stays clean.
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
  tui.addBlock({
    role: "assistant",
    title: "Agento",
    content: `## Keyboard Shortcuts
- **Enter** — Send your message
- **Ctrl+J** — Add a newline
- **Arrow keys** — Move cursor in the input field
- **Alt+Left/Right** — Move cursor by word
- **Home/End** — Move to start/end of visual line
- **Alt+Up/Down** — Scroll messages
- **Page Up/Down** — Scroll messages by half page
- **Ctrl+Home/End** — Scroll to top/bottom
- **Delete** — Delete character after cursor
- **Tab** — Cycle through available models
- **ESC** — Cancel current operation
- **Ctrl+C** — Quit the application

## Commands
- **/model** — View or select a different model
- **/new** — Start a new conversation

## Current Working Directory
\`${process.cwd()}\`

Ready to help! Type a message or use a command to get started.`,
  });
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
