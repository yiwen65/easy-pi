# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

T-153 implemented and verified; recommended fixed, pending coordinator acceptance. Baseline remains f7606c3df; prior auth fixes preserved.

Reproduced seven leaks before editing production: Codex device startup/poll HTTP errors, invalid success objects and malformed JSON exposed synthetic device_auth_id, user_code, authorization_code, code_verifier or arbitrary-token markers in public login errors. Root cause was direct body/JSON interpolation plus unsanitized JSON parser exceptions.

Fix: startup/poll errors now retain HTTP status or fixed JSON/expected-field diagnostics, never response values. Device response strings are validated before returning. Parser failures preserve caller cancellation rather than misclassifying it. Pending/slow_down parsing and normal login remain unchanged; unrelated third-party/fetch error reporting is not blanket-redacted.

Only files changed this turn:
- packages/ai/src/auth/oauth/openai-codex.ts:202–316 — device startup/poll sanitization.
- packages/ai/test/oauth-token-boundaries.test.ts:66–162 — seven synthetic leak regressions; existing token-response tests additionally verify response bodies are consumed.
- packages/ai/test/openai-codex-oauth.test.ts:428–539 — string/nested pending+slow_down schedule guards, token-exchange cancellation, updated unsafe response-body expectation.

Verification (cwd packages/ai):
Command prefix: env -i PATH="$PATH" HOME=/tmp/pi-model-auth-empty-home PI_OFFLINE=1 NO_COLOR=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js"
- Red: --run test/oauth-token-boundaries.test.ts -t 'T-153' → 7 failed, 60 unrelated skipped. Log /tmp/fix-model-auth-t153-red.log.
- Final green: --run test/oauth-token-boundaries.test.ts test/openai-codex-oauth.test.ts test/anthropic-oauth.test.ts test/oauth-auth.test.ts test/oauth-device-code.test.ts test/models-runtime.test.ts → 6 files, 147 passed. Log /tmp/fix-model-auth-t153-green.log.
- Pending/slow_down fake-clock polls occurred at exactly 0, 1000, 7000 ms for both error encodings; token exchange receives the caller signal and rejects on cancellation. Prior 40 controlled browser-cancellation schedules and OAuth persistence regressions remain green.
- Scoped Biome check and owned diff whitespace check passed; source/test changes reviewed.

No real provider requests or credentials, docs, dependencies, lockfiles, commits or authority records changed. Root check/build remain coordinator-owned and were not run. Documentation recommendation for sync-harness-docs: extend the OAuth diagnostic-redaction note to Codex device-code startup/poll errors; HTTP status and expected-field information remain available, raw provider payloads do not. No new unresolved finding identified within T-153.
