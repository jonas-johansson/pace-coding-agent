Support the Wint workflow

Add MCP support and test the feature with Linear MCP

Syntax highlighting for markdown code blocks

Come up with a name for this coding agent: boom, wing, cush, cuz, yea, pax, snow

Input box improvements:
- SHIFT+DEL should delete the line the cursor is on in the user input box.
- Mouse click should move cursor in input box.
- CTRL+DEL should delete the next word.
- CTRL+RIGHT should place the cursor at the end of the word.



Add exponential backoff to deal with 429 error from Fireworks. Right now I only see this error message. But it would make sense to do retry with exponential backoff and then if that fails then tell the user that it retried with exponential backoff but it still failed.

Error

Error: Fireworks AI request failed (429): {"error":{"message":"You have exceeded your rate limit for
this API. Please try again later. For more information, see
https://docs.fireworks.ai/guides/quotas_usage/rate-limits.","param":null,"code":"RATE_LIMIT_EXCEEDED",
"type":"error"},"request_id":"chatcmpl-a87df2edc956489aae4d4d72c4e857d9"}
at FireworksProvider.stream (/home/jonas/dev/code-agent/providers/fireworks.ts:283:13)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async prompt (/home/jonas/dev/code-agent/app.ts:821:38)
at async Object.handleUserInput (/home/jonas/dev/code-agent/app.ts:756:5)

