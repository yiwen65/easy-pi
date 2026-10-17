# 模块边界初审证据（实施前，只读）

历史初审证据；不是最终验收状态。最终状态见主报告与唯一任务计划。

T-003 READ-ONLY REPORT. Implementation/validation pending; not overall acceptance. Root `/Users/w/Projects/easy-pi/pi`; supplied baseline f7606c3df/my-pi not independently checked. All findings are high-confidence static traces, not executed reproductions.

Path aliases (relative to packages/): A=`ai/src/`; C=`coding-agent/src/core/`; Codex=A`api/openai-codex-responses.ts`; Anthropic=A`api/anthropic-messages.ts`; Mistral=A`api/mistral-conversations.ts`; PiMsg=A`api/pi-messages.ts`; OAuthC=A`auth/oauth/openai-codex.ts`; OAuthA=A`auth/oauth/anthropic.ts`.

## Findings

### F01 Scope socket reuse by endpoint/auth
- Severity: High
- Axis: Security
- Location: Codex `acquireWebSocket`.
- Problem: Cache identity is sessionId/accountId only. Changing URL/token/tenant headers reuses the prior authenticated socket; handshake configuration is unchecked.
- Impact: New conversation data can reach the previous endpoint; new auth settings are ignored.
- Recommended fix: Include endpoint/handshake/proxy identity; reset continuation on changes. Test same-session/account endpoint/header changes create new connections.
- Certainty: High confidence — cached socket returns before url/headers/env are consulted.

### F02 Remove token bodies from errors
- Severity: High
- Axis: Security
- Location: OAuthC `readTokenResponse`; OAuthA token parsing; A`auth/resolve.ts#withCauseDetail`.
- Problem: Missing Codex fields serialize token JSON; malformed Anthropic JSON includes raw response. These messages propagate into lazy assistant errors.
- Impact: Partial responses containing tokens expose secrets through ordinary error reporting.
- Recommended fix: Allowlist status/field diagnostics, never token bodies. Test synthetic secrets in incomplete/truncated responses remain absent from errors and Models results.
- Certainty: High confidence — interpolation/forwarding inspected.

### F03 Fail closed on unresolved stored key expressions
- Severity: Medium
- Axis: Security
- Location: C`auth-storage.ts#read`, `resolve-config-value.ts`; A`auth/helpers.ts#envApiKeyAuth`.
- Problem: Missing env references/failed commands become key:undefined, then standard providers use ambient keys. Explicit resolution failure resembles absent configuration.
- Impact: Silent account/billing identity change.
- Recommended fix: Reject unresolved defined expressions; preserve intentionally key-absent ambient credentials. Test broken stored expression plus ambient key cannot dispatch.
- Certainty: High confidence — full conversion/fallback chain inspected.

### F04 Honor explicit tokens for OAuth-only providers
- Severity: Medium
- Axis: Correctness
- Location: A`auth/resolve.ts#resolveProviderAuthWithSignal`, `providers/openai-codex.ts`.
- Problem: Explicit apiKey works only when provider.auth.apiKey exists. OAuth-only Codex still requires/refreshes stored OAuth.
- Impact: Documented request override fails through Models/ModelRuntime.
- Recommended fix: Decouple request override from login methods. Test explicit token with absent/expired stored OAuth dispatches without refreshing it.
- Certainty: High confidence — branch/factory inspected.

### F05 Make lazy setup cancellation-aware
- Severity: Medium
- Axis: Correctness
- Location: A`api/lazy.ts#lazyStream`, `models.ts#applyAuth`; C`model-runtime.ts#prepareRequest`.
- Problem: Setup aborts are encoded as error. Async transformHeaders is not raced with cancellation; abort is checked only afterward.
- Impact: Misclassified cancellation or stalled request.
- Recommended fix: Signal-aware setup racing/classification with no late dispatch. Test pre-abort, auth-wait abort and pending-transform abort: exactly one aborted terminal result.
- Certainty: High confidence — setup lacks cancellation context.

### F06 Do not resurrect transformed-away headers
- Severity: Medium
- Axis: Security
- Location: A`models.ts#applyAuth`; C`model-runtime.ts#prepareRequest`; A`api/openai-responses.ts#createClient`.
- Problem: Chat passes transformed options.headers plus original model.headers, which adapters remerge. Filtered transform results/{} cannot remove defaults.
- Impact: Host-excluded sensitive headers still reach endpoints.
- Recommended fix: Strip raw defaults after assembly, as image dispatch does. Fetch-level test must prove removed headers stay absent and transform runs once.
- Certainty: High confidence — assembly/remerge inspected.

### F07 Honor case-insensitive Google header deletion
- Severity: Medium
- Axis: Correctness
- Location: A`api/google-generative-ai.ts#createClient`, `utils/headers.ts#providerHeadersToRecord`.
- Problem: Model X-Tenant plus request x-tenant:null creates two keys; null filtering retains X-Tenant because deletion is case-sensitive.
- Impact: Explicit suppression fails, including direct adapter calls.
- Recommended fix: Merge/delete case-insensitively before SDK conversion. Mock Google client; assert no tenant header after case-variant null override.
- Certainty: High confidence — resulting header object follows directly from code.

### F08 Keep direct streamSimple failures in the protocol
- Severity: Medium
- Axis: Correctness
- Location: `streamSimple` in Anthropic, Codex, Mistral and A`api/{openai-completions,openai-responses,google-generative-ai}.ts`.
- Problem: Auth/preparation throws before returning a stream; only the inner producer is protected, contrary to StreamFunction's contract.
- Impact: Direct consumers fail before obtaining events/result().
- Recommended fix: Protect preflight/conversion. Test missing auth/invalid preparation returns a stream, one terminal error, no network.
- Certainty: High confidence — each listed implementation read fully.

### F09 Detach Codex's header-only deadline
- Severity: Medium
- Axis: Correctness
- Location: Codex SSE fetch; A`utils/abort-signals.ts#combineAbortSignals`.
- Problem: timeoutMs without caller signal returns the timeout signal directly; cleanup is a no-op, leaving body consumption deadline-bound.
- Impact: Healthy long responses terminate at the header deadline.
- Recommended fix: Separate request/deadline lifetimes. Test signal-bound fetch with active body beyond timeoutMs and no caller signal succeeds.
- Certainty: High confidence — single-signal helper behavior inspected; Mistral explicitly avoids it.

### F10 Keep error-body reads cancellable
- Severity: Medium
- Axis: Correctness
- Location: Mistral `requestMistralStream`; Codex SSE response.text.
- Problem: Composite signal listeners detach after headers. Success parsers replace cancellation, non-2xx response.text does not. Codex manifestation requires timeoutMs plus caller signal; Mistral always composites.
- Impact: Stalled error bodies block cancellation/completion.
- Recommended fix: Retain caller cancellation through diagnostic reads; cancel/bound bodies. Test unfinished 401/503 bodies settle and cancel on abort.
- Certainty: High confidence — branch inspected; success-body tests miss it.

### F11 Do not retry terminal HTTP/hook errors
- Severity: Medium
- Axis: Correctness
- Location: Codex SSE retry catch.
- Problem: Non-retryable HTTP errors enter a broad catch that retries almost every Error. With maxRetries>0, 400/401/403 retry; onResponse exceptions can repeat accepted POSTs.
- Impact: Needless backoff and potentially duplicated model work.
- Recommended fix: Separate transport retries from HTTP/callback failures. Test terminal status and throwing onResponse call counts; preserve 429/503 retries.
- Certainty: High confidence — catch exclusions inspected.

### F12 Parse SSE newline state across chunks
- Severity: Medium
- Axis: Correctness
- Location: Codex `parseSSE`; Anthropic `consumeLine/iterateSseMessages`.
- Problem: Codex supports LF/LF only, so CRLF frames stall/combine at EOF. Anthropic immediately consumes trailing CR; next-chunk LF becomes a false blank line.
- Impact: Valid SSE fails depending on chunking/line endings.
- Recommended fix: Stateful LF/CRLF/CR handling. Add CRLF/bytewise regressions, preserving EOF behavior; Mistral has a useful fixture.
- Certainty: High confidence — deterministic parser traces.

### F13 Cancel bodies on early logical exits
- Severity: Medium
- Axis: Performance
- Location: PiMsg `readPiMessagesEvents`; Anthropic `iterateSseMessages`; inspected HTTP onResponse boundaries.
- Problem: PiMsg terminal return/Anthropic parser errors release locks without cancelling. Throwing onResponse before iteration leaves bodies unconsumed. Ownership misses early exits.
- Impact: Resources outlive requests; repeated failures retain outstanding work.
- Recommended fix: Cleanup hooks/early return using reader cancel or SDK abort. Test cancel spies for open terminal body, Anthropic error frame and throwing onResponse.
- Certainty: High confidence — finally blocks/installed OpenAI iterator inspected; no measurements claimed.

### F14 Retain pi-messages partial output on local failure
- Severity: Medium
- Axis: Correctness
- Location: PiMsg `createEventConverter/createErrorEvent/stream`.
- Problem: Converter accumulates output, but catch creates an empty message on EOF, parse failure or abort; success/error state is separate.
- Impact: result() loses already emitted content.
- Recommended fix: Finalize accumulated state. Test EOF retains 'partial', plus abort-after-delta and malformed-later-frame cases.
- Certainty: High confidence — existing EOF test checks only error text.

### F15 Apply modelOverrides headers last
- Severity: Medium
- Axis: Correctness
- Location: C`provider-composer.ts#rawModelHeaders`.
- Problem: Definition/extension headers overwrite modelOverrides, reversing documented precedence and other metadata behavior.
- Impact: Final user tenant/auth header corrections are ignored.
- Recommended fix: Apply overrides last case-insensitively. Test conflicting definition/extension/override values through getAuth(model) and dispatch.
- Certainty: High confidence — composer/models.md inspected.

### F16 Validate Anthropic token shape before persistence
- Severity: Medium
- Axis: Correctness
- Location: OAuthA token parsing; A`auth/resolve.ts#refreshStoredOAuthCredential`.
- Problem: JSON is only cast. A 200 object missing fields yields undefined tokens/NaN expiry and overwrites the old credential.
- Impact: Malformed upstream success destroys usable auth, forcing re-login.
- Recommended fix: Validate token strings/finite expiry without dumping data. Mock incomplete/wrong-type 200 responses and assert Models preserves previous credentials.
- Certainty: High confidence — refresh persistence chain inspected.

### F17 Link OAuth operation/manual-prompt cancellation
- Severity: Medium
- Axis: Correctness
- Location: OAuthA `loginAnthropic`; OAuthC `loginOpenAICodex`.
- Problem: Operation abort cancels server.waitForCode, then awaits manualPromise. Its separate signal is aborted only in finally after that await.
- Impact: Signal-respecting prompts remain pending; callback server can survive outward login cancellation.
- Recommended fix: Link signals/check abort before waiting again. Mock server/prompt; assert cancellation, close, settlement and no exchange.
- Certainty: High confidence — same cancellation cycle in both implementations.

## Offline regression files (all NOT RUN)
F01/09/11: `ai/test/openai-codex-stream.test.ts`. F02/16/17: `ai/test/{openai-codex-oauth,anthropic-oauth}.test.ts` plus Models refresh integration. F03: `coding-agent/test/auth-storage.test.ts`. F04/05: `ai/test/models-runtime.test.ts` and ModelRuntime integration. F06/07/15: new `coding-agent/test/model-runtime-header-boundaries.test.ts`, `ai/test/google-header-overrides.test.ts`. F08: new `ai/test/stream-setup-errors.test.ts`. F10: Codex stream/Mistral HTTP tests. F12: Codex stream/Anthropic SSE tests. F13/14: pi-messages/Anthropic SSE plus new `ai/test/response-cleanup.test.ts`. Exact scenarios/assertions appear above; use synthetic credentials/mocks only.

## Coverage
Fully read AGENTS.md, review-code/best-practice skills, ai README, coding-agent docs custom-provider.md/models.md/providers.md.
Fully read source files:
A `{index,types,models,compat,session-resources}.ts`; `auth/{types,resolve,helpers,credential-store}.ts`; `auth/oauth/{openai-codex,anthropic}.ts`; `providers/{all,openai,openai-codex,anthropic,cloudflare-stream}.ts`; `api/{lazy,simple-options,transform-messages,openai-responses-shared,openai-responses,openai-completions,openai-codex-responses,anthropic-messages,google-generative-ai,google-shared,mistral-conversations,pi-messages,cloudflare-gateway-binding}.ts`; `utils/{event-stream,provider-retry,abort,abort-signals,provider-env,headers,error-body,diagnostics}.ts`.
C `{model-runtime,model-registry,provider-composer,auth-storage,runtime-credentials,resolve-config-value}.ts`.
Tests read, not run: ai/test/{models-runtime,provider-retry,openai-codex-stream,openai-codex-oauth,codex-session-cleanup,anthropic-sse-parsing,mistral-http-transport,pi-messages,lazy-module-load}.test.ts; coding-agent/test/auth-storage.test.ts. Also installed OpenAI core/streaming.mjs and internal/stream-utils.mjs.
Chains: registry → runtime → auth/locked storage refresh → composition → lazy API → transport → EventStream; Models refresh → generation-checked publication; Codex cache → continuation → release/TTL/cleanup; auth errors → assistant errors.

## Opportunities/exclusions/gaps
EventStream buffering/disposal is an opportunity, not a demonstrated harness leak: documented cancellation is AbortSignal; complete() supports result-only consumers. OAuth rotation deliberately survives cancellation after locking to preserve new tokens; inspected tests support it. Session views explicitly share capabilities and are not a sandbox; sharing alone is not a finding.
Not deeply audited: Bedrock, Azure Responses, Google Vertex, OpenRouter image adapters; remaining OAuth flows, remote catalog, ModelConfig parser, generated catalogs, downstream persistence.
Factories/auth not deeply audited: amazon-bedrock, ant-ling, azure-openai-responses, baseten, cerebras, cloudflare-ai-gateway/workers-ai (helpers only), deepseek, fireworks, github-copilot, google/google-vertex, groq, huggingface, kimi-coding, minimax/minimax-cn, mistral, moonshotai/moonshotai-cn, nvidia, opencode/opencode-go, openrouter, three qwen-token-plan variants, radius, together, vercel-ai-gateway, xai, xiaomi plus regional plans, zai/zai-coding-cn. Shared adapter coverage is not exhaustive provider coverage.
Auth-file crash/partial-write/first-creation durability needs fault injection, not asserted reproduced. Only reads: no execution, network/APIs, credential reads, edits or hashes. No tests passed/failed or performance measurements.

## Proposed implementation ownership
A `api/lazy.ts`, `models.ts`, `auth/resolve.ts`, OAuthA/OAuthC, Codex/Anthropic/Mistral/PiMsg, `api/{openai-responses,openai-completions,google-generative-ai}.ts`, `utils/headers.ts`; C `{auth-storage,model-runtime,provider-composer}.ts`; targeted regressions above. Coordinate shared abort-helper changes with parent. No edits performed.
