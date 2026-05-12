import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod";
import { readFile, writeFile } from "fs/promises"
import { exec } from "child_process";
import { promisify } from "util";
import { parse } from "partial-json";
import TurndownService from "turndown";

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

// ─── Web Fetch ──────────────────────────────────────────────────────────────

const WEB_FETCH_MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const WEB_FETCH_DEFAULT_TIMEOUT = 30_000;
const WEB_FETCH_MAX_TIMEOUT = 120_000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function buildAcceptHeader(format: "text" | "markdown" | "html"): string {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
}

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  td.remove(["script", "style", "meta", "link"]);
  return td.turndown(html);
}

function htmlToText(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const webFetchTool = Tool({
  name: "web_fetch",
  description:
    "Fetch the content of a URL and return it as text, markdown, or raw HTML. " +
    "Use this when the user asks you to read, summarize, or extract information from a specific URL. " +
    "HTTP URLs are automatically upgraded to HTTPS.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in. Defaults to markdown."),
    timeout: z
      .number()
      .default(30)
      .optional()
      .describe("Request timeout in seconds (max 120). Defaults to 30."),
  }),
  titleFormatter: (input) => `web_fetch: ${input.url ?? ""}`,
  execute: async (input): Promise<ToolOutput> => {
    const { url, format, timeout } = input;

    const resolvedUrl = url.startsWith("http://")
      ? url.replace("http://", "https://")
      : url;

    if (!resolvedUrl.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    const timeoutMs = Math.min(
      (timeout ?? WEB_FETCH_DEFAULT_TIMEOUT / 1000) * 1000,
      WEB_FETCH_MAX_TIMEOUT,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        "User-Agent": BROWSER_UA,
        Accept: buildAcceptHeader(format),
        "Accept-Language": "en-US,en;q=0.9",
      };

      const initial = await fetch(resolvedUrl, {
        signal: controller.signal,
        headers,
      });

      // Retry with a plain UA if Cloudflare blocks us
      const response =
        initial.status === 403 &&
        initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(resolvedUrl, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "code-agent" },
            })
          : initial;

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        parseInt(contentLength, 10) > WEB_FETCH_MAX_RESPONSE_SIZE
      ) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > WEB_FETCH_MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5 MB limit)");
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

      if (mime.startsWith("image/") && mime !== "image/svg+xml") {
        return {
          content: [{ type: "text", text: `Image content at ${resolvedUrl} (${mime}) - binary content skipped` }],
        };
      }

      const content = new TextDecoder().decode(arrayBuffer);
      const isHtml = contentType.includes("text/html");
      let output = content;

      switch (format) {
        case "markdown":
          output = isHtml ? htmlToMarkdown(content) : content;
          break;
        case "text":
          output = isHtml ? htmlToText(content) : content;
          break;
        case "html":
          output = content;
          break;
      }

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request timed out after ${Math.floor(timeoutMs / 1000)} seconds`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
});

// ─── Web Search ─────────────────────────────────────────────────────────────

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

function parseSsePayload(text: string): unknown {
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]")
    .map((line) => JSON.parse(line));

  if (payloads.length === 0) {
    throw new Error("No data in Exa MCP response");
  }

  return payloads.at(-1);
}

const webSearchTool = Tool({
  name: "web_search",
  description:
    "Search the web for current information, news, facts, or any topic.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    numResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("Number of results to return (default 5)"),
  }),
  titleFormatter: (input) => `web_search: ${input.query ?? ""}`,
  execute: async (input): Promise<ToolOutput> => {
    const { query, numResults } = input;

    const response = await fetch(EXA_MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query, numResults },
        },
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Exa MCP request failed with status ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = parseSsePayload(text) as {
      error?: { message?: string };
      result?: { content?: Array<{ text?: string }> };
    };

    if (data.error) {
      throw new Error(data.error.message ?? "Exa MCP request failed");
    }

    const output =
      typeof data.result?.content?.[0]?.text === "string"
        ? data.result.content[0].text
        : JSON.stringify(data, null, 2);

    return { content: [{ type: "text", text: output }] };
  },
});

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
