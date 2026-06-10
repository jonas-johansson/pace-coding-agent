export type BlockRole = "user" | "assistant" | "reasoning" | "tool" | "error";

export type BlockTheme = {
  fg: number;
  bg: number;
  accent: number;
  bold: number;
};

export type TuiTheme = {
  name: string;
  blocks: Record<BlockRole, BlockTheme> & { inlineTool: BlockTheme };
  canvas: { bg: number; panelBg: number };
  overlay: { bg: number; chromeBg: number; selBg: number; fg: number; dimFg: number; brightFg: number };
  suggestion: { bg: number };
  status: {
    bg: number;
    fg: number;
    runningFg: number;
    contextFg: number;
    contextWarnFg: number;
    costFg: number;
    modelFg: number;
  };
  input: { bg: number; bashBg: number; fg: number; bashFg: number };
  glyphs: { done: { glyph: string; color: number }; error: { glyph: string; color: number } };
  logoColor: number;
  shikiTheme: string;
};

export const BUILT_IN_THEMES: Record<string, TuiTheme> = {
  dark: {
    name: "dark",
    blocks: {
      user: { fg: 231, bg: 24, accent: 117, bold: 230 },
      assistant: { fg: 255, bg: 234, accent: 221, bold: 215 },
      reasoning: { fg: 245, bg: 234, accent: 179, bold: 179 },
      tool: { fg: 252, bg: 235, accent: 117, bold: 230 },
      error: { fg: 231, bg: 88, accent: 217, bold: 223 },
      inlineTool: { fg: 245, bg: 234, accent: 117, bold: 230 },
    },
    canvas: { bg: 234, panelBg: 235 },
    overlay: { bg: 235, chromeBg: 237, selBg: 238, fg: 245, dimFg: 244, brightFg: 252 },
    suggestion: { bg: 235 },
    status: { bg: 235, fg: 250, runningFg: 229, contextFg: 245, contextWarnFg: 217, costFg: 187, modelFg: 109 },
    input: { bg: 236, bashBg: 237, fg: 252, bashFg: 179 },
    glyphs: { done: { glyph: "✓", color: 151 }, error: { glyph: "✗", color: 217 } },
    logoColor: 117,
    shikiTheme: "dark-plus",
  },
  light: {
    name: "light",
    blocks: {
      user: { fg: 16, bg: 153, accent: 31, bold: 24 },
      assistant: { fg: 16, bg: 255, accent: 130, bold: 166 },
      reasoning: { fg: 238, bg: 255, accent: 136, bold: 136 },
      tool: { fg: 238, bg: 253, accent: 31, bold: 24 },
      error: { fg: 231, bg: 160, accent: 203, bold: 209 },
      inlineTool: { fg: 238, bg: 255, accent: 31, bold: 24 },
    },
    canvas: { bg: 255, panelBg: 253 },
    overlay: { bg: 253, chromeBg: 251, selBg: 254, fg: 240, dimFg: 244, brightFg: 236 },
    suggestion: { bg: 253 },
    status: { bg: 253, fg: 238, runningFg: 28, contextFg: 240, contextWarnFg: 160, costFg: 28, modelFg: 31 },
    input: { bg: 254, bashBg: 251, fg: 238, bashFg: 130 },
    glyphs: { done: { glyph: "✓", color: 28 }, error: { glyph: "✗", color: 160 } },
    logoColor: 31,
    shikiTheme: "light-plus",
  },
};

/**
 * Resolve a theme name to a TuiTheme. Falls back to the dark theme when the
 * name is not recognised.
 */
export function resolveTheme(name: string): TuiTheme {
  return BUILT_IN_THEMES[name] ?? BUILT_IN_THEMES.dark;
}
