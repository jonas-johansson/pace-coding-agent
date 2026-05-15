# Plan: Add MCP Support and Test with Linear MCP

## Goal
Add Model Context Protocol (MCP) client support to Agento so it can discover and invoke tools from external MCP servers. Test the feature end-to-end with a real Linear MCP server.

---

## Phase 1: Create MCP Client Module (`mcp.ts`)

### 1.1 Define configuration types
- `McpServerConfig`: base with `enabled?: boolean`, `timeout?: number`
- `McpLocalConfig extends McpServerConfig`: `type: "local"`, `command: string[]`, `environment?: Record<string, string>`
- `McpRemoteConfig extends McpServerConfig`: `type: "remote"`, `url: string`, `headers?: Record<string, string>`
- `McpConfig`: `Record<string, McpLocalConfig | McpRemoteConfig>`

### 1.2 Configuration loading
- Load from `~/.config/agento/mcp.json` (or similar global config path).
- Gracefully handle missing config (no MCP servers).
- Validate JSON shape at runtime with Zod.

### 1.3 JSON-RPC 2.0 helpers
- `jsonRpcRequest(id, method, params)` → JSON string.
- `parseJsonRpcResponse(text)` → validated result or throws on error.
- The Exa `web_search` tool already does this — extract/generalise the pattern.

### 1.4 Stdio transport (`McpStdioTransport`)
- Spawn the process from `command` + optional `environment`.
- Send requests via `stdin` (line-delimited JSON).
- Read responses from `stdout` (line-delimited JSON).
- Maintain request→response correlation with an `id` map and Promise-based pending queue.
- Handle process errors / stderr logging.
- Provide `request(method, params)` method returning the result.
- Clean shutdown (`kill()`).

### 1.5 HTTP transport (`McpHttpTransport`)
- POST JSON-RPC request to `url` with optional `headers`.
- Parse response.
- Provide `request(method, params)` method.

### 1.6 MCP client wrapper
- `McpClient` class wrapping a transport.
- `initialize()` — send `initialize` (protocolVersion, capabilities, clientInfo) and `notifications/initialized`.
- `listTools()` — send `tools/list`, return array of `{ name, description, inputSchema }`.
- `callTool(name, arguments)` — send `tools/call`, return `{ content, isError? }`.
- Handle MCP content block types: `text`, `image`, `resource`.

---

## Phase 2: Integrate MCP Tools into Agento's Tool System

### 2.1 Discovery and registration
- In `app.ts` (or a dedicated init function), after loading skills:
  1. Load MCP config.
  2. For each enabled server:
     - Create transport → `McpClient`.
     - `await client.initialize()`.
     - `await client.listTools()`.
     - For each tool, create a `ToolDescriptor` and `Tool()`-register it.
     - Prefix tool names with `mcp__<serverName>__` to avoid collisions (e.g. `mcp__linear__create_issue`).
     - Store the client for the lifetime of the session.
- If a server fails to connect or list tools, log a warning but do not crash.

### 2.2 Tool execution proxy
- The `execute` function of each dynamic MCP tool delegates to `client.callTool(name, args)`.
- Map MCP content blocks to the app's `ToolOutput.content` format.
- Surface `is_error` when MCP reports `isError: true`.
- Respect `AbortSignal` (cancel in-flight request / kill stdio process).

### 2.3 Lifecycle management
- Keep MCP client connections open for the duration of the session.
- On app exit (`/quit`, `/exit`, SIGINT), shut down all transports cleanly.
- If a transport disconnects mid-session, mark its tools as unavailable.

### 2.4 Tool metadata in the system prompt
- Add a small section to the system prompt listing active MCP servers and their tool prefixes so the model knows they are available.
- Alternatively, rely on the tool descriptions alone (the model sees them in the tools array).

---

## Phase 3: CLI / UI Enhancements

### 3.1 Commands
- Add `/mcp` command (or `/mcp list`) that shows:
  - Configured servers (enabled/disabled).
  - Connection status.
  - Number of tools per server.
  - Tool names.

### 3.2 Slash command suggestions
- Add `/mcp` to the TUI slash-commands list.

---

## Phase 4: Test with Linear MCP

### 4.1 Research Linear MCP
- Find the official Linear MCP server URL and authentication method (OAuth, API key via header, etc.).
- Document the expected `~/.config/agento/mcp.json` entry.

### 4.2 Configure and run
- Create the config file locally.
- Start Agento.
- Run `/mcp list` to verify the server connects and tools are listed.

### 4.3 Functional test
- Ask the agent to perform a real Linear action, e.g.:
  > "List my open Linear issues"
- Verify:
  1. The model picks the correct MCP tool (`mcp__linear__list_issues` or similar).
  2. The tool is invoked successfully via the MCP transport.
  3. The response is displayed in the TUI.
  4. The model uses the result to answer the user.

### 4.4 Edge-case tests
- Server unreachable → graceful warning, no crash.
- Invalid tool name → model never picks it (schema mismatch handled by existing flow).
- Large MCP response → ensure it fits within context window (existing output limits apply).

---

## Phase 5: Code Quality & Lint

- Run `npm run lint` (tsc --noEmit) after all changes.
- Ensure no `any` types in the MCP module; define interfaces for JSON-RPC payloads.
- Keep new files under ~300 lines where possible; split into `mcp-config.ts`, `mcp-transport.ts`, `mcp-client.ts`, `mcp-tools.ts` if needed.

---

## Dependencies

- `@modelcontextprotocol/sdk` (TypeScript SDK) — **evaluate whether to use it** or hand-roll JSON-RPC.
  - Pro: handles protocol details, transports, stdio/HTTP, types.
  - Con: extra dependency; we already hand-roll for Exa MCP.
  - **Decision**: Start with hand-rolled JSON-RPC (consistent with existing Exa pattern, zero new deps). If stdio transport becomes complex, revisit the SDK.

---

## Files to create / modify

| File | Action | Purpose |
|------|--------|---------|
| `mcp-config.ts` | Create | Config loading & validation |
| `mcp-transport.ts` | Create | Stdio & HTTP transport classes |
| `mcp-client.ts` | Create | JSON-RPC wrapper, initialize, listTools, callTool |
| `mcp-tools.ts` | Create | Convert MCP tools to Agento `ToolDescriptor`s and register them |
| `app.ts` | Modify | Load MCP config, init clients, add `/mcp` command, shutdown |
| `tool.ts` | Modify (minor) | Ensure `tools` array can receive dynamically added entries (already dynamic) |
| `package.json` | Modify (minor) | No new deps expected |

---

## Open Questions

1. **Config location**: `~/.config/agento/mcp.json` is consistent with XDG. Is there a project-level config desire? (Start with global only.)
2. **Stdio env var expansion**: Should we support `{env:VAR}` like OpenCode/Claude Code? (Start without; use plain strings.)
3. **OAuth**: Linear MCP likely uses OAuth or API-key headers. The first version should support static `headers` only; OAuth can be a follow-up.
4. **Error messages from MCP**: Should we pass them verbatim or wrap them? (Pass verbatim with a prefix.)
5. **Context window**: MCP tool schemas can be large. Do we need a tool-count limit or tool-search deferral? (Defer to future; start simple.)
