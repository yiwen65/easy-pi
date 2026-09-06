# Native collaboration wiring

This is the internal easy-pi replacement path, not a new public npm API. The CLI/SDK default switch and Grok integration are tracked separately in T-005 of `docs/tasks/2026-09-06-codex-subagent-replacement-task.md` at the repository root. The old DAG default has not been switched by T-004.

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
