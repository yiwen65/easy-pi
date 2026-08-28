# Session Handoff: Pi cache hit rate optimization

- Created: 2026-08-23T18:34:58+08:00
- Workspace: /Users/w/Projects/easy-pi/pi

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting. This handoff supplies context, not new authorization.

## Session summary

- The goal was to compare Pi's implementation with `docs/harness/cache hit rate.md`, implement low-risk cache-hit improvements, and verify them. The authoritative task plan is complete with `Overall status: done` and `Result: passed`.
- Durable `AgentHarness` now defaults Provider `sessionId` to the durable session metadata ID, preserves explicit caller overrides, and retains that affinity through `setStreamOptions`; faux-provider regression showed a warm cache read and zero cache activity with `cacheRetention: none`.
- OpenAI prompt cache keys longer than 64 Unicode code points now use a readable bounded prefix plus a deterministic hash of the complete key, avoiding collisions for keys that share a long prefix.
- The TUI metric formerly labeled `CH` was not request-level cache hit rate. It is now consistently named `CR` / `latestCacheReadRatio`; its formula remains `cacheRead / (input + cacheRead + cacheWrite)`.
- A real Provider run exposed `SessionError: Durable payload contains undefined`. The product fix normalizes Provider assistant messages at the provider-to-durable persistence boundary by recursively dropping object properties whose value is `undefined`; the strict durable JSON contract was intentionally retained.
- The opt-in real eval initially failed with `fetch failed`. Safe diagnostics localized this to `UND_ERR_CONNECT_TIMEOUT` for `chatgpt.com`; the standalone test had not installed coding-agent's `configureHttpDispatcher()`. Installing the production dispatcher in the opt-in path resolved it.
- Authorized `openai-codex/gpt-5.6-luna` SSE validation passed: cold input 6884, cacheRead 0, output 9, 2403 ms; warm input 1025, cacheRead 5888, output 21, 1837 ms; warm cached-input ratio 85.17%.
- Final evidence: 61/61 targeted deterministic tests passed, real eval default mode 1/1 skipped, opt-in Luna eval 1/1 passed, `npm run check`, task-path `git diff --check`, and task-document validation passed.
- There are no task blockers, but the workspace is heavily dirty with changes from multiple sessions. This work is uncommitted; do not treat the full diff of shared files such as `agent-harness.ts` as belonging only to this task.

## User intent and success criteria

The user asked for an evidence-backed analysis and implementation based on the cache-hit-rate methodology, followed by real OpenAI Codex validation using Luna. Success required:

- default same-session Provider/cache affinity with explicit override semantics;
- observable faux warm cache reads and disabled-cache behavior;
- collision-resistant, deterministic, 64-code-point OpenAI cache keys;
- accurate TUI/README cache metric naming;
- an explicitly gated real Luna double request with warm `cacheRead > 0` and redacted usage/latency reporting;
- targeted regression, static checks, and honest limits on conclusions.

All criteria have recorded evidence in the task document.

## Work completed and outcomes

1. Implemented default durable session affinity in `AgentHarness.create()` and preservation in `setStreamOptions()`.
2. Added regressions for default session ID, explicit override, faux cold/write then warm/read behavior, disabled retention, and strict durable JSON persistence.
3. Changed long OpenAI cache-key encoding to bounded prefix plus full-input deterministic hash; short keys remain unchanged.
4. Renamed current cached-input token ratio from `CH`/cache-hit terminology to `CR`/cache-read terminology across standard and Grok TUI code, README, and tests without changing the calculation.
5. Added `packages/coding-agent/test/real-cache-affinity-eval.test.ts`. It is skipped unless `PI_REAL_MODEL_EVAL=1`, uses local `ModelRuntime`/`AuthStorage`, prints only usage/latency or redacted transport diagnostics, and does not print response text or credentials.
6. Fixed Provider assistant-message durable persistence by applying `stripUndefined` before writing the durable entry and using the normalized message for usage recording.
7. Diagnosed the real-eval transport failure and aligned the standalone eval with the production HTTP dispatcher. Luna then produced a real warm cache read of 5888 tokens.
8. Closed all tasks T-001 through T-007 and validated the task document.

## Key decisions, constraints, and rationale

- Default affinity is scoped to the durable session metadata ID. Cross-session sharing was rejected because tenant/authorization scope is unavailable and unsafe to infer.
- Explicit `streamOptions.sessionId` remains authoritative so callers can deliberately choose another safe affinity scope.
- The durable JSON schema was not relaxed. Normalization occurs at the Provider-message persistence boundary because Provider messages may legally contain optional `undefined` fields while durable storage requires strict JSON.
- Cache-write reporting was not required from OpenAI; real success was defined as warm `cacheRead > 0` plus recorded usage and latency.
- The real test is opt-in to avoid accidental network/provider usage. Prior user authorization in this session is historical context, not continuing authorization for a new agent.
- The real measurements prove wiring and one actual prefix-cache hit only. They do not establish production average hit rate, statistically significant latency improvement, or behavior of other models/providers.
- Larger work was deliberately deferred: cross-session cache cohorts, structured prompt layering, Gemini explicit cached-content objects, general tool caching, semantic/final-answer caching, and production telemetry baselines.
- The shared working tree already contained many unrelated edits. Changes were made surgically and were not committed or published.

## Files and artifacts

Authoritative artifacts:

- `/Users/w/Projects/easy-pi/pi/docs/tasks/2026-08-23-pi-cache-hit-rate-task.md` — completed execution plan, evidence, log, and final limitations.
- `/Users/w/Projects/easy-pi/pi/docs/harness/cache hit rate.md` — source methodology.

Task implementation and tests:

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/test/harness/agent-harness-scaffold.test.ts`
- `packages/ai/src/api/openai-prompt-cache.ts`
- `packages/ai/test/openai-completions-prompt-cache.test.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/coding-agent/src/modes/interactive-grok/components/grok-stats-bar.ts`
- `packages/coding-agent/README.md`
- `packages/coding-agent/test/footer-width.test.ts`
- `packages/coding-agent/test/grok-shell-components.test.ts`
- `packages/coding-agent/test/server/create-harness.test.ts`
- `packages/coding-agent/test/real-cache-affinity-eval.test.ts` — currently untracked in the dirty worktree.

Important workspace state: `git status --short` showed many modified and untracked paths unrelated to this task. The task document is also currently untracked. Re-run status and inspect path-specific diffs before any commit or cleanup.

## Commands, validation, and evidence

Real Luna validation that passed:

```bash
cd /Users/w/Projects/easy-pi/pi/packages/coding-agent
PI_REAL_MODEL_EVAL=1 \
PI_REAL_CACHE_PROVIDER=openai-codex \
PI_REAL_CACHE_MODEL=gpt-5.6-luna \
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/real-cache-affinity-eval.test.ts --silent=false
```

Reported redacted metrics:

```text
cold: input=6884 output=9 cacheRead=0 cacheWrite=0 elapsedMs=2403
warm: input=1025 output=21 cacheRead=5888 cacheWrite=0 cacheReadRatio=0.8517 elapsedMs=1837
```

Final deterministic validation:

- `packages/agent/test/harness/agent-harness-scaffold.test.ts`: 7/7 passed.
- `packages/ai/test/openai-completions-prompt-cache.test.ts`: 16/16 passed.
- Coding-agent footer, Grok, server harness tests: 38/38 passed.
- Real eval without opt-in: 1/1 skipped and did not call a Provider.
- `cd /Users/w/Projects/easy-pi/pi && npm run check`: passed all phases; Biome reported no fixes applied on the final run.
- Task-related `git diff --check`: passed.
- `python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-08-23-pi-cache-hit-rate-task.md`: passed.

The earlier transport boundary was `TypeError: fetch failed`, caused by `UND_ERR_CONNECT_TIMEOUT`; no credentials or response bodies were recorded.

## Unresolved items, risks, and unknowns

- No implementation or validation blocker remains for the agreed scope.
- All work is uncommitted. Ownership of unrelated modifications in the shared workspace is unknown; do not reset, format broadly, or commit the entire working tree.
- The real result is a single Luna session with two requests. Production cache-hit distribution and latency benefit remain unknown.
- Cross-session cohort safety, structured prompt-layer impact, explicit Provider cache objects, tool cache policy, and telemetry design remain future work rather than defects in this completed scope.
- Re-running the opt-in eval may consume Provider capacity and requires fresh authorization/context. Local credentials are read through `AuthStorage`; they were not copied into this handoff.

## Recommended continuation

1. Re-run `git status --short` and inspect only the listed task paths to detect drift; no user input is needed for this read-only check.
2. If asked to commit or publish, first isolate task-owned hunks from unrelated shared-file changes, especially in `packages/agent/src/harness/agent-harness.ts`; committing has not been authorized by this handoff.
3. Do not repeat real Provider calls unless the user freshly authorizes them. If further optimization is requested, establish a multi-session workload baseline before choosing among prompt layering, safe cache cohorts, explicit Provider caches, or telemetry work.
