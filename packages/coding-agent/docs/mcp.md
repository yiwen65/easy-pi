# MCP servers

Easy Pi connects to Model Context Protocol servers over **stdio** or **Streamable HTTP**. MCP tools run through the normal tool hooks, permissions and task-recovery pipeline. Codemode, legacy SSE, MCP Apps, sampling and MCP tasks are not supported.

## Setup

```bash
epi mcp add docs --url https://example.com/mcp
epi mcp add filesystem -- node /absolute/path/server.mjs
epi mcp list
epi
```

Commands add global entries by default. Use `--local` (`-l`) for project configuration. Run `epi mcp --help` for add/remove/list/login/logout options.

Global configuration is `<agentDir>/mcp.json`; the agent directory is the same one used for settings and provider credentials. Project configuration is `.epi/mcp.json` by default (or the configured project config directory). Project entries are read only when the project is trusted.

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "description": "Search product documentation",
      "exposure": "deferred"
    },
    "local": {
      "command": "node",
      "args": ["/absolute/path/server.mjs"],
      "env": { "API_TOKEN": "${LOCAL_TOKEN}" },
      "exposure": "direct"
    }
  }
}
```

A project entry replaces a global entry with the same name. An entry without `command`, `url` or `type` can instead override only `enabled`, `exposure` and `toolExposure`:

```json
{ "mcpServers": { "docs": { "enabled": false } } }
```

`command` is one executable, not a shell command string. Relative `cwd` is resolved against the session directory. `env`, HTTP `headers` and OAuth `clientSecret` support `${NAME}` substitution and whole-value `!command` resolution. These commands and stdio servers execute with the host process's permissions; project trust is not an OS sandbox. Stdio servers inherit the host environment.

`timeout` is a per-request timeout in seconds (default 60); progress notifications renew it. Invalid entries are reported and skipped independently.

## Discovery and strict authorization

Tools are named `mcp__<server>__<tool>`, with provider-safe sanitization and a hash suffix for collisions or long names.

| Exposure | Behavior |
| --- | --- |
| `deferred` (default) | `tool_search` finds and loads allowed tools; their schemas appear on the next model call. |
| `direct` | Tools are declared as soon as the server connects. |
| `hidden` | Tools cannot be discovered, declared or called. |

`toolExposure` overrides individual tools by exact name or `*` pattern. Exact names win, then the first matching pattern:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "toolExposure": { "search": "direct", "delete_*": "hidden" }
    }
  }
}
```

`--tools` and SDK `tools` are **strict allowlists**, including MCP. Unlike upstream's convenience behavior, naming only `tool_search` does not authorize all MCP tools:

```bash
# No MCP tools are authorized or connected.
epi --tools read,tool_search

# Discovery may expose only this server's allowed tools.
epi --tools 'read,tool_search,mcp__docs__*' --exclude-tools 'mcp__docs__delete_*'

# Disable the built-in integration for one run.
epi --no-mcp
```

Search, late registration, resume, reload and branch navigation never add authorization. Loaded deferred tools are restored from the active branch when their server reconnects, subject to current grants and exclusions. Hidden or withdrawn tools remain unavailable.

## Management and OAuth

`/mcp` opens the interactive manager: inspect server state and errors, reconnect, sign in/out, enable/disable, and change exposure. It remains usable while connections are pending. Outside the TUI, `/mcp` reports status; `/mcp login <server>`, `/mcp logout <server>` and `/mcp reconnect <server>` perform those actions. Reload after editing configuration outside the session.

Enabled servers connect in the background. The first prompt waits at most 10 seconds for direct tools. Discovery and resource requests wait for their relevant connections. Shutdown cancels pending connections and sign-ins, closes stdio process groups and waits for cleanup.

HTTP servers without an explicit `Authorization` header use OAuth when challenged. Sign in with `/mcp login docs` or `epi mcp login docs`. Credentials are stored separately in `<agentDir>/mcp-auth.json`, keyed by server name and URL; concurrent refreshes are serialized. No browser sign-in starts automatically from a model tool call.

For pre-registered clients:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "oauth": { "clientId": "client-id", "clientSecret": "${DOCS_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

OAuth supports PKCE, dynamic registration, loopback callbacks, scope upgrades and an optional trusted `authServerMetadataUrl`. Issuer mismatches, including an unverifiable `iss`, are rejected before authorization-code exchange. Esc or session shutdown cancels sign-in. Provider-token forwarding, Radius setup and `clientRegistration: "cimd"` are deliberately unsupported.

## Results and recovery

Text and images reach the model. Text over 20 KB is shortened, with the full output saved to a temporary file; binary resources are also saved to files. Server log notifications are written to `<agentDir>/mcp.log` with bounded rotation.

A returned MCP `isError` is a known tool error. A connection drop, timeout or cancellation after dispatch can leave the remote effect **unknown**: Easy Pi pauses for verification instead of automatically replaying the call. Remote `readOnlyHint` and `idempotentHint` are metadata, not retry guarantees.

## Resources and native children

Root sessions can use `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`. Resource tools obey the same grants and exposure controls. MCP App resources are omitted.

Native children receive only the root's approved MCP configuration for concretely delegated tools, never fresh global/project discovery. Each session owns its transport; closing one child does not close the root's connections. Live parent and ancestry restrictions apply to search and execution, including follow-up turns.

The first-phase delegation API does not express resource-server scopes. Consequently, generic MCP resource tools are **not delegated to children**, even with `tools: "inherit"`. Granting a server tool does not grant that server's entire resource catalog. Children cannot start browser OAuth login; authenticate from the root/user first.

## Extensions and SDK

Extensions may register session-only servers:

```typescript
pi.registerMcpServer("docs", { url: "https://example.com/mcp", exposure: "deferred" });
```

File configuration takes precedence over registrations. Registrations are owned by their extension. An installed extension providing `/mcp` replaces the built-in session integration, avoiding duplicate connections; shell `epi mcp` commands still use the built-in implementation. Disable the built-in persistently with `"extensions": ["-builtin:mcp"]`.

The default SDK resource loader includes MCP. Use `noMcp: true` to disable it. A custom loader remains host-owned; add factories explicitly:

```typescript
import { createMcpExtension, createToolSearchExtension, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension({ agentDir }), builtin: true, replaceable: true },
  ],
});
await loader.reload();
```

Factories support injected configuration, credential stores and transports for trusted embedding and local tests. The model-visible declaration set is not the authorization catalog: discovery changes declarations, not host grants.
