import Anthropic from "@anthropic-ai/sdk"
import { getUserInput } from "./input"
import { z } from "zod";
import { readFile, writeFile } from "fs/promises"

const ant = new Anthropic();
const messages: Anthropic.MessageParam[] = [];

type ToolOutput = {
  content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.SearchResultBlockParam | Anthropic.DocumentBlockParam | Anthropic.ToolReferenceBlockParam>;
}

type ZodObjectSchema = z.ZodObject<z.core.$ZodShape>;

type ToolDescriptor<T extends ZodObjectSchema = ZodObjectSchema> = {
  name: string;
  description: string;
  inputSchema: T;
  stringify: (input: z.infer<T>) => string;
  execute: (input: z.infer<T>) => Promise<ToolOutput>;
}

const registeredCustomTools: ToolDescriptor[] = [];

function Tool<T extends ZodObjectSchema>(descriptor: ToolDescriptor<T>) {
  if (registeredCustomTools.some(tool => tool.name === descriptor.name)) {
    throw new Error(`Duplicate tool name: "${descriptor.name}" is already registered`);
  }
  registeredCustomTools.push(descriptor as ToolDescriptor);
  console.log(`Registered tool ${descriptor.name}`);
  return descriptor;
}

const readTool = Tool({
  name: "read",
  description: "Read content from a file.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path.")
  }),
  stringify: (input) => `read: ${input.path}`,
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
  stringify: (input) => `write: ${input.path}`,
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
  stringify: (input) => `edit: ${input.path}`,
  execute: async (input): Promise<ToolOutput> => {
    const oldFileData = await readFile(input.path, 'utf8');
    const newFileData = oldFileData.replaceAll(input.oldText, input.newText);
    await writeFile(input.path, newFileData);
    return {
      content: [{ type: "text", text: `Edited file` }]
    }
  }
})

const { execSync } = require('child_process');

const bashTool = Tool({
  name: "bash",
  description: "Execute a bash command.",
  inputSchema: z.object({
    command: z.string(),
  }),
  stringify: (input) => `bash: ${input.command}`,
  execute: async (input): Promise<ToolOutput> => {
    try {
      const bashOutput = execSync(input.command).toString();
      return {
        content: [{ type: "text", text: bashOutput }]
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}`}]
      }
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
        model: "claude-opus-4-6",
        max_tokens: 1000,
        messages,
        tools: antTools
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
          const toolToExecute = registeredCustomTools.find(tool => tool.name === nameOfToolToExecute);
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
