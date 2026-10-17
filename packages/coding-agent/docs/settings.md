# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## Project Trust

On interactive startup, pi asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.pi/agent/trust.json`. Trusting a project allows pi to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.pi/agent/settings.json`, or change it with `/settings`.

`pi config` and package commands use the same project trust flow, except `pi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.pi/agent/trust.json` only; the current session is not reloaded, so restart pi for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `codexServiceTier` | string | omitted | Global-only remembered preference: `"fast"` requests accelerated Codex processing; `"default"` explicitly requests Standard. Independent of thinking level |
| `subagentModel` | string | inherit caller | Global-only default `provider/model` for newly spawned Subagents; does not change root or existing children |
| `subagentThinkingLevel` | string | inherit caller | Global-only default child effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `subagentEnabled` | boolean | `true` | Team collaboration tools (`spawn_agent` and peers). `false` removes the seven tools, the collaboration contract, and the agents panel from new sessions; existing team history remains inspectable |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses and compaction or branch-summary usage |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level. Anthropic, Google, and Bedrock use these natively. OpenAI-compatible models use them when `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`) is set. |

#### Codex Fast mode

Use `/fast on`, `/fast off`, or `/fast` to save or toggle one global preference. Set it once: new and resumed sessions in all projects use that preference, including after tree navigation, fork and clone. `/fast status` shows the global setting, model capability, and latest matching response's sent/reported tiers. Changes apply to the next model request, not an in-flight response or a retry of an already-started summary.

The same setting is available as **Codex service tier default** in `/settings`, or in easy-pi's `~/.epi/agent/settings.json`:

```json
{ "codexServiceTier": "fast" }
```

Both `/fast` and the menu save this global setting. Project settings, temporary settings overrides and historical session/branch preferences do not override it. **Unspecified** removes the global preference, while **Standard** explicitly requests `service_tier: "default"`. Without a preference, requests keep their previous unspecified-tier behavior. Other running Pi processes are not hot-synchronized; they load the saved value on restart.

Fast uses the same model and reasoning effort, sending `service_tier: "priority"`. Initial built-in capability declarations cover GPT-6.1 Sol, GPT-6 Astra, and GPT-5.6 Sol. You can save Fast while using any model; the preference is inactive on unknown/unsupported models and applies when a capable Codex model is selected. Other providers receive no tier from this setting. See [model compatibility overrides](models.md#openai-compatibility) for explicit custom capability declarations.

Fast uses extra subscription usage or credits, including same-session compaction and branch summaries. New and cold-loaded native child sessions snapshot the current global preference and check their own model capability; already-loaded children retain their snapshot. Standalone summaries do not acquire a Fast default implicitly.

**Fast requested is not proof of Fast service.** Model capability does not verify account or regional eligibility. The UI preserves the latest upstream report (`default`, `priority`/`fast`, or unknown), independently of the request. Costs are compatibility estimates, not a subscription bill. Codex's historical default-echo pricing estimate is retained and never overwrites the raw upstream report. Unavailable requests are not silently resubmitted at Standard.

#### Subagent defaults

In `/settings`, select **Subagent model** or **Subagent effort**. The model submenu searches the current cached catalog of configured providers; opening it does not refresh catalogs or call a model. Each field has **Inherit caller**, which removes that global default independently. An unavailable saved model is retained until explicitly changed; it is not silently replaced.

In easy-pi these values are saved to `~/.epi/agent/settings.json` (or the configured agent directory):

```json
{
  "subagentModel": "openai-codex/gpt-5.4",
  "subagentThinkingLevel": "high"
}
```

The example requires that model/provider to be available in your configuration. Remove either key to inherit that field. Project settings and temporary settings overrides do not override these global-only fields.

For each field, precedence is **explicit `spawn_agent` override > global Subagent default > calling agent**. Saving affects subsequent new children immediately, including descendants spawned by already-existing children. Existing children and their followups retain their original model/effort. Other running Pi instances are not hot-synchronized.

Unsupported model/effort combinations are rejected before child admission, not downgraded. Effort choices are independent of the root model, so select a level supported by the intended child model. A differing default also conflicts with `prefix: "preserve"`; explicitly match the caller's model/effort or choose a compatible context policy. No automatic retry or context fallback occurs. See [collaboration.md](collaboration.md).

#### Native subagent storage

`subagentStorage` is a **global-only** operator policy in `~/.epi/agent/settings.json` (or the configured agent directory). Project settings and temporary host overrides cannot enable GC or change these budgets. Invalid fields, types, negative/fractional/overflowing values are rejected rather than silently changing deletion policy.

| Setting | Default | Meaning |
| --- | --- | --- |
| `subagentStorage.autoGc` | `false` | Run one bounded cold-team/log sweep at persistent root startup after acquiring the current team owner |
| `subagentStorage.maxAgeDays` | `0` | Cold-team age threshold; `0` disables age-based deletion |
| `subagentStorage.maxTeamBytes` | `0` | Observed per-team byte threshold for rejecting new spawn/followup admission |
| `subagentStorage.maxTotalBytes` | `0` | Observed team-storage total for admission and optional capacity-based GC |
| `subagentStorage.logMaxAgeDays` | `0` | Managed output-log age threshold |
| `subagentStorage.logMaxTotalBytes` | `0` | Managed output-log capacity target; protected logs remain |

All day/byte values are non-negative safe integers. Zero disables that criterion. Enabling `autoGc` alone, with all thresholds zero, does not delete anything. To inspect a proposed policy without automatic deletion:

```json
{
  "subagentStorage": {
    "autoGc": false,
    "maxAgeDays": 30,
    "logMaxAgeDays": 7
  }
}
```

Run `/agents storage` and `/agents gc` (dry-run); `/agents gc --confirm` explicitly applies the policy. Only set `autoGc: true` after reviewing its candidates. A time/byte threshold is never permission to delete active, unknown or protected data. Capacity-only team GC requires at least 24 hours of coldness. Unconsumed messages, unfinished/interrupted work and unknown legacy history protect teams from automatic GC; manual `/agents delete <root-id>` requires separate confirmation.

Byte budgets are admission safeguards, **not hard disk quotas**. They never truncate existing session history or stop already-admitted work. Team totals cover team databases, child JSONL and child logs, not root JSONL or unrelated files. Bounded/incomplete measurements reject budgeted admission instead of reporting free capacity. SDK memory logs under `<agentDir>/tool-output/` are discoverable. Offline custom session roots, direct embeddings' OS temporary roots without an agent directory, and old unowned OS temporary files are outside global discovery. Closing a child still retains its history; compaction does not shrink JSONL. See [storage lifecycle](collaboration.md#storage-lifecycle) for deletion, retry and `/resume` scope choices.

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`PI_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `tuiMode` | string | `"fullscreen"` | Interactive TUI mode: `"fullscreen"` (default) or `"regular"`. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the resume hint. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost column and keeps it visible, and `"hidden"` hides it. Has no effect in regular TUI mode |

For VS Code, include `--wait` so pi resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. It does not control Easy Pi update checks.

Easy Pi does not use the official Pi update feed. Automatic version checks remain disabled until `EASY_PI_UPDATE_URL` points to an Easy Pi latest-version API endpoint. Set `PI_SKIP_VERSION_CHECK=1` to disable a configured check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `8192` | Maximum tokens for retaining the latest complete user message beside the compaction item |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 8192
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `10` | Maximum agent-level retries for every retryable failure; excludes the initial call |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff, capped at 30s or the base delay when larger |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

Network transport failures (for example DNS, connection, socket, and fetch timeouts), provider-overload errors, 5xx server failures, and other retryable errors share the same `retry.maxRetries` budget. The default allows 10 retries after the initial call, for at most 11 calls in one consecutive failure sequence. A successful response resets the budget for the next model call. Set `retry.maxRetries` to `0`, or disable `retry.enabled`, to prevent automatic retries.

Failures remain visible in the transcript and are saved to session history, including when retries are disabled. Failed attempts are removed from the active model context before retrying. When the budget is exhausted, the current run stops with a final error; the session is retained so you can submit another prompt. Cancellation and quota/billing failures are not retried. This budget is not a total request-duration deadline; header/body idle timeouts still apply separately.

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Pi sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 10,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

Windows paths in JSON must use forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultTools` | string[] | `read`, `bash`, `edit`, `write`, `codemode` | Built-in tools enabled initially. When omitted, Pi uses its standard defaults |
| `codemode.mode` | string | `"on"` | While codemode is active, `"on"` keeps active direct tools declared; `"only"` omits their provider declarations and calls them through scripts |
| `codemode.inlineBudget` | number | `3000` | Non-negative estimated-token budget for tool declarations in the codemode description |

`defaultTools` selects the standard built-in tools enabled at startup; `codemode` is part of the defaults. Other extension and SDK custom tools retain their registration defaults. A list that omits `codemode` turns it off. V2 profile selection is no longer supported:

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

An empty array starts with no built-in tools while preserving extension and SDK custom tools. `--tools` replaces this behavior with a strict allowlist for all tools, `--no-tools` disables all tools, and `--no-builtin-tools` disables the built-in defaults. `--exclude-tools` filters the resulting list. A project `defaultTools` array replaces the global array.

For codemode, keep target tools enabled as well:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "codemode"],
  "codemode": { "mode": "only", "inlineBudget": 3000 }
}
```

In easy-pi, these files are `~/.epi/agent/settings.json` and trusted `.epi/settings.json` by default; use the configured product directories when overridden. `codemode.mode` only changes provider-facing declarations. It does not grant tools, activate explicitly disabled targets, or weaken `--tools`/`excludeTools`. For example, `epi --tools codemode` authorizes no target tools. See [Codemode](codemode.md) for scripts, discovery, branch-local store, and recovery behavior.

MCP's `autoEnableCodemode` belongs to `mcp.json`, not `settings.json`; see [MCP servers](mcp.md#discovery-and-strict-authorization).

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 8192
  },
  "retry": {
    "enabled": true,
    "maxRetries": 10
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
