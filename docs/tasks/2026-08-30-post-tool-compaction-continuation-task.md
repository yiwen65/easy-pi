# Task Plan: 优化 post-tool compaction continuation

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求执行对 main 提交 56700d42 的借鉴建议

<!-- task-doc-section:background-goal -->
## Background and goal

当前 `my-pi` 已能在 provider request preflight 中压缩 post-tool 上下文，但 compaction 发生在 agent loop 已轮询 steering 之后，导致压缩期间加入的 steering 延迟一个 provider turn；同一 run 内压缩结束后 TUI working 状态也需要恢复。目标是在保留现有完整 provider-context 估算、durable replacement checkpoint 与 hard-limit fail-closed 行为的前提下，采用 main 提交 56700d42 的 next-turn 生命周期语义，补齐 continuation、queue、UI 与 manual-compaction 回归覆盖。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:
- 只在确认下一次 assistant/provider turn 存在时调用 `prepareNextTurn`。
- continuation turn 在 `prepareNextTurnWithContext` 中执行现有 HF provider preflight，并在其后重新轮询空的 steering queue。
- 保留首轮/最终 provider-boundary `transformContext` preflight。
- 覆盖 post-tool threshold、compaction 期间 steering、terminating tool、manual compact 持久化和 TUI 状态恢复。

Non-goals:
- 不替换现有 HF checkpoint/narrative/trigger 算法。
- 不改动 95% trigger policy、完整请求 token 估算或 overflow retry policy。
- 不重构无关 agent、TUI 或 toolchain 代码。
- 不触碰现有未跟踪 harness 文档。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 `prepareNextTurn` 在每个成功 turn 后立即执行，包括 final/terminating turn。 | `packages/agent/src/agent-loop.ts:226-261` |
| F-002 | 当前 HF threshold compaction 在 `transformContext` 内执行，而 steering 在此前已轮询。 | `packages/agent/src/agent-loop.ts:167-195`; `packages/coding-agent/src/core/agent-session.ts:618-669` |
| F-003 | 确定性临时探针复现：压缩期间加入的 steering 不在立即恢复请求中，而在第三次 provider 请求中出现。 | 2026-08-30 本会话执行的 `/tmp/check-post-tool-steering.ts`，输出 `resumedHasSteering:false`, `delayedRequestHasSteering:true`, `callCount:3` |
| F-004 | 当前完整请求触发估算包含 system、tools、messages 和 output reserve，并保留 provider usage floor。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts:182-230` |
| F-005 | interactive-mode 两个文件存在其他会话的未提交修改，已实现 compaction 后 working/progress 恢复；必须保留且不得据为本会话改动。 | `git status`; `git diff -- packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/test/interactive-mode-compaction.test.ts` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户的“执行建议的优化”授权实现前述 P0、P1、P2 范围；影响是会同步 `prepareNextTurn` 的公开生命周期语义并记录 breaking changelog。
- Assumption: continuation preflight 与保留的 transform preflight 可通过现有 same-checkpoint/active-message语义避免无变化时重复压缩；用集成测试验证。
- Open question: None. 现有证据足以安全实施；interactive 文件的并发修改将只验证、不覆盖。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `prepareNextTurn` 只在实际将开始下一 assistant turn 时调用，并在 `shouldStopAfterTurn` 之后。
- 大工具结果跨 threshold 时，同一 agent run 在下一 provider 请求前激活一个 checkpoint。
- compaction 期间加入的 steering 出现在压缩后立即恢复的 provider 请求中，不额外产生延迟 turn。
- terminating tool 不触发 threshold compaction。
- 当前完整请求估算、hard-limit blocking、projection revision 与 system prompt refresh 行为保留。
- manual compact 先持久化 aborted assistant response，再写 checkpoint。
- TUI compaction 后 working/progress 回归测试通过，且不覆盖其他会话改动。
- 目标测试、`npm run check` 和 task document validator 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005.
- Parallel batches: 无；agent loop 与 AgentSession continuation 接线共享行为契约，测试及实现需串行红绿验证；interactive 文件由其他会话占用。
- Serialization constraints: 不并行编辑 `agent-loop.ts`、`agent-session.ts`、compaction suite 或 authority document；interactive 文件只读验证，直到并发修改结束。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 修正 agent loop next-turn 生命周期

- Status: done
- Owner: coordinator
- Objective: 采用 `lastCompletedTurn` 语义，只在实际 continuation 前 preparation，并在长 preparation 后安全重读 steering。
- Inputs and prerequisites: F-001、main commit 56700d42 diff、当前 system-prompt/provider-context 扩展。
- Scope or files: `packages/agent/src/agent-loop.ts`, `packages/agent/src/types.ts`, `packages/agent/test/agent-loop.test.ts`, `packages/agent/CHANGELOG.md`.
- Expected output: 不丢失 my-pi 特有 context hooks 的最小 agent-core 生命周期变更及回归测试。
- Dependencies: None.
- Execution steps:
  1. 先增加 prepare 调用次数、terminating/final turn 和 preparation 期间 steering 的回归断言并观察失败。
  2. 最小修改 `runLoop` 和类型文档。
  3. 运行 agent-loop 目标测试。
- Acceptance criteria:
  - final/terminating turn 不调用 preparation。
  - preparation 后空 pending queue 会重读 steering；one-at-a-time 已有 pending 时不重复 drain。
  - `resolveSystemPrompt`、`buildProviderContext`、`onProviderContext` 行为保留。
- Verification method:
  - `packages/agent/test/agent-loop.test.ts`。
- Validation evidence: 红阶段 `packages/agent/test/agent-loop.test.ts` 3 个断言按预期失败（prepare 调用 2 次、stop/terminate 后各调用 1 次）；实现后同文件 25 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 将 continuation HF preflight 接入 preparation

- Status: done
- Owner: coordinator
- Objective: 让 post-tool compaction 在 steering 重读之前完成，同时保留 transform preflight 作为首轮和最终 provider gate。
- Inputs and prerequisites: T-001；现有 `_installAgentNextTurnRefresh`、`_checkCompaction`、checkpoint revision。
- Scope or files: `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/test/suite/agent-session-compaction.test.ts`.
- Expected output: 共享 provider-preflight helper、post-tool/steering/terminating 回归测试。
- Dependencies: T-001.
- Execution steps:
  1. 增加 post-tool crossing、steering during compaction、terminating tool 测试并确认目标失败。
  2. 提取现有 preflight 为可复用 helper，在 `prepareNextTurnWithContext` 中先运行，再调用已有 callback。
  3. 验证只有一个 checkpoint、一个 agent run，立即请求包含 steering。
- Acceptance criteria:
  - 满足全局 acceptance criteria 中的 post-tool、steering、terminating 条目。
  - 不降低完整请求估算和 hard-limit blocking。
- Verification method:
  - `packages/coding-agent/test/suite/agent-session-compaction.test.ts`。
  - `packages/coding-agent/test/suite/regressions/repeated-auto-compaction-active-tool-loop.test.ts`。
- Validation evidence: 红阶段 compaction suite 的 steering immediate-request 测试失败；实现共享 preflight helper 后通过。对抗审查新增 existing prepare callback composition 回归，红阶段 marker 被丢弃，修复 projection 同步顺序后 `agent-session-compaction.test.ts` 31 tests passed；active-tool-loop 1 test、auto-compaction queue 6 tests、active-tools-next-turn 3 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 锁定 manual compact 持久化顺序

- Status: done
- Owner: coordinator
- Objective: 确认 active response abort entry 在 manual checkpoint 前持久化。
- Inputs and prerequisites: T-002；main commit 的 #7253 回归断言。
- Scope or files: `packages/coding-agent/test/suite/regressions/7253-manual-compact-during-response.test.ts`；仅在测试暴露产品缺陷时修改对应最小实现。
- Expected output: durable ordering 回归保护。
- Dependencies: T-002.
- Execution steps:
  1. 增加 entry ordering 断言。
  2. 运行目标测试；仅在失败原因为产品行为时修复。
- Acceptance criteria:
  - aborted assistant entry 存在且索引小于 compaction entry。
- Verification method:
  - `packages/coding-agent/test/suite/regressions/7253-manual-compact-during-response.test.ts`。
- Validation evidence: 增加 aborted assistant entry 先于 compaction entry 的断言；`7253-manual-compact-during-response.test.ts` 1 test passed，无需产品代码修改。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证 TUI 状态恢复

- Status: done
- Owner: coordinator
- Objective: 验证并发修改提供的 compaction 后 working/progress 恢复与新的事件顺序兼容，不覆盖其文件。
- Inputs and prerequisites: T-003；F-005 中的现有 worktree diff。
- Scope or files: 只读验证 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/test/interactive-mode-compaction.test.ts`.
- Expected output: 目标测试通过；若并发修改消失或失败，重新评估后只做必要最小修改。
- Dependencies: T-003.
- Execution steps:
  1. 重查 git status/diff 确认所有权状态。
  2. 运行 interactive compaction 测试。
  3. 检查 agent_start/compaction_end/agent_end timing 与 progress 状态。
- Acceptance criteria:
  - active run compaction 后 working indicator 与 terminal progress 恢复。
  - turn duration 不因 compaction 重置。
- Verification method:
  - `packages/coding-agent/test/interactive-mode-compaction.test.ts`。
- Validation evidence: 并发修改已由独立 commit `df54418ad fix(coding-agent): restore turn UI after compaction` 落库；`interactive-mode-compaction.test.ts` 10 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 全量静态验证、diff 审核与提交

- Status: done
- Owner: coordinator
- Objective: 验证跨包契约，审查只包含授权变更，并按仓库规则提交本会话文件。
- Inputs and prerequisites: T-001 至 T-004。
- Scope or files: 本任务修改文件与 task document；不包含其他会话拥有的 interactive 文件和现有未跟踪文档。
- Expected output: targeted tests、`npm run check`、task validator 通过；显式路径提交。
- Dependencies: T-004.
- Execution steps:
  1. 运行目标测试和 `npm run check`。
  2. 审查 git diff/status，区分本会话与其他会话文件。
  3. 更新 task evidence/final result，validate 后显式 stage/commit。
- Acceptance criteria:
  - 所有目标检查通过，无未解释的本会话改动。
  - commit 不包含 F-005 的并发文件，除非其所有权已通过独立 commit 解除。
- Verification method:
  - targeted Vitest commands；`npm run check`；task document validator；`git diff --check`。
- Validation evidence: agent loop 25 tests passed；coding-agent 6 files / 52 tests passed；`npm run check` 通过；`git diff --check` 与 staged diff check 通过；实现以 commit `efdbcf26a` 提交且未包含既有未跟踪 harness 文档。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 红阶段：agent prepare call-count/queue 测试；coding-agent steering-during-compaction 测试。
2. 绿阶段：分别运行 agent-loop、agent-session compaction、active-tool-loop、#7253、interactive compaction 目标文件。
3. 邻域：运行 agent-session auto-compaction queue 测试。
4. 静态：仓库根 `npm run check`，完整输出；`git diff --check`。
5. 计划：每次 material status 更新后运行 task document validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- `prepareNextTurn` 是公开 callback，时序改变属于 breaking behavior；需 changelog 和精确测试。
- 双 preflight 可能导致重复压缩；通过 checkpoint count 和 provider call order 断言约束。
- compaction failure 抛错路径不能丢失 hard-limit fail-closed；保留现有 helper 逻辑。
- interactive 文件由其他会话修改；不得覆盖、stage 或 commit，除非其修改先独立落库且 HEAD 更新。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: 创建 execute task document。
- 2026-08-30: 记录已确认的 steering 延迟复现、当前架构边界和并发 interactive 文件所有权；T-001 开始。
- 2026-08-30: T-001 红阶段复现 3 个 lifecycle 失败；采用 `lastCompletedTurn` 后 `packages/agent/test/agent-loop.test.ts` 25 tests passed，T-001 完成，T-002 开始。
- 2026-08-30: T-002 红阶段确认 steering 延迟；共享 preflight helper 接入 continuation preparation 后 compaction suite 及 3 个邻域测试文件通过。
- 2026-08-30: T-003 新增 durable ordering 断言，#7253 回归测试通过；无需实现修改。
- 2026-08-30: TUI 并发修改由独立 commit `df54418ad` 落库，interactive compaction 10 tests passed；T-004 完成，T-005 开始。
- 2026-08-30: 对抗审查发现 compaction 激活后已有 prepare callback 的 context update 会被 revision refresh 覆盖；新增红测并改为 callback 前同步 projection，修复后 compaction suite 31 tests passed。其余报告项为既有边界或 upstream 明确的 one-at-a-time 取舍，未扩展本任务。
- 2026-08-30: 最终目标测试批次通过：agent 25 tests；coding-agent 6 files / 52 tests。首次 `npm run check` 因新增测试漏导入 `vi` 失败；补齐导入后完整 `npm run check` 通过且无自动修复，`git diff --check` 通过。
- 2026-08-30: 显式 stage 本任务 11 个文件并提交 `efdbcf26a fix(coding-agent): compact before post-tool requests`；T-005 完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 均完成并具备目标测试、静态检查、diff 审核和 commit 证据；task document validator 在最终状态通过。
- Limitations: 未运行仓库完整测试套件，遵循项目规则仅运行目标 Vitest 文件；既有未跟踪 `docs/harness_tools` 文档未触碰。
