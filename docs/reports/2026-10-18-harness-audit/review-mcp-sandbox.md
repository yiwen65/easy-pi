# 独立复查证据快照

修复后静态复查；最终状态见任务计划。

Two actionable regressions in the supplied stable diff. Review only; no changes or execution.

### Preserve final stdout messages before signalling stdio closure
- Severity: Medium
- Axis: Correctness
- Location: `packages/mcp/src/transports/stdio.ts:124-125,194-216` (`exit` callback and `closeChild`).
- Problem: The new leader `exit` callback immediately calls `close()`. When the leader has exited and its group is absent, `closeChild()` returns and its `finally` emits transport close without waiting for the child's stdio `close` event. A process can exit while its final response is still buffered in stdout. This legal exit→stdout-data→close ordering now becomes transport-close→message. The previous implementation emitted closure from the child's `close` event after draining stdio.
- Impact: `McpClient.handleTransportClose()` rejects pending requests before their valid final response arrives; `handleResponse()` then treats the response as an unknown request (or its listener has already been removed). A completed tool effect can therefore be reported as a connection failure instead of its actual result. Normal unexpected server termination is affected, not just explicit caller shutdown.
- Recommended fix: Keep group termination/escalation independent of leader/pipe exit, but do not equate group disappearance with drained transport I/O. Await/observe stdio closure before publishing normal transport closure and completing cleanup; retain bounded failure handling. Deterministic regression: mock cross-spawn with an EventEmitter child and PassThrough stdout; start transport, set exitCode=0, make the owned group's signal-0 probe throw ESRCH, emit `exit`, then write a valid JSON-RPC response plus newline to stdout, then emit `close`. Assert onMessage precedes onClose. With a pending connected client, assert that response resolves the request rather than rejecting it. This event-order test was not run.
- Certainty: High confidence — the new synchronous exit→closeChild→finally path is explicit in source; client rejection/correlation behavior was inspected in `packages/mcp/src/client.ts` (`handleResponse`, `handleTransportClose`, `markClosed`). Existing `stdio-cleanup.test.ts` tests group survival and shared cleanup but not trailing stdout.

### Preserve known HTTP status when the diagnostic body fails
- Severity: Medium
- Axis: Correctness
- Location: `packages/mcp/src/transports/streamable-http.ts:378-383`.
- Problem: `checkResponse()` now awaits `readBody()` without the old non-cancellation body-read fallback. If HTTP error headers arrive but their body fails mid-stream (e.g. fetch's `TypeError: terminated`), that error escapes before constructing McpSessionExpiredError/McpAuthRequiredError/McpHttpError. This loses a status already known from the response; it is not an unknown HTTP outcome.
- Impact: In particular, a 404 on an established session no longer reaches the expiry-reconnect branch at `packages/coding-agent/src/extensions/mcp/runtime.ts:327-334`. A 503 body failure also bypasses that consumer's McpHttpError-only read-only retry at lines 323-326. Conversely, GET/resumption treats a broken 401/404 body as retryable TypeError instead of the known nonretryable status (`streamable-http.ts`, `isRetryable`).
- Recommended fix: Preserve cancellation propagation, but tolerate non-cancellation failures while reading an error body's bounded diagnostic prefix and still classify by response.status (empty diagnostic text is sufficient, as before). Regression: establish a session using a normal JSON response with `mcp-session-id`, then return `new Response(new ReadableStream({start(c){c.error(new TypeError("terminated"));}}), {status:404})` from injected fetch. Assert send/request rejects with McpSessionExpiredError, not TypeError. Add analogous 401/503 cases and a stalled-body caller-abort neighbor that must still reject as abort. These tests were not run.
- Certainty: High confidence — direct source and stable-diff comparison establish removal of `.text().catch(() => "")`; downstream status-dependent behavior was inspected. The new bounds tests cover oversized and UTF-8 bodies, not errored diagnostic streams.

Inspected scope:
- Complete supplied `/tmp/pi-harness-mcp-sandbox-review.diff` (source snapshot; no independent Git HEAD/hash verification).
- Full MCP client, stdio/HTTP/transport/in-memory modules, OAuth flow, existing client/stdio/HTTP/OAuth tests, new cancellation/bounds/group-cleanup tests and leader-exits fixture. Checked cancellation isolation, authentication waits/retry, stream readers/backoff, cleanup memoization, process-group ownership and token redirect handling.
- Full codemode execution/prelude, VM/protocol and worker/inline/remote launchers; execution/resource-budget/portable tests; full product executeCodemode and codemode-extension tests. Checked exact mutation accounting, escaped keys/tombstones/replacements, refused-write ordering, admission cap, pending cancellation and product drain/unknown-effect certainty.
- Full web index/snapshot store, snapshot-store/tool-contract tests and session-host fixture. Followed actual ExtensionRunner context ownership and relevant SessionManager identity/path/new-session/branch/fork functions. Checked anchor inclusion rather than leaf equality, completion recheck, weak owner references, LRU/drop and idle expiry timers.
- No additional actionable issues found in the codemode, web snapshot, or OAuth changes inspected.

Validation gaps and residual risks:
- Static-only as assigned: no tests, commands, network, native processes, browser, edits, or build/type checks were performed. Reproduction recipes above are proposed checks, not passed/failed executions.
- Implementation validation reports were read as untrusted claims, not accepted as proof. Supplied source diff was the review target; surrounding live consumer modules were inspected only to establish impact.
- Native OS event ordering/process-group behavior, Linux/Windows/Bun/Cloudflare execution, GC timing, built-loader integration and overall task acceptance remain unverified here. This is not overall completion approval.
