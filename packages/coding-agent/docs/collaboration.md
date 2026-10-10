# Native collaboration wiring

The CLI/SDK built-in factory now composes native collaboration instead of the old DAG. The nine delegation tools are registered when the root session binds its extensions, and the child host registers the `deliver_result` protocol tool in every child; discovery/help alone opens no team. Persistent teams live under `.epi/agent/teams/<root-session-id>/`; ephemeral roots use memory only. These are internal host APIs, not a new public npm API. Custom ResourceLoaders remain embedding-owned.

## Grok-TUI: `/agents`

Run `/agents` even while root is working. It opens a framed, viewport-filling modal that hides the main editor while it owns keyboard focus; it is not another message in the transcript. The top hint shows the configured cancel key (Esc by default) and its current destination. Select a child with Up/Down and Enter to watch its independent session. The focused panel displays model/effort, native history path, execution/residency status, streaming assistant text/thinking, tool calls and tool output. PageUp/PageDown scroll the bounded preview. Alt+Left/Right switches agents; selecting root returns to the unchanged main editor. Escape returns to the list, then closes the panel. Closing the panel does **not** cancel root or children.

Within a child view:

| Default key | Action | Configurable binding |
| --- | --- | --- |
| Ctrl+T | Retained turn history for the selected child | `app.agents.turns` |
| End | Follow latest runtime preview | `app.agents.latest` |
| Ctrl+S | Compose a passive message; Enter submits, Escape cancels | `app.agents.message` |
| Ctrl+F | Paste an explicit `followup_task` JSON contract for an idle child (selected target is pinned) | `app.agents.followup` |
| Ctrl+K | Request interrupt; Enter confirms, Escape cancels | `app.agents.interrupt` |
| Alt+Left / Alt+Right | Previous / next agent | `app.agents.previous` / `app.agents.next` |

In retained history, Up/Down select a stable turn ID and PageDown fetches the next
metadata page on demand. Enter opens the selected result's full detail; PageUp/Down
scroll that detail rather than changing pages. Escape returns detail → history →
runtime preview → list → main editor, one step at a time. The visible hint names the
current destination. Queries never load a native child, run inference, acknowledge
mail or read referenced reports. Loaded-page usage is a known range, not complete
team billing. Disabled query tools show an unavailable notice without hiding child
rows. Runtime preview scrolling remains independent of retained result scrolling.

Accepted is not consumed/completed. Busy followups are rejected, never silently queued. Rejected drafts remain in the panel for correction. Root tool filters apply to operator actions too. Children inherit live root permissions and the intersection of their creation ancestors' tool ceilings. Removed live ancestor tools are denied at the next tool-call boundary, including removals mid-turn. Followups may narrow but never expand a child's ceiling. Unloading an ancestor persists any further narrowing before removing its live binding, so losing an intermediate ancestor's getter (or reopening its stored ceiling) cannot restore that ancestor's revoked tools. Failed child startup releases installed bindings before disposal. This is an execution gate as well as a tool-schema filter, not an OS sandbox; already-admitted operations are not retroactively undone. The default host reloads only already-approved file extensions, not fresh child extension discovery; inline/custom ResourceLoader integrations must use the explicit host composition below for their child factories.

The viewer is display-only: it does not replace the active `AgentSessionRuntime`, consume mail, inject transcript text, load an idle execution slot, or start a provider call. Event subscriptions replace polling: panel repaint listeners detach on close, and native monitoring detaches on child unload/root shutdown. Preview text is capped at 64 Ki UTF-16 code units, initialized from the latest 100 effective messages. Images are labeled rather than decoded. Cold inspection refuses native files over 4 MiB, symlinks and unknown/mismatched identity/version; it never migrates or rewrites them. The history path identifies the full retained JSONL. This is a runtime inspector, not a full tree/export/editor replacement.

## Upgrade boundary

The local product contains native collaboration only. The admission/control/diagnostic optimizations documented here were rebuilt into the installed `dist` on 2026-09-11 after explicit authorization; compiled faux spawning and offline packaging checks passed (see `docs/tasks/2026-09-10-subagent-admission-control-task.md` at the repository root). Existing running sessions are not hot-switched. Legacy runs require their original build; any legacy process-child launch into this build fails closed, without reading the old context or silently becoming an unrestricted root. Old ledgers/worktrees are not converted, cleaned or replayed. The source root wiring now automatically acquires a verified dead-owner team during startup, marking unfinished turns interrupted without restarting tasks. A live owner still blocks acquisition; if that process later releases the team or exits, initialization is retried before the next root turn. `/agents` and `/agents recover` both retry initialization when no controller was acquired. Owner liveness is probed by pid plus a recorded process start time, so a recycled pid does not masquerade as a live owner (the start-time probe degrades to the pid probe on platforms without `ps`). Invalid storage or mismatched identities remain errors requiring inspection; they are never replaced with an empty team.

Breaking internal API change: `createEasyPiHarness()` now defaults to native collaboration; use `{ agentDir }` for root storage or `{ nativeSession }` for explicit child authority. The old `subagent` options, process launcher, `/subagents`, `/subagent-models`, DAG tool and legacy private-package exports are retired. `@easy-pi/subagent` exports/bundles only the collaboration contract/controller/mailbox/store, context fork and session host. Recovery source remains in the repository, not in the product; removed harness/launcher/tests have byte snapshots under root `docs/archive/native-subagent-cutover/`.

After an authorized product build, `node scripts/check-native-subagent-product.mjs` (repository root) checks compiled faux spawning, the delegation tool catalog, retired exports, CLI metadata and npm pack inventories offline. This is not an isolated installation, real-provider or physical-terminal acceptance. History disposition/budgets and final recovery-aware source retirement/distribution acceptance remain T-006/T-007.

## Explicit delegation contract

Model and operator calls use the flat wire contract below; old `message`/`fork_turns` calls, the `delegation` wrapper and free-text followups are rejected. Retained session files and version-1 team snapshots remain readable, including records without delegation metadata. Recovery never executes stored calls. Use a new explicit followup to continue a retained child, or a fresh child for independent work.

```json
{
  "task_name": "parser-check",
  "task": {
    "objective": "Check parser handling of empty input. Inspect src/parser.ts and test/parser.test.ts only; do not change files. Report concrete findings with file/line evidence and distinguish verified findings from untested risks."
  },
  "relationship": "verify",
  "tools": ["read"]
}
```

`relationship` belongs **beside `task`**, not inside it; `task.objective` is the only required task field, and omitted `relationship` defaults to `continue`. Old nested wire calls are rejected; stored canonical delegations still use `delegation.task.relationship`. `verify` derives isolated context when `context` is omitted. The objective identifies task data and boundaries; it does not automatically read inputs or enforce filesystem confinement. Select tools that can actually perform the task: this example cannot run tests, and must report them as not run. `tools: "inherit"` captures the caller's allowed active tools as an upper ceiling; an explicit list can only reduce it. Exclude bash and arbitrary side-effecting extension tools when requesting read-only work. Do not assume that hiding write/edit makes bash read-only. Trusted extensions themselves execute with process permissions and are not sandboxed by this tool gate.

`task.objective` is capped at 40,000 Unicode characters; the complete delegation has a 256 KiB serialization guard. Child model and reasoning effort resolve independently: global `subagentModel` / `subagentThinkingLevel` > live caller.

Use `/settings` → **Subagent model** / **Subagent effort** to save global defaults; **Inherit caller** clears each field independently. These settings apply immediately to future children, including nested spawns, but never change the root or existing children/followups. They are global-only, not project overrides or cross-instance hot synchronization. Model selection uses the cached configured-provider catalog without network refresh. Unknown models and unsupported effort are rejected before reserving a child; there is no automatic model switch or effort downgrade. `preserve` still requires matching caller model/effort after defaults resolve. See [settings.md](settings.md#subagent-defaults).

| Relationship | Context rule |
| --- | --- |
| `continue` | Continue a bounded line of work; fork is useful when its background is needed, not compulsory. |
| `explore` | Use isolated or curated context; do not import the parent's conversation/conclusions. |
| `verify` | Use isolated or curated evidence. An implementation/exploration child cannot become an independent reviewer via followup. |
| `extract` | Supply curated references that name the dataset; effective compacted history is not a raw-history dataset. |

### Context selection and request prefixes

There is no automatic selection, relevance summarizer, or silent fallback:

- `{"mode":"isolated"}`: no parent messages. Current system, tools, resources and task still apply. Shared files can contain parent conclusions; this is context isolation, not proof of unbiased judgment or security isolation.
- `{"mode":"fork","turns":"all","prefix":"preserve"}`: copy the last observed canonical parent request prefix (system, ordered tool schemas, model/effort and effective provider messages), then append the child's runtime identity and task. The in-progress assistant tool-call batch is not copied. Unconsumed input or messages added after that request are not promised. The public provider-context observer captures this before provider-specific payload serialization. Authentication options and native/connection identities are not cloned. For Codex, the trusted prefix also records non-secret cache-affinity and logical cache-key hints as described below; selected historical message text can still contain sensitive data or earlier envelope IDs.
- `{"mode":"fork","turns":"all","prefix":"rebuild"}`: inherit current effective branch messages, rebuilding child system/tools/model under current configuration. A positive string N instead of `all` selects the last N complete original user turns after the latest compaction. Incomplete tool-call batches and orphan results are excluded; unavailable N errors.
- `{"mode":"curated","references":[{"path":"src/parser.ts","sha256":"<64 lowercase hex digits>","start_line":1,"end_line":40}]}`: the host reads exact inclusive lines from hash-pinned UTF-8 files. The hash covers the full file, not just selected lines. Sources must be nonsymlink local files within cwd, and the caller must have the active builtin read tool. Normal extension/permission read gates run before access; custom/remote read implementations require their own evidence host and are explicitly unsupported here. Changed hashes, unavailable ranges, binary sources and oversized input fail before child creation. Included text is untrusted evidence with provenance, not authority. Recheck versions before accepting claims because shared files can change afterwards.

Forked effective messages and preserved request prefixes have no additional collaboration byte cap; they inherit Pi's current effective context after its normal compaction. Curated evidence remains limited to 256 KiB per source file and 256 KiB for the combined encoded curated messages. Task and runtime envelope overhead are additional.

`preserve` requires `turns: "all"`, the same model/effort and ordered tools, an unchanged effective branch/checkpoint, and compatible current child rules. The child checks its actual canonical request before its first provider invocation; rule/tool/message differences fail instead of rebuilding silently. Payload-transforming extension hooks are conservatively unsupported for preservation. The child remains independently configured: preserved system text is not frozen authority across future permission/configuration changes or cold followups. Use explicit `rebuild` or `isolated` when these compatibility conditions do not hold.

The collaboration system addition is identity-neutral for root and children. Root role information is appended to its current conversation. The child assignment at the end identifies itself, its creation parent (automatic result recipient), and the current task sender; inherited identity/task envelopes are background. Agent messages cannot grant permissions or execute slash commands.

### Followups and automatic results

`followup_task` requires `target` and `task` (with only `objective` inside it); optional top-level `relationship` and `tools` select the relationship and narrow the ceiling. It retains the child's existing context, not a fresh isolated one. The Grok Ctrl+F editor accepts the same JSON; the selected agent overrides/pins `target`. Malformed drafts remain editable and are not retried. A followup retains the child's history and can only narrow its tool ceiling. Its runtime envelope explicitly says `contextUse: "existing"`; the stored `delegation.context` remains the creation recipe, not a claim of fresh isolation. To obtain a new independent judgment, spawn a fresh agent.

Children are asked to deliver one JSON object by calling the child-side `deliver_result` protocol tool exactly once; a later call replaces the delivered result, and an oversized call is rejected with a hint to compact it and deliver again:

```json
{"summary":"Checked src/parser.ts:1-40; observed finding and test result; remaining risk: untested cases","outcome":"partial"}
```

Only `summary` and `outcome` are required. Optional `artifacts` contain at most eight `{path,purpose,sha256?}` report references; other extra fields are rejected. `summary` must be a nonblank string with schema `maxLength: 2048` and should contain the complete result, including key outputs, observed evidence (paths/line ranges/version hashes), checks actually run, and residual risks. The complete result must fit 8192 UTF-8 bytes. Curated input references are objects, but result evidence belongs in the `summary` text, not a separate `evidence` field. Cite only observed evidence; report unperformed checks and uncertainty honestly.

Each initial task and explicit followup appends these output instructions after the assignment, without modifying the inherited request prefix; the validator's `DelegationResultSchema` travels as the input schema of the child's `deliver_result` protocol tool rather than as serialized schema text. A successful `deliver_result` ends the child turn after every already-admitted call in that tool batch settles, so it does not trigger another model request; invalid delivery arguments remain a model-visible tool error that can be corrected on the next turn. This is model guidance plus post-execution validation, not provider-enforced structured output or a guarantee that every model will comply.

`outcome` is `succeeded`, `partial`, `blocked`, or `failed`. A delivered result replaces any earlier delivery in the same turn and overrides the final-text fallback; if the child never calls `deliver_result`, the final assistant text is retained and validated instead, so unstructured narrative output is `invalid`. The controller records `resultValidation.contract` as `valid`, `invalid`, or `not_completed`; `acceptance: "not_reviewed"` is only tolerated when reading legacy records, not written for new results. Valid format is not proof of the claims. Invalid fallback JSON is not discarded or automatically repaired by another inference request; an oversized `deliver_result` call is rejected at the tool boundary, leaving any earlier delivery in place. The native child history retains full output; the mailbox carries a bounded, explicitly truncated preview if needed. Non-completed turns never receive a successful format verdict. Results return to the creation parent even when another agent sent the followup.

`list_agents` exposes creation projection bytes and measurement scope (`messages` or `request_prefix`), the requested prefix policy (`required` is not itself proof of successful execution), result-format state, and available latest-turn provider-reported input/output/cache usage. Missing sizes/usage are unknown, and interrupted zero usage can be incomplete. These are not current context-token estimates or an additional charge added to parent usage. Successful first-prefix checks also write a noncontextual `epi-collaboration-prefix` entry in native child history.

### Retained result lookup and pinned waiting

The source implementation registers `get_agent_result` and `list_agent_turns` and
extends `wait_agent` with a target selector. Existing running sessions are not
hot-switched; source tests are not proof that an installed build has these tools.
`deliver_result` accepts required `summary` and `outcome` plus optional bounded
`artifacts` references, with unchanged 2048-character/8192-byte limits. References
are untrusted claims, not file reads, permission grants or acceptance.

When a result seems missing, query retained work instead of starting inference to
resend it. Admission receipts include `turn_id` and `message_id` (the **task**
receipt). Use `turn_id` for result lookup/waiting; a result lookup by `message_id`
requires the **result notification** ID, available in list/query metadata.

```json
{"target":"worker","turn_id":"<admitted-turn-id>"}
```

Use that input with `get_agent_result` or `wait_agent`. For history, call
`list_agent_turns` with `{"target":"worker","limit":10}` and reuse its
`next_cursor` for the next page. Never sum repeated latest-turn usage snapshots.
A passive `send_message` does not wake an idle child; `followup_task` is for new
work, not retrieving old output. Children cannot call `send_message` or other root
team tools; use `deliver_result` for automatic return to the creation parent.
A fresh isolated/curated verifier is independent context; a followup is continuous
review. For small self-contained tasks choose isolated explicitly when appropriate,
without changing the `continue` default. Read-only tasks need an actual allowlist;
excluding write/edit while retaining bash does not provide a read-only boundary.

#### Result selectors and read-only pages

All queries require live root authority and same-team target/selector ownership,
including closed or unloaded children. They never load/run a child, call a provider,
ack/consume mail, read source files, or inject old messages into normal context.

| `get_agent_result` input | Selection / rejection |
| --- | --- |
| `target` only | Capture this agent's current turn once; closed agents retain their last turn. |
| `target` + `turn_id` | Exact retained turn of that target. |
| `target` + `message_id` | Exact **result notification** ID of that target, not a task/passive message ID. |
| Both IDs, missing target, empty ID, extra fields | `invalid_arguments`; never guess precedence. |
| Known ID belongs to another target/team | `invalid_arguments` (`unknown_turn`) or `forbidden` for foreign authority; never return the other record. |
| Unretained ID, complete history | `invalid_arguments / unknown_turn`. |
| Unretained ID, legacy partial history | `history_unavailable` response; absence cannot prove the turn never existed. |

IDs are nonblank ASCII identifiers of at most 128 characters. Path normalization
uses the existing root-scoped resolver; shape validation alone cannot prove team
membership. `found` returns a turn view and retained result, including invalid
fallback output; `pending` has a pending/running turn and no result; `no_result`
has a known terminal turn without output (for example failed startup).
`history_unavailable` includes target and `retained_only` coverage, not a fabricated
turn. Format validity, child outcome, execution status and parent acceptance are
separate; this protocol has no automatic acceptance verdict.

`list_agent_turns` requires target and accepts `limit` (default 10, integer 1–20)
and an opaque base64url cursor of at most 512 characters. The cursor binds the root,
canonical target, exclusive last sequence and an inclusive high-water sequence
captured on the first page. Validate its encoding and bounds against this team;
a malformed, foreign or mismatched cursor is `invalid_arguments`. Ascending team
sequences are positive safe integers, never reused. Followups admitted after the
high-water mark do not appear mid-pagination. Pages contain turn views, not result
bodies, full delegation or artifacts. `next_cursor: null` means this bounded traversal
is exhausted, not that legacy history is complete. Empty pages must not emit a
nonadvancing cursor. Page metadata may reflect later completion/ack of existing turns;
the cursor fixes membership, not an immutable historical snapshot.

Query previews fit 8192 UTF-8 bytes; truncation preserves Unicode boundaries and
includes any truncation marker in that budget. `truncated: false` is a proven full
result, `true` is a shortened result, and `null` means legacy completeness is unknown.
`source` identifies native history with a turn-level locator and, when proven, an
exact native entry ID; missing/memory-only sources are `unavailable`. A path/entry
reference is not an implicit read or authority grant. Whole result responses fit
64 KiB (including JSON escaping of invalid raw output); whole pages fit 64 KiB and may return fewer than the requested count to fit.
Do not silently drop fields: reject an individually unrepresentable record with
`storage_error`. Task previews are capped at 256 Unicode characters with a separate
`task_truncated` marker. Unknown legacy task text is empty with partial coverage,
not a claim that the assignment was empty.

#### Pinned wait truth table

`wait_agent` allows `target` and optional `turn_id`; a `turn_id` without
`target` is invalid. Without target the existing mailbox/user-input/timeout behavior
is unchanged. With target, resolve and pin the explicit or current turn **once at
entry**, before subscribing. Check before and after subscription to prevent lost
wakeups; subsequent followups cannot replace the pinned turn.

| Observed pinned turn / event | Targeted wait result |
| --- | --- |
| Pending/running, no activity | Stay subscribed to that turn, not arbitrary mailbox arrivals. |
| Completed/failed/interrupted, even already acknowledged | Immediately `terminal`, `timed_out: false`, target, turn ID and result query. |
| Startup failed before result notification | `terminal` with `no_result`; notification is not required. |
| Followup admitted during wait | Keep waiting for the original turn, never the latest one. |
| Close after a terminal turn | Return retained terminal status, not `closed` as a turn status. |
| Dead-owner recovery | Interrupted pinned turn is terminal; no replay or restart. |
| Simultaneous user input and terminal event | `user_input` wins; include pinned target/turn ID. |
| Deadline without user input or terminal event | `timeout`, `timed_out: true`, pinned target/turn ID. |
| Unknown legacy terminal status / missing legacy turn | `context_unavailable / history_unavailable`, not an infinite wait or guessed completion. |
| Cancellation / shutdown / ownership loss | Existing safe error/cancellation path; release timer/listeners and never interrupt the child merely because waiting ended. |

#### Incremental ledger and upgrade boundary

Use indexed per-turn rows in the existing SQLite database, not a growing history
array in every version-1 snapshot. A bounded four-turn fixture compares rewriting
all serialized historical rows with writing only each changed row; this is an
encoded-byte comparison, not a disk/performance benchmark. The memory store follows
the same transactional semantics. Snapshot remains the current agent/mailbox and
small authority projection, not the history container.

Admission writes a new turn, snapshot/task receipt and completion reservation in
one owner/CAS-checked transaction. Completion writes terminal turn, bounded result,
message identity and notification in one transaction. Failure rolls back all of
those changes. Startup failure records the failed/interrupted turn without requiring
a notification. Followup never overwrites older turn task/result/usage. Closing
changes agent lifecycle only; terminal turn status is retained. Recovery changes
active turns to interrupted and records any notification atomically, without replay.
Authority checks must not decode the entire ledger. Read-only pages do not advance
any delivery state.

`CollaborationTurnRecord` defines root/target/sequence/turn identity, task and result
message IDs (null when unknown), bounded task preview, canonical delegation when
known, status, result source/preview/truncation, known timestamps, delivery and usage.
Turn timestamps are epoch milliseconds (`admitted_at`, `started_at`, `finished_at`);
unknown is null, not zero or filesystem mtime. Delivery is `not_enqueued`, `enqueued`,
`acknowledged`, or `unknown`, with nullable enqueue/ack timestamps. Acknowledgement
requires receiving native persistence/sync evidence and is idempotent. It proves
neither model attention nor parent acceptance. There is still no cross-DB/JSONL
transaction or exactly-once execution promise.

Usage coverage is `complete`, `partial`, or `unknown`; each input/output/cache counter
is nullable and provider-reported for this turn only. Aborted/missing reports are
not invented zeros. Legacy latest usage is partial unless completeness is provable;
never copy it into queued older turns or sum repeated latest snapshots. Creation
projection bytes are not current context or usage.

New teams have `complete` history from admission onward. Upgrade seeds **only**
provable latest task/result and already queued result envelopes from the snapshot,
deduplicated by target+turn ID. Historical queued notifications without task receipts
have unknown task IDs/delegations/timestamps/usage. A closed legacy agent without a
provable terminal notification has turn status `unknown`, not guessed completed.
Legacy records/teams remain `retained_only`; future turns cannot make overwritten
past history complete. Do not scan full native histories, infer old acknowledgement,
rewrite real session files or replay. Conflicting provable records fail atomically
with `storage_error` rather than selecting an arbitrary result.

Retention is a same-team cap of **4096 retained turns**, including failed startup
and closed-agent turns. No automatic deletion/pruning on ack, close or recovery.
Each retained turn has at most 256 KiB encoded delegation, 8192 result-preview bytes
and 8192 encoded metadata bytes (remaining identity/time/source fields). Artifact
references stay in the original preview instead of being duplicated in ledger metadata. Thus the
logical payload ceiling is 1088 MiB/team, excluding SQLite/index overhead and native
session files; it is not a physical disk quota. Admission at capacity rejects before
persistence/loading/provider work with `limit_reached / turn_history_full` and a
new-root-session hint. Reads, completion/ack and control of already-admitted work
remain available at capacity. Upgrade overflow rejects atomically without pruning.
The coordinator confirmed this bounded policy in the task authority document;
The store enforces these budgets before admitting a new turn and preserves
control/query access for already-admitted work.

An artifact is `{path, purpose, sha256?}`: nonblank path <=2048 characters, nonblank
purpose <=256, optional lowercase 64-hex SHA256, at most eight refs; path/purpose
cannot contain NUL. All refs count against the complete result's unchanged
8192-byte budget. Queries derive validated refs from the retained preview without
reading the paths. They never trigger execution or acceptance; tests/checks/base
revision remain in the referenced report and are parent-verified. Missing/changed
reports are unavailable evidence, not a reason to restart inference automatically.

### Codex preserve cache affinity

For new Codex `preserve` children, the host inherits the caller's effective cache-affinity ID and logical `prompt_cache_key`. The root normally uses its own session ID for both; a nested preserve child inherits the same lineage rather than starting a new one. These non-secret hints live in the child's `epi-collaboration-identity` metadata, not the model-visible history. Persistent idle unload/recovery restores them for explicit followups without replaying inference. Existing child histories without these hints keep their previous independent behavior; they are not rewritten or assigned a guessed lineage.

Native session IDs, files, request IDs, abort signals and resource ownership remain independent. Only the Codex SSE `session-id` header uses the inherited affinity; `x-client-request-id` remains child-specific. Cache-affine Codex requests **always use SSE**, even if the configured preference is `auto`, `websocket` or `websocket-cached`. Root transport preferences are not changed, and isolated/curated/rebuild children and other providers do not inherit this Codex hint. Shared WebSocket affinity/continuation is deliberately not enabled. A low-level request with `cacheRetention: "none"` suppresses cache headers and key, while still keeping an explicit affinity request on SSE.

The low-level `cacheAffinityId` stream/Agent option is distinct from `sessionId` and `promptCacheKey`: it selects this Codex SSE policy without becoming a native or WebSocket pool identity. Other providers ignore it. Metadata is validated before reopening native files; it carries no authentication or authority.

Local Luna/Codex/SSE header-isolation experiments supported `session-id` as a factor in first parent-prefix reuse, independently of `x-client-request-id` (see repository task `docs/tasks/2026-09-11-cache-header-isolation-diagnosis.md`). Cache reuse nevertheless remains opportunistic, not guaranteed savings or latency. These experiments do not establish real server concurrency safety, cross-provider economics, or cache reuse from a WebSocket parent to an SSE child. The affinity fix is source-only until an explicitly authorized build; existing running sessions do not hot-update.

## Host composition

- Create one `CollaborationStore` and `CollaborationController` per root session. Persistent teams require persistent receiving sessions. Use separate team storage, never the legacy DAG database or project files.
- `registerPiCollaborationTools({ pi, controller, identity, getSession })` in `src/extensions/pi-collaboration-tools.ts` binds the nine tools to an exact native session instance. Root identity uses its actual session ID and `/root`.
- The native child host's `registerTools(identity, pi, getSession)` callback binds the same controller to every child. Team tools stay visible in child contexts so preserved prefixes remain byte-identical, but execution is rejected for non-root identities (`nested_delegation`); nested teams are not supported. Custom embeddings should pass the same live root `getDefaults: () => ({ subagentModel, subagentThinkingLevel })` to every `registerPiCollaborationTools` call; otherwise the adapter reads its own session settings. The built-in root already supplies this getter, avoiding stale defaults in child SettingsManager snapshots. Pass live parent permission capabilities through `createEasyPiHarness({ nativeSession: ... })`; do not register this adapter alone and omit the permission harness. Set `subagentEnabled: false` in settings to disable the whole collaboration stack (tools, contract, agents panel) for new sessions.
- Tool checks read a small frozen store projection (path, parent, status, tool ceiling), not the full mailbox. Every query still checks SQLite ownership and `data_version`; external changes force full snapshot revalidation. Successful local commits refresh the projection. Live ancestor/root getters run on each decision, so this is not an allow/deny cache or a claim of zero database I/O.
- Bind extensions after assigning the created `AgentSession` to the accessor. Root shutdown stops the team; child unload only closes that child's binding. Replacement sessions need fresh bindings, not reused callbacks.
- `test/pi-collaboration-tools.test.ts` contains the complete offline SDK composition and faux-provider execution of all nine tools; history/targeted-wait store regressions are under `packages/subagent/test/collaboration-*.test.ts`, and display/monitor regressions cover paging, malformed metadata and immutable mouse frames. These are offline source checks, not a physical-terminal or real-provider guarantee.

## Message and execution semantics

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Validate explicit delegation/context/capabilities, reserve name, execution capacity and parent completion-mailbox capacity, persist a task receipt, and start a native child. Model/effort resolve explicit override → global Subagent default → caller, independently. |
| `send_message` | Persist a same-team message and wake a current waiter. Never load, start or resume an idle recipient. |
| `followup_task` | Start an explicit contracted turn on an idle child with existing context and no capability expansion; return the persisted task message ID. Reject running children and root targets. |
| `wait_agent` | With target, pin the specified/current turn and return terminal result even after ack. Without target, observe pending mailbox/user input, not history. User input wins; timeout/cancellation do not cancel children. |
| `get_agent_result` | Read one retained result by target/current turn, explicit turn ID or result notification ID. No child loading/inference, mailbox consumption or source reading. |
| `list_agent_turns` | Metadata-only history pages with scoped cursor/high-water membership and explicit coverage. No loading/inference or mailbox consumption. |
| `interrupt_agent` | Cancel pending startup or abort execution without rolling back shared edits. Reject root/self and return the previous status. |
| `list_agents` | Return child status and loaded state, optionally filtered by a canonical path subtree. Completion is not delivery. |
| `close_agent` | Retire a settled descendant: keep its record, session file and last result for audit while releasing its team slot and native session, and return the previous status. Pending/running children must be interrupted first and descendants closed leaf-first; root, self and other branches are rejected. Idempotent on already-closed agents; closed names are never reused. |
| `deliver_result` | Child-side protocol tool whose input schema is the `DelegationResultSchema`. Captures the structured final result during the turn; a later call replaces the delivered result and an oversized call is rejected with a compact-and-redeliver hint. It is never bound at the root. |

Pending inboxes are capped at 64 messages, including reserved completion slots. Individual text is capped at 8192 UTF-8 bytes. A completed turn and its parent result notification are committed together. Large results carry an explicit truncated preview; complete output remains in the child history. Completion notifications include terminal status. A rejected startup releases its completion reservation after cleanup and retains an inspectable failed/interrupted record; it does not emit a normal completion notification or retry inference.

Closed agents are auditable, not erased: their record, native session file and last result remain inspectable, while the team slot and native session are released. A closed name is never reused — respawning it is rejected as a duplicate and the rejection names the offending agent. `send_message` to a closed agent fails as an unknown receiving agent and `followup_task` reports it busy. Closing is idempotent on already-closed agents and returns the previous status; disposal runs outside the control queue, so closing never blocks message, interrupt or completion commits. Each root team retains at most 2048 child-agent records, including closed agents; when full, `spawn_agent` rejects with `team_history_full` before persistence. Start a new root session for more children; closing does not delete records or make names reusable.

Admission commits the new delegation, task receipt, turn identity, `pending` state and completion reservation together, clearing the previous turn's result, validation and usage before loading. A failed cold followup therefore describes the failed **new** task, never the new objective alongside an old successful result. Native history and previously queued result messages remain retained.

Slow child creation and idle disposal use a separate serial lifecycle queue. They may delay other startups, but do not hold the team's message, interrupt or completion-commit queue. The 15 child execution slots (16 total, with one reserved for root) count both running turns and startup reservations. Cancelling pending startup returns without waiting for a noncooperative host, but its slot remains reserved and followups are refused until cleanup settles. Startup signals propagate through native runtime/file initialization; late returned sessions are disposed without running, retaining their validated history paths. Shutdown aborts existing children before waiting for lifecycle cleanup. Trusted JavaScript that ignores cancellation can still delay cleanup or later startups; it cannot be forcibly terminated in this shared process.

Completed turns release execution capacity but retain native sessions for explicit followups. Persistent teams keep at most 15 loaded children and unload the least recently used resource-idle child when another session needs loading. The native host's `canUnload()` excludes active inference, disposal, and running/stopping background tasks: a completed turn does not prove its processes have ended. If every loaded child still owns work, new loading is rejected with `loaded_sessions_full`; existing work, results and control operations remain usable. Memory-only teams retain their contexts within the separate team-agent bound because they cannot cold-load history.

Child background completion uses `nextRequest`, even when the root selects `wake` or `followUp`. Notifications remain available to an explicit followup; they cannot launch unassigned child inference after a delivered result. The root's delivery setting is unchanged. Explicit close/root shutdown drains owned background processes and transport resources, releases authority and monitoring subscriptions, and retains result/history records. Incomplete native shutdown reports reject disposal. Failed disposal keeps the live team owner and its session references until operator inspection or process exit, instead of letting another controller acquire uncertain resources. Codex native-session cleanup also releases per-session transport counters and sticky SSE fallback markers without clearing another session's metadata.

The opt-in `subagent-lifecycle-real-provider.test.ts` validates pressure unloading, cold followup, background ownership, wake suppression, foreground interrupt, concurrent inference, transport cleanup and cold reopening. `subagent-cli-real-provider.test.ts` runs the source `pi-test.sh --mode rpc` entry with a real root/child model and verifies clean exit plus zero-inference retained-team inspection. Both require `PI_REAL_MODEL_EVAL=1`; user teams are untouched and credentials are referenced, never copied into the tests or their output. These checks do not establish physical Computer/native-app drain, arbitrary extension cooperation, or installed-binary acceptance.

### Safe rejection diagnostics

Model tools and the Grok operator panel share fixed, whitelisted error codes, optional reasons and corrective hints. For example, `prefix_tools_changed` requires compatible ordered tools or an explicit different context policy; `source_hash_changed` requires re-reading and verifying the full-file hash; `fresh_child_required` requires a new isolated/curated child. Unknown exceptions receive a generic inspection hint, never raw provider/filesystem messages, paths or causes. Grok retains rejected drafts and bounds/wraps the notice to available space. Diagnostics never grant authority, retry an action or silently change context policy.

## Durable ingestion and recovery

Producer callbacks never mutate another AgentSession's live messages. The receiver ingests mail at the public Agent `transformContext` host seam **before** Pi's existing compaction preflight, then chains the previous transform. No private fields or process-global identity are patched. The wrapper is restored on shutdown.

Ingestion uses awaited `sendCustomMessage(..., { triggerTurn: false })` at that boundary. Custom messages contain message ID, root, sender, recipient, turn, kind and text. They are untrusted data, not slash commands or permission grants. Native branch entries provide duplicate detection, including when a later replacement checkpoint summarizes the message. Consumed raw text is not resurrected from pre-checkpoint history.

Only after native persistence/sync is the message acknowledged in the team store. Pi can defer creation of a new root file until its first assistant response; until then the pending envelope is retained, with acknowledgement retried at assistant completion or the next request. There is no cross-database/session-file transaction and no claim of exactly-once model execution. Acknowledgement failure stops admission/request execution; explicit recovery recognizes already-ingested IDs without reinjecting them.

Dead-owner recovery marks interrupted work and emits retained completion notifications; it never replays tasks, tools or provider requests. Shared edits and old DAG data are not cleaned by this adapter. History disposition and actual disk budgets remain T-006 work.

## End-to-end contract validation

From `packages/coding-agent`, run the opt-in real CLI contract tests with:

```bash
PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run test/subagent-e2e-real-provider.test.ts --silent=false
```

The default model is `openai-codex/gpt-6.1-sol` with `medium` effort for root and children. Explicit test overrides use `PI_REAL_SUBAGENT_PROVIDER`, `PI_REAL_SUBAGENT_MODEL` and `PI_REAL_SUBAGENT_EFFORT`; model and effort resolve independently through `subagent-real-config.ts`. CLI state and retained child metadata verify the requested configuration. The tests run isolated synthetic work through `pi-test.sh --mode rpc`, inspect JSONL/SQLite/filesystem effects, and cleanly close their processes. Prompt acceptance or a model's final statement is not sufficient evidence.

The contract suite covers live capability narrowing, known no-effect admission rejection, isolated/curated/fork context, passive mail and explicit followup, pinned historical results, execution-versus-task-outcome separation, crash recovery without effect replay, and same-cwd team isolation. Precise quota/byte/race/fault boundaries remain deterministic regressions. A pre-admission rejection such as an invalid nested capability or fresh-reviewer requirement must carry `not_started` certainty, while a failed admission commit or disposal after mutation retains the existing unknown-effect/reconciliation boundary. No test automatically retries an uncertain effect.
