import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

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

import { type ThemeConfig, DEFAULT_THEME_CONFIG } from "./config.js";

export { DEFAULT_THEME_CONFIG };

const THEME_DIR = join(homedir(), ".config", "pace", "themes");

export async function loadTheme(config: ThemeConfig): Promise<TuiTheme> {
  let theme: TuiTheme;

  if (config.name === "system") {
    const isDark = await detectTerminalBackground();
    theme = isDark ? BUILT_IN_THEMES.dark : BUILT_IN_THEMES.light;
  } else {
    // 1. Check custom theme files
    const customPath = join(THEME_DIR, `${config.name}.json`);
    try {
      const raw = await readFile(customPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const base =
        typeof parsed.extends === "string"
          ? (BUILT_IN_THEMES[parsed.extends] ?? BUILT_IN_THEMES.dark)
          : BUILT_IN_THEMES.dark;
      theme = mergeTheme(base, parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code: string }).code === "ENOENT") {
        // Custom theme not found — fall through to built-in
        theme = BUILT_IN_THEMES[config.name] ?? BUILT_IN_THEMES.dark;
      } else {
        throw error;
      }
    }
  }

  // Apply optional Shiki theme override from config
  if (config.shikiTheme) {
    theme = JSON.parse(JSON.stringify(theme)) as TuiTheme;
    theme.shikiTheme = config.shikiTheme;
  }

  return theme;
}

function mergeTheme(base: TuiTheme, override: Record<string, unknown>): TuiTheme {
  const result = JSON.parse(JSON.stringify(base)) as TuiTheme;
  result.name = (override.name as string) ?? result.name;

  if (override.blocks) {
    for (const [role, block] of Object.entries(
      (override.blocks as Record<string, Partial<BlockTheme>>) ?? {},
    )) {
      if (result.blocks[role as BlockRole]) {
        Object.assign(result.blocks[role as BlockRole], block);
      }
      if (role === "inlineTool" && result.blocks.inlineTool) {
        Object.assign(result.blocks.inlineTool, block);
      }
    }
  }

  if (override.canvas) Object.assign(result.canvas, override.canvas as Record<string, unknown>);
  if (override.overlay) Object.assign(result.overlay, override.overlay as Record<string, unknown>);
  if (override.suggestion)
    Object.assign(result.suggestion, override.suggestion as Record<string, unknown>);
  if (override.status) Object.assign(result.status, override.status as Record<string, unknown>);
  if (override.input) Object.assign(result.input, override.input as Record<string, unknown>);
  if (override.glyphs) {
    const glyphs = override.glyphs as Record<string, Record<string, unknown>>;
    if (glyphs.done) Object.assign(result.glyphs.done, glyphs.done);
    if (glyphs.error) Object.assign(result.glyphs.error, glyphs.error);
  }
  if (override.logoColor !== undefined) result.logoColor = override.logoColor as number;
  if (override.shikiTheme !== undefined) result.shikiTheme = override.shikiTheme as string;

  return result;
}

async function detectTerminalBackground(): Promise<boolean> {
  // 1. COLORFGBG env var
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(";");
    const bg = parseInt(parts[parts.length - 1] ?? "", 10);
    if (!Number.isNaN(bg)) {
      return bg <= 7;
    }
  }

  // 2. TERM_BACKGROUND / TERMBG env vars
  const termBg = process.env.TERM_BACKGROUND ?? process.env.TERMBG;
  if (termBg) {
    const bg = parseInt(termBg, 10);
    if (!Number.isNaN(bg)) {
      return bg <= 7;
    }
  }

  // 3. Try OSC 11 query if stdin is a TTY
  const oscResult = await detectTerminalBackgroundOsc();
  if (oscResult !== undefined) {
    return oscResult;
  }

  // 4. Default to dark
  return true;
}

function detectTerminalBackgroundOsc(): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, 100);

    const handler = (data: Buffer) => {
      const str = data.toString();
      // Match OSC 11 response: \x1b]11;rgb:<rr>/<gg>/<bb>\x1b\\ or \x07-terminated
      const match =
        /\x1b\]11;rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/.exec(str);
      if (match) {
        cleanup();
        const r = parseInt(match[1].slice(0, 2), 16);
        const g = parseInt(match[2].slice(0, 2), 16);
        const b = parseInt(match[3].slice(0, 2), 16);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        resolve(luminance < 128);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.off("data", handler);
    };

    process.stdin.on("data", handler);
    process.stdout.write("\x1b]11;?\x07");
  });
}
