# Task Plan: Real Large-Repo v2 Validation

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User explicitly authorized a real Google embedding endpoint and the real `openai-codex/gpt-5.6-luna` model at `thinkingLevel: "max"` for validation on a large repository.

<!-- task-doc-section:background-goal -->
## Background and goal

Run one bounded, auditable end-to-end validation of the optimized v2 Search/Read/Edit/Run toolchain against a large public TypeScript repository. Use Google’s OpenAI-compatible `gemini-embedding-001` endpoint for semantic candidate retrieval and `openai-codex/gpt-5.6-luna` with maximum thinking for the agent. Measure whether a hidden regression can be located, repaired, and verified without persisting prompts, source, tool output, credentials, or model output in this repository.

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope: credential-presence/model-auth preflight without printing secrets; a shallow pinned clone of `microsoft/vscode` under a temporary directory; one deterministic hidden mutation in an existing early-indexed TypeScript utility; one structured/semantic v2 agent session; Google embedding request/token/cost accounting; chat usage/cost, turns, sanitized tool trace, hidden filesystem grading, repository-size/index-coverage evidence, cleanup, task validation, and a documentation commit.

Non-goals: modifying or committing the external repository; sending private/local project code to Google; running the prior calibration or held-out matrix; retrying or rerunning a failed paid attempt; benchmarking all large repositories or claiming universal recall/latency; changing product code unless the one-shot run reveals a deterministic product defect and the user separately authorizes repair.

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | The user explicitly authorized real model and embedding endpoint calls and requested Google embeddings plus `gpt-5.6-luna` at max thinking. | Current user request. |
| F-002 | `GOOGLE_API_KEY` is present in the process environment; its value was not read or printed. The generic `PI_EMBEDDING_*`, `GEMINI_API_KEY`, and real-stage opt-in flags are unset. | Presence-only environment preflight on 2026-08-30. |
| F-003 | Google documents OpenAI-compatible embeddings at `https://generativelanguage.googleapis.com/v1beta/openai/embeddings` with model `gemini-embedding-001`; paid standard input pricing is $0.15 per million tokens. | `https://ai.google.dev/gemini-api/docs/openai`, `https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001`, and `https://ai.google.dev/gemini-api/docs/pricing`. |
| F-004 | The repository already exposes an explicit OpenAI-compatible semantic provider with request, byte, token-cost, dimension, cancellation, cache, and cursor gates, plus a real Agent `shouldStopAfterTurn` boundary at 18 turns. | `packages/coding-agent/src/core/tools/openai-compatible-embedding-search-provider.ts`; `packages/coding-agent/test/tool-profile-eval/full-real-eval.real.test.ts`. |
| F-005 | The worktree contains two protected user-owned untracked files under `docs/harness_tools/`; they must remain untouched and uncommitted. | Current `git status --short`. |
| F-006 | The temporary VS Code clone is pinned at `3aa54039a0bec1bd4f9b428cdb202b4271bf22ef`, contains 18,370 tracked files and 13,151 JS/TS files totaling 162,480,993 bytes, and is clean except for the single frozen hidden mutation. | Temporary-clone Git metadata, tracked-file scan, and T-002 oracle state. |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: A single-session global cap of $1.00, 18 assistant turns, 180 seconds, at most 12 embedding requests, 64 semantic documents, and 256 KiB uncached embedding input is a conservative bounded interpretation of the user’s paid-call authorization. The run stops rather than increasing a breaker.
- Assumption: `microsoft/vscode` is an appropriate large public TypeScript corpus; only its public source can cross the Google boundary.
- Assumption: One paid attempt is authoritative. Infrastructure, auth, quota, timeout, or task failure is recorded as failure/partial and is not rerun.
- Open question: None. Repository choice and bounded cost/turn limits can be selected conservatively without changing the requested model/provider combination.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Preflight proves the exact chat model exists and has configured auth without exposing credentials, and a minimal Google embedding request succeeds before the agent session only if it counts inside the same $1/request budgets.
- A shallow pinned VS Code clone has recorded commit, tracked-file count, JS/TS file count, and byte size; the hidden mutation starts failing its deterministic oracle and the expected restoration passes it.
- Exactly one real agent attempt uses tool profile `v2`, structured TypeScript Search, Google semantic Search, `thinkingLevel: "max"`, 18-turn pre-provider stopping, 180-second timeout, and the $1 combined known-cost cap.
- Google receives only the public clone’s semantic query and semantic documents generated from that clone. No Pi workspace source, credential, prompt, tool/model output, or external-repo source is persisted in the task document.
- The final record reports completed/aborted status, success/score, turns, token/cache/cost usage, embedding requests/tokens/cost, sanitized tool metrics, index completeness/skips, elapsed time, and hidden-oracle results.
- The temporary clone/session resources are cleaned; the two protected files remain untouched; task validation, focused diff/secret review, explicit staging, and a documentation commit pass.

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004`.
- Parallel batches: None. Paid preflight, fixture freeze, one-shot execution, and grading are intentionally serialized.
- Serialization constraints: T-003 may start only after the exact clone commit, mutation, expected solution, data boundary, and all breakers are frozen. No rerun is allowed after a provider request begins.

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Preflight credentials, model, endpoint, and breakers

- Status: done
- Owner: coordinator
- Objective: Prove the requested providers can be invoked safely before cloning or spending beyond the frozen cap.
- Inputs and prerequisites: User authorization; current auth storage; presence-only Google key; Google endpoint/model/pricing documentation.
- Scope or files: Read-only runtime/auth checks and temporary preflight scripts; this task document.
- Expected output: Exact model/auth confirmation, frozen endpoint/model/price and one-session budgets, with no secret output.
- Dependencies: None.
- Execution steps:
  1. Resolve `openai-codex/gpt-5.6-luna` through `ModelRuntime` and check auth presence only.
  2. Validate Google endpoint/model configuration and freeze all request/input/token/cost/turn/time limits.
  3. Validate the task document before any paid request.
- Acceptance criteria:
  - No credential value is printed or persisted.
  - Any missing auth/config blocks the run before clone mutation or paid execution.
- Verification method:
  - Temporary local preflight program and task-document validator.
- Validation evidence: A temporary Node strip-types preflight resolved exact model `openai-codex/gpt-5.6-luna` and returned `modelFound:true`, `authConfigured:true` without printing auth material. Presence-only environment inspection found `GOOGLE_API_KEY` set. Google’s documented OpenAI-compatible endpoint, `gemini-embedding-001`, 2,048-token input limit, and $0.15/M-token standard price were frozen. One-session limits are $1 combined known cost, 18 turns, 180 seconds, 12 embedding requests, 64 documents, and 256 KiB uncached input. The live Google probe is deferred until the public clone/query boundary is frozen so it cannot send an unapproved string. Task validation passed; no provider request occurred.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Freeze a large public repository and hidden oracle

- Status: done
- Owner: coordinator
- Objective: Create a reproducible large-repository fixture with a deterministic failing mutation and passing restoration.
- Inputs and prerequisites: T-001 done.
- Scope or files: Temporary shallow VS Code clone only; no Pi product path.
- Expected output: Pinned commit/size counts, target mutation, failing initial oracle, passing hidden expected solution, and public-source embedding allowlist.
- Dependencies: T-001.
- Execution steps:
  1. Shallow clone `microsoft/vscode` into a unique temporary directory and record content-free size metadata.
  2. Inspect an early-indexed TypeScript utility and apply one minimal reversible behavioral regression.
  3. Prove the hidden oracle fails after mutation and passes after the expected restoration, then restore the mutation for the one-shot starting state.
- Acceptance criteria:
  - Repository is materially large and pinned.
  - Oracle is non-vacuous and wrong-location changes are detectable.
- Verification method:
  - Git metadata/file counts and a local content-hash/text oracle; no model call.
- Validation evidence: The LFS-disabled shallow clone is pinned at commit `3aa54039a0bec1bd4f9b428cdb202b4271bf22ef` with 18,370 tracked files, 13,151 JS/TS files, 162,480,993 JS/TS bytes, and a 353,924 KiB checkout. A content-hash oracle proved the one-line mutation fails, an exact restoration passes with a clean tree, and reapplying the mutation leaves exactly one changed path. The bounded `src/vs/base/common/**` index scope contains 155 indexable tracked source files and 1,632,188 bytes. Its frozen semantic catalog contains 5,000 documents from 41 files, includes the hidden target, and truthfully reports `SEMANTIC_DOCUMENT_LIMIT`; only the exact frozen query and exact public-clone document bodies are admitted by the in-memory Google boundary. A three-request fake-endpoint dry run exercised catalog selection, session construction, the 256 KiB boundary, schema hashing, and hidden grading without a provider/API call; its deterministic token-overlap vectors ranked the target first. No paid request has occurred.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Execute one real structured/semantic v2 session

- Status: done
- Owner: coordinator
- Objective: Run the requested model/provider combination once against the frozen large-repo regression.
- Inputs and prerequisites: T-002 done; exact clone/mutation/oracles/data boundary frozen.
- Scope or files: Temporary clone and in-memory/temporary runner only.
- Expected output: One sanitized real execution record and hidden grade.
- Dependencies: T-002.
- Execution steps:
  1. Construct TypeScript and Google embedding providers with frozen limits and public-clone-only boundary validation.
  2. Create an ephemeral v2 Agent session using `openai-codex/gpt-5.6-luna`, max thinking, and the 18-turn gate.
  3. Submit one conceptual repair task, capture sanitized lifecycle/usage only, grade, and stop without rerun.
- Acceptance criteria:
  - Exactly one paid agent attempt occurs and no nineteenth provider request is possible.
  - Embedding request count is positive, all boundary checks pass, and combined known cost remains at or below $1.
  - Success/failure is graded from hidden filesystem state, not model prose.
- Verification method:
  - Sanitized counters, provider usage, trace collector, hidden oracle, and attempt counter.
- Validation evidence: Exactly one real attempt completed successfully with `openai-codex/gpt-5.6-luna`, `thinkingLevel: max`, and tool profile `v2`. It made 6 chat requests/assistant turns, used 7,671 input, 1,030 output, 10,752 cache-read, and 0 cache-write tokens, and cost $0.00298524. Google `gemini-embedding-001` made 4 network requests for 15,825 embedding tokens and 63,291 allowlisted input bytes, costing $0.00237375. Total known cost was $0.00535899 against the $1 cap; the 18-chat-request, 12-embedding-request, 180-second, 256-KiB, and pre-request $0.3664 worst-case chat-cost reserve gates all held. The session finished in 34,418 ms with no boundary violation. The sanitized trace contains 5 successful tool calls, 0 tool errors, 0 schema errors, first-search target rank 1, a target-first read, one post-edit read, and one observed semantic search. Hidden grading found the exact target restored, no wrong-location changes, and a clean external repository, yielding success `true` and score `1.0`. The terminal one-shot marker independently records 6 chat and 4 embedding requests, preventing a paid rerun.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Finalize evidence, cleanup, audit, and commit

- Status: done
- Owner: coordinator
- Objective: Record the one-shot result truthfully and leave only task-owned documentation committed.
- Inputs and prerequisites: T-003 terminal outcome.
- Scope or files: This task document, temporary cleanup, explicit Git commit.
- Expected output: Valid content-free task result, removed clone, protected-file audit, and documentation commit.
- Dependencies: T-003.
- Execution steps:
  1. Record exact sanitized metrics, limitations, and whether the run completed, aborted, passed, or failed.
  2. Remove temporary clone/runner artifacts and verify no session/source/credential output entered the repository.
  3. Validate task structure and diff, stage explicit task-owned documentation, scan for credentials, and commit.
- Acceptance criteria:
  - No source, prompt, model/tool output, session transcript, or credential is committed.
  - Final status matches the hidden grade and any breaker/infrastructure outcome.
- Verification method:
  - Task validator, `git diff --check`, status/protected review, staged name/secret audit, commit inspection.
- Validation evidence: The sanitized result and independent one-shot marker agreed on success, 6 chat requests, 4 embedding requests, exact target restoration, a clean external repository, no boundary violation, and $0.00535899 total known cost. Cleanup removed all three `/tmp/pi-vscode-real-eval.*` roots plus the pointer, oracle, runner, and self-removing cleanup script; an explicit absence check found no matching root or file. The Pi worktree contains only this task document and the same two protected untracked harness documents. Content scanning found no private-key marker, Google key literal, bearer token, transcript event, prompt, source, tool output, or model output. The task validator, `git diff --check`, explicit staged-name review, staged secret/content audit, and task-document-only documentation commit all passed; no code test or root check was needed for a documentation-only change.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Use only presence/auth preflight before spending. Freeze one public shallow clone and a non-vacuous local oracle. Execute one Agent session with existing sanitized trace and provider accounting, no retry. Validate exact usage/turn/request/cost and hidden filesystem state. Do not run the prior real matrix, full test suite, or root build. Finish with temporary cleanup, task validation, `git diff --check`, protected-path and staged-secret review, explicit staging, and documentation commit.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

Real APIs incur cost and can fail due auth, quota, rate, network, or model availability; one attempt and hard breakers bound exposure. Google embeddings send public code off-host; a public-clone-only allowlist must reject every other input. `gemini-embedding-001` has a 2,048-token input limit, so semantic documents remain bounded and endpoint errors are terminal. A very large repository can hit the 2,000-file/32-MiB TypeScript index limits; partial coverage must be recorded and the target chosen inside a justified scope rather than treated as complete-root proof. Model behavior is stochastic; no rerun may convert failure into success. Temporary clone cleanup must not use unsafe deletion against any non-temporary path. Protected harness documents and `.env` remain untouched.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: User explicitly authorized real Google embeddings and `openai-codex/gpt-5.6-luna` at max thinking on a large repository. Presence-only preflight found `GOOGLE_API_KEY` set and generic embedding flags unset; no credential value was read or printed. Google’s documented OpenAI-compatible endpoint/model and $0.15/M-token standard price were confirmed. T-001 started; no paid request has occurred.
- 2026-08-30: T-001 completed after exact model/auth presence and all endpoint/breaker checks passed without network calls. Live Google probing is intentionally delayed until the public-source allowlist exists. T-002 started.
- 2026-08-30: T-002 completed. The pinned clone/oracle cycle passed, the bounded semantic catalog and exact public-source boundary were frozen, and a fake-endpoint dry run validated the temporary runner without any real provider call. The catalog is intentionally reported partial because the 5,000-document semantic limit covers 41 of the 155 in-scope source files, while the hidden target is present. T-003 started; this transition is still before the first paid request.
- 2026-08-30: T-003 completed on the sole paid attempt. Google embeddings and `gpt-5.6-luna` max both ran within every breaker; the semantic search ranked the target first, the exact hidden restoration passed, the external clone ended clean, and combined known cost was $0.00535899. No rerun was made or permitted. T-004 started for content-free recording, cleanup, audit, and commit.
- 2026-08-30: T-004 completed. Sanitized metrics were recorded, all three clone roots and temporary scripts/state were removed through exact-path guards, protected paths remained unmodified, task/diff/content/staging audits passed, and only this task document was committed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: One `openai-codex/gpt-5.6-luna` max session completed successfully with structured/semantic v2 tools and real Google `gemini-embedding-001`: score `1.0`, first semantic-search target rank `1`, exact hidden restoration, clean clone, 6/18 chat requests, 4/12 embedding requests, 63,291/262,144 embedding input bytes, 34,418/180,000 ms, no data-boundary violation, and $0.00535899/$1 total known cost. Cleanup and repository audits passed, and the task-owned documentation was explicitly committed.
- Limitations: This is one stochastic task on one pinned public repository. The semantic catalog hit its 5,000-document limit and covered 41 of 155 in-scope source files, so the result validates the bounded target-bearing scope and breakers, not universal large-repository recall or latency.
