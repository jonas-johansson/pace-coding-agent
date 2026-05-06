import Anthropic from "@anthropic-ai/sdk"
import { getUserInput } from "./input"
import { z, ZodSchema } from "zod";
import { readFile, writeFile } from "fs/promises"

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
  description: "Read content from a file.",
  inputSchema: z.object({ path: z.string().describe("Absolute or relative path.") }),
  execute: async (input): Promise<ToolOutput> => {
    const fileData = await readFile(input.path, 'utf8');
    return {
      content: [{ type: "text", text: fileData }]
    }
  }
});

const writeTool = Tool({
  name: "write",
  description: "Write content to a file.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string()
  }),
  execute: async (input): Promise<ToolOutput> => {
    await writeFile(input.path, input.content);
    return {
      content: [{ type: "text", text: `Wrote file` }]
    }
  }
});

const editTool = Tool({
  name: "edit",
  description: "Edit a file by replacing exact text.",
  inputSchema: z.object({
    path: z.string(),
    oldText: z.string().describe("Old text to find and replace (must match exactly)"),
    newText: z.string().describe("New text to replace the old with")
  }),
  execute: async (input): Promise<ToolOutput> => {
    const oldFileData = await readFile(input.path, 'utf8');
    const newFileData = oldFileData.replaceAll(input.oldText, input.newText);
    await writeFile(input.path, newFileData);
    return {
      content: [{ type: "text", text: `Edited file` }]
    }
  }
})

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
      // console.log(JSON.stringify(response, null, 2));

      // Tool use
      for (let i=0; i<response.content.length; i++) {
        const cb = response.content[i];
        // console.log("content block", cb);
        if (cb.type == "text") {
          console.log(cb.text);
        }
        else if (cb.type == "tool_use") {
          const nameOfToolToExecute = cb.name;
          // console.log(`[${cb.name}]`);
          console.log(`[${cb.name}: ${JSON.stringify(cb.input, null, 2)}]`);
          const toolToExecute = registeredCustomTools.find(tool => tool.name === nameOfToolToExecute);
          if (!toolToExecute) {
            throw new Error("Couldn't find tool " + nameOfToolToExecute);
          }
          const inputParseResult = toolToExecute.inputSchema.safeParse(cb.input);
          if (!inputParseResult.success) {
            throw new Error(`Input object in content block doesn't match the input schema for the tool`);
          }
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
