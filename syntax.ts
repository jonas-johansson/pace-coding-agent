/**
 * syntax.ts — Syntax tokenizer for fenced code blocks.
 *
 * Exposes:
 *   initHighlighter()              — call once at startup (fire-and-forget)
 *   tokenizeCode(lines, language)  → SyntaxSegment[][]
 *
 * Shiki is used when available (initialized asynchronously at startup).
 * The hand-rolled tokenizer is used as an immediate fallback until Shiki is
 * ready, and permanently for any language Shiki did not load.
 *
 * SyntaxSegment styles:
 *   "sh-raw"        — Shiki token; carries a CSS hex `color` field
 *   "sh-keyword"    — hand-rolled: keywords
 *   "sh-string"     — hand-rolled: string literals
 *   "sh-number"     — hand-rolled: numeric literals
 *   "sh-comment"    — hand-rolled: comments
 *   "sh-type"       — hand-rolled: type names / built-ins
 *   "sh-function"   — hand-rolled: function calls
 *   "sh-operator"   — hand-rolled: operators
 *   "sh-punctuation"— hand-rolled: brackets, commas, colons
 *   "sh-property"   — hand-rolled: object keys / CSS properties
 *   "code"          — plain (unrecognised) token
 */

import {
  createHighlighterCoreSync,
  type HighlighterCore,
  type ThemedToken,
  type ThemeRegistrationAny,
  type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages, bundledThemes } from "shiki";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyntaxStyle =
  | "code"
  | "sh-raw"
  | "sh-keyword"
  | "sh-string"
  | "sh-number"
  | "sh-comment"
  | "sh-type"
  | "sh-function"
  | "sh-operator"
  | "sh-punctuation"
  | "sh-property";

export type SyntaxSegment = {
  text: string;
  style: SyntaxStyle;
  /** Only set when style === "sh-raw". CSS hex color string, e.g. "#569CD6". */
  color?: string;
  /** Only set when style === "sh-raw". FontStyle bitmask: Bold=2, Italic=1. */
  fontStyle?: number;
};

// ---------------------------------------------------------------------------
// Shiki integration
// ---------------------------------------------------------------------------

const THEME = "dark-plus";

const SHIKI_LANGS = [
  "typescript",
  "javascript",
  "json",
  "python",
  "bash",
  "shell",
  "markdown",
  "html",
  "css",
  "sql",
  "rust",
  "go",
  "yaml",
  "toml",
  "dockerfile",
  "regex",
] as const;

type ShikiLang = (typeof SHIKI_LANGS)[number];

/** Normalises common LLM-output language tags to Shiki's bundled IDs. */
const shikiLangAlias: Record<string, ShikiLang> = {
  // JavaScript
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // TypeScript
  ts: "typescript",
  tsx: "typescript",
  // Python
  py: "python",
  python3: "python",
  // Shell
  sh: "bash",
  zsh: "bash",
  fish: "bash",
  // YAML
  yml: "yaml",
  // JSON variants
  jsonc: "json",
  json5: "json",
};

function resolveShikiLang(lang: string): string {
  const lower = lang.toLowerCase();
  return shikiLangAlias[lower] ?? lower;
}

let shiki: HighlighterCore | null = null;

/**
 * Asynchronously initialises the Shiki highlighter.  Call once at app startup
 * and ignore the return value — the hand-rolled tokenizer works immediately
 * while Shiki loads in the background.
 */
export async function initHighlighter(): Promise<void> {
  const engine = createJavaScriptRegexEngine();

  const [themeModule, ...langModules] = await Promise.all([
    bundledThemes[THEME]() as Promise<{ default: ThemeRegistrationAny }>,
    ...SHIKI_LANGS.map((l) =>
      (bundledLanguages as Record<string, () => Promise<{ default: LanguageRegistration | LanguageRegistration[] }>>)[l]()
    ),
  ]);

  shiki = createHighlighterCoreSync({
    themes: [themeModule.default],
    langs: langModules.map((m) => m.default),
    engine,
  });
}

// ---------------------------------------------------------------------------
// Hex → ANSI 256-color conversion
// ---------------------------------------------------------------------------

/**
 * Map a CSS hex color (e.g. "#569CD6") to the nearest ANSI 256-color index.
 * Uses the 6×6×6 RGB cube (indices 16–231) and the 24-step grayscale ramp
 * (indices 232–255).
 */
export function hexToAnsi256(hex: string): number {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  // Grayscale ramp (232–255): use when all channels are close to each other.
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8)   return 16;   // nearest black in color cube
    if (r > 248) return 231;  // nearest white in color cube
    return Math.round(((r - 8) / 247) * 24) + 232;
  }

  // 6×6×6 color cube (16–231): channel steps are 0, 95, 135, 175, 215, 255.
  const steps = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number) =>
    steps.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(steps[best] - v) ? i : best), 0);

  return 16 + 36 * nearest(r) + 6 * nearest(g) + nearest(b);
}

// ---------------------------------------------------------------------------
// Shiki tokenization path
// ---------------------------------------------------------------------------

function tokenizeWithShiki(lines: string[], lang: string): SyntaxSegment[][] {
  const code = lines.join("\n");
  const tokenLines: ThemedToken[][] = shiki!.codeToTokensBase(code, {
    lang,
    theme: THEME,
  });

  // codeToTokensBase may return a trailing empty line; align to input lines.
  return lines.map((line, i) => {
    const tokens = tokenLines[i] ?? [];
    if (tokens.length === 0) {
      return [{ text: line, style: "code" as const }];
    }
    return tokens.map((t) => ({
      text: t.content,
      style: "sh-raw" as const,
      color: t.color,
      fontStyle: t.fontStyle ?? 0,
    }));
  });
}

// ---------------------------------------------------------------------------
// Hand-rolled tokenizer
// ---------------------------------------------------------------------------

type TokenRule = { pattern: RegExp; style: SyntaxStyle };

/** Walk `line` left-to-right matching the earliest rule at each position. */
function tokenizeLine(line: string, rules: TokenRule[]): SyntaxSegment[] {
  const segments: SyntaxSegment[] = [];
  let pos = 0;

  outer: while (pos < line.length) {
    let earliest = -1;
    let earliestLen = 0;
    let earliestStyle: SyntaxStyle = "code";

    for (const rule of rules) {
      rule.pattern.lastIndex = pos;
      const m = rule.pattern.exec(line);
      if (m === null) continue;
      const start = m.index;
      if (earliest === -1 || start < earliest || (start === earliest && m[0].length > earliestLen)) {
        earliest = start;
        earliestLen = m[0].length;
        earliestStyle = rule.style;
      }
      if (start === pos) {
        break; // already at the earliest possible position
      }
    }

    if (earliest === -1) {
      segments.push({ text: line.slice(pos), style: "code" });
      break outer;
    }

    if (earliest > pos) {
      segments.push({ text: line.slice(pos, earliest), style: "code" });
    }

    segments.push({ text: line.slice(earliest, earliest + earliestLen), style: earliestStyle });
    pos = earliest + earliestLen;
  }

  return segments;
}

/** Renamed internal wrapper used by tokenizeCode() when Shiki is unavailable. */
function tokenizeWithRules(lines: string[], language: string | null): SyntaxSegment[][] {
  const rules = language ? (langRules[language.toLowerCase()] ?? null) : null;
  return lines.map((line) => {
    if (!rules) return [{ text: line, style: "code" as const }];
    const segments = tokenizeLine(line, rules);
    return segments.length === 0 ? [{ text: line, style: "code" as const }] : segments;
  });
}

// ---------------------------------------------------------------------------
// Language rule sets
// ---------------------------------------------------------------------------

// JavaScript / TypeScript
const JS_KEYWORDS =
  "\\b(?:abstract|any|as|async|await|boolean|break|case|catch|class|const|constructor|continue|" +
  "declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|" +
  "implements|import|in|instanceof|interface|keyof|let|namespace|never|new|null|number|object|" +
  "of|override|package|private|protected|public|readonly|return|set|static|string|super|switch|" +
  "symbol|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|with|yield)\\b";

const JS_TYPES = "\\b(?:[A-Z][A-Za-z0-9_]*)\\b";

const jsRules: TokenRule[] = [
  { pattern: /\/\/.*/gy, style: "sh-comment" },
  { pattern: /\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  { pattern: /`(?:[^`\\]|\\.)*`/gy, style: "sh-string" },
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  { pattern: new RegExp(JS_KEYWORDS, "gy"), style: "sh-keyword" },
  { pattern: new RegExp(JS_TYPES, "gy"), style: "sh-type" },
  { pattern: /\b([a-z_$][A-Za-z0-9_$]*)(?=\s*\()/gy, style: "sh-function" },
  { pattern: /\b0x[\da-fA-F]+n?\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/gy, style: "sh-number" },
  { pattern: /(?:===|!==|=>|<=|>=|<<|>>|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?])/gy, style: "sh-operator" },
  { pattern: /[{}()[\],.;:]/gy, style: "sh-punctuation" },
  { pattern: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*:(?!:))/gy, style: "sh-property" },
];

// Python
const PY_KEYWORDS =
  "\\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|" +
  "except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|" +
  "try|while|with|yield)\\b";

const PY_BUILTINS =
  "\\b(?:abs|all|any|bool|bytes|callable|chr|complex|dict|dir|divmod|enumerate|eval|exec|" +
  "filter|float|format|frozenset|getattr|globals|hasattr|hash|help|hex|id|input|int|isinstance|" +
  "issubclass|iter|len|list|locals|map|max|memoryview|min|next|object|oct|open|ord|pow|print|" +
  "property|range|repr|reversed|round|set|setattr|slice|sorted|staticmethod|str|sum|super|" +
  "tuple|type|vars|zip)\\b";

const pyRules: TokenRule[] = [
  { pattern: /#.*/gy, style: "sh-comment" },
  { pattern: /"""[\s\S]*?"""/gy, style: "sh-string" },
  { pattern: /'''[\s\S]*?'''/gy, style: "sh-string" },
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  { pattern: new RegExp(PY_KEYWORDS, "gy"), style: "sh-keyword" },
  { pattern: new RegExp(PY_BUILTINS, "gy"), style: "sh-type" },
  { pattern: /\b[A-Z][A-Za-z0-9_]*\b/gy, style: "sh-type" },
  { pattern: /\b([a-z_][A-Za-z0-9_]*)(?=\s*\()/gy, style: "sh-function" },
  { pattern: /@[A-Za-z_][A-Za-z0-9_.]*/gy, style: "sh-keyword" },
  { pattern: /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  { pattern: /(?:==|!=|<=|>=|\*\*|\/\/|<<|>>|->|[+\-*/%&|^~!=<>])/gy, style: "sh-operator" },
  { pattern: /[{}()[\],.;:]/gy, style: "sh-punctuation" },
];

// Bash / shell
const SH_KEYWORDS =
  "\\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|return|select|then|until|while)\\b";

const SH_BUILTINS =
  "\\b(?:alias|bg|bind|break|builtin|caller|cd|command|compgen|complete|compopt|continue|" +
  "declare|dirs|disown|echo|enable|eval|exec|exit|export|false|fc|fg|getopts|hash|help|" +
  "history|jobs|kill|let|local|logout|mapfile|popd|printf|pushd|pwd|read|readarray|readonly|" +
  "set|shift|shopt|source|suspend|test|times|trap|true|type|typeset|ulimit|umask|unalias|" +
  "unset|wait)\\b";

const shRules: TokenRule[] = [
  { pattern: /#.*/gy, style: "sh-comment" },
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  { pattern: /'[^']*'/gy, style: "sh-string" },
  { pattern: /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9])/gy, style: "sh-type" },
  { pattern: new RegExp(SH_KEYWORDS, "gy"), style: "sh-keyword" },
  { pattern: new RegExp(SH_BUILTINS, "gy"), style: "sh-function" },
  { pattern: /\b\d+\b/gy, style: "sh-number" },
  { pattern: /(?:&&|\|\||>>|[|&;<>])/gy, style: "sh-operator" },
  { pattern: /[{}()[\],.]/gy, style: "sh-punctuation" },
  { pattern: /(?:^|\s)--?[A-Za-z][A-Za-z0-9_-]*/gy, style: "sh-property" },
];

// JSON
const jsonRules: TokenRule[] = [
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  { pattern: /\b(?:true|false|null)\b/gy, style: "sh-keyword" },
  { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  { pattern: /:/gy, style: "sh-operator" },
  { pattern: /[{}()[\],]/gy, style: "sh-punctuation" },
];

// CSS
const cssRules: TokenRule[] = [
  { pattern: /\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  { pattern: /@[A-Za-z-]+/gy, style: "sh-keyword" },
  { pattern: /#[\da-fA-F]{3,8}\b/gy, style: "sh-number" },
  { pattern: /-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|rad|fr|ch|ex)?\b/gy, style: "sh-number" },
  { pattern: /::?[A-Za-z-]+/gy, style: "sh-type" },
  { pattern: /!important\b/gy, style: "sh-keyword" },
  { pattern: /[A-Za-z-]+(?=\s*:)/gy, style: "sh-property" },
  { pattern: /[{}()[\],;:]/gy, style: "sh-punctuation" },
];

// HTML / XML
const htmlRules: TokenRule[] = [
  { pattern: /<!--[\s\S]*?-->/gy, style: "sh-comment" },
  { pattern: /<!?[A-Za-z][^>]*>/gy, style: "sh-comment" },
  { pattern: /<\/[A-Za-z][A-Za-z0-9._:-]*>/gy, style: "sh-keyword" },
  { pattern: /<[A-Za-z][A-Za-z0-9._:-]*/gy, style: "sh-keyword" },
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  { pattern: /\b[A-Za-z_:][A-Za-z0-9_.:-]*(?=\s*=)/gy, style: "sh-property" },
  { pattern: /[<>/=]/gy, style: "sh-punctuation" },
  { pattern: /&[A-Za-z#][A-Za-z0-9]*;/gy, style: "sh-type" },
];

// SQL
const SQL_KEYWORDS =
  "\\b(?:ADD|ALL|ALTER|AND|AS|ASC|BETWEEN|BY|CASE|COLUMN|CONSTRAINT|CREATE|CROSS|DATABASE|" +
  "DEFAULT|DELETE|DESC|DISTINCT|DROP|ELSE|END|EXISTS|FOREIGN|FROM|FULL|GROUP|HAVING|IN|" +
  "INDEX|INNER|INSERT|INTO|IS|JOIN|KEY|LEFT|LIKE|LIMIT|NOT|NULL|ON|OR|ORDER|OUTER|PRIMARY|" +
  "REFERENCES|RIGHT|SELECT|SET|TABLE|THEN|TOP|UNION|UNIQUE|UPDATE|VALUES|VIEW|WHEN|WHERE|WITH|" +
  "add|all|alter|and|as|asc|between|by|case|column|constraint|create|cross|database|default|" +
  "delete|desc|distinct|drop|else|end|exists|foreign|from|full|group|having|in|index|inner|" +
  "insert|into|is|join|key|left|like|limit|not|null|on|or|order|outer|primary|references|" +
  "right|select|set|table|then|top|union|unique|update|values|view|when|where|with)\\b";

const sqlRules: TokenRule[] = [
  { pattern: /--.*|\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  { pattern: new RegExp(SQL_KEYWORDS, "gy"), style: "sh-keyword" },
  { pattern: /\b\d+(?:\.\d+)?\b/gy, style: "sh-number" },
  { pattern: /(?:!=|<>|<=|>=|[+\-*/%=<>])/gy, style: "sh-operator" },
  { pattern: /[{}()[\],.;:]/gy, style: "sh-punctuation" },
  { pattern: /`[^`]*`|\[[^\]]*\]/gy, style: "sh-property" },
];

// YAML
const yamlRules: TokenRule[] = [
  { pattern: /#.*/gy, style: "sh-comment" },
  { pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/gy, style: "sh-string" },
  { pattern: /[&*][A-Za-z_][A-Za-z0-9_-]*/gy, style: "sh-type" },
  { pattern: /\b[A-Za-z_][A-Za-z0-9_-]*(?=\s*:)/gy, style: "sh-property" },
  { pattern: /\b(?:true|false|yes|no|null|~)\b/gy, style: "sh-keyword" },
  { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  { pattern: /[{}()[\],:?|>-]/gy, style: "sh-punctuation" },
];

// TOML
const tomlRules: TokenRule[] = [
  { pattern: /#.*/gy, style: "sh-comment" },
  { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/gy, style: "sh-string" },
  { pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/gy, style: "sh-string" },
  { pattern: /\[\[?[^\]]+\]\]?/gy, style: "sh-type" },
  { pattern: /\b[A-Za-z_][A-Za-z0-9_."-]*(?=\s*=)/gy, style: "sh-property" },
  { pattern: /\b(?:true|false)\b/gy, style: "sh-keyword" },
  { pattern: /\b\d{4}-\d{2}-\d{2}(?:T\S*)?\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  { pattern: /[{}()[\],.=]/gy, style: "sh-punctuation" },
];

// ---------------------------------------------------------------------------
// Language alias map (hand-rolled)
// ---------------------------------------------------------------------------

const langRules: Record<string, TokenRule[]> = {
  js: jsRules, javascript: jsRules, jsx: jsRules, mjs: jsRules, cjs: jsRules,
  ts: jsRules, typescript: jsRules, tsx: jsRules,
  json: jsonRules, jsonc: jsonRules, json5: jsonRules,
  py: pyRules, python: pyRules, python3: pyRules,
  sh: shRules, bash: shRules, shell: shRules, zsh: shRules, fish: shRules,
  css: cssRules, scss: cssRules, sass: cssRules, less: cssRules,
  html: htmlRules, htm: htmlRules, xml: htmlRules, svg: htmlRules,
  sql: sqlRules,
  yaml: yamlRules, yml: yamlRules,
  toml: tomlRules,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tokenize `lines` using Shiki when available, falling back to the hand-rolled
 * tokenizer.  Returns one `SyntaxSegment[]` per input line.
 */
export function tokenizeCode(lines: string[], language: string | null): SyntaxSegment[][] {
  if (shiki && language) {
    const resolved = resolveShikiLang(language);
    if (shiki.getLoadedLanguages().includes(resolved)) {
      return tokenizeWithShiki(lines, resolved);
    }
  }
  return tokenizeWithRules(lines, language);
}
