import Anthropic from "@anthropic-ai/sdk";
import assert from "assert";
import { parse } from "partial-json";
import { Tui } from "./tui";
import { ToolOutput, tools, toolsTransformedToAnthropicStyle } from "./tool";

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];
const tui = new Tui({ onSubmit: handleUserInput });

let promptRunning = false;

function parsePartialJson(jsonString: string): unknown {
  if (jsonString.length === 0) {
    return {};
  }

  return parse(jsonString);
}

function formatPartialJson(jsonString: string) {
  if (!jsonString.trim()) {
    return "{}";
  }

  try {
    return JSON.stringify(parsePartialJson(jsonString), null, 2);
  } catch {
    return jsonString;
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function formatToolOutput(toolOutput: ToolOutput) {
  return toolOutput.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      return `[${part.type}] ${JSON.stringify(part, null, 2)}`;
    })
    .join("\n\n");
}

function formatToolInput(input: unknown) {
  return JSON.stringify(input, null, 2);
}

function formatToolUse(summary: string, input: unknown) {
  return `${summary}\n\nInput:\n${formatToolInput(input)}`;
}

function handleCommand(command: string): boolean {
  switch (command) {
    case "/new":
      messages.length = 0;
      tui.clearBlocks();
      tui.addBlock({
        role: "assistant",
        title: "Agento",
        content: "New conversation started. Press Enter to send, Ctrl+J or Shift+Enter for a newline. Press Ctrl+C to quit.",
      });
      return true;
    default:
      tui.addBlock({ role: "error", title: "Unknown command", content: `Unknown command: ${command}` });
      return true;
  }
}

async function handleUserInput(userMessage: string) {
  if (userMessage.startsWith("/")) {
    handleCommand(userMessage.trim());
    return;
  }

  if (promptRunning) {
    tui.setStatus("agent is still running");
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
  tui.addBlock({ role: "user", title: "You", content: userMessage });
  messages.push({ role: "user", content: [{ type: "text", text: userMessage }] });

  while (true) {
    tui.setStatus("thinking");

    const stream = await ant.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 16_000,
      messages,
      tools: toolsTransformedToAnthropicStyle,
    });

    let currentContentBlockIndex = -1;
    let currentTextBlockId: number | undefined;
    let currentToolUseId: string | undefined;
    let accInputJson = "";
    let accText = "";
    const toolUseBlocks = new Map<string, number>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          assert(currentContentBlockIndex === -1);
          currentContentBlockIndex = event.index;
          currentTextBlockId = undefined;
          currentToolUseId = undefined;
          accInputJson = "";
          accText = "";

          const contentBlock = event.content_block;
          if (contentBlock.type === "text") {
            accText = contentBlock.text ?? "";
            currentTextBlockId = tui.addBlock({
              role: "assistant",
              title: "Assistant",
              content: accText,
            });
            tui.setStatus("streaming response");
          } else if (contentBlock.type === "tool_use") {
            currentToolUseId = contentBlock.id;
            const blockId = tui.addBlock({
              role: "tool_use",
              title: `Tool: ${contentBlock.name}`,
              content: "Preparing input",
            });
            toolUseBlocks.set(contentBlock.id, blockId);
            tui.setStatus(`preparing tool: ${contentBlock.name}`);
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
                  title: "Assistant",
                  content: accText,
                });
              } else {
                tui.updateBlock(currentTextBlockId, accText);
              }
              tui.setStatus("streaming response");
              break;

            case "input_json_delta": {
              accInputJson += event.delta.partial_json;
              if (currentToolUseId) {
                const blockId = toolUseBlocks.get(currentToolUseId);
                if (blockId !== undefined) {
                  tui.updateBlock(blockId, `Input:\n${formatPartialJson(accInputJson)}`);
                }
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
          accInputJson = "";
          accText = "";
          break;
      }
    }

    const response = await stream.finalMessage();
    messages.push({ role: "assistant", content: response.content });

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

      const inputParseResult = toolToExecute.inputSchema.safeParse(contentBlock.input);
      if (!inputParseResult.success) {
        const errorText =
          `Input did not match schema:\n${JSON.stringify(inputParseResult.error.issues, null, 2)}\n\n` +
          `Received input:\n${JSON.stringify(contentBlock.input, null, 2)}`;

        tui.addBlock({ role: "error", title: `Tool input error: ${contentBlock.name}`, content: errorText });
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
        continue;
      }

      const toolSummary = toolToExecute.stringify(inputParseResult.data);
      const toolUseText = formatToolUse(toolSummary, contentBlock.input);
      const streamedToolBlockId = toolUseBlocks.get(contentBlock.id);
      if (streamedToolBlockId !== undefined) {
        tui.updateBlock(streamedToolBlockId, toolUseText);
      } else {
        tui.addBlock({ role: "tool_use", title: `Tool: ${contentBlock.name}`, content: toolUseText });
      }

      tui.setStatus(`using tool: ${contentBlock.name}`);

      try {
        const toolOutput = await toolToExecute.execute(inputParseResult.data) as ToolOutput;
        tui.addBlock({
          role: "tool_result",
          title: `Tool result: ${contentBlock.name}`,
          content: formatToolOutput(toolOutput),
        });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: contentBlock.id,
              content: toolOutput.content,
            },
          ],
        });
      } catch (error: unknown) {
        const errorText = formatError(error);
        tui.addBlock({ role: "error", title: `Tool failed: ${contentBlock.name}`, content: errorText });
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
      }
    }

    if (response.stop_reason === "tool_use") {
      continue;
    }

    break;
  }
}

async function main() {
  tui.start();
  tui.addBlock({
    role: "assistant",
    title: "Agento",
    content: "Press Enter to send, Ctrl+J or Shift+Enter for a newline. Press Ctrl+C to quit.",
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
