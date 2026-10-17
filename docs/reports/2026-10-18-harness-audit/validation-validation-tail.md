# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T164: test-only fixes complete; recommended status is ready for root review and isolated full-suite revalidation, not acceptance. Base HEAD: f7606c3df763e4dcbc75261211346e67124ee628.

Changed only:
- packages/coding-agent/test/footer-data-provider.test.ts (SHA256 cb4b89c1d1e2ad07825546e7f22f0084dd1c244ce7c7c635c91ed6d2d788a8e8): controlled FS-event seams and fake timers preserve exact debounce/async-call/notification assertions (lines 218–291). Native integration remains (294–339): a bounded, separate watch-ready probe establishes actual directory-event delivery; next.ref creation and tables.list mutation then occur once each, with raw event and branch-notification assertions. The existing 3000 ms condition timeout is unchanged; branch writes/assertions are not retried.
- packages/coding-agent/test/suite/regressions/01a0c4e0-large-recovery-session.test.ts (SHA256 337c49e56c4cff97358cf54c1fd280acdbfd61b54946bb55581580d406ae0e6a): lines 60–101 explicitly check exact copied journal payloads, original sourceSessionId, parent-session paths, branch IDs, source unlink and fork reopen. Clone/fork recovery state must be undefined. The unchanged 96 MiB heap regression still covers 180 × 1 MiB historical payloads, clone/fork traversal, and another 180 appended snapshots.
- src/core/footer-data-provider.ts is unchanged; session-manager/task-recovery and all other source remain untouched by this child. No commits, dependency changes, authority-report/task edits, or LEARNS edits.

Evidence / diagnosis:
- Original two-file baseline reproduced the stale fork assertion: 1 failed / 12 passed, expected undefined to equal interrupted (/tmp/pi-t164-baseline.log:14–42). Current documented audit-only fork semantics and code provenance filtering explain this; restoring executable recovery would be wrong.
- The original native footer timeout did not recur in 20 targeted runs plus 100 instrumented temp-repo cycles. Traces showed fixture-creation events and polling mixed with the intended change.
- A stricter native directory-event integration exposed immediate-write delivery failures: 8/30 complete footer runs failed (/tmp/pi-t164-footer-repeat.log:737). Diagnostic repetition observed zero raw directory events, zero execFile calls, cached main (/tmp/pi-t164-native-trace.log:34,94; 2/10 failures). This locates the observed failure before debounce/git resolution, not a proven product logic defect. A single event-loop yield, canonical paths, and removing earlier native watcher churn did not resolve it.
- After separating readiness from the tested mutations, 30/30 complete footer runs passed (/tmp/pi-t164-native-ready.log:601). Diagnostic console output/counters and temporary probe scripts were removed.

Verification:
From packages/coding-agent, final command:
PI_OFFLINE=1 PI_TELEMETRY=0 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/footer-data-provider.test.ts test/footer-width.test.ts test/suite/regressions/2791-fswatch-error-crash.test.ts test/suite/regressions/01a0c4e0-large-recovery-session.test.ts test/session-manager/history-integrity.test.ts test/session-manager/file-operations.test.ts test/session-manager/durable-storage.test.ts test/task-recovery-admission.test.ts test/suite/regressions/session-history-boundaries.test.ts --reporter=verbose
Result: 9 files / 97 tests passed; /tmp/pi-t164-final-neighbors.log:102–103.
Repeated the footer-only form 30 times with explicit failure counting; 0 failures after readiness synchronization. Targeted read-only Biome check on both edited files and scoped git diff --check pass.

Limits: the original full-suite platform timeout was not reconstructed exactly, and the lower-level reason native events were absent remains unproven. This stabilizes fixture readiness and independently checks watcher logic, not a claimed OS/product watcher repair. Only this macOS/Node v24.15.0 environment was exercised. Root npm run check/build and ./test.sh were intentionally not run; root owns those serial gates. No real model/network/credential use.
