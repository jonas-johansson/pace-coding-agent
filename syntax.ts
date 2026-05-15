/**
 * syntax.ts — Hand-rolled syntax tokenizer for fenced code blocks.
 *
 * Exposes:
 *   tokenizeCode(lines, language) → StyledSegment[][]
 *
 * Each entry in the returned array corresponds to one input line and contains
 * a sequence of StyledSegment values whose styles are "sh-keyword", "sh-string",
 * "sh-number", "sh-comment", "sh-type", "sh-function", "sh-operator",
 * "sh-punctuation", "sh-property", or the plain "code" style for anything that
 * did not match a rule.
 */

// We re-declare the minimal slice of types we need so this module has no
// circular dependency on tui.ts.
type SyntaxStyle =
  | "code"
  | "sh-keyword"
  | "sh-string"
  | "sh-number"
  | "sh-comment"
  | "sh-type"
  | "sh-function"
  | "sh-operator"
  | "sh-punctuation"
  | "sh-property";

export type SyntaxSegment = { text: string; style: SyntaxStyle };

// ---------------------------------------------------------------------------
// Token rule
// ---------------------------------------------------------------------------

type TokenRule = { pattern: RegExp; style: SyntaxStyle };

// ---------------------------------------------------------------------------
// Shared / language-agnostic helpers
// ---------------------------------------------------------------------------

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
        // Already at the earliest possible position; no need to keep looking.
        break;
      }
    }

    if (earliest === -1) {
      // No rule matched anywhere in the remaining string.
      segments.push({ text: line.slice(pos), style: "code" });
      break outer;
    }

    if (earliest > pos) {
      // Plain text before the match.
      segments.push({ text: line.slice(pos, earliest), style: "code" });
    }

    segments.push({ text: line.slice(earliest, earliest + earliestLen), style: earliestStyle });
    pos = earliest + earliestLen;
  }

  return segments;
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
  // Single-line comment
  { pattern: /\/\/.*/gy, style: "sh-comment" },
  // Multi-line comment (simplified — captures the whole match on one logical scan)
  { pattern: /\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  // Template literals (simplified — no nested ${…} coloring)
  { pattern: /`(?:[^`\\]|\\.)*`/gy, style: "sh-string" },
  // Double-quoted strings
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  // Single-quoted strings
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  // Keywords
  { pattern: new RegExp(JS_KEYWORDS, "gy"), style: "sh-keyword" },
  // Type/class names (PascalCase identifiers)
  { pattern: new RegExp(JS_TYPES, "gy"), style: "sh-type" },
  // Function calls:  ident(
  { pattern: /\b([a-z_$][A-Za-z0-9_$]*)(?=\s*\()/gy, style: "sh-function" },
  // Numbers (hex, float, int, bigint)
  { pattern: /\b0x[\da-fA-F]+n?\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b/gy, style: "sh-number" },
  // Operators
  { pattern: /(?:===|!==|=>|<=|>=|<<|>>|\+\+|--|&&|\|\||[+\-*/%&|^~!=<>?])/gy, style: "sh-operator" },
  // Punctuation
  { pattern: /[{}()[\],.;:]/gy, style: "sh-punctuation" },
  // Object/type property keys:  word  followed by  : (not ::)
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
  // Comments
  { pattern: /#.*/gy, style: "sh-comment" },
  // Triple double-quoted strings
  { pattern: /"""[\s\S]*?"""/gy, style: "sh-string" },
  // Triple single-quoted strings
  { pattern: /'''[\s\S]*?'''/gy, style: "sh-string" },
  // Double-quoted strings
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  // Single-quoted strings
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  // Keywords
  { pattern: new RegExp(PY_KEYWORDS, "gy"), style: "sh-keyword" },
  // Built-ins
  { pattern: new RegExp(PY_BUILTINS, "gy"), style: "sh-type" },
  // Class names (PascalCase)
  { pattern: /\b[A-Z][A-Za-z0-9_]*\b/gy, style: "sh-type" },
  // Function/method calls
  { pattern: /\b([a-z_][A-Za-z0-9_]*)(?=\s*\()/gy, style: "sh-function" },
  // Decorators
  { pattern: /@[A-Za-z_][A-Za-z0-9_.]*/gy, style: "sh-keyword" },
  // Numbers
  { pattern: /\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  // Operators
  { pattern: /(?:==|!=|<=|>=|\*\*|\/\/|<<|>>|->|[+\-*/%&|^~!=<>])/gy, style: "sh-operator" },
  // Punctuation
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
  // Comments
  { pattern: /#.*/gy, style: "sh-comment" },
  // Double-quoted strings
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  // Single-quoted strings (no escapes inside)
  { pattern: /'[^']*'/gy, style: "sh-string" },
  // Variable expansions: ${VAR}, $VAR, $0-$9, $@, $*
  { pattern: /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9])/gy, style: "sh-type" },
  // Keywords
  { pattern: new RegExp(SH_KEYWORDS, "gy"), style: "sh-keyword" },
  // Built-ins
  { pattern: new RegExp(SH_BUILTINS, "gy"), style: "sh-function" },
  // Numbers
  { pattern: /\b\d+\b/gy, style: "sh-number" },
  // Operators / redirects
  { pattern: /(?:&&|\|\||>>|[|&;<>])/gy, style: "sh-operator" },
  // Punctuation
  { pattern: /[{}()[\],.]/gy, style: "sh-punctuation" },
  // Flags: -x or --long-flag
  { pattern: /(?:^|\s)--?[A-Za-z][A-Za-z0-9_-]*/gy, style: "sh-property" },
];

// JSON
const jsonRules: TokenRule[] = [
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"/gy, style: "sh-string" },
  // Keywords (true/false/null)
  { pattern: /\b(?:true|false|null)\b/gy, style: "sh-keyword" },
  // Numbers
  { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  // Object keys — already captured by sh-string above when quoted; no extra rule needed
  // Operators / structural
  { pattern: /:/gy, style: "sh-operator" },
  // Punctuation
  { pattern: /[{}()[\],]/gy, style: "sh-punctuation" },
];

// CSS
const cssRules: TokenRule[] = [
  // Comments
  { pattern: /\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  // At-rules
  { pattern: /@[A-Za-z-]+/gy, style: "sh-keyword" },
  // Property values: colors, sizes, keywords
  { pattern: /#[\da-fA-F]{3,8}\b/gy, style: "sh-number" },
  // Numbers with optional unit
  { pattern: /-?\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|rad|fr|ch|ex)?\b/gy, style: "sh-number" },
  // Selectors / pseudo-classes / pseudo-elements
  { pattern: /::?[A-Za-z-]+/gy, style: "sh-type" },
  // Important
  { pattern: /!important\b/gy, style: "sh-keyword" },
  // CSS property names (word followed by colon)
  { pattern: /[A-Za-z-]+(?=\s*:)/gy, style: "sh-property" },
  // Punctuation
  { pattern: /[{}()[\],;:]/gy, style: "sh-punctuation" },
];

// HTML / XML (very light — just tags and attributes)
const htmlRules: TokenRule[] = [
  // Comments
  { pattern: /<!--[\s\S]*?-->/gy, style: "sh-comment" },
  // Doctype / processing instructions
  { pattern: /<!?[A-Za-z][^>]*>/gy, style: "sh-comment" },
  // Closing tags
  { pattern: /<\/[A-Za-z][A-Za-z0-9._:-]*>/gy, style: "sh-keyword" },
  // Self-closing or opening tags (capture just the tag name portion)
  { pattern: /<[A-Za-z][A-Za-z0-9._:-]*/gy, style: "sh-keyword" },
  // Attribute values
  { pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  // Attribute names
  { pattern: /\b[A-Za-z_:][A-Za-z0-9_.:-]*(?=\s*=)/gy, style: "sh-property" },
  // Punctuation
  { pattern: /[<>/=]/gy, style: "sh-punctuation" },
  // Entities
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
  // Comments
  { pattern: /--.*|\/\*[\s\S]*?\*\//gy, style: "sh-comment" },
  // Strings
  { pattern: /'(?:[^'\\]|\\.)*'/gy, style: "sh-string" },
  // Keywords
  { pattern: new RegExp(SQL_KEYWORDS, "gy"), style: "sh-keyword" },
  // Numbers
  { pattern: /\b\d+(?:\.\d+)?\b/gy, style: "sh-number" },
  // Operators
  { pattern: /(?:!=|<>|<=|>=|[+\-*/%=<>])/gy, style: "sh-operator" },
  // Punctuation
  { pattern: /[{}()[\],.;:]/gy, style: "sh-punctuation" },
  // Identifiers in backticks or brackets
  { pattern: /`[^`]*`|\[[^\]]*\]/gy, style: "sh-property" },
];

// YAML
const yamlRules: TokenRule[] = [
  // Comments
  { pattern: /#.*/gy, style: "sh-comment" },
  // Strings (quoted)
  { pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/gy, style: "sh-string" },
  // YAML anchors & aliases
  { pattern: /[&*][A-Za-z_][A-Za-z0-9_-]*/gy, style: "sh-type" },
  // Keys (word followed by colon)
  { pattern: /\b[A-Za-z_][A-Za-z0-9_-]*(?=\s*:)/gy, style: "sh-property" },
  // Booleans / null
  { pattern: /\b(?:true|false|yes|no|null|~)\b/gy, style: "sh-keyword" },
  // Numbers
  { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  // Punctuation
  { pattern: /[{}()[\],:?|>-]/gy, style: "sh-punctuation" },
];

// TOML
const tomlRules: TokenRule[] = [
  // Comments
  { pattern: /#.*/gy, style: "sh-comment" },
  // Multi-line strings
  { pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/gy, style: "sh-string" },
  // Strings
  { pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/gy, style: "sh-string" },
  // Table headers  [section] / [[array-of-tables]]
  { pattern: /\[\[?[^\]]+\]\]?/gy, style: "sh-type" },
  // Keys
  { pattern: /\b[A-Za-z_][A-Za-z0-9_."-]*(?=\s*=)/gy, style: "sh-property" },
  // Booleans
  { pattern: /\b(?:true|false)\b/gy, style: "sh-keyword" },
  // Numbers / dates
  { pattern: /\b\d{4}-\d{2}-\d{2}(?:T\S*)?\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/gy, style: "sh-number" },
  // Punctuation
  { pattern: /[{}()[\],.=]/gy, style: "sh-punctuation" },
];

// ---------------------------------------------------------------------------
// Language alias map
// ---------------------------------------------------------------------------

const langRules: Record<string, TokenRule[]> = {
  // JavaScript
  js: jsRules,
  javascript: jsRules,
  jsx: jsRules,
  mjs: jsRules,
  cjs: jsRules,
  // TypeScript
  ts: jsRules,
  typescript: jsRules,
  tsx: jsRules,
  // JSON
  json: jsonRules,
  jsonc: jsonRules,
  json5: jsonRules,
  // Python
  py: pyRules,
  python: pyRules,
  python3: pyRules,
  // Shell / Bash
  sh: shRules,
  bash: shRules,
  shell: shRules,
  zsh: shRules,
  fish: shRules,
  // CSS
  css: cssRules,
  scss: cssRules,
  sass: cssRules,
  less: cssRules,
  // HTML / XML
  html: htmlRules,
  htm: htmlRules,
  xml: htmlRules,
  svg: htmlRules,
  // SQL
  sql: sqlRules,
  // YAML
  yaml: yamlRules,
  yml: yamlRules,
  // TOML
  toml: tomlRules,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Tokenize `lines` using the rules for the given `language`.
 * Returns one `SyntaxSegment[]` per input line.
 * Falls back to a single "code"-styled segment per line when the language is
 * unknown or not provided.
 */
export function tokenizeCode(lines: string[], language: string | null): SyntaxSegment[][] {
  const rules = language ? (langRules[language.toLowerCase()] ?? null) : null;

  return lines.map((line) => {
    if (!rules) {
      return [{ text: line, style: "code" as const }];
    }
    const segments = tokenizeLine(line, rules);
    // If we got nothing (e.g. empty line), return a single empty code segment
    // so callers can always rely on at least one element.
    if (segments.length === 0) {
      return [{ text: line, style: "code" as const }];
    }
    return segments;
  });
}
