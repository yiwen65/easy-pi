# Computer canonical ancestor revocation

Apply `g01-canonical-ancestor.patch` after `g02-general-candidate.patch` and `g02-action-metadata.patch`. SHA-256: `651b1fb6fa119f348668afd913d706d78dba6ef4f61d59729bb724648b40f05c`. Same upstream MIT notice: `LICENSE.cua.md`. Two authored Rust paths; genuine generated source bytes and dependency locks are unchanged.

## Diagnosis

The frozen baseline already used explicit native lifetime for dedicated unrestricted/no-manifest Computer contexts: their actual expiration timers were absent. Entry TTL configuration and an `is_expired()` call did **not** prove artificial expiry. New deterministic old-timestamp tests confirm this pre-existing behavior and preserve ordinary/restricted/manifest expiry.

The reproduced defect was canonical ancestor revocation: revoking a runtime parent did not invalidate a descendant context's direct canonical dispatch. The controlled facade gate independently traversed ancestors, so this is not evidence that the old facade delivered input after revoke.

Contexts now retain immutable native parent contexts. Ancestor revoke/expiry reaches authorization, commit, resolution and SDK liveness; ordinary delegation still has no parent. Binding rejects foreign-generation, expired and unregistered parents. No renewal loop, huge TTL, operation deadline change, input-release change or timeout-based cleanup was added.

## Verification

- Deterministic parent-revoke regression: one expected failure before, pass after; descendant/late-child rejection and independent sibling survival checked.
- Coordinator rerun: complete SDK 81 and controlled core 85 passed, zero skips. Worker core authorization 48 passed; genuine generation/check/staging/header/types passed.
- Worker sandbox socket EPERM caused its original full SDK/core failures. Those logs remain; the passing coordinator rerun does not relabel them.
- Strict independent apply/byte-compare/reverse: `.artifacts/computer/general/lifetime-source-verification.json`.
- Independent installed C349: single original AgentSession four-application data workflow, 41 terminals/two natural exits. C350: drag emergency release, one initiating model request and zero continuation, six terminals/two natural exits. Sealed in `lifetime-crossapp-verification.json` and `lifetime-stop-verification.json`.
- Matched same-fixture observation component, 100 samples/arm after five warmups: median 1115.6652085 → 10.568542 ms; empirical p95 1146.812209 → 13.321625 ms. `observation-matched-verification.json` records conditions and limits. This is not whole-task or universal GUI improvement.

Candidate SDK `e680d9c8ee16e693e4fd752e96818a75291d2dfa60c103be11eb99ff675a7b4f`, N-API `14d5e37dcaafbb5ac2517b706d0840b61a3f7e8d394fab35f169bebd68d97f5f`; helper remains `e17ff560525e2908b684da706cc8c5f1a4cf540e09ace34f054cdd3593cacecc`. Do not use stale upstream stage binaries. Production pins and final General Computer acceptance remain unchanged.
