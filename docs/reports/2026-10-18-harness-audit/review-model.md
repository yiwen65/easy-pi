# 复查与后续验证证据

历史回执；最终状态见任务计划与主报告。

### Preserve configured provider headers with explicit OAuth access tokens

- Severity: Medium
- Axis: Correctness
- Location: `packages/ai/src/auth/resolve.ts:73–80`
- Problem: The new OAuth-only explicit-token branch returns only `{apiKey}` and bypasses the composed provider's header application. Concrete trigger: configure `providers.openai-codex.headers: {"X-Tenant":"tenant-a"}` in models.json, leave the provider OAuth-only, then call `ModelRuntime.completeSimple(model, context, {apiKey: syntheticToken})`. `composeApiKeyAuth` intentionally returns undefined (`packages/coding-agent/src/core/provider-composer.ts:327–338`); configured provider headers are applied only by `composeOAuthAuth.toAuth` (`:393–415`), which this branch skips. `ModelRuntime.getAuth` (`packages/coding-agent/src/core/model-runtime.ts:549–572`) subsequently adds only configured *model* headers, so it cannot restore the missing provider header. With a valid stored OAuth credential, the previous implementation retained that header while `prepareRequest` selected the explicit token.
- Impact: Required gateway/tenant headers silently disappear on otherwise valid Codex requests; previously working proxy configurations can fail authentication or route differently. Request/model headers are not affected in the same way.
- Recommended fix: Apply configured provider request headers independently of stored OAuth derivation when accepting an explicit access token. Preserve the new no-storage/no-refresh behavior; do not fabricate an API-key login method. Add a ModelRuntime regression using an OAuth-only Codex provider, configured provider headers, and an explicit synthetic JWT: assert the fetch receives both the explicit bearer token and configured headers, transformHeaders sees them, and storage/refresh is not invoked. Cover both no stored credential and an existing credential, plus request-level header override/deletion.
- Certainty: High confidence — complete resolver/composer/runtime call paths and the supplied before/after diff establish the omission; not executed during this review. Existing explicit-token boundary tests use an unconfigured builtin/faux provider and do not combine this override with provider-level header configuration.

### Coverage

Read the supplied `/tmp/pi-harness-model-review.diff` and current enclosing implementations for Models/ModelRuntime setup, credential resolution/storage, header composition, lazyStream/lazyApi, all six direct streamSimple wrappers, Anthropic/Codex OAuth token validation and browser cancellation, Codex device auth, WebSocket identity/continuation, SSE retry/deadline/sleep, diagnostic-body readers, response-hook cleanup, Pi partial-error retention, and SSE parsing. Followed shared event-stream/abort helpers and the enclosing Responses stream consumer. Inspected the new boundary tests and relevant existing OAuth, header, lazy-loading, Pi, and Anthropic tests. No additional actionable issue identified in these changed paths.

### Validation gaps and residual risks

- Read-only static review only: no commands, tests, typecheck, network calls, edits, or real credentials used. The proposed regression remains unexecuted.
- Validation reports were read as implementation claims, not accepted as checks performed by this reviewer.
- Review target was the supplied diff plus observed working-tree contents. HEAD/base revision and file hashes were not independently verified; no overall acceptance is asserted.
- Real SDK/network cancellation, proxy behavior, browser callback resources, and Node/Bun differences remain runtime-validation limits.
