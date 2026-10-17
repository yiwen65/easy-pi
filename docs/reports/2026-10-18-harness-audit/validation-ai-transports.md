# 复查/验证证据快照

历史证据；最终接受状态由任务计划和主报告决定。

Implemented and locally verified T-060, T-066–T-073. Recommended status: ready for parent review/acceptance and serial root checks, not independently accepted. Baseline and final HEAD f7606c3df763e4dcbc75261211346e67124ee628; no commits.

Per-task causal fixes/evidence:
- T-060/F01: Codex cached socket identity now includes URL, normalized handshake headers (auth included), and effective proxy. Identity changes invalidate idle sockets and connection-local continuation; active sockets remain isolated. Before→after endpoint/token/tenant/proxy changes: 1 incorrectly reused socket→2 connections, prior connection closed once, no previous_response_id carried. Equivalent headers still reuse. Ten controlled busy-socket schedules passed. Source openai-codex-responses.ts:1191ff.
- T-066/F07: Google merges request header overrides through Headers before SDK conversion, preserving case-insensitive deletion/overwrite. Null suppression initially retained X-Tenant; now absent. Source google-generative-ai.ts:354ff.
- T-067/F08: All six assigned direct streamSimple implementations wrap preparation in existing lazyStream, passing options.signal. Confirmed required contract in types.ts:333–340 and README Error Handling; not a preference change. Missing auth, invalid preparation, pre-abort now yield one terminal error/aborted event with no network. Depends on fix-model-auth's optional third lazyStream signal argument; I did not modify lazy.ts.
- T-068/F09: Codex uses a detachable composite even without a caller signal. Controlled header deadline no longer aborts a successful active body. Source Codex:407ff.
- T-069/F10: Codex/Mistral error reads use a caller-cancellable 4,000-byte diagnostic prefix reader in utils/error-body.ts:19ff. Stalled 401/503 cancellation count 0→1, reader unlocked; finite ASCII fixture consumed 12,000→4,000 bytes and cancelled unread remainder. Successful streaming is not capped.
- T-070/F11: Codex retry catch now covers fetch failure only, not terminal HTTP or onResponse errors. 400/401/403 and throwing accepted-response hooks: POST count 3→1. 429/503/network retries and retry-delay limits preserved. Adversarial test caught a patch regression in the existing 'Request was aborted' sentinel exclusion; restored it and verified 3→1. Source Codex:401–479.
- T-071/F12: Codex/Anthropic retain CRLF state across chunks. Bytewise LF/CRLF/CR, multiline JSON, UTF-8, EOF and Codex open terminal bodies pass. Prior CRLF framing merged/rejected events; now normal terminal output. Sources Codex:811ff, Anthropic:420ff.
- T-072/F13: Pi/Anthropic iterators cancel on early exit; six HTTP adapters cancel unconsumed bodies after hook failure, with SDK controller abort for OpenAI. Observed underlying cancellation 0→1; locks released. Pi terminal result is published after iterator cleanup.
- T-073/F14: Pi local failure finalizes converter-owned accumulated message rather than allocating empty output. EOF, malformed later frame, abort all retain text/thinking/partial tool arguments and emit exactly one terminal event. Source pi-messages.ts:265ff,330ff,417ff.

Exact files changed (12):
packages/ai/src/api/anthropic-messages.ts
packages/ai/src/api/google-generative-ai.ts
packages/ai/src/api/mistral-conversations.ts
packages/ai/src/api/openai-codex-responses.ts
packages/ai/src/api/openai-completions.ts
packages/ai/src/api/openai-responses.ts
packages/ai/src/api/pi-messages.ts
packages/ai/src/utils/error-body.ts
packages/ai/test/stream-setup-errors.test.ts (new)
packages/ai/test/google-header-overrides.test.ts (new)
packages/ai/test/codex-transport-boundaries.test.ts (new)
packages/ai/test/response-lifecycle.test.ts (new)
All modified source files read completely before edits. No docs, task/report authority files, shared abort/header helpers, auth files, models, dependency or lockfile edits by me.

Verification:
- From packages/ai, prefix `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run`.
- Initial red with test/{stream-setup-errors,google-header-overrides,codex-transport-boundaries,response-lifecycle}.test.ts: 51 failed/7 passed, all finding failures at intended assertions, /tmp/fix-ai-transports-red.log.
- Final command used that prefix and these exact files: test/stream-setup-errors.test.ts test/google-header-overrides.test.ts test/codex-transport-boundaries.test.ts test/response-lifecycle.test.ts test/openai-codex-stream.test.ts test/codex-session-cleanup.test.ts test/openai-codex-cache-affinity.test.ts test/openai-codex-service-tier.test.ts test/anthropic-sse-parsing.test.ts test/anthropic-adaptive-thinking-models.test.ts test/mistral-http-transport.test.ts test/mistral-reasoning-mode.test.ts test/pi-messages.test.ts test/openai-completions-retry.test.ts test/openai-responses-terminal-event.test.ts test/google-thinking-level-map.test.ts test/google-raw-stop-reason.test.ts test/error-body.test.ts test/provider-error-body-regression.test.ts test/provider-error-body-passthrough.test.ts.
- Final: 20 files/278 tests passed, including all 62 new tests; /tmp/fix-ai-transports-final-tests.log. No real APIs/credentials; controlled mocks and existing loopback fixtures only.
- Scoped `./node_modules/.bin/biome check --write --error-on-warnings` on all 12 owned files: clean, no final fixes. Scoped git diff --check: clean; complete source diff reviewed.
- Root npm check/build, full suites, real network/Bun runtime checks NOT run; parent owns serial checks. Proxy identity tested via mock constructor, not live proxy traffic. Diagnostic reads are byte-bounded and caller-cancellable, not a newly imposed wall-clock body deadline.

Documentation recommendations for coordinator (no doc edits): update ai README Codex connection-reuse note to require unchanged endpoint/auth/headers/effective proxy; optionally mention Codex/Mistral HTTP diagnostic truncation at 4,000 bytes. Existing stream failure/partial-output docs already specify repaired behavior.

Follow-up: T-150 queued by root remains untouched: Codex sleep() at ~170–184 retains anonymous abort listener after timer success. No other assigned tasks remain open in this delivery.
