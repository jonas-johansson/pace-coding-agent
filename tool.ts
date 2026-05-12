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

type ToolDescriptor<T extends ZodObjectSchema = ZodObjectSchema> = {
  name: string;
  description: string;
  inputSchema: T;
  execute: (input: z.infer<T>) => Promise<ToolOutput>;
  titleFormatter?: (input: Partial<z.infer<T>>) => string;
  /**
   * When false, the tool's result body is hidden in the TUI; the block shows
   * only its title and state glyph. The body is still sent to the model
   * verbatim. Errors are always shown regardless of this flag. Defaults to true.
   */
  showContent?: boolean;
}

export const tools: ToolDescriptor[] = [];

function Tool<T extends ZodObjectSchema>(definition: ToolDescriptor<T>) {
  if (tools.some(tool => tool.name === definition.name)) {
    throw new Error(`Duplicate tool name: "${definition.name}" is already registered`);
  }

  tools.push(definition as ToolDescriptor);
  return definition;
}

export function visualizeToolTitle(toolName: string, input: unknown): string {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool?.titleFormatter && input && typeof input === "object") {
    try {
      return oneLine(tool.titleFormatter(input as never));
    } catch {
      // fall through to generic
    }
  }
  return oneLine(`${toolName}: ${defaultInputSummary(input)}`);
}

export function visualizeToolPartialTitle(toolName: string, jsonString: string): string {
  let parsed: unknown = {};
  try {
    parsed = parsePartialJson(jsonString);
  } catch {
    parsed = {};
  }
  return visualizeToolTitle(toolName, parsed);
}

export function formatToolResultBody(output: ToolOutput): string {
  return formatToolOutput(output).trimEnd();
}

function defaultInputSummary(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  // Prefer common "path" or "command" keys
  for (const preferred of ["command", "path", "file", "name"]) {
    if (typeof obj[preferred] === "string") return obj[preferred] as string;
  }
  // Fall back to first string value
  for (const key of keys) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  return JSON.stringify(input);
}

function oneLine(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

function parsePartialJson(jsonString: string): unknown {
  if (jsonString.length === 0) {
    return {};
  }

  return parse(jsonString);
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

const readTool = Tool({
  name: "read",
  description: "Read content from a file.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path."),
  }),
  titleFormatter: (input) => `read: ${input.path ?? ""}`,
  showContent: false,
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
  titleFormatter: (input) => `write: ${input.path ?? ""}`,
  showContent: false,
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
  titleFormatter: (input) => `edit: ${input.path ?? ""}`,
  showContent: false,
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
  titleFormatter: (input) => `bash: ${input.command ?? ""}`,
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
