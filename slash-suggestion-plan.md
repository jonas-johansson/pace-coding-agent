# Slash Command & File Reference Suggestion List — Feature Plan

## Overview

When the user types `/` at the start of the input box, a suggestion list appears showing available slash commands. When the user types `@` anywhere in the input, a suggestion list appears showing files from the project. The user can navigate with ↑/↓ and autocomplete with Tab.

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

Extracted as:
```ts
const query = this.input.slice(1); // remove leading "/"
```

### File Mode (`@`)

The popup shows when:
- The character immediately before the cursor, or somewhere back to the previous whitespace, starts with `@`.
- The cursor is positioned within that token (no space typed after the `@` token).

Token extraction (cursor-relative):
```ts
private extractFileToken(): { query: string; start: number; end: number } | null {
  const chars = Array.from(this.input);
  let start = this.inputCursor - 1;
  // Walk back to find the start of the current word
  while (start >= 0 && chars[start] !== " " && chars[start] !== "\n") {
    start -= 1;
  }
  start += 1; // move to first char of the word
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

If both `/` and `@` could match (e.g. input is `/something@else` — unlikely), slash mode wins because it is anchored to the start of input.

## Trigger / Dismiss Rules

- **Show `/`**: `this.input.startsWith("/")`, cursor in first token, no spaces in input.
- **Show `@`**: Cursor is inside a word that starts with `@`.
- **Hide**: Token no longer starts with trigger character, space typed inside token, cursor moved outside token, Enter submits, or Escape is pressed.
- **Dismiss on Escape**: If suggestions are active, Escape first dismisses them; a second Escape cancels the running prompt as before.
- **Dismiss on Arrow Up/Down when not active**: Normal history navigation. When active, Up/Down navigate suggestions instead.
- **Dismiss on Tab**: Autocomplete and dismiss.

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

### Tab (`\t`)
- If suggestions active: autocomplete with the selected item's `insertText`, dismiss popup, move cursor to end of inserted text.
- Otherwise: existing `onTab` (cycle model).

### Escape (`\x1b`)
- If suggestions active: dismiss popup, keep input unchanged.
- Otherwise: existing cancel-running-prompt behavior.

### Typing characters / Backspace
- Recompute trigger detection, filter, and re-render. If input no longer qualifies, dismiss.

## Autocomplete Behavior

### Slash Autocomplete

Tab replaces the **entire input** with the selected command's `insertText`:

```ts
this.input = matches[suggestionIndex].insertText; // e.g. "/new "
this.inputCursor = this.input.length;
this.suggestionActive = false;
```

### File Autocomplete

Tab replaces **only the current token** with the selected file's `insertText`:

```ts
const chars = Array.from(this.input);
const before = chars.slice(0, this.suggestionTokenStart).join("");
const after = chars.slice(this.suggestionTokenEnd).join("");
this.input = before + matches[suggestionIndex].insertText + after;
this.inputCursor = this.suggestionTokenStart + matches[suggestionIndex].insertText.length;
this.suggestionActive = false;
```

Example: input is `check @docs/ma` → Tab → `check @docs/manual.md ` (cursor at end of inserted path).

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
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 5000); // cap to avoid memory issues
  } catch {
    // rg not available — fall back to a minimal set or empty
    return [];
  }
}
```

### Caching

- Cache the file list in `Tui` after the first successful fetch.
- Refresh on explicit user action only (future enhancement). For now, stale cache is acceptable because file trees change infrequently during a session.
- If the provider returns an empty list, do not enter file suggestion mode.

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
      `${bg(PANEL_BG)}  ${prefix}${labelColor}${clipped}${suffix}${" ".repeat(pad)}  ${RESET}`
    );
  }
  return lines;
}
```

If `matches.length > MAX_SUGGESTION_ROWS`, append a dim line: `  … and N more  `.

## Integration Points

### `tui.ts`

1. **Constructor**: accept `slashCommands` and `fileSuggestions` providers, store them.
2. **`handleData` / `handleEscape`**: intercept Up/Down/Tab/Escape when `suggestionActive`.
3. **`insertCharAtCursor` / `deleteBackward`**: after mutating input, call `updateSuggestions()`.
4. **`render()`**: compute popup rows, subtract from message rows, insert popup lines between messages and input.
5. **New methods**:
   - `updateSuggestions()` — detect mode (`slash`/`file`/`none`), extract query, filter, clamp index, set `suggestionActive`.
   - `dismissSuggestions()` — clear state.
   - `acceptSuggestion()` — autocomplete based on current mode.
   - `ensureFilePaths()` — async cache fetch for file list.

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
| Popup visible and user presses Enter | Dismiss popup, submit input normally |
| Popup visible and user presses Ctrl+C | Dismiss popup, then handle clear-input / exit logic |
| Multi-line input with `/` on first line | Only show popup when cursor is in the first line and input still qualifies |
| History recalled while popup would be active | Dismiss popup; history takes precedence |
| `rg` is not installed | File provider returns empty list; `@` suggestions never appear |
| Project has >5000 files | List is capped; user types more to filter down |

## Files to Modify

- `tui.ts` — all suggestion logic, rendering, input handling.
- `app.ts` — pass `slashCommands` and `fileSuggestions` to `Tui` constructor; implement `getProjectFiles`.

## Testing Checklist (Manual)

### Slash Commands
1. Type `/` — popup appears with all commands.
2. Type `n` — list filters to `/new`, `/skill:<name>` (if substring matching).
3. Press Down twice, Up once — selection moves correctly.
4. Press Tab — input becomes `/new `, cursor at end, popup gone.
5. Press Escape while popup visible — popup gone, input unchanged.
6. Type `/xyz` — popup disappears (no matches).
7. Resize terminal — popup re-renders correctly.
8. Submit a command via suggestion — works end-to-end.

### File References
1. Type `check @` — popup appears with project files (after brief async load).
2. Type `d` — list filters to paths containing `d`.
3. Press Down to select `docs/manual.md`.
4. Press Tab — input becomes `check @docs/manual.md`, cursor at end of path, popup gone.
5. Type `compare @src/` — popup filters to `src/` subtree.
6. Press Escape — popup gone, input unchanged.
7. Type `@nonexistent` — popup disappears (no matches).
8. Resize terminal — popup re-renders correctly.
