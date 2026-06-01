import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import { defineTool, throwIfAborted, type ToolOutput } from "./core";
import { expandHomePath, normalizePath } from "./path";

/** Maximum number of lines returned per read call when no explicit limit is provided. */
const DEFAULT_READ_LIMIT = 2000;
/** Individual lines longer than this are truncated to keep output manageable. */
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `… (truncated to ${MAX_LINE_LENGTH} chars)`;
/** Hard cap on total output size in bytes. Stops collecting lines early if
 *  the accumulated output would exceed this, regardless of the line limit. */
const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024}KB`;

export const readTool = defineTool({
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
  truncateOutput: false,
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

export const writeTool = defineTool({
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

export const editTool = defineTool({
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
