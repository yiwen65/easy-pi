# Historical A/B/C result — `openai-codex/gpt-5.6-luna`

This section preserves the completed 15-session happy-path run from the earlier evaluation contract. It is not evidence for the current P0/P1/P2 recovery and structured-retrieval requirements.

Run contract:

- model: `openai-codex/gpt-5.6-luna`
- thinking: `max`
- fixed seeds: `17, 41, 73, 101, 137`
- one reset composite discover/read/move/multi-file-edit/test fixture per session
- variants: A native complete tools; B current v2; C full opt-in v2 with journaled mutation and minimal hooks
- sessions: exactly 15 (5 per variant)
- persisted data: aggregate behavior metrics and hashes only; no credentials, prompts, paths, commands, file contents, tool output, or model output

## Aggregate result

| Metric | A | B | C |
| --- | ---: | ---: | ---: |
| Successful sessions | 5/5 | 5/5 | 5/5 |
| Mean model turns | 6.0 | 5.6 | 5.2 |
| Mean tool calls | 10.6 | 7.4 | 6.2 |
| Tool errors | 0 | 0 | 0 |
| First edit succeeded | 5/5 | 5/5 | 5/5 |
| First read selected target | 4/5 | 4/5 | 4/5 |
| Search target rank 1 | n/a | 5/5 | 5/5 |
| Schema/invalid-input errors | 0 | 0 | 0 |
| Shell/run misuse count | 6 | 0 | 0 |
| Approximate search results | 0 | 0 | 0 |
| Mean elapsed ms | 20,305.4 | 19,215.0 | 16,959.6 |
| Mean model-only elapsed ms | 20,215.2 | 19,127.6 | 16,759.6 |
| Total input tokens | 35,876 | 32,206 | 32,867 |
| Total output tokens | 3,335 | 3,261 | 2,755 |
| Total cache-read tokens | 29,184 | 14,848 | 6,144 |
| Total reported cost USD | 0.011761 | 0.010651 | 0.010002 |

Paired completion-score deltas were all zero (`B−A=0`, `C−B=0`, `C−A=0`); the clustered 95% bootstrap interval for `C−A` was `[0, 0]` because every session completed successfully.

B and C exposed the same four model schemas; A exposed the separate seven-tool native schema. C used 41.5% fewer tool calls than A and 16.2% fewer than B in this sample. C's mean elapsed time was 16.5% below A and 11.7% below B, but five sessions per variant are insufficient to attribute latency differences causally.

No run produced tool errors, recovery, partial/approximate search, or truncation, so this run validates the happy-path composite workflow but does not estimate those rare-path rates. The candidate remains opt-in; the default profile remains legacy and the v2 edit dialect remains operations.

## Current deterministic P0/P1/P2 evidence

The current no-model matrix executes all 16 declared requirement scenarios through actual legacy/v2 definitions over generated temporary fixtures. It activates legacy text, v2 text, production JS/TS structured Search/Read, deterministic semantic candidates, query templates, preferred-path ranking, partial coverage, overflow, versioned Edit recovery, and focused Run repair. It persists only counts and numeric metrics.

| Safety oracle | Result |
| --- | ---: |
| Scenarios passed | 16/16 |
| Ambiguity rejection | 1/1 |
| Stale view/patch/preimage rejection | 3/3 |
| Truncation disclosure | 3/3 |
| Wrong-location protection | 3/3 |
| Silent replace-all prevention | 1/1 |
| Unversioned write prevention | 3/3 |
| Syntax-failure state disclosure | 1/1 |

| Retrieval variant | Queries | Precision@5 | Hit@5 | Mean target rank | Complete / partial / overflow |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy | 1 | 0.250 | 1.000 | 1.000 | 1 / 0 / 0 |
| text-v2 | 3 | 0.750 | 1.000 | 1.333 | 2 / 0 / 1 |
| structured-v2 | 5 | 0.567 | 0.800 | 1.000 | 4 / 1 / 0 |
| structured without path prior | 1 | 0.333 | 1.000 | 3.000 | 1 / 0 / 0 |
| semantic-v2 | 1 | 0.500 | 1.000 | 1.000 | 1 / 0 / 0 |

The path-prior ablation improved target rank from 3 to 1. The three workflow samples averaged 1.33 locate calls, 3.67 safe-edit calls, and 5.67 verification calls; they returned 3,094 bytes / 777 estimated tokens at $0. Host-local workflow latency was p50 17.26 ms and p95 82.73 ms. These mixed fixtures intentionally do not support a universal structured Precision@5 advantage; they verify capability activation, truthful coverage, bounded context, ranking effects, and exact safety behavior.

## Current real-run status

The replacement evaluator freezes 6 calibration and 42 held-out sessions across legacy, text-v2, and structured/semantic-v2 with 18-turn/session, 48-session, and $5 combined breakers. Calibration completed 6/6 hidden-oracle workflows with 100% wrong-location protection and external-change preservation. It consumed $0.03481999, made 4 guarded embedding requests for 277 synthetic-fixture tokens, and observed at most 16/18 turns. Calibration remains excluded from held-out aggregates.

| Calibration variant | Success | Mean turns | Mean tool calls | Tool errors | Schema errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy | 2/2 | 8.5 | 11.5 | 2 | 0 |
| text-v2 | 2/2 | 15.5 | 19.5 | 16 | 6 |
| structured/semantic-v2 | 2/2 | 12.5 | 16.0 | 8 | 6 |

Deterministic diagnosis found that Read's model-visible union branches each advertised both `path` and `locatorId` although runtime required exactly one, while custom text-only sessions advertised unavailable structured/semantic capabilities. Regressions now prove exclusive Read branches and provider-capability-aware Search/Read guidance. Search schema descriptions and prompt guidance also state the selector, `kind`, `context`, `targetKind`, and `ranking` constraints; faux structured and semantic executions prove valid normalized requests. The exact arguments of three historical Search `INVALID_INPUT` calls were intentionally not persisted, so no individual historical conflict class is claimed. Intentional stale locator/view/patch rejection remains covered by the deterministic safety matrix.

The held-out stage was invoked exactly once. Four sessions completed successfully, then the fifth attempt (legacy variant) crossed the reactive assistant-turn guard and stopped the sequential matrix with `model_turn_budget_exceeded`; the remaining 37 sessions were not started. The held-out opt-in was disabled immediately and this stage will not be rerun.

| Partial held-out variant | Attempts | Completed / successful | Mean turns | Mean tool calls | Tool errors | Schema errors | Known cost USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 2 | 1 / 1 | 8.0 | 9.0 | 0 | 0 | 0.00518636 |
| text-v2 | 1 | 1 / 1 | 8.0 | 12.0 | 2 | 0 | 0.00354192 |
| structured/semantic-v2 | 2 | 2 / 2 | 7.5 | 7.0 | 0 | 0 | 0.00651546 |

All four completed records scored 1 and preserved every wrong location and external change. The structured/semantic records made 4 guarded embedding requests for 554 synthetic-fixture tokens. Their mean first-target rank was 1; the text-v2 record's was 4. The text-v2 record recovered from two capability errors without a schema error. Completed-record token totals were 35,008 input, 5,724 output, and 64,512 cache-read tokens; the aborted record has no finalized usage.

Known completed held-out cost is $0.01524374, making the known calibration-plus-completed total $0.05006373. The aborted legacy attempt's final chat usage was unavailable because the breaker threw before record finalization, so exact total cost is not claimed; it made no embedding request. Six calibration sessions plus five held-out attempts consumed 11 of the 48 authorized session starts.

The captured failure also proved the evaluator enforced the 18-turn cap one turn late: it aborted after observing turn 19. A deterministic red/green regression now drives `Agent.shouldStopAfterTurn` after turn 18 when tool results would otherwise trigger another provider request, while still allowing a final answer on turn 18. No held-out rerun was performed after this evaluator fix. Therefore the real comparison is partial and cannot support seven-family or 14-runs-per-variant conclusions.

## Deterministic FFF Search evidence

After making the local v2 Search backend FFF-first, a no-model paired benchmark compared the actual model-visible Search outputs of `LocalSearchProviderV2` and `FffSearchProvider`. The fixed fixture contains five typo/transposition file-name queries, each with one target, three related siblings, and a 400-file noisy tree. A scripted exact-name fallback runs only when the first query misses.

| Metric | Local rg/fd | FFF-first |
| --- | ---: | ---: |
| First-query Recall@5 | 0/5 | 5/5 |
| Mean reciprocal rank | 0.0 | 1.0 |
| Target ranked first | 0/5 | 5/5 |
| Mean Search calls | 2.0 | 1.0 |
| Mean discovery-call proxy | 3.0 | 2.0 |
| Model-visible result bytes | 1,545 | 1,260 |
| Estimated result tokens (chars/4) | 390 | 315 |
| Irrelevant-hit rate | 75% | 75% |
| Duplicate hits | 0 | 0 |
| Peak retained result tokens | 390 | 315 |
| Cumulative visible result tokens | 2,037 | 951 |
| Descriptive mean elapsed ms | 20.16 | 11.19 |

In this synthetic typo workload, FFF removed one retry per query, reduced the discovery-call proxy by 33.3%, model-visible result bytes by 18.4%, estimated retained result tokens by 19.2%, and cumulative result-context exposure by 53.3%. It did not improve the 75% irrelevant-hit ratio within the top five, so the evidence supports typo ranking and retry/context reduction, not a broad relevance claim. Timing is descriptive and has no stability or causal gate.

The stress test separately passed native text search in a 12,000-line file inside a 3,000-file noisy index, bounded three-result continuation without duplicates, explicit approximate/partial signaling for an incomplete zero-wait scan, and local fallback for exact case semantics. These are deterministic provider/tool tests, not additional model sessions; actual filesystem files scanned are not exposed by the shared `SearchPage` contract, and the candidate-read count is therefore a documented discovery-effort proxy rather than an OS scan count.

## Deterministic locator-safe chain evidence

A second no-model fixture executed the actual four-tool v2 definitions through `search → read → edit prepare → edit commit → read verify`. The fixture repeats one assignment across source, test, vendor, and a generated 12,000-character line, then separately exercises same-range ambiguity, a changed prepared preimage, search overflow, an overlong-line locator read, and unsupported symbol intent.

| Metric | Result |
| --- | ---: |
| Broad matches / duplicate locator IDs | 4 / 0 |
| Scoped target Precision@1 | 100% |
| Locator Search bytes | 270 |
| Prior full-line Search baseline bytes | 12,259 |
| Search-output reduction | 97.8% |
| Calls to prepared safe edit | 4 |
| Calls including focused Read verification | 5 |
| Full safe-chain model-visible bytes | 1,045 |
| Estimated full-chain tokens (chars/4) | 262 |
| Ambiguity rejection | 1/1 |
| Changed-preimage rejection | 1/1 |
| Truncation disclosure | 1/1 |
| Unsupported-structure disclosure | 1/1 |
| Wrong-location writes | 0 |

The full five-call locator/read/prepare/commit/verify chain remained below the old one-call full-line Search baseline because the generated long line stayed behind a match-centered locator and bounded Read fragment. Prepare performed no mutation; commit consumed the patch handle and rechecked all observations. The source target changed, while test, vendor, generated, and ambiguous fixtures remained unchanged.

Limits: this is a deterministic synthetic fixture, not a new model run or a repository-wide latency study. The 97.8% figure is intentionally driven by the overlong generated-line case and is not a universal expected reduction. Token values use chars/4. Production structured Search/Read is limited to JS/TS; other languages fail closed. Semantic retrieval remains explicit opt-in, and the current semantic evidence uses a local static provider rather than a remote embedding call. Files above the editable hash limit return non-editable views, and the default mutation backend still makes no cross-file atomic-visibility or OS-sandbox claim.

## Bounded public-repository evaluation — PREIMAGE recovery

This evaluation is separate from the historical runs above. It used `openai-codex/gpt-5.6-luna` with max thinking and Google `gemini-embedding-001` against pinned public VS Code and Vitest clones. The sealed contract hash is `01cee1d...94278`; the baseline was HEAD `51a6534c9`, and the frozen candidate changed only the model-visible `PREIMAGE_MISMATCH` recovery instruction plus its regression test (`3a011dab...359b`). The persisted content-free evidence is `v2-bounded-real-eval-results.json`.

D-01 aborted before provider dispatch because the evaluator rejected three static Pi documentation-reference lines in the frozen system prompt. Its zero-request record was preserved and not rerun. D-02 supplied the usable paired development comparison:

| D-02 metric | Baseline | Candidate |
| --- | ---: | ---: |
| Task completion / score | no / 0.8667 | yes / 1.0000 |
| Search / Read / Edit / Run calls | 2 / 4 / 4 / 0 | 1 / 4 / 3 / 1 |
| `PREIMAGE_MISMATCH` errors | 2 | 1 |
| Target rank / required Read coverage | 1 / 100% | 1 / 100% |
| Verifier Run succeeded | no activation | yes, exit 0 |
| Combined reported tokens | 56,346 | 53,194 |
| Provider payload bytes | 601,362 | 581,971 |
| Tool-return bytes | 7,547 | 7,074 |
| Useful / duplicate / irrelevant / ambiguous active context bytes | 1,005 / 39,920 / 3,208 / 661 | 1,039 / 40,853 / 2,950 / 848 |
| Peak active tool-result bytes | 6,819 | 7,074 |
| Elapsed ms | 72,794 | 62,818 |
| Known cost USD, including embeddings | 0.00766434 | 0.00672958 |

The actionable error saved one Search, one failed Edit, and enough turns to activate the required Run. Combined tokens fell 5.6%, provider payload 3.2%, tool-return bytes 6.3%, elapsed 13.7%, and known cost 12.2% in this single paired sample. Active tool-result context rose 2.0% and its peak rose 3.7% because the retained recovery error was longer. The completion benefit was retained; latency and cost changes are descriptive, not causal estimates.

The one-shot held-out stage was unsuccessful. H-01 stopped before mutation or provider dispatch on an evaluator-only cross-repository prompt-normalization defect; its attempt was preserved and not rerun. H-02 ranked the semantic target first but exhausted its eight-turn cap after 6 Search and 5 Read calls, with three wrong-candidate Reads, one semantic duplicate, one repeated Read, zero Edit, and zero Run. It scored 0.5333, used 39,874 combined reported tokens, took 50,960 ms, and cost $0.00526898. Because H-02 made no Edit call and only the evaluator's target mutation was dirty, it made no wrong-location write; the immutable raw record's `wrongLocationsUnchanged: false` conflates target failure with off-target mutation, and the persisted result carries an explicit correction while retaining the raw record and hash.

| Final bounded budget | Used | Cap |
| --- | ---: | ---: |
| Sessions started | 5 | 6 |
| Chat requests | 28 | 56 |
| Embedding requests | 6 | 24 |
| Combined paid requests | 34 | 80 |
| Embedding tokens | 14,118 | 250,000 |
| Combined reported tokens | 149,414 | 800,000 |
| Known cost USD | 0.01966290 | 15.00 |

This is a bounded real evaluation, not a general benchmark. It has one usable paired development case, no completed held-out task, two preserved zero-dispatch evaluator aborts, fixed public commits, stochastic model behavior, and a frozen eight-to-ten-turn session ceiling. No held-out attempt was rerun or used for product tuning. The evidence supports preserving the more actionable PREIMAGE recovery message, but it does not establish broad held-out task-completion improvement.

Final offline validation passed 101 focused Agent tests and 80 focused coding-agent tests; the gated real test was skipped. The 16-scenario deterministic matrix remained 16/16, root `npm run check` passed without rewrites, both public clones were clean at their sealed commits, and candidate, protected-file, and immutable held-out hashes remained exact. Final report preparation completed within the 150-minute evaluation cap and made no additional provider request.
