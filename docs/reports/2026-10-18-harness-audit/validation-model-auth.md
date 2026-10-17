# 实施与验证回执快照

实现方回执，最终接受状态见任务计划与 root 复查。

Implemented and regression-verified T-061–T-065 and T-074–T-076 against baseline f7606c3df. Recommended status: fixed, pending coordinator review/integration acceptance.

Task outcomes:
- T-061/F02: reproduced token-bearing OAuth exceptions and Models assistant errors. Anthropic/Codex exchange/refresh diagnostics now expose fixed field/JSON diagnostics or HTTP status, not response bodies. Generic ModelsError cause reporting remains intact; built-in token diagnostics are sanitized at their source.
- T-062/F03: reproduced successful dispatch using ambient credentials after missing stored env references, failed/empty commands and empty stored keys. AuthStorage and read-only non-command resolution now fail closed. Deliberately omitted key still permits ambient auth; credential-scoped env and command caching remain unchanged.
- T-063/F04: explicit Codex tokens previously failed with no stored OAuth or attempted expired-token refresh. They now bypass storage/refresh without adding an API-key login method. Existing override contract confirmed in packages/ai/README.md:334–341.
- T-064/F05: reproduced setup aborts reported as error and unresolved transform/module waits. lazyStream(model, setup, signal?: AbortSignal) now classifies/races cancellation; existing two-argument callers remain compatible. Models/ModelRuntime/lazyApi check before dispatch; late transform/load completion cannot dispatch. Started locked OAuth refresh still persists rotated credentials after stream cancellation.
- T-065/F06: fetch-level tests reproduced transformed-away model headers reappearing through OpenAI Responses. Models.applyAuth and ModelRuntime.prepareRequest now strip raw model.headers after assembly, including both stream entrypoints, matching image behavior.
- T-074/F15: reproduced definition/extension headers beating modelOverrides. rawModelHeaders now merges definition → extension → overrides case-insensitively; getAuth and dispatch both verified with same-case and mixed-case conflicts.
- T-075/F16: reproduced malformed successful Anthropic responses replacing stored credentials. Exchange/refresh validate nonempty token strings, positive finite expires_in, and finite computed expiry before returning credentials; malformed responses preserve previous credentials.
- T-076/F17: reproduced operation abort leaving manual prompt pending and callback server open. Signals are linked, abort is checked before further waits/exchange, and fallback prompt waits race cancellation. Mock resource evidence: baseline opened=1/closed=0 after abort; fixed opened=1/closed=1, zero exchanges, across 40 controlled schedules (two providers × cooperative/uncooperative prompts × 10). These are mock-handle counts, not OS/resource-throughput measurements.

Changed files (all under packages/):
AI source: ai/src/api/lazy.ts; ai/src/models.ts; ai/src/auth/resolve.ts; ai/src/auth/oauth/anthropic.ts; ai/src/auth/oauth/openai-codex.ts.
Coding-agent source: coding-agent/src/core/auth-storage.ts; coding-agent/src/core/model-runtime.ts; coding-agent/src/core/provider-composer.ts.
Tests: ai/test/model-auth-boundaries.test.ts (new); ai/test/oauth-token-boundaries.test.ts (new); ai/test/openai-codex-oauth.test.ts (updated old assertion that required response-body disclosure); coding-agent/test/model-runtime-auth-boundaries.test.ts (new).
No docs, authority reports/tasks, adapters/header utils, dependencies, lockfiles or commits changed by this worker. resolve-config-value.ts did not require editing.

Checks/evidence:
- Initial AI red: package cwd, node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/model-auth-boundaries.test.ts test/oauth-token-boundaries.test.ts → 30 failed / 5 passed. /tmp/fix-model-auth-red-ai.log
- Expanded OAuth red (soft assertions reached persistence and wrapped-error boundaries): same CLI --run test/oauth-token-boundaries.test.ts → 19 failed / 5 passed. /tmp/fix-model-auth-red-oauth.log
- Coding-agent red: same CLI --run test/model-runtime-auth-boundaries.test.ts → 16 failed / 1 passed. /tmp/fix-model-auth-red-coding.log
- Final AI green, cwd packages/ai: env -i PATH="$PATH" HOME=/tmp/pi-model-auth-empty-home PI_OFFLINE=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/model-auth-boundaries.test.ts test/oauth-token-boundaries.test.ts test/anthropic-oauth.test.ts test/openai-codex-oauth.test.ts test/models-runtime.test.ts test/oauth-auth.test.ts test/images-models.test.ts test/lazy-module-load.test.ts → 8 files, 169 passed. /tmp/fix-model-auth-green-ai-neighbors.log
- Final coding-agent green, cwd packages/coding-agent: same sanitized-env CLI --run test/model-runtime-auth-boundaries.test.ts test/auth-storage.test.ts test/model-runtime-auth-options.test.ts test/model-runtime-images.test.ts test/model-runtime-credential-sync.test.ts test/model-runtime-session-view.test.ts test/model-runtime-modify-models-compat.test.ts test/model-runtime-cloudflare-compat.test.ts test/resolve-config-value.test.ts test/model-registry.test.ts → 10 files, 190 passed. /tmp/fix-model-auth-green-coding-neighbors.log
- Scoped Biome check on all 12 owned changed files passed (final read-only check: no fixes). Owned diff whitespace check passed; diff reviewed.

Key implementation references: ai/src/api/lazy.ts:48–126; ai/src/models.ts:789–932; ai/src/auth/resolve.ts:73–94; ai/src/auth/oauth/anthropic.ts:191–215,244–329; ai/src/auth/oauth/openai-codex.ts:127–158,456–524; coding-agent/src/core/auth-storage.ts:25–31,274–283,457–462; coding-agent/src/core/model-runtime.ts:654–803; coding-agent/src/core/provider-composer.ts:418–443.

Coordinator follow-up/limits:
- Root npm run check/build not run, per assignment; coordinator owns serial integration checks. No real provider APIs or real credentials used. Fetches synthetic/injected, callback cancellation uses mock servers; existing Anthropic login neighbor exercises localhost callback lifecycle.
- Documentation recommendation: providers.md Key Resolution should explicitly say defined unresolved/empty stored keys fail instead of falling back; omitted key remains intentional ambient auth. AI README could clarify explicit access-token overrides work for OAuth-only providers and cancellation stops setup waiting but cannot terminate noncooperative custom transform work. models.md:390 already documents correct final override precedence; no wording correction needed.
- Related unmodified static concern reported via progress: Codex device-code startup/poll diagnostics still interpolate raw bodies/JSON and can contain auth artifacts; outside assigned readTokenResponse exchange/refresh finding, needs separate coordinator triage. Not claimed reproduced or fixed. Arbitrary third-party OAuth errors are likewise not promised secret-redacted.
