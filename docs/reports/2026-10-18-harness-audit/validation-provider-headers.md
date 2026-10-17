# 实施与验证回执快照

历史回执；最终接受状态见任务计划。

T-063 followup implemented; recommended status: fixed, ready for root review/serial checks (not acceptance).

Base: f7606c3df763e4dcbc75261211346e67124ee628, pre-existing shared dirty worktree preserved. Only these files changed by this task:
- packages/coding-agent/src/core/provider-composer.ts:418–429 — narrow configured-provider auth decoration using existing header/authHeader composition.
- packages/coding-agent/src/core/model-runtime.ts:556–580 — explicitly supplied tokens on configured OAuth-only providers receive provider headers without stored OAuth derivation; then static/configured model headers apply in order. Both getAuth overloads work; model/request/transform precedence remains intact.
- packages/coding-agent/test/model-runtime-auth-boundaries.test.ts:117–285 — 14 additional regressions.

Proven cause: resolveProviderAuth's explicit OAuth-only branch correctly bypasses credentials/toAuth, but configured provider headers lived only in the skipped auth handler. Runtime previously added only configured model headers. Fix operates at coding-agent composition; packages/ai/src/auth/resolve.ts is byte-identical to task start, auth types unchanged, normal stored-OAuth composition unchanged. No API-key login capability added.

Red/green evidence:
- Before production edits, package coding-agent command `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/model-runtime-auth-boundaries.test.ts -t 'preserves configured OAuth-only Codex headers'` failed all 12 new cases. Synthetic JWT reached injected fetch with correct bearer/account; storage reads/modifies, OAuth refresh/toAuth were not invoked; configured headers were absent from transform input.
- Final coding-agent command with the same CLI and `--run test/model-runtime-auth-boundaries.test.ts test/model-runtime-auth-options.test.ts test/model-runtime-cloudflare-compat.test.ts test/model-runtime-modify-models-compat.test.ts test/model-runtime-images.test.ts test/model-runtime-credential-sync.test.ts test/model-registry.test.ts test/auth-storage.test.ts test/suite/regressions/5661-uppercase-header-values.test.ts`: 9 files, 193/193 passed. Changed test file contains 31 passing cases.
- Final coverage includes stored absent/valid/expired; fetch-level X-Tenant retention; request case-insensitive override/null deletion; transform omission without resurrection; transform exactly once; request env/authHeader; provider/static-model/configured-model precedence; cancellation before dispatch.
- New configured-token cancellation test repeated 10 times with controlled promise scheduling, no sleeps: 10/10 passed, one aborted terminal event and zero fetch dispatches each time.
- Package ai: same CLI `--run test/model-auth-boundaries.test.ts test/providers.test.ts test/oauth-auth.test.ts test/google-header-overrides.test.ts`: 4 files, 49/49 passed.
- Scoped Biome check: all 3 owned files passed after formatting the test. Scoped git diff --check passed. Reviewed task-start-to-final diff.

Separate integration failure, NOT fixed here: initial wider neighbor run including test/auth-check.test.ts yielded 202 passed / 1 failed. Line 117 expects CLI not_ready/credentials_not_configured for unresolved stored reference, but receives invalid/invalid_state. The failing no-refresh/no-config route uses unchanged checkAuth, not this header patch. Root confirmed this is a known integration regression and will preserve CLI not_ready behavior in T162; do not simply change its expectation.

Evidence logs and isolated task delta are under /tmp/pi-t063-model-review/. Full root check/build not run per assignment. No real API requests, credential use, commits, documentation, dependency, or lockfile edits. Remaining limits: real network/proxy interoperability untested; root serial check and independent acceptance pending.
