# Task Plan: Stop child turn after result delivery

- Created: 2026-09-19
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户授权执行已确认的简化修复方案。

<!-- task-doc-section:background-goal -->
## Background and goal

Native child 成功调用 `deliver_result` 后当前仍会继续 agent loop，可能继续发起 provider/tool 调用；controller 只有在完整 `ChildSession.run()` 返回后才把 persisted `running` 改为终态。目标是让成功 delivery 在当前工具批次完成后终止 child turn，复用现有 agent-loop 的 `shouldStopAfterTurn` seam。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围仅限 `packages/coding-agent/src/extensions/pi-child-session-host.ts` 与对应定向测试。非目标：heartbeat、lease、watchdog、新状态、全局 deadline、teardown timeout 或 monitor 重构。该源文件已有另一任务未提交修改，本任务只暂存自己的精确 hunks。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `deliver_result` 只设置 `delivered` 并返回普通 tool result。 | `pi-child-session-host.ts` tool implementation |
| F-002 | agent-loop 在工具批次后调用 `shouldStopAfterTurn`，返回 true 会发出 `agent_end` 并退出。 | `packages/agent/src/agent-loop.ts:313-316` |
| F-003 | OpenAI Agents SDK 的 StopAtTools 和 AutoGen FunctionCallTermination 都把指定工具完成作为明确终止条件。 | 官方文档 URL 见本次调研答复 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 成功 delivery 是 child 当前 turn 的最终协议动作；同一批次已调度的其他工具仍按 agent-loop 既有语义完成。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 成功 `deliver_result` 后不再发生下一次 provider 请求。
- 无效 `deliver_result` 不终止，模型仍可重试。
- 同一批次多个成功 delivery 保持最后一个结果生效。
- 未调用 delivery 的普通 child 运行行为不变。
- controller 接收到 completed 结果并释放 running slot。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002.
- Parallel batches: 无，源和回归测试紧密耦合。
- Serialization constraints: coordinator 独占本任务测试修改；源文件与其他 Computer 工作共享，只做精确 hunk。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现 delivery 终止语义

- Status: done
- Owner: coordinator
- Objective: 使用现有 `shouldStopAfterTurn` 在成功 delivery 所在工具批次结束后停止 child loop。
- Inputs and prerequisites: F-001、F-002。
- Scope or files: `packages/coding-agent/src/extensions/pi-child-session-host.ts`。
- Expected output: 最小生命周期接线，不引入新状态或定时器。
- Dependencies: None.
- Execution steps:
  1. 保存原 callback。
  2. 安装组合 callback：delivery 成功优先停止，否则委托原 callback。
  3. dispose/失败启动时恢复原 callback，避免污染复用对象。
- Acceptance criteria:
  - delivery 成功后 loop 在批次边界结束。
- Verification method:
  - 定向 faux provider 回归。
- Validation evidence: `pi-child-session-host.test.ts` 的有效 delivery 用例仅提供一个 provider response 并通过，证明无第二次请求；多 delivery 批次最后值生效。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 回归验证与提交

- Status: done
- Owner: coordinator
- Objective: 验证有效、无效、多 delivery 和普通完成路径。
- Inputs and prerequisites: T-001。
- Scope or files: `packages/coding-agent/test/pi-child-session-host.test.ts` 及本任务文档。
- Expected output: 定向测试、类型检查、格式检查与精确提交。
- Dependencies: T-001.
- Execution steps:
  1. 先修改现有 delivery 测试令第二 provider 响应不可用，并断言请求数为 1。
  2. 添加无效 delivery 可重试且最后成功值生效的测试。
  3. 运行定向测试、scoped Biome、tsgo、diff check，精确暂存/提交。
- Acceptance criteria:
  - 所有目标路径通过，提交不包含共享 Computer hunks。
- Verification method:
  - Vitest、Biome、tsgo、git staged diff review。
- Validation evidence: `pi-child-session-host.test.ts` 18/18 通过；scoped Biome、tsgo、diff check 和任务 validator 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

运行 `pi-child-session-host.test.ts`，必要时补 `pi-collaboration-tools.test.ts`；检查 provider call count、持久终态、delivery 内容。随后 scoped Biome、`npx tsgo --noEmit`、`git diff --check`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 并行工具批次不会在首个 delivery 时强杀其他已开始工具，这是有意保留的安全语义。
- 本修复不解决任意 provider/extension/fsync Promise 真正不返回的问题；仅修复已观测的 delivery 后继续循环。
- 共享源文件包含未提交 Computer 工作，必须仅暂存本任务 hunk。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-19: 用户授权简化修复；T-001 开始。
- 2026-09-19: 通过组合现有 `shouldStopAfterTurn` 实现成功 delivery 后批次边界终止；保留原 callback。新增有效 delivery、无效后纠正、同批多 delivery 回归，18/18 通过。T-001/T-002 done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 定向 Vitest 18/18；scoped Biome、tsgo、diff check、任务文档 validator 通过。
- Limitations: 本修复不处理 provider、扩展 handler 或文件同步本身永不返回；不新增 deadline/watchdog。
