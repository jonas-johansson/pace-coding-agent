# MCP support in OpenCode and Claude Code

Research date: 2026-05-13

## Executive summary

Both OpenCode and Claude Code support the Model Context Protocol (MCP) as a way to expose external tools, APIs, data sources, prompts, and resources to coding agents. The core difference is configuration style and depth:

- **OpenCode** has a straightforward `opencode.json`/config-centered MCP model with `local` and `remote` server types, first-class OAuth for remote servers, CLI commands for adding/listing/auth/debug, and tool enablement through OpenCode's normal `tools` and per-agent configuration.
- **Claude Code** has a broader MCP surface area: CLI-managed installation, multiple scopes (`local`, `project`, `user`), HTTP/SSE/stdio transports, OAuth and custom authentication helpers, Claude.ai connector reuse, plugin-provided MCP servers, use of Claude Code itself as an MCP server, MCP resources and prompts, channel support, dynamic tool updates, tool search, and enterprise managed configuration.

## OpenCode MCP support

### What OpenCode supports

OpenCode can add external tools using MCP and supports both **local** MCP servers and **remote** MCP servers. After configuration, MCP tools are automatically available to the LLM alongside OpenCode's built-in tools.

OpenCode warns that MCP servers add to context usage, and that servers with many tools, such as GitHub MCP servers, can consume a large amount of the context window.

### Configuration model

MCP servers are configured under the `mcp` key in the OpenCode config, typically `opencode.json`/`opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "name-of-mcp-server": {
      "enabled": true
    }
  }
}
```

Each server is named, and users can refer to that name in prompts, for example: `use context7` or `use the gh_grep tool`.

Servers can be disabled without removing them by setting:

```json
{
  "enabled": false
}
```

Organizations can also provide default MCP servers through a `.well-known/opencode` endpoint. Local config values override remote defaults, so users can opt in to a remotely supplied server by defining the same server locally with `enabled: true`.

### Local MCP servers

Local servers use `type: "local"` and a command array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mcp_everything": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
      "enabled": true,
      "environment": {
        "MY_ENV_VAR": "my_env_var_value"
      }
    }
  }
}
```

Local options documented by OpenCode:

| Option | Required | Purpose |
| --- | --- | --- |
| `type` | Yes | Must be `"local"`. |
| `command` | Yes | Command and arguments used to start the MCP server. |
| `environment` | No | Environment variables for the MCP server process. |
| `enabled` | No | Enable/disable on startup. |
| `timeout` | No | Timeout in milliseconds for fetching tools; default is 5000 ms. |

### Remote MCP servers

Remote servers use `type: "remote"`, a URL, and optional headers:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-remote-mcp": {
      "type": "remote",
      "url": "https://my-mcp-server.com",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer MY_API_KEY"
      }
    }
  }
}
```

Remote options documented by OpenCode:

| Option | Required | Purpose |
| --- | --- | --- |
| `type` | Yes | Must be `"remote"`. |
| `url` | Yes | MCP server URL. |
| `enabled` | No | Enable/disable on startup. |
| `headers` | No | Headers sent to the remote server. |
| `oauth` | No | OAuth configuration, or `false` to disable OAuth auto-detection. |
| `timeout` | No | Timeout in milliseconds for fetching tools; default is 5000 ms. |

### OAuth and authentication

OpenCode automatically handles OAuth for remote MCP servers. When a server requires authentication, OpenCode detects a `401` response, starts the OAuth flow, uses Dynamic Client Registration (RFC 7591) if supported, and stores tokens for future requests.

Typical OAuth server config can be minimal:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-oauth-server": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

OpenCode can also use pre-registered OAuth credentials:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-oauth-server": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "{env:MY_MCP_CLIENT_ID}",
        "clientSecret": "{env:MY_MCP_CLIENT_SECRET}",
        "scope": "tools:read tools:execute"
      }
    }
  }
}
```

If a server uses API keys instead of OAuth, OAuth auto-detection can be disabled:

```json
{
  "mcp": {
    "my-api-key-server": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:MY_API_KEY}"
      }
    }
  }
}
```

OpenCode stores OAuth tokens in `~/.local/share/opencode/mcp-auth.json`.

### CLI management

OpenCode provides these MCP CLI commands:

```bash
opencode mcp add          # interactive local/remote server setup
opencode mcp list         # list configured servers and connection status
opencode mcp ls           # alias for list
opencode mcp auth [name]  # authenticate OAuth-enabled server
opencode mcp auth list    # list OAuth-capable servers and auth status
opencode mcp auth ls      # alias
opencode mcp logout [name]
opencode mcp debug <name> # debug OAuth connection issues
```

### Tool management and agents

OpenCode registers MCP server tools with the server name as a prefix. MCP tools can be managed through the normal OpenCode `tools` configuration. You can disable one server or a group with glob patterns:

```json
{
  "mcp": {
    "my-mcp-foo": {
      "type": "local",
      "command": ["bun", "x", "my-mcp-command-foo"]
    }
  },
  "tools": {
    "my-mcp*": false
  }
}
```

MCP tools can also be enabled per agent. A common pattern is to disable MCP tools globally and enable them only for a specific agent:

```json
{
  "mcp": {
    "my-mcp": {
      "type": "local",
      "command": ["bun", "x", "my-mcp-command"],
      "enabled": true
    }
  },
  "tools": {
    "my-mcp*": false
  },
  "agent": {
    "my-agent": {
      "tools": {
        "my-mcp*": true
      }
    }
  }
}
```

### OpenCode examples from documentation

- Sentry remote MCP: `https://mcp.sentry.dev/mcp`, with OAuth.
- Context7 remote MCP: `https://mcp.context7.com/mcp`, optionally with `CONTEXT7_API_KEY` header.
- Grep by Vercel remote MCP: `https://mcp.grep.app`.

## Claude Code MCP support

### What Claude Code supports

Claude Code can connect to external tools and data sources through MCP. Anthropic positions MCP as the mechanism for connecting Claude Code to issue trackers, monitoring tools, databases, APIs, design tools, automation workflows, and external event sources.

Claude Code supports:

- Remote HTTP MCP servers.
- Remote SSE MCP servers, though SSE is deprecated in favor of HTTP where available.
- Local stdio MCP servers.
- MCP servers from JSON config.
- MCP servers imported from Claude Desktop.
- MCP servers configured in Claude.ai connectors.
- Plugin-provided MCP servers.
- Claude Code acting as an MCP server for other MCP clients.
- MCP tools, prompts, resources, elicitation, channels, dynamic tool updates, reconnection, and tool search.

### Installation and transports

#### Remote HTTP servers

HTTP is the recommended transport for remote MCP servers:

```bash
claude mcp add --transport http <name> <url>

# Example
claude mcp add --transport http notion https://mcp.notion.com/mcp

# With a bearer token
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer your-token"
```

In JSON config, Claude Code accepts `type: "streamable-http"` as an alias for `type: "http"`, because `streamable-http` is the MCP specification name.

#### Remote SSE servers

SSE is supported but deprecated:

```bash
claude mcp add --transport sse asana https://mcp.asana.com/sse
```

#### Local stdio servers

Stdio servers run as local processes:

```bash
claude mcp add --transport stdio --env AIRTABLE_API_KEY=YOUR_KEY airtable \
  -- npx -y airtable-mcp-server
```

Important option-ordering rule: flags such as `--transport`, `--env`, `--scope`, and `--header` must appear before the server name, and `--` separates the server name from the command and arguments passed to the server.

Claude Code sets `CLAUDE_PROJECT_DIR` in spawned server environments to the project root. Stdio servers can use this to resolve project-relative paths.

### Managing servers

Claude Code provides these MCP management commands:

```bash
claude mcp list               # list configured servers
claude mcp get github         # show details for one server
claude mcp remove github      # remove a server
claude mcp add-json <name> '<json>'
claude mcp add-from-claude-desktop
claude mcp reset-project-choices
```

Inside Claude Code, `/mcp` shows server status, tool counts, authentication options, and warnings. The name `workspace` is reserved for Claude Code internal use; a user-defined server with that name is skipped.

### Configuration scopes

Claude Code has three user-facing MCP scopes plus enterprise-managed configuration:

| Scope | Loads in | Team-shared? | Stored in |
| --- | --- | --- | --- |
| `local` | Current project only | No | `~/.claude.json`, under the current project's path |
| `project` | Current project only | Yes | `.mcp.json` in the project root |
| `user` | All projects | No | `~/.claude.json` |

Local scope is the default:

```bash
claude mcp add --transport http stripe https://mcp.stripe.com
```

Project scope is intended to be committed to version control:

```bash
claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp
```

User scope applies across all projects:

```bash
claude mcp add --transport http hubspot --scope user https://mcp.hubspot.com/anthropic
```

Precedence when the same server is defined in more than one place:

1. Local scope
2. Project scope
3. User scope
4. Plugin-provided servers
5. Claude.ai connectors

Project-scoped `.mcp.json` files support environment variable expansion in `command`, `args`, `env`, `url`, and `headers` using `${VAR}` and `${VAR:-default}`.

### JSON configuration

Claude Code can add MCP servers directly from JSON:

```bash
claude mcp add-json weather-api \
  '{"type":"http","url":"https://api.weather.com/mcp","headers":{"Authorization":"Bearer token"}}'

claude mcp add-json local-weather \
  '{"type":"stdio","command":"/path/to/weather-cli","args":["--api-key","abc123"],"env":{"CACHE_DIR":"/tmp"}}'
```

A `.mcp.json` file uses this shape:

```json
{
  "mcpServers": {
    "shared-server": {
      "command": "/path/to/server",
      "args": [],
      "env": {}
    }
  }
}
```

### Authentication

Claude Code supports OAuth 2.0 for remote MCP servers. A server is marked as needing authentication when it responds with `401 Unauthorized` and a `WWW-Authenticate` header pointing to its authorization server. Users authenticate from the `/mcp` panel.

OAuth features include:

- Secure token storage and refresh.
- Browser-based login from `/mcp`.
- Fixed callback port via `--callback-port` for servers requiring pre-registered redirect URIs.
- Pre-configured OAuth credentials using `--client-id`, `--client-secret`, and JSON `oauth` configuration.
- Dynamic Client Registration support when available.
- OAuth metadata override using `oauth.authServerMetadataUrl`.
- Scope pinning using `oauth.scopes`.

Example pre-configured OAuth JSON:

```bash
claude mcp add-json my-server \
  '{"type":"http","url":"https://mcp.example.com/mcp","oauth":{"clientId":"your-client-id","callbackPort":8080}}' \
  --client-secret
```

For non-OAuth custom authentication, Claude Code supports:

- Static headers through `--header` or JSON `headers`.
- Dynamic headers with `headersHelper`, a shell command that outputs JSON key/value headers and runs at connection time.

Example dynamic headers:

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.internal.example.com",
      "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
    }
  }
}
```

### Claude.ai and Claude Desktop integration

Claude Code can import servers from Claude Desktop:

```bash
claude mcp add-from-claude-desktop
```

This works on macOS and WSL and reads the Claude Desktop configuration file from its standard location.

If a user is logged into Claude Code with a Claude.ai account, MCP servers configured as Claude.ai connectors are automatically available in Claude Code. These can be disabled with:

```bash
ENABLE_CLAUDEAI_MCP_SERVERS=false claude
```

### Claude Code as an MCP server

Claude Code can itself run as a stdio MCP server for other clients:

```bash
claude mcp serve
```

Example Claude Desktop config:

```json
{
  "mcpServers": {
    "claude-code": {
      "type": "stdio",
      "command": "claude",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

This exposes Claude Code's built-in tools, such as file viewing/editing and shell/search tools, to the connecting MCP client. It does not proxy through to the MCP servers that Claude Code itself is connected to.

### Resources, prompts, elicitation, and channels

Claude Code supports more than MCP tool calls:

- **Resources**: MCP resources can be referenced with `@` mentions, using syntax such as `@github:issue://123`. Claude Code can list and read resources when servers support them.
- **Prompts**: MCP server prompts appear as slash commands such as `/mcp__servername__promptname`.
- **Elicitation**: MCP servers can request structured input mid-task; Claude Code shows interactive dialogs or URL flows.
- **Channels**: MCP servers can push messages into a session with the `claude/channel` capability, allowing Claude to react to external events.

### Dynamic behavior and reliability

Claude Code supports MCP `list_changed` notifications, so servers can update available tools, prompts, and resources without a reconnect.

For remote HTTP or SSE servers, Claude Code automatically reconnects with exponential backoff when a server disconnects mid-session. Stdio servers are not automatically reconnected.

### Context management and tool search

Claude Code has explicit features for MCP scale:

- It warns when MCP tool output exceeds 10,000 tokens.
- The default maximum MCP output is 25,000 tokens and can be changed with `MAX_MCP_OUTPUT_TOKENS`.
- Server authors can annotate tools with `_meta["anthropic/maxResultSizeChars"]`, up to a hard ceiling of 500,000 characters.
- Tool search is enabled by default for supported models, deferring MCP tool definitions until needed so large MCP tool sets do not fill context upfront.
- Tool search can be configured with `ENABLE_TOOL_SEARCH` values such as `true`, `auto`, `auto:<N>`, or `false`.
- A server can be exempted from deferral with `alwaysLoad: true`.

Example:

```json
{
  "mcpServers": {
    "core-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "alwaysLoad": true
    }
  }
}
```

### Enterprise management

Claude Code supports centralized enterprise MCP governance:

1. `managed-mcp.json`: a system-wide file that takes exclusive control over MCP servers.
2. Managed settings with `allowedMcpServers` and `deniedMcpServers`: policy controls that allow or block servers by name, command, or URL pattern.

System-wide `managed-mcp.json` paths:

- macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`
- Linux/WSL: `/etc/claude-code/managed-mcp.json`
- Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`

Allow/deny policy entries can match exactly by stdio command, by server name, or by remote URL wildcard patterns. Denylist entries take absolute precedence.

### Claude Agent SDK MCP support

Anthropic's Claude Agent SDK also supports MCP. SDK users can configure MCP servers in code or load `.mcp.json` configuration. The SDK supports stdio, HTTP, and SSE servers, plus in-process SDK MCP servers/custom tools.

Important SDK-specific point: MCP tools require explicit permission via `allowedTools`, using names like:

```text
mcp__<server-name>__<tool-name>
```

Example TypeScript SDK configuration:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Use the docs MCP server to explain what hooks are in Claude Code",
  options: {
    mcpServers: {
      "claude-code-docs": {
        type: "http",
        url: "https://code.claude.com/docs/mcp"
      }
    },
    allowedTools: ["mcp__claude-code-docs__*"]
  }
})) {
  // handle messages
}
```

The SDK documentation notes that OAuth flows are not handled automatically by the SDK; applications should complete OAuth themselves and pass access tokens through headers.

## Comparison

| Area | OpenCode | Claude Code |
| --- | --- | --- |
| Main config key | `mcp` in OpenCode config | `mcpServers` in `.mcp.json` / `~/.claude.json` / managed config |
| Local transport | `type: "local"`, `command` array | `type: "stdio"` or command/args; `claude mcp add --transport stdio` |
| Remote transport | `type: "remote"`, `url` | `type: "http"` / `streamable-http`, `sse`; HTTP recommended, SSE deprecated |
| CLI setup | `opencode mcp add` interactive | `claude mcp add`, `add-json`, `add-from-claude-desktop`, `serve`, etc. |
| OAuth | Automatic OAuth for remote servers, DCR support, token file in OpenCode data dir | OAuth from `/mcp`, DCR/preconfigured credentials, callback ports, metadata override, scope pinning |
| Scoping | OpenCode config and organization remote defaults | Local, project, user, plugins, Claude.ai connectors, enterprise managed config |
| Tool enable/disable | Uses OpenCode `tools` config and per-agent tool config with glob patterns | Permissions, `/mcp`, `allowedTools` in SDK, tool search, `alwaysLoad` |
| Context strategy | Warning to be careful; can disable globally/per-agent | Tool search enabled by default, output limits/warnings, server/tool annotations |
| Resources/prompts | Docs focus on tools | Tools, resources, prompts as slash commands, elicitation, channels |
| Enterprise | Organization `.well-known/opencode` remote defaults | `managed-mcp.json`, allowlists/denylists, Claude.ai connectors/admin controls |
| Acts as MCP server | Not documented in researched pages | Yes: `claude mcp serve` exposes Claude Code tools to MCP clients |

## Practical takeaways

- Use **OpenCode MCP** when you want simple config-driven local/remote MCP integration and straightforward OAuth/tool enablement inside OpenCode's agent/tool model.
- Use **Claude Code MCP** when you need richer scoping, team-shared `.mcp.json`, Claude.ai/Claude Desktop interoperability, enterprise controls, resources/prompts, or large MCP deployments where tool search matters.
- For both products, be careful with MCP servers that expose many tools or large outputs. MCP can significantly increase context usage and expand the agent's authority over external systems.
- Prefer environment variables or OAuth flows for credentials; avoid committing secrets in shared MCP configuration.

## Sources

- OpenCode MCP servers documentation: https://opencode.ai/docs/mcp-servers/
- OpenCode CLI documentation, MCP commands: https://opencode.ai/docs/cli/
- Claude Code MCP documentation: https://code.claude.com/docs/en/mcp
- Claude Agent SDK MCP documentation: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-mcp

---

## Pi Coding Agent MCP support

### Vanilla Pi: intentionally no built-in MCP

Pi's official position is that **vanilla Pi does not ship MCP support**. The Pi site lists MCP under "What we didn't build" and recommends two alternatives:

1. Build CLI tools with README files, usually surfaced through Pi Skills or normal project documentation.
2. Build or install a Pi extension that adds MCP support.

Pi's reasoning is tied to its larger design philosophy: a small terminal coding harness with a minimal prompt, four default tools (`read`, `write`, `edit`, `bash`), and extensibility through TypeScript extensions, skills, prompt templates, themes, RPC, and SDK mode. Pi aims to keep its default system prompt plus tool definitions under roughly 1,000 tokens and to let users choose what enters the context window.

Mario Zechner's Pi design post states that Pi "does not and will not support MCP" in core because MCP is considered overkill for many coding-agent workflows and often carries large context overhead. The cited examples are browser automation MCP servers:

- Playwright MCP: 21 tools, roughly 13.7k tokens.
- Chrome DevTools MCP: 26 tools, roughly 18k tokens.

The argument is that those schemas can consume 7-9% of a 200k-token context window before the session starts, and the agent may use only a small subset of the tools.

### Pi's preferred alternative: CLI tools with READMEs / Skills

Pi's recommended pattern is to build small CLI tools and document them with concise README files. The agent reads the README only when it needs that capability, then invokes scripts through `bash`.

For browser automation, Zechner gives a minimal README-style tool set:

```markdown
# Browser Tools

## Start Chrome
./start.js              # Fresh profile
./start.js --profile    # Copy your profile (cookies, logins)

## Navigate
./nav.js https://example.com
./nav.js https://example.com --new

## Evaluate JavaScript
./eval.js 'document.title'

## Screenshot
./screenshot.js
```

The claimed benefits are:

- **Progressive disclosure**: the README is loaded only when needed.
- **Low token cost**: the example browser tools README is about 225 tokens, versus 13k-18k for broad browser MCP servers.
- **Composability**: CLI output can be piped, redirected, filtered, saved to files, or chained without passing every intermediate result through the model context.
- **Easy customization**: adding a new capability can be as simple as adding a script and a README section.
- **Agent familiarity**: models have extensive training on shell, common CLIs, and code.

Pi also supports Skills as an on-demand capability packaging mechanism. Skills can contain instructions, scripts, references, templates, and assets. That makes them a natural home for the "README + scripts" pattern.

### Pi extension model: MCP can be added outside core

Although core Pi omits MCP, Pi is explicitly designed so users can add MCP with extensions. Extensions are TypeScript modules that can register tools, add slash commands, intercept tool calls, modify prompts, inject context, and build custom UI. Pi packages can bundle extensions and distribute them through npm or git.

Several community MCP approaches exist.

### `pi-codemode-mcp`: MCP through two code-oriented tools

Armin Ronacher's `pi-codemode-mcp` is an experimental Pi extension that exposes MCP to Pi through only two tools:

- `list_mcp_tools`: enumerates enabled MCP tools, showing the first 20 inline and writing larger results to a temporary TSV file for `grep`/`rg`.
- `call_mcp`: runs JavaScript in a sandbox and lets the script call MCP servers.

It also adds a `/mcp` command for:

```text
/mcp                         # interactive menu
/mcp status                  # server/auth state and enabled counts
/mcp enable <server> <tool|all>
/mcp disable <server> <tool|all>
/mcp reconnect [server]
/mcp auth <server>
```

Configuration files are loaded in merge order:

1. `~/.pi/agent/mcp.json`
2. `~/.pi/agent/.mcp.json`
3. `<cwd>/.pi/mcp.json`
4. `<cwd>/.mcp.json`

The `call_mcp` tool exposes a JavaScript API inside the sandbox:

```js
await call(server, tool, args)
await readResource(server, uri)
listTools(query?)
servers     // configured server names
tools       // map of server -> tool names
resources   // map of server -> resources
state       // persistent mutable object across calls
```

This is essentially a "code mode" design: instead of exposing every MCP tool directly to the model as a first-class tool schema, expose a small meta-tool surface and let the agent write JavaScript to discover, batch, compose, and call MCP tools.

Authentication behavior includes OAuth browser login for URL-based servers, token storage under `~/.pi/agent/mcp-oauth/<server>/tokens.json`, dynamic client registration when available, and bearer-token fallbacks.

The repository says the experiment was intended to test whether code-based MCP interaction improves efficiency. Its finding is nuanced: the hoped-for efficiency gains were not very useful with today's MCP, but MCP servers that internally expose a code environment can be helpful.

### `my-pi` / `@spences10/pi-mcp`: direct tool registration extension

The `my-pi` project is a custom Pi distribution built on the Pi SDK. It adds MCP integration as a built-in extension and also publishes reusable Pi packages such as `@spences10/pi-mcp`.

Its MCP model is closer to traditional MCP host integration:

- Loads `mcp.json` configs from global and project locations.
- Connects to stdio and HTTP/streamable-HTTP servers.
- Performs the MCP `initialize` handshake.
- Calls `tools/list`.
- Registers each tool with Pi as `mcp__<server>__<tool>` using `pi.registerTool()`.
- Toggles tools with `pi.setActiveTools()`.

Example global config:

```json
{
  "mcpServers": {
    "mcp-sqlite-tools": {
      "command": "npx",
      "args": ["-y", "mcp-sqlite-tools"]
    }
  }
}
```

Example HTTP config:

```json
{
  "mcpServers": {
    "my-http-mcp": {
      "type": "http",
      "url": "https://myproject.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ..."
      }
    }
  }
}
```

`my-pi` treats project-local `mcp.json` as untrusted by default. Interactive sessions prompt before loading it; headless sessions skip it unless `MY_PI_MCP_PROJECT_CONFIG=allow` or `MY_PI_MCP_PROJECT_CONFIG=trust` is set. This is a notable security posture compared with simply loading project MCP definitions.

Interactive MCP commands include:

```text
/mcp list
/mcp enable <server>
/mcp disable <server>
```

It also supports MCP backup/restore/profile management in the interactive MCP modal.

### Pi as an MCP server

Separate from connecting Pi to MCP servers, there are projects that expose Pi itself as an MCP server. For example, `pandysp/pi-mcp-server` wraps Pi as tools such as:

- `pi`: start a new Pi coding-agent session.
- `pi-reply`: continue an existing session.

This lets Claude Desktop, Cursor, or another MCP client delegate coding work to Pi as a sub-agent. This is the inverse of "Pi consumes MCP": Pi becomes the tool exposed over MCP.

### Pi takeaways

Pi's MCP story is intentionally different from OpenCode and Claude Code:

- **Core Pi**: no MCP, by design.
- **Preferred default**: small CLI tools + README/Skills + bash.
- **If needed**: install or build a TypeScript extension.
- **Community implementations**: either register every MCP tool as Pi tools (`my-pi`) or expose MCP through a small code-mode surface (`pi-codemode-mcp`).
- **Pi can also be wrapped as an MCP server** for other agents.

This makes Pi a useful contrast case: it treats MCP as optional infrastructure rather than a default integration layer.

## Pros and cons of MCP

### Pros

1. **Interoperability and ecosystem reuse**
   - One MCP server can work across multiple MCP-aware clients such as Claude Code, OpenCode, Cursor, Windsurf, VS Code, and others.
   - This reduces the N x M integration problem: build one server per service and one client per host rather than custom integrations for every pairing.

2. **Standardized discovery**
   - Servers advertise tools, resources, and prompts through a common protocol.
   - The agent does not need prior knowledge of every API endpoint or CLI command.

3. **Process isolation**
   - MCP servers usually run as separate processes or remote services.
   - They can be sandboxed, containerized, run under restricted OS users, or given only scoped credentials.

4. **Uniform client implementation**
   - Clients can speak one protocol instead of implementing a custom integration path for every SaaS API, database, CLI, or service.

5. **Good fit for external systems**
   - MCP is strongest when an agent needs to read or write data in databases, SaaS products, cloud services, file stores, monitoring systems, issue trackers, or internal APIs.

6. **Potential governance surface**
   - The protocol boundary can become a place to enforce validation, logging, auditing, rate limits, and policy, especially when paired with an MCP gateway.

7. **Resources and prompts, not only tools**
   - MCP can expose data resources and prompt templates in addition to callable tools.

### Cons

1. **Context/schema overhead**
   - Many clients load all tool definitions up front.
   - Large servers can consume tens of thousands of tokens before the user prompt is processed.
   - The cost compounds when multiple MCP servers are connected.

2. **Intermediate-result overhead**
   - In direct MCP tool-calling, tool results often pass through the model context before they can be used by later calls.
   - Large documents, database results, transcripts, screenshots, or logs can blow up context and cost.

3. **Weak shell-style composability**
   - Unix tools compose by pipes, files, and scripts.
   - MCP calls are often mediated by the model/agent loop, making the model a bottleneck for pipelines unless a code-execution pattern is used.

4. **Additional infrastructure and latency**
   - Every tool needs a server wrapper, transport, deployment, monitoring, and security maintenance.
   - Each call may add an extra hop and another failure mode.

5. **Authentication complexity**
   - OAuth, token refresh, per-user scoping, credential storage, rotation, and multi-tenant isolation are still uneven across MCP implementations.
   - Enterprises often need a gateway/proxy layer to make MCP operationally acceptable.

6. **Server quality varies widely**
   - Common anti-patterns include too many tools, verbose schemas, kitchen-sink responses, poor pagination/filtering, weak error messages, and natural-language intent parsing inside the server.

7. **Models currently know shell and common APIs better**
   - Models have much more training data for bash, `git`, `curl`, `gh`, Python, JavaScript, SQL, etc. than for custom MCP tool schemas.
   - That can make CLI/script workflows more reliable for developer-operated tasks.

8. **Security risks remain**
   - MCP does not make tools safe by itself. A malicious or overprivileged server can exfiltrate data, mutate systems, or become a confused-deputy path.
   - Project-local MCP configs can be dangerous if loaded automatically without trust prompts.

### Best practices when using MCP

- Keep servers thin: route to an SDK/API, validate inputs, return structured data, and avoid duplicating app logic.
- Prefer fewer, better tools over many fine-grained tools.
- Use pagination, filtering, field selection, truncation, and slim response modes.
- Include useful guidance in responses: next steps, warnings, and actionable validation errors.
- Avoid natural-language intent parsing inside MCP servers; let the model decide intent.
- Measure token footprint of tool schemas and outputs.
- Use scoped credentials and sandboxing.
- Treat project-local MCP configs as untrusted until approved.
- Consider code-mode/meta-tool patterns once the tool count grows.

## Alternatives and complements to MCP

### 1. CLI tools with README files

This is Pi's preferred alternative and a common pattern for developer-operated coding agents.

**How it works:** create small command-line tools, document them with a concise README, and let the agent invoke them through `bash`.

**Pros:**

- Very low startup context cost.
- Uses model training on shell, common CLIs, and programming languages.
- Composable with pipes, files, `jq`, `xargs`, temporary files, and scripts.
- Easy to modify locally.
- Works in nearly any coding agent with shell access.

**Cons:**

- Less standardized discovery.
- Tool usage can be platform-dependent and brittle.
- Shell quoting and session management can trip agents.
- Auth and setup are ad hoc.
- Harder to share safely with non-technical users.

**Best for:** individual developers, small teams, local workflows, one-off automations, and tasks where composability matters more than cross-client discovery.

### 2. Agent Skills

Skills package procedural knowledge as folders containing `SKILL.md`, scripts, templates, and reference files. They use progressive disclosure: only names/descriptions are loaded up front; detailed instructions and assets are loaded on demand.

**Pros:**

- Token-efficient knowledge loading.
- Easy to author, review, version-control, and distribute.
- Good for organizational playbooks, code review checklists, deployment procedures, style guides, and domain workflows.
- Complements any execution mechanism: built-in tools, bash, CLI tools, or MCP.

**Cons:**

- Skills are inert instructions; they do not provide external connectivity by themselves.
- Security depends on host behavior and the tools the agent already has.
- Implementations differ by host.

**Best for:** procedural knowledge and workflow guidance. Use Skills plus MCP when the agent needs both external connectivity and organization-specific methods.

### 3. Direct APIs / REST / OpenAPI

Agents or agent harnesses can call existing APIs directly, often guided by OpenAPI specs or hand-written docs.

**Pros:**

- Uses existing infrastructure, auth, gateways, observability, rate limits, and governance.
- No extra MCP wrapper.
- Universal and well understood.
- Good for production systems with mature API programs.

**Cons:**

- Discovery is weaker unless OpenAPI/metadata is provided in an agent-friendly way.
- The client/agent must handle auth, retries, pagination, and transport details.
- Less portable across agent hosts than MCP.

**Best for:** production services with established APIs, latency-sensitive workflows, and teams that already have strong API governance.

### 4. UTCP (Universal Tool Calling Protocol)

UTCP describes how to call tools through their native interfaces instead of proxying calls through a server. A UTCP document is a machine-readable manual that can describe HTTP APIs, gRPC, WebSockets, CLI commands, database drivers, queues, local interfaces, or even MCP.

**Pros:**

- Avoids the MCP intermediary/proxy layer.
- Lower latency and fewer runtime moving parts.
- Protocol-agnostic and compatible with existing APIs.
- Can incorporate MCP as one possible transport rather than making it mandatory.

**Cons:**

- More responsibility shifts to the AI client.
- The client must support diverse transports, auth schemes, retries, and error handling.
- Ecosystem maturity and host support are behind MCP.

**Best for:** environments with many existing tools/APIs where wrapping everything in MCP is wasteful and the client platform is capable enough to call native interfaces directly.

### 5. OpenAI-style function calling / provider-native tool calling

Provider-native function calling lets an application register tools/functions directly in model requests.

**Pros:**

- Simple for app-specific tools.
- No separate server process.
- Low operational overhead for small tool sets.
- Strong integration with the provider's model API.

**Cons:**

- Usually vendor-specific and not portable.
- Function definitions must be registered by the application.
- No cross-host discovery or shared ecosystem.

**Best for:** application-local tools and products already tied to one model provider.

### 6. Code execution with MCP / Code Mode

This is not a replacement for MCP; it is an alternative usage pattern. Instead of exposing every MCP tool directly as a model tool, the harness exposes a code execution environment where MCP servers appear as code APIs or a virtual filesystem of tool modules.

Anthropic reports an example where token usage dropped from 150,000 tokens to 2,000 tokens (98.7% reduction) by letting the agent read only needed tool definitions and process intermediate data inside the sandbox.

Benefits:

- Progressive disclosure of tool definitions.
- Intermediate results can be filtered, joined, aggregated, or copied without entering model context.
- Loops, conditionals, retries, and error handling happen in code rather than through repeated model turns.
- Sensitive data can remain in the sandbox and only selected summaries/results reach the model.
- Agent can persist useful code as reusable Skills.

Costs:

- Requires a sandbox, resource limits, monitoring, and security controls.
- Agent-generated code execution expands the attack surface if poorly isolated.
- More complex to implement than direct tool calls.

This is the same family of idea as `pi-codemode-mcp`, Armin Ronacher's single-tool Python/JavaScript MCP experiments, and Cloudflare-style "Code Mode" gateways.

### 7. MCP-to-CLI bridges, such as MCPorter

MCPorter bridges MCP and CLI/code workflows. It can discover configured MCP servers, call tools from the command line, expose typed TypeScript clients, generate standalone CLIs from MCP server definitions, and pool/OAuth connections.

This gives agents a way to use MCP servers through shell or TypeScript instead of direct MCP host integration.

**Pros:**

- Reuses existing MCP servers.
- Makes MCP more composable through CLI/scripts.
- Can generate narrow, single-purpose CLIs.
- Useful when the agent has shell access but no native MCP support.

**Cons:**

- Adds another tool layer.
- Still inherits MCP server quality/auth issues.
- Requires agents to understand the bridge's CLI/API.

**Best for:** Pi-style workflows that want the MCP ecosystem without loading every MCP tool schema into the agent context.

### 8. A2A (Agent-to-Agent protocol)

A2A solves a different problem: communication between agents, not tool access for one agent. It can complement MCP in multi-agent systems.

**Use MCP when:** one host/model needs tools.

**Use A2A when:** separate agents need to discover each other, advertise capabilities, and exchange messages across trust boundaries.

Most production multi-agent systems can use both: each agent uses MCP or direct tools internally, while A2A handles cross-agent coordination.

## Updated comparison including Pi

| Area | OpenCode | Claude Code | Pi Coding Agent |
| --- | --- | --- | --- |
| Core MCP support | Built in | Built in | Not built in by design |
| Default philosophy | Config-driven local/remote MCP tools | Rich MCP platform with scopes, auth, resources, prompts, tool search | Minimal harness; add features through extensions/skills |
| Preferred MCP alternative | Disable/manage tools globally or per agent | Tool search, code execution patterns, Skills | CLI tools with READMEs / Skills / bash |
| MCP install path | `opencode mcp add` or `mcp` config | `claude mcp add`, `.mcp.json`, `~/.claude.json`, plugins/connectors | Community extensions/packages, e.g. `pi-codemode-mcp`, `@spences10/pi-mcp` |
| Tool naming | Server-name-prefixed MCP tools | `mcp__server__tool` | Extension-dependent; `my-pi` uses `mcp__server__tool` |
| Code-mode approach | Not emphasized in docs researched | Officially documented as efficient MCP pattern | Community experiment exposes MCP through `list_mcp_tools` + `call_mcp` JavaScript |
| Project trust | Organization remote defaults/local config | Project `.mcp.json` approval and managed policies | `my-pi` treats project MCP config as untrusted by default |
| Pi-specific advantage | N/A | N/A | Total control over context; MCP optional, replaceable, or custom-built |

## Decision guide

Use MCP when:

- You need cross-agent-host interoperability.
- The agent needs standardized access to external systems.
- You want tools/resources/prompts discoverable by unknown clients.
- Process isolation and centralized integration boundaries matter.
- You are exposing a product integration to the broader AI-tool ecosystem.

Avoid or minimize MCP when:

- A few local scripts or CLI commands are enough.
- Token/context overhead matters more than discovery.
- The workflow is mostly shell composition, file pipelines, or developer-operated automation.
- You already have mature APIs and agent-friendly docs.
- You cannot operate MCP auth, observability, sandboxing, and governance safely.

Use Skills when:

- The missing capability is knowledge/procedure, not connectivity.
- You need progressive disclosure of internal methods, templates, or runbooks.
- You want version-controlled guidance that can pair with any execution tool.

Use Code Mode when:

- You have many MCP tools/servers.
- Intermediate data is large or sensitive.
- The task naturally involves loops, joins, filters, retries, or batching.
- You can provide a secure sandbox.

Use CLI/README tools when:

- Developers are the operators.
- The workflow benefits from Unix composition.
- You need maximum simplicity and minimum context cost.
- You are comfortable managing setup and trust yourself.

## Additional sources

- Pi official site: https://pi.dev/
- Mario Zechner, "What I learned building an opinionated and minimal coding agent": https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- Mario Zechner, "What if you don't need MCP at all?": https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/
- Armin Ronacher, "Your MCP Doesn't Need 30 Tools: It Needs Code": https://lucumr.pocoo.org/2025/8/18/code-mcps/
- `pi-codemode-mcp`: https://github.com/mitsuhiko/pi-codemode-mcp
- `my-pi`: https://github.com/spences10/my-pi
- MCPorter: https://github.com/openclaw/mcporter
- Anthropic, "Code execution with MCP: Building more efficient agents": https://www.anthropic.com/engineering/code-execution-with-mcp
- Nordic APIs, "Model Context Protocol (MCP) vs. Universal Tool Calling Protocol (UTCP)": https://nordicapis.com/model-context-protocol-mcp-vs-universal-tool-calling-protocol-utcp/
- AgentDrop, "MCP vs A2A vs Function Calling": https://agent-drop.com/agent-protocol-comparison
- Ravikanth Chaganti, "Agent skills vs Model Context Protocol": https://ravichaganti.com/blog/agent-skills-vs-model-context-protocol-how-do-you-choose/
- Steven Poitras, "MCP Isn't the Problem": https://agenticthinking.ai/blog/five-things-wrong-with-mcp/
