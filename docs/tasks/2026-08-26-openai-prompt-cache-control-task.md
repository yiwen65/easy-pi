# Task Plan: OpenAI 提示缓存命中率优化

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request in the current task: analyze and implement cache-hit-rate optimizations.

<!-- task-doc-section:background-goal -->
## Background and goal

Improve prompt-cache reuse without changing conversation semantics. The implementation will add GPT-5.6's modern prompt-cache controls to the standard OpenAI Responses adapter and separate the logical prompt-cache grouping key from the transport/session identifier.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- In scope: public stream option contract, proxy forwarding, OpenAI Responses/Completions, Azure Responses, OpenAI Codex Responses, Mistral Conversations, faux-provider cache simulation, focused documentation, and offline payload regression tests.
- In scope: backward-compatible fallback from `promptCacheKey` to `sessionId`.
- Non-goal: prompt reordering, large prompt-layering refactors, Gemini explicit cache objects, provider calls that incur cost, or measured production hit-rate claims.
- Non-goal: changing transport affinity, WebSocket reuse, or request-header identity from `sessionId` to `promptCacheKey`.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The current public stream contract exposes `cacheRetention` and `sessionId`, but no independent logical cache key. | `packages/ai/src/types.ts`; `packages/agent/src/proxy.ts` |
| F-002 | OpenAI Responses currently derives `prompt_cache_key` directly from `sessionId`; GPT-5.6-compatible models only use `prompt_cache_options` to disable writes. | `packages/ai/src/api/openai-responses.ts`; generated `supportsExplicitPromptCacheMode` metadata |
| F-003 | The installed OpenAI SDK predates `prompt_cache_options` and `prompt_cache_breakpoint` type declarations. | `node_modules/openai/resources/responses/responses.d.ts` search on 2026-08-26 |
| F-004 | Several adapters already use `sessionId` as both cache identity and transport affinity, so the split requires a cross-adapter regression matrix. | OpenAI Completions, Azure Responses, Codex Responses, Mistral Conversations, and faux provider sources/tests |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: `promptCacheKey ?? sessionId` is the compatibility rule; an explicitly absent cache key retains current session-scoped behavior.
- Assumption: for GPT-5.6 caching, implicit mode remains enabled while an explicit breakpoint is added after the stable system prompt; this preserves the growing-conversation cache opportunity while adding a reusable stable prefix.
- Open question: the actual hit-rate and cost delta remain unknown until production-like A/B telemetry is available.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `promptCacheKey` is forwarded end-to-end and overrides `sessionId` only for provider prompt-cache identity.
- Existing callers that only set `sessionId` retain the same prompt-cache key and transport affinity behavior.
- GPT-5.6 standard OpenAI Responses payloads use modern TTL controls and mark the system-prompt text as an explicit cache breakpoint when caching is enabled.
- `cacheRetention: "none"` still omits prompt-cache keys and disables implicit writes on capable models.
- Older OpenAI models do not receive unsupported `prompt_cache_options` or breakpoint fields.
- Targeted adapter tests and repository-wide `npm run check` pass without unrelated rewrites.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: none; the changes share the same stream option contract and overlapping adapter tests.
- Serialization constraints: establish the option semantics first, then add provider behavior, then validate and document the complete matrix.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Separate logical cache identity from transport session identity

- Status: done
- Owner: primary agent
- Objective: Introduce `promptCacheKey` and propagate it without changing `sessionId` transport behavior.
- Inputs and prerequisites: F-001, F-004, existing prompt-cache key bounding helper.
- Scope or files: `packages/ai/src/types.ts`, relevant adapters/providers, `packages/agent/src/proxy.ts`, focused tests and README.
- Expected output: Cache payloads use `promptCacheKey ?? sessionId`; headers and connection reuse continue to use `sessionId`.
- Dependencies: None.
- Execution steps:
  1. Add and document the public option.
  2. Forward it through the agent proxy.
  3. Update every adapter that currently maps `sessionId` into a prompt-cache key.
  4. Add cross-adapter override and fallback tests.
- Acceptance criteria:
  - Explicit cache keys override payload cache identity but not affinity headers.
  - Legacy `sessionId`-only behavior remains covered.
- Verification method:
  - Run focused Vitest suites for OpenAI Responses, OpenAI Completions, Azure Responses, Codex Responses, Mistral, faux, and proxy behavior.
- Validation evidence: Cross-adapter AI suites passed (162 passed, 4 environment-dependent skipped); Agent proxy/forwarding suites passed (27 passed).
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add GPT-5.6 stable-prefix prompt-cache controls

- Status: done
- Owner: primary agent
- Objective: Preserve implicit caching while adding a system-prompt breakpoint and modern TTL selection for capable standard OpenAI Responses models.
- Inputs and prerequisites: T-001; F-002; F-003.
- Scope or files: `packages/ai/src/api/openai-responses.ts`, `packages/ai/src/api/openai-responses-shared.ts`, compatibility type documentation, cache-retention tests.
- Expected output: GPT-5.6 requests use `prompt_cache_options` with the requested TTL and carry a breakpoint only on the stable system prompt.
- Dependencies: T-001.
- Execution steps:
  1. Define narrow local wire types for SDK fields not yet declared.
  2. Mark the system input text only when the capability is enabled and caching is not disabled.
  3. Use modern TTL options for capable models while retaining legacy retention fields for older models.
- Acceptance criteria:
  - Short/long/none and capable/incapable combinations have exact payload assertions.
  - No breakpoint is emitted for older models or disabled caching.
- Verification method:
  - Run `packages/ai/test/cache-retention.test.ts` and response compatibility tests.
- Validation evidence: `packages/ai/test/cache-retention.test.ts` asserts GPT-5.6 short/long/none payloads and older-model omission; included in the passing AI suite.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Validate, document, and audit the final diff

- Status: done
- Owner: primary agent
- Objective: Prove the wire-contract behavior offline and ensure repository checks do not damage the dirty worktree.
- Inputs and prerequisites: T-001, T-002.
- Scope or files: targeted tests, `packages/ai/README.md`, task document, final diff/status audit.
- Expected output: passing focused tests and full check, with explicit limitations on unmeasured hit-rate gains.
- Dependencies: T-001, T-002.
- Execution steps:
  1. Run targeted Vitest suites from their package directories.
  2. Snapshot status before and after `npm run check` and inspect all changed files.
  3. Validate this task document and record evidence.
- Acceptance criteria:
  - Targeted tests and `npm run check` pass.
  - No unrelated files are rewritten by validation.
- Verification method:
  - Command output plus focused `git diff --check`, status, and diff inspection.
- Validation evidence: Second `npm run check` passed with 1131 files checked and no fixes applied; `git diff --check` passed; status snapshots showed no new unrelated paths from validation.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Adapter payload unit tests: explicit key override, session fallback, disabled caching, and affinity isolation.
2. GPT-5.6 payload tests: short and long TTL, stable system breakpoint, and disabled mode.
3. Compatibility tests: older models omit all new fields.
4. Repository validation: full `npm run check`, followed by status/diff audit.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Risk: the installed SDK lacks the newest wire types. Mitigation: local structural types only; no dependency change or broad cast.
- Risk: a shared `promptCacheKey` can reduce cache isolation if callers choose an over-broad cohort. Mitigation: keep it opt-in and document that callers own the logical grouping boundary.
- Risk: payload-shape tests cannot prove a higher live cache hit rate. Mitigation: report the result as mechanism verification and leave production A/B measurement explicit.
- Blocker: none.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: Task document created; content not yet completed.
- 2026-08-26: Inspected current cache paths, dirty-file overlap, generated model capability flags, and installed SDK type surface; selected a serial implementation graph.
- 2026-08-26: Added `promptCacheKey` to public/simple/Agent/proxy surfaces and separated cache payload identity from session-based headers and connection reuse across supported adapters.
- 2026-08-26: Added GPT-5.6 implicit-mode TTL controls plus an explicit system-prompt breakpoint while retaining legacy fields for older models and explicit-only disabling for `cacheRetention: "none"`.
- 2026-08-26: Focused AI tests passed (162 passed, 4 skipped); focused Agent tests passed (27 passed); full repository check passed with no final rewrites.
- 2026-08-26: Merged the verified high-level forwarding gap into the existing cache-affinity entry in `LEARNS.md`; no duplicate lesson was added.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: AI Vitest command: 8 files passed, 162 tests passed, 4 skipped. Agent Vitest command: 2 files passed, 27 tests passed. Root `npm run check`: passed, including Biome, dependency/import/lock checks, TypeScript no-emit, and browser smoke validation.
- Limitations: Live provider A/B measurement is intentionally not run without explicit authorization and production-like traffic.
