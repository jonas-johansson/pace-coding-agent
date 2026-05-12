type BlockRole = "user" | "assistant" | "tool_use" | "tool_result" | "error";

export type RenderBlock = {
  id: number;
  role: BlockRole;
  title?: string;
  content: string;
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

const themes: Record<BlockRole, BlockTheme> = {
  user: { fg: 231, bg: 24, accent: 117 },
  assistant: { fg: 255, bg: 236, accent: 221 },
  tool_use: { fg: 230, bg: 58, accent: 229 },
  tool_result: { fg: 254, bg: 238, accent: 151 },
  error: { fg: 231, bg: 88, accent: 217 },
};

export class Tui {
  private blocks: RenderBlock[] = [];
  private input = "";
  private nextBlockId = 1;
  private running = false;
  private status = "idle";
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

  constructor(private readonly options: { onSubmit?: SubmitHandler } = {}) {}

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
    this.blocks.push({ id, ...block });
    this.requestRender();
    return id;
  }

  updateBlock(id: number, content: string) {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      return;
    }

    block.content = content;
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
      this.stop();
      process.exit(0);
    }

    if (this.handleEscape(data)) {
      return;
    }

    this.clearSelection();

    for (const char of Array.from(data)) {
      if (char === "\r") {
        this.submitInput();
        continue;
      }

      if (char === "\n") {
        this.insertInputNewline();
        continue;
      }

      if (char === "\u007f") {
        this.input = Array.from(this.input).slice(0, -1).join("");
        this.requestRender();
        continue;
      }

      if (char === "\b") {
        this.deleteWord();
        continue;
      }

      if (char === "\u0015") {
        if (this.input) {
          this.input = "";
          this.requestRender();
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
        this.input += char;
        this.requestRender();
      }
    }
  };

  private handleEscape(data: string) {
    if (INSERT_NEWLINE_KEYS.has(data)) {
      this.clearSelection();
      this.insertInputNewline();
      return true;
    }

    if (this.handleMouse(data)) {
      return true;
    }

    switch (data) {
      case "\x1b[A":
        this.scrollBy(1);
        return true;
      case "\x1b[B":
        this.scrollBy(-1);
        return true;
      case "\x1b[5~":
        this.scrollPageUp();
        return true;
      case "\x1b[6~":
        this.scrollPageDown();
        return true;
      case "\x1b[H":
      case "\x1b[1~":
      case "\x1bOH":
        this.scrollToTop();
        return true;
      case "\x1b[F":
      case "\x1b[4~":
      case "\x1bOF":
        this.scrollToBottom();
        return true;
      case "\x1b\u007f":
      case "\x1b\b":
        this.deleteWord();
        return true;
      default:
        return data.startsWith("\x1b");
    }
  }

  private insertInputNewline() {
    this.input += "\n";
    this.requestRender();
  }

  private deleteWord() {
    if (!this.input) {
      return;
    }

    const chars = Array.from(this.input);
    let index = chars.length - 1;

    // If last char is a special character (not alphanumeric, not space), remove just it
    const lastChar = chars[index];
    if (lastChar && !/^[\p{L}\p{Nd}]$/u.test(lastChar) && lastChar !== " ") {
      this.input = chars.slice(0, index).join("");
      this.requestRender();
      return;
    }

    // If last char is a space, remove trailing spaces then the preceding word
    if (lastChar === " ") {
      while (index >= 0 && chars[index] === " ") {
        index -= 1;
      }
    }

    // Remove consecutive alphanumeric characters
    while (index >= 0 && /^[\p{L}\p{Nd}]$/u.test(chars[index])) {
      index -= 1;
    }

    this.input = chars.slice(0, index + 1).join("");
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
    return Math.max(0, rows - statusRows - input.lines.length);
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
      this.requestRender();
      return;
    }

    if (this.running) {
      this.status = "agent is still running";
      this.requestRender();
      return;
    }

    this.input = "";
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
    const messageRows = Math.max(0, rows - statusRows - input.lines.length);
    const renderedBlocks = this.blocks.flatMap((block) => [
      ...renderBlock(block, columns),
      "",
    ]);
    const lineDelta = renderedBlocks.length - this.lastRenderedLineCount;
    if (this.scrollOffset > 0 && this.lastRenderedLineCount > 0 && lineDelta !== 0) {
      this.scrollOffset += lineDelta;
    }

    this.lastRenderedLineCount = renderedBlocks.length;

    const maxScroll = Math.max(0, renderedBlocks.length - messageRows);
    this.scrollOffset = Math.min(Math.max(0, this.scrollOffset), maxScroll);

    const start = Math.max(0, renderedBlocks.length - messageRows - this.scrollOffset);
    const visibleMessages = renderedBlocks.slice(start, start + messageRows);

    while (visibleMessages.length < messageRows) {
      visibleMessages.unshift(plainLine("", columns));
    }

    const messageLines = visibleMessages.map((line) => padAnsi(line, columns));
    const statusLine = this.renderStatusLine(columns, maxScroll);

    const lines = statusRows > 0
      ? [...messageLines, ...input.lines, statusLine]
      : [...messageLines, ...input.lines];
    this.screenColumns = columns;
    this.screenLines = lines.slice(0, rows).map((line) => stripAnsi(clipAnsi(line, columns)));

    const output = [`${HIDE_CURSOR}`];
    for (let row = 0; row < rows; row += 1) {
      output.push(`\x1b[${row + 1};1H\x1b[2K${clipAnsi(this.renderSelectedLine(lines[row] ?? "", row + 1, columns), columns)}`);
    }
    output.push(`\x1b[${Math.min(rows, messageRows + input.cursorRow)};${input.cursorCol}H${SHOW_CURSOR}`);

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
    const text = `${spinner}${statusText}${scrollText}`;
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const visible = takeRight(text, textWidth);
    return renderBar(`${" ".repeat(horizontalPadding)}${visible}`, columns, 235, this.running ? 229 : 250);
  }

  private renderInputLine(columns: number, maxRows: number) {
    const prompt = "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = sanitizeContent(`${prompt}${this.input}`);
    const wrapped = wrapInputText(raw, textWidth);
    const hasPadding = maxRows >= INPUT_VERTICAL_PADDING + 1;
    const contentRows = Math.max(1, maxRows - (hasPadding ? INPUT_VERTICAL_PADDING : 0));
    const visibleRows = wrapped.slice(-contentRows);
    const cursorText = visibleRows[visibleRows.length - 1] ?? "";
    const cursorCol = Math.max(1, Math.min(columns, horizontalPadding + visibleLength(cursorText) + 1));
    const renderedContent = visibleRows.map((line) => renderBar(`${" ".repeat(horizontalPadding)}${line}`, columns, 236, 252));

    return {
      lines: hasPadding
        ? [renderBar("", columns, 236, 252), ...renderedContent, renderBar("", columns, 236, 252)]
        : renderedContent,
      cursorRow: (hasPadding ? 1 : 0) + visibleRows.length,
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

function renderBlock(block: RenderBlock, columns: number) {
  const theme = themes[block.role];
  const innerWidth = Math.max(1, columns - 4);
  const rows: StyledSegment[][] = [[]];

  if (block.title) {
    rows.push(...wrapSegments([{ text: block.title, style: "title" }], innerWidth));
  }

  const content = sanitizeContent(block.content);
  if (content) {
    for (const line of content.split("\n")) {
      rows.push(...wrapSegments(parseMarkdownLine(line), innerWidth));
    }
  }

  rows.push([]);
  return rows.map((row) => renderBlockRow(row, theme, columns));
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
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${BOLD}${segment.text}`;
    case "italic":
      return `${RESET}${bg(theme.bg)}${fg(theme.fg)}${ITALIC}${segment.text}`;
    case "code":
      return `${RESET}${bg(230)}${fg(16)}${segment.text}`;
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

function wrapInputText(text: string, width: number) {
  const rows = text.split("\n").flatMap((line) => wrapInputLine(line, width));
  return rows.length > 0 ? rows : [""];
}

function wrapInputLine(text: string, width: number) {
  const rows: string[] = [];
  const chars = Array.from(text);
  const maxWidth = Math.max(1, width);
  let index = 0;

  while (index < chars.length) {
    while (rows.length > 0 && isInputWrapWhitespace(chars[index])) {
      index += 1;
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
      rows.push(chars.slice(index, end).join(""));
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

    rows.push(chars.slice(index, rowEnd).join(""));
    index = next;
  }

  return rows.length > 0 ? rows : [""];
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
    while (chars[index]?.text === " ") {
      index += 1;
    }
    if (index >= chars.length) {
      break;
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

function plainLine(text: string, columns: number) {
  return `${text}${" ".repeat(Math.max(0, columns - visibleLength(text)))}`;
}

function padAnsi(text: string, columns: number) {
  return `${text}${" ".repeat(Math.max(0, columns - visibleLength(text)))}`;
}

function sanitizeContent(text: string) {
  return String(text)
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
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
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function fg(code: number) {
  return `\x1b[38;5;${code}m`;
}

function bg(code: number) {
  return `\x1b[48;5;${code}m`;
}
