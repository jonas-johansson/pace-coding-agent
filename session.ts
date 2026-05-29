import { createHash, randomUUID } from "crypto";
import type {
  AssistantMessage,
  ContentBlock as ProviderContentBlock,
  ImageBlock,
  ProviderMessage,
  TextBlock,
  ToolResultContent,
  ToolResultPart as ProviderToolResultPart,
  ToolUseBlock,
  UserMessage,
} from "./provider";

export type { ImageBlock, TextBlock, ToolUseBlock };

export const SESSION_SCHEMA_VERSION = 1;

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
};

export type ToolResultPart = ProviderToolResultPart | ImageBlock;

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ImageBlock;

export type BaseEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type UserEntry = BaseEntry & {
  type: "user";
  content: (TextBlock | ImageBlock)[];
};

export type AssistantEntry = BaseEntry & {
  type: "assistant";
  content: ContentBlock[];
  provider: string;
  modelId: string;
  modelVariant?: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cost: number;
  providerMetadata?: unknown;
};

export type ToolResultEntry = BaseEntry & {
  type: "tool_result";
  toolUseId: string;
  content: ToolResultPart[];
  isError?: boolean;
};

export type SessionEntry = UserEntry | AssistantEntry | ToolResultEntry;

export type Session = {
  version: number;
  id: string;
  projectKey: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  currentModelId: string;
  title?: string;
  activeEntryId: string | null;
  entries: SessionEntry[];
};

let currentSessionId: string = randomUUID();

export function getSessionId(): string {
  return currentSessionId;
}

export function resetSession(): string {
  currentSessionId = randomUUID();
  return currentSessionId;
}

export function setCurrentSessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

export function createProjectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("base64url").slice(0, 32);
}

export function createSession(cwd: string, currentModelId: string): Session {
  const now = new Date().toISOString();
  const id = randomUUID();
  setCurrentSessionId(id);

  return {
    version: SESSION_SCHEMA_VERSION,
    id,
    projectKey: createProjectKey(cwd),
    cwd,
    createdAt: now,
    updatedAt: now,
    currentModelId,
    activeEntryId: null,
    entries: [],
  };
}

export function getActivePath(session: Session): SessionEntry[] {
  if (session.activeEntryId === null) {
    return [];
  }

  const entriesById = new Map(session.entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const path: SessionEntry[] = [];
  let entryId: string | null = session.activeEntryId;

  while (entryId !== null) {
    if (seen.has(entryId)) {
      throw new Error(`Session ${session.id} active path contains a cycle at entry ${entryId}`);
    }
    seen.add(entryId);

    const entry = entriesById.get(entryId);
    if (!entry) {
      throw new Error(`Session ${session.id} active path references missing entry ${entryId}`);
    }

    path.push(entry);
    entryId = entry.parentId;
  }

  return path.reverse();
}

export function appendEntries(
  session: Session,
  entries: readonly SessionEntry[],
  updatedAt = new Date().toISOString(),
): Session {
  if (entries.length === 0) {
    return session;
  }

  const existingIds = new Set(session.entries.map((entry) => entry.id));
  const appendedIds = new Set<string>();
  let parentId = session.activeEntryId;
  const appendedEntries: SessionEntry[] = [];

  for (const entry of entries) {
    if (existingIds.has(entry.id) || appendedIds.has(entry.id)) {
      throw new Error(`Duplicate session entry id: ${entry.id}`);
    }
    appendedIds.add(entry.id);

    const appendedEntry: SessionEntry = { ...entry, parentId };
    appendedEntries.push(appendedEntry);
    parentId = entry.id;
  }

  return {
    ...session,
    updatedAt,
    activeEntryId: parentId,
    entries: [...session.entries, ...appendedEntries],
  };
}

export function undoLastUserTurn(
  session: Session,
  updatedAt = new Date().toISOString(),
): Session {
  const path = getActivePath(session);

  for (let i = path.length - 1; i >= 0; i -= 1) {
    const entry = path[i];
    if (entry.type === "user") {
      return {
        ...session,
        updatedAt,
        activeEntryId: entry.parentId,
      };
    }
  }

  return session;
}

export function sessionToProviderMessages(session: Session): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  let pendingToolResults: ToolResultContent[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) {
      return;
    }

    messages.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const entry of getActivePath(session)) {
    if (entry.type === "tool_result") {
      pendingToolResults.push(toProviderToolResult(entry));
      continue;
    }

    flushToolResults();

    if (entry.type === "user") {
      messages.push(toProviderUserMessage(entry));
    } else {
      messages.push(toProviderAssistantMessage(entry));
    }
  }

  flushToolResults();
  return messages;
}

function toProviderUserMessage(entry: UserEntry): UserMessage {
  return {
    role: "user",
    content: entry.content,
  };
}

function toProviderAssistantMessage(entry: AssistantEntry): AssistantMessage {
  return {
    role: "assistant",
    content: entry.content.filter(isProviderAssistantContentBlock),
    ...(entry.providerMetadata !== undefined && { providerMetadata: entry.providerMetadata }),
  };
}

function toProviderToolResult(entry: ToolResultEntry): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: entry.toolUseId,
    content: entry.content.filter(isProviderToolResultPart),
    ...(entry.isError && { is_error: true }),
  };
}

function isProviderAssistantContentBlock(block: ContentBlock): block is ProviderContentBlock {
  return block.type === "text" || block.type === "tool_use";
}

function isProviderToolResultPart(part: ToolResultPart): part is ProviderToolResultPart {
  return part.type === "text";
}
