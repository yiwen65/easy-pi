# 实施与验证回执快照

实现方回执，不是最终接受声明；最终状态见任务计划。

Implemented T-027/T-028/T-029/T-030 (F08–F11), recommended ready for coordinator review and final integration gates, not accepted. Base/current HEAD: f7606c3df763e4dcbc75261211346e67124ee628. No commits, dependency changes, shared-core edits, documentation edits, root check/build, real network/browser/provider/desktop operations.

Results and causal fixes:
- T-027/F08: red regressions showed old captures remained readable after real SessionManager.branch(), and branch/newSession transitions during capture still published handles. Fixed packages/pi-web-search/src/index.ts:658–675,735–737,786–827 and src/snapshot-store.ts:407–451. Captures bind to manager object + logical session ID + capture entry anchor; reads require that anchor on the current path. Completion rechecks ownership before publishing. Ordinary append remains valid, including append during capture. Rewind/siblings excluding the anchor, createBranchedSession, newSession and setSessionFile with copied entry IDs are refused. Returning to the original path remains valid until TTL. This is capture-anchor visibility, not leaf equality or permanent invalidation on any navigation. Empty/malformed hosts have no provable anchor and receive content without a handle.
- T-028/F09: red idle test retained 1 entry/289 bytes after expiry without get/put. Forced-GC probe retained the synthetic session owner/history while keeping just 1 capture/273 bytes. Fixed snapshot-store.ts:386,409,461–474: WeakRef owner plus unref expiry timers, cleared on removal; no session-history back-reference. Green idle accounting is 0 entries/0 bytes. Same forced-GC probe now reports retainedOwner=false while snapshotCount=1/snapshotBytes=273; the capture itself remains bounded until TTL. Process exited normally with its unref timer still armed.
- T-029/F10: red worker tests committed 1,048,610 bytes for a giant deletion key, 1,054,664 for many deletions and set/delete churn, and 1,574,320 for escaped deletion keys. Product regression recorded 1 oversized session-store commit. Fixed codemode/src/runtime/prelude-source.ts:278–350: incremental exact serialized mutation accounting, including escaped keys, array framing, tombstones and overwritten entries, bounded to MAX_STORE_TOTAL_CHARS=1,048,576. Checks precede live-state mutation. Host execution.ts:112–129 rejects oversized bridge payloads before JSON decoding and oversized values before accepting writes. Green failing runs produce zero writes/commits; repeated same-key churn, exact boundary, caught-refusal state preservation and prototype-key neighbors pass.
- T-030/F11: practical red worker test with an 8-MiB VM and timeout Infinity dispatched/retained 2,048 cheap sequential calls; product did the same despite its 256-call display cap. Red in-flight test admitted 1,025 calls. Added fixed host-owned 1,024 total calls/execution cap at codemode/src/runtime/execution.ts:44–47,185,282–294, covering tools and globals. The 1,025th attempt fails the whole script as RangeError before dispatch, even if script catches errors. All admitted records remain; pending calls are signalled, not silently truncated. Green counts are sequential dispatched=retained=1,024 and concurrent dispatched=cancelled=retained=1,024. Exact 1,024-call success, fresh execution budgets and caught tool failures pass. Product quota-cancelled unknown-effect regression verifies drain waits for the real outcome, preserves unknown certainty and commits no state. No execute.ts change was necessary. The chosen fixed cap is 4× the existing display limit, preserves the existing 300-call case, and bounds both retained history and maximum pending count without a new configuration API or lost effect records; it is not a claim of optimal throughput or full host-memory isolation.

Validation (final source state):
- packages/pi-web-search: node test/run.mjs — 148/148 passed, isolated offline loader/browser mocks.
- packages/codemode: node ../../node_modules/vitest/dist/cli.js --run test/resource-budgets.test.ts test/execution.test.ts test/sandbox.test.ts test/terminal-output-budget.test.ts test/portable.test.ts — 181/181 passed. Existing sandbox neighbors cover worker/inline/in-process remote backends.
- packages/coding-agent: node ../../node_modules/vitest/dist/cli.js --run test/codemode-extension.test.ts — 27/27 passed.
- Scoped codemode tsc --noEmit -p packages/codemode/tsconfig.build.json passed; scoped web tsc (--ignoreConfig, ES2024, Node16, strict, noEmit) passed. Initial web tsc invocation needed TypeScript's --ignoreConfig when specifying files; corrected invocation passed.
- Biome check on all seven changed TypeScript files passed; git diff --check passed.
- node --check passed for changed native/live fixtures and new session-host.mjs. Their live browser suites were NOT run, per task restrictions; changes only replace owner stubs with the same real anchored session helper exercised offline.

Evidence logs:
/tmp/fix-sandbox-web-web-{red,green}.log (red: 4 expected failures/141 passes; final green:148)
/tmp/fix-sandbox-web-codemode-{red,green}.log (red:9 expected failures/3 passes; final green:181)
/tmp/fix-sandbox-web-product-{red,green}.log (red:2 expected failures plus dispatch/commit counts; final green:27)
/tmp/fix-sandbox-web-owner-gc-{red,green}.log (owner retention true→false; probe script removed after use)
/tmp/fix-sandbox-web-{biome,typecheck,web-typecheck}.log

Complete changed-file list:
packages/codemode/src/runtime/execution.ts
packages/codemode/src/runtime/prelude-source.ts
packages/codemode/test/execution.test.ts
packages/codemode/test/resource-budgets.test.ts (new)
packages/coding-agent/test/codemode-extension.test.ts
packages/pi-web-search/src/index.ts
packages/pi-web-search/src/snapshot-store.ts
packages/pi-web-search/test/snapshot-store.test.mjs
packages/pi-web-search/test/tool-contract.test.mjs
packages/pi-web-search/test/structure-contract.test.mjs
packages/pi-web-search/test/structure-child.mjs
packages/pi-web-search/test/live-snapshot-child.mjs
packages/pi-web-search/test/session-host.mjs (new)

Coordinator-owned required documentation updates (none edited by me):
1. packages/pi-web-search/README.md: replace object-only/blanket other-branch isolation claim with manager + logical session + capture-anchor visibility. Explain ordinary append/return to original path remains readable, unanchored hosts and ownership changes during capture publish no handle, and idle expiry uses unref timers with weak owner references.
2. packages/codemode/README.md Store: keys and the serialized mutation payload (including deletions, escaping and framing) are capped at 1,048,576 characters in addition to the existing per-value/live-store limits; caught refusals do not mutate state. Results/timeout sections: 1,024 combined tool/global attempts per execution, including with Infinity; exceeding cap terminates with script RangeError, preserves all admitted call records, abort-signals pending calls and discards writes. Globals still are not listed in result.calls.
3. packages/coding-agent/docs/codemode.md Store/Limits: same mutation bound; 1,024 total tools + discovery-global calls, independent of the 256-call display summary. Prior effects are not undone, no automatic replay; drain/unknown-outcome handling still governs final certainty.

Residual gates: root integration check/build and rebuilt-loader validation remain coordinator-owned. Web tests used the package's existing built loader/SessionManager fixture, source web extension, and mocks. No real Cloudflare, Bun, live browser or native desktop execution was attempted. A call-count cap is not a byte bound for trusted tool payloads and cancellation never proves external effects stopped.
