import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod";
import { readFile, writeFile } from "fs/promises"
import { exec } from "child_process";
import { promisify } from "util";
import { parse } from "partial-json";

const execAsync = promisify(exec);

export type ToolOutput = {
  content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.SearchResultBlockParam | Anthropic.DocumentBlockParam | Anthropic.ToolReferenceBlockParam>;
}

export type ToolDisplayBlock = {
  title?: string;
  content: string;
}

type ZodObjectSchema = z.ZodObject<z.core.$ZodShape>;

type ToolVisualization<T extends ZodObjectSchema = ZodObjectSchema> = {
  start: () => ToolDisplayBlock | undefined;
  partialInput: (jsonString: string) => ToolDisplayBlock | undefined;
  input: (input: z.infer<T>) => ToolDisplayBlock;
  result: (output: ToolOutput) => ToolDisplayBlock | undefined;
}

type ToolDescriptor<T extends ZodObjectSchema = ZodObjectSchema> = {
  name: string;
  description: string;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<ToolOutput>;
  visualize: ToolVisualization<T>;
}

type ToolDefinition<T extends ZodObjectSchema = ZodObjectSchema> = Omit<ToolDescriptor<T>, "visualize">;

export const tools: ToolDescriptor[] = [];

function Tool<T extends ZodObjectSchema>(definition: ToolDefinition<T>) {
  if (tools.some(tool => tool.name === definition.name)) {
    throw new Error(`Duplicate tool name: "${definition.name}" is already registered`);
  }

  const descriptor: ToolDescriptor<T> = {
    ...definition,
    visualize: defaultToolVisualization(definition),
  };

  tools.push(descriptor as ToolDescriptor);
  return descriptor;
}

function defaultToolVisualization<T extends ZodObjectSchema>(tool: Omit<ToolDescriptor<T>, "visualize" | "execute" | "description" | "inputSchema">): ToolVisualization<T> {
  return {
    start: () => ({ title: `Tool use: ${tool.name}`, content: "Input:\n{}" }),
    partialInput: (jsonString) => ({ title: `Tool use: ${tool.name}`, content: `Input:\n${formatPartialJson(jsonString)}` }),
    input: (input) => ({ title: `Tool use: ${tool.name}`, content: `Input:\n${formatToolInput(input)}` }),
    result: (output) => ({ title: `Tool result: ${tool.name}`, content: formatToolOutput(output) }),
  };
}

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

const readTool = Tool({
  name: "read",
  description: "Read content from a file.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path."),
  }),
  execute: async (input): Promise<ToolOutput> => {
    const text = await readFile(input.path, 'utf8');
    return {
      content: [{ type: "text", text }]
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

const bashTool = Tool({
  name: "bash",
  description: "Execute a bash command.",
  inputSchema: z.object({
    command: z.string(),
  }),
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
