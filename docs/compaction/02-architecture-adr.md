# ADR: Session-native replacement checkpoints

Status: accepted, 2026-08-26.

## Problem

The previous implementation duplicated the main Session JSONL into an event mirror, snapshot sidecar, artifact store, and recall catalog. That made compaction recovery depend on several independently persisted states and required the model to notice missing context before calling recall tools.

## Decision

Compaction is a lossy active-context replacement, not a retrieval-memory subsystem.

```text
active Session context
        | canonical system/messages/tools + local compaction trigger
        | one tool-free compactor call
        v
recent user messages + textual compaction item
        | append CompactionEntry(replacementHistory)
        v
main Session JSONL  ------> resume/tree/audit
        | buildSessionContext()
        v
live Agent messages + later Session entries
```

The main Session JSONL is the only durable truth. A modern `CompactionEntry` stores `replacementHistory`; old raw entries stay append-only. Resume selects the newest checkpoint on the active branch and replays only entries after it.

The checkpoint contains conversation history only. System prompt, tools, model settings, permissions, extension configuration, and environment are current runtime state and are regenerated before each provider request.

No compaction-specific artifact store, typed runtime snapshot, exact-recall tool, or model-managed memory index is retained.

## Consequences

- Active context is bounded and unchanged until compaction actually triggers.
- Resume is deterministic for the compacted context and does not depend on sidecar state.
- Raw pre-compaction history remains available to users/runtime, not to the model as a recall tool.
- Fidelity depends on the compaction item. Tool outputs may need to be re-read or re-run through normal tools.
- A failed/aborted compactor call appends nothing and leaves live context unchanged.
- Multiple compactions can accumulate semantic loss; tests must cover repeated checkpoints and long-task continuation.

## Trigger

Automatic compaction opens when the predicted complete next request reaches `>=95%` of the model context limit, or after overflow. Manual `/compact` always attempts one checkpoint. Trigger evaluation does not mutate context.
