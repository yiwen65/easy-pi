# Context compaction

Pi uses a Codex-style replacement checkpoint for long sessions. Compaction is inactive until the predicted complete provider request reaches 95% of the model context window, a provider reports overflow, or the user runs `/compact`.

## Checkpoint contents

Pi uses one local handoff path for every provider. It makes one tool-free model request that mirrors the external boundary of Codex Remote Compaction V2. The request keeps the current canonical system prompt, converts the active Session messages through the normal provider-message converter, includes the current tool schemas, then appends a dedicated `local_compaction_trigger` user item. `toolChoice` is forced to `none`; short cache retention and the active Session routing ID allow the unchanged prefix to reuse provider cache. Only when overflow makes that request impossible are tool-result bodies rewritten to a fixed truncation notice in the compactor request; durable history is not changed. The resulting local replacement history contains:

1. the new compaction item as a historical `compactionSummary` message;
2. the latest real user message, only when it fits intact within `keepRecentTokens` (default 8,192 tokens) and the remaining compacted-history budget.

Assistant messages, reasoning, tool calls, and tool results participate in the compactor request but are not retained as a recent tail. Important outcomes must be represented in the compaction item or be re-read/re-run through normal tools.

The compaction item plus retained user message is capped to 5% of the model context window. Pi never retains a clipped suffix of an oversized user message: the compaction item must carry its relevant goal, constraints, and exact anchors. A checkpoint is rejected if it exceeds that history budget or would not reduce the complete projected context.

`/compact <custom instructions>` adds the instructions to the local compaction trigger.

## Persistence and recovery

`SessionManager.appendCompaction()` appends one `CompactionEntry` to the main session JSONL. Its `replacementHistory` field is the exact active message checkpoint. Older entries are never rewritten or deleted.

`buildSessionContext()` finds the newest branch-visible compaction entry with `replacementHistory`, installs it as the base, and replays entries appended after that checkpoint. Older summary-only entries remain readable through the legacy `summary + firstKeptEntryId` path.

There is no compaction artifact store, snapshot sidecar, recall catalog, `recall_search`, or `recall_exact`. Raw history is available to the runtime and user through the session file, tree navigation, and export; it is not an on-demand model memory tool.

## Runtime context boundary

The checkpoint contains conversation messages only. The current system prompt, tool schemas, model, thinking level, permissions, environment, and extension configuration are rebuilt from current runtime state before every provider call. A historical compaction item cannot freeze or override those values. Entries added after the checkpoint supersede stale checkpoint statements.

## Publication and continuation

Compaction publication is ordered:

1. generate one non-empty local handoff and construct its bounded replacement history;
2. validate that the local handoff is non-empty, fits the compacted-history budget, and reduces context;
3. append the complete checkpoint to the main Session JSONL;
4. rebuild `agent.state.messages` from `SessionManager`;
5. notify extensions and continue the turn when overflow recovery or queued work requires it.

If local handoff generation or cancellation fails, no compaction entry is appended and the live context is unchanged. Automatic overflow recovery performs at most one compact-and-retry attempt.

## Commands and configuration

- `/compact [instructions]`: create a checkpoint immediately.
- `/context`: show checkpoint identity, message counts, and token composition.
- `/context inspect`: show the replacement history.
- `/context inspect --full`: additionally show the current system prompt and active tool schemas.
- `PI_HF_COMPACTION=off|full_pipeline`: disable or enable checkpoint compaction. Unknown and retired mode names are rejected.
- `compaction.enabled=false`: disable automatic compaction; manual `/compact` still requires the compaction host to be enabled.

`session_before_compact`, `session_compact`, and `session_compact_failed` remain the extension observation/cancellation boundary. `session_compact` receives the actual persisted `CompactionEntry`, not a synthetic snapshot notification.
