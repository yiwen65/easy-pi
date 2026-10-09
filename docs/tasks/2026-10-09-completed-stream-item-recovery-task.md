# Task Plan: 模型断流后的完整输出项恢复

- Created: 2026-10-09
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户要求参考 Codex 整改，已确认采用完整项保留、断流后执行工具并接续。

<!-- task-doc-section:background-goal -->
## Background and goal

失败响应的完整项目前全部丢弃。参考 Codex 2351d9e 的项完成边界，在断流后保留完整项，沿既有批处理执行完整工具调用，收集结果后使用最新历史接续。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：可信完成标记、恢复检查点、AgentSession 接续、代理转发、协议字段核对、离线回归、文档和提交。首先接入具有明确 output_item.done 的 Responses 系列；通用本地 *_end 不作为上游完成证明。正常回合保持批处理；不在流中执行工具，不增加无限重试，不宣称跨崩溃恰好一次。保护开工时其他会话修改。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 开工时错误响应后不执行任何调用 | 基线 306dd93b7 packages/agent/src/agent-loop.ts:268 |
| F-002 | Responses 提供 output_item.done；其他 end 可能只是本地片段结束 | packages/ai/src/api/openai-responses-shared.ts、openai-completions.ts |
| F-003 | 重试移除尾部错误并继续，成功消息重置预算 | packages/coding-agent/src/core/agent-session.ts:1059,1499,3305 |
| F-004 | Codex 收集工具结果后重新读取历史重试 | upstream 2351d9e core/src/session/turn.rs:1635,2462,3167 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 只有上游确认完成的项可进入检查点；孤立思考和未完成调用不重放。
- Open question: 无，用户已选择断流后执行方案。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 完整调用 A + 半截 B + 断流：A 执行一次、B 不执行；重试包含 A 结果。
- 完整文本保留且可接续；未完成文本排除；检查点不重置失败预算或重复统计 usage。
- 取消、非重试错误、length 不执行恢复工具；正常调用顺序保持。
- 保存检查点先于工具执行，收集结果先于重试；定向测试与 npm run check 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: 故障回归 -> 协议/loop/接续实施 -> 邻域验证/check/交付。
- Parallel batches: 无，跨层行为合同串行修改与验证。
- Serialization constraints: 协调者独占本任务增量；脏文件只暂存本次补丁。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 完整项断流恢复整改与验证

- Status: done
- Owner: coordinator
- Objective: 落实已确认恢复合同，完成 red/green 和交付。
- Inputs and prerequisites: F-001 至 F-004，用户已授权整改。
- Scope or files: ai types/Responses、agent loop/Agent、AgentSession 最小增量、新回归、相关文档。
- Expected output: 完整项检查点、结果收集、有限恢复及验证证据。
- Dependencies: None.
- Execution steps:
  1. 建立离线故障基线，运行新回归观察失败。
  2. 明确项完成标记，保存快照、执行完整调用、收集结果和记录错误尾部。
  3. 验证取消、预算、normal/length、持久化和快照边界；执行 check 并提交本次增量。
- Acceptance criteria:
  - 本文验收条件全部满足，其他会话修改保留。
- Verification method:
  - 指定 Vitest 文件、npm run check、git diff/status、任务文档校验。
- Validation evidence: 用基线 agent-loop 和真实 Responses 解析重放，2 failed / 1 passed（完整调用未执行、完整文本未保留）；实现后新 suite 13/13 passed，AI 完成标记 13/13 passed，代理标记回归修复前 3 failed / 1 passed、修复后 4/4 passed。最终 coding-agent 8 files / 121 passed、agent 4 files / 67 passed、AI 5 files / 31 passed、server protocol 9 passed，合计 228。npm run check 无错误、警告、info，通过浏览器 smoke、依赖和锁文件一致性检查。独立提交树（仅本次增量）新 suite 13/13 和完整 check 同样通过；只链接离线生成的模型目录与既有 node_modules。提交中共享 AgentSession 只有一行条件修改，两个共享 changelog 各一条记录；其余会话修改均未纳入。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

各包根运行指定 Vitest；suite 使用 harness + faux provider，必要时 loopback SSE，不使用真实模型。新回归先 red 后 green；针对 retry/prompt/queue/compaction 邻域验证；npm run check 完整输出且核对自动格式化边界。禁止 npm test/build 和完整 Vitest。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

本地 *_end 不能直接证明上游项完成。检查点不能重置失败预算，usage 只计入原响应一次。工具副作用和结果持久化仍为独立步骤。工作区存在 retry/edit 并发修改，必须隔离增量暂存。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-09: 读取 best-practice、Codex 和本地执行边界，用户确认断流后执行方案；T-001 开始。
- 2026-10-09: 完成标记由 Responses upstream done/status 和严格 JSON 校验产生；完成项以不可变快照保留，检查点先持久化，工具结果完成后再结束失败回合。保留批处理、准入和终止行为。
- 2026-10-09: 边界回归发现取消后已排队错误仍可能重试，已将活动 abort signal 优先归一化；length 继续沿既有错误工具结果路径处理。
- 2026-10-09: root 定向 228 项通过，完整 check 通过；独立提交树验证通过，确认不依赖其他会话尚未提交的实现。使用隔离工作树/索引提交本次增量并仅同步拥有路径的索引记录，未改写共享工作区文件；最终验证记录随同本次提交更新。T-001 done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 228 项定向测试、独立提交树的新 suite 13 项、两树完整 npm run check、git diff --check 和任务文档校验均通过；本次增量已提交。
- Limitations: 不包含真实模型、流中工具执行或跨崩溃事务验证。
