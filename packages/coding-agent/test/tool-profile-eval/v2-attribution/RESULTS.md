# V2 cost attribution and bounded remediation

**Result: partial.** The fixed protocol input-token difference is measured and reconciled. A small protocol-only remediation passes local regressions and reduces fixed serialized bytes. Candidate task tokens, cost, latency, accuracy and safety superiority remain **unproven**: the real run stopped on unknown usage before obtaining a complete development pair.

Authority: [`2026-09-05-v2-cost-attribution-remediation-task.md`](../../../../../docs/tasks/2026-09-05-v2-cost-attribution-remediation-task.md). Content-free request records, immutable evidence hashes and accounting: [`results.json`](./results.json).

## 1. Contract and execution boundary

- A: original native `read/bash/edit/write`; B: original V2 `search/read/edit/bash`; C: locally remediated V2. Default profile remains native.
- Baseline revision: `38c64d5b60eadaff13a7ff480c32d92f62b3817e`.
- Model: `openai-codex/gpt-5.6-luna`, `max`, SSE, no retries, compaction, embedding or resource discovery. All **9 outgoing payloads** confirmed model/max.
- New independent ceilings: **$15 / 240 requests / 2,000,000 total tokens / 180 minutes**. Clock started **2026-09-05 21:33:13.621 +0800**, including local evaluation and remediation; it was not reset.
- Host: macOS 26.5.1, arm64 Apple M5, 24 GiB, Node v24.15.0. No Windows or general-population performance inference.
- Public synthetic fixtures only; verification scripts read data, never execute model-written code. Transient writes are observed at mutation I/O, so later rollback does not erase a violation. Concurrent faults occur after the first successful target Read returns its old view, not before Read.
- Same production SDK/tool wiring and fixed task cwd. Only installation documentation references are normalized. Protocol snapshots retain `constrainedSampling`; this run explicitly uses the default non-experimental setting.
- Detached baseline and live checkout matched product, ignored public model-catalog, runner and runtime-function hashes before generation. Baseline isolation was rechecked after C edits. No historical U-01–U-04/held-out scenario was rerun or changed.
- External sealed evidence: `/tmp/pi-v2-attribution-FhvQ0M`. `protocol-A/B.json` are public protocol **input** snapshots, not model responses. Results contain no source, prompts, tool/model bodies or credentials. The baseline worktree is retained there.

## 2. MEASURED: fixed input cost, before any task history

Each probe uses the same short user input, `toolChoice=none` and one request. Counts below are provider input + cache-read + cache-write tokens; cache counts were zero. No bytes/4 or guessed tokenizer is used.

| Probe | Input tokens | Output tokens |
| --- | ---: | ---: |
| Base instruction, no tools | 25 | 5 |
| A system only | 549 | 5 |
| B system only | 907 | 5 |
| A tools only | 538 | 17 |
| B tools only | 1,350 | 5 |
| A system + tools | 1,062 | 20 |
| B system + tools | 2,232 | 5 |

The controlled differences reconcile exactly:

- **Tools protocol: +812 input tokens/request (69.4% of the difference).**
- **System prompt: +358 input tokens/request (30.6%).**
- **Combined: +1,170 input tokens/request = 812 + 358.**

This locates the first cost divergence **before tool results exist**. A smaller returned tool body cannot cancel the larger fixed protocol repeatedly submitted on each request.

### Schema and description bytes are not exact component tokens

| Serialized parameter value | A bytes | B bytes |
| --- | ---: | ---: |
| Read | 304 | 3,058 |
| Edit | 776 | 1,486 |
| Bash | 313 | 313 |
| Write / Search (different capabilities) | 225 | 3,123 |
| Entire tools value, including descriptions/wrappers | 3,041 | 9,243 |
| Entire system instruction value | 2,501 | 4,352 |

The probes attribute **tools as a whole**, not each tool's exact tokenizer share. Search/Read parameter repetition is visible in bytes; their individual provider-token costs remain unattributed.

**Supported inference about the previous frozen result:** 20 requests × 1,170 = 23,400 tokens is very close to its 23,433-token input increase. This strongly supports repeated fixed protocol overhead as the dominant mechanism. It is not an exact retrospective decomposition: this experiment normalized installation references and did not re-tokenize or rerun the historical requests.

## 3. Repeated context, generated output and time

`PayloadMeter` partitions disjoint serialized JSON values into system, tools, user, assistant text, tool calls, tool results, reasoning and other history. Remaining field names/separators/top-level metadata are protocol bytes. Every request's sections sum exactly to total payload bytes. A hash-only set distinguishes new history from history already carried on a prior request; it is **not** a billing-cache measurement.

The only attempted development session (`D-11/A`) demonstrates the additional accounting boundary, but is not a successful performance sample:

- Request payloads: **6,441 → 8,863 bytes**.
- Second request: **590 retained-history bytes + 2,419 new-history bytes**. The new items comprise assistant calls (265), tool-result protocol (212) and reasoning item (1,942).
- Returned tool content was only **154 bytes**; generated tool arguments were 101 bytes. These are different quantities from cumulative outgoing context.
- First request: 1,162 input / 124 output tokens, including 78 reported reasoning tokens. Reasoning is an output **subset**, never added again. Missing/zero reasoning breakdown does not prove an absence of hidden thinking.
- Session wall time: **24,454 ms = 24,441 model-stage + 8 tool-union + 5 orchestration ms**. Model-stage time includes the failed second request; setup and independent post-session grading are excluded. This single incomplete session cannot establish a latency difference.

## 4. Stop and accounting

The second development request (global request 9) passed outgoing payload/model/max checks but returned no usable usage. The underlying provider/transport failure type is **unknown** from the content-free evidence; no causal claim is made about it.

The predeclared breaker stopped all real execution. There were no retries, ledger resets or later provider calls.

| Accounting | Value |
| --- | ---: |
| Requests dispatched | 9 |
| Settled requests | 8 |
| Unknown-usage requests | 1 |
| Known input / output / cache tokens | 7,825 / 186 / 0 |
| Known total tokens | **8,011** |
| Known catalog-priced cost | **$0.0017882** |
| Pending conservative reservation | **400,000 tokens / $0.3664** |
| Known usage + pending reservation | 408,011 tokens / $0.3681882 |

These costs use the catalog, not a billing statement. Actual usage/cost for request 9 remains unknown. Codex does not forward the `maxTokens` option; reservations therefore use the model's full catalog input/output capacity, not a fictitious enforced output cap.

Completed: 7 protocol probes. Incomplete: 1 development session. Not run: the other 3 A/B development sessions, candidate provider probes/development, and **all 18 independent validation sessions**.

## 5. Offline remediation and its limit

Only three product files changed:

1. `packages/agent/src/harness/tools/search-v2.ts`: encode multi-valued capability-specific string domains as `enum` rather than repeating `{const,type}` objects in `anyOf`. Values, required fields, aliases, capability filtering and runtime checks are unchanged. Empty and singleton domains keep their previous representation.
2. `packages/coding-agent/src/core/tools/tool-profile.ts`: shorten repeated guidance while retaining bounded discovery, coverage caveats, view/hash/range binding, single apply, approval, prepare/commit, independent verification and safe partial-commit recovery. Read supplied paths directly; semantic verification guidance remains when a provider is configured.
3. `packages/coding-agent/src/core/system-prompt.ts`: do not also advise Bash discovery when Search exists. Native-only guidance is unchanged.

No Read/Edit/Bash schema or implementation, execution backend, permissions, dependencies or default profile changed.

| Fixed serialized values | B bytes | Final offline C bytes | Saved |
| --- | ---: | ---: | ---: |
| Tools | 9,243 | 8,653 | 590 |
| System | 4,352 | 3,795 | 557 |
| Combined | 13,595 | 12,448 | **1,147 (8.4%)** |

Search parameters alone: **3,123 → 2,533 bytes (−18.9%)**. Other tool schemas/descriptions match B exactly. The first offline artifact saved 1,158 bytes; final review corrected wording that incorrectly grouped `targetKind` with aliases, adding 11 bytes. Both artifacts are retained; final iteration is 2. No validation outcomes were used for either edit.

This is a verified **serialized-protocol reduction**, not a measured C provider-token reduction, task speedup or task success gain. Fixed C bytes still exceed A. No candidate provider call was made after the breaker.

## 6. Verification and three-dimensional verdict

- **148 unique local tests passed**: Agent 77; coding-agent 71. The new real test remains skipped by default.
- Search schema regressions compare accepted/rejected domains and argument normalization with the previous union representation across seven capability sets, including strict-sampling nullable selectors.
- Production regressions cover structured/semantic capabilities, native default, Memory/SSH adapters, views, ranges, stale evidence, approval/denial, prepare/commit, mutations, coverage and errors.
- Baseline post-change recheck: 13 tests passed; original product/catalog/runner hashes unchanged.
- Root `npm run check` passed; diff checks and independent offline artifact/ledger reconciliation passed. Task-document validation is recorded in the authority.
- No build, full suite, install, embedding, historical real replay or C provider test was run.

| Agreed gate | Verdict |
| --- | --- |
| Accuracy or safety strictly better than A; other not worse; no regression vs B | **Not proven** |
| Task total tokens and catalog cost below A, including failures | **Not proven** |
| Paired task latency 95% log-ratio interval upper bound < 0 | **Not proven; no pairs** |
| Overall three-dimensional superiority | **Partial, not achieved** |

A later real investigation requires new explicit authorization and a new independent run; it must not clear this ledger or reuse the frozen validation set for tuning. This run's evaluator, fixtures and real records are frozen history.
