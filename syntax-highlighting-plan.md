# Plan: Syntax Highlighting for Markdown Code Blocks

## Goal

Add language-aware syntax highlighting to fenced code blocks (\`\`\`lang … \`\`\`) rendered in the TUI. Inside a code block, tokens (keywords, strings, comments, numbers, types, etc.) should be colored with ANSI 256-color codes instead of rendering as plain text.

## Current State

- `parseMarkdownLine()` handles **inline** markdown only: headings, `` `code` ``, `**bold**`, `*italic*`. It operates line-by-line and has no concept of fenced blocks.
- `SegmentStyle` is `"normal" | "bold" | "italic" | "code" | "heading" | "title"`.
- `renderSegment()` paints inline `` `code` `` spans with `fg(118)` (green).
- Block-level markdown constructs (fenced code blocks, blockquotes, lists, horizontal rules) are not parsed; a multi-line code block renders as plain text lines.

## Architecture Changes Needed

### 1. Introduce block-level content splitting

Before the existing line-by-line wrapping/rendering, split a block’s content into **regions**:

```
Region = { kind: "markdown"; lines: string[] }
       | { kind: "code"; language: string | null; lines: string[] }
```

A simple state-machine scanner is sufficient:

1. Scan lines sequentially.
2. When a line matches `` /^```(\w*)/ ``, start a `code` region and capture the optional language tag.
3. Collect lines until the closing `` /^```$/ `` or end of content.
4. Everything else is a `markdown` region.

This scanner runs inside `renderAssistantBlock`, `renderUserBlock`, `renderPanelToolBlock`, and `renderErrorBlock` before the row-building loops.

### 2. Extend `SegmentStyle` for syntax tokens

Add new styles that the highlighter can emit:

```ts
type SegmentStyle =
  | "normal" | "bold" | "italic" | "code" | "heading" | "title"
  | "sh-keyword"    // if/else, function, const, return, …
  | "sh-string"     // "…", '…', `…`
  | "sh-number"     // 42, 0xFF, 3.14
  | "sh-comment"    // //, /* */, #, --
  | "sh-type"       // class names, type aliases, primitives
  | "sh-function"   // function calls / declarations
  | "sh-operator"   // +, -, =>, ===, &&
  | "sh-punctuation" // brackets, commas, colons
  | "sh-property";   // object keys, CSS properties
```

### 3. Add a syntax-highlighting module (`syntax.ts`)

A dedicated module keeps tokenization logic out of `tui.ts`. It exposes:

```ts
export function tokenizeCode(lines: string[], language: string | null): StyledSegment[][];
// Returns one array of segments per input line.
```

Two implementation strategies are viable. The plan recommends **Option A** as the primary path with a **fallback to Option B** for offline/air-gapped usage.

#### Option A — Shiki (recommended)

Add `shiki` as a dependency. Shiki v1+ includes `codeToANSI()`, which produces exact ANSI sequences from TextMate grammars.

**Pros**
- High-quality, grammar-accurate highlighting for 100+ languages.
- Built-in ANSI output; no HTML→ANSI conversion needed.
- Well-maintained, actively updated grammars.

**Cons**
- Larger install footprint (~5–8 MB with WASM + grammars).
- Async initialization (`createHighlighter()`).
- May be slower for very large code blocks than a hand-rolled tokenizer.

**Integration sketch**

```ts
import { createHighlighter, type Highlighter } from "shiki";

let highlighter: Highlighter | null = null;

export async function initHighlighter() {
  highlighter = await createHighlighter({ themes: ["dark-plus"], langs: [] });
}

export function tokenizeCode(lines: string[], language: string | null): StyledSegment[][] {
  if (!highlighter || !language) {
    return lines.map((line) => [{ text: line, style: "code" }]);
  }
  const code = lines.join("\n");
  const ansi = highlighter.codeToANSI(code, { lang: language, theme: "dark-plus" });
  // Split ANSI result back into lines and parse SGR sequences into StyledSegments.
  // …
}
```

Because `tokenizeCode` must be synchronous inside the render loop, the highlighter is initialized once at startup and cached. If the cache miss (language not loaded), Shiki supports on-demand grammar loading (`highlighter.loadLanguage(lang)`), which is async, so the first render of a new language would need to either (1) skip highlighting until loaded, or (2) trigger an async load and queue a re-render. The simplest approach is to pre-register common languages at init time.

Pre-registered common languages: `typescript`, `javascript`, `json`, `python`, `bash`, `shell`, `markdown`, `html`, `css`, `sql`, `rust`, `go`, `yaml`, `toml`, `dockerfile`, `regex`.

#### Option B — Lightweight hand-rolled tokenizer (fallback / zero-dependency)

A regex-based lexer for the most common languages. Each language provides a `TokenRule[]` array; the lexer walks the line left-to-right, matching the earliest/longest rule.

**Pros**
- Zero dependencies.
- Synchronous, instant.
- Easy to add new language rules.

**Cons**
- Less accurate than TextMate grammars (e.g., nested comments, complex string interpolation).
- More maintenance burden for new languages.

**Integration sketch**

```ts
const jsRules: TokenRule[] = [
  { pattern: /^(\s*\/\/.*)/, style: "sh-comment" },
  { pattern: /^((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))/, style: "sh-string" },
  { pattern: /^(\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|typeof|instanceof)\b)/, style: "sh-keyword" },
  { pattern: /^(\b(?:true|false|null|undefined)\b)/, style: "sh-type" },
  { pattern: /^(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/, style: "sh-number" },
  { pattern: /^(\b[A-Z][a-zA-Z0-9_]*\b)/, style: "sh-type" },
  { pattern: /^(\b[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\())/, style: "sh-function" },
  { pattern: /^([{}\[\](),;:.])/, style: "sh-punctuation" },
  { pattern: /^([+\-*/%=!&|<>^~?]+)/, style: "sh-operator" },
];
```

A generic `tokenizeLine(line, rules)` function returns `StyledSegment[]`.

### 4. Update the render pipeline

In each block renderer (`renderAssistantBlock`, `renderUserBlock`, etc.), replace the naive `content.split("\n")` loop with region-aware rendering:

```ts
for (const region of splitContentRegions(content)) {
  if (region.kind === "markdown") {
    for (const line of region.lines) {
      rows.push(...wrapSegments(parseMarkdownLine(line), innerWidth));
    }
  } else {
    // Code region
    const tokenized = tokenizeCode(region.lines, region.language);
    for (const segments of tokenized) {
      rows.push(...wrapSegments(segments, innerWidth));
    }
  }
}
```

Because `wrapSegments` already operates on `StyledSegment[]`, tokenized code blocks integrate without changes to the wrapping engine.

### 5. Theme mapping for syntax tokens

Add a `syntaxTheme` map that converts `sh-*` styles into ANSI SGR codes inside `renderSegment`:

```ts
const syntaxTheme: Record<string, string> = {
  "sh-keyword": fg(204),     // soft red
  "sh-string": fg(151),    // pale green
  "sh-number": fg(179),    // tan / gold
  "sh-comment": fg(245),   // gray (dim)
  "sh-type": fg(81),       // cyan
  "sh-function": fg(117),  // light blue
  "sh-operator": fg(186),  // light yellow
  "sh-punctuation": fg(250), // light gray
  "sh-property": fg(187),  // pale magenta
};
```

These colors are chosen to be readable on the existing `CANVAS_BG = 234` (near-black) and `PANEL_BG = 235` (dark gray) backgrounds.

### 6. Code block framing (optional polish)

To visually distinguish a code block from body text, render a subtle frame:

- Prefix each code line with a narrow left gutter using a dim color (e.g., `fg(240) | `).
- Or add a one-character left border in `bg(237)` with `fg(245)`.

This is a visual-design decision that can be deferred to a later iteration.

## Implementation Phases

### Phase 1 — Region splitting + existing `` `inline code` `` preserved
- Add `splitContentRegions()` to `tui.ts` (or a new `markdown.ts` module).
- Update all four block renderers to iterate regions instead of raw lines.
- Ensure code regions still render with the existing `"code"` style (no syntax highlighting yet, but correctly identified).
- Verify that inline backticks inside markdown regions continue to work.

### Phase 2 — Syntax highlighting module
- Create `syntax.ts`.
- Implement the **fallback tokenizer** (Option B) for JS/TS, JSON, Python, and Bash. This immediately gives value without heavy deps.
- Wire `tokenizeCode()` into the region loop.
- Add the `sh-*` style branches to `renderSegment()` with the color map.

### Phase 3 — Shiki integration (optional, if desired)
- Add `shiki` to `package.json`.
- Initialize the highlighter asynchronously at app startup (`app.ts` → `await initHighlighter()`).
- Make `tokenizeCode()` try Shiki first, fall back to the hand-rolled tokenizer if the language is unavailable or Shiki is not ready.
- Cache tokenized results per block to avoid re-highlighting unchanged content on every render.

### Phase 4 — Visual polish
- Add a subtle left border / gutter to code blocks.
- Add an info line showing the detected language (e.g., `typescript`) in the top-right corner of the first code line.
- Fine-tune theme colors for contrast on both assistant (black) and tool (gray) panel backgrounds.

## Files to Modify / Create

| File | Action | Notes |
|------|--------|-------|
| `tui.ts` | Modify | Add region splitting; extend `SegmentStyle`; add `syntaxTheme` to `renderSegment`; update block renderers. |
| `syntax.ts` | Create | Tokenizer rules for JS/TS, JSON, Python, Bash; `tokenizeCode()` function. |
| `package.json` | Modify | Add `shiki` (Phase 3 only; Phase 2 needs no new deps). |
| `app.ts` | Modify | `await initHighlighter()` at startup (Phase 3 only). |

## Open Decisions

1. **Shiki vs. hand-rolled only**: Decide after Phase 2 whether the quality/complexity trade-off of Shiki is worth it for this tool.
2. **Language tag normalization**: Shiki uses `ts` / `typescript`, `js` / `javascript`, `py` / `python`, `sh` / `bash` / `shell`. Maintain an alias map so common tags from LLM output (e.g., `js`, `ts`, `py`, `sh`) all resolve correctly.
3. **Block cache invalidation**: The existing block-level render cache (`blockRenderCache`) keys on `content`, `title`, `state`, `collapsed`, and `columns`. Adding syntax highlighting does not change these keys, so no cache invalidation changes are needed unless we add a separate syntax-token cache.
