# Plan: Theme System for Pace (Omarchy-Style Integration)

**Goal:** Give Pace a configurable, hot-reloadable theme system that can be driven externally — similar to how Omarchy switches OpenCode's theme via `SIGUSR2`.

**Current State:**
- TUI colors are hardcoded ANSI 256 indices (e.g. `user: { fg: 231, bg: 24, accent: 117, bold: 230 }`)
- Shiki syntax highlighter uses hardcoded `THEME = "dark-plus"`
- Config is loaded once at startup; no reload mechanism exists
- No concept of "theme" in `~/.config/pace/config.json`

**Target State:**
- `theme` field in `~/.config/pace/config.json` ( `"system"`, `"dark"`, `"light"`, or `"<custom-name>"` )
- Built-in dark / light themes that replace hardcoded values
- Custom themes loadable from `~/.config/pace/themes/<name>.json`
- `SIGUSR2` handler re-reads config, swaps theme, invalidates render cache, and re-renders without restart
- `/theme` slash command to switch interactively
- Omarchy can drive Pace the same way it drives OpenCode: update config + `killall -SIGUSR2 pace`

---

## 1. Theme Configuration & Schema

### 1.1 Extend `PaceConfig` in `src/config.ts`

```ts
export type ThemeConfig = {
  name: string;                    // "system" | "dark" | "light" | "tokyo-night" | ...
  shikiTheme?: string;             // optional Shiki theme override
};

export type PaceConfig = {
  cost: CostDisplayConfig;
  defaultModel?: string;
  cycleModels?: string[];
  sessionTitleModel?: string;
  theme?: ThemeConfig;             // NEW
};
```

### 1.2 Default

```ts
export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  name: "system",
};
```

### 1.3 Validation

Add `themeConfigSchema` to Zod schema with `.optional()` and `.default()`.

---

## 2. Theme Definition Format

### 2.1 Built-in Themes (embedded in `src/themes.ts`)

```ts
export type ColorDef =
  | number       // ANSI 256 index (0-255)
  | "none"       // inherit terminal default
  | { dark: number; light: number };  // auto-switching

export type TuiTheme = {
  name: string;
  blocks: Record<BlockRole, BlockTheme>;
  canvas: { bg: number; panelBg: number };
  overlay: { bg: number; chromeBg: number; selBg: number };
  suggestion: { bg: number };
  glyphs: { done: { glyph: string; color: number }; error: { glyph: string; color: number } };
  shikiTheme: string;   // e.g. "dark-plus", "light-plus", "github-light"
};
```

Two built-in themes:
- `"dark"` — maps exactly to today's hardcoded values
- `"light"` — light-background variants (e.g. `user.bg: 153`, `assistant.bg: 255`, `canvas.bg: 255`, etc.)

### 2.2 Custom Theme Files

User-defined themes live at `~/.config/pace/themes/<name>.json`:

```json
{
  "$schema": "https://pace.dev/theme.json",
  "name": "catppuccin-mocha",
  "extends": "dark",
  "blocks": {
    "user": { "fg": 231, "bg": 24, "accent": 117, "bold": 230 }
  },
  "canvas": { "bg": 234, "panelBg": 235 },
  "overlay": { "bg": 235, "chromeBg": 237, "selBg": 238 },
  "suggestion": { "bg": 235 },
  "glyphs": {
    "done": { "glyph": "✓", "color": 151 },
    "error": { "glyph": "✗", "color": 217 }
  },
  "shikiTheme": "dark-plus"
}
```

`extends` allows overriding a subset of a built-in theme.

### 2.3 Theme Loader (`src/themes.ts`)

```ts
export async function loadTheme(config: ThemeConfig): Promise<TuiTheme> {
  if (config.name === "system") {
    return await resolveSystemTheme();
  }
  // 1. Check ~/.config/pace/themes/<name>.json
  // 2. Fall back to built-in
  // 3. Fall back to "dark" if missing
}
```

---

## 3. "System" Theme — Terminal Auto-Detection

### 3.1 Strategy (same as OpenCode)

OpenCode's `system` theme detects the terminal background and adapts. Pace should do the same.

**Detection heuristics (in order of reliability):**

1. **`COLORFGBG` env var** — many terminals set this (e.g. `15;0` means white fg, black bg). If bg > 7, assume dark.
2. **`TERM_BACKGROUND` / `TERMBG` env vars** — some terminals export this.
3. **`COLORTERM` + terminal emulator detection** — if `COLORTERM=truecolor` and we know the emulator (via `TERM_PROGRAM` or `TERM`), we can query.
4. **OSC 11 query** — send `\x1b]11;?\x07` to stdout and read the response from stdin. This is the most accurate but requires temporarily intercepting stdin during startup (before the TUI takes over raw mode).

### 3.2 Implementation

```ts
async function resolveSystemTheme(): Promise<TuiTheme> {
  const isDark = await detectTerminalBackground();
  return isDark ? BUILT_IN_THEMES.dark : BUILT_IN_THEMES.light;
}
```

**OSC 11 approach for startup:**
- In `main()`, before `tui.start()`, send the OSC query and wait up to 100ms for a response on stdin (using `readFile` with `fs` on stdin fd, or `process.stdin.once('data', ...)`).
- Parse the response: `\x1b]11;rgb:<rr>/<gg>/<bb>\x1b\\` or `\x07`-terminated variant.
- Calculate luminance: `Y = 0.299*R + 0.587*G + 0.114*B`. If Y < 128, dark; else light.
- If no response in time, default to dark.

**Note:** Once `tui.start()` calls `setRawMode(true)`, OSC responses arrive as raw data in the TUI's `handleData` path. We can ignore them there (they start with `\x1b]11;`) or use them for mid-session re-detection.

---

## 4. TUI Integration

### 4.1 Make Colors Dynamic

In `src/tui.ts`, replace the module-level `const themes` with a mutable reference:

```ts
// Before:
const themes: Record<BlockRole, BlockTheme> = { ... };

// After:
let currentTheme: TuiTheme = BUILT_IN_THEMES.dark;

export function setTuiTheme(theme: TuiTheme) {
  currentTheme = theme;
}
```

All internal references to `themes[role]` become `currentTheme.blocks[role]`.

Same for `CANVAS_BG`, `PANEL_BG`, `OVERLAY_BG`, etc. — they become `currentTheme.canvas.bg`, etc.

### 4.2 Render Cache Invalidation

When `setTuiTheme()` is called, clear the block render cache so every block re-renders with new colors:

```ts
export function setTuiTheme(theme: TuiTheme, tuiInstance?: Tui) {
  currentTheme = theme;
  if (tuiInstance) {
    tuiInstance.invalidateRenderCache();
  }
}
```

Add `invalidateRenderCache()` method to `Tui` class:

```ts
invalidateRenderCache() {
  this.blockRenderCache.clear();
  this.previousFrameLines = [];
  this.previousRawLines = [];
  this.requestRender();
}
```

### 4.3 Shiki Theme Swap

In `src/syntax.ts`, replace `const THEME = "dark-plus"` with a mutable variable and export a setter:

```ts
let currentShikiTheme = "dark-plus";

export function setShikiTheme(themeName: string) {
  currentShikiTheme = themeName;
  // If Shiki is already loaded, we need to re-initialize with the new theme.
  // Shiki's createHighlighterCoreSync is immutable per-instance, so we have
  // two options:
  //   A) Re-create the highlighter (async, non-blocking)
  //   B) Just record the new theme and let new code blocks use it
  // Option B is fine: clear cache, re-init in background.
  shiki = null; // force re-init on next tokenize
  initHighlighter().catch(() => {});
}
```

Actually, Shiki v1 supports multiple themes per highlighter. Better approach:

```ts
// Load both dark and light themes at init, or lazy-load on theme switch.
export async function setShikiTheme(themeName: string) {
  if (!shiki) return; // not ready yet
  if (shiki.getLoadedThemes().includes(themeName)) return;
  
  const { bundledThemes } = await import("shiki");
  const mod = await bundledThemes[themeName]();
  shiki.loadTheme(mod.default);
  currentShikiTheme = themeName;
}
```

Then `tokenizeWithShiki` uses `currentShikiTheme`.

---

## 5. Hot-Reload via SIGUSR2

### 5.1 Signal Handler in `src/app.ts`

After `tui.start()` in `main()`, register:

```ts
process.on("SIGUSR2", async () => {
  try {
    const newConfig = await loadPaceConfig();
    const newTheme = await loadTheme(newConfig.theme ?? DEFAULT_THEME_CONFIG);
    
    setTuiTheme(newTheme, tui);
    setShikiTheme(newTheme.shikiTheme);
    
    tui.setStatus(`Theme reloaded: ${newTheme.name}`);
  } catch (error) {
    tui.setStatus(`Theme reload failed: ${formatError(error)}`);
  }
});
```

### 5.2 Why SIGUSR2?

This mirrors OpenCode's convention and Omarchy's existing `omarchy-restart-opencode` script. Omarchy can then add:

```bash
# omarchy-restart-pace
if pgrep -x pace >/dev/null; then
    killall -SIGUSR2 pace
fi
```

And call it from `omarchy-theme-set` alongside `omarchy-restart-opencode`.

---

## 6. `/theme` Slash Command

Add to the slash commands list in `src/app.ts`:

```ts
{ label: "/theme", detail: "Show or switch theme", kind: "command", insertText: "/theme " },
```

Handle in `handleUserInput` (or wherever slash commands are parsed):

```ts
if (input === "/theme" || input === "/themes") {
  listThemes();  // show available themes in a block
  return;
}
if (input.startsWith("/theme ")) {
  const themeName = input.slice(7).trim();
  await switchTheme(themeName);
  return;
}
```

`switchTheme`:
1. Loads the theme definition
2. Calls `setTuiTheme(theme, tui)` + `setShikiTheme(theme.shikiTheme)`
3. Optionally persists to `~/.config/pace/config.json` (or just `preferences.json`)

---

## 7. Omarchy Integration Script

Create a standalone script that Omarchy can ship or the user can add:

```bash
#!/bin/bash
# ~/.local/bin/omarchy-restart-pace
# omarchy:summary=Reload Pace configuration (used by the Omarchy theme switching).

if pgrep -x pace >/dev/null; then
  killall -SIGUSR2 pace
fi
```

And add to `omarchy-theme-set` (or a user hook):

```bash
# In ~/.config/omarchy/hooks/theme-set.d/pace-theme
#!/bin/bash
THEME_NAME=$1

# Map Omarchy theme names to Pace theme names
# (optional — if Pace has matching custom themes)
case "$THEME_NAME" in
  catppuccin|catppuccin-latte) PACE_THEME="catppuccin" ;;
  tokyo-night) PACE_THEME="tokyonight" ;;
  everforest) PACE_THEME="everforest" ;;
  *) PACE_THEME="system" ;;
esac

# Update Pace config
mkdir -p ~/.config/pace
if [[ -f ~/.config/pace/config.json ]]; then
  jq --arg theme "$PACE_THEME" '.theme = {name: $theme}' ~/.config/pace/config.json > ~/.config/pace/config.json.tmp
  mv ~/.config/pace/config.json.tmp ~/.config/pace/config.json
else
  echo '{"theme":{"name":"'$PACE_THEME'"}}' > ~/.config/pace/config.json
fi

# Signal running Pace instances
if pgrep -x pace >/dev/null; then
  killall -SIGUSR2 pace
fi
```

---

## 8. Files to Modify

| File | Changes |
|------|---------|
| `src/config.ts` | Add `ThemeConfig` type, schema, default |
| `src/themes.ts` | **New file** — theme loader, built-in themes, system detection, custom theme file reader |
| `src/tui.ts` | Replace hardcoded colors with `currentTheme` reference; add `setTuiTheme()` and `invalidateRenderCache()` |
| `src/syntax.ts` | Replace `const THEME` with mutable `currentShikiTheme`; add `setShikiTheme()`; support theme loading |
| `src/app.ts` | Load theme at startup; add SIGUSR2 handler; add `/theme` slash command handler |
| `src/events.ts` | Optional: add `"theme-reloaded"` event type |

---

## 9. Implementation Order (Phases)

### Phase 1: Core Theme Infrastructure
1. Create `src/themes.ts` with `TuiTheme` type, built-in dark/light themes, and `loadTheme()`
2. Refactor `src/tui.ts` to use `currentTheme` instead of hardcoded constants
3. Refactor `src/syntax.ts` to support `setShikiTheme()`

### Phase 2: Config & Startup
4. Add `theme` to `PaceConfig` in `src/config.ts`
5. In `src/app.ts` `main()`, load and apply theme before first render

### Phase 3: Hot-Reload
6. Add `SIGUSR2` handler in `src/app.ts`
7. Add `invalidateRenderCache()` to `Tui`

### Phase 4: User Commands
8. Add `/theme` and `/themes` slash commands
9. Add `switchTheme()` function that updates runtime + optionally persists

### Phase 5: System Auto-Detection
10. Implement `detectTerminalBackground()` with `COLORFGBG` + OSC 11 fallback
11. Make `"system"` theme resolve to dark/light based on detection

### Phase 6: Omarchy Integration
12. Document the hook script for `~/.config/omarchy/hooks/theme-set.d/`
13. Test end-to-end: `omarchy theme set "tokyo-night"` → Pace updates live

---

## 10. Open Questions / Decisions

1. **Should theme changes persist to `config.json` or `preferences.json`?**
   - *Recommendation:* Use `preferences.json` for runtime-switchable state (like model cycling), but since theme is more "config-like", either works. `config.json` is fine if we don't rewrite it frequently.

2. **Should we support truecolor (24-bit RGB) in theme definitions?**
   - *Recommendation:* Start with ANSI 256 only (matches current architecture). Truecolor can be added later by extending `ColorDef` to support `"#rrggbb"` strings and emitting `\x1b[38;2;R;G;Bm` sequences.

3. **What Shiki themes should be bundled?**
   - *Recommendation:* Start with the built-in Shiki themes that have dark/light pairs: `dark-plus` / `light-plus`, `github-dark` / `github-light`, `nord`, `tokyo-night`. The highlighter loads them lazily.

4. **Should the TUI cache invalidation be more granular?**
   - *Recommendation:* Full cache clear is fine. Theme changes are rare events; the cost of re-rendering all blocks is negligible compared to the user benefit.

---

## 11. Acceptance Criteria

- [ ] `~/.config/pace/config.json` accepts `"theme": { "name": "light" }` and Pace renders with light colors on next start
- [ ] Running `killall -SIGUSR2 pace` while Pace is open immediately switches colors without restart
- [ ] `/theme light` inside Pace switches the theme and re-renders
- [ ] `/theme system` detects the terminal background and picks dark or light
- [ ] Custom theme files in `~/.config/pace/themes/` can override any color
- [ ] Shiki syntax highlighting theme changes alongside the TUI theme
- [ ] Omarchy hook can drive Pace theme changes the same way it drives OpenCode
