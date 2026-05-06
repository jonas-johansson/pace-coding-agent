import Anthropic from "@anthropic-ai/sdk"
import { getUserInput } from "./input"
import { ToolOutput, tools, toolsTransformedToAnthropicStyle } from "./tool";

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];

async function main() {
  console.log("How can I help?");

  while (true) {

    // User
    console.log("\n----------------------------\n")
    const input = await getUserInput("User: ");
    messages.push({ role: "user", content: [ { type: "text", text: input } ]});

    // Assistant
    while (true) {
      // console.log("...");
      console.log();
      const response = await ant.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 16_000,
        messages,
        tools: toolsTransformedToAnthropicStyle
      });
      messages.push({ role: "assistant", content: response.content })
      // console.log(JSON.stringify(response, null, 2));

      // Tool use
      for (let i=0; i<response.content.length; i++) {
        const cb = response.content[i];
        if (cb.type == "text") {
          console.log(cb.text);
        }
        else if (cb.type == "tool_use") {
          const nameOfToolToExecute = cb.name;
          // console.log(`[${cb.name}]`);
          const toolToExecute = tools.find(tool => tool.name === nameOfToolToExecute);
          if (!toolToExecute) {
            throw new Error("Couldn't find tool " + nameOfToolToExecute);
          }
          const inputParseResult = toolToExecute.inputSchema.safeParse(cb.input);
          if (!inputParseResult.success) {
            console.error(
              `[tool:${nameOfToolToExecute}] input did not match schema.\n` +
              `Received input: ${JSON.stringify(cb.input, null, 2)}\n` +
              `Zod errors: ${JSON.stringify(inputParseResult.error.issues, null, 2)}`
            );
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: cb.id,
                  is_error: true,
                  content: [{ type: "text", text: `Input did not match schema: ${JSON.stringify(inputParseResult.error.issues)}` }]
                }
              ]
            });
            continue;
          }
          console.log(`[tool] ${toolToExecute.stringify(inputParseResult.data)}`);
          const toolOutput = await toolToExecute.execute(inputParseResult.data) as ToolOutput;
          // console.log("toolResult", JSON.stringify(toolOutput, null, 2));
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: cb.id,
                content: toolOutput.content
              }
            ]}
          );
        } else {
          console.warn(`Unhandled content block type: ${cb.type}`);
        }
      }

      if (response.stop_reason === "tool_use") {
        continue;
      } else {
        break;
      }
    }
  }
}

main();
