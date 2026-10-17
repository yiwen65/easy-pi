# 实施与验证回执快照

实现方回执，部分可能是未完成的中间回执；最终接受状态见任务计划与 root 复查。

T-160 current-source documentation sync completed; ready for coordinator review, not overall remediation acceptance. Base HEAD verified: f7606c3df763e4dcbc75261211346e67124ee628. Read AGENTS.md, all edited docs completely, coding-agent README, initial reports/available validation receipts, and relevant source functions.

Changed paths (only assigned ownership):
- packages/permissions/README.md
- tools/agent-desktop-mcp/README.md
- packages/codemode/README.md
- packages/pi-web-search/README.md
- packages/coding-agent/docs/{mcp,codemode,extensions,tui,compaction,session-format,collaboration,sdk}.md
- packages/coding-agent/src/extensions/codemode/tool.ts (description only, one added line)

Contracts corrected:
- Permissions README:9 and SDK:612: invocation cwd changes target resolution, not protected session/inherited roots; no sandbox guarantee.
- Desktop README:60, MCP:127–130 and codemode:97: queued cancellation prevents CLI launch; active interruption remains uncertain; literal _meta['io.easy-pi/execution-outcome']='unknown' overrides ordinary confirmed MCP isError handling, even with isError=false. Metadata cannot assert certainty and is stripped before script results.
- Codemode package README:62,76; product docs:136–141; tool.ts:125: 1024 combined tool/injected-global host calls, including with unlimited deadline; bounded serialized writes include keys/deletions/escaping/framing, without undoing external effects. IMPORTANT: actual source limit is 1048576 JavaScript string characters, not 1 MiB of UTF-8; docs state this accurately.
- Web README:21–22,133: weak owner references and idle expiry timers; manager object + logical session ID + capture-anchor visibility; append and return to an anchor-visible path remain valid until TTL; unanchored/changed capture ownership publishes no handle.
- Extensions:221,459–478: factory-owned registration/subscription cleanup only, no arbitrary-effect rollback; compaction preparation may be undefined, branchEntries remains available. Also corrected the existing missing-file mutation-queue description to match nearest-existing-ancestor canonicalization.
- TUI:33–37: scoped standard assistant/Bash/tool-text ingress sanitization and title control removal; no blanket renderer or extension-sandbox claim.
- Collaboration:96,305 and SDK:175–179: host-controlled child binding/provider admission; successful delivery suppresses internal continuations without resolving unknown sibling effects; exclusive validated import; forked recovery records are historical only.
- Session format:230–251,277,329–341,406–429: replacementHistory replaces stale retainedTail documentation; distinguishes effective provider context from transcript/entry projection; modern checkpoint API, optional full Usage fields, and sourceSessionId recovery provenance. Compaction docs:48,83 agree.

Verification performed:
- packages/coding-agent: PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/codemode-extension.test.ts — 27/27 passed (task-1, 2.00s). Log: /Users/w/.epi/agent/teams/a3b1f38f-3857-4750-9fc0-5d00d483c1cb/46ff8a9f-c435-4d51-ae42-866e9f241424/01a14b70-ce41-78ec-94e3-8b304d42bd8d.logs/bash-97d20c21-9933-4933-a49b-90f0ca54ff96.log
- Scoped Biome check of tool.ts passed, no fixes.
- Scoped git diff --check passed; complete owned diff reviewed.
- Temporary local documentation checker: 89 relative link targets exist, 2 added relative links/anchors valid, modern/legacy CompactionEntry JSON examples parse, no retainedTail contract remains. Removed the checker after use. External URLs were not fetched.

Pending followup recommendations, deliberately not asserted as implemented:
1. Once failed/aborted/rejected compaction usage accounting finishes, document its actual durable usage record and consumer deduplication/totals behavior. Current docs describe optional full usage on successful checkpoints only; last inspected getSessionStats still counted compaction/branch-summary entry.usage and message usage, not diagnostic entries.
2. Once Grok summary ingress followup lands and is verified, extend the narrowly scoped TUI text to the specific thinking/tool-summary paths; do not claim every renderer is safe.
3. Once failed-factory API revocation lands, document rejection of later calls through a retained failed factory API. Current wording promises only staged registration/subscription cleanup, not revocation or rollback of arbitrary JavaScript effects.
4. Physical symlink-cwd followup may merit a short note after final source verification; current docs avoid asserting a particular symlink normalization algorithm.

No root check/build/typecheck, real provider/browser/GUI calls, dependencies, commit, authority/task/report edits, or unassigned source/test changes. Active workers may still alter contracts; final integration review remains coordinator-owned.
