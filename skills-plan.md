# Feature plan: Skills support

## Research summary

### The Agent Skills specification

There is a shared open standard called **Agent Skills** ([agentskills/agentskills](https://github.com/agentskills/agentskills)) that defines a common format adopted by nearly every coding agent. It specifies:

- **Structure**: A skill is a directory containing a `SKILL.md` file plus optional `scripts/`, `references/`, and `assets/` subdirectories.
- **Frontmatter** (YAML between `---` markers):
  - `name` (required): 1–64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens, must match directory name.
  - `description` (required): 1–1024 chars. Describes what the skill does and when to use it. Critical for agent discovery.
  - `license` (optional): License identifier.
  - `compatibility` (optional): Max 500 chars, environment requirements.
  - `metadata` (optional): Arbitrary string→string map.
  - `allowed-tools` (optional, experimental): Space-separated tool whitelist.
- **Progressive disclosure**: Only names+descriptions are loaded at startup (~100 tokens each). Full `SKILL.md` body is loaded on activation. Supporting files (`references/`, `scripts/`) are loaded only when needed by the agent via `read`.
- **Body**: Markdown instructions after frontmatter, recommended <500 lines.

### How Claude Code handles skills

Claude Code has the most mature implementation:

- **Locations**: `.claude/skills/*/SKILL.md` (project), `~/.claude/skills/*/SKILL.md` (user/global). Also supports legacy `.claude/commands/*.md` flat format.
- **Invocation**: Dual-mode. Users can type `/skill-name` to invoke explicitly. The model can also invoke skills automatically via a `SkillTool` when it determines a skill is relevant, based on description matching.
- **Frontmatter extensions** (beyond the base spec):
  - `disable-model-invocation: true` — prevents the model from auto-loading the skill; user must type `/skill-name`.
  - `user-invocable: false` — hides from `/` menu; only model can trigger it.
  - `allowed-tools` — restricts which tools the skill can use.
  - `argument-hint` — placeholder text shown in the `/` menu.
  - `when_to_use` — extra natural-language hint for model discovery.
  - `context: fork` — runs skill in an isolated conversation thread.
  - `agent` — routes to a specific named agent.
  - `paths` — gitignore-style patterns; skill only activates for matching files.
  - `hooks` — scoped hook configuration.
  - `$ARGUMENTS` — template variable capturing user input after the command name.
- **Bundled skills**: `/simplify`, `/batch`, `/debug`, `/loop`, `/claude-api` — prompt-based skills that ship with every session.
- **Plugin system**: Plugins bundle skills under a namespace (`/plugin-name:skill-name`), distributed via `.claude-plugin/plugin.json`.
- **`/skills` command**: Interactive skill browser with token count display and hide/show toggle.
- **Context strategy**: Skill names+descriptions are in every request. Full content loads only when invoked or auto-loaded.

### How OpenCode handles skills

OpenCode follows the Agent Skills spec closely but with a more minimalist, tool-driven approach:

- **Locations** (searches many paths for compatibility):
  - `.opencode/skills/*/SKILL.md` (project)
  - `~/.config/opencode/skills/*/SKILL.md` (global)
  - `.claude/skills/*/SKILL.md` (Claude-compatible, project)
  - `~/.claude/skills/*/SKILL.md` (Claude-compatible, global)
  - `.agents/skills/*/SKILL.md` (generic standard, project)
  - `~/.agents/skills/*/SKILL.md` (generic standard, global)
- **Discovery**: Walks up from cwd to git worktree root, scanning each directory.
- **Frontmatter**: Only `name` (required), `description` (required), `license`, `compatibility`, `metadata`. Unknown fields are silently ignored.
- **Loading mechanism**: Skills are exposed to the model via a native `skill` tool. The model calls `skill({ name: "git-release" })` to load a skill's full content. Descriptions are listed in the tool's description text.
- **Permissions**: Granular pattern-based permissions in `opencode.json` — `allow`, `deny`, `ask` per skill pattern (e.g. `"internal-*": "deny"`). Can be overridden per-agent.
- **No user invocation**: OpenCode does not have `/skill-name` slash commands for skills. The model decides when to use them.

### How Pi handles skills

Pi (by Mario Zechner) takes the most extensible approach:

- **Locations**:
  - `~/.pi/agent/skills/` and `~/.agents/skills/` (global)
  - `.pi/skills/` and `.agents/skills/` (project, walks up to git root)
  - Pi packages (`skills/` in npm packages or `pi.skills` in `package.json`)
  - CLI: `--skill <path>` (additive, works even with `--no-skills`)
  - Settings: `skills` array
- **Format**: Follows the Agent Skills spec. Also supports flat `.md` files as individual skills in `~/.pi/agent/skills/` and `.pi/skills/`.
- **Progressive disclosure**: Names+descriptions go into the system prompt in XML format. The model uses `read` to load full `SKILL.md` on demand.
- **Skill commands**: Skills register as `/skill:name` commands for explicit invocation.
- **Packages**: Skills can be bundled into npm packages alongside extensions, prompts, and themes. Installed via `pi install npm:package-name`.
- **Extensions**: Pi has a full TypeScript extension system. Skills can be combined with custom tools, hooks, and TUI extensions.
- **`disable-model-invocation`**: Supported. When true, skill is hidden from system prompt and only available via `/skill:name`.
- **Validation**: Warns on spec violations but still loads the skill (lenient).

### The skills.sh / `npx skills` ecosystem

[skills.sh](https://skills.sh) is an open skills directory and CLI by Vercel Labs ([vercel-labs/skills](https://github.com/vercel-labs/skills)):

- **Scale**: 90,000+ public skills indexed from GitHub repositories.
- **CLI commands**:
  - `npx skills add <owner/repo>` — install skills from a GitHub repo
  - `npx skills list` — list installed skills
  - `npx skills find [query]` — interactive search
  - `npx skills remove [skills]` — uninstall
  - `npx skills update [skills]` — update to latest
  - `npx skills init [name]` — scaffold a new SKILL.md
- **Installation options**:
  - `-g, --global` — install to user/global directory
  - `-a, --agent <agent>` — target specific agent(s)
  - `-s, --skill <name>` — install specific skills from a repo
  - `--copy` — copy files instead of symlinking
  - `-y, --yes` / `--all` — skip prompts
- **Multi-agent support**: 55+ agents supported. Each has a configured project path and global path:
  - Claude Code: `.claude/skills/` / `~/.claude/skills/`
  - OpenCode: `.agents/skills/` / `~/.config/opencode/skills/`
  - Codex: `.agents/skills/` / `~/.codex/skills/`
  - Pi: `.pi/skills/` / `~/.pi/agent/skills/`
  - Generic/Universal: `.agents/skills/` / `~/.config/agents/skills/`
- **Skill discovery in repos**: Searches `skills/`, `skills/.curated/`, `skills/.experimental/`, `.claude/skills/`, `.agents/skills/`, root `SKILL.md`, and falls back to recursive search.
- **Also**: SkillsGate (desktop/TUI app), agentskill.sh (alternative CLI with `/learn` command), agent-skills-cli — all part of the growing ecosystem.

### Key insight: directory format is the standard

Every agent uses `<dir>/SKILL.md` as the canonical format. The directory name equals the skill name. This is the format we should adopt for compatibility with the entire ecosystem.

---

## Design for Agento

### Goals

1. **Spec-compliant**: Follow the Agent Skills specification for file format and directory structure.
2. **Ecosystem-compatible**: Use the `.agents/skills/` convention so `npx skills add -a universal` works out of the box.
3. **Progressive disclosure**: Only inject skill names+descriptions into the system prompt. Load full content via a `skill` tool.
4. **Slash command invocation**: Support `/skill:name` for explicit invocation.
5. **Simple**: Start with the core — no plugins, no permissions, no sub-agents. Ship the 80% case.

### Skill file format

Follow the Agent Skills spec exactly. Each skill is a directory with a `SKILL.md`:

```
my-skill/
├── SKILL.md              # Required: YAML frontmatter + markdown instructions
├── scripts/              # Optional
├── references/           # Optional
└── assets/               # Optional
```

Frontmatter fields we parse:
- `name` (required) — validated against spec rules
- `description` (required) — validated 1–1024 chars
- `disable-model-invocation` (optional) — if `true`, skill is hidden from the model's skill listing and can only be invoked via `/skill:name`

All other frontmatter fields are silently ignored (forward compatibility).

### Skill directories

We lean on the generic `.agents/` convention, which is the universal standard used by Amp, Codex, Cursor, OpenCode, and many others. No Agento-specific paths.

| Scope | Path | Notes |
|-------|------|-------|
| Project | `.agents/skills/*/SKILL.md` | Generic standard, checked into repo |
| Global | `~/.agents/skills/*/SKILL.md` | Used by Cline, Warp, and many `npx skills` installs |
| Global | `~/.config/agents/skills/*/SKILL.md` | Universal convention |

For project paths, we scan only from cwd (no walking up to git root in v1 — keeps it simple).

**Precedence**: When the same skill name appears in multiple locations, the first match wins in scan order: project → `~/.agents/` → `~/.config/agents/`.

### `npx skills` integration

Since we use the `.agents/skills/` convention, `npx skills` already works out of the box:

```bash
npx skills add -a universal <owner/repo>        # project: .agents/skills/
npx skills add -a universal -g <owner/repo>     # global: ~/.config/agents/skills/
```

No registration PR needed. The `universal` agent target maps directly to our paths.

### System prompt integration (progressive disclosure)

Skills are **not** injected as full text into the system prompt. Instead:

1. **At prompt time**, we collect all discovered skills and build an `<available_skills>` XML block listing just names and descriptions (~100 tokens per skill). This goes into the system prompt.
2. **The model uses the `skill` tool** to load a skill's full content when it decides one is relevant.
3. **`/skill:name` invocation** by the user injects the skill's full content as a user message, bypassing the tool.

Skills with `disable-model-invocation: true` are excluded from the `<available_skills>` listing.

System prompt structure:
```
[Base system prompt]

---

<available_skills>
<skill name="git-release">Create consistent releases and changelogs</skill>
<skill name="code-review">Review code for best practices</skill>
</available_skills>

---

# Project-specific instructions (from AGENTS.md)
[AGENTS.md content]
```

### The `skill` tool

A new tool added to `tool.ts`:

```typescript
const skillTool = Tool({
  name: "skill",
  description: `Load a skill's full instructions by name. Available skills:\n${skillListing}`,
  concurrency: "safe",
  inputSchema: z.object({
    name: z.string().describe("The skill name to load"),
  }),
  execute: async (input) => {
    const skill = findSkill(input.name);
    if (!skill) return { content: [{ type: "text", text: `Unknown skill: ${input.name}` }], is_error: true };
    const content = await readFile(skill.filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  },
});
```

The tool description dynamically includes the skill listing so the model can see what's available even without the system prompt block.

### User interface

#### Slash commands

| Command | Description |
|---------|-------------|
| `/skills` | List all discovered skills with source and description |
| `/skill:name` | Invoke a skill explicitly — injects its full content as a user message |
| `/skill:name <args>` | Invoke with arguments — `$ARGUMENTS` in the skill content is replaced |

#### `/skills` output

```
Project skills (.agents/skills/):
  git-release — Create consistent releases and changelogs
  code-review — Review code for best practices
  deploy — Deploy application to staging

Global skills (~/.config/agents/skills/):
  typescript-style — TypeScript style guide
```

#### Status bar

When skills are available, show count in the status bar:

```
skills: 4 | claude-sonnet-4-6 | 45K/1M tokens | $0.12
```

### Implementation plan

#### Step 1: Add `skill.ts` module

New file handling discovery, parsing, and state.

```typescript
// skill.ts — public API

export type Skill = {
  name: string;
  description: string;
  filePath: string;       // Path to SKILL.md
  baseDir: string;        // Skill directory
  source: "project" | "global";
  disableModelInvocation: boolean;
};

/** Discover all skills from known directories. */
export async function discoverSkills(): Promise<Skill[]>;

/** Get skills available to the model (excludes disable-model-invocation). */
export function getModelVisibleSkills(skills: Skill[]): Skill[];

/** Build the <available_skills> XML block for the system prompt. */
export function formatSkillsSystemPromptBlock(skills: Skill[]): string;

/** Find a skill by name. */
export function findSkill(skills: Skill[], name: string): Skill | undefined;

/** Read the full content of a skill's SKILL.md. */
export async function loadSkillContent(skill: Skill): Promise<string>;
```

Key implementation details:
- Parse YAML frontmatter manually (split on `---` delimiters, parse as YAML). We can use a simple regex-based parser to avoid adding a dependency, or add `yaml` as a dependency.
- Validate `name` against the spec regex: `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` and no `--`.
- Validate `name` matches directory name.
- Validate `description` is 1–1024 chars.
- Log warnings for invalid skills but skip them silently.

#### Step 2: Add `skill` tool to `tool.ts`

Register a new `skill` tool that loads skill content on demand. The tool description is dynamically generated to include the skill listing.

Since the skill listing can change (if the user changes cwd), we regenerate the tool definitions on each prompt call.

#### Step 3: Modify system prompt assembly (`app.ts`)

In the `prompt()` function:
1. Call `discoverSkills()` to get all available skills.
2. Build the `<available_skills>` block via `formatSkillsSystemPromptBlock()`.
3. Insert between base system prompt and AGENTS.md content.
4. Pass the skills to the `skill` tool so it can resolve names.

#### Step 4: Add `/skills` and `/skill:*` commands (`app.ts`)

Extend `handleCommand()`:
- `/skills` — discover and display all skills grouped by source.
- Commands starting with `/skill:` — extract the skill name, find it, read its content, and inject as a user message preceding the prompt.

For `/skill:name <args>`, replace `$ARGUMENTS` in the skill content with the provided arguments.

#### Step 5: Add skill count to status bar (`tui.ts`)

Add `skillCount` state and `setSkillCount()` method on Tui. Display in `renderStatusLine()` when count > 0.

#### Step 6: Update build configuration

- Add `skill.ts` to `tsconfig.json` `include` array.
- If we use a YAML parsing dependency, add it to `package.json`.

### File changes summary

| File | Change |
|------|--------|
| `skill.ts` | **New.** Skill discovery, frontmatter parsing, formatting. |
| `tool.ts` | Add `skill` tool for on-demand content loading. |
| `app.ts` | Import skill module. Modify system prompt. Add `/skills` and `/skill:*` commands. Update status bar. |
| `tui.ts` | Add `skillCount` + `setSkillCount()`, render in status bar. |
| `tsconfig.json` | Add `skill.ts` to `include`. |

### YAML parsing approach

The frontmatter is simple key-value YAML. Options:

1. **Regex-based**: Parse `---`-delimited frontmatter, extract `name:`, `description:`, `disable-model-invocation:` with simple regex. No dependency needed. Sufficient for the fields we care about.
2. **`yaml` npm package**: Full YAML parsing. Handles edge cases (multi-line descriptions, quoting). Adds a dependency.

**Recommendation**: Use a lightweight approach — split on `---`, then use a simple line-by-line parser for the flat key-value fields we need. If a field spans multiple lines (description with `>` or `|`), fall back gracefully. This avoids a new dependency and is sufficient for the spec's simple frontmatter.

---

## Non-goals (for v1)

- **Permissions system**: No allow/deny/ask per skill. All discovered skills are available.
- **Plugin system**: No namespaced plugin skills.
- **Sub-agents**: No running skills in forked contexts.
- **`allowed-tools` enforcement**: Parse but ignore.
- **Walking up to git root**: Scan only cwd for project skills.
- **Bundled skills**: No built-in skills shipped with Agento.
- **Persistent activation state**: Skills are discovered fresh each prompt.
- **Skill creation wizard**: No `/skill init` command.

## Future work (v2+)

- Walk up to git root for project skill discovery (matching OpenCode/Pi behavior).
- Support `.claude/skills/` paths for Claude Code compatibility.
- Bundled skills (e.g. `/simplify`, `/debug`).
- Skill permissions in a config file.
- `$ARGUMENTS` and named argument support.
