# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-160 second-pass documentation completed against current source; ready for coordinator review, not overall remediation acceptance. HEAD remains f7606c3df763e4dcbc75261211346e67124ee628. Preserved the prior docs and one-line codemode description change. No source/test edits this turn.

Complete combined changed-doc inventory (20):
1. packages/permissions/README.md
2. tools/agent-desktop-mcp/README.md
3. packages/codemode/README.md
4. packages/pi-web-search/README.md
5. packages/ai/README.md
6. packages/agent/README.md
7. packages/mcp/README.md
8. packages/server/README.md
9. packages/session-backends/sqlite-node/README.md
10. packages/coding-agent/docs/mcp.md
11. packages/coding-agent/docs/codemode.md
12. packages/coding-agent/docs/extensions.md
13. packages/coding-agent/docs/tui.md
14. packages/coding-agent/docs/compaction.md
15. packages/coding-agent/docs/session-format.md
16. packages/coding-agent/docs/collaboration.md
17. packages/coding-agent/docs/sdk.md
18. packages/coding-agent/docs/providers.md
19. packages/coding-agent/docs/stream-recovery.md
20. packages/coding-agent/docs/rpc.md
Prior source-description change retained unchanged: packages/coding-agent/src/extensions/codemode/tool.ts:125.

Second-pass contracts/evidence:
- AI README:344,400,933–937,1574–1578 and providers:183–185,319: explicit access-token overrides for OAuth-only providers; no new login method; defined unresolved/empty stored keys fail closed versus omitted ambient auth; setup cancellation prevents late dispatch but cannot stop arbitrary JS, and started locked refresh may still persist rotated credentials. Codex socket reuse includes endpoint/auth/normalized headers/effective proxy; HTTP diagnostics retain 4000 source bytes, not a success-stream cap. Anthropic/Codex token and Codex device errors omit raw credential-bearing bodies, without claiming generic custom-error redaction. Grounded in ai auth/resolve.ts, api/lazy.ts, models.ts, Codex acquireWebSocket/readTokenResponse/device helpers, error-body.ts, and coding-agent AuthStorage/ModelRuntime.
- Agent README:15–19,541 and stream-recovery:61: synchronous detached entry/record input snapshots; V4 JSONL repairs only unterminated syntax-corrupt tails, rejects terminated/interior/schema corruption; raw loop producer failure preserves queued events then rejects iteration/result without fabricating successful agent_end. Ordinary provider/Agent errors unchanged.
- SDK:629–631: background cancellation is admission-only; successful admission/adoption is independent of the launch signal; shutdown includes output-writer settlement and incomplete joins are retryable. Grounded in background-task-manager.ts start/adopt/shutdown/finalize.
- MCP README:109,116–120: token redirect rejection; request-owned HTTP cancellation, shared-auth independence, JSON/SSE limits and 8-KiB diagnostic prefix; known status survives diagnostic-body failure unless cancelled. Concurrent client close joins group cleanup and stdio drain. Current streamable-http checkResponse and stdio closeChild include review followups.
- Server README:42–46: live dispose failure retains owner and blocks replacement; public PiServer.close has sealed admission, joined attempts, retry after failure and idempotent success; Unix admitted writes drain subject to close deadline. Sources server.ts:152–175, sessions.ts:178–198,331–348, harness-service.ts:365–372, Unix send/close/write.
- SQLite README:24–31: terminal close seals admission, drains admitted work and session release, then closes DB; input snapshots. Grounded in repo.ts:410–478,864–884 and storage release.
- Stream recovery:26–34: host-controlled startup exception, fork provenance audit-only, child delivery suppresses investigation without resolving uncertain effects.
- RPC:26,39–43,417,1344,1390: envelope validation, startup/replacement readiness with UI/abort availability, deferred extension shutdown versus signal/EOF path, typed-client failure rejection and collector cleanup. Corrected modern compaction response/event firstKeptEntryId to empty legacy placeholder and removed obsolete custom-summary-handler claim.
- Followups actually present in source and now documented: failed factory retained-API revocation (extensions:221); physical symlink invocation cwd assessment (permissions:9); specific Grok thinking/tool-name/argument-summary ingress sanitization (tui:35). The exact Grok files live under interactive-grok, not interactive; corrected the earlier narrow progress check before finalizing. Still no blanket renderer or extension sandbox assertion.
- Compaction:48 describes activated checkpoint full Usage, all reported retry/overflow attempts counted once, and full Usage shape for injected completions. It does not claim failed/aborted summaries are counted.

Checks actually run this turn:
- Fully read all eight newly owned docs and applicable AGENTS.md; read relevant validation receipts and enclosing source functions.
- Temporary local Markdown checker: 105 relative targets exist, 3 added links/anchors valid, four modern/legacy compaction entry/response/event JSON examples parse. Removed checker afterward. External URLs not fetched.
- Scoped git diff --check passed; reviewed second-pass and affected prior diffs.
- Confirmed prior tool.ts diff is still description-only. No product tests rerun for this docs-only turn; prior turn's codemode-extension 27/27 and scoped Biome remain historical checks, not a new result.

Exact remaining documentation recommendations after the bounded near-end source check:
1. T-154: failed/aborted/rejected compaction usage consumer integration was not present at inspection; getSessionStats still aggregates entry/message usage, while non-activated attempts are diagnostic records. Once final source lands, document its actual durable usage record and deduplication/totals semantics. Do not infer zero usage or claim all failed attempts are counted now.
2. T-080: startup suppression/guard is present, but TaskRecoveryJournal.start still lacks the coordinated inheritQueuedInputs admission seam and AgentSession has no sticky host-owned queue isolation. The validation-session-execution receipt retains a cold-followup adversary with two provider calls. Once fixed, document old pending prompt/steer/followUp/nextTurn receipts remaining historical/suspended rather than becoming executable queues in a new child assignment. Current docs deliberately promise startup suppression only, not that stronger isolation.

No root check/build/typecheck, real network/provider/GUI calls, dependencies, commits, task/report/LEARNS edits or unassigned files. Final integration and acceptance remain coordinator-owned.
