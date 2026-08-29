# A/B/C result — `openai-codex/gpt-5.6-luna`

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

## Deterministic FFF Search evidence

After making the local v2 Search backend FFF-first, a no-model paired benchmark compared the actual model-visible Search outputs of `LocalSearchProviderV2` and `FffSearchProvider`. The fixed fixture contains five typo/transposition file-name queries, each with one target, three related siblings, and a 400-file noisy tree. A scripted exact-name fallback runs only when the first query misses.

| Metric | Local rg/fd | FFF-first |
| --- | ---: | ---: |
| First-query Recall@5 | 0/5 | 5/5 |
| Mean reciprocal rank | 0.0 | 1.0 |
| Target ranked first | 0/5 | 5/5 |
| Mean Search calls | 2.0 | 1.0 |
| Mean discovery-call proxy | 3.0 | 2.0 |
| Model-visible result bytes | 945 | 860 |
| Estimated result tokens (chars/4) | 240 | 215 |
| Irrelevant-hit rate | 75% | 75% |
| Duplicate hits | 0 | 0 |
| Peak retained result tokens | 240 | 215 |
| Cumulative visible result tokens | 1,237 | 651 |
| Descriptive mean elapsed ms | 24.09 | 11.16 |

In this synthetic typo workload, FFF removed one retry per query, reduced the discovery-call proxy by 33.3%, model-visible result bytes by 9.0%, estimated retained result tokens by 10.4%, and cumulative result-context exposure by 47.4%. It did not improve the 75% irrelevant-hit ratio within the top five, so the evidence supports typo ranking and retry/context reduction, not a broad relevance claim. Timing is descriptive and has no stability or causal gate.

The stress test separately passed native text search in a 12,000-line file inside a 3,000-file noisy index, bounded three-result continuation without duplicates, explicit approximate/partial signaling for an incomplete zero-wait scan, and local fallback for exact case semantics. These are deterministic provider/tool tests, not additional model sessions; actual filesystem files scanned are not exposed by the shared `SearchPage` contract, and the candidate-read count is therefore a documented discovery-effort proxy rather than an OS scan count.
