# 实施与验证回执快照

这是实现 worker 的证据回执，不是最终接受声明。最终状态由唯一任务计划及 root 复查记录决定。

Implemented T-020/F01, T-023/F04, T-024/F05. Recommended status: implementation complete, pending coordinator review/root checks (not acceptance). Base verified: f7606c3df763e4dcbc75261211346e67124ee628.

Results
- F01: permission assessment now resolves Bash input.cwd consistently with NodeExecutionEnv (absolute/relative, home and file URLs), while session/inherited protected roots remain fixed. Nested shells retain those roots. Production: packages/permissions/src/permissions.ts:565,658,764. Red: unit allowed protected deletion with cwd='..'; both absolute/relative faux-provider integration cases dispatched the synthetic command. Green: protected calls blocked; scratch cleanup allowed. No shell/deletion executed.
- F04: desktop SDK signal reaches queue admission, slot acquisition and execFile. Cancelled queued click/type/batch never start; queue remains usable after active cancellation. Production: tools/agent-desktop-mcp/server.mjs:70-86,114-121. Red: 3 starts instead of expected 2 and missing signal; green: 2 starts and aborted signal observed.
- F05: uncertain CLI errors emit _meta['io.easy-pi/execution-outcome']='unknown'. Adapter recognizes only literal unknown, never metadata claiming confirmed/not_started, strips protocol metadata, and raises unknown AgentToolError even with isError=false. Genuine native CLI error envelopes remain confirmed structured results. Production: desktop server:84-93; packages/coding-agent/src/extensions/mcp/tools.ts:176-219. Red: unknown metadata resolved or became confirmed; stubbed timeout completed instead of needs_reconciliation. Green: recovery pauses, store writes discarded, direct/nested repeats blocked, STALE_REF remains confirmed. No codemode source edits.

Changed files (complete list)
1. packages/permissions/src/permissions.ts
2. packages/permissions/test/permissions.test.ts
3. packages/coding-agent/src/extensions/mcp/tools.ts
4. packages/coding-agent/test/mcp-adapter-tools.test.ts
5. packages/coding-agent/test/suite/regressions/bash-cwd-breaker.test.ts (new)
6. packages/coding-agent/test/suite/regressions/desktop-unknown-outcome.test.ts (new)
7. tools/agent-desktop-mcp/server.mjs
8. tools/agent-desktop-mcp/server.test.mjs

Verification
- From packages/permissions: PI_OFFLINE=1 node --test test/permissions.test.ts — 14/14 pass (task-10; /tmp/fix-tool-boundaries-final-permissions.log).
- From tools/agent-desktop-mcp: node --test server.test.mjs — 10/10 pass (task-7; /tmp/fix-tool-boundaries-F04-F05-desktop-green.log).
- From packages/coding-agent: PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/suite/regressions/bash-cwd-breaker.test.ts test/easy-pi-harness.test.ts test/bash-tool-contract.test.ts test/mcp-adapter-tools.test.ts test/suite/regressions/desktop-unknown-outcome.test.ts test/suite/agent-session-codemode-mcp.test.ts — 53/53 pass (task-9; /tmp/fix-tool-boundaries-final-coding-agent.log).
- Scoped Biome on all six changed TS files passed; scoped git diff --check passed.
- Red logs: /tmp/fix-tool-boundaries-F01-unit-red.log (task-1); /tmp/fix-tool-boundaries-F01-integration-red.log (task-2); /tmp/fix-tool-boundaries-F04-F05-desktop-red.log (task-5); /tmp/fix-tool-boundaries-F05-adapter-red.log (task-6).
- Initially also verified real local stdio MCP + QuickJS with a stubbed CLI (green task-8, /tmp/fix-tool-boundaries-F05-adapter-green.log). Durable integration was then converted to existing in-memory MCP fixtures because desktop SDK is standalone, not a root dependency; temporary fixture removed. Desktop emitter and product consumer remain independently covered without a new install requirement.

Coordinator documentation recommendations (none edited)
- packages/permissions/README.md: cwd changes deletion target resolution, not protected session/inherited roots.
- tools/agent-desktop-mcp/README.md: cancelled queue slots do not launch; active cancellation forwards AbortSignal but does not prove effects stopped; timeout/interruption/malformed replies carry the explicit unknown marker.
- packages/coding-agent/docs/mcp.md Results and recovery, and docs/codemode.md Call tools: qualify the blanket isError-is-confirmed statement with the unknown-marker exception; metadata may only reduce certainty and is not exposed to scripts.

Limits: no real desktop effects, provider APIs or credentials; no root check/build/typecheck, commits, dependency/lockfile changes or task/report edits. Root owns serial full check. Deletion checks remain best-effort, not shell containment; active interruption remains uncertain rather than proof of stopped native effects.
