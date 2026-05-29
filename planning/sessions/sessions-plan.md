# New Feature: Sessions

It should be possible to exit the coding agent and then be able to resume the session later on, just where we left it.

It should be possible list sessions.

Sessions should be bound to a project identity.

Session data is persisted to local storage.

Sessions have an id.

It should be possible to undo: rewind conversation history to before the last user message. We don't need to undo side-effects such as file modifications.

A session is a tree of entries/events (not sure what to call them). At any given time there's an active leaf and the conversation history is constructed by traversing up through the parents from that active leaf.

Streaming: It's important that the UI shows the updated information live while the AI model is streaming data. I think it would make sense that the TUI is rendering with session data as the input.

Session data is only persisted to local storage after a turn ends.

We don't care about backwards compatibility yet because the coding agent is still in development.

Sessions should provide observability so that a user can look through the session data to see what has happened after the fact.

When opening the coding agent in a dir then we'll figure out a project identity based on either git repo info or the path.

It should be possible to list sessions and resume an existing session by id.

Session data is provider-agnostic, but they need to contain some provider metadata (such as thinking signatures for Claude).

I think it's good to think of session entries as immutable. The session entries conceptually form an append-only timeline. However, while streaming we'll have partial data and the TUI needs to work with that.

```ts
type ContentBlock
{
    type: "text" | "thinking" | "tool_call" | "image";
}

type TextContentBlock : ContentBlock // ContentBlock.type = text
{
    text: string;
}

type ThinkingContentBlock : ContentBlock // ContentBlock.type = thinking
{
    thinking: string;
    signature: string;
}

type ToolCallContentBlock : ContentBlock // ContentBlock.type = tool_call
{
    id: string // tu_ABCD1234abcd
    name: string // ex: "web_search"
    input // object, ex: { query: "current weather Paris" }
}

type ImageSource
{
    type: "base64"; // enum
    media_type // image/png etc
    data // ex: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
}

type ImageContentBlock : ContentBlock // ContentBlock.type = image
{
    source: ImageSource
}

type SessionEntry
{
    id: string; // random uuid
    parentId: string | null;
    timestamp: string; // ex: 2026-05-28T13:23:21.176Z
}

type Message : SessionEntry
{
    role: "user" | "assistant";
    content: ContentBlock[]; // ContentBlock array
}

type UserMessage : Message
{
}

type AssistantMessage : Message
{
    provider: string; // ex: openai
    modelId: string; // ex: gpt-5, claude-opus-4
    modelVariant?: string; // ex: high, max
    tokensIn: number;
    tokensOut: number;
    cost: number; // cost in USD
}

type ToolResult : SessionEntry
{
    content: ContentBlock[]; // text, images
    is_error?: boolean; // optional is_error boolean
}

type Session
{
    version: number; // number 1
    id: string; // random uuid string
    createdAt: string; // ex: 2026-05-28T13:23:21.176Z
    updatedAt: string; // ex: 2026-05-28T13:23:21.176Z
    title?: string;
    activeEntryId: string;
    entries: SessionEntry[];
}

```


## LLM context generation

### Message history

1. Traverse session entries from active entry up the tree.
2. Filter message entries.
3. Convert to provider.

