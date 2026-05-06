import Anthropic from "@anthropic-ai/sdk"
import { getUserInput } from "./input"
import { z, ZodSchema } from "zod";
import { readFile } from "fs/promises"

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];

type ToolOutput = {
  content: any[]; // TODO: Suitably type this
}

type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  execute: any; // TODO: Infer function signature so that the execute function takes an input object (follows input schema) and returns a ToolOutput object
}

const registeredCustomTools: ToolDescriptor[] = [];

function Tool(descriptor: ToolDescriptor) {
  registeredCustomTools.push(descriptor);
  console.log(`Registered custom tool ${descriptor.name}`);
  return descriptor;
}

const readTool = Tool({
  name: "read",
  description: "Read file content from an absolute or relative path.",
  inputSchema: z.object({ path: z.string() }),
  execute: async (input): Promise<ToolOutput> => {
    const fileData = await readFile(input.path, 'utf8');
    return {
      content: [{ type: "text", text: fileData }]
    }
  }
});

function makeAnthropicToolsFromCustomTools() {
  let transformedTools: Anthropic.Tool[] = [];
  for (let i=0; i < registeredCustomTools.length; i++) {
    transformedTools.push({
      name: registeredCustomTools[i].name,
      description: registeredCustomTools[i].description,
      input_schema: z.toJSONSchema(registeredCustomTools[i].inputSchema) as Anthropic.Tool["input_schema"]
    })
  }
  return transformedTools;
}

const antTools: Anthropic.Tool[] = makeAnthropicToolsFromCustomTools();

async function main() {
  console.log("READY!");

  while (true) {

    // User
    const input = await getUserInput("User: ");
    messages.push({ role: "user", content: [ { type: "text", text: input } ]});

    // Assistant
    while (true) {
      const response = await ant.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1000,
        messages,
        tools: antTools
      });
      messages.push({ role: "assistant", content: response.content })
      console.log(JSON.stringify(response, null, 2));

      // Tool use
      for (let i=0; i<response.content.length; i++) {
        const cb = response.content[i];
        if (cb.type == "tool_use") {
          console.log("[processing tool use]", cb);
          const nameOfToolToExecute = cb.name;
          const toolToExecute = registeredCustomTools.find(tool => tool.name === nameOfToolToExecute);
          if (!toolToExecute) {
            throw new Error("Couldn't find tool " + nameOfToolToExecute);
          }
          const inputParseResult = toolToExecute.inputSchema.safeParse(cb.input);
          if (!inputParseResult.success) {
            throw new Error(`Input object in content block doesn't match the input schema for the tool`);
          }
          const toolOutput = await toolToExecute.execute(inputParseResult.data) as ToolOutput;
          console.log("toolResult", JSON.stringify(toolOutput, null, 2));
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
