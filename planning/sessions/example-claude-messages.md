# Claude API Conversation Examples

Realistic examples based on Anthropic's **Messages API** format (`role` + `content` blocks).

---

## 1. Basic user message

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Check the current weather in Seattle and save a summary to weather.md."
    }
  ]
}
```

---

## 2. Assistant message with reasoning/thinking + tool call

Claude 3.7+ can emit `thinking` blocks (with a `signature`) alongside regular text and `tool_use` blocks.

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "The user wants the current weather in Seattle and then wants it saved to a file. I should first search for the weather, then use the file writer tool. I'll start with a web search to get live data.",
      "signature": "EqoCCkYICxgCKkDfbTNVdXJiZ2Vy..."
    },
    {
      "type": "text",
      "text": "I'll look up the current weather in Seattle and then save the summary for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01Abc9XyZ123",
      "name": "web_search",
      "input": {
        "query": "current weather Seattle"
      }
    }
  ]
}
```

---

## 3. Tool execution APPROVAL — represented as a tool result

The API itself doesn't have a special "approval" block. In practice, approval happens client-side, and you send back the result of the executed tool.

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01Abc9XyZ123",
      "content": "Seattle, WA: 58°F, partly cloudy, 10% chance of rain. Wind 5 mph."
    }
  ]
}
```

---

## 4. Assistant message after receiving tool result

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "I now have the weather data. The user wants it saved to weather.md. I should call the write_file tool with the summary.",
      "signature": "EogCCkYICxgCKkDHo0xnKV3HJ..."
    },
    {
      "type": "text",
      "text": "Got it. Now I'll write the summary to weather.md."
    },
    {
      "type": "tool_use",
      "id": "toolu_02Def0LmN456",
      "name": "write_file",
      "input": {
        "path": "weather.md",
        "content": "# Seattle Weather\n- **Temp:** 58°F\n- **Condition:** Partly cloudy\n- **Rain:** 10%\n- **Wind:** 5 mph\n"
      }
    }
  ]
}
```

---

## 5. Tool execution DENIAL — blocking a dangerous operation

If the user (or a safety layer) denies the tool, the typical pattern is to send a `tool_result` with `is_error: true` explaining the denial.

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02Def0LmN456",
      "is_error": true,
      "content": "Execution denied by user: I don't want files written to disk right now."
    }
  ]
}
```

---

## 6. Full back-and-forth conversation array

Here is how the full `messages` payload looks when sent to the API (includes a user denial in the middle):

```json
[
  {
    "role": "user",
    "content": [
      { "type": "text", "text": "Run a system update command." }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants to run a system update. I have a bash tool available. I should construct the appropriate update command for the detected OS.",
        "signature": "EpUDCkYICxgCKkBlNDMuLi4="
      },
      {
        "type": "tool_use",
        "id": "toolu_03GhI7QrS789",
        "name": "bash",
        "input": { "command": "sudo apt update && sudo apt upgrade -y" }
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_03GhI7QrS789",
        "is_error": true,
        "content": "Tool execution denied by user policy: privileged commands require manual approval."
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Understood. I won't run the update command. Let me know if you'd like me to proceed later." }
    ]
  }
]
```

---

## 7. Tool result returning an image

A `tool_result` can include `image` content blocks alongside (or instead of) text. Images must be base64-encoded.

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_04JkL8TuV012",
      "content": [
        {
          "type": "text",
          "text": "Screenshot of the dashboard taken successfully."
        },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
          }
        }
      ]
    }
  ]
}
```

Alternatively, an image can be referenced by URL instead of base64:

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/chart.png"
  }
}
```

---

## Quick notes on format

- **`thinking`** blocks only appear when using models that support extended thinking (e.g., Claude 3.7 Sonnet with `thinking` enabled). The `signature` is required for verification.
- **`tool_use`** is always from the assistant; **`tool_result`** is always from the user.
- **Approval/denial** is not a native API content type — it's a client pattern. Most clients either execute the tool and return a normal `tool_result`, or return an error-style `tool_result` / text message when denying.
- **Images in tool results** are supported in the Messages API. They count toward image limits and pricing just like user-provided images.
- **Content blocks are not recursive.** A message's `content` is a flat array of blocks. The only "nesting" is that a `tool_result`'s `content` can be an array of `text`/`image` blocks, but those are leaf nodes and cannot contain further blocks.
