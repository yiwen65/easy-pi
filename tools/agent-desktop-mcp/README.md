# Agent Desktop MCP for Easy Pi

A standalone stdio MCP server wrapping the macOS `agent-desktop` CLI. No changes to Easy Pi's core, no shell execution, and no FFI dependency. Validated against agent-desktop **0.9.4**, Node **24**, and MCP SDK **1.32.1**.

## Install and register

```sh
cd /absolute/path/to/pi/tools/agent-desktop-mcp
npm ci --ignore-scripts
```

Install the macOS agent-desktop release binary and its adjacent `agent-desktop-macos-helper` from [upstream releases](https://github.com/lahfir/agent-desktop/releases/tag/v0.9.4). Verify the archive against the release's `checksums.txt`. This host uses the independently built PID-inventory fix at `/Users/w/.local/share/agent-desktop/0.9.4-epi-pidfix/agent-desktop`; the original `0.9.4` directory remains available for rollback. See the rebuild instructions below.

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

CLI JSON envelopes and partial batch results are preserved in MCP text and structured content. Failed batch entries set MCP `isError`, even when the outer CLI envelope says `ok: true`. Each CLI invocation has a 45-second deadline (native batch budget: 40 seconds); there is no automatic retry.

Cancellation is checked before queueing and again when the queue slot opens, so a cancelled queued action never starts the CLI. Active calls forward the request's `AbortSignal` to `execFile`; interruption does not prove that desktop effects stopped. Timeouts, interruptions and malformed CLI replies carry `_meta["io.easy-pi/execution-outcome"] = "unknown"`. Easy Pi treats that marker as an uncertain effect, not a confirmed failure, and requires verification before replay. Genuine native error envelopes remain confirmed responses. Inspect desktop state before retrying; neither cancellation nor batch failure rolls back earlier actions.

## Verification

```sh
node --test server.test.mjs
```

Tests cover MCP discovery/validation, literal argv construction, byte limits, error propagation, no retry, and serialization using an in-memory MCP client.

The opt-in native E2E test compiles a temporary AppKit app, uses the **registered global MCP configuration**, and verifies all seven tools against its real UI. It checks headless click counts, Unicode text values, an app-specific keyboard shortcut, and a native click/snapshot batch. It closes its own fixture and deletes only its generated temporary directory. It does not touch existing documents, but it brings the fixture forward and sends a shortcut to that app:

```sh
AGENT_DESKTOP_E2E=1 node e2e/run.mjs
```

Verified on this host after the PID fix: all seven tools pass. Finder list-apps and snapshot also pass. This does not establish support for every app, headed input, or other OS versions.

## Rebuild the upstream PID-inventory fix

Original agent-desktop 0.9.4 rejected the entire workspace inventory when NSWorkspace returned a stale `Device Hub` record with PID `-1`. `patches/skip-invalid-app-pid.patch` skips nonpositive-PID inventory rows only; positive-PID name, duplicate and launch-time checks remain unchanged. The frontmost-app validation is unchanged.

The native regression includes the actual upstream bridge and injects controlled NSWorkspace records. On pristine source it fails; after the patch it passes. Rebuild from the pinned v0.9.4 commit (requires macOS, Xcode command line tools and Rust >=1.89):

```sh
ADAPTER="$PWD" # Run from tools/agent-desktop-mcp
WORK=$(mktemp -d)
curl -fsSL https://github.com/lahfir/agent-desktop/archive/a4a695fdd1f673426579696c7e17074910e799fc.tar.gz -o "$WORK/source.tar.gz"
mkdir "$WORK/source"
tar -xzf "$WORK/source.tar.gz" --strip-components=1 -C "$WORK/source"
cd "$WORK/source"

# Pristine regression fails at the invalid PID assertion (expected).
clang -fobjc-arc -fblocks -framework AppKit -I crates/macos/src/system \
  "$ADAPTER/patches/workspace-inventory.test.m" -o "$WORK/inventory-regression"
"$WORK/inventory-regression"

patch -p1 < "$ADAPTER/patches/skip-invalid-app-pid.patch"
clang -fobjc-arc -fblocks -framework AppKit -I crates/macos/src/system \
  "$ADAPTER/patches/workspace-inventory.test.m" -o "$WORK/inventory-regression"
"$WORK/inventory-regression"
cargo build --locked --release -p agent-desktop -p agent-desktop-macos \
  --bin agent-desktop --bin agent-desktop-macos-helper

DEST="$HOME/.local/share/agent-desktop/0.9.4-epi-pidfix"
mkdir -p "$DEST"
cp target/release/agent-desktop target/release/agent-desktop-macos-helper "$DEST/"
"$DEST/agent-desktop" status
"$DEST/agent-desktop" list-apps --app Finder
"$DEST/agent-desktop" snapshot --app Finder -i --max-depth 3
```

Set the existing `agent_desktop.env.AGENT_DESKTOP_BIN` in `~/.epi/agent/mcp.json` to the patched executable, preserving other settings, then reload/reconnect Easy Pi. To roll back, restore the original binary path. No system permission changes or third-party app shutdown is required by this fix.
