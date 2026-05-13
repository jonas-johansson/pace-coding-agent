# Plan: Paste Image and Send with User Message

## Overview

Allow the user to include images with their messages. Images can enter the app in three ways:

1. **Ctrl+V clipboard paste** — the app reads the system clipboard for image data using native OS tools (`osascript` on macOS, `wl-paste` on Wayland, `xclip` on X11). This is the primary UX.
2. **`@image(<path>)` syntax** — explicit inline reference to an image file on disk.
3. **Bare image file path** — auto-detected paths ending in a known image extension.

Images are base64-encoded and included as `ImageBlock` content blocks in the `UserMessage`.

---

## Current Architecture

### Message types (`provider.ts`)

```
UserMessage.content = (TextBlock | ToolResultContent)[]
```

There is no `ImageBlock` type. The only blocks a user message can contain are `text` and `tool_result`.

### Input handling (`tui.ts`)

`handleData` processes raw stdin bytes. Ctrl+V arrives as `\x16` (literal byte). The TUI currently does not handle `\x16` — it falls through to `insertCharAtCursor` and inserts a control character. There is no clipboard reading.

The TUI communicates user intent via callbacks: `onSubmit`, `onTab`, `onEscape`. A new `onPasteImage` callback follows the same pattern.

### Provider message translation

- **Anthropic** (`providers/anthropic.ts`): `toAnthropicMessages` maps `TextBlock` and `ToolResultContent`. No image block handling.
- **OpenAI** (`providers/openai.ts`): `toResponsesInput` maps text/tool_result blocks. No image block handling.
- **OpenCode Zen** (`providers/opencode-zen.ts`): `toOaiMessages` flattens user content to strings. No image block handling.

### Prompt construction (`app.ts`)

```ts
const userMsg: UserMessage = {
  role: "user",
  content: [{ type: "text", text: userMessage }],
};
```

`handleUserInput` and `prompt` only accept a `string`. There is no concept of attachments.

---

## API Research Summary

Based on research in `image-research-results.md`:

### Format support (intersection of Anthropic + OpenAI)

Both providers accept: **JPEG, PNG, GIF (non-animated / first frame only), WebP**.

### Size limits

| Provider | Per-image limit | Request limit |
|----------|----------------|---------------|
| Anthropic | **5 MB** per image | 32 MB total request |
| OpenAI | No per-image limit stated | 512 MB total payload |

**Anthropic is the binding constraint at 5 MB per image.**

### Sending mechanism

| Provider | Wire format for base64 images |
|----------|-------------------------------|
| Anthropic | `image` content block with `source.type: "base64"`, `media_type`, and `data` |
| OpenAI (Responses API) | `input_image` part with `image_url: "data:<mime>;base64,<data>"` |
| OpenAI (Chat Completions / OpenCode Zen) | `image_url` content part with `url: "data:<mime>;base64,<data>"` |

### Image ordering

Anthropic recommends placing images **before** the text instruction. We emit `ImageBlock`s before `TextBlock`s.

### Detail level (OpenAI only)

OpenAI exposes `detail` (`low`, `high`, `auto`). We default to `auto`.

---

## Terminal Clipboard Landscape

Reading images from the clipboard in a terminal app is a solved-but-fragmented problem. Key findings from researching Claude Code, OpenCode, Ghostty, Kitty, WezTerm, and iTerm2:

### Why terminal paste (Cmd+V / Ctrl+Shift+V) doesn't work for images

Most terminal emulators' paste action (`PasteFrom(clipboard)`) is **text-only by design**. When the clipboard contains only an image (no text), the paste action either sends nothing or sends empty bytes. This affects Kitty, Ghostty, WezTerm, and most others. Only Alacritty pipes raw binary clipboard bytes (including PNG data) through bracketed paste.

### OSC 52 — text only

OSC 52 is the standard terminal clipboard protocol, but it has no MIME type field and only handles text. It cannot transport image data.

### OSC 5522 (Kitty clipboard protocol) — images but poor adoption

Kitty's OSC 5522 extends OSC 52 with MIME type support and can read `image/png` from the clipboard via escape sequences. However, as of May 2026:
- **Kitty**: supported (the only terminal with full support)
- **Ghostty**: PR in progress, not yet shipped
- **iTerm2, WezTerm, Terminal.app, VS Code, Warp, Cursor**: not supported

OSC 5522 is the right long-term answer but adoption is too low for it to be the primary mechanism today.

### What Claude Code and OpenCode actually do: shell out to OS clipboard tools

The proven, cross-platform approach used by Claude Code and OpenCode is to **spawn a native clipboard tool as a subprocess** on Ctrl+V:

| Platform | Tool | Command |
|----------|------|---------|
| macOS | `osascript` | AppleScript writes `the clipboard as «class PNGf»` to a temp file, then Node reads the file bytes |
| Linux (Wayland) | `wl-paste` | `wl-paste --list-types`, then `wl-paste --type <mime>` |
| Linux (X11) | `xclip` | `xclip -selection clipboard -t TARGETS -o`, then `xclip -selection clipboard -t <mime> -o` |

This approach:
- Works in every terminal emulator (the app reads the clipboard, not the terminal).
- Works through tmux and screen (the subprocess accesses the system clipboard directly).
- Does **not** work over SSH to a headless remote (no display server). OSC 5522 is needed for that, which we can add later.

### Our approach: shell out on Ctrl+V, with graceful fallback

We intercept `\x16` (Ctrl+V) in the TUI. Instead of inserting a control character, we spawn the appropriate OS clipboard tool to check for image data. If an image is found, we attach it to the pending message. If no image is found (text-only clipboard or tool missing), we do nothing (text paste via terminal's own Cmd+V / Ctrl+Shift+V continues to work as before through the normal `handleData` path).

---

## Design

### Pending images model

The TUI maintains a list of pending image attachments (`pendingImages: ImageAttachment[]`). Images are added by:
- Ctrl+V clipboard paste
- Detected from `@image(...)` / bare paths at submit time

When the user submits, pending images are combined with the text to form the `UserMessage` content blocks.

```ts
type ImageAttachment = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64
  label: string; // e.g. "clipboard-1", "screenshot.png"
};
```

### Clipboard reading (`clipboard.ts` — new file)

A small module that detects the platform and spawns the appropriate tool:

```ts
export type SupportedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type ClipboardImage = {
  mediaType: SupportedImageMediaType;
  data: Buffer;
};

export async function readClipboardImage(): Promise<ClipboardImage | null> { ... }
```

Logic:
1. **macOS**: Run `osascript` with AppleScript that writes clipboard image data to a temp PNG file, then read the file back. Do **not** base64-encode raw `osascript` stdout unless the implementation explicitly decodes AppleScript's `«data PNGf... »` data literal; stdout is not guaranteed to be raw PNG bytes. If no image data is on the clipboard, return `null`.
2. **Linux (Wayland)**: Detect via `$WAYLAND_DISPLAY`. Run `wl-paste --list-types`, choose the first supported image MIME type in preference order `image/png`, `image/jpeg`, `image/webp`, `image/gif`, then run `wl-paste --type <mime>`. If exit code non-zero or empty stdout, return `null`.
3. **Linux (X11)**: Detect via `$DISPLAY`. Run `xclip -selection clipboard -t TARGETS -o`, choose the first supported image MIME type in the same preference order, then run `xclip -selection clipboard -t <mime> -o`. If exit code non-zero or empty stdout, return `null`.
4. **Fallback**: Return `null` (no image paste support, user can still use `@image(...)` syntax).

Linux clipboard tools generally do **not** transcode between image formats; they only read MIME targets already offered by the clipboard owner. macOS may convert clipboard image data to PNG through the AppleScript path, so macOS clipboard images are returned as PNG, while Linux clipboard images keep the selected source MIME type.

### Ctrl+V flow

1. User presses Ctrl+V.
2. TUI calls `onPasteImage` callback (async).
3. `app.ts` calls `readClipboardImage()`.
4. If image found:
   - Validate size ≤ 5 MB.
   - Validate aggregate pending-image size against provider/request limits (see **Size validation and message retention**).
   - Base64-encode.
   - Add to `pendingImages` array.
   - Show `[Image: clipboard-N]` indicator in the input area or as a status line badge.
5. If no image found:
   - Do nothing (no error — the user may have meant to paste text via the terminal's own paste).
6. On submit, `pendingImages` are included in the message.

### `@image()` syntax (complementary path)

At submit time, the text is scanned for `@image(<path>)` patterns and bare image file paths. These are resolved to `ImageAttachment`s the same way clipboard images are, and added to the content blocks.

`@image(...)` tokens are removed from the text sent to the model and replaced in the TUI display with readable attachment labels (for example `[Image: screenshot.png]`). Bare image paths are left in the text by default, because they may be meaningful context; the matching file is attached in addition to the text reference.

### Size validation and message retention

Validate both raw file size and encoded/request size:

- Per image: raw bytes must be ≤ 5 MB, matching Anthropic's binding per-image cap.
- Current turn: sum of raw pending/parsed image bytes should stay comfortably below Anthropic's 32 MB total request cap after base64 expansion. Use an encoded-size estimate (`Math.ceil(rawBytes / 3) * 4`) when checking.
- Conversation history: image blocks remain in `messages` and are resent on later turns. Before each provider call, estimate total base64 image payload already present in `messages`; if it approaches the provider request cap, stop with a clear TUI error and suggest starting `/new` or removing images in a future compaction feature.

### Vision capability gating

Add a model capability flag so the app can fail before provider translation:

```ts
export type ModelConfig = {
  // ...existing fields...
  supportsImages: boolean;
};
```

When parsed or pending images are present and `currentModelConfig().supportsImages` is false, show an error block such as `Current model does not support image input: <model>` and do not send the message.

### Content block ordering

Following Anthropic's recommendation, all `ImageBlock`s are placed **before** any `TextBlock` in the `UserMessage.content` array.

### Supported formats

- **Clipboard paste**: macOS returns PNG; Linux returns the selected offered MIME type among JPEG, PNG, GIF, and WebP.
- **`@image()` / bare path**: JPEG, PNG, GIF, WebP (determined by file extension).

---

## Changes by File

### 1. `provider.ts` — Add `ImageBlock` type

```ts
export type ImageBlock = {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Base64-encoded image data. */
  data: string;
};
```

Update `UserMessage`:

```ts
export type UserMessage = {
  role: "user";
  content: (TextBlock | ImageBlock | ToolResultContent)[];
};
```

No changes to `ContentBlock` (assistant-side) or streaming types.

Update `ModelConfig` with image capability metadata:

```ts
export type ModelConfig = {
  // ...existing fields...
  supportsImages: boolean;
};
```

Set `supportsImages` explicitly for every model entry. Use this to reject image attachments before provider calls when the selected model cannot accept vision input.

### 2. `clipboard.ts` (new) — Cross-platform clipboard image reading

~100 lines. Exports `readClipboardImage()`. Platform detection via environment variables (`$WAYLAND_DISPLAY`, `$DISPLAY`, `process.platform`). Uses `child_process.execFile` with a timeout (2 seconds) to avoid hanging. Includes MIME target discovery on Linux and temp-file cleanup on macOS.

### 3. `app.ts` — Image attachment lifecycle + `@image()` parsing

**New state:**
```ts
let pendingImages: ImageAttachment[] = [];
```

**New callback for TUI:**
```ts
onPasteImage: handlePasteImage
```

**`handlePasteImage()`** — called by TUI on Ctrl+V:
- Serializes paste attempts with a small in-flight guard/queue so repeated Ctrl+V presses cannot race the pending image state.
- Calls `readClipboardImage()`.
- If image found and ≤ 5 MB and aggregate limits pass, base64-encodes and adds to `pendingImages`.
- Updates TUI status to show `[Image: clipboard-N]`.
- If not found, does nothing.
- Catches all errors and reports at most a concise status message; clipboard subprocess failures must not become unhandled promise rejections.

**`parseUserInput(raw: string)`** — called at submit time:
- Scans for `@image(...)` patterns and bare image file paths.
- Reads files, validates ≤ 5 MB, validates aggregate request/image limits, determines MIME from extension, base64-encodes.
- Removes `@image(...)` tokens from the model text and uses attachment labels in `displayText`; leaves bare image paths in model text.
- Returns `{ displayText, contentBlocks, images }` with images before text.
- Merges `pendingImages` (from clipboard paste) with parsed images.
- Checks `currentModelConfig().supportsImages` before sending any image blocks.
- Clears `pendingImages` only after a successful submit/parse; keep them if validation fails so the user can fix text or change model.

**`prompt()`** updated:
- Calls `parseUserInput(userMessage)`.
- Uses `parsed.displayText` for the TUI display block.
- Uses `parsed.contentBlocks` for `userMsg.content`.

### 4. `tui.ts` — Ctrl+V interception + image indicator

**In `handleData`:** Add a check for `\x16` (Ctrl+V) early in the character loop:
```ts
if (char === "\x16") {
  void Promise.resolve(this.options.onPasteImage?.()).catch(() => {
    // Swallow here; app-level handler is responsible for user-visible status.
  });
  continue;
}
```

**Image indicator:** When images are pending, show a count in the input area or status line, e.g., `📎 2 images`. The `Tui` class gets a `setImageCount(count: number)` method called by `app.ts`.

**Constructor options:** Add `onPasteImage?: () => void | Promise<void>` to the options type. The TUI should call it through `Promise.resolve(...).catch(...)` or an equivalent `void` wrapper so async failures are handled and cannot crash the process.

### 5. `providers/anthropic.ts` — Map `ImageBlock`

In `toAnthropicMessages`, handle the `image` block type:

```ts
if (block.type === "image") {
  return {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: block.mediaType,
      data: block.data,
    },
  };
}
```

### 6. `providers/openai.ts` — Map `ImageBlock`

In `toResponsesInput`, build one Responses user message per logical `UserMessage` when it contains text/images. Do not emit a separate user message per image. Tool results still become separate `function_call_output` items.

```ts
const parts: Array<
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
> = [];

for (const block of msg.content) {
  if (block.type === "image") {
    parts.push({
      type: "input_image",
      image_url: `data:${block.mediaType};base64,${block.data}`,
      detail: "auto",
    });
  } else if (block.type === "text") {
    parts.push({ type: "input_text", text: block.text });
  } else {
    // flush parts first, then emit function_call_output
  }
}

if (parts.length > 0) {
  items.push({ role: "user", content: parts });
}
```

### 7. `providers/opencode-zen.ts` — Map `ImageBlock`

Extend `OaiMessage` user variant to support multi-part content:

```ts
type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

// User message content becomes string | OaiContentPart[] when images present
```

In `toOaiMessages`, when a user message has image blocks, emit multi-part content array. When no images, keep plain-string for backward compatibility.

---

## Implementation Order & Dependencies

```
Step 1: provider.ts          — Add ImageBlock type, update UserMessage
Step 2: clipboard.ts (new)   — Cross-platform clipboard image reader
Step 3: tui.ts               — Ctrl+V interception, image count indicator, onPasteImage callback
Step 4: app.ts               — handlePasteImage, parseUserInput, pendingImages lifecycle
Step 5: anthropic.ts         — Handle image blocks in toAnthropicMessages
Step 6: openai.ts            — Handle image blocks in toResponsesInput
Step 7: opencode-zen.ts      — Handle image blocks in toOaiMessages
Step 8: provider.ts/models   — Add supportsImages capability to ModelConfig entries
Step 9: tsconfig.json         — Add clipboard.ts to includes
Step 10: npm run lint         — Verify no type errors
```

Steps 5–7 are independent of each other and can be done in any order.

---

## User-Facing Syntax

### Ctrl+V clipboard paste (primary UX)

```
1. Copy a screenshot or image to clipboard (Cmd+Shift+4 on macOS, etc.)
2. In the input area, press Ctrl+V
3. Status shows: 📎 1 image
4. Type your question and press Enter
5. Message is sent with the image attached
```

Multiple Ctrl+V presses add multiple images. Each press reads the clipboard again (so the user can copy different images between presses).

### `@image()` syntax

```
Tell me what's in this screenshot @image(./screenshot.png)
Compare these two diagrams @image(before.png) @image(after.png)
```

### Bare image path (auto-detected)

```
What's in ./photo.jpg
```

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Ctrl+V with no image on clipboard | Do nothing silently (text paste handled by terminal's own Cmd+V / Ctrl+Shift+V) |
| Ctrl+V and clipboard tool not installed | Do nothing silently (warn on first attempt: "Install xclip or wl-clipboard for image paste") |
| File doesn't exist (`@image()`) | Show error block: `Image not found: <path>` — don't send |
| File too large (> 5 MB) | Show error block: `Image too large: <path> (max 5 MB)` — don't send. Matches Anthropic's per-image API cap. |
| Clipboard image too large (> 5 MB) | Show status message: `Image too large (max 5 MB)` — don't attach |
| Unsupported extension | Treat as plain text (not an image reference) |
| Multiple images | All included as separate `ImageBlock`s, placed before text |
| Only images, no text | Content is just `ImageBlock`(s) — models accept this |
| `~` in path | Expand via `expandHomePath()` (exists in `tool.ts`, extract to shared util) |
| Animated GIF | Accepted with current provider limitations noted; if a provider rejects it, show the provider error |
| Aggregate image payload too large | Show error block explaining the request is too large and suggest `/new` or fewer/smaller images; don't send |
| Model does not support images | Show error block and don't send; keep pending images so the user can switch model or clear/start `/new` |
| Running over SSH (headless) | Clipboard tools fail silently → `null` → no image. User can still use `@image()` with file paths. |
| Running inside tmux/screen | Works — the subprocess accesses the system clipboard directly, not the terminal's paste buffer. |

---

## File Size Estimate

| File | Lines added | Lines modified |
|------|-------------|----------------|
| `provider.ts` | ~15 | ~8 |
| `clipboard.ts` (new) | ~100 | — |
| `tui.ts` | ~15 | ~5 |
| `app.ts` | ~140 | ~20 |
| `providers/anthropic.ts` | ~10 | ~0 |
| `providers/openai.ts` | ~30 | ~10 |
| `providers/opencode-zen.ts` | ~25 | ~12 |
| `tsconfig.json` | ~1 | ~0 |
| **Total** | **~336** | **~55** |

---

## Out of Scope (Future)

- **OSC 5522 clipboard protocol** — the right long-term answer for image paste, especially over SSH. Currently only Kitty supports it. When Ghostty and others ship support, we should add it as a higher-priority path before falling back to OS clipboard tools.
- **Image URL support** — `@image(https://...)` fetching a remote image. Both providers accept URL-based image inputs natively. Easy to add later.
- **Inline image preview in TUI** — iTerm2 (OSC 1337) and Kitty graphics protocol can render images inline in terminal output. Has good adoption (iTerm2, Ghostty, WezTerm, Kitty, Terminal.app all support at least one protocol). Nice-to-have for the future.
- **Files API integration** — both Anthropic and OpenAI offer persistent file upload APIs. Reduces payload size for multi-turn conversations reusing images. Adds upload lifecycle complexity.
- **OpenAI `detail` parameter exposure** — could expose as `@image(path, detail=low)` later.
- **Per-provider dimension validation** — Anthropic caps at 8000×8000 px; we let providers resize automatically.
- **Windows/WSL clipboard support** — could use `powershell.exe Get-Clipboard` or `clip.exe`. Not a priority for current user base.
