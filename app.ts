import Anthropic from "@anthropic-ai/sdk";
import assert from "assert";
import { Tui } from "./tui";
import { tools, toolsTransformedToAnthropicStyle, visualizeToolInput, visualizeToolPartialInput, visualizeToolResult, visualizeToolStart } from "./tool";

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];
const tui = new Tui({ onSubmit: handleUserInput });

let promptRunning = false;

function formatError(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
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

function upsertToolUseBlock(toolUseBlocks: Map<string, number>, toolUseId: string, display: { title?: string; content: string } | undefined) {
  if (!display) {
    return;
  }

  const blockId = toolUseBlocks.get(toolUseId);
  if (blockId !== undefined) {
    tui.updateBlock(blockId, display.content);
    return;
  }

  toolUseBlocks.set(toolUseId, tui.addBlock({ role: "tool_use", ...display }));
}

async function handleUserInput(userMessage: string) {
  if (userMessage.startsWith("/")) {
    handleCommand(userMessage.trim());
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

  while (true) {
    tui.setStatus("Thinking");

    const stream = await ant.messages.stream({
      model: "claude-haiku-4-5",
      max_tokens: 16_000,
      messages,
      tools: toolsTransformedToAnthropicStyle,
    });

    let currentContentBlockIndex = -1;
    let currentTextBlockId: number | undefined;
    let currentToolUseId: string | undefined;
    let currentToolName: string | undefined;
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
            upsertToolUseBlock(toolUseBlocks, contentBlock.id, visualizeToolStart(contentBlock.name));
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
                upsertToolUseBlock(toolUseBlocks, currentToolUseId, visualizeToolPartialInput(currentToolName, accInputJson));
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

      upsertToolUseBlock(toolUseBlocks, contentBlock.id, visualizeToolInput(contentBlock.name, inputParseResult.data));

      tui.setStatus(`Using tool: ${contentBlock.name}`);

      try {
        const toolOutput = await toolToExecute.execute(inputParseResult.data);
        tui.addBlock({ role: "tool_result", ...visualizeToolResult(contentBlock.name, toolOutput) });
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
