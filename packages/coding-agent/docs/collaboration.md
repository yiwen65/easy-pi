# Native collaboration wiring

The CLI/SDK built-in factory now composes native collaboration instead of the old DAG. The six tools are registered when the root session binds its extensions; discovery/help alone opens no team. Persistent teams live under `.epi/agent/teams/<root-session-id>/`; ephemeral roots use memory only. These are internal host APIs, not a new public npm API. Custom ResourceLoaders remain embedding-owned.

## Grok-TUI: `/agents`

Run `/agents` even while root is working. Select a child with Up/Down and Enter to watch its independent session. The focused panel displays model/effort, native history path, execution/residency status, streaming assistant text/thinking, tool calls and tool output. PageUp/PageDown scroll the bounded preview. Alt+Left/Right switches agents; selecting root returns to the unchanged main editor. Escape returns to the list, then closes the panel. Closing the panel does **not** cancel root or children.

Within a child view:

| Default key | Action | Configurable binding |
| --- | --- | --- |
| Ctrl+S | Compose a passive message; Enter submits, Escape cancels | `app.agents.message` |
| Ctrl+F | Compose an explicit new task for an idle child | `app.agents.followup` |
| Ctrl+K | Request interrupt; Enter confirms, Escape cancels | `app.agents.interrupt` |
| Alt+Left / Alt+Right | Previous / next agent | `app.agents.previous` / `app.agents.next` |

Accepted is not consumed/completed. Busy followups are rejected, never silently queued. Rejected drafts remain in the panel for correction. Root tool filters apply to operator actions too. Children inherit live root permissions and cannot use removed root tools, including tools removed mid-turn. The default host reloads only already-approved file extensions, not fresh child extension discovery; inline/custom ResourceLoader integrations must use the explicit host composition below for their child factories.

The viewer is display-only: it does not replace the active `AgentSessionRuntime`, consume mail, inject transcript text, load an idle execution slot, or start a provider call. Event subscriptions replace polling: panel repaint listeners detach on close, and native monitoring detaches on child unload/root shutdown. Preview text is capped at 64 Ki UTF-16 code units, initialized from the latest 100 effective messages. Images are labeled rather than decoded. Cold inspection refuses native files over 4 MiB, symlinks and unknown/mismatched identity/version; it never migrates or rewrites them. The history path identifies the full retained JSONL. This is a runtime inspector, not a full tree/export/editor replacement.

## Upgrade boundary

The local product has been rebuilt with native collaboration only. Existing running sessions are not hot-switched. Legacy runs require their original build; any legacy process-child launch into this build fails closed, without reading the old context or silently becoming an unrestricted root. Old ledgers/worktrees are not converted, cleaned or replayed. `/agents recover` explicitly acquires a dead-owner team without restarting its tasks; a live owner still blocks recovery.

Breaking internal API change: `createEasyPiHarness()` now defaults to native collaboration; use `{ agentDir }` for root storage or `{ nativeSession }` for explicit child authority. The old `subagent` options, process launcher, `/subagents`, `/subagent-models`, DAG tool and legacy private-package exports are retired. `@easy-pi/subagent` exports/bundles only the collaboration contract/controller/mailbox/store, context fork and session host. Recovery source remains in the repository, not in the product; removed harness/launcher/tests have byte snapshots under root `docs/archive/native-subagent-cutover/`.

After an authorized product build, `node scripts/check-native-subagent-product.mjs` (repository root) checks compiled faux spawning, six tools, retired exports, CLI metadata and npm pack inventories offline. This is not an isolated installation, real-provider or physical-terminal acceptance. History disposition/budgets and final recovery-aware source retirement/distribution acceptance remain T-006/T-007.

## Host composition

- Create one `CollaborationStore` and `CollaborationController` per root session. Persistent teams require persistent receiving sessions. Use separate team storage, never the legacy DAG database or project files.
- `registerPiCollaborationTools({ pi, controller, identity, getSession })` in `src/extensions/pi-collaboration-tools.ts` binds the six tools to an exact native session instance. Root identity uses its actual session ID and `/root`.
- The native child host's `registerTools(identity, pi, getSession)` callback binds the same controller to every child, including nested children. Pass live parent permission capabilities through `createEasyPiHarness({ nativeSession: ... })`; do not register this adapter alone and omit the permission harness.
- Bind extensions after assigning the created `AgentSession` to the accessor. Root shutdown stops the team; child unload only closes that child's binding. Replacement sessions need fresh bindings, not reused callbacks.
- `test/pi-collaboration-tools.test.ts` contains the complete offline SDK composition and faux-provider execution of all six tools.

## Message and execution semantics

| Tool | Behavior |
| --- | --- |
| `spawn_agent` | Reserve name, execution capacity and parent completion-mailbox capacity; persist a task receipt; start a native child. Model/effort inherit the live caller unless explicitly overridden. |
| `send_message` | Persist a same-team message and wake a current waiter. Never load, start or resume an idle recipient. |
| `followup_task` | Start an explicit new turn on an idle child; return the persisted task message ID. Reject running children and root targets. |
| `wait_agent` | Observe the caller's pending mailbox or user-input activity. User input wins simultaneous activity; timeout and wait cancellation do not cancel children. |
| `interrupt_agent` | Abort execution without rolling back shared edits. Reject root/self and return the previous status. |
| `list_agents` | Return child status and loaded state, optionally filtered by a canonical path subtree. Completion is not delivery. |

Pending inboxes are capped at 64 messages, including reserved completion slots. Individual text is capped at 8192 UTF-8 bytes. A completed turn and its parent result notification are committed together. Large results carry an explicit truncated preview; complete output remains in the child history. Completion notifications include terminal status. A failed create releases its completion reservation and retains an inspectable failed record.

## Durable ingestion and recovery

Producer callbacks never mutate another AgentSession's live messages. The receiver ingests mail at the public Agent `transformContext` host seam **before** Pi's existing compaction preflight, then chains the previous transform. No private fields or process-global identity are patched. The wrapper is restored on shutdown.

Ingestion uses awaited `sendCustomMessage(..., { triggerTurn: false })` at that boundary. Custom messages contain message ID, root, sender, recipient, turn, kind and text. They are untrusted data, not slash commands or permission grants. Native branch entries provide duplicate detection, including when a later replacement checkpoint summarizes the message. Consumed raw text is not resurrected from pre-checkpoint history.

Only after native persistence/sync is the message acknowledged in the team store. Pi can defer creation of a new root file until its first assistant response; until then the pending envelope is retained, with acknowledgement retried at assistant completion or the next request. There is no cross-database/session-file transaction and no claim of exactly-once model execution. Acknowledgement failure stops admission/request execution; explicit recovery recognizes already-ingested IDs without reinjecting them.

Dead-owner recovery marks interrupted work and emits retained completion notifications; it never replays tasks, tools or provider requests. Shared edits and old DAG data are not cleaned by this adapter. History disposition and actual disk budgets remain T-006 work.
