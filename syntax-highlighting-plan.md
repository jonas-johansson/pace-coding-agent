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

See the detailed design below.

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

---

## Phase 3 Detailed Design — Shiki Integration

### Overview

Shiki v4 produces `ThemedToken[][]` — one array of tokens per line, each token carrying a `color` hex string (and optional `fontStyle` flags for bold/italic). We convert that into our existing `SyntaxSegment[][]` format by mapping hex colors to the nearest ANSI 256-color code. This keeps `tokenizeCode()` synchronous after startup and requires no changes outside `syntax.ts` and `app.ts`.

### Shiki API choices

Shiki v4 ships two regex engines:

| Engine | Init | Notes |
|--------|------|-------|
| `createOnigurumaEngine` | `async` (loads WASM) | Full grammar accuracy. ~5–8 MB WASM blob. |
| `createJavaScriptRegexEngine` | synchronous | Pure-JS transpiled regexes. Covers all bundled languages well. No WASM. Recommended. |

**Use `createJavaScriptRegexEngine`.** It avoids the WASM load entirely, makes startup simpler, and still produces grammar-accurate output far beyond our hand-rolled tokenizer.

After the engine is resolved we use `createHighlighterCoreSync` so the highlighter instance is available synchronously for subsequent `codeToTokensBase()` calls inside the render loop.

### Initialization sequence

```
app startup
  └─ await initHighlighter()          (syntax.ts export)
       ├─ createJavaScriptRegexEngine()   — synchronous
       ├─ createHighlighterCoreSync({     — synchronous
       │     themes: [themeObject],
       │     langs:  [lang1, lang2, …],
       │     engine,
       │  })
       └─ shikiReady = true
```

`initHighlighter` is `async` only because the lang/theme modules are dynamic imports (each is a small JSON-like object). They can all be `await Promise.all()`-ed in one shot.

### `syntax.ts` changes

```ts
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlighterCore, ThemedToken } from "shiki/core";

let shiki: HighlighterCore | null = null;
const THEME = "dark-plus";

// Pre-registered languages (aliases resolved via langMap below).
const SHIKI_LANGS = [
  "typescript", "javascript", "json", "python", "bash",
  "shell", "markdown", "html", "css", "sql", "rust", "go",
  "yaml", "toml", "dockerfile", "regex",
] as const;

export async function initHighlighter(): Promise<void> {
  const engine = createJavaScriptRegexEngine();
  const [theme, ...langs] = await Promise.all([
    import("shiki/themes/dark-plus"),
    ...SHIKI_LANGS.map((l) => import(`shiki/langs/${l}`)),
  ]);
  shiki = createHighlighterCoreSync({
    themes: [theme.default],
    langs: langs.map((m) => m.default),
    engine,
  });
}
```

**Language alias resolution** — Shiki's bundled language IDs are the full names (`typescript`, `javascript`, …), but LLM output uses short tags (`ts`, `js`, `py`, `sh`). Add a `shikiLangAlias` map that normalises the tag before passing it to `codeToTokensBase()`:

```ts
const shikiLangAlias: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", python3: "python",
  sh: "bash", shell: "bash", zsh: "bash", fish: "bash",
  yml: "yaml",
  jsonc: "json", json5: "json",
  // full names pass through unchanged
};

function resolveShikiLang(lang: string): string {
  return shikiLangAlias[lang] ?? lang;
}
```

**`tokenizeCode()` — try Shiki, fall back to hand-rolled:**

```ts
export function tokenizeCode(lines: string[], language: string | null): SyntaxSegment[][] {
  if (shiki && language) {
    const resolved = resolveShikiLang(language.toLowerCase());
    if (shiki.getLoadedLanguages().includes(resolved)) {
      return tokenizeWithShiki(lines, resolved);
    }
  }
  // Hand-rolled fallback (existing logic unchanged).
  return tokenizeWithRules(lines, language);
}
```

### Converting `ThemedToken[][]` → `SyntaxSegment[][]`

Shiki returns `ThemedToken[][]` where each token has:
- `content: string` — the token text
- `color?: string` — CSS hex color from the theme, e.g. `"#569CD6"`
- `fontStyle?: number` — bitmask (bold = 2, italic = 1, underline = 4)

We need to map hex colors to `SyntaxSegment` styles. Because `renderSegment()` is already wired to emit ANSI fg colors for `sh-*` styles, the cleanest approach for Shiki tokens is to introduce a new **passthrough segment style** `"sh-raw"` that carries the hex color directly, and let `renderSegment()` convert it to an ANSI 256-color code at render time:

```ts
// New style added to SegmentStyle in tui.ts:
| "sh-raw"

// New field added to StyledSegment in tui.ts:
type StyledSegment = {
  text: string;
  style: SegmentStyle;
  color?: string;   // only set when style === "sh-raw"; holds a CSS hex color
};
```

`renderSegment` gains a new case:

```ts
case "sh-raw": {
  const ansi = segment.color ? hexToAnsi256(segment.color) : theme.fg;
  const prefix = (segment.fontStyle ?? 0) & 2 ? BOLD : "";
  const italic = (segment.fontStyle ?? 0) & 1 ? ITALIC : "";
  return `${RESET}${bg(theme.bg)}${fg(ansi)}${prefix}${italic}${segment.text}`;
}
```

`SyntaxSegment` in `syntax.ts` is extended with the same optional `color` field so it can carry Shiki data without breaking the existing hand-rolled path.

The `tokenizeWithShiki` helper:

```ts
function tokenizeWithShiki(lines: string[], lang: string): SyntaxSegment[][] {
  const code = lines.join("\n");
  // codeToTokensBase is synchronous on a fully-initialised highlighter.
  const tokenLines: ThemedToken[][] = shiki!.codeToTokensBase(code, {
    lang,
    theme: THEME,
  });

  // Pad/trim to match the input line count (Shiki may add a trailing empty line).
  return lines.map((_, i) => {
    const tokens = tokenLines[i] ?? [];
    if (tokens.length === 0) return [{ text: lines[i], style: "code" as const }];
    return tokens.map((t) => ({
      text: t.content,
      style: "sh-raw" as const,
      color: t.color,
    }));
  });
}
```

### Hex → ANSI 256 conversion

Add `hexToAnsi256(hex: string): number` to `syntax.ts`. The standard ANSI 256-color cube (colors 16–231) uses a 6×6×6 RGB grid with channel steps `[0, 95, 135, 175, 215, 255]`. The grayscale ramp (232–255) covers 24 levels from 8 to 238 in steps of 10.

```ts
function hexToAnsi256(hex: string): number {
  // Parse "#RRGGBB" or "#RGB"
  const c = hex.replace("#", "");
  const full = c.length === 3
    ? c.split("").map((x) => x + x).join("")
    : c;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  // Check grayscale ramp first (more precise for near-gray colors).
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8)  return 16;   // black
    if (r > 248) return 231;  // white
    return Math.round((r - 8) / 247 * 24) + 232;
  }

  // Map each channel to the nearest 6-step cube index.
  const steps = [0, 95, 135, 175, 215, 255];
  const ri = steps.reduce((best, v, i) => Math.abs(v - r) < Math.abs(steps[best] - r) ? i : best, 0);
  const gi = steps.reduce((best, v, i) => Math.abs(v - g) < Math.abs(steps[best] - g) ? i : best, 0);
  const bi = steps.reduce((best, v, i) => Math.abs(v - b) < Math.abs(steps[best] - b) ? i : best, 0);
  return 16 + 36 * ri + 6 * gi + bi;
}
```

### `app.ts` changes

```ts
import { initHighlighter } from "./syntax.js";

async function main() {
  tui.start();
  updateContextInfo();
  // …existing startup code…

  // Initialise Shiki in the background; syntax.ts falls back to the
  // hand-rolled tokenizer until the promise resolves.
  initHighlighter().catch(() => {
    // Non-fatal: hand-rolled highlighting remains active.
  });
}
```

`initHighlighter` is fire-and-forget — the first render(s) use the hand-rolled tokenizer and switch automatically to Shiki once `shiki` is assigned.

### `package.json` changes

```json
"dependencies": {
  "shiki": "^4.0.0"
}
```

No additional `@types/shiki` needed — the package ships its own TypeScript declarations.

### `tsconfig.json` changes

`syntax.ts` needs to be added to the `include` list (it currently is not):

```json
"include": [
  "app.ts", "tool.ts", "tui.ts", "input.ts", "provider.ts",
  "clipboard.ts", "skill.ts", "syntax.ts",
  "providers/anthropic.ts", "providers/opencode-zen.ts", "providers/openai.ts"
]
```

### Token cache

Shiki is fast but `codeToTokensBase` does real work on every call. Because `blockRenderCache` already caches rendered rows keyed on `(content, title, state, collapsed, columns)`, re-highlighting is already avoided for unchanged blocks — no additional cache is needed.

If profiling shows render cost, a `Map<string, SyntaxSegment[][]>` keyed on `lang + "\0" + code` inside `syntax.ts` would be sufficient.

### Files modified / created

| File | Change |
|------|--------|
| `syntax.ts` | Add `initHighlighter()`, `hexToAnsi256()`, `tokenizeWithShiki()`, `shikiLangAlias` map; extend `SyntaxSegment` with optional `color` field; update `tokenizeCode()` to try Shiki first. |
| `tui.ts` | Add `"sh-raw"` to `SegmentStyle`; add `color?: string` to `StyledSegment`; add `"sh-raw"` case in `renderSegment()`. |
| `app.ts` | Import and fire-and-forget `initHighlighter()` in `main()`. |
| `package.json` | Add `"shiki": "^4.0.0"` to `dependencies`. |
| `tsconfig.json` | Add `"syntax.ts"` to `include`. |

### Risk / mitigation

| Risk | Mitigation |
|------|------------|
| Shiki dynamic imports fail (e.g., no internet at install time) | `initHighlighter` failure is silently caught; hand-rolled tokenizer keeps working. |
| `createJavaScriptRegexEngine` produces incorrect highlighting for some grammars | Hand-rolled fallback activates for any language Shiki did not load. |
| Large code block causes perceptible render lag | Block-level cache in `blockRenderCache` means Shiki only runs once per unique block content. |
| Shiki `dark-plus` colors clash with terminal palette | `hexToAnsi256` quantises to the nearest of the 240 non-system colors; inherently approximate but well-tested for `dark-plus` on 256-color terminals. |

## Open Decisions

1. **Shiki vs. hand-rolled only**: Decide after Phase 2 whether the quality/complexity trade-off of Shiki is worth it for this tool.
2. **Language tag normalization**: Shiki uses `ts` / `typescript`, `js` / `javascript`, `py` / `python`, `sh` / `bash` / `shell`. Maintain an alias map so common tags from LLM output (e.g., `js`, `ts`, `py`, `sh`) all resolve correctly.
3. **Block cache invalidation**: The existing block-level render cache (`blockRenderCache`) keys on `content`, `title`, `state`, `collapsed`, and `columns`. Adding syntax highlighting does not change these keys, so no cache invalidation changes are needed unless we add a separate syntax-token cache.
