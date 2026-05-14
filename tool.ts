import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod";
import { readFile, writeFile, mkdir } from "fs/promises"
import { homedir } from "os";
import { spawn } from "child_process";
import { parse } from "partial-json";
import { resolve, relative, dirname } from "path";
import TurndownService from "turndown";
import { fetchWithRetry } from "./fetch-retry";

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export type ToolOutput = {
  content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.SearchResultBlockParam | Anthropic.DocumentBlockParam | Anthropic.ToolReferenceBlockParam>;
  is_error?: boolean;
}

export type ToolDisplayBlock = {
  title?: string;
  content: string;
}

type ZodObjectSchema = z.ZodObject<z.core.$ZodShape>;

export type ToolConcurrency = "safe" | "exclusive";

type ToolDescriptor<T extends ZodObjectSchema = ZodObjectSchema> = {
  name: string;
  description: string;
  inputSchema: T;
  execute: (input: z.infer<T>, signal?: AbortSignal) => Promise<ToolOutput>;
  concurrency?: ToolConcurrency;
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

/**
 * Expand leading `~` in paths the same way users expect from shells.
 * Node's fs APIs do not do this automatically, so without this helper a path
 * like `~/Downloads/file.md` would create a local `~` directory under cwd.
 */
function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/**
 * Normalize a file path for display: expand `~`, resolve it against cwd, then
 * make it relative so that both `./tool.ts` and `/home/user/project/tool.ts`
 * are displayed as `tool.ts`.
 */
function normalizePath(path: string): string {
  return relative(process.cwd(), resolve(expandHomePath(path))) || ".";
}

/** Maximum number of lines returned per read call when no explicit limit is provided. */
const DEFAULT_READ_LIMIT = 2000;
/** Individual lines longer than this are truncated to keep output manageable. */
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `… (truncated to ${MAX_LINE_LENGTH} chars)`;
/** Hard cap on total output size in bytes. Stops collecting lines early if
 *  the accumulated output would exceed this, regardless of the line limit. */
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024}KB`;

const readTool = Tool({
  name: "read",
  description: "Read content from a file at a specified path.",
  concurrency: "safe",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative file path."),
    offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed). Defaults to 1."),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read. Defaults to 2000."),
  }),
  titleFormatter: (input) => {
    const pathPart = input.path ? normalizePath(input.path) : "";
    if (input.offset != null || input.limit != null) {
      const offsetStr = input.offset != null ? `offset=${input.offset}` : "";
      const limitStr = input.limit != null ? `limit=${input.limit}` : "";
      const suffix = [offsetStr, limitStr].filter(Boolean).join(", ");
      return `read: ${pathPart} (${suffix})`;
    }
    return `read: ${pathPart}`;
  },
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);
    const fullText = await readFile(filePath, 'utf8');
    const allLines = fullText.split("\n");
    const totalLines = allLines.length;

    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    const start = offset - 1; // convert 1-indexed to 0-indexed

    if (start >= totalLines && totalLines > 0) {
      return {
        content: [{ type: "text", text: `Offset ${offset} is beyond end of file (${totalLines} lines).` }],
        is_error: true,
      };
    }

    const candidateLines = allLines.slice(start, start + limit);
    const numbered: string[] = [];
    let bytes = 0;
    let truncatedByBytes = false;

    for (let i = 0; i < candidateLines.length; i++) {
      const lineNum = start + i + 1;
      const truncatedLine = candidateLines[i].length > MAX_LINE_LENGTH
        ? candidateLines[i].substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
        : candidateLines[i];
      const formatted = `${lineNum}: ${truncatedLine}`;
      const lineBytes = Buffer.byteLength(formatted, "utf8") + (numbered.length > 0 ? 1 : 0); // +1 for newline separator
      if (bytes + lineBytes > MAX_READ_BYTES) {
        truncatedByBytes = true;
        break;
      }
      bytes += lineBytes;
      numbered.push(formatted);
    }

    let text = numbered.join("\n");

    const endLine = start + numbered.length;
    const hasMore = endLine < totalLines;

    if (truncatedByBytes) {
      text += `\n\n(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`;
    } else if (hasMore) {
      text += `\n\n(Showing lines ${offset}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.)`;
    } else {
      text += `\n\n(${totalLines} lines)`;
    }

    return {
      content: [{ type: "text", text }]
    };
  }
});

const writeTool = Tool({
  name: "write",
  description: "Write content to a file.",
  concurrency: "exclusive",
  inputSchema: z.object({
    path: z.string(),
    content: z.string()
  }),
  titleFormatter: (input) => `write: ${input.path ? normalizePath(input.path) : ""}`,
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.content);
    return {
      content: [{ type: "text", text: `Wrote file` }]
    }
  }
});

const editTool = Tool({
  name: "edit",
  description: "Edit a file by replacing exact text.",
  concurrency: "exclusive",
  inputSchema: z.object({
    path: z.string(),
    oldText: z.string().describe("Old text to find and replace (must match exactly)"),
    newText: z.string().describe("New text to replace the old with")
  }),
  titleFormatter: (input) => `edit: ${input.path ? normalizePath(input.path) : ""}`,
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const filePath = expandHomePath(input.path);
    const oldFileData = await readFile(filePath, 'utf8');
    const newFileData = oldFileData.replaceAll(input.oldText, input.newText);
    await writeFile(filePath, newFileData);
    return {
      content: [{ type: "text", text: `Edited file` }]
    }
  }
})

const BASH_DEFAULT_TIMEOUT = 10_000;

const bashTool = Tool({
  name: "bash",
  description: "Execute a bash command in the current working directory.",
  concurrency: "exclusive",
  inputSchema: z.object({
    command: z.string(),
  }),
  titleFormatter: (input) => `bash: ${input.command ?? ""}`,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const timeoutMs = (BASH_DEFAULT_TIMEOUT / 1000) * 1000;
    try {
      // Use spawn with detached: true so the shell and all its children
      // form their own process group. This lets us kill the entire tree
      // (e.g. "sleep 15") instantly via process.kill(-pid, SIGTERM)
      // instead of only killing the wrapper shell.
      const child = spawn("/bin/sh", ["-c", input.command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const maxBuffer = 10 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let stdoutLen = 0;
      let stderrLen = 0;
      let killed = false;
      let killSignal: string | null = null;

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdoutLen += chunk.length;
        if (stdoutLen <= maxBuffer) stdout += chunk;
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderrLen += chunk.length;
        if (stderrLen <= maxBuffer) stderr += chunk;
      });

      // Kill the entire process group so children are also terminated
      const killTree = () => {
        killed = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch {}
        }
        child.kill("SIGTERM");
      };

      // Set up timeout
      const timer = setTimeout(() => {
        killSignal = "SIGTERM";
        killTree();
      }, timeoutMs);

      // Set up abort signal
      if (signal) {
        const onAbort = () => { killTree(); };
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("exit", () => signal.removeEventListener("abort", onAbort));
      }

      // Wait for the process to exit
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode) => resolve(exitCode));
      });

      clearTimeout(timer);

      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (killed && killSignal === "SIGTERM") {
        const partial = [stdout, stderr].filter(Boolean).join("\n");
        const message = partial
          ? `Command timed out after ${Math.floor(timeoutMs / 1000)} seconds. Partial output:\n${partial}`
          : `Command timed out after ${Math.floor(timeoutMs / 1000)} seconds.`;
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          is_error: true,
        };
      }

      if (code !== 0 && code !== null) {
        const message = [stdout, stderr, `Command exited with code ${code}`].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
        };
      }

      const bashOutput = [stdout, stderr].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: bashOutput }]
      };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
      };
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
  concurrency: "safe",
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
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
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

    // Link the external cancellation signal to our internal controller
    if (signal) {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

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
      // If abort was triggered by our external signal, propagate as AbortError
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
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
  concurrency: "safe",
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
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const { query, numResults } = input;

    const response = await fetchWithRetry(
      EXA_MCP_URL,
      {
        method: "POST",
        signal,
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
      },
      signal,
    );

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

// ─── Skill Tool ─────────────────────────────────────────────────────────────

import type { Skill } from "./skill";
import { findSkill, loadSkillContent, formatSkillsForToolDescription } from "./skill";

let currentSkills: Skill[] = [];

/**
 * Update the set of skills available to the skill tool.
 * Called from app.ts at the start of each prompt cycle.
 */
export function setCurrentSkills(skills: Skill[]) {
  currentSkills = skills;
}

const skillTool = Tool({
  name: "skill",
  description:
    "Load a skill's full instructions by name. " +
    "Use this to read the complete SKILL.md content for an available skill when you determine it is relevant to the current task.",
  concurrency: "safe",
  inputSchema: z.object({
    name: z.string().describe("The skill name to load"),
  }),
  titleFormatter: (input) => `skill: ${input.name ?? ""}`,
  showContent: false,
  execute: async (input, signal): Promise<ToolOutput> => {
    throwIfAborted(signal);
    const skill = findSkill(currentSkills, input.name);
    if (!skill) {
      return {
        content: [{ type: "text", text: `Unknown skill: ${input.name}` }],
        is_error: true,
      };
    }
    const content = await loadSkillContent(skill);
    return {
      content: [{ type: "text", text: content }],
    };
  },
});

// ─── Tool definition export ─────────────────────────────────────────────────

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

import type { ToolDefinition } from "./provider";

/**
 * Provider-agnostic tool definitions. Used by the provider abstraction layer
 * so each provider can serialise tools into its own API format.
 *
 * The skill tool's description is dynamically augmented with the current
 * skill listing so the model can see available skills in the tool schema.
 */
export function getProviderToolDefinitions(): ToolDefinition[] {
  return tools.map((t) => {
    let description = t.description;

    // Dynamically append skill listing to the skill tool
    if (t.name === "skill" && currentSkills.length > 0) {
      const listing = formatSkillsForToolDescription(currentSkills);
      if (listing) {
        description = `${description}\n\nAvailable skills:\n${listing}`;
      }
    }

    return {
      name: t.name,
      description,
      inputSchema: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
    };
  });
}
