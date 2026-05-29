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






```ts
type ContentBlock
{
    type: "text" | "thinking" | "tool_use" | "tool_result" | "image"; // enum
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

type ToolUseContentBlock : ContentBlock // ContentBlock.type = tool_use
{
    id: string // tu_ABCD1234abcd
    name: string // ex: "web_search"
    input // object, ex: { query: "current weather Paris" }
}

type ToolResultContentBlock : ContentBlock // ContentBlock.type = tool_result
{
    toolUseId: string // ex: tu_ABCD1234abcd
    content // optional array of text/image leaves
    is_error // optional boolean
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

type Entry
{
    id
    timestamp // ex: 2026-05-28T13:23:21.176Z
}

type Message : Entry
{
    role // user or assistant
    content // ContentBlock array
}

type UserMessage : Message
{
}

type AssistantMessage : Message
{
}

type ModelChange : Entry
{
    provider: string
    modelId: string
}

```



