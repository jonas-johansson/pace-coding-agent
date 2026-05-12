type BlockRole = "user" | "assistant" | "tool_use" | "tool_result" | "error";

export type RenderBlock = {
  id: number;
  role: BlockRole;
  title?: string;
  content: string;
};

type SubmitHandler = (input: string) => void | Promise<void>;
type SegmentStyle = "normal" | "bold" | "code" | "heading" | "title";

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
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ANSI_AT_START = /^\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/;
const SGR_MOUSE_PATTERN = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const MOUSE_WHEEL_LINES = 3;
const INPUT_HORIZONTAL_PADDING = 2;
const INPUT_ROWS = 3;
const STATUS_ROWS = 1;
const RESERVED_ROWS = INPUT_ROWS + STATUS_ROWS;

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

  private startSpinner() {
    if (this.spinnerTimer) {
      return;
    }

    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, 120);
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

    for (const char of Array.from(data)) {
      if (char === "\r" || char === "\n") {
        this.submitInput();
        continue;
      }

      if (char === "\u007f" || char === "\b") {
        this.input = Array.from(this.input).slice(0, -1).join("");
        this.requestRender();
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
      default:
        return data.startsWith("\x1b");
    }
  }

  private handleMouse(data: string) {
    let handled = false;

    for (const match of data.matchAll(SGR_MOUSE_PATTERN)) {
      handled = this.handleMouseButton(Number(match[1]), match[4]) || handled;
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

      handled = this.handleMouseButton(data.charCodeAt(start + 3) - 32, "M") || handled;
      index = start + 6;
    }

    return handled;
  }

  private handleMouseButton(buttonCode: number, action: string) {
    if (action !== "M" || (buttonCode & 64) === 0) {
      return false;
    }

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

  private scrollPageUp() {
    this.scrollBy(Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollPageDown() {
    this.scrollBy(-Math.max(1, Math.floor(this.messageRows() / 2)));
  }

  private scrollBy(lines: number) {
    this.scrollOffset = Math.max(0, this.scrollOffset + Math.trunc(lines));
    this.requestRender();
  }

  private scrollToTop() {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender();
  }

  private scrollToBottom() {
    this.scrollOffset = 0;
    this.requestRender();
  }

  private messageRows() {
    return Math.max(process.stdout.rows ?? 24, RESERVED_ROWS + 1) - RESERVED_ROWS;
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

    const columns = Math.max(process.stdout.columns ?? 80, 20);
    const rows = Math.max(process.stdout.rows ?? 24, RESERVED_ROWS + 1);
    const messageRows = rows - RESERVED_ROWS;
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
    const input = this.renderInputLine(columns);

    const lines = [...messageLines, statusLine, ...input.lines];
    const output = [`${HIDE_CURSOR}`];
    for (let row = 0; row < rows; row += 1) {
      output.push(`\x1b[${row + 1};1H\x1b[2K${clipAnsi(lines[row] ?? "", columns)}`);
    }
    output.push(`\x1b[${rows - 1};${input.cursorCol}H${SHOW_CURSOR}`);

    process.stdout.write(output.join(""));
  }

  private renderStatusLine(columns: number, maxScroll: number) {
    const spinner = this.running ? SPINNER_FRAMES[this.spinnerFrame] : " ";
    const scrollText = this.scrollOffset > 0 ? ` | scroll ${this.scrollOffset}/${maxScroll} | End latest` : "";
    const text = `${spinner} ${this.status || "idle"}${scrollText}`;
    return renderBar(text, columns, 235, this.running ? 229 : 250);
  }

  private renderInputLine(columns: number) {
    const prompt = "";
    const horizontalPadding = Math.min(INPUT_HORIZONTAL_PADDING, Math.floor((columns - 1) / 2));
    const textWidth = Math.max(1, columns - horizontalPadding * 2);
    const raw = `${prompt}${this.input}`;
    const visible = takeRight(raw, textWidth);
    const cursorCol = Math.max(1, Math.min(columns, horizontalPadding + visibleLength(visible) + 1));
    return {
      lines: [
        renderBar("", columns, 236, 252),
        renderBar(`${" ".repeat(horizontalPadding)}${visible}`, columns, 236, 252),
        renderBar("", columns, 236, 252),
      ],
      cursorCol,
    };
  }
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

    normal += line[index];
    index += 1;
  }

  flushNormal();
  return segments.length > 0 ? segments : [{ text: "", style: "normal" }];
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
  return displayWidth(text.replace(ANSI_PATTERN, ""));
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
