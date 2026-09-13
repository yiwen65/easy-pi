# Native collaboration wiring

The CLI/SDK built-in factory now composes native collaboration instead of the old DAG. The seven delegation tools are registered when the root session binds its extensions, and the child host registers the `deliver_result` protocol tool in every child; discovery/help alone opens no team. Persistent teams live under `.epi/agent/teams/<root-session-id>/`; ephemeral roots use memory only. These are internal host APIs, not a new public npm API. Custom ResourceLoaders remain embedding-owned.

## Grok-TUI: `/agents`

Run `/agents` even while root is working. It opens a framed, viewport-filling modal that hides the main editor while it owns keyboard focus; it is not another message in the transcript. The top hint shows the configured cancel key (Esc by default) and its current destination. Select a child with Up/Down and Enter to watch its independent session. The focused panel displays model/effort, native history path, execution/residency status, streaming assistant text/thinking, tool calls and tool output. PageUp/PageDown scroll the bounded preview. Alt+Left/Right switches agents; selecting root returns to the unchanged main editor. Escape returns to the list, then closes the panel. Closing the panel does **not** cancel root or children.

Within a child view:

| Default key | Action | Configurable binding |
| --- | --- | --- |
| Ctrl+S | Compose a passive message; Enter submits, Escape cancels | `app.agents.message` |
| Ctrl+F | Paste an explicit `followup_task` JSON contract for an idle child (selected target is pinned) | `app.agents.followup` |
| Ctrl+K | Request interrupt; Enter confirms, Escape cancels | `app.agents.interrupt` |
| Alt+Left / Alt+Right | Previous / next agent | `app.agents.previous` / `app.agents.next` |

Accepted is not consumed/completed. Busy followups are rejected, never silently queued. Rejected drafts remain in the panel for correction. Root tool filters apply to operator actions too. Children inherit live root permissions and the intersection of their creation ancestors' tool ceilings. Removed live ancestor tools are denied at the next tool-call boundary, including removals mid-turn. Followups may narrow but never expand a child's ceiling. Unloading an ancestor persists any further narrowing before removing its live binding, so losing an intermediate ancestor's getter (or reopening its stored ceiling) cannot restore that ancestor's revoked tools. Failed child startup releases installed bindings before disposal. This is an execution gate as well as a tool-schema filter, not an OS sandbox; already-admitted operations are not retroactively undone. The default host reloads only already-approved file extensions, not fresh child extension discovery; inline/custom ResourceLoader integrations must use the explicit host composition below for their child factories.

The viewer is display-only: it does not replace the active `AgentSessionRuntime`, consume mail, inject transcript text, load an idle execution slot, or start a provider call. Event subscriptions replace polling: panel repaint listeners detach on close, and native monitoring detaches on child unload/root shutdown. Preview text is capped at 64 Ki UTF-16 code units, initialized from the latest 100 effective messages. Images are labeled rather than decoded. Cold inspection refuses native files over 4 MiB, symlinks and unknown/mismatched identity/version; it never migrates or rewrites them. The history path identifies the full retained JSONL. This is a runtime inspector, not a full tree/export/editor replacement.

## Upgrade boundary

The local product contains native collaboration only. The admission/control/diagnostic optimizations documented here were rebuilt into the installed `dist` on 2026-09-11 after explicit authorization; compiled faux spawning and offline packaging checks passed (see `docs/tasks/2026-09-10-subagent-admission-control-task.md` at the repository root). Existing running sessions are not hot-switched. Legacy runs require their original build; any legacy process-child launch into this build fails closed, without reading the old context or silently becoming an unrestricted root. Old ledgers/worktrees are not converted, cleaned or replayed. `/agents recover` explicitly acquires a dead-owner team without restarting its tasks; a live owner still blocks recovery. Owner liveness is probed by pid plus a recorded process start time, so a recycled pid does not masquerade as a live owner (the start-time probe degrades to the pid probe on platforms without `ps`). The persistent `/agents` error text names the recovery path for a dead owner (`interrupted`) and points to the owning process for a live one (`busy`).

Breaking internal API change: `createEasyPiHarness()` now defaults to native collaboration; use `{ agentDir }` for root storage or `{ nativeSession }` for explicit child authority. The old `subagent` options, process launcher, `/subagents`, `/subagent-models`, DAG tool and legacy private-package exports are retired. `@easy-pi/subagent` exports/bundles only the collaboration contract/controller/mailbox/store, context fork and session host. Recovery source remains in the repository, not in the product; removed harness/launcher/tests have byte snapshots under root `docs/archive/native-subagent-cutover/`.

After an authorized product build, `node scripts/check-native-subagent-product.mjs` (repository root) checks compiled faux spawning, the delegation tool catalog, retired exports, CLI metadata and npm pack inventories offline. This is not an isolated installation, real-provider or physical-terminal acceptance. History disposition/budgets and final recovery-aware source retirement/distribution acceptance remain T-006/T-007.

## Explicit delegation contract

New model and operator calls require the new contract; old `message`/`fork_turns` spawn calls and free-text followups are rejected, not silently translated. Retained session files and version-1 team snapshots remain readable, including records without delegation metadata. Recovery never executes stored calls. Use a new explicit followup to continue a retained child, or a fresh child for independent work.

```json
{
  "task_name": "parser-check",
  "delegation": {
    "version": 1,
    "task": {
      "relationship": "verify",
      "objective": "Check parser handling of empty input",
      "scope": "Parser and parser tests only; do not change files",
      "material": ["src/parser.ts", "test/parser.test.ts"],
      "deliverables": ["Concrete findings with file/line evidence"],
      "acceptance": ["Distinguish verified findings from untested risks"]
    },
    "context": { "mode": "isolated" },
    "capabilities": { "tools": ["read"] }
  }
}
```

`material` identifies task data; it is not automatically read or permission-granting. `scope` is a task boundary, not enforced filesystem confinement. Select capabilities that can actually perform the task: this example cannot run tests, and must report them as not run. `tools: "inherit"` captures the caller's allowed active tools as an upper ceiling; an explicit list can only reduce it. Exclude bash and arbitrary side-effecting extension tools when requesting read-only work. Do not assume that hiding write/edit makes bash read-only. Trusted extensions themselves execute with process permissions and are not sandboxed by this tool gate.

The complete delegation object is capped at 8192 UTF-8 bytes. Model and reasoning overrides remain optional. Each field resolves independently: explicit `model` / `reasoning_effort` > global `subagentModel` / `subagentThinkingLevel` > live caller.

Use `/settings` → **Subagent model** / **Subagent effort** to save global defaults; **Inherit caller** clears each field independently. These settings apply immediately to future children, including nested spawns, but never change the root or existing children/followups. They are global-only, not project overrides or cross-instance hot synchronization. Model selection uses the cached configured-provider catalog without network refresh. Unknown models and unsupported effort are rejected before reserving a child; there is no automatic model switch or effort downgrade. `preserve` still requires matching caller model/effort after defaults resolve. See [settings.md](settings.md#subagent-defaults).

| Relationship | Context rule |
| --- | --- |
| `continue` | Continue a bounded line of work; fork is useful when its background is needed, not compulsory. |
| `explore` | Use isolated or curated context; do not import the parent's conversation/conclusions. |
| `verify` | Use isolated or curated evidence. An implementation/exploration child cannot become an independent reviewer via followup. |
| `extract` | Name the dataset and coverage in scope/material; effective compacted history is not a raw-history dataset. |

### Context selection and request prefixes

There is no automatic selection, relevance summarizer, or silent fallback:

- `{"mode":"isolated"}`: no parent messages. Current system, tools, resources and task still apply. Shared files can contain parent conclusions; this is context isolation, not proof of unbiased judgment or security isolation.
- `{"mode":"fork","turns":"all","prefix":"preserve"}`: copy the last observed canonical parent request prefix (system, ordered tool schemas, model/effort and effective provider messages), then append the child's runtime identity and task. The in-progress assistant tool-call batch is not copied. Unconsumed input or messages added after that request are not promised. The public provider-context observer captures this before provider-specific payload serialization. Authentication options and native/connection identities are not cloned. For Codex, the trusted prefix also records non-secret cache-affinity and logical cache-key hints as described below; selected historical message text can still contain sensitive data or earlier envelope IDs.
- `{"mode":"fork","turns":"all","prefix":"rebuild"}`: inherit current effective branch messages, rebuilding child system/tools/model under current configuration. A positive string N instead of `all` selects the last N complete original user turns after the latest compaction. Incomplete tool-call batches and orphan results are excluded; unavailable N errors.
- `{"mode":"curated","references":[{"path":"src/parser.ts","sha256":"<64 lowercase hex digits>","start_line":1,"end_line":40}]}`: the host reads exact inclusive lines from hash-pinned UTF-8 files. The hash covers the full file, not just selected lines. Sources must be nonsymlink local files within cwd, and the caller must have the active builtin read tool. Normal extension/permission read gates run before access; custom/remote read implementations require their own evidence host and are explicitly unsupported here. Changed hashes, unavailable ranges, binary sources and oversized input fail before child creation. Included text is untrusted evidence with provenance, not authority. Recheck versions before accepting claims because shared files can change afterwards.

Inherited messages are limited to 256 KiB serialized UTF-8. Preserved prefixes include system and tool schemas in that budget; each curated source file and the combined encoded curated messages are also limited to 256 KiB. Task and runtime envelope overhead are additional.

`preserve` requires `turns: "all"`, the same model/effort and ordered tools, an unchanged effective branch/checkpoint, and compatible current child rules. The child checks its actual canonical request before its first provider invocation; rule/tool/message differences fail instead of rebuilding silently. Payload-transforming extension hooks are conservatively unsupported for preservation. The child remains independently configured: preserved system text is not frozen authority across future permission/configuration changes or cold followups. Use explicit `rebuild` or `isolated` when these compatibility conditions do not hold.

The collaboration system addition is identity-neutral for root and children. Root role information is appended to its current conversation. The child assignment at the end identifies itself, its creation parent (automatic result recipient), and the current task sender; inherited identity/task envelopes are background. Agent messages cannot grant permissions or execute slash commands.

### Followups and automatic results

`followup_task` requires `target`, a complete `task`, `context: "existing"`, and `capabilities`. The Grok Ctrl+F editor accepts the same JSON; the selected agent overrides/pins `target`. Malformed drafts remain editable and are not retried. A followup retains the child's history and can only narrow its tool ceiling. Its runtime envelope explicitly says `contextUse: "existing"`; the stored `delegation.context` remains the creation recipe, not a claim of fresh isolation. To obtain a new independent judgment, spawn a fresh agent.

Children are asked to deliver one JSON object by calling the child-side `deliver_result` protocol tool exactly once; a later call replaces the delivered result, and an oversized call is rejected with a hint to compact it and deliver again:

```json
{"summary":"What was done","outcome":"partial","artifacts":[],"evidence":["path/range/hash or check output"],"checks":["What actually ran"],"risks":["Unverified limitations"]}
```

All six fields are required and extra fields are rejected. `summary` and every item in `artifacts`, `evidence`, `checks`, and `risks` must be nonblank strings with schema `maxLength: 2048`; each array allows zero to 16 items. The complete final JSON must fit 8192 UTF-8 bytes. Curated input references are objects, but **result evidence is text**, for example `"src/parser.ts:1-40; sha256=<observed full-file hash>; finding"`, not `{ "path": ..., "sha256": ... }` objects. Cite only observed evidence; do not invent checks to populate an array.

Each initial task and explicit followup appends these output instructions after the assignment, without modifying the inherited request prefix; the validator's `DelegationResultSchema` travels as the input schema of the child's `deliver_result` protocol tool rather than as serialized schema text. This is model guidance plus post-execution validation, not provider-enforced structured output or a guarantee that every model will comply.

`outcome` is `succeeded`, `partial`, `blocked`, or `failed`. A delivered result replaces any earlier delivery in the same turn and overrides the final-text fallback; if the child never calls `deliver_result`, the final assistant text is retained and validated instead, so unstructured narrative output is `invalid`. The controller records `resultValidation.contract` as `valid`, `invalid`, or `not_completed`, with `acceptance: "not_reviewed"` always. Valid format is not proof of the claims. Invalid fallback JSON is not discarded or automatically repaired by another inference request; an oversized `deliver_result` call is rejected at the tool boundary, leaving any earlier delivery in place. The native child history retains full output; the mailbox carries a bounded, explicitly truncated preview if needed. Non-completed turns never receive a successful format verdict. Results return to the creation parent even when another agent sent the followup.

`list_agents` exposes creation projection bytes and measurement scope (`messages` or `request_prefix`), the requested prefix policy (`required` is not itself proof of successful execution), result-format state, and available latest-turn provider-reported input/output/cache usage. Missing sizes/usage are unknown, and interrupted zero usage can be incomplete. These are not current context-token estimates or an additional charge added to parent usage. Successful first-prefix checks also write a noncontextual `epi-collaboration-prefix` entry in native child history.

### Codex preserve cache affinity

For new Codex `preserve` children, the host inherits the caller's effective cache-affinity ID and logical `prompt_cache_key`. The root normally uses its own session ID for both; a nested preserve child inherits the same lineage rather than starting a new one. These non-secret hints live in the child's `epi-collaboration-identity` metadata, not the model-visible history. Persistent idle unload/recovery restores them for explicit followups without replaying inference. Existing child histories without these hints keep their previous independent behavior; they are not rewritten or assigned a guessed lineage.

Native session IDs, files, request IDs, abort signals and resource ownership remain independent. Only the Codex SSE `session-id` header uses the inherited affinity; `x-client-request-id` remains child-specific. Cache-affine Codex requests **always use SSE**, even if the configured preference is `auto`, `websocket` or `websocket-cached`. Root transport preferences are not changed, and isolated/curated/rebuild children and other providers do not inherit this Codex hint. Shared WebSocket affinity/continuation is deliberately not enabled. A low-level request with `cacheRetention: "none"` suppresses cache headers and key, while still keeping an explicit affinity request on SSE.

The low-level `cacheAffinityId` stream/Agent option is distinct from `sessionId` and `promptCacheKey`: it selects this Codex SSE policy without becoming a native or WebSocket pool identity. Other providers ignore it. Metadata is validated before reopening native files; it carries no authentication or authority.

Local Luna/Codex/SSE header-isolation experiments supported `session-id` as a factor in first parent-prefix reuse, independently of `x-client-request-id` (see repository task `docs/tasks/2026-09-11-cache-header-isolation-diagnosis.md`). Cache reuse nevertheless remains opportunistic, not guaranteed savings or latency. These experiments do not establish real server concurrency safety, cross-provider economics, or cache reuse from a WebSocket parent to an SSE child. The affinity fix is source-only until an explicitly authorized build; existing running sessions do not hot-update.

## Host composition

- Create one `CollaborationStore` and `CollaborationController` per root session. Persistent teams require persistent receiving sessions. Use separate team storage, never the legacy DAG database or project files.
- `registerPiCollaborationTools({ pi, controller, identity, getSession })` in `src/extensions/pi-collaboration-tools.ts` binds the seven tools to an exact native session instance. Root identity uses its actual session ID and `/root`.
- The native child host's `registerTools(identity, pi, getSession)` callback binds the same controller to every child. Team tools stay visible in child contexts so preserved prefixes remain byte-identical, but execution is rejected for non-root identities (`nested_delegation`); nested teams are not supported. Custom embeddings should pass the same live root `getDefaults: () => ({ subagentModel, subagentThinkingLevel })` to every `registerPiCollaborationTools` call; otherwise the adapter reads its own session settings. The built-in root already supplies this getter, avoiding stale defaults in child SettingsManager snapshots. Pass live parent permission capabilities through `createEasyPiHarness({ nativeSession: ... })`; do not register this adapter alone and omit the permission harness. Set `subagentEnabled: false` in settings to disable the whole collaboration stack (tools, contract, agents panel) for new sessions.
- Tool checks read a small frozen store projection (path, parent, status, tool ceiling), not the full mailbox. Every query still checks SQLite ownership and `data_version`; external changes force full snapshot revalidation. Successful local commits refresh the projection. Live ancestor/root getters run on each decision, so this is not an allow/deny cache or a claim of zero database I/O.
- Bind extensions after assigning the created `AgentSession` to the accessor. Root shutdown stops the team; child unload only closes that child's binding. Replacement sessions need fresh bindings, not reused callbacks.
- `test/pi-collaboration-tools.test.ts` contains the complete offline SDK composition and faux-provider execution of all seven tools.

## Message and execution semantics

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Validate explicit delegation/context/capabilities, reserve name, execution capacity and parent completion-mailbox capacity, persist a task receipt, and start a native child. Model/effort resolve explicit override → global Subagent default → caller, independently. |
| `send_message` | Persist a same-team message and wake a current waiter. Never load, start or resume an idle recipient. |
| `followup_task` | Start an explicit contracted turn on an idle child with existing context and no capability expansion; return the persisted task message ID. Reject running children and root targets. |
| `wait_agent` | Observe the caller's pending mailbox or user-input activity. User input wins simultaneous activity; timeout and wait cancellation do not cancel children. |
| `interrupt_agent` | Cancel pending startup or abort execution without rolling back shared edits. Reject root/self and return the previous status. |
| `list_agents` | Return child status and loaded state, optionally filtered by a canonical path subtree. Completion is not delivery. |
| `close_agent` | Retire a settled descendant: keep its record, session file and last result for audit while releasing its team slot and native session, and return the previous status. Pending/running children must be interrupted first and descendants closed leaf-first; root, self and other branches are rejected. Idempotent on already-closed agents; closed names are never reused. |
| `deliver_result` | Child-side protocol tool whose input schema is the `DelegationResultSchema`. Captures the structured final result during the turn; a later call replaces the delivered result and an oversized call is rejected with a compact-and-redeliver hint. It is never bound at the root. |

Pending inboxes are capped at 64 messages, including reserved completion slots. Individual text is capped at 8192 UTF-8 bytes. A completed turn and its parent result notification are committed together. Large results carry an explicit truncated preview; complete output remains in the child history. Completion notifications include terminal status. A rejected startup releases its completion reservation after cleanup and retains an inspectable failed/interrupted record; it does not emit a normal completion notification or retry inference.

Closed agents are auditable, not erased: their record, native session file and last result remain inspectable, while the team slot and native session are released. A closed name is never reused — respawning it is rejected as a duplicate and the rejection names the offending agent. `send_message` to a closed agent fails as an unknown receiving agent and `followup_task` reports it busy. Closing is idempotent on already-closed agents and returns the previous status; disposal runs outside the control queue, so closing never blocks message, interrupt or completion commits.

Admission commits the new delegation, task receipt, turn identity, `pending` state and completion reservation together, clearing the previous turn's result, validation and usage before loading. A failed cold followup therefore describes the failed **new** task, never the new objective alongside an old successful result. Native history and previously queued result messages remain retained.

Slow child creation and idle disposal use a separate serial lifecycle queue. They may delay other startups, but do not hold the team's message, interrupt or completion-commit queue. The three child execution slots count both running turns and startup reservations. Cancelling pending startup returns without waiting for a noncooperative host, but its slot remains reserved and followups are refused until cleanup settles. Startup signals propagate through native runtime/file initialization; late returned sessions are disposed without running, retaining their validated history paths. Shutdown aborts existing children before waiting for lifecycle cleanup. Trusted JavaScript that ignores cancellation can still delay cleanup or later startups; it cannot be forcibly terminated in this shared process.

### Safe rejection diagnostics

Model tools and the Grok operator panel share fixed, whitelisted error codes, optional reasons and corrective hints. For example, `prefix_tools_changed` requires compatible ordered tools or an explicit different context policy; `source_hash_changed` requires re-reading and verifying the full-file hash; `fresh_child_required` requires a new isolated/curated child. Unknown exceptions receive a generic inspection hint, never raw provider/filesystem messages, paths or causes. Grok retains rejected drafts and bounds/wraps the notice to available space. Diagnostics never grant authority, retry an action or silently change context policy.

## Durable ingestion and recovery

Producer callbacks never mutate another AgentSession's live messages. The receiver ingests mail at the public Agent `transformContext` host seam **before** Pi's existing compaction preflight, then chains the previous transform. No private fields or process-global identity are patched. The wrapper is restored on shutdown.

Ingestion uses awaited `sendCustomMessage(..., { triggerTurn: false })` at that boundary. Custom messages contain message ID, root, sender, recipient, turn, kind and text. They are untrusted data, not slash commands or permission grants. Native branch entries provide duplicate detection, including when a later replacement checkpoint summarizes the message. Consumed raw text is not resurrected from pre-checkpoint history.

Only after native persistence/sync is the message acknowledged in the team store. Pi can defer creation of a new root file until its first assistant response; until then the pending envelope is retained, with acknowledgement retried at assistant completion or the next request. There is no cross-database/session-file transaction and no claim of exactly-once model execution. Acknowledgement failure stops admission/request execution; explicit recovery recognizes already-ingested IDs without reinjecting them.

Dead-owner recovery marks interrupted work and emits retained completion notifications; it never replays tasks, tools or provider requests. Shared edits and old DAG data are not cleaned by this adapter. History disposition and actual disk budgets remain T-006 work.
