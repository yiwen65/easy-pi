# Compaction integration seam

## Runtime flow

```text
AgentSession provider preflight
  -> HfCompactionHost.evaluateCompactionTrigger()
  -> none: preserve the exact current context
  -> compact:
       append local_compaction_trigger to canonical system/messages/tools
       overflow only: rewrite tool-result bodies until the compact request fits
       generateCompactionItem()
       select recent user messages
       build replacementHistory
       SessionManager.appendCompaction(..., replacementHistory)
       agent.state.messages = SessionManager.buildSessionContext().messages
       emit session_compact
       continue current run when required
```

`HfCompactionHost` owns trigger estimation, the single compaction-item call, recent-user selection, token accounting, and read-only `/context` inspection. It owns no durable store.

`SessionManager` owns persistence, branch ancestry, checkpoint selection, replay of post-checkpoint entries, and legacy summary-only compatibility.

`AgentSession` owns authentication, extension hooks, durable-before-live publication ordering, overflow retry state, provider-boundary continuation, and canonical system/tool refresh.

## Checkpoint contract

`CompactionEntry.replacementHistory?: AgentMessage[]` is the only new persisted field. When present it completely replaces context-visible entries through that compaction entry. `summary`, `firstKeptEntryId`, and legacy reconstruction remain for old sessions.

## Failure boundary

- compactor error/empty output/abort: no append, no live replacement;
- Session append failure: no live replacement;
- successful append: live messages are rebuilt from the persisted Session state;
- extension notification failure occurs after durable publication and cannot erase the checkpoint;
- overflow recovery continues only after a successful durable checkpoint.

## Configuration

`PI_HF_COMPACTION=off|full_pipeline`. `shadow`, `offload_only`, and structured/snapshot modes are retired and rejected.
