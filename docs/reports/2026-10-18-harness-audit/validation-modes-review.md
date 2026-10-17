# 实施与验证回执快照

历史回执；最终接受状态见任务计划与 root 复查。

T-044 / T-051 followups independently reproduced and fixed. Recommended status: fixed, awaiting root review/acceptance and serialized system/type checks. Base HEAD: f7606c3df763e4dcbc75261211346e67124ee628. Preserved inherited changes; no commits, project docs/reports, dependency/lockfile changes, real APIs, credentials, or remote effects.

Only four project files changed:
- packages/coding-agent/src/modes/rpc/rpc-mode.ts:328–333: rechecks deferred shutdown on compaction_end as well as agent_settled. Existing binding/active-command/pending-prompt/isIdle/isCompacting guards are unchanged. Actual AgentSession manual success and failure paths clear the controller before compaction_end (agent-session.ts:3524,3544).
- packages/coding-agent/src/modes/interactive/interactive-mode.ts:590,5183–5190,5833–5854: selector replacement/reset advances a generation; the enclosing tree workflow checks its dialog generation after both awaits. Explicit user completion/Escape does not advance it. Supersession/reset therefore abandons the continuation instead of reopening tree/summary UI, including when the replacement already closed or the old answer was already queued.
- packages/coding-agent/test/rpc-mode-lifecycle.test.ts:321–439: eight real AgentSession/extension-command cases (success/failure × no blocker/prompt handler/prompt backpressure/command backpressure), stdin left open with no later commands. Also fixed root-reported inherited signal typing using installed NodeJS.SignalsListener and proper SIGINT/SIGTERM callback arguments at lines 88,309,576.
- packages/coding-agent/test/interactive-extension-ui.test.ts:313–434: seventeen enclosing showTreeSelector cases using real tree/dialog/editor components and virtual terminal. Covers pending dialogs, Escape/submit queued before replacement/reset, replacement finishing before old continuation, real Escape back-navigation, and committed no-summary streaming-abort/navigation. Navigation/abort business operations are mocked.

Evidence and validation:
- RED before production edits: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/rpc-mode-lifecycle.test.ts test/interactive-extension-ui.test.ts -t 'standalone compaction|tree workflow dialog ownership'` from packages/coding-agent: exit 1, 16 expected failures / 9 passed / 51 skipped. Two RPC cases completed compaction but disposal remained 0; fourteen tree cases reopened UI or aborted streaming after supersession/reset. No fixture/import failures.
- GREEN focused complete files: 76/76.
- FINAL: 34 named files, 312 tests passed; includes all prior RPC/UI validation neighbors plus tree, retry and compaction neighbors. Scoped Biome checked four files with no fixes; scoped git diff --check passed. Exact commands/file list: /tmp/pi-fix-modes-review/commands.txt; output: green-final.log.
- Repeated all 25 new controlled-schedule cases five times: 125/125, no sleeps introduced (explicit promise gates, microtask/event-loop barriers). Output: repeated.log.
- Actual counts: RPC disposal changed 0 (red no-blocker success/failure) to 1; green asserts one exit and one flush, compaction inactive at disposal, stdin reader count 1 before release → 0 after shutdown while stdin remains open. No throughput/byte claims.
- Reviewed incremental source and test diffs. Complete source/doc reads performed before edits.

Final SHA256:
- rpc-mode.ts: b231729d6200f50f0fb9f7ab1e6b2390e15ba5497745d533693b0c2b38063dcb
- interactive-mode.ts: 044926a46e9a90d0e16b0749458030bdce73dde2e00022f89f597f15e738f67b
- rpc-mode-lifecycle.test.ts: 3a93831ec2a0659e2142c3d85f60c27554a3ad486b25e72dd578afaeb3f11456
- interactive-extension-ui.test.ts: cd8b254f6b1d97c71d4876bca47aba2c6caed50ab0142dd90d0f040015969835

Limits: no root npm check/build/typecheck by this child; parent owns those. No live-terminal or real signal/process-exit validation (virtual terminal, mocked process.exit). RPC uses actual session/extension flow with injected offline compaction completion. No remaining reproduced assigned failure.
