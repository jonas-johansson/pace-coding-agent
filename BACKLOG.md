Sessions

Undo











Syntax highlighting for markdown code blocks

Come up with a name for this coding agent: boom, wing, cush, cuz, yea, pax, snow, sup



Extract reasoning titles from model output (OpenCode-style)

OpenAI's Responses API (and providers that mirror it) stream reasoning summaries in the
format `**Title**\n\n<body>`, e.g. `**Inspecting PR workflow**\n\n...`. Instead of showing a
generic "Reasoning" label for every thinking block, we can pull that title out with a
simple regex so the collapsed line carries real signal.

Plan:
1. Add a small `reasoningTitle(text: string): string | null` utility that matches
   `^\*\*([^*\n]+)\*\*` at the start of the reasoning text.
2. In the stream-processing loop, after each reasoning delta, run the accumulated
   reasoning text through `reasoningTitle`. If it returns a non-null title, update the
   block's title dynamically via `updateBlock(id, { title })`.
3. When finishing a reasoning block (e.g. before tool use or text output), collapse it
   but preserve whatever title was discovered during streaming instead of hardcoding
   `"Reasoning"`.
4. No provider-layer changes required — this is purely a display-layer extraction. For
   providers that don't emit the `**Title**` convention (Anthropic thinking blocks,
   Fireworks `reasoning_content`, etc.), the utility returns `null` and the fallback
   `"Reasoning"` label stays in place.
