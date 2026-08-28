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
