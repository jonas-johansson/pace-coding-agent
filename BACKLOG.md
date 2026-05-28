Sessions

Undo




bash: /bin/ls -1                                                                      ✗

Error: Command timed out after 30 seconds. Process did not exit after SIGKILL; stopped
waiting.










Syntax highlighting for markdown code blocks

Come up with a name for this coding agent: boom, wing, cush, cuz, yea, pax, snow, sup

Tell agents to only use tool_composer to chain tool calls together because sometimes I see agents use it to run scripts.




---

I got this error when I cancelled a tool being prepared with k2.6 and then continued with sonnet and said "continue but don't use tool_composer"

Error

Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.tool_use.id: String should match pattern
'^[a-zA-Z0-9_-]+$'"},"request_id":"req_011Cb4SFyx5UutcgqTt9JpP1"}
at APIError.generate
(/home/jonas/dev/code-agent/node_modules/.pnpm/@anthropic-ai+sdk@0.94.0/node_modules/@anthropic-ai/sdk/src/core/error.ts:75:14)
at Anthropic.makeStatusError
(/home/jonas/dev/code-agent/node_modules/.pnpm/@anthropic-ai+sdk@0.94.0/node_modules/@anthropic-ai/sdk/src/client.ts:804:28)
at Anthropic.makeRequest
(/home/jonas/dev/code-agent/node_modules/.pnpm/@anthropic-ai+sdk@0.94.0/node_modules/@anthropic-ai/sdk/src/client.ts:1064:24)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)





Render Reasoning text with markdown. Example:

Reasoning (arrow down symbol)

This is some very interesting reasoning text right here. We'll do it in this order:
1. Say hey
2. Say bye

