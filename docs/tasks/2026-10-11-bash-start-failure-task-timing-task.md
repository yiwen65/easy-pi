# Task Plan: 修复 Bash 启动前失败误恢复与用户任务重复耗时

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户报告 session b824062c-5115-485b-a05b-aedabe2f70c8 中断及两个 work time；完成只读诊断后明确要求“执行根因修复”。

<!-- task-doc-section:background-goal -->
## Background and goal

消除明确未启动的 Bash 失败被当作未知副作用而误触发恢复的问题，并使同一用户任务跨内部恢复/续跑时只有连续 Working 计时和最终一次 worked 结算。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

只修改 Bash 启动前失败的执行确定性、InteractiveMode 最终收尾边界、AgentSession settled 通知顺序及必要回归测试。保留真实未知副作用的 reconciliation、有界重试、历史耗时重放、正常后续用户任务和终态错误展示。

不修改目标会话/锁/子代理数据库，不重启或控制运行中的用户进程；不改依赖、锁文件、发布、模型或其他并发迁移。无真实 provider/API/凭证访问、构建或完整测试。根协调者独占本文并负责检查及提交；子代理不提交、不运行会自动写入全仓库的 npm run check。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 开始修复时 HEAD=6f935c952，原 worktree 干净。 | git status --short；git log -4。 |
| F-002 | 报告会话 12:18:17 +0800 的后台 Bash 指定不存在的 node22 cwd；错误为 SPAWN_ERROR。 | 原会话 JSONL 第 6799 行 pi-tool-interruption；诊断阶段实际 Bash 离线复现确认 shell 未解析、任务未注册、命令未运行。 |
| F-003 | 缺少 not_started 的 ExecutionToolError 默认被 getToolErrorOutcome 分类为 unknown，从而触发 needs_reconciliation 和内部恢复运行。 | packages/agent/src/harness/tools/bash.ts:187；tool-outcome.ts；task-recovery.ts:result；AgentSession 离线 faux 回放。 |
| F-004 | 只改变相同失败的 executionOutcome 为 not_started，可把同一输入的 start/end/start/end/settled 序列变成 start/end/settled，且无暂停任务。 | 诊断阶段双场景因果对照 PASS。 |
| F-005 | TUI 在 agent_end(!willRetry) 结算耗时，但内部恢复会在同一次 prompt 内再次 agent_start，直到最终才 agent_settled。 | interactive-mode.ts:3682–3719；agent-session.ts:_runAgentPrompt；实际 UI 回放同时呈现 worked19m22 和 Working13m32。 |
| F-006 | 将收尾移到 settled 后，原先扩展先于 public 通知的顺序允许重入 B，再由旧 A 通知误清理 B。 | 独立复核后 actual faux/extension/UI gate 红测 task-10-92172225.log；public 通知前移后同回归与邻接 105/105 通过。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 无剩余执行假设；agent_settled 的 prompt/resume 最终边界及异常、取消、重试与扩展重入路径已通过定向验证。
- Open question: 无需用户决策；若出现未授权文件冲突或依赖/发布需求，停止并询问。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 后台 Bash 的 cwd/容量/启动准备等明确未启动失败保留原错误文字并分类为 not_started；真实未知执行异常仍为 unknown。
- 真实 Bash 不存在 cwd 的 faux 会话回归不产生暂停任务或额外恢复运行。
- 内部 agent_end/agent_start 续跑不写 worked、不重置原起点，最终 agent_settled 才结算一次；正常新任务、重试、取消/异常最终收尾和历史重放不退化。
- 回归先在原实现因预期行为失败，再在修复后通过；必要邻接测试与根 npm run check 通过。
- diff 仅含本任务文件，完成后提交但不推送。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 和 T-002 无依赖；T-004、T-005 依赖 T-002；T-003 依赖 T-001、T-002、T-004、T-005。
- Parallel batches: 第一批 T-001（bash-start-fix）与 T-002（task-timing-fix）；发现邻接旧 fixture 后由 coordinator 执行 T-004；最后执行 T-003。现有工具仅有 spawn_agent，没有 DAG 批量工具，使用一次 parallel 包装发起两个独立任务。
- Serialization constraints: 两个子代理各自独占所列文件；协调者独占整合回归、本文、LEARNS.md 和提交，最终 npm run check 在子代理编辑结束后串行运行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 修正 Bash 启动前失败确定性

- Status: done
- Owner: /root/bash-start-fix
- Objective: 在未启动命令的拒绝边界保留 not_started，避免误恢复，保留真正未知效果安全门。
- Inputs and prerequisites: F-002–F-004；仓库规则；干净基线。
- Scope or files: packages/agent/src/harness/tools/bash.ts；packages/agent/test/harness/background-task-tools.test.ts；packages/agent/test/harness/bash.test.ts（必要时）；packages/coding-agent/test/suite/agent-session-bash-persistence.test.ts。
- Expected output: 最小实现和 Bash/faux 会话回归。
- Dependencies: None.
- Execution steps:
  1. 完整读取拥有文件及必要执行状态源；写回归并记录 red。
  2. 在证据保证命令未启动的边界修正确定性；运行拥有的测试。
- Acceptance criteria:
  - 不存在后台 cwd 的调用不会启动 shell、不产生任务、不进入 needs_reconciliation；普通/未知执行错误保持安全语义。
- Verification method:
  - 从 packages/agent 定向运行 Bash/background task 测试；从 packages/coding-agent 定向运行 suite/agent-session-bash-persistence.test.ts。
- Validation evidence: 原实现 core 回归 7 failed/24 passed，faux 回归 1 failed/30 passed，分别显示 unknown 错分类及额外 start/end。修复后协调者独立运行 Agent 四文件 59/59（task-6-ef7666c7.log）、coding-agent 三文件 80/80（task-5-2f67e9c6.log）通过；审查生产/最终测试 diff 和 red/green 日志，无 blanket 分类。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 统一用户任务耗时最终收尾

- Status: done
- Owner: /root/task-timing-fix
- Objective: 使内部恢复、续跑和重试保持同一个时间起点，到 agent_settled 才结束计时与折叠活动组。
- Inputs and prerequisites: F-005；现有时钟/活动组/错误展示/关闭路径。
- Scope or files: packages/coding-agent/src/modes/interactive/interactive-mode.ts；packages/coding-agent/test/turn-activity-footer.test.ts；packages/coding-agent/test/interactive-mode-retry.test.ts（必要时）。
- Expected output: 最小生命周期接线与同任务续跑、重试、最终收尾回归。
- Dependencies: None.
- Execution steps:
  1. 完整读取实现和拥有测试，核对 agent_settled 语义并写失败回归。
  2. 调整收尾边界，保留终态错误显示；执行定向 UI 邻接测试。
- Acceptance criteria:
  - 内部 end 后无 worked，续跑 Working 含原已用时间；最终 settled 一次结算，错误/取消收尾不留活动计时器。
- Verification method:
  - 定向 turn-activity-footer、interactive-mode-retry、status-indicator、turn-transcript-container 测试；必要新增场景必须运行。
- Validation evidence: 原实现新增回归先 5 failed/6 passed；修复后子代理七文件 93/93 passed，协调者独立重跑四核心文件 54/54 passed（task-4-e2062180.log）。协调者审查实现 diff 与 red/green 日志。独占范围外 compaction 旧 fixture 已由 T-004 迁移并通过，取消门和活动组回归亦已验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 整合复核、全仓库检查与提交

- Status: done
- Owner: coordinator
- Objective: 验证整个触发链和保留安全行为，审查独立结果后完成检查及提交。
- Inputs and prerequisites: T-001、T-002 的已检查 diff 与真实测试结果；T-004、T-005 邻接风险收敛。
- Scope or files: packages/coding-agent/test/suite/regressions/b824062c-bash-task-timing.test.ts（必要整合回归）；本文；LEARNS.md（仅经证实可复用经验）；拥有测试的类型注解修正。
- Expected output: 整合验证证据、干净检查与限定范围提交。
- Dependencies: T-001, T-002, T-004, T-005.
- Execution steps:
  1. 独立检查子代理 diff，补实际 Bash/faux/UI 触发链整合覆盖并运行。
  2. 运行定向邻接验证及 npm run check，核对 check 自动修改范围。
  3. 更新经验与本文，验证任务文档，显式路径提交。
- Acceptance criteria:
  - 所有回归/邻接测试与根检查通过，无目标会话或无关文件改动。
- Verification method:
  - targeted Vitest + faux；npm run check；git diff --check/status；task_document.py validate。
- Validation evidence: 实际组合回归扩展到四例；最终 Agent 4 files/59 tests（task-13-3fce8f71.log）及 coding-agent 13 files/189 tests（task-12-d8cb8a59.log）全部通过，共 248 项。首轮 check 的三个 Result mock TS2322 已按真实函数类型修正；最终 npm run check exit0（task-14-e1802465.log，完整输出已读取），无自动改写。独立重入 finding 经红/绿回归和通知顺序修复关闭；git diff --check 通过，源码/测试/经验限定于任务范围，已提交为 612f54acec52bce965f9d192fef630893ec7736a；提交后核对十个文件全部属于本任务，worktree 仅剩本文未跟踪，无代码残留。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 更新 compaction 邻接 fixture 的最终边界

- Status: done
- Owner: coordinator
- Objective: 将 compaction 现有回归 fixture 从内部 agent_end 迁移到真实最终 agent_settled，保持原断言并补充中间不结算断言。
- Inputs and prerequisites: T-002 源码和已通过的核心 UI 回归；子代理邻接验证发现 interactive-mode-compaction.test.ts:132 仍期待内部 end 即完成。
- Scope or files: packages/coding-agent/test/interactive-mode-compaction.test.ts。
- Expected output: 使用真实最终事件的邻接 fixture，完整文件通过。
- Dependencies: T-002.
- Execution steps:
  1. 完整读取 fixture 和失败证据，加入最终 settlement 事件及必要宿主 mock。
  2. 在内部 end 后断言没有完成，在 settled 后保持既有完成/历史重放断言；运行完整文件。
- Acceptance criteria:
  - compaction 保留起点、不在内部 end 结算，最终 worked 和历史重放仍通过。
- Verification method:
  - PI_OFFLINE=1 targeted Vitest test/interactive-mode-compaction.test.ts。
- Validation evidence: 新生命周期源码下旧 fixture 在第 132 行期待内部 end 完成而失败；协调者更新 fixture，保留既有完成/重放断言并增加中间 end 无结算断言，完整文件 10/10 passed（task-7-710deb5e.log）。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 防止最终收尾扩展重入抢先启动新运行

- Status: done
- Owner: coordinator（回归）和 /root/settled-reentry-fix（独占 agent-session.ts）
- Objective: 验证独立复核提出的 late settled 通知跨运行清理风险；若复现，在当前任务的最终通知边界修正顺序。
- Inputs and prerequisites: T-002；root-cause-review 静态路径：AgentSession._emitAgentSettled 先标 idle 并 await 扩展，再通知 UI，扩展可 triggerTurn 启动新运行。
- Scope or files: packages/coding-agent/src/core/agent-session.ts；packages/coding-agent/test/suite/regressions/b824062c-bash-task-timing.test.ts；必要 settled 事件邻接验证。
- Expected output: 真实 faux Session 与 UI 的可重入回归及最小通知顺序修正，或有证据排除风险。
- Dependencies: T-002.
- Execution steps:
  1. 在一次异步 settled 扩展中启动第二个持有 gate 的运行，验证原任务收尾是否清空新任务的 Working。
  2. 记录 red 后修正最终通知顺序；保留 extension idle 观察和 waitForIdle；运行回归与 settled/retry 邻接文件。
- Acceptance criteria:
  - 第二个运行仍活跃时不被第一个运行的 settled 清理；每次运行最终正确停止并记录自身耗时。
- Verification method:
  - actual suite/harness faux + real InteractiveMode lifecycle；6363-agent-settled-event、agent-session-retry-events 和相关会话回归。
- Validation evidence: 真实 faux/扩展/UI gate 回归先 1 failed/2 passed（task-10-92172225.log）：第二个运行 isStreaming=true 且 isIdle=false，但 Working 被旧 settled 清空。将 public settled 通知前移到扩展 hook 之前，用 finally 保留 subscriber 抛错时的扩展收尾及既有 idle 解析；协调者审查 8 行局部 diff 并独立运行组合/settled/event/retry/recovery/persistence 六文件 105/105 passed（task-11-e1289a45.log）。连续独立复核认为原重入链已关闭，无新具体阻塞；四项组合测试包括已 pending idle waiter 的异常保护。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

全部模型相关测试仅 faux；运行 PI_OFFLINE=1 的单文件/定向 Vitest（从所属 package 根）。先记录失败断言，修改后重跑完整修改文件。禁止 npm test、完整 Vitest、构建和真实 provider 调用。

- Agent：`PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/harness/background-task-tools.test.ts test/harness/bash.test.ts test/harness/background-task-manager.test.ts test/agent-loop-tool-error.test.ts`，59/59 passed。
- coding-agent：`PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/turn-activity-footer.test.ts test/interactive-mode-retry.test.ts test/status-indicator.test.ts test/turn-transcript-container.test.ts test/interactive-mode-compaction.test.ts test/interactive-mode-grok-components.test.ts test/suite/regressions/6363-agent-settled-event.test.ts test/suite/agent-session-retry-events.test.ts test/suite/agent-session-bash-persistence.test.ts test/bash-tool-contract.test.ts test/suite/agent-session-task-recovery.test.ts test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts test/suite/regressions/b824062c-bash-task-timing.test.ts`，189/189 passed。
- 根 `npm run check`：格式/lint、精确依赖、TS import、shrinkwrap、install-lock、tsgo、browser smoke 均通过；完整输出已读取且无自动修改。
- `git diff --check` 和 `task_document.py validate --path <本文>`：通过；提交前后再次核对文件范围。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 不能把所有异常 blanket 标为 not_started；只改明确未启动命令的边界，保留取消/后启动未知效果。
- 将 UI 收尾从内部 end 移到 settled 时必须停止状态指示器并请求重绘，避免异常路径遗漏 end 造成泄漏。
- 共享 worktree 和 npm run check --write 可影响无关文件；先检查并行编辑结束与状态，检查后核对范围。
- 旧运行进程不会热加载修复；本次不重启用户 session，也不回填已有历史记录。
- 仅内置 Node BackgroundTaskManager 的未启动 Result 错误已被实际验证；自定义 BackgroundTaskManagerLike 应遵守失败准入不启动命令的边界，不把不透明 transport 的未知效果推断为未执行。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 创建并填充执行契约，复核 HEAD 和干净 worktree；T-001、T-002 设置 in_progress，使用 parallel 授权派发两个文件不重叠子任务。
- 2026-10-11: T-002 返回实现和真实 red/green 证据；协调者审查两处生产 diff、读取失败/通过日志并独立重跑 UI 核心四文件 54/54 passed，验收 T-002 done。
- 2026-10-11: 邻接 compaction 旧 fixture 仍按 agent_end 断言完成；新增必要 T-004，指定 coordinator 独占该测试文件并开始迁移。T-003 保持 pending，等待完整依赖验收。
- 2026-10-11: T-001 最终输出经源码/回归 diff、原 red 日志与协调者独立 59+80 测试验证，验收 done；T-004 完整文件 10/10 passed，验收 done。
- 2026-10-11: 所有初始依赖已通过，T-003 开始；实际 Bash/faux/真实 UI 组合两例 2/2 passed。独立只读 root-cause-review 同时检查修复安全边界，不具有写权限。
- 2026-10-11: 首轮根 check 在新测试 Result mock 的 unknown 泛型处失败；明确注解真实函数类型修正，未修改生产类型或依赖，检查没有自动改写其他文件。
- 2026-10-11: 独立 review 指出异步 settled 扩展可先启动 B，之后旧 A 的 settled 才通知 UI，可能误清理 B；新增 T-005 因果回归并开始，T-003 暂 blocked 等待该风险收敛及根检查重跑。
- 2026-10-11: T-005 真实 held-tool 重入回归在第二个运行仍活跃时稳定失败（Working=undefined）；授权只读/edit 子代理独占 agent-session.ts 最小顺序修正，coordinator 保留测试所有权并增加 subscriber-throw 邻接保护。
- 2026-10-11: T-005 修复经协调者 diff 检查、105 项定向测试及连续只读复核通过，验收 done；T-003 解除 blocked，继续最终完整定向矩阵和根检查。
- 2026-10-11: 最终 17 个定向文件 248/248 passed；根 check 全部通过，输出已完整读取，状态核对未触及无关文件；新增两条经过实际红/绿验证的执行确定性和重入收尾经验。
- 2026-10-11: 实现、回归与经验已显式十路径提交为 612f54acec52bce965f9d192fef630893ec7736a；提交后 git show/status 核对通过，T-003 done。本文最终验证状态写入后单独提交执行记录，无推送、构建、目标会话改写或用户进程控制。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001–T-005 全部 done，无 blocked；17 个定向文件 248/248 passed，根 npm run check、git diff --check 与任务文档验证通过；代码提交 612f54acec52bce965f9d192fef630893ec7736a 已核对限定十文件范围。执行记录单独提交。
- Limitations: 没有运行完整 suite/构建/真实 provider 或用户物理 TUI；原运行进程与历史记录不在修改范围，已加载旧模块不会热替换。
