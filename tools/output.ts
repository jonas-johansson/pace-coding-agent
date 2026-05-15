import { createWriteStream, type WriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { formatToolResultBody, type ToolOutput } from "./core";

export const TOOL_OUTPUT_TRUNCATION_BYTES = 4 * 1024;
export const TOOL_OUTPUT_TRUNCATION_HEAD_BYTES = 3 * 1024;
export const TOOL_OUTPUT_TRUNCATION_TAIL_BYTES = 1 * 1024;
const TOOL_OUTPUT_DIR = ".agento/tool-outputs";
let toolOutputTruncationSuppressionDepth = 0;

export function shouldPersistLargeToolOutput() {
  return toolOutputTruncationSuppressionDepth === 0;
}

export async function withoutToolOutputTruncation<T>(fn: () => Promise<T>): Promise<T> {
  toolOutputTruncationSuppressionDepth += 1;
  try {
    return await fn();
  } finally {
    toolOutputTruncationSuppressionDepth -= 1;
  }
}

export async function truncateToolOutputIfNeeded(
  output: ToolOutput,
  toolName: string,
  toolUseId?: string,
): Promise<ToolOutput> {
  const fullText = formatToolResultBody(output);
  const fullBytes = Buffer.byteLength(fullText, "utf8");

  if (fullBytes <= TOOL_OUTPUT_TRUNCATION_BYTES) {
    return output;
  }

  const outputPath = await createToolOutputPath(toolName, toolUseId);
  await writeFile(outputPath, fullText, "utf8");

  const truncatedText = buildTruncatedToolOutputText(fullText, fullBytes, outputPath);

  return {
    content: [{ type: "text", text: truncatedText }],
    ...(output.is_error && { is_error: true }),
  };
}

export async function createToolOutputPath(toolName: string, toolUseId?: string): Promise<string> {
  await mkdir(TOOL_OUTPUT_DIR, { recursive: true });
  return `${TOOL_OUTPUT_DIR}/${makeToolOutputFilename(toolName, toolUseId)}`;
}

function makeToolOutputFilename(toolName: string, toolUseId?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "tool";
  const safeToolUseId = toolUseId?.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const suffix = safeToolUseId ? `-${safeToolUseId}` : `-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return `${timestamp}-${safeToolName}${suffix}.txt`;
}

function buildTruncatedToolOutputText(fullText: string, fullBytes: number, outputPath: string): string {
  const marker = buildToolOutputTruncationMarker(fullBytes, outputPath);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const availableBytes = Math.max(0, TOOL_OUTPUT_TRUNCATION_BYTES - markerBytes);
  const headBytes = Math.min(TOOL_OUTPUT_TRUNCATION_HEAD_BYTES, Math.floor(availableBytes * 0.75));
  const tailBytes = Math.max(0, availableBytes - headBytes);
  return truncateUtf8Prefix(fullText, headBytes) + marker + truncateUtf8Suffix(fullText, tailBytes);
}

export function buildTruncatedToolOutputFromParts(
  headText: string,
  tailText: string,
  fullBytes: number,
  outputPath: string,
): string {
  const marker = buildToolOutputTruncationMarker(fullBytes, outputPath);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const availableBytes = Math.max(0, TOOL_OUTPUT_TRUNCATION_BYTES - markerBytes);
  const headBytes = Math.min(TOOL_OUTPUT_TRUNCATION_HEAD_BYTES, Math.floor(availableBytes * 0.75));
  const tailBytes = Math.max(0, availableBytes - headBytes);
  return `${truncateUtf8Prefix(headText, headBytes)}${marker}${truncateUtf8Suffix(tailText, tailBytes)}`;
}

function buildToolOutputTruncationMarker(fullBytes: number, outputPath: string): string {
  return (
    `\n\n[Tool output truncated. Full output saved to ${outputPath}. ` +
    `Omitted ${formatByteCount(Math.max(0, fullBytes - TOOL_OUTPUT_TRUNCATION_BYTES))}. ` +
    `Showing the beginning and end of the output.]\n\n`
  );
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

export function truncateUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return trimDanglingHighSurrogate(text.slice(0, low));
}

export function truncateUtf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const suffix = text.slice(text.length - mid);
    if (Buffer.byteLength(suffix, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return trimDanglingLowSurrogate(text.slice(text.length - low));
}

function trimDanglingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
}

function trimDanglingLowSurrogate(text: string): string {
  if (text.length === 0) return text;
  const code = text.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? text.slice(1) : text;
}

export function finishWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}
