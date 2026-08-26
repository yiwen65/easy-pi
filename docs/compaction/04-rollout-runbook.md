# Compaction checkpoint runbook

## Observe

- `/context` shows checkpoint ID, replacement/tail message counts, provider-context identity, and token zones.
- `/context inspect` shows replacement history.
- `/context inspect --full` also shows the current system prompt and active tool schemas.
- Session JSONL should contain a branch-visible `compaction` entry with non-empty `summary` and `replacementHistory`.

## Failure symptoms

| Symptom | Interpretation | Action |
| --- | --- | --- |
| `Compaction rejected: ...` | Compaction-item generation failed or returned empty | Retry `/compact`; verify model/auth/network |
| Provider request blocked after required compaction | Compaction did not commit and the projected request still exceeds the window | Reduce context or switch to a larger-context model |
| Resume shows raw old history | Session has no modern branch-visible checkpoint | Compact once; old sidecar `.hf` state is intentionally ignored |
| Compaction item misses critical evidence | Expected lossy-summary failure | Re-read files or rerun normal tools; improve the local trigger/eval |
| Repeated checkpoints drift | Semantic loss accumulated across summaries | Re-anchor with a current user instruction and re-read authoritative files |

## Disable

Set `PI_HF_COMPACTION=off` to remove the compaction host, or `compaction.enabled=false` to disable automatic triggering. Removing the environment override restores default `full_pipeline` behavior.

Old `.hf/<session>` sidecar directories are no longer read. The refactor does not delete them automatically; operators may remove them separately after confirming no older binary needs them.

## Verification

1. Run targeted SessionManager, checkpoint host, AgentSession manual/threshold/overflow, `/context`, and default-tool tests.
2. Run `npm run check` and inspect formatter changes.
3. Confirm production source contains no recall tools, structured snapshots, snapshot stores, or compaction artifact-offload imports.
4. For release validation, run `./test.sh`; real-provider evaluation requires separate explicit approval and opt-in.
