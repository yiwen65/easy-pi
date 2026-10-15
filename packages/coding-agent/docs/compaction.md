# Context compaction

Pi uses a Codex-style replacement checkpoint for long sessions. Compaction is inactive until the predicted complete provider request reaches 95% of the model context window, a provider reports overflow, or the user runs `/compact`.

During a multi-turn agent run, Pi evaluates the completed tool results before starting the next assistant turn. If compaction activates, the same run resumes from the checkpoint, and steering queued while compaction was running is included in that resumed request. No threshold compaction runs after a terminating tool batch when no further assistant turn is needed.

## Model effort and latency diagnostics

Compaction uses the current session model with an explicit `low` reasoning request, independent of the main agent's thinking level. Providers map this request to their supported effort; non-reasoning models may ignore it. The handoff prompt aims for roughly 1,000–2,000 tokens for typical history, less for simple history, but allows more when necessary to preserve continuation facts. This is a soft prompt target, not a hard output cap or a truncation rule. The normal branch-summary path is unchanged.

Every started manual or automatic compaction best-effort appends a `custom` session entry with `customType: "pi-compaction-diagnostics"` when it ends, including failed, rejected, and cancelled attempts. These entries do not enter provider context. They contain no prompt, tool arguments/results, generated handoff text, credentials, or raw error messages.

The version-1 `data` payload contains:

- `reason` (`manual`, `threshold`, or `overflow`) and `outcome` (`activated`, `failed`, or `aborted`; rejected checkpoints are `failed`);
- `durationMs`, measured from the compaction-start event to the end before diagnostic persistence;
- host `stages`: `preparationMs`, `generationMs`, and `validationMs`. Generation includes request conversion, trimming, model calls, outer retry sleeps, and the generator's summary checks. Auth, extension hooks, and checkpoint publication are outside these host stages but included in total duration;
- `attempts`: each outer provider invocation's duration, requested model/provider/API/effort, prompt version, message count, stop reason, and full reported `usage` (including cache, reasoning, and cost fields when supplied);
- per-attempt `firstEventMs`, `firstTextMs`, and `firstThinkingMs`, measured from that invocation's start. Missing events leave their fields absent, not zero. A first event may be headers/start rather than a generated token; these timings cannot independently separate server queueing from prefill;
- `requestIndex`: retries within one summary request share an index; an overflow fallback starts another request;
- `retryCount` and `scheduledRetryDelayMs`: outer retry count and requested sleep total. Actual waits are included in generation time; provider-internal retries remain inside their invocation's duration.

An injected `config.complete` bypasses the production adapter, so its per-provider attempts are unavailable; host phases and total duration are still recorded. A diagnostic write failure never fails compaction or masks its original error. Inspect the session JSONL to compare a slow request's first-text latency, generation interval, cache usage, output/reasoning tokens, and retries before changing models or retry policy. These diagnostics and offline regressions alone do not establish real-provider speedup or handoff quality.

## Checkpoint contents

Pi uses one local handoff path for every provider. It makes one tool-free model request that mirrors the external boundary of Codex Remote Compaction V2. The request keeps the current canonical system prompt, converts the active Session messages through the normal provider-message converter, includes the current tool schemas, then appends a dedicated `local_compaction_trigger` user item. `toolChoice` is forced to `none`; short cache retention and the active Session routing ID allow the unchanged prefix to reuse provider cache. The request budget incorporates recent provider-reported usage when it exceeds the local estimate. When necessary, tool-result bodies are rewritten to a fixed truncation notice in the compactor request; if the provider still reports overflow, Pi retries once with every tool-result body rewritten. Durable history is not changed. The resulting local replacement history contains:

1. the new compaction item as a historical `compactionSummary` message;
2. the latest real user message, only when it fits intact within `keepRecentTokens` (default 8,192 tokens).

Assistant messages, reasoning, tool calls, and tool results participate in the compactor request but are not retained as a recent tail. Important outcomes must be represented in the compaction item or be re-read/re-run through normal tools.

The compaction handoff has no product-level fixed output-token or percentage cap. The compaction provider may use the output space physically available under the model's own limits. Pi never retains a clipped suffix of an oversized user message: the compaction item must carry its relevant goal, constraints, and exact anchors. A checkpoint is rejected when the fixed system/tool/current-input layer fits but adding the compacted history would exceed the model window, or when it would not reduce the previous projected context. If the fixed layer alone already exceeds an artificial or misconfigured model window, Pi still accepts a history-reducing checkpoint because compaction cannot shrink that fixed layer. Output space is clamped by the provider adapter from the room that remains; a configured response reserve does not impose a handoff-size cap.

The handoff recovers an active goal hierarchy instead of treating every later request as a replacement for all earlier goals. It distinguishes durable primary objectives from active, paused, resumed, completed, abandoned, or superseded process objectives. A later message overrides an earlier goal only when it explicitly replaces it or conflicts at the same scope; interleaved process objectives do not silently erase their parent or unresolved siblings.

Historical content is organized in source order as user-led causal episodes: each material user request is followed by the relevant assistant and tool work and the resulting outcome or state. Tool traffic is summarized with the assistant work it supported rather than emitted as a separate ledger. Exact evidence anchors are retained when material. Trivial continuation requests may be folded into the preceding episode without losing whether the requested action occurred. A previous compaction summary is historical prologue, not a synthetic user episode.

The handoff ends with `Current continuation point`, which reconciles the timeline into the active primary and process objectives, their parent chain, paused or open work, applicable constraints, verified current state, and next action. This is a natural-language continuation index, not a machine-readable contract or a second runtime state store. Conversation appended after the checkpoint supersedes conflicting statements from it at the same scope.

`/compact <custom instructions>` adds the instructions to the local compaction trigger.

## Persistence and recovery

`SessionManager.appendCompaction()` appends one `CompactionEntry` to the main session JSONL. Its `replacementHistory` field is the exact active message checkpoint. Older entries are never rewritten or deleted.

`buildSessionContext()` finds the newest branch-visible compaction entry with `replacementHistory`, installs it as the base, and replays entries appended after that checkpoint. Older summary-only entries remain readable through the legacy `summary + firstKeptEntryId` path.

There is no compaction artifact store, snapshot sidecar, recall catalog, `recall_search`, or `recall_exact`. Raw history is available to the runtime and user through the session file, tree navigation, and export; it is not an on-demand model memory tool.

## Runtime context boundary

The checkpoint contains conversation messages only. The session's `prepareRequest` hook refreshes the persisted message projection and current system prompt, tools, model, and thinking level after selected input events and before the provider step binds its schemas and handlers. Retry/recovery failure artifacts intentionally removed from live context are not resurrected from durable history. Explicit next-turn context callbacks retain their in-flight context updates. Subsequent durable additions are merged from the captured branch-entry boundary, without restoring deliberately omitted older entries or duplicating selected inputs; a later checkpoint supersedes that override. Permissions, environment, and extension configuration remain current runtime authority; a historical compaction item cannot freeze or override them. Entries added after the checkpoint supersede stale checkpoint statements.

When `AgentSession` chains an existing `agent.prepareRequest`, that callback receives the refreshed messages and live model, thinking level, system prompt, and tools. Returned context messages can be honored, but model, thinking level, system prompt, and tools remain session-authoritative and are refreshed again after the callback. A compaction projection activated during the callback supersedes its message override.

Post-tool compaction keeps its existing pre-steering scheduling boundary, so steering queued during compaction can join the resumed request. Mailbox and background notification ingestion and extension context transforms still run once through the existing transform pipeline; request preparation does not drain them. That pipeline retains its compaction preflight. The canonical provider-context observer remains after transforms and before provider-specific serialization.

## Publication and continuation

Compaction publication is ordered:

1. generate one non-empty local handoff and construct its replacement history;
2. validate that the local handoff is non-empty, its projected provider input fits the model context window, and compaction reduces context;
3. append the complete checkpoint to the main Session JSONL;
4. rebuild `agent.state.messages` from `SessionManager`;
5. notify extensions and continue the turn when overflow recovery or queued work requires it.

If local handoff generation or cancellation fails, no compaction entry is appended and the live context is unchanged. Automatic overflow recovery performs at most one compact-and-retry attempt.

## Commands and configuration

- `/compact [instructions]`: create a checkpoint immediately.
- `/context`: show checkpoint identity, message counts, and token composition. Zone sizes are calibrated against the most recent provider measurement, and the applied factor is reported here.
- `/context inspect`: show the replacement history.
- `/context inspect --full`: additionally show the current system prompt and active tool schemas.
- `PI_HF_COMPACTION=off|full_pipeline`: disable or enable checkpoint compaction. Unknown and retired mode names are rejected.
- `compaction.enabled=false`: disable automatic compaction; manual `/compact` still requires the compaction host to be enabled.

`session_before_compact`, `session_compact`, and `session_compact_failed` remain the extension observation/cancellation boundary. `session_compact` receives the actual persisted `CompactionEntry`, not a synthetic snapshot notification.
