# Agent Desktop MCP for Easy Pi

A standalone stdio MCP server wrapping the macOS `agent-desktop` CLI. No changes to Easy Pi's core, no shell execution, and no FFI dependency. Validated against agent-desktop **0.9.4**, Node **24**, and MCP SDK **1.32.1**.

## Install and register

```sh
cd /absolute/path/to/pi/tools/agent-desktop-mcp
npm ci --ignore-scripts
```

Install the macOS agent-desktop release binary and its adjacent `agent-desktop-macos-helper` from [upstream releases](https://github.com/lahfir/agent-desktop/releases/tag/v0.9.4). Verify the archive against the release's `checksums.txt`. This host uses `/Users/w/.local/share/agent-desktop/0.9.4/agent-desktop`.

```sh
/path/to/agent-desktop status
# Only if permissions are missing (this may open macOS permission prompts):
/path/to/agent-desktop permissions --request

epi mcp add agent_desktop --exposure deferred \
  --env AGENT_DESKTOP_BIN=/absolute/path/to/agent-desktop \
  -- /absolute/path/to/node /absolute/path/to/pi/tools/agent-desktop-mcp/server.mjs
epi mcp list
```

Registration is global (`~/.epi/agent/mcp.json`); existing servers are preserved. Reload Easy Pi after registration. `/mcp` shows connection state. A strict tool allowlist must explicitly include `mcp__agent_desktop__*`; configuring a server does not grant its tools to an already restricted session.

For other MCP clients, use the same executable/arguments/environment in their `mcpServers` configuration.

## Tools

| Tool | Parameters |
| --- | --- |
| `desktop_status` | none |
| `desktop_list_apps` | optional `app` filter |
| `desktop_snapshot` | required `app`; optional `window_id`, `max_depth`, `interactive_only`, `compact`, `skeleton`, `surface`, `root` |
| `desktop_click` | `ref_id`; optional `headed` |
| `desktop_type` | `ref_id`, `text`; optional `headed` |
| `desktop_press` | `combo`, required target `app` |
| `desktop_batch` | `actions`, optional `headed` |

Refs must be qualified, such as `@s8f3k2p9:e3`, and obtained from this server's snapshot. Each server process gets an isolated snapshot namespace; refs cannot be carried into a reconnect or another transport. Namespace-only sessions do not enable trace recording. Requests within a transport are serialized; separate agents must still coordinate mutations to shared UI.

Batch uses native command names (`status`, `list-apps`, `snapshot`, `click`, `type`, `press`) and the same arguments as individual tools, except `headed` is a batch-level option:

```json
{
  "actions": [
    { "command": "click", "args": { "ref_id": "@s8f3k2p9:e3" } },
    { "command": "snapshot", "args": { "app": "Finder" } }
  ]
}
```

Batch is sequential, **not atomic**, and stops at the first error. It accepts at most 64 entries and 64 KiB of serialized UTF-8 input. Text is also bounded to 64 KiB. Session overrides, nested batches, arbitrary commands, permission prompting and shortcut `force` overrides are not exposed. Re-observe between dependent steps; never guess refs for a UI that has not been observed.

Ref actions default to strict headless AX delivery. `headed: true` explicitly permits physical delivery/focus side effects. Keyboard commands can change focus. User confirmation for deletion, sending messages, or other sensitive effects remains the agent's responsibility: this wrapper is **not a security sandbox**.

CLI JSON envelopes and partial batch results are preserved in MCP text and structured content. Failed batch entries set MCP `isError`, even when the outer CLI envelope says `ok: true`. Each CLI invocation has a 45-second deadline (native batch budget: 40 seconds); there is no automatic retry. A timeout or interruption may follow a successful desktop mutation: inspect state before retrying.

## Verification

```sh
node --test server.test.mjs
```

Tests cover MCP discovery/validation, literal argv construction, byte limits, error propagation, no retry, and serialization using an in-memory MCP client. Real stdio smoke checks on this host verified tool discovery, permission status and a native status batch. Finder snapshot/list-apps currently return upstream application/window inventory timeouts; successful desktop interaction remains unverified until that upstream inventory issue is resolved.
