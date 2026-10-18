# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Where `<path>` is the working directory with `/` replaced by `-`.

## Deleting Sessions

Sessions can be removed by deleting their `.jsonl` files under `~/.pi/agent/sessions/`. V4 image assets are separate in `<session.jsonl>.images/`: deleting only the log does not erase those image bytes. Do not delete an image directory while its owning session is live. There is no automatic global image GC.

Pi also supports deleting sessions interactively from `/resume` (select a session and press `Ctrl+D`, then confirm). When available, pi uses the `trash` CLI to avoid permanent deletion.

## Session Discovery Index

The resume picker uses a disposable summary/search projection under the resolved agent directory's `session-index/v1/` (easy-pi default: `~/.epi/agent/session-index/v1/`). Each source file has one hashed-path cache entry. A hit requires the source device, inode, byte size, modification time and change time to match; the JSONL remains the authority. Missing, corrupt, outdated or unwritable indexes fall back to scanning the source. The first unindexed load can therefore still take time; available rows are shown while other files load.

The projection preserves the existing user/assistant message-body search text, so fuzzy, quoted-phrase and `re:` searches do not become title-only searches. It does not store tool results, image data or recovery snapshots. **It can contain private conversation text**, so its files/directories are private. Removing this derived directory only makes later listings rebuild it; it does not remove or change sessions. Successful picker deletion also best-effort removes that session's search projection. Manual/external session deletion is detected on lookup, but is not an immediate cache-erasure operation.

Known successful session appends update the in-process projection without rereading old history. Existing full-load and rewrite operations build projections while already reading their entries. Only files used by listing enable disk caching; an existing disk index keeps that interest enabled when a fresh writer loads and appends to the session, even without reopening the picker. Opening a never-listed native child alone does not create a persistent search index for it. Cache publication is atomic and best effort, not part of the session's durability or recovery protocol. External edits, truncation or file replacement cause a rebuild rather than a guessed append-only update. Very large search projections may deliberately bypass the bounded cache without truncating search results.

The picker hides **initialization-only** sessions by default. These have no meaningful name or content beyond their header, model/thinking settings and known initialization metadata. Use `Ctrl+Shift+E` (`app.session.toggleEmptyFilter`) to show/hide them; no session file is deleted. This is not a `messageCount === 0` filter: named sessions, custom messages, checkpoints, labels, recovery state and unknown extension state are conservatively retained. The optional `SessionInfo.isMetadataOnly` flag classifies this state; SDK `list`/`listAll` still return all valid sessions. Progress callbacks may receive a third argument containing the currently available, scope-filtered `SessionInfo` rows; existing two-argument callbacks remain valid.

When no first user text exists, the picker distinguishes `(not started)`, `(session state)` and `(no user text)` without changing the SDK's `firstMessage` fallback. If your terminal cannot distinguish `Ctrl+Shift+E`, remap `app.session.toggleEmptyFilter` in keybindings.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification); inline portable images
- **Version 4**: New native sessions use `imageEncoding: "assets-v1"` with session-owned image assets

New persistent sessions use v4. Existing v1–v3 sessions are not automatically converted to v4: legacy logical migrations to v3 still apply, but opening alone does not rewrite the file or create durable originals. Continued legacy writes remain inline. Portable JSONL export uses v3 inline prepared images, without original-source metadata.

## Source Files

Source on GitHub ([pi-mono](https://github.com/earendil-works/pi-mono)):
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) - Session entry types and SessionManager
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/` and `node_modules/@earendil-works/pi-ai/dist/`.

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (from pi-ai)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  usage?: Usage;      // Nested LLM work performed by the tool
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number; // subset of cacheWrite, when reported
  reasoning?: number;    // subset of output, not additional tokens
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

The exported pi-ai `StopReason` type also includes `"pending"`, but that value is reserved for partial messages in streaming events. Terminal `done`/`error` messages replace it with a completion reason before pi persists the assistant message, so `"pending"` should never appear in session JSONL.

### Extended Message Types (from pi-coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":4,"imageEncoding":"assets-v1","id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":4,"imageEncoding":"assets-v1","id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### Image storage (v4)

Native v4 physical image blocks replace Base64 `data` with an `imageAsset` reference. Optional `imageSource` links the separately retained original to the prepared image. Schematic block (digest placeholders are not valid hashes):

```json
{"type":"image","mimeType":"image/png","imageAsset":{"version":1,"sha256":"<prepared SHA-256>","byteLength":1200,"mimeType":"image/png"},"imageSource":{"version":1,"asset":{"version":1,"sha256":"<original SHA-256>","byteLength":8000,"mimeType":"image/png"},"dimensions":{"originalWidth":4000,"originalHeight":2000,"width":2000,"height":1000}}}
```

Both asset digests are SHA-256 of binary bytes, not Base64. Files live under `<session.jsonl>.images/<sha256>`, without extensions. Keep the native log and its asset directory together when copying/backing up. Assets are published before their referencing log records; fork/clone copy required assets into the destination session's ownership scope. A hash does not authorize access to another session's assets.

`SessionManager`, `loadEntriesFromFile(path)` and `parseSessionEntries(text, owningSessionPath)` return hydrated logical `ImageContent` with standard Base64 `data`, not `imageAsset`. If only the prepared asset is missing/corrupt, loading can recover the separately verified original with an explicit local notice and restored original raster dimensions. If only the original is unavailable, the usable prepared image remains with an original-unavailable notice and no false source link. If neither is usable, local omission text preserves surrounding tool facts. Original-source reads separately validate ownership, length and digest, and return classified `storage_missing`/`storage_invalid` errors. Supply the owning session path when parsing native asset references; raw `JSON.parse` does not hydrate them.

The codec visits known image-bearing message/custom-message content, compaction replacement history and defined task recovery/interruption fields only. Tool arguments, extension details and signature/encrypted blocks remain opaque. Bounded malformed tool-image evidence can remain inline when no valid asset reference can be made.

`imageSource` is app-only metadata, not a provider file ID. It is stripped before provider serialization and portable export. Portable JSONL/HTML export inlines prepared images and does **not** bundle originals. Legacy sessions do not gain a source by relabeling a prepared image. In-memory sessions have bounded local source storage (32 sources / 32 MiB), no durable path, and explicit local/RPC reads while the session lives.

`/images sources` lists only sources attached to known messages/custom messages and compaction replacement-history content on the active branch, deduplicated by source digest; arbitrary opaque metadata is not an attachment. `/images source <ID>` previews explicitly and never creates a provider message. `SessionManager.auditImageAssets()` checks whole-log reachability/missing/orphan candidates without deleting anything; branch-inactive does not mean disposable. See [Images](images.md) for report levels, source access and privacy.

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

Created when context is compacted. Modern entries store the complete active message checkpoint in `replacementHistory`:

```json
{"type":"compaction","id":"f6a7b8c9","parentId":"e5f6a7b8","timestamp":"2024-12-03T14:10:00.000Z","tokensBefore":50000,"replacementHistory":[{"role":"compactionSummary","summary":"User discussed X, Y, Z...","tokensBefore":50000,"timestamp":1733235000000},{"role":"user","content":"latest request","timestamp":1733234940000}]}
```

`replacementHistory` is a materialized `AgentMessage[]`, not an additional tail appended to a separately reconstructed summary. Pi installs it verbatim as the context base, then replays later branch entries. The local compactor retains its handoff and, when it fits intact, the latest real user message; see [compaction.md](compaction.md). Original entries remain in the append-only log.

Legacy summary-only entries remain readable:

```json
{"type":"compaction","id":"f6a7b8c9","parentId":"e5f6a7b8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional fields:
- `usage`: Full reported `Usage` from summary generation, including cache, cost and optional reasoning fields; included in session token and cost totals when present
- `replacementHistory`: Complete modern checkpoint; absent on legacy summary-only entries
- `summary`, `firstKeptEntryId`: Legacy summary and retained-entry boundary; omitted by modern checkpoint publication
- `details`: Implementation-specific data
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `usage`: LLM usage from generating the summary; included in session token and cost totals
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if pi-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `pi.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

Version-1 `pi-compaction-diagnostics` entries remain outside provider context, but valid full attempt `Usage` records from `failed`/`aborted` outcomes contribute to token/cost totals. Activated diagnostics are excluded because checkpoint `usage` already accounts for them. Missing/malformed usage is ignored, not reconstructed; see [compaction diagnostics](compaction.md#model-effort-and-latency-diagnostics).

Native `pi-task-recovery` entries copied into a new fork/clone carry an optional top-level `sourceSessionId`. They remain historical evidence, including their queued inputs and unresolved effects, but are ignored as executable recovery state in the new session. Reopening the fork does not revive the copied task.

#### Recovery field storage

Recovery records can include a **physical-only** top-level encoding marker:

```json
{"type":"custom","customType":"pi-task-recovery","id":"snapshot2","parentId":"snapshot1","timestamp":"2026-01-01T00:00:01.000Z","data":{"version":2,"id":"task1","status":"running"},"recoveryStorage":{"version":1,"refs":{"prompt":{"entryId":"snapshot1","sha256":"<64 lowercase hex digits>"}}}}
```

This abbreviated example illustrates the encoding, not a complete executable task state. Only `prompt`, `systemPrompt`, and `suspendedTasks` may be referenced. The referenced field is omitted from physical `data`; it must exist inline in an earlier recovery record in the same file. The digest is SHA-256 of the field's UTF-8 `JSON.stringify` representation. References are direct, never chains. Fields smaller than 512 bytes, or whose references would cost more space, remain inline.

`SessionManager`, `loadEntriesFromFile()` and `parseSessionEntries()` return the complete logical `data` and omit `recoveryStorage`. Raw `JSON.parse` consumers see the storage representation instead. Missing, malformed, unsupported-version or mismatched references fail loading rather than authorizing tool replay. Content sharing does not share execution authority: branch selection, receipts and `sourceSessionId` remain authoritative.

New appends reuse committed fields; merely opening an old file does not rewrite it. Repair, clone and fork re-encode selected logical entries into self-contained native sessions (including required image assets for v4). Portable JSONL export inlines prepared images and strips original-source links. Recovery text-field sharing itself requires no sidecar or global object store. JSONL export writes records incrementally; normal existing output files can be atomically replaced, existing symbolic links resolve to their target, and multiply hard-linked output files are refused.

Restart old drivers before using reference-encoded files. Older readers do not understand this storage representation. Recovery-field sharing does not itself change the task-state schema or session header version; v4 image encoding is a separate feature.

#### Non-destructive recovery-log compaction

From a source checkout, create a smaller **same-identity copy** of a closed/quiescent session:

```bash
node --import ./scripts/source-resolver.mjs scripts/compact-session-recovery.mjs \
  /path/to/source.jsonl /path/outside-live-sessions/compacted.jsonl
```

The command refuses existing outputs and in-place rewrites. It stages the copy, verifies every logical entry (including IDs, parent links, timestamps, recovery payloads and provenance), checks that the source has not changed, then publishes the output exclusively. Damaged history is rejected rather than silently discarded. Its report contains counts and byte sizes, not conversation content.

The original is never replaced or deleted. The copy retains the original session ID and recovery authority: do not run both copies concurrently. Stop the old driver before choosing which copy to use; installation and backup removal remain explicit user actions. Space is not reclaimed until old files/backups and any open references to their inodes are released. This encoding reduces duplicate storage; the separate [discovery index](#session-discovery-index) avoids rescanning unchanged logs for `/resume`.

Codex service preference is now remembered in global settings, not session entries. Historical `customType: "codex-service-tier"` entries are retained but ignored for preference resolution and never enter model context; new toggles do not append them. Resuming, branching, forking or cloning uses the current global preference. Codex assistant messages may separately contain `serviceTier: { requested?, sent?, reported?, costEstimated? }`. `reported` is the raw upstream value; missing/null is unknown and never inferred from the preference or compatibility price estimate.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `pi.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildSessionContext()` walks the current leaf's path and produces the effective message list for the LLM:

1. Extracts model and thinking level from the full path.
2. Finds the newest branch-visible compaction with `replacementHistory`, installs that array as the complete context base, and converts entries after it to messages.
3. Without a modern checkpoint, uses `buildContextEntries()` for the legacy `summary + firstKeptEntryId` selection.

Entry conversion maps `message` to its stored `AgentMessage`, legacy `compaction` to `compactionSummary`, `branch_summary` to `branchSummary`, and `custom_message` to `CustomMessage`. Plain `custom` entries do not enter context.

`buildContextEntries()` returns entries, not the materialized replacement messages: it selects the latest compaction, any legacy kept-entry range, and subsequent entries. Use `buildSessionContext().messages` for the effective modern checkpoint. `buildTranscriptEntries()` separately preserves the visible branch history across modern checkpoints; legacy summaries retain their historical summary-plus-tail display behavior.

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?)` - New session
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?)` - Continue most recent or create new
- `SessionManager.inMemory(cwd?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork session from another project

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?)` - List all sessions across all projects

### Instance Methods - Session Management
- `newSession(options?)` - Start a new session (options: `{ parentSession?: string }`)
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompactionCheckpoint(replacementHistory, tokensBefore, usage?)` - Add a modern complete checkpoint
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?, usage?, replacementHistory?)` - Add a legacy summary entry, optionally with a replacement checkpoint
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Images
- `attachImageSource(prepared, source, dimensions?)` - Associate a retained original snapshot with a prepared logical image; legacy persistent sessions return the prepared image without durable source metadata
- `readImageSource(ref)` - Read bounded original bytes through the owning session's store checks; callers exposing reads must additionally enforce active-branch membership
- `getImageSourcePath(ref)` - Verified local asset path for explicit use, or `undefined` in memory; not a default diagnostic field
- `auditImageAssets()` - Read-only whole-log reachable/missing/orphan audit; never GC

### Instance Methods - Context & Info
- `buildContextEntries()` - Get selected branch entries, not materialized replacement messages
- `buildTranscriptEntries()` - Get visible branch entries, retaining history across modern checkpoints
- `buildSessionContext()` - Get effective checkpoint messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
