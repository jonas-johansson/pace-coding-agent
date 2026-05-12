import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod";
import { readFile, writeFile } from "fs/promises"
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type ToolOutput = {
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

export const tools: ToolDescriptor[] = [];

function Tool<T extends ZodObjectSchema>(descriptor: ToolDescriptor<T>) {
  if (tools.some(tool => tool.name === descriptor.name)) {
    throw new Error(`Duplicate tool name: "${descriptor.name}" is already registered`);
  }
  tools.push(descriptor as ToolDescriptor);
  return descriptor;
}

const readTool = Tool({
  name: "read",
  description: "Read content from a file.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path.")
  }),
  stringify: (input) => `Read ${input.path}`,
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
  stringify: (input) => `Write ${input.path}`,
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
  stringify: (input) => `Edit ${input.path}`,
  execute: async (input): Promise<ToolOutput> => {
    const oldFileData = await readFile(input.path, 'utf8');
    const newFileData = oldFileData.replaceAll(input.oldText, input.newText);
    await writeFile(input.path, newFileData);
    return {
      content: [{ type: "text", text: `Edited file` }]
    }
  }
})

const bashTool = Tool({
  name: "bash",
  description: "Execute a bash command.",
  inputSchema: z.object({
    command: z.string(),
  }),
  stringify: (input) => `Bash: ${input.command}`,
  execute: async (input): Promise<ToolOutput> => {
    try {
      const { stdout, stderr } = await execAsync(input.command, { maxBuffer: 10 * 1024 * 1024 });
      const bashOutput = [stdout, stderr].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: bashOutput }]
      }
    } catch (error: unknown) {
      const execError = error as Error & { stdout?: string; stderr?: string };
      const message = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: `Error: ${message}`}]
      }
    }
  }
})

function makeAnthropicToolsFromCustomTools() {
  let transformedTools: Anthropic.Tool[] = [];
  for (let i=0; i < tools.length; i++) {
    transformedTools.push({
      name: tools[i].name,
      description: tools[i].description,
      input_schema: z.toJSONSchema(tools[i].inputSchema) as Anthropic.Tool["input_schema"]
    })
  }
  return transformedTools;
}

export const toolsTransformedToAnthropicStyle: Anthropic.Tool[] = makeAnthropicToolsFromCustomTools();
