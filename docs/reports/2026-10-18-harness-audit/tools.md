# 工具边界初审证据（实施前，只读）

这是 2026-10-18 初审快照，不是最终整改状态。最终验收见主报告与唯一任务计划。

T-004 — read-only audit handoff; remediation and overall acceptance remain open.
Root: /Users/w/Projects/easy-pi/pi. Supplied baseline f7606c3df / my-pi was not independently git-verified. No edits, executable tests, network calls, or desktop operations. Findings are static traces, not reproductions. Locations use narrow symbols.

## Actionable findings

### F01: Use Bash's effective cwd for deletion assessment
- Severity: High
- Axis: Correctness
- Location: `packages/permissions/src/permissions.ts:decidePermission`; `packages/coding-agent/src/extensions/easy-pi.ts` permission hook.
- Problem: Assessment ignores input.cwd, unlike execution. With session cwd `/tmp/parent/repo`, `{command:"rm -rf repo",cwd:"/tmp/parent"}` is assessed against `/tmp/parent/repo/repo` but executes against protected `/tmp/parent/repo`. Conversely, `rm -rf .` in an unrelated scratch cwd is falsely blocked. Root cause: different target-resolution bases.
- Impact: Supported arguments bypass the catastrophic-deletion breaker or block safe cleanup; not a claim of shell sandboxing.
- Recommended fix: Resolve invocation cwd consistently, retaining original session cwd/inherited roots as protected roots. Test absolute/relative cwd synthetically and with injected Bash operations, never actual deletion.
- Certainty: High confidence — permission modules and both Bash adapters fully inspected; existing tests cover shell cd, not this argument.

### F02: Cancel request-owned MCP HTTP work
- Severity: High
- Axis: Correctness
- Location: `packages/mcp/src/client.ts:requestInternal/cancelPending`; `src/transports/streamable-http.ts:authorizedFetch/consumeResponseStream`; `transports/transport.ts:McpTransport.send`.
- Problem: Abort/timeout removes the pending entry and sends a cancellation notification, but original send has no request signal. Fetches use only the transport controller. A POST awaiting auth can start after cancellation; stalled streams/resumptions continue afterward. Root cause: cancellation does not own transport work.
- Impact: Late external dispatch and abandoned network work until session close.
- Recommended fix: Add per-request cancellation; check after auth waits and before POST/retry; stop its body/resumption loop without closing unrelated calls. Dispatched effects remain unknown.
- Certainty: High confidence — complete client/transport/adapter inspected; gated-auth and cancelled-stream cases are absent from inspected HTTP tests.

### F03: Reject OAuth token redirects
- Severity: High
- Axis: Security
- Location: `packages/mcp/src/oauth/flow.ts:secureEndpoint/tokenRequest`.
- Problem: Only initial URL is validated; fetch follows redirects. A 307/308 can forward refresh_token or code+code_verifier, possibly client_secret, across origins or HTTPS→HTTP. Root cause: validation does not cover redirected credential delivery.
- Impact: Misconfigured/open/compromised redirects can disclose credentials outside the validated endpoint; intentional credential access does not authorize arbitrary forwarding.
- Recommended fix: Set redirect:error or implement a strictly constrained policy. Test 307/308 refusal, no credential delivery, no token save.
- Certainty: High confidence — missing policy and fetch semantics establish the path; no disclosure reproduction. Existing tests cover initial URL/issuer checks only.

### F04: Cancel queued desktop actions before CLI startup
- Severity: High
- Axis: Correctness
- Location: `tools/agent-desktop-mcp/server.mjs:createServer/run` and registerTool callbacks.
- Problem: Callbacks discard SDK extra.signal; queue always executes and execFile receives no signal. Hold A, queue click/type B, cancel B, release A: B still starts. Root cause: queue admission/active execution lack cancellation wiring.
- Impact: Desktop mutations after cancellation, potentially against changed UI; queue delay is outside CLI timeout.
- Recommended fix: Thread signal through queue/execFile and recheck at slot acquisition. Suppress unstarted work; preserve unknown effects after interruption.
- Certainty: High confidence — full server/tests and installed SDK handler-dispatch excerpt inspected; cancellation not covered by existing serialization test.

### F05: Preserve desktop unknown effects through MCP
- Severity: High
- Axis: Correctness
- Location: desktop `server.mjs:run` catch; `packages/coding-agent/src/extensions/mcp/tools.ts:convertMcpResult`; `extensions/codemode/execute.ts:toScriptValue`.
- Problem: Killed/timed-out/malformed CLI execution returns isError with uncertainty only in prose. Adapter labels it confirmed; codemode resolves its structured CallToolResult and can commit store writes. Root cause: certainty is lost at the protocol boundary.
- Impact: Unknown-effect reconciliation/no-repeat protection does not engage.
- Recommended fix: Define an adapter-understood unknown marker that only reduces certainty, or a low-level MCP error path. Ordinary high-level McpServer throws are caught into isError by the installed SDK. Keep genuine native error envelopes confirmed.
- Certainty: High confidence — desktop tests expect timeout isError; codemode tests establish confirmed-error resolution versus unknown-result store rejection. End-to-end test not run.

### F06: Clean stdio descendants after leader exit
- Severity: Medium
- Axis: Correctness
- Location: `packages/mcp/src/transports/stdio.ts:start/close/killProcessTree`.
- Problem: Leader exit removes its group from exit cleanup; close returns early for exited leader. Another path clears escalation timers on child close, sends one SIGTERM, then resolves even if a same-group descendant ignores TERM. Root cause: leader/stdio completion substitutes for group completion.
- Impact: Server descendants survive shutdown/child retirement while cleanup appears complete.
- Recommended fix: Track group lifetime independently; retain bounded TERM→KILL escalation and shared cleanup promise until group exit. Avoid signalling reused/unowned identities.
- Certainty: High confidence — full transport/tests inspected; existing stubborn-server test lacks leader-first exit.

### F07: Enforce HTTP MCP bounds during consumption
- Severity: Medium
- Axis: Performance
- Location: `packages/mcp/src/transports/streamable-http.ts:send/checkResponse/consumeSseStream`.
- Problem: maxMessageBytes only bounds SSE; JSON uses unbounded response.json(), errors read text fully before an 8-KiB slice. SSE overflow releases its reader without cancelling unread body. Root cause: bounds apply too late or only to one framing path.
- Impact: Large/continuous responses exceed configured memory bounds or retain unwanted bodies; output truncation cannot prevent this.
- Recommended fix: Incremental byte-limited JSON/error reads; cancel overflow/failed readers, then release locks.
- Certainty: High confidence — static path; no memory benchmark/OOM claimed.

### F08: Bind snapshots to logical session/branch identity
- Severity: Medium
- Axis: Correctness
- Location: `packages/pi-web-search/src/index.ts:capturePage/readStoredPage`; `snapshot-store.ts` owner binding; supporting `packages/coding-agent/src/core/session-manager.ts:branch/newSession/setSessionFile/createBranchedSession`.
- Problem: Owner is only ctx.sessionManager. Manager changes branches and supports session replacement in place; no branch/session identity or invalidation is checked. The old ID still reads its capture. Root cause: mutable object identity substitutes for logical ownership.
- Impact: Violates README's other-branch isolation claim; SDK manager reuse can cross logical sessions. Distinct manager objects remain isolated.
- Recommended fix: Host-owned session/branch tokens or capture-anchor membership; invalidate on transitions and reject capture completion into changed ownership.
- Certainty: High confidence — complete involved modules inspected; current snapshot tests use distinct owner objects only.

### F09: Release idle expired snapshot owners
- Severity: Medium
- Axis: Performance
- Location: `packages/pi-web-search/src/snapshot-store.ts:SnapshotPool.entries/sweep`, SnapshotStore.owner, defaultPool.
- Problem: Expiry only sweeps on later get/put. Global pool retains entry→store→owner→SessionManager/history indefinitely during inactivity. Root cause: lazy expiry plus strong back-reference defeats WeakMap owner collection.
- Impact: Bounded snapshot payloads retain potentially much larger histories; source's TTL retention claim is false. Expired reads still correctly fail.
- Recommended fix: Remove strong owner back-reference and add independent expiry/disposal (unref timer/lifecycle cleanup), preserving accounting.
- Certainty: High confidence — reference graph inspected; no heap measurement claimed.

### F10: Bound codemode deletion payloads
- Severity: Medium
- Axis: Performance
- Location: `packages/codemode/src/runtime/prelude-source.ts:store/serializeWrites/done`; `execution.ts:parseStoreWrites`.
- Problem: store(key,undefined) records a deletion before budget checks. A key exceeding MAX_STORE_TOTAL_CHARS passes; unique deletions/set-delete cycles grow writes while storedChars remains small. Terminal bound excludes writes; host persists them. Root cause: live-value budget omits mutation payload.
- Impact: Scripts bypass small-state/output limits via tombstones, increasing host memory/session-log size.
- Recommended fix: Bound keys and mutation serialization or compact no-op changes; enforce host-side bounds. Test giant keys, many deletions and churn; failed runs must not commit.
- Certainty: High confidence — full paths/tests inspected; existing tests cover live values, not tombstones.

### F11: Bound codemode host call history
- Severity: Medium
- Axis: Performance
- Location: `packages/codemode/src/runtime/execution.ts:Execution.calls/handleCall`; coding-agent `extensions/codemode/execute.ts` sandbox options/MAX_DISPLAY_CALLS.
- Problem: Every tool call retains a host record without count/in-flight bounds. A loop awaiting a cheap injected tool grows host history with little live VM memory. Product timeout defaults to Infinity; 256 display records do not cap the underlying array. Root cause: VM/output budgets omit host bookkeeping.
- Impact: Accidental long/unbounded loops grow host memory; not an authority escape.
- Recommended fix: Host-owned call/in-flight budget or bounded history option enabled by product; preserve separate durable effect accounting. Use deterministic quota tests, not OOM tests.
- Certainty: High confidence for standalone sandbox/library array; practical product-wide limits/throughput remain unverified.

## Coverage and limitations
Read AGENTS.md, all five assigned package/tool READMEs, coding-agent README and docs/{mcp,codemode,security}.md fully.
Complete source modules read (under each package src, .ts omitted):
- permissions: permissions, external-mutation-journal, journal-types.
- mcp: client; transports/{transport,stdio,streamable-http}; oauth/{discovery,flow,provider,callback}.
- codemode: index, types, cloudflare; runtime/{host,execution,vm,worker,prelude-source,protocol,inline,remote}.
- coding-agent: extensions/codemode/{index,tool,execute}, tool-search/{index,tool}, mcp/{index,authority,config,runtime,tools,resources,oauth}, extensions/{easy-pi,pi-child-session-host}; core/{extensions/runner,mcp-servers,session-manager,tools/bash}. Also agent/src/harness/tools/bash.
- pi-web-search: index, network, browser, snapshot-store, frame-scan. Desktop server.mjs.
Tests read: permissions decisions; MCP HTTP/stdio/OAuth; codemode execution/sandbox/portable; coding-agent codemode-extension and suite agent-session-codemode-mcp/codemode-child/mcp-child; web snapshot-store; desktop server.test.mjs. Assertions indicate intended coverage, NOT passing results. SDK tool dispatch excerpt only.
Chains: permission→Bash cwd; config/registration→eligibility→discovery/exposure→remote call; native grants→live callable context→nested gateway/drain/store; cancellation→HTTP/auth/SSE; desktop queue→error→certainty; proxy/DNS→browser cleanup→snapshot ownership/expiry.
Boundary-focused, not per-file exhaustive. Not fully audited: page-scan/content-format, declarations, MCP CLI/TUI/logging, every protocol validator/test, native desktop implementation. Core AgentSession recovery/gateway is another audit scope; inspected runner/relevant tests rather than its entire module.

## Exclusions/opportunities/unverified hypotheses
- Full Access credential reads, host execution and arbitrary trusted extensions are intended, not sandbox defects. No current native-product journal bug established.
- Deferred exposure is presentation, not a grant. Inspected tests address concrete native-child targets, resource exclusion, root/ancestry revocation, independent transports and approved config snapshots; no additional widening established.
- Web HTTP/CONNECT checks pin approved DNS. Documented fake-IP routing exception has explicit strict-mode opt-out; not an undisclosed bypass.
- Codemode alias collision first-wins is intentional/tested; changing it requires a separate decision.
- Resource-tool comments promise script JSON payloads but definitions lack outputSchema/structuredContent: documentation/typed-output opportunity, not established safety bug.
- Delayed VM-launch cancellation and malformed external protocol handling remain hypotheses.
- Real browser, Windows cleanup, Cloudflare, live OAuth/network and desktop validation NOT RUN. No performance measurements claimed.

## Proposed ownership and exact regression targets — NOT RUN
Own boundary source files cited above, coordinating shared-core changes. Proposed test edits/additions:
1. `packages/permissions/test/permissions.test.ts`; new `packages/coding-agent/test/suite/regressions/harness-audit-bash-cwd-breaker.test.ts`: absolute/relative cwd, protected workspace, safe scratch, injected execution only.
2/7. `packages/mcp/test/streamable-http.test.ts`: gated-auth abort; stalled JSON/SSE abort/timeout; no late POST/resumption; unrelated calls survive; streaming size limits cancel readers. Source ownership includes client.ts and transports/{transport,streamable-http}.ts.
3. `packages/mcp/test/oauth.test.ts`: 307/308 refusal/no forwarded secrets/token save; direct flow preserved. Own oauth/flow.ts.
4/5. `tools/agent-desktop-mcp/server.test.mjs`; new `packages/coding-agent/test/suite/regressions/harness-audit-desktop-unknown-outcome.test.ts`: cancelled queue never executes, active signal, timeout reconciliation/no commit/no repeat, genuine error confirmed. Own desktop server.mjs and coding-agent extensions/mcp/tools.ts.
6. `packages/mcp/test/stdio.test.ts`; new `test/fixtures/leader-exits-server.mjs`: leader exits first, same-group descendant holds/closes stdio and ignores TERM; no effect on another server. Own transports/stdio.ts.
8/9. `packages/pi-web-search/test/{snapshot-store,tool-contract}.test.mjs`: actual manager branch/newSession, capture race, idle TTL accounting/owner release. Own src/{index,snapshot-store}.ts. Run package `node test/run.mjs`, not isolated files in a normal credential environment.
10/11. `packages/codemode/test/{sandbox,execution}.test.ts`: deletion/call budgets, no store commit, cancellation cleanup with fake tools. Own runtime/{prelude-source,execution}.ts; types.ts/product codemode execute.ts only if enabling a host option.
Follow-up should reproduce accepted findings, implement surgical fixes, run targeted tests and required repository checks, then reassess severity and acceptance.
