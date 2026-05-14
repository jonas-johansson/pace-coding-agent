# Slash Command & File Reference Suggestion List — Feature Plan

## Overview

When the user types `/` at the start of the input box, a suggestion list appears showing available slash commands. When the user types `@` anywhere in the input, a suggestion list appears showing files from the project. The user can navigate with ↑/↓ and autocomplete with Tab or Enter.

**Key behavior**: If the user types a complete, exact command or file path, the suggestion popup hides automatically so Enter submits the input directly rather than "picking" from the list.

## Available Slash Commands

The following commands are handled in `app.ts` (`handleCommand`):

| Command | Description |
|---------|-------------|
| `/new` | Clear conversation state and start fresh |
| `/exit` | Exit the application |
| `/quit` | Exit the application |
| `/model` | Show or switch the current model |
| `/skills` | List available skills |
| `/skill:<name>` | Load and run a skill |

## Data Model

### Suggestion Item (Unified)

Both `/` commands and `@` files use a single suggestion item type.

```ts
type SuggestionItem = {
  label: string;      // display text, e.g. "/new" or "docs/manual.md"
  detail: string;       // description or file type indicator
  kind: "command" | "file";
  insertText: string;   // what gets written on autocomplete, e.g. "/new " or "@docs/manual.md"
};
```

### Providers

The TUI receives two providers via constructor options so `app.ts` owns the data.

```ts
type SubmitHandler = (input: string) => void | Promise<void>;
type SuggestionProvider = () => SuggestionItem[];
type FileSuggestionProvider = () => Promise<string[]>; // returns relative file paths

constructor(options: {
  onSubmit?: SubmitHandler;
  onTab?: () => void;
  onShiftTab?: () => void;
  onEscape?: () => void;
  onPasteImage?: () => void | Promise<void>;
  slashCommands?: SuggestionProvider;
  fileSuggestions?: FileSuggestionProvider;
  model?: string;
  cwd?: string;
} = {})
```

## UI State

Add the following private fields to `Tui`:

```ts
private slashItems: SuggestionItem[] = [];
private filePaths: string[] = [];            // cached file list from provider
private filePathsLoaded = false;             // have we fetched files yet?
private filePathsLoading = false;            // is a fetch in flight?
private suggestionMode: "none" | "slash" | "file" = "none";
private suggestionQuery = "";                // text after the trigger character
private suggestionIndex = 0;                 // selected item in filtered list
private suggestionActive = false;            // is the popup visible?
private suggestionTokenStart = 0;            // char offset where the trigger token starts
private suggestionTokenEnd = 0;                // char offset where the trigger token ends
```

## Trigger Detection

### Slash Mode (`/`)

The popup shows when:
- The input starts with `/`.
- The cursor is positioned within the first token (no spaces typed yet).
- The input contains no newline before the cursor.
- The current input is **NOT** an exact match for any slash command label.

Extracted as:
```ts
const query = this.input.slice(1);
```

### File Mode (`@`)

The popup shows when:
- The character immediately before the cursor, or somewhere back to the previous whitespace, starts with `@`.
- The cursor is positioned within that token (no space typed after the `@` token).
- The current `@token` is **NOT** an exact match for any file path.

Token extraction (cursor-relative):
```ts
private extractFileToken(): { query: string; start: number; end: number } | null {
  const chars = Array.from(this.input);
  let start = this.inputCursor - 1;
  while (start >= 0 && chars[start] !== " " && chars[start] !== "\n") {
    start -= 1;
  }
  start += 1;
  const end = this.inputCursor;
  const token = chars.slice(start, end).join("");
  if (token.startsWith("@")) {
    return { query: token.slice(1), start, end };
  }
  return null;
}
```

If the user types a space, moves the cursor out of the token, or deletes the `@`, the popup dismisses.

### Mode Priority

If both `/` and `@` could match, slash mode wins because it is anchored to the start of input.

## Exact-Match Suppression

After computing the filtered matches, check whether the current token is an exact match for any of them. If so, hide the popup so Enter submits directly.

```ts
private hasExactMatch(matches: SuggestionItem[], fullToken: string): boolean {
  const tokenLower = fullToken.toLowerCase();
  return matches.some((item) => item.label.toLowerCase() === tokenLower);
}
```

Applied in `updateSuggestions()`:

```ts
// After computing matches...
if (matches.length > 0) {
  const fullToken = this.suggestionMode === "slash"
    ? this.input
    : "@" + file.query;
  if (this.hasExactMatch(matches, fullToken)) {
    this.dismissSuggestions();
    return;
  }
  // ...show popup
}
```

**Why case-insensitive?** Command names are effectively case-insensitive in the app. For files, users typically type the correct case; case-insensitive matching is pragmatic and avoids popup annoyance on case-insensitive filesystems.

### Examples

| Input | Matches | Exact? | Popup |
|-------|---------|--------|-------|
| `/` | all commands | no | **show** |
| `/n` | `/new`, `/model`, ... | no | **show** |
| `/new` | `/new` only | yes | **hide** — Enter submits `/new` |
| `/new stuff` | (dismissed by space) | — | **hide** |
| `/skill:` | `/skill:<name>` | no | **show** — label is `/skill:<name>`, not `/skill:` |
| `@` | all files | no | **show** |
| `@app` | `app.ts`, `app.tsx` | no | **show** |
| `@app.ts` | `app.ts` (exact), `app.tsx` | yes | **hide** — Enter submits `@app.ts` |

## Trigger / Dismiss Rules

- **Show `/`**: `this.input.startsWith("/")`, cursor in first token, no spaces in input, not an exact match.
- **Show `@`**: Cursor is inside a word that starts with `@`, not an exact match.
- **Hide**: Token no longer starts with trigger character, space typed inside token, cursor moved outside token, exact match reached, Enter submits, or Escape is pressed.
- **Dismiss on Escape**: If suggestions are active, Escape first dismisses them; a second Escape cancels the running prompt as before.
- **Dismiss on Arrow Up/Down when not active**: Normal history navigation. When active, Up/Down navigate suggestions instead.
- **Dismiss on Tab / Enter**: Autocomplete and dismiss.

## Filtering

### Slash Filtering

```ts
const query = this.input.slice(1);
const matches = this.slashItems.filter(item =>
  item.label.toLowerCase().includes(query.toLowerCase())
);
```

### File Filtering

```ts
const matches = this.filePaths
  .filter(path => path.toLowerCase().includes(query.toLowerCase()))
  .map(path => ({
    label: path,
    detail: "file",
    kind: "file" as const,
    insertText: `@${path}`,
  }));
```

If `matches` is empty, hide the popup.

Clamp `suggestionIndex` to `0 … matches.length - 1` whenever the query changes.

## Navigation

### Arrow Up (`\x1b[A`)
- If suggestions active: `suggestionIndex = Math.max(0, suggestionIndex - 1)`.
- Otherwise: existing history-up behavior.

### Arrow Down (`\x1b[B`)
- If suggestions active: `suggestionIndex = Math.min(matches.length - 1, suggestionIndex + 1)`.
- Otherwise: existing history-down behavior.

### Tab (`\t`) or Enter (`\r`)
- If suggestions active: autocomplete with the selected item's `insertText`, dismiss popup, move cursor to end of inserted text.
- Tab otherwise: existing `onTab` (cycle model).
- Enter otherwise: submit input.

### Escape (`\x1b`)
- If suggestions active: dismiss popup, keep input unchanged.
- Otherwise: existing cancel-running-prompt behavior.

### Typing characters / Backspace
- Recompute trigger detection, filter, exact-match check, and re-render. If input no longer qualifies, dismiss.

## Autocomplete Behavior

### Slash Autocomplete

Tab or Enter replaces the **entire input** with the selected command's `insertText`:

```ts
this.input = matches[suggestionIndex].insertText; // e.g. "/new "
this.inputCursor = this.input.length;
this.suggestionActive = false;
```

### File Autocomplete

Tab or Enter replaces **only the current token** with the selected file's `insertText` plus a trailing space:

```ts
const chars = Array.from(this.input);
const before = chars.slice(0, this.suggestionTokenStart).join("");
const after = chars.slice(this.suggestionTokenEnd).join("");
this.input = before + matches[suggestionIndex].insertText + " " + after;
this.inputCursor = this.suggestionTokenStart + matches[suggestionIndex].insertText.length + 1;
this.suggestionActive = false;
```

Example: input is `check @docs/ma` → Tab/Enter → `check @docs/manual.md ` (cursor after the trailing space).

## File Discovery

### Provider Implementation in `app.ts`

Use `rg --files` (respects `.gitignore`) to list project files. Exclude standard build directories.

```ts
async function getProjectFiles(): Promise<string[]> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  try {
    const { stdout } = await execAsync(
      `rg --files --hidden -g '!node_modules/' -g '!.git/' -g '!dist/' -g '!build/' -g '!coverage/' -g '!.next/' -g '!vendor/'`,
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
```

### Caching

- Cache the file list in `Tui` after the first successful fetch.
- Refresh on explicit user action only (future enhancement). For now, stale cache is acceptable because file trees change infrequently during a session.
- If the provider returns an empty list, do not enter file suggestion mode.

## Input Box Highlighting

Slash commands (`/word`) and file mentions (`@word`) are highlighted in the input box with distinct colors.

### Highlighting Rules

- A `/word` token is highlighted when `/` is at the start of the line or preceded by a non-alphanumeric character.
- An `@word` token is highlighted when `@` is at the start of the line or preceded by a non-alphanumeric character.
- The highlight applies per wrapped visible line. If a token is split across two wrapped lines, only the portion on each line is highlighted.

### Colors

- Normal input text: `inputFg` (252 for normal mode, 179 for bash mode)
- Slash command tokens: `fg(117)` (cyan accent)
- File mention tokens: `fg(151)` (green)
- Background: `inputBg` (236 for normal, 237 for bash)

### Implementation

A `highlightInputLine(line: string, inputFg: number): string` function parses a plain text line and builds an ANSI string with colored segments. The `renderInputLine` method replaces `renderBar` for content rows with a custom renderer that:

1. Adds horizontal padding spaces with default input colors
2. Builds the highlighted content via `highlightInputLine`
3. Pads the remainder of the terminal width with background color

```ts
function highlightInputLine(line: string, inputFg: number): string {
  const segments: { text: string; color: number }[] = [];
  let index = 0;

  while (index < line.length) {
    let found = false;
    for (let i = index; i < line.length; i++) {
      const ch = line[i];
      if (ch === "/" || ch === "@") {
        const isWordStart = i === index || !/[\p{L}\p{Nd}]/u.test(line[i - 1]);
        if (isWordStart) {
          if (i > index) {
            segments.push({ text: line.slice(index, i), color: inputFg });
          }
          let j = i + 1;
          while (j < line.length && line[j] !== " ") {
            j++;
          }
          const word = line.slice(i, j);
          const color = ch === "/" ? 117 : 151;
          segments.push({ text: word, color });
          index = j;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      segments.push({ text: line.slice(index), color: inputFg });
      break;
    }
  }

  let result = "";
  for (const seg of segments) {
    result += `${fg(seg.color)}${seg.text}`;
  }
  return result;
}
```

The input row is then rendered as:

```ts
const prefix = " ".repeat(horizontalPadding);
const highlighted = highlightInputLine(line, inputFg);
const visibleWidth = horizontalPadding + displayWidth(line);
const pad = Math.max(0, columns - visibleWidth);
return `${bg(inputBg)}${fg(inputFg)}${prefix}${highlighted}${" ".repeat(pad)}${RESET}`;
```

## Rendering

The suggestion popup renders **above** the input box, as extra lines inserted between `messageLines` and `inputSection` in `render()`.

### Layout

- Max height: 6 lines (5 items + 1 optional "more..." indicator).
- Width: same as terminal `columns`.
- Background: `PANEL_BG` (235) for contrast against the black canvas.
- Each line: `  label    detail  ` padded to full width.
- Selected line: inverse video (`INVERSE`).
- Command items: accent color (117) for the label.
- File items: normal foreground (252) for the label, dim (245) for the detail.

### Row Budget

The popup steals rows from `messageRows`. When the popup is visible:

```ts
const popupRows = Math.min(matches.length, MAX_SUGGESTION_ROWS);
const messageRows = Math.max(0, rows - statusRows - input.lines.length - popupRows);
```

This naturally pushes older messages up, exactly like any new block would.

### Rendering Function

```ts
private renderSuggestionPopup(
  columns: number,
  matches: SuggestionItem[],
  selectedIndex: number,
): string[] {
  const maxRows = Math.min(matches.length, MAX_SUGGESTION_ROWS);
  const lines: string[] = [];
  for (let i = 0; i < maxRows; i++) {
    const item = matches[i];
    const isSelected = i === selectedIndex;
    const prefix = isSelected ? `${INVERSE}` : "";
    const suffix = isSelected ? `${RESET}` : "";
    const labelColor = item.kind === "command" ? fg(117) : fg(252);
    const label = item.label.padEnd(20, " ");
    const detail = item.detail;
    const text = `  ${label} ${detail}`;
    const clipped = clipAnsi(text, columns - 4);
    const pad = Math.max(0, columns - 4 - visibleLength(clipped));
    lines.push(
      `${bg(PANEL_BG)}  ${prefix}${labelColor}${clipped}${suffix}${" ".repeat(pad)}  ${RESET}`,
    );
  }
  return lines;
}
```

If `matches.length > MAX_SUGGESTION_ROWS`, append a dim line: `  … and N more  `.

## Integration Points

### `tui.ts`

1. **Constructor**: accept `slashCommands` and `fileSuggestions` providers, store them.
2. **`handleData` / `handleEscape`**: intercept Up/Down/Tab/Enter/Escape when `suggestionActive`.
3. **`insertCharAtCursor` / `deleteBackward`**: after mutating input, call `updateSuggestions()`.
4. **`render()`**: compute popup rows, subtract from message rows, insert popup lines between messages and input.
5. **`renderInputLine()`**: use `highlightInputLine` for colored input rendering.
6. **New methods**:
   - `updateSuggestions()` — detect mode (`slash`/`file`/`none`), extract query, filter, check exact match, clamp index, set `suggestionActive`.
   - `dismissSuggestions()` — clear state.
   - `acceptSuggestion()` — autocomplete based on current mode.
   - `ensureFilePaths()` — async cache fetch for file list.
   - `highlightInputLine()` — build ANSI-colored input line.
   - `hasExactMatch()` — check if any match label equals the current token.

### `app.ts`

Pass both providers when constructing `Tui`:

```ts
const tui = new Tui({
  onSubmit: handleUserInput,
  onTab: cycleModel,
  onShiftTab: cycleModelReverse,
  onEscape: cancelPrompt,
  onPasteImage: handlePasteImage,
  slashCommands: () => [
    { label: "/new", detail: "Start a new conversation", kind: "command", insertText: "/new " },
    { label: "/exit", detail: "Exit the application", kind: "command", insertText: "/exit " },
    { label: "/quit", detail: "Exit the application", kind: "command", insertText: "/quit " },
    { label: "/model", detail: "Show or switch model", kind: "command", insertText: "/model " },
    { label: "/skills", detail: "List available skills", kind: "command", insertText: "/skills " },
    { label: "/skill:<name>", detail: "Load and run a skill", kind: "command", insertText: "/skill:" },
  ],
  fileSuggestions: getProjectFiles,
  model: DEFAULT_MODEL_ID,
  cwd: process.cwd(),
});
```

## Edge Cases

| Case | Behavior |
|------|----------|
| User types `/` then deletes it | Popup disappears immediately |
| User types `/new stuff` (space after command) | Popup dismissed on space; input is a normal command submission |
| User types `@` then deletes it | Popup disappears immediately |
| User types `check @docs/ma then more` (space after path) | Popup dismissed on space after the token |
| No matches for query | Popup hidden; input behaves normally |
| Terminal resized while popup open | Re-render with new width; clamp rows |
| Popup visible and user presses Enter | Accepts suggestion (not submit) |
| Popup visible and user presses Ctrl+C | Dismisses popup, then clears input / exit logic |
| Multi-line input with `/` on first line | Only shows popup when cursor is in the first line and input still qualifies |
| History recalled while popup would be active | Dismisses popup; history takes precedence |
| `rg` is not installed | File provider returns empty list; `@` suggestions never appear |
| Project has >5000 files | List is capped; user types more to filter down |
| File token at end of input | Autocomplete adds trailing space for continued typing |
| File token in middle of input | Autocomplete adds trailing space; text after token shifts right |
| Exact match with multiple substring matches (e.g. `@app.ts` with `app.ts` and `app.tsx`) | Popup hides because exact match exists; Enter submits `@app.ts` |
| `/skill:` typed | Popup shows because label is `/skill:<name>`, not `/skill:` |
| Exact match user presses Backspace (`/new` → `/ne`) | Popup reappears because `/ne` is no longer an exact match |

## Files to Modify

- `tui.ts` — all suggestion logic, rendering, input handling, input highlighting, exact-match suppression.
- `app.ts` — pass `slashCommands` and `fileSuggestions` to `Tui` constructor; implement `getProjectFiles`.

## Testing Checklist (Manual)

### Slash Commands
1. Type `/` — popup appears with all commands.
2. Type `n` — list filters to `/new`, `/skill:<name>` (if substring matching).
3. Press Down twice, Up once — selection moves correctly.
4. Press Tab — input becomes `/new `, cursor at end, popup gone.
5. Press Enter (with popup open) — same as Tab.
6. Press Escape while popup visible — popup gone, input unchanged.
7. Type `/xyz` — popup disappears (no matches).
8. Resize terminal — popup re-renders correctly.
9. Submit a command via suggestion — works end-to-end.
10. Type `/new` in input box — `/new` appears in cyan (117), **popup hides**, pressing Enter submits `/new` directly.
11. Type `/new` then Backspace → `/ne` — **popup reappears**.
12. Type `/skill:` — **popup shows** (not an exact match for `/skill:<name>`).

### File References
1. Type `check @` — popup appears with project files (after brief async load).
2. Type `d` — list filters to paths containing `d`.
3. Press Down to select `docs/manual.md`.
4. Press Tab — input becomes `check @docs/manual.md `, cursor after trailing space, popup gone.
5. Press Enter (with popup open) — same as Tab.
6. Type `compare @src/` — popup filters to `src/` subtree.
7. Press Escape — popup gone, input unchanged.
8. Type `@nonexistent` — popup disappears (no matches).
9. Resize terminal — popup re-renders correctly.
10. Type `look at @app.ts` — `@app.ts` appears in green (151) in input box, **popup hides if exact match**, Enter submits directly.
11. Type `cd /path and @file.txt` — both `/path` and `@file.txt` highlighted in input.
