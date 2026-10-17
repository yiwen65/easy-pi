# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-162 implemented; recommend fixed/ready for root review and serial checks, not acceptance. Base HEAD remains f7606c3df763e4dcbc75261211346e67124ee628.

Changed only:
- packages/coding-agent/src/core/auth-storage.ts:25–40: added module-exported StoredApiKeyUnavailableError(providerId); shared resolveStoredApiKey throws it for explicitly configured keys that resolve empty/unavailable. Existing message retained without exposing key expressions. Missing key remains eligible for ambient auth.
- packages/coding-agent/src/cli/auth-check.ts:50–61: maps only ModelsError(code="auth") whose immediate cause is StoredApiKeyUnavailableError for the checked provider to not_ready/credentials_not_configured. No raw-message matching, arbitrary cause-chain traversal, or general error suppression. Other errors remain invalid.
- packages/coding-agent/test/auth-check.test.ts:128–240: unavailable-key matrix, ambient omission, refresh-time classification, exact-cause negatives, malformed-state controls. Original unresolved-env expectation preserved.
- packages/coding-agent/test/auth-storage.test.ts:54–80: typed-error and read-only command-opacity tests.

Causal evidence: before source edits, auth-check.test.ts produced 17 failures/11 passes: the existing unresolved-env case plus 16 missing/empty env, empty literal, failed/empty command cases returned invalid instead of not_ready. Each new failing case first proved request dispatch still failed closed with an ambient key present: auth resolver/provider dispatch/OAuth refresh counts all zero. The shared helper's untyped error prevented the CLI distinguishing unavailable configuration from invalid state. Typing that same failure and narrowly classifying its wrapper repairs status without allowing fallback.

Checks (all run from packages/coding-agent with `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run ...`):
- RED: test/auth-check.test.ts — 17 failed, 11 passed; /tmp/pi-t162-auth-classification/red.log.
- FINAL GREEN: test/auth-check.test.ts test/auth-storage.test.ts test/model-runtime-auth-boundaries.test.ts test/model-runtime-auth-options.test.ts test/model-runtime-credential-sync.test.ts test/model-registry.test.ts — 6 files, 202/202 passed.
- Additional neighbors: test/credential-print.test.ts test/runtime-credentials.test.ts test/resolve-config-value.test.ts test/suite/regressions/7027-credential-refresh-hang.test.ts — 4 files, 22/22 passed.
- Scoped Biome check and git diff --check passed. Task-start-to-final diff reviewed.
- SHA256 comparison confirms ai/src/auth/resolve.ts, model-runtime.ts, provider-composer.ts and the T-063 model-runtime-auth-boundaries test are unchanged by T-162.

One supplemental test fixture initially assumed checkAuth reads credentials once; inspection showed a second read through fallback resolution. Corrected the fixture to explicitly mock a successful availability check before exercising actual getAuth/storage failure; final checks above pass. No production change was needed for that fixture issue.

Preserved boundary: ReadOnlyAuthStorage intentionally does not execute !commands (used by actual --no-refresh CLI). Missing/empty literal/env expressions are tested in both stores and both checker modes; failed/empty command outputs are tested with evaluating AuthStorage in both checker modes. The read-only command test proves opacity/no execution; determining its unevaluated command outcome is intentionally not claimed.

No real APIs/credentials, documentation, commits, root check/build, lockfile/dependency, or other source edits. New diagnostic is local to coding-agent; no pi-ai/provider API redesign. Root typecheck/build and final acceptance remain pending.
