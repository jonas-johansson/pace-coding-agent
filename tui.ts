type BlockRole = "user" | "assistant" | "tool" | "error";

export type BlockState = "running" | "done" | "error";

export type RenderBlock = {
  id: number;
  role: BlockRole;
  title?: string;
  content: string;
  collapsed?: boolean;
  state?: BlockState;
};

export type BlockPatch = Partial<Pick<RenderBlock, "title" | "content" | "state">>;

export type ContextInfo = {
  usedTokens: number;
  contextWindow: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type SubmitHandler = (input: string) => void | Promise<void>;
type SegmentStyle = "normal" | "bold" | "italic" | "code" | "heading" | "title";

type ScreenPosition = {
  row: number;
  col: number;
};

type SelectionRange = {
  anchor: ScreenPosition;
  focus: ScreenPosition;
};

type StyledSegment = {
  text: string;
  style: SegmentStyle;
};

type BlockTheme = {
  fg: number;
  bg: number;
  accent: number;
  bold: number;
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const INVERSE = "\x1b[7m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ANSI_AT_START = /^\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/;
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MOUSE_WHEEL_LINES = 3;
const INPUT_HORIZONTAL_PADDING = 2;
const INPUT_VERTICAL_PADDING = 2;
const STATUS_ROWS = 1;
const MIN_MESSAGE_ROWS = 1;
const INSERT_NEWLINE_KEYS = new Set(["\x1b[13;2u", "\x1b[13;2~", "\x1b[27;2;13~"]);

/** Pitch black background used for the main canvas (assistant text, inline tools). */
const CANVAS_BG = 234;
/** Slightly gray background for tool panels that show content. */
const PANEL_BG = 235;

const themes: Record<BlockRole, BlockTheme> = {
  user: { fg: 231, bg: 24, accent: 117, bold: 230 },
  assistant: { fg: 255, bg: CANVAS_BG, accent: 221, bold: 215 },
  tool: { fg: 252, bg: PANEL_BG, accent: 117, bold: 230 },
  error: { fg: 231, bg: 88, accent: 217, bold: 223 },
};

/** Theme used for inline tool lines (single-line, no content) rendered on the canvas. */
const inlineToolTheme: BlockTheme = { fg: 245, bg: CANVAS_BG, accent: 117, bold: 230 };

const DONE_GLYPH = { glyph: "✓", color: 151 };
const ERROR_GLYPH = { glyph: "✗", color: 217 };
const TOOL_ARROW = "→";

export class Tui {
  private blocks: RenderBlock[] = [];
  private input = "";
  private inputCursor = 0;
  private inputScrollRow = 0;
  private nextBlockId = 1;
  private running = false;
  private status = "idle";
  private model = "";
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private renderQueued = false;
  private open = false;
  private scrollOffset = 0;
  private lastRenderedLineCount = 0;
  private screenLines: string[] = [];
  private screenColumns = 0;
  private selection: SelectionRange | undefined;
  private selecting = false;
  private selectionMoved = false;
  private blockLineMap: number[] = [];
  private lastMessageStart = 0;
  private lastMessageRows = 0;
  private emptyPrefixLines = 0;
  private contextInfo: ContextInfo | undefined;
  private cost = 0;
  private cwd = "";

  constructor(private readonly options: { onSubmit?: SubmitHandler; onTab?: () => void; onEscape?: () => void; model?: string; cwd?: string } = {}) {
    this.model = options.model ?? "";
    this.cwd = options.cwd ?? "";
  }

  start() {
    if (this.open) {
      return;
    }

    this.open = true;
    process.stdin.setEncoding("utf8");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on("data", this.handleData);
    process.stdout.on("resize", this.handleResize);
    process.once("exit", this.handleExit);
    process.stdout.write(`${CLEAR_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE}`);
    this.render();
  }

  stop() {
    if (!this.open) {
      return;
    }

    this.open = false;
    this.stopSpinner();
    process.stdin.off("data", this.handleData);
    process.stdout.off("resize", this.handleResize);
    process.off("exit", this.handleExit);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write(`${RESET}${DISABLE_MOUSE}${SHOW_CURSOR}\n`);
  }

  addBlock(block: Omit<RenderBlock, "id">) {
    const id = this.nextBlockId++;
    this.blocks.push({
      id,
      ...block,
      collapsed: block.collapsed ?? (block.role === "tool" ? true : undefined),
    });
    this.requestRender();
    return id;
  }

  updateBlock(id: number, patch: string | BlockPatch) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }

    if (typeof patch === "string") {
      block.content = patch;
    } else {
      if (patch.title !== undefined) block.title = patch.title;
      if (patch.content !== undefined) block.content = patch.content;
      if (patch.state !== undefined) block.state = patch.state;
    }
    this.requestRender();
  }

  clearBlocks() {
    this.blocks = [];
    this.scrollOffset = 0;
    this.lastRenderedLineCount = 0;
    this.selection = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    this.requestRender();
  }

  appendToBlock(id: number, text: string) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }

    block.content += text;
    this.requestRender();
  }

  setStatus(status: string) {
    this.status = status;
    this.requestRender();
  }

  setRunning(running: boolean, status?: string) {
    this.running = running;
    if (status) {
      this.status = status;
    }

    if (running) {
      this.startSpinner();
    } else {
      this.stopSpinner();
      this.spinnerFrame = 0;
    }

    this.requestRender();
  }

  setModel(model: string) {
    this.model = model;
    this.requestRender();
  }

  setContextInfo(info: ContextInfo) {
    this.contextInfo = info;
    this.requestRender();
  }

  setCost(cost: number) {
    this.cost = cost;
    this.requestRender();
  }

  setCwd(cwd: string) {
    this.cwd = cwd;
    this.requestRender();
  }

  toggleBlockCollapse(id: number) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }
    if (block.role !== "tool") {
      return;
    }
    block.collapsed = !block.collapsed;
    this.requestRender();
  }

  private handleBlockClick(position: ScreenPosition | undefined) {
    if (!position) {
      return;
    }
    if (position.row > this.lastMessageRows) {
      return;
    }
    // Subtract the empty prefix lines that were prepended to fill the
    // screen when there are fewer rendered block lines than message rows.
    const renderedIndex = this.lastMessageStart + (position.row - 1) - this.emptyPrefixLines;
    if (renderedIndex < 0 || renderedIndex >= this.blockLineMap.length) {
      return;
    }
    const blockId = this.blockLineMap[renderedIndex];
    if (blockId) {
      this.toggleBlockCollapse(blockId);
    }
  }

  private clearSelection() {
    if (!this.selection && !this.selecting && !this.selectionMoved) {
      return;
    }

    this.selection = undefined;
    this.selecting = false;
    this.selectionMoved = false;
    this.requestRender();
  }

  private startSpinner() {
    if (this.spinnerTimer) {
      return;
    }

    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, 50);
  }

  private stopSpinner() {
    if (!this.spinnerTimer) {
      return;
    }

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private handleResize = () => {
    this.requestRender();
  };

  private handleExit = () => {
    process.stdout.write(`${RESET}${DISABLE_MOUSE}${SHOW_CURSOR}`);
  };

  private handleData = (data: string) => {
    if (data === "\u0003") {
      if (this.input) {
        this.input = "";
        this.inputCursor = 0;
        this.inputScrollRow = 0;
        this.requestRender();
        return;
      }
      this.stop();
      process.exit(0);
    }

    if (this.handleEscape(data)) {
      return;
    }

    this.clearSelection();

    // Detect paste: if the data contains more than a single \r or \n,
    // treat carriage returns and newlines as newline insertions rather
    // than submit triggers.  A real Enter keypress arrives as a lone "\r".
    const isPaste = data.length > 1 && data !== "\r\n";

    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === "\r") {
        if (isPaste) {
          this.insertInputNewline();
          // Skip a \n that immediately follows \r (i.e. \r\n pair)
          if (chars[i + 1] === "\n") {
            i += 1;
          }
        } else {
          this.submitInput();
        }
        continue;
      }

      if (char === "\n") {
        this.insertInputNewline();
        continue;
      }

      if (char === "\u007f") {
        this.deleteBackward();
        continue;
      }

      if (char === "\b") {
        this.deleteWord();
        continue;
      }

      if (char === "\t") {
        this.options.onTab?.();
        continue;
      }

      if (char === "\u0015") {
        if (this.input) {
          this.clearInputBeforeCursor();
        } else {
          this.scrollPageUp();
        }
        continue;
      }

      if (char === "\u0004") {
        if (!this.input) {
          this.scrollPageDown();
        }
        continue;
      }

      if (char >= " " && char !== "\u007f") {
        this.insertCharAtCursor(char);
      }
    }
  };

  private handleEscape(data: string) {
    // Bare ESC key (single \x1b byte) — cancel running prompt
    if (data === "\x1b") {
      if (this.running) {
        this.options.onEscape?.();
      }
      return true;
    }

    if (INSERT_NEWLINE_KEYS.has(data)) {
      this.clearSelection();
      this.insertInputNewline();
      return true;
    }

    if (this.handleMouse(data)) {
      return true;
    }

    switch (data) {
      // Arrow keys — cursor movement in the input field
      case "\x1b[A":
        this.clearSelection();
        this.moveCursorUp();
        return true;
      case "\x1b[B":
        this.clearSelection();
        this.moveCursorDown();
        return true;
      case "\x1b[C":
        this.clearSelection();
        this.moveCursorRight();
        return true;
      case "\x1b[D":
        this.clearSelection();
        this.moveCursorLeft();
        return true;

      // Alt+Up / Alt+Down — scroll the message area
      case "\x1b[1;3A":
        this.scrollBy(1);
        return true;
      case "\x1b[1;3B":
        this.scrollBy(-1);
        return true;

      // Alt+Left / Alt+Right / Ctrl+Left / Ctrl+Right — word movement
      case "\x1b[1;3D":
      case "\x1b[1;5D":
      case "\x1bb":
        this.clearSelection();
        this.moveCursorWordLeft();
        return true;
      case "\x1b[1;3C":
      case "\x1b[1;5C":
      case "\x1bf":
        this.clearSelection();
        this.moveCursorWordRight();
        return true;

      // Page Up / Page Down
      case "\x1b[5~":
        this.scrollPageUp();
        return true;
      case "\x1b[6~":
        this.scrollPageDown();
        return true;

      // Home / End — move cursor to start/end of current visual line
      case "\x1b[H":
      case "\x1b[1~":
      case "\x1bOH":
        this.clearSelection();
        this.moveCursorHome();
        return true;
      case "\x1b[F":
      case "\x1b[4~":
      case "\x1bOF":
        this.clearSelection();
        this.moveCursorEnd();
        return true;

      // Ctrl+Home / Ctrl+End — scroll to top/bottom of messages
      case "\x1b[1;5H":
        this.scrollToTop();
        return true;
      case "\x1b[1;5F":
        this.scrollToBottom();
        return true;

      // Delete key — delete character after cursor
      case "\x1b[3~":
        this.clearSelection();
        this.deleteForward();
        return true;

      // Alt+Backspace — delete word
      case "\x1b\u007f":
      case "\x1b\b":
        this.deleteWord();
        return true;
      default:
        return data.startsWith("\x1b");
    }
  }

  private insertInputNewline() {
    this.insertCharAtCursor("\n");
  }

  private insertCharAtCursor(char: string) {
    // Convert tabs to spaces for display (tabs should not appear in input)
    const charToInsert = char === "\t" ? "  " : char;
    const chars = Array.from(this.input);
    const insertChars = Array.from(charToInsert);
    chars.splice(this.inputCursor, 0, ...insertChars);
    this.input = chars.join("");
    this.inputCursor += insertChars.length;
    this.requestRender();
  }

  private deleteBackward() {
    if (this.inputCursor <= 0) {
      return;
    }

    const chars = Array.from(this.input);
    chars.splice(this.inputCursor - 1, 1);
    this.input = chars.join("");
    this.inputCursor -= 1;
    this.requestRender();
  }

  private deleteForward() {
    const chars = Array.from(this.input);
    if (this.inputCursor >= chars.length) {
      return;
    }

    chars.splice(this.inputCursor, 1);
    this.input = chars.join("");
    this.requestRender();
  }

  private clearInputBeforeCursor() {
    const chars = Array.from(this.input);
    this.input = chars.slice(this.inputCursor).join("");
    this.inputCursor = 0;
    this.requestRender();
  }

  private deleteWord() {
    if (this.inputCursor <= 0) {
      return;
    }

    const chars = Array.from(this.input);
    let index = this.inputCursor - 1;

    // If char before cursor is a special character (not alphanumeric, not space), remove just it
    const lastChar = chars[index];
    if (lastChar && !/^[\p{L}\p{Nd}]$/u.test(lastChar) && lastChar !== " ") {
      chars.splice(index, 1);
      this.input = chars.join("");
      this.inputCursor -= 1;
      this.requestRender();
      return;
    }

    // If char before cursor is a space, remove trailing spaces then the preceding word
    if (lastChar === " ") {
      while (index >= 0 && chars[index] === " ") {
        index -= 1;
      }
    }

    // Remove consecutive alphanumeric characters
    while (index >= 0 && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index -= 1;
    }

    const deleteFrom = index + 1;
    const deleteCount = this.inputCursor - deleteFrom;
    chars.splice(deleteFrom, deleteCount);
    this.input = chars.join("");
    this.inputCursor = deleteFrom;
    this.requestRender();
  }

  private moveCursorLeft() {
    if (this.inputCursor > 0) {
      this.inputCursor -= 1;
      this.requestRender();
    }
  }

  private moveCursorRight() {
    const length = Array.from(this.input).length;
    if (this.inputCursor < length) {
      this.inputCursor += 1;
      this.requestRender();
    }
  }

  private moveCursorWordLeft() {
    if (this.inputCursor <= 0) {
      return;
    }

    const chars = Array.from(this.input);
    let index = this.inputCursor - 1;

    // Skip spaces
    while (index >= 0 && (chars[index] === " " || chars[index] === "\t")) {
      index -= 1;
    }

    // Skip word characters
    while (index >= 0 && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index -= 1;
    }

    // If we only skipped spaces and hit a non-word char, move past it
    if (index === this.inputCursor - 1) {
      index -= 1;
    }

    this.inputCursor = Math.max(0, index + 1);
    this.requestRender();
  }

  private moveCursorWordRight() {
    const chars = Array.from(this.input);
    if (this.inputCursor >= chars.length) {
      return;
    }

    let index = this.inputCursor;

    // Skip word characters
    while (index < chars.length && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index += 1;
    }

    // Skip spaces
    while (index < chars.length && (chars[index] === " " || chars[index] === "\t")) {
      index += 1;
    }

    // If we didn't move (started on a non-word, non-space char), skip it
    if (index === this.inputCursor) {
      index += 1;
    }

    this.inputCursor = Math.min(chars.length, index);
    this.requestRender();
  }

  private moveCursorUp() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    if (layout.cursorLine <= 0) {
      // Already on the first visual line — move to start
      this.inputCursor = 0;
      this.requestRender();
      return;
    }

    // Move to same visual column on the previous line
    const targetLine = layout.cursorLine - 1;
    const targetCol = layout.cursorCol;
    this.inputCursor = layout.charOffsetAt(targetLine, targetCol);
    this.requestRender();
  }

  private moveCursorDown() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    if (layout.cursorLine >= layout.lines.length - 1) {
      // Already on the last visual line — move to end
      this.inputCursor = Array.from(this.input).length;
      this.requestRender();
      return;
    }

    // Move to same visual column on the next line
    const targetLine = layout.cursorLine + 1;
    const targetCol = layout.cursorCol;
    this.inputCursor = layout.charOffsetAt(targetLine, targetCol);
    this.requestRender();
  }

  private moveCursorHome() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    this.inputCursor = layout.charOffsetAt(layout.cursorLine, 0);
    this.requestRender();
  }

  private moveCursorEnd() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(this.input);
    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);

    const lineText = layout.lines[layout.cursorLine] ?? "";
    const lineWidth = displayWidth(lineText);
    this.inputCursor = layout.charOffsetAt(layout.cursorLine, lineWidth);
    this.requestRender();
  }

  private handleMouse(data: string) {
    let handled = false;

    for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
      handled = this.handleMouseEvent(Number(match[1]), Number(match[2]), Number(match[3]), match[4]) || handled;
    }

    let index = 0;
    while (index < data.length) {
      const start = data.indexOf("\x1b[M", index);
      if (start === -1) {
        break;
      }

      if (start + 6 > data.length) {
        break;
      }

      handled = this.handleMouseEvent(
        data.charCodeAt(start + 3) - 32,
        data.charCodeAt(start + 4) - 32,
        data.charCodeAt(start + 5) - 32,
        "M",
      ) || handled;
      index = start + 6;
    }

    return handled;
  }

  private handleMouseEvent(buttonCode: number, col: number, row: number, action: string) {
    if (action === "M" && (buttonCode & 64) !== 0) {
      const wheelButton = buttonCode & 3;
      if (wheelButton === 0) {
        this.scrollBy(MOUSE_WHEEL_LINES);
        return true;
      }

      if (wheelButton === 1) {
        this.scrollBy(-MOUSE_WHEEL_LINES);
        return true;
      }

      return false;
    }

    const position = this.mousePosition(col, row);
    const button = buttonCode & 3;
    const isRelease = action === "m" || button === 3;
    if (isRelease) {
      if (!this.selecting) {
        return false;
      }

      this.updateSelection(position);
      this.finishSelection();
      return true;
    }

    if (button !== 0) {
      return false;
    }

    const isMotion = (buttonCode & 32) !== 0;
    if (isMotion) {
      if (!this.selecting) {
        return false;
      }

      this.updateSelection(position);
      return true;
    }

    this.startSelection(position);
    return true;
  }

  private mousePosition(col: number, row: number): ScreenPosition {
    const columns = this.screenColumns || process.stdout.columns || 80;
    const rows = this.screenLines.length || process.stdout.rows || 24;
    return {
      row: Math.max(1, Math.min(rows, Math.trunc(row))),
      col: Math.max(1, Math.min(columns, Math.trunc(col))),
    };
  }

  private startSelection(position: ScreenPosition) {
    this.selection = { anchor: position, focus: position };
    this.selecting = true;
    this.selectionMoved = false;
    this.requestRender();
  }

  private updateSelection(position: ScreenPosition) {
    if (!this.selection) {
      return;
    }

    this.selectionMoved = this.selectionMoved || !samePosition(this.selection.anchor, position);
    this.selection.focus = position;
    this.requestRender();
  }

  private finishSelection() {
    this.selecting = false;
    if (!this.selectionMoved) {
      this.handleBlockClick(this.selection?.anchor);
      this.clearSelection();
      return;
    }

    const text = cleanCopiedText(this.selectedText());
    if (!text) {
      this.clearSelection();
      return;
    }

    copyToClipboard(text);
    const lineCount = text.split("\n").length;
    this.status = lineCount === 1 ? `copied ${visibleLength(text)} chars` : `copied ${lineCount} lines`;
    this.clearSelection();
  }

  private selectedText() {
    if (!this.selection) {
      return "";
    }

    const { start, end } = normalizeSelection(this.selection);
    const columns = this.screenColumns || process.stdout.columns || 80;
    const lines: string[] = [];
    for (let row = start.row; row <= end.row; row += 1) {
      const bounds = selectionBoundsForRow(this.selection, row, columns);
      if (!bounds) {
        continue;
      }

      const line = this.screenLines[row - 1] ?? "";
      lines.push(sliceByCells(line, bounds.start, bounds.end).replace(/[ \t]+$/g, ""));
    }

    while (lines[0]?.trim() === "") {
      lines.shift();
    }

    while (lines[lines.length - 1]?.trim() === "") {
      lines.pop();
    }

    return lines.join("\n");
  }

  private scrollPageUp() {
    this.scrollBy(Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollPageDown() {
    this.scrollBy(-Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollBy(lines: number) {
    this.clearSelection();
    this.scrollOffset = Math.max(0, this.scrollOffset + Math.trunc(lines));
    this.requestRender();
  }

  private scrollToTop() {
    this.clearSelection();
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  private scrollToBottom() {
    this.clearSelection();
    this.scrollOffset = 0;
    this.requestRender();
  }

  private messageRows() {
    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    const statusRows = this.statusRows(rows);
    const input = this.renderInputLine(columns, this.maxInputRows(rows, statusRows));
    // Account for the margin lines above and below the input box
    const inputMarginRows = rows > statusRows + input.lines.length + 2 ? 2 : 0;
    return Math.max(0, rows - statusRows - input.lines.length - inputMarginRows);
  }

  private statusRows(rows: number) {
    return rows > 1 ? STATUS_ROWS : 0;
  }

  private maxInputRows(rows: number, statusRows: number) {
    return Math.max(1, rows - statusRows - MIN_MESSAGE_ROWS);
  }

  private submitInput() {
    const submitted = this.input.trimEnd();
    if (!submitted.trim()) {
      this.input = "";
      this.inputCursor = 0;
      this.inputScrollRow = 0;
      this.requestRender();
      return;
    }

    if (this.running) {
      this.status = "agent is still running";
      this.requestRender();
      return;
    }

    this.input = "";
    this.inputCursor = 0;
    this.inputScrollRow = 0;
    this.scrollOffset = 0;
    this.clearSelection();
    this.requestRender();

    Promise.resolve(this.options.onSubmit?.(submitted)).catch((error: unknown) => {
      this.addBlock({
        role: "error",
        title: "Error",
        content: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      this.setRunning(false, "idle");
    });
  }

  private requestRender() {
    if (!this.open || this.renderQueued) {
      return;
    }

    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render() {
    if (!this.open) {
      return;
    }

    const columns = Math.max(process.stdout.columns ?? 80, 1);
    const rows = Math.max(process.stdout.rows ?? 24, 1);
    const statusRows = this.statusRows(rows);
    const input = this.renderInputLine(columns, this.maxInputRows(rows, statusRows));
    // Account for margin lines above and below the input box
    const inputMarginRows = rows > statusRows + input.lines.length + 2 ? 2 : 0;
    const messageRows = Math.max(0, rows - statusRows - input.lines.length - inputMarginRows);
    const renderedBlocks: string[] = [];
    const blockLineMap: number[] = [];
    const spinnerFrame = SPINNER_FRAMES[this.spinnerFrame];

    // Classify each block's visual type for margin logic
    type VisualType = "user" | "assistant" | "inline-tool" | "panel" | "error";
    const visualType = (b: RenderBlock): VisualType => {
      if (b.role === "user") return "user";
      if (b.role === "assistant") return "assistant";
      if (b.role === "error") return "error";
      // tool
      return isInlineTool(b) ? "inline-tool" : "panel";
    };

    let prevType: VisualType | undefined;
    for (let blockIdx = 0; blockIdx < this.blocks.length; blockIdx++) {
      const block = this.blocks[blockIdx];
      const curType = visualType(block);
      const blockLines = renderBlock(block, columns, spinnerFrame);

      // Skip empty blocks (e.g. assistant still streaming with no content yet)
      if (blockLines.length === 0) {
        continue;
      }

      // ── Margin logic ──
      // User blocks: always get a margin line before (unless first) and after.
      // Assistant / panel / error blocks: get a margin line before, unless
      //   the previous block was a user block (which already added a trailing margin)
      //   or this is the first block.
      // Inline tools: get a margin line before the *first* in a consecutive
      //   group, but no separator between adjacent inline tools.
      if (prevType !== undefined) {
        if (curType === "user") {
          // Skip margin if previous block has its own internal padding
          if (prevType !== "panel" && prevType !== "error") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        } else if (curType === "inline-tool") {
          // Only add margin before the first inline tool in a group
          if (prevType !== "inline-tool" && prevType !== "user") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        } else {
          // assistant, panel, error — margin before, unless prev was user
          if (prevType !== "user") {
            renderedBlocks.push(blackLine(columns));
            blockLineMap.push(0);
          }
        }
      }

      renderedBlocks.push(...blockLines);
      for (let i = 0; i < blockLines.length; i++) {
        blockLineMap.push(block.id);
      }

      // Trailing margin after user blocks — skip if last block (input margin
      // suffices) or if the next block has its own internal padding.
      if (curType === "user" && blockIdx < this.blocks.length - 1) {
        const nextType = visualType(this.blocks[blockIdx + 1]);
        if (nextType !== "panel" && nextType !== "error") {
          renderedBlocks.push(blackLine(columns));
          blockLineMap.push(0);
        }
      }

      prevType = curType;
    }

    // Ensure there's a margin line at the very top of the scroll area
    if (renderedBlocks.length > 0) {
      renderedBlocks.unshift(blackLine(columns));
      blockLineMap.unshift(0);
    }

    const lineDelta = renderedBlocks.length - this.lastRenderedLineCount;
    if (this.scrollOffset > 0 && this.lastRenderedLineCount > 0 && lineDelta !== 0) {
      this.scrollOffset += lineDelta;
    }

    this.lastRenderedLineCount = renderedBlocks.length;

    const maxScroll = Math.max(0, renderedBlocks.length - messageRows);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);

    const start = Math.max(0, renderedBlocks.length - messageRows - this.scrollOffset);
    const visibleMessages = renderedBlocks.slice(start, start + messageRows);

    // When there are fewer rendered block lines than message rows, empty
    // lines are prepended to fill the screen. Track how many so click
    // handling can offset correctly.
    let emptyPrefixLines = 0;
    while (visibleMessages.length < messageRows) {
      visibleMessages.unshift(plainLine("", columns));
      emptyPrefixLines += 1;
    }

    const messageLines = visibleMessages.map((line) => padAnsi(line, columns));
    const statusLine = this.renderStatusLine(columns, maxScroll);

    // Add margin lines above and below the input box if there's room
    const inputMarginLine = blackLine(columns);
    const inputSection = inputMarginRows > 0
      ? [inputMarginLine, ...input.lines, inputMarginLine]
      : input.lines;
    const inputCursorRowOffset = inputMarginRows > 0 ? 1 : 0;

    const lines = statusRows > 0
      ? [...messageLines, ...inputSection, statusLine]
      : [...messageLines, ...inputSection];
    this.screenColumns = columns;
    this.screenLines = lines.slice(0, rows).map((line) => stripAnsi(clipAnsi(line, columns)));
    this.blockLineMap = blockLineMap;
    this.lastMessageStart = start;
    this.lastMessageRows = messageRows;
    this.emptyPrefixLines = emptyPrefixLines;

    const output = [`${HIDE_CURSOR}`];
    for (let row = 0; row < rows; row += 1) {
      output.push(`\x1b[${row + 1};1H\x1b[2K${clipAnsi(this.renderSelectedLine(lines[row] ?? "", row + 1, columns), columns)}`);
    }
    output.push(`\x1b[${Math.min(rows, messageRows + inputCursorRowOffset + input.cursorRow)};${input.cursorCol}H${SHOW_CURSOR}`);

    process.stdout.write(output.join(""));
  }

  private renderSelectedLine(line: string, row: number, columns: number) {
    if (!this.selection || !this.selectionMoved) {
      return line;
    }

    const bounds = selectionBoundsForRow(this.selection, row, columns);
    if (!bounds) {
      return line;
    }

    return highlightAnsiRange(line, bounds.start, bounds.end);
  }

  private renderStatusLine(columns: number, maxScroll: number) {
    const spinner = this.running ? `${SPINNER_FRAMES[this.spinnerFrame]} ` : "";
    const statusText = !this.running && (!this.status || this.status === "idle") ? "" : this.status || "idle";
    const scrollText = this.scrollOffset > 0 ? `${statusText ? " | " : ""}scroll ${this.scrollOffset}/${maxScroll} | End latest` : "";
    const leftText = `${spinner}${statusText}${scrollText}`;
    const costText = this.cost > 0 ? `  ${formatCost(this.cost)}  ` : "";
    const contextText = this.contextInfo ? `  ${formatContextInfo(this.contextInfo)}  ` : "";
    const modelText = this.model ? `  ${this.model}  ` : "";
    const cwdText = this.cwd ? `  ${this.cwd}  ` : "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const rightWidth = visibleLength(cwdText) + visibleLength(costText) + visibleLength(contextText) + visibleLength(modelText);
    const leftWidth = Math.max(1, columns - horizontalPadding * 2 - rightWidth);
    const leftVisible = takeRight(leftText, leftWidth);
    const leftPadded = `${" ".repeat(horizontalPadding)}${leftVisible}`;
    const leftPaddedWidth = visibleLength(leftPadded);
    const gapWidth = Math.max(0, columns - leftPaddedWidth - rightWidth);
    const fgColor = this.running ? 229 : 250;
    const contextFgColor = this.contextInfo && this.contextInfo.usedTokens / this.contextInfo.contextWindow >= 0.8 ? 217 : 245;
    return (
      `${bg(235)}${fg(fgColor)}${leftPadded}${" ".repeat(gapWidth)}` +
      `${bg(235)}${fg(246)}${cwdText}` +
      `${bg(235)}${fg(187)}${costText}` +
      `${bg(235)}${fg(contextFgColor)}${contextText}` +
      `${bg(235)}${fg(109)}${modelText}${RESET}`
    );
  }

  private renderInputLine(columns: number, maxRows: number) {
    const prompt = "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(`${prompt}${this.input}`);

    // Clamp cursor to valid range
    const inputLength = Array.from(this.input).length;
    if (this.inputCursor > inputLength) {
      this.inputCursor = inputLength;
    }
    if (this.inputCursor < 0) {
      this.inputCursor = 0;
    }

    const layout = wrapInputTextWithCursor(raw, textWidth, this.inputCursor);
    const wrapped = layout.lines;
    const hasPadding = maxRows >= INPUT_VERTICAL_PADDING + 1;
    const contentRows = Math.max(1, maxRows - (hasPadding ? INPUT_VERTICAL_PADDING : 0));

    // Ensure the cursor line is visible by adjusting inputScrollRow
    const cursorLine = layout.cursorLine;
    if (cursorLine < this.inputScrollRow) {
      this.inputScrollRow = cursorLine;
    }
    if (cursorLine >= this.inputScrollRow + contentRows) {
      this.inputScrollRow = cursorLine - contentRows + 1;
    }
    // Clamp scroll to valid range
    const maxInputScroll = Math.max(0, wrapped.length - contentRows);
    this.inputScrollRow = Math.min(Math.max(0, this.inputScrollRow), maxInputScroll);

    const visibleRows = wrapped.slice(this.inputScrollRow, this.inputScrollRow + contentRows);
    const cursorRowInView = cursorLine - this.inputScrollRow;
    const cursorCol = Math.max(1, Math.min(columns, horizontalPadding + layout.cursorCol + 1));
    const isBashCommand = this.input.startsWith("!");
    const inputBg = isBashCommand ? 237 : 236;
    const inputFg = isBashCommand ? 179 : 252;
    const renderedContent = visibleRows.map((line) => renderBar(`${" ".repeat(horizontalPadding)}${line}`, columns, inputBg, inputFg));

    return {
      lines: hasPadding
        ? [renderBar("", columns, inputBg, inputFg), ...renderedContent, renderBar("", columns, inputBg, inputFg)]
        : renderedContent,
      cursorRow: (hasPadding ? 1 : 0) + cursorRowInView + 1,
      cursorCol,
    };
  }
}

function copyToClipboard(text: string) {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}

function cleanCopiedText(text: string) {
  return text
    .split("\n")
    .map((line) => line.trimStart().replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function samePosition(a: ScreenPosition, b: ScreenPosition) {
  return a.row === b.row && a.col === b.col;
}

function comparePositions(a: ScreenPosition, b: ScreenPosition) {
  return a.row === b.row ? a.col - b.col : a.row - b.row;
}

function normalizeSelection(selection: SelectionRange) {
  const { anchor, focus } = selection;
  return comparePositions(anchor, focus) <= 0 ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

function selectionBoundsForRow(selection: SelectionRange, row: number, columns: number) {
  const maxColumn = Math.max(1, columns);
  const { start, end } = normalizeSelection(selection);
  if (row < start.row || row > end.row) {
    return undefined;
  }

  if (start.row === end.row) {
    const left = Math.max(0, Math.min(maxColumn, Math.min(start.col, end.col) - 1));
    const right = Math.max(left, Math.min(maxColumn, Math.max(start.col, end.col)));
    return right > left ? { start: left, end: right } : undefined;
  }

  if (row === start.row) {
    return { start: Math.max(0, Math.min(maxColumn, start.col - 1)), end: maxColumn };
  }

  if (row === end.row) {
    return { start: 0, end: Math.max(0, Math.min(maxColumn, end.col)) };
  }

  return { start: 0, end: maxColumn };
}

function sliceByCells(text: string, start: number, end: number) {
  let result = "";
  let cell = 0;

  for (const char of Array.from(text)) {
    const width = charWidth(char);
    const charStart = cell;
    const charEnd = cell + width;
    if (charEnd > start && charStart < end) {
      result += char;
    }

    cell = charEnd;
    if (cell >= end) {
      break;
    }
  }

  return result;
}

function highlightAnsiRange(line: string, start: number, end: number) {
  if (end <= start) {
    return line;
  }

  let result = "";
  let activeStyle = "";
  let selected = false;
  let cell = 0;
  let index = 0;

  while (index < line.length) {
    const ansi = ANSI_AT_START.exec(line.slice(index));
    if (ansi) {
      const sequence = ansi[0];
      result += sequence;
      activeStyle = updateActiveStyle(activeStyle, sequence);
      if (selected) {
        result += INVERSE;
      }

      index += sequence.length;
      continue;
    }

    const char = Array.from(line.slice(index))[0];
    const width = charWidth(char);
    const charStart = cell;
    const charEnd = cell + width;
    if (!selected && charEnd > start && charStart < end) {
      result += INVERSE;
      selected = true;
    }

    if (selected && charStart >= end) {
      result += `${RESET}${activeStyle}`;
      selected = false;
    }

    result += char;
    cell = charEnd;
    index += char.length;
  }

  if (selected) {
    result += `${RESET}${activeStyle}`;
  }

  return result;
}

function updateActiveStyle(activeStyle: string, sequence: string) {
  const sgr = /^\x1b\[([0-9;]*)m$/.exec(sequence);
  if (!sgr) {
    return activeStyle;
  }

  const params = sgr[1] ? sgr[1].split(";") : ["0"];
  if (params.includes("0")) {
    return "";
  }

  return activeStyle + sequence;
}

/**
 * Determines whether a tool block should render as a single inline line
 * (on the black canvas) or as a panel with gray background.
 *
 * Inline: no visible content body (collapsed with no content, or done with
 * showContent=false, etc.)
 * Panel: has content to display.
 */
function isInlineTool(block: RenderBlock): boolean {
  if (block.role !== "tool") return false;
  const content = sanitizeContent(block.content).replace(/^\n+/, "").replace(/\n+$/, "");
  return !content;
}

function renderBlock(block: RenderBlock, columns: number, spinnerFrame: string) {
  // ── User blocks: rendered as a boxed card (existing style) ──
  if (block.role === "user") {
    return renderUserBlock(block, columns);
  }

  // ── Assistant blocks: inline text on black canvas ──
  if (block.role === "assistant") {
    return renderAssistantBlock(block, columns);
  }

  // ── Tool blocks ──
  if (block.role === "tool") {
    if (isInlineTool(block)) {
      return renderInlineToolBlock(block, columns, spinnerFrame);
    }
    return renderPanelToolBlock(block, columns, spinnerFrame);
  }

  // ── Error blocks: rendered as a panel with error theme ──
  return renderErrorBlock(block, columns);
}

/** Render a user message as a boxed card with padding (keeps existing look). */
function renderUserBlock(block: RenderBlock, columns: number) {
  const theme = themes.user;
  const sanitizedContent = sanitizeContent(block.content);
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.replace(/^\n+/, "").replace(/\n+$/, "");
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], innerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    for (const line of content.split("\n")) {
      rows.push(...wrapSegments(parseMarkdownLine(line), innerWidth));
    }
  }

  rows.push([]); // bottom padding

  return rows.map((row) => renderBlockRow(row, theme, columns));
}

/** Render assistant text inline on the black canvas — no box, no padding rows. */
function renderAssistantBlock(block: RenderBlock, columns: number) {
  const theme = themes.assistant;
  const sanitizedContent = sanitizeContent(block.content);
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.replace(/^\n+/, "").replace(/\n+$/, "");
  const result: string[] = [];

  if (block.title && content) {
    // If there's both a title and content, show title as a heading then content
    const titleRows = wrapSegments([{ text: block.title, style: "title" }], innerWidth);
    for (const row of titleRows) {
      result.push(renderBlockRow(row, theme, columns));
    }
    // blank line between title and content
    result.push(renderBlockRow([], theme, columns));
    for (const line of content.split("\n")) {
      const wrapped = wrapSegments(parseMarkdownLine(line), innerWidth);
      for (const row of wrapped) {
        result.push(renderBlockRow(row, theme, columns));
      }
    }
  } else if (block.title) {
    const titleRows = wrapSegments([{ text: block.title, style: "title" }], innerWidth);
    for (const row of titleRows) {
      result.push(renderBlockRow(row, theme, columns));
    }
  } else if (content) {
    for (const line of content.split("\n")) {
      const wrapped = wrapSegments(parseMarkdownLine(line), innerWidth);
      for (const row of wrapped) {
        result.push(renderBlockRow(row, theme, columns));
      }
    }
  }

  return result;
}

/** Render a tool block as a single inline line: `→ title  ✓` */
function renderInlineToolBlock(block: RenderBlock, columns: number, spinnerFrame: string) {
  const theme = inlineToolTheme;
  const title = block.title ?? block.role;
  const indicator = renderInlineStateIndicator(block.state, spinnerFrame);
  const indicatorWidth = indicator ? visibleLength(indicator.text) + 1 : 0;
  const arrowWidth = displayWidth(TOOL_ARROW) + 1; // arrow + space
  const titleWidth = Math.max(1, columns - 4 - arrowWidth - indicatorWidth);
  // Truncate title to fit
  const truncatedTitle = truncateToWidth(title, titleWidth);
  const titleVisible = displayWidth(truncatedTitle);
  const totalContentWidth = arrowWidth + titleVisible + (indicator ? 1 + visibleLength(indicator.text) : 0);
  const rightPad = Math.max(0, columns - 2 - totalContentWidth);

  const arrowRendered = `${RESET}${bg(theme.bg)}${fg(245)}${TOOL_ARROW} `;
  const titleRendered = `${RESET}${bg(theme.bg)}${fg(theme.accent)}${truncatedTitle}`;
  const indicatorRendered = indicator ? ` ${indicator.rendered}` : "";
  const padRendered = `${RESET}${bg(theme.bg)}${" ".repeat(rightPad)}${RESET}`;

  return [`${bg(theme.bg)}  ${arrowRendered}${titleRendered}${indicatorRendered}${padRendered}`];
}

/** Render a tool block as a gray panel (has content to show). */
function renderPanelToolBlock(block: RenderBlock, columns: number, spinnerFrame: string) {
  const theme = themes.tool;
  const sanitizedContent = sanitizeContent(block.content);
  const content = sanitizedContent.replace(/^\n+/, "").replace(/\n+$/, "");
  const indicator = renderStateIndicator(block.state, content, spinnerFrame, theme);
  const indicatorWidth = indicator ? visibleLength(indicator.text) : 0;
  const titleInnerWidth = Math.max(1, columns - 4 - (indicatorWidth > 0 ? indicatorWidth + 1 : 0));
  const innerWidth = Math.max(1, columns - 4);
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], titleInnerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    for (const line of content.split("\n")) {
      rows.push(...wrapSegments(parseMarkdownLine(line), innerWidth));
    }
  }

  rows.push([]); // bottom padding

  const isCollapsed = block.collapsed === true;
  const maxRows = 15;

  let result = rows.map((row, index) => {
    if (index === 1 && indicator && block.title) {
      return renderBlockRowWithGutter(row, indicator, theme, columns);
    }
    return renderBlockRow(row, theme, columns);
  });

  if (isCollapsed && result.length > maxRows) {
    result = result.slice(0, maxRows - 3);
    result.push(renderBlockRow([], theme, columns));
    result.push(renderBlockRow([{ text: "Click to expand", style: "italic" }], theme, columns));
    result.push(renderBlockRow([], theme, columns));
  }

  return result;
}

/** Render an error block as a panel with the error theme. */
function renderErrorBlock(block: RenderBlock, columns: number) {
  const theme = themes.error;
  const sanitizedContent = sanitizeContent(block.content);
  const innerWidth = Math.max(1, columns - 4);
  const content = sanitizedContent.replace(/^\n+/, "").replace(/\n+$/, "");
  const rows: StyledSegment[][] = [[]]; // top padding

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], innerWidth));
    if (content) rows.push([]);
  }

  if (content) {
    for (const line of content.split("\n")) {
      rows.push(...wrapSegments(parseMarkdownLine(line), innerWidth));
    }
  }

  rows.push([]); // bottom padding

  return rows.map((row) => renderBlockRow(row, theme, columns));
}

/** Truncate text to fit within a given display width. */
function truncateToWidth(text: string, maxWidth: number): string {
  const chars = Array.from(text);
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = charWidth(chars[i]);
    if (width + w > maxWidth) {
      return chars.slice(0, i).join("") + "…";
    }
    width += w;
  }
  return text;
}

function renderStateIndicator(
  state: BlockState | undefined,
  content: string,
  spinnerFrame: string,
  theme: BlockTheme,
): { text: string; rendered: string } | undefined {
  if (!state) {
    return undefined;
  }

  if (state === "running") {
    return {
      text: spinnerFrame,
      rendered: `${RESET}${bg(theme.bg)}${fg(229)}${spinnerFrame}`,
    };
  }

  if (state === "error") {
    return {
      text: ERROR_GLYPH.glyph,
      rendered: `${RESET}${bg(theme.bg)}${fg(ERROR_GLYPH.color)}${BOLD}${ERROR_GLYPH.glyph}`,
    };
  }

  // state === "done": show a checkmark only when there is no body to render
  if (!content) {
    return {
      text: DONE_GLYPH.glyph,
      rendered: `${RESET}${bg(theme.bg)}${fg(DONE_GLYPH.color)}${BOLD}${DONE_GLYPH.glyph}`,
    };
  }

  return undefined;
}

/** State indicator for inline tool lines (rendered on the black canvas). */
function renderInlineStateIndicator(
  state: BlockState | undefined,
  spinnerFrame: string,
): { text: string; rendered: string } | undefined {
  if (!state) {
    return undefined;
  }

  if (state === "running") {
    return {
      text: spinnerFrame,
      rendered: `${RESET}${bg(CANVAS_BG)}${fg(229)}${spinnerFrame}`,
    };
  }

  if (state === "error") {
    return {
      text: ERROR_GLYPH.glyph,
      rendered: `${RESET}${bg(CANVAS_BG)}${fg(ERROR_GLYPH.color)}${BOLD}${ERROR_GLYPH.glyph}`,
    };
  }

  // done
  return {
    text: DONE_GLYPH.glyph,
    rendered: `${RESET}${bg(CANVAS_BG)}${fg(DONE_GLYPH.color)}${DONE_GLYPH.glyph}`,
  };
}

function renderBlockRowWithGutter(
  segments: StyledSegment[],
  indicator: { text: string; rendered: string },
  theme: BlockTheme,
  columns: number,
) {
  const visible = segments.reduce((total, segment) => total + visibleLength(segment.text), 0);
  const indicatorWidth = visibleLength(indicator.text);
  const middlePadding = Math.max(1, columns - 2 - visible - indicatorWidth - 2);
  const base = `${bg(theme.bg)}${fg(theme.fg)}`;
  const content = segments.map((segment) => renderSegment(segment, theme)).join("");
  return `${base}  ${content}${RESET}${bg(theme.bg)}${fg(theme.fg)}${" ".repeat(middlePadding)}${indicator.rendered}${RESET}${bg(theme.bg)}  ${RESET}`;
}

function renderBlockRow(segments: StyledSegment[], theme: BlockTheme, columns: number) {
  const visible = segments.reduce((total, segment) => total + visibleLength(segment.text), 0);
  const rightPadding = Math.max(0, columns - 2 - visible);
  const base = `${bg(theme.bg)}${fg(theme.fg)}`;
  const content = segments.map((segment) => renderSegment(segment, theme)).join("");
  return `${base}  ${content}${RESET}${bg(theme.bg)}${fg(theme.fg)}${" ".repeat(rightPadding)}${RESET}`;
}

function renderSegment(segment: StyledSegment, theme: BlockTheme) {
  if (!segment.text) {
    return "";
  }

  switch (segment.style) {
    case "title":
      return `${RESET}${bg(theme.bg)}${fg(theme.accent)}${BOLD}${segment.text}`;
    case "heading":
      return `${RESET}${bg(theme.bg)}${fg(220)}${BOLD}${segment.text}`;
    case "bold":
      return `${RESET}${bg(theme.bg)}${fg(theme.bold)}${BOLD}${segment.text}`;
    case "italic":
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${ITALIC}${segment.text}`;
    case "code":
      return `${RESET}${bg(theme.bg)}${fg(118)}${segment.text}`;
    default:
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${segment.text}`;
  }
}

function parseMarkdownLine(line: string): StyledSegment[] {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    return [{ text: heading[2], style: "heading" }];
  }

  const segments: StyledSegment[] = [];
  let index = 0;
  let normal = "";

  const flushNormal = () => {
    if (normal) {
      segments.push({ text: normal, style: "normal" });
      normal = "";
    }
  };

  while (index < line.length) {
    if (line.startsWith("`", index)) {
      const end = line.indexOf("`", index + 1);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 1, end), style: "code" });
        index = end + 1;
        continue;
      }
    }

    if (line.startsWith("**", index)) {
      const end = line.indexOf("**", index + 2);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 2, end), style: "bold" });
        index = end + 2;
        continue;
      }
    }

    if (line.startsWith("*", index)) {
      const end = line.indexOf("*", index + 1);
      if (end !== -1) {
        flushNormal();
        segments.push({ text: line.slice(index + 1, end), style: "italic" });
        index = end + 1;
        continue;
      }
    }

    normal += line[index];
    index += 1;
  }

  flushNormal();
  return segments.length > 0 ? segments : [{ text: "", style: "normal" }];
}

type InputLayout = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  /** Given a visual (line, col) position, return the character offset into the input text. */
  charOffsetAt: (line: number, col: number) => number;
};

/**
 * Wraps input text for display and computes cursor position within the
 * wrapped layout. Also provides a reverse mapping from visual coordinates
 * back to character offsets, used for Up/Down/Home/End cursor movement.
 *
 * `cursorPos` is a character (grapheme) offset into `text`, ranging from
 * 0 to Array.from(text).length inclusive.
 */
function wrapInputTextWithCursor(text: string, width: number, cursorPos: number): InputLayout {
  const allChars = Array.from(text);
  const maxWidth = Math.max(1, width);

  // We process the text line-by-line (split on \n), wrapping each line.
  // For each character we track which visual row/col it maps to, and
  // build the reverse mapping at the same time.

  const lines: string[] = [];
  // For each visual line, store the char offset of its first character
  const lineStartOffsets: number[] = [];
  // For each visual line, store an array of { charOffset, cellStart } for
  // each character on that line, to enable reverse lookup.
  const lineCharMaps: { charOffset: number; cellStart: number; cellEnd: number }[][] = [];

  let cursorLine = 0;
  let cursorCol = 0;
  let globalCharIndex = 0; // index into allChars

  const rawLines = text.split("\n");
  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const rawLine = rawLines[lineIdx];
    const lineChars = Array.from(rawLine);
    const lineStartGlobal = globalCharIndex;

    // Wrap this single line, tracking character positions
    const wrappedRows = wrapInputLineWithOffsets(lineChars, maxWidth, lineStartGlobal);

    if (wrappedRows.length === 0) {
      // Empty line
      const row = lines.length;
      lines.push("");
      lineStartOffsets.push(lineStartGlobal);
      lineCharMaps.push([]);

      // Check if cursor is at this position (at the \n or end of text)
      if (cursorPos === globalCharIndex) {
        cursorLine = row;
        cursorCol = 0;
      }
    } else {
      for (const wrappedRow of wrappedRows) {
        const row = lines.length;
        lines.push(wrappedRow.text);
        lineStartOffsets.push(wrappedRow.startOffset);
        lineCharMaps.push(wrappedRow.charMap);

        // Check if cursor falls within this row
        for (const entry of wrappedRow.charMap) {
          if (entry.charOffset === cursorPos) {
            cursorLine = row;
            cursorCol = entry.cellStart;
          }
        }

        // Cursor might be at the end of this row (after the last char)
        const lastEntry = wrappedRow.charMap[wrappedRow.charMap.length - 1];
        if (lastEntry && lastEntry.charOffset + 1 === cursorPos) {
          // Only set if this is the last wrapped row for this raw line,
          // or if cursorPos points to a \n
          const isLastWrappedRow = wrappedRow === wrappedRows[wrappedRows.length - 1];
          if (isLastWrappedRow) {
            cursorLine = row;
            cursorCol = lastEntry.cellEnd;
          }
        }
      }
    }

    // Account for the \n between raw lines
    globalCharIndex = lineStartGlobal + lineChars.length;
    if (lineIdx < rawLines.length - 1) {
      // There's a \n separator
      if (cursorPos === globalCharIndex) {
        // Cursor is right on the \n — show at end of last wrapped row of this line
        const row = lines.length - 1;
        const map = lineCharMaps[row];
        const lastEntry = map?.[map.length - 1];
        cursorLine = row;
        cursorCol = lastEntry ? lastEntry.cellEnd : 0;
      }
      globalCharIndex += 1; // skip the \n
    }
  }

  // Handle cursor at very end of text
  if (cursorPos >= allChars.length && lines.length > 0) {
    const lastRow = lines.length - 1;
    const map = lineCharMaps[lastRow];
    const lastEntry = map?.[map.length - 1];
    cursorLine = lastRow;
    cursorCol = lastEntry ? lastEntry.cellEnd : 0;
  }

  const charOffsetAt = (line: number, col: number): number => {
    const clampedLine = Math.max(0, Math.min(lines.length - 1, line));
    const map = lineCharMaps[clampedLine];
    if (!map || map.length === 0) {
      return lineStartOffsets[clampedLine] ?? 0;
    }

    // Find the character whose cell range contains `col`, or the closest one
    let best = map[0].charOffset;
    for (const entry of map) {
      if (col >= entry.cellEnd) {
        best = entry.charOffset + 1;
      } else if (col >= entry.cellStart) {
        best = entry.charOffset;
        break;
      } else {
        break;
      }
    }

    return Math.min(best, allChars.length);
  };

  return { lines, cursorLine, cursorCol, charOffsetAt };
}

type WrappedRowInfo = {
  text: string;
  startOffset: number;
  charMap: { charOffset: number; cellStart: number; cellEnd: number }[];
};

/**
 * Wraps a single line's characters into visual rows, tracking the global
 * character offset for each character placed.
 */
function wrapInputLineWithOffsets(
  chars: string[],
  maxWidth: number,
  globalStart: number,
): WrappedRowInfo[] {
  const rows: WrappedRowInfo[] = [];
  let index = 0;

  if (chars.length === 0) {
    return [];
  }

  while (index < chars.length) {
    // Skip leading whitespace on continuation rows
    while (rows.length > 0 && isInputWrapWhitespace(chars[index])) {
      index += 1;
    }
    if (index >= chars.length) {
      break;
    }

    let end = index;
    let used = 0;
    let lastWhitespace = -1;

    while (end < chars.length) {
      const charCells = charWidth(chars[end]);
      if (used > 0 && used + charCells > maxWidth) {
        break;
      }

      used += charCells;
      if (isInputWrapWhitespace(chars[end])) {
        lastWhitespace = end;
      }
      end += 1;
    }

    if (end >= chars.length) {
      // Last row — take everything
      const rowChars = chars.slice(index, end);
      const charMap: WrappedRowInfo["charMap"] = [];
      let cell = 0;
      for (let i = 0; i < rowChars.length; i++) {
        const w = charWidth(rowChars[i]);
        charMap.push({ charOffset: globalStart + index + i, cellStart: cell, cellEnd: cell + w });
        cell += w;
      }
      rows.push({ text: rowChars.join(""), startOffset: globalStart + index, charMap });
      break;
    }

    let rowEnd = end;
    let next = end;
    if (lastWhitespace > index) {
      rowEnd = lastWhitespace;
      while (rowEnd > index && isInputWrapWhitespace(chars[rowEnd - 1])) {
        rowEnd -= 1;
      }
      next = lastWhitespace + 1;
    }

    if (rowEnd === index) {
      rowEnd = index + 1;
      next = rowEnd;
    }

    const rowChars = chars.slice(index, rowEnd);
    const charMap: WrappedRowInfo["charMap"] = [];
    let cell = 0;
    for (let i = 0; i < rowChars.length; i++) {
      const w = charWidth(rowChars[i]);
      charMap.push({ charOffset: globalStart + index + i, cellStart: cell, cellEnd: cell + w });
      cell += w;
    }
    rows.push({ text: rowChars.join(""), startOffset: globalStart + index, charMap });
    index = next;
  }

  return rows;
}

function isInputWrapWhitespace(char: string | undefined) {
  return char === " " || char === "\t";
}

function wrapSegments(segments: StyledSegment[], width: number) {
  const chars = segments.flatMap((segment) =>
    Array.from(segment.text).map((char) => ({ text: char, style: segment.style, width: charWidth(char) })),
  );

  if (chars.length === 0) {
    return [[]];
  }

  const rows: StyledSegment[][] = [];
  let index = 0;

  while (index < chars.length) {
    if (rows.length > 0) {
      while (chars[index]?.text === " ") {
        index += 1;
      }
      if (index >= chars.length) {
        break;
      }
    }

    let end = index;
    let used = 0;
    let lastSpace = -1;

    while (end < chars.length && used + chars[end].width <= width) {
      used += chars[end].width;
      if (chars[end].text === " ") {
        lastSpace = end;
      }
      end += 1;
    }

    let next = end;
    if (end < chars.length && lastSpace > index) {
      end = lastSpace;
      next = lastSpace + 1;
    } else if (end === index) {
      end = index + 1;
      next = end;
    }

    const rowChars = chars.slice(index, end);
    while (rowChars[rowChars.length - 1]?.text === " ") {
      rowChars.pop();
    }

    rows.push(coalesceSegments(rowChars));
    index = next;
  }

  return rows;
}

function coalesceSegments(chars: StyledSegment[]) {
  const segments: StyledSegment[] = [];
  for (const char of chars) {
    const previous = segments[segments.length - 1];
    if (previous?.style === char.style) {
      previous.text += char.text;
    } else {
      segments.push({ ...char });
    }
  }
  return segments;
}

function renderBar(text: string, columns: number, bgColor: number, fgColor: number) {
  const clean = sanitizeSingleLine(text);
  const clipped = takeRight(clean, columns);
  return `${bg(bgColor)}${fg(fgColor)}${clipped}${" ".repeat(Math.max(0, columns - visibleLength(clipped)))}${RESET}`;
}

function blackLine(columns: number) {
  return `${bg(CANVAS_BG)}${" ".repeat(columns)}${RESET}`;
}

function plainLine(text: string, columns: number) {
  const pad = Math.max(0, columns - visibleLength(text));
  return `${bg(CANVAS_BG)}${text}${" ".repeat(pad)}${RESET}`;
}

function padAnsi(text: string, columns: number) {
  const pad = Math.max(0, columns - visibleLength(text));
  if (pad <= 0) return text;
  return `${text}${bg(CANVAS_BG)}${" ".repeat(pad)}${RESET}`;
}

function sanitizeContent(text: string) {
  return String(text)
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function sanitizeSingleLine(text: string) {
  return sanitizeContent(text).replace(/\n/g, " ");
}

function takeRight(text: string, width: number) {
  let result = "";
  let used = 0;
  const chars = Array.from(text);

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const widthToAdd = charWidth(char);
    if (used + widthToAdd > width) {
      break;
    }

    result = char + result;
    used += widthToAdd;
  }

  return result;
}

function visibleLength(text: string) {
  return displayWidth(stripAnsi(text));
}

function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "");
}

function clipAnsi(text: string, width: number) {
  let result = "";
  let used = 0;
  let index = 0;

  while (index < text.length) {
    const ansi = ANSI_AT_START.exec(text.slice(index));
    if (ansi) {
      result += ansi[0];
      index += ansi[0].length;
      continue;
    }

    const char = Array.from(text.slice(index))[0];
    const widthToAdd = charWidth(char);
    if (used + widthToAdd > width) {
      break;
    }

    result += char;
    used += widthToAdd;
    index += char.length;
  }

  return `${result}${RESET}`;
}

function displayWidth(text: string) {
  return Array.from(text).reduce((width, char) => width + charWidth(char), 0);
}

function charWidth(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }

  if (isCombining(codePoint) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
    return 0;
  }

  return isWide(codePoint) ? 2 : 1;
}

function isCombining(codePoint: number) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff)
  );
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return value % 1 === 0 ? `${value}M` : `${value.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return value % 1 === 0 ? `${value}k` : `${value.toFixed(1)}k`;
  }
  return `${tokens}`;
}

function formatContextInfo(info: ContextInfo): string {
  const used = formatTokenCount(info.usedTokens);
  const total = formatTokenCount(info.contextWindow);
  const percent = info.contextWindow > 0
    ? Math.round((info.usedTokens / info.contextWindow) * 100)
    : 0;
  const base = `${used}/${total} (${percent}%)`;

  // Show cache status when there are cached tokens
  const cacheRead = info.cacheReadTokens ?? 0;
  const cacheCreation = info.cacheCreationTokens ?? 0;
  if (cacheRead > 0 || cacheCreation > 0) {
    const cachedTotal = cacheRead + cacheCreation;
    const cachePercent = info.usedTokens > 0
      ? Math.round((cacheRead / info.usedTokens) * 100)
      : 0;
    if (cacheRead > 0) {
      return `${base} cache ${formatTokenCount(cacheRead)}/${formatTokenCount(cachedTotal)} (${cachePercent}% hit)`;
    }
    return `${base} cache ${formatTokenCount(cachedTotal)} (new)`;
  }

  return base;
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    // Show sub-cent costs with more precision
    return `${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `${cost.toFixed(3)}`;
  }
  return `${cost.toFixed(2)}`;
}

function fg(code: number) {
  return `\x1b[38;5;${code}m`;
}

function bg(code: number) {
  return `\x1b[48;5;${code}m`;
}
