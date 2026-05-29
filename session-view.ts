import type { RenderBlock } from "./tui";
import {
  getActivePath,
  type AssistantEntry,
  type Session,
  type SessionEntry,
  type ToolResultEntry,
  type ToolResultPart,
  type UserEntry,
} from "./session";
import { tools, visualizeToolTitle } from "./tool";

export type SessionRenderBlock = Omit<RenderBlock, "id">;

export function sessionToRenderBlocks(session: Session): SessionRenderBlock[] {
  return entriesToRenderBlocks(getActivePath(session));
}

export function entriesToRenderBlocks(entries: readonly SessionEntry[]): SessionRenderBlock[] {
  const blocks: SessionRenderBlock[] = [];
  const toolResultsByUseId = collectToolResults(entries);
  const renderedToolResultEntryIds = new Set<string>();

  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        blocks.push(userEntryToRenderBlock(entry));
        break;
      case "assistant":
        blocks.push(...assistantEntryToRenderBlocks(entry, toolResultsByUseId, renderedToolResultEntryIds));
        break;
      case "tool_result":
        if (!renderedToolResultEntryIds.has(entry.id)) {
          blocks.push(toolResultEntryToRenderBlock(entry));
        }
        break;
    }
  }

  return blocks;
}

function collectToolResults(entries: readonly SessionEntry[]): Map<string, ToolResultEntry[]> {
  const results = new Map<string, ToolResultEntry[]>();

  for (const entry of entries) {
    if (entry.type !== "tool_result") {
      continue;
    }

    const existing = results.get(entry.toolUseId) ?? [];
    existing.push(entry);
    results.set(entry.toolUseId, existing);
  }

  return results;
}

function userEntryToRenderBlock(entry: UserEntry): SessionRenderBlock {
  return {
    key: `entry:${entry.id}`,
    role: "user",
    content: formatUserContent(entry.content),
  };
}

function assistantEntryToRenderBlocks(
  entry: AssistantEntry,
  toolResultsByUseId: Map<string, ToolResultEntry[]>,
  renderedToolResultEntryIds: Set<string>,
): SessionRenderBlock[] {
  const blocks: SessionRenderBlock[] = [];

  entry.content.forEach((contentBlock, index) => {
    const key = `entry:${entry.id}:block:${index}`;

    switch (contentBlock.type) {
      case "text":
        if (contentBlock.text) {
          blocks.push({ key, role: "assistant", content: contentBlock.text });
        }
        break;
      case "thinking":
        if (contentBlock.thinking) {
          blocks.push({ key, role: "reasoning", title: "Reasoning", content: contentBlock.thinking });
        }
        break;
      case "image":
        blocks.push({ key, role: "assistant", content: formatImageBlock(contentBlock) });
        break;
      case "tool_use": {
        const results = toolResultsByUseId.get(contentBlock.id) ?? [];
        for (const result of results) {
          renderedToolResultEntryIds.add(result.id);
        }
        blocks.push(toolUseToRenderBlock(contentBlock.id, contentBlock.name, contentBlock.input, results));
        break;
      }
    }
  });

  return blocks;
}

function toolUseToRenderBlock(
  toolUseId: string,
  toolName: string,
  input: unknown,
  results: readonly ToolResultEntry[],
): SessionRenderBlock {
  const isError = results.some((result) => result.isError);
  const content = shouldShowToolResultContent(toolName, isError)
    ? formatToolResultEntries(results)
    : "";

  return {
    key: `tool:${toolUseId}`,
    role: "tool",
    title: visualizeToolTitle(toolName, input),
    content,
    ...(results.length > 0 && { state: isError ? "error" : "done" }),
  };
}

function toolResultEntryToRenderBlock(entry: ToolResultEntry): SessionRenderBlock {
  return {
    key: `entry:${entry.id}`,
    role: "tool",
    title: `tool_result: ${entry.toolUseId}`,
    content: formatToolResultParts(entry.content),
    state: entry.isError ? "error" : "done",
  };
}

function shouldShowToolResultContent(toolName: string, isError: boolean): boolean {
  const tool = tools.find((candidate) => candidate.name === toolName);
  return tool?.showContent !== false || isError;
}

function formatUserContent(content: UserEntry["content"]): string {
  return content.map(formatUserContentBlock).filter(Boolean).join("\n\n");
}

function formatUserContentBlock(block: UserEntry["content"][number]): string {
  if (block.type === "text") {
    return block.text;
  }

  return formatImageBlock(block);
}

function formatToolResultEntries(entries: readonly ToolResultEntry[]): string {
  return entries.map((entry) => formatToolResultParts(entry.content)).filter(Boolean).join("\n\n");
}

function formatToolResultParts(parts: readonly ToolResultPart[]): string {
  return parts.map(formatToolResultPart).filter(Boolean).join("\n\n").trimEnd();
}

function formatToolResultPart(part: ToolResultPart): string {
  if (part.type === "text") {
    return part.text;
  }

  return formatImageBlock(part);
}

function formatImageBlock(block: { mediaType: string }): string {
  return `[Image: ${block.mediaType}]`;
}
