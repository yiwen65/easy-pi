# Task Plan: Subagent 诊断、收尾与活动可见性优化

- Created: 2026-10-19
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户在已确认缺陷与优化分析后授权“执行优化”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复子代理执行错误分类丢失、结果保存失败时关闭仍报成功的问题；使协调模型无需额外推理即可看到孩子的实际活动，避免把等待期限误认成任务失败。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：native child host、collaboration controller/contract、对应离线测试及协作说明。严格保留权限、参数校验、任务接收/执行/结果验收区别。
不做：真实 provider 调用、构建发布、自动重试/自动中断、原始异常或凭证回显、强制项目快照与 worktree、历史 session 改写。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | controller 把执行抛错统一丢为通用失败文字 | collaboration-controller.ts:975–983；离线注入 forbidden/tools_unavailable 后分类丢失 |
| F-002 | shutdown 没检查完成持久化失败 | collaboration-controller.ts:1135–1172；离线 commit 抛错后 shutdown resolved |
| F-003 | wait 只等待终态/主动进度，超时不会取消任务 | collaboration-controller.ts:714–774；前轮 targeted wait/progress 测试 45 项通过 |
| F-004 | monitor 已跟踪活动，但模型查询未暴露它 | pi-collaboration-monitor.ts:174–176；controller.list/readAgentResult |
| F-005 | warm deliver_result 后 followup 并非必然失败 | 本会话 faux 离线两轮实验均 completed，provider 请求各一次 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 活动是宿主观察而非任务进展；使用有界、按 turn 绑定的内存投影，卸载/重启后不得伪造活动。
- Assumption: 安全诊断可采用 native custom entry 加有界结果引用，避免为此迁移整个团队数据库。
- Open question: 无阻塞决策；原即时失败的具体原因未证明，此次增强诊断而非声称修复该未知原因。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 执行异常保留白名单错误分类/阶段及可查的安全诊断引用，不泄漏任意异常正文。
- 完成写入失败时仍清理资源，但 shutdown 明确失败。
- 查询/等待超时可看到当前 turn 活动；旧 turn、卸载或恢复不得继承伪造活动。
- 不因每个 token 写库、发送 mailbox 或唤醒根推理；活动不替代 report_progress。
- 定向离线回归及 npm run check 通过；仅提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-004；T-005 → T-002。
- Parallel batches: T-001 与新增 T-005 分属 controller/host，可并行；随后串行，避免交叉接线并发修改。
- Serialization constraints: 子代理独占 T-001 的 controller 和 controller.test，交付后协调者才修改这些文件；任务文档归协调者。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 关闭失败传播

- Status: done
- Owner: subagent shutdown-fix
- Objective: 清理不掩盖结果持久化失败。
- Inputs and prerequisites: 已确认 F-002。
- Scope or files: packages/subagent/src/collaboration-controller.ts；packages/subagent/test/collaboration-controller.test.ts。
- Expected output: 最小 shutdown 修复和失败注入回归。
- Dependencies: None.
- Execution steps:
  1. 先新增并运行回归，确认旧代码假成功，再修复并复测。
- Acceptance criteria:
  - 失败时清理完成但 shutdown 返回 storage_error。
- Verification method:
  - 定向 controller 测试。
- Validation evidence: 子代理新增两条回归旧代码失败；修复后 controller 56/56 通过；协调者已审查 diff，最终集成会重跑。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 安全执行诊断

- Status: done
- Owner: coordinator
- Objective: 覆盖推理前失败、provider 失败和执行抛错，保留安全分类与诊断来源。
- Inputs and prerequisites: T-001 交付，F-001。
- Scope or files: native child host、session-host/contract、controller 及相关测试。
- Expected output: 有界诊断和回归，不泄漏原始错误。
- Dependencies: T-001, T-005.
- Execution steps:
  1. 接线安全分类、native 诊断记录和结果引用，补失败测试。
- Acceptance criteria:
  - 已知错误分类保留，未知错误无凭证/路径/堆栈回显，推理前也可诊断。
- Verification method:
  - child host/controller 定向离线测试。
- Validation evidence: observability/native host 33/33；runtime/controller 58/58；preflight 与 provider 回归旧代码失败、修复后通过，错误摘要和诊断不回显任意异常文本。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 活动与等待可见性

- Status: done
- Owner: coordinator
- Objective: 给模型查询宿主观察活动，明确等待到期不等于任务失败。
- Inputs and prerequisites: T-002 接口稳定。
- Scope or files: session-host/contract、controller、native child host、协作工具及对应测试。
- Expected output: 按 turn 绑定的有界活动投影和明确超时语义。
- Dependencies: T-002.
- Execution steps:
  1. 宿主上报阶段/工具活动，查询投影，验证旧 turn 与恢复隔离。
- Acceptance criteria:
  - 无主动进度时仍能看见实际活动；不写活动流水、不自动唤醒/重试/取消。
- Verification method:
  - targeted wait/progress/native host 定向测试。
- Validation evidence: 全部9个 collaboration 定向文件236/236通过；新增活动测试确认100次事件零commit/零通知、超时仍running、旧turn隔离和冷恢复无伪造活动；native observability和host测试通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成、说明与提交

- Status: done
- Owner: coordinator
- Objective: 验证完整链路并记录操作边界。
- Inputs and prerequisites: T-001 至 T-003 已验证。
- Scope or files: packages/coding-agent/docs/collaboration.md、LEARNS.md、任务文档及本任务代码。
- Expected output: 文档、定向测试、完整检查及最小提交。
- Dependencies: T-003.
- Execution steps:
  1. 更新协作说明，覆盖审计版本/范围/阶段交付建议；运行集成测试、npm run check、审查 diff 并提交。
- Acceptance criteria:
  - 所有本任务回归通过，无未说明的失败；不构建、不调用真实 provider。
- Verification method:
  - 定向 vitest；npm run check；任务文档校验；git diff/status。
- Validation evidence: subagent 9 files / 236 tests、coding-agent 10 files / 118 tests 全部通过；npm run check 通过（最后一轮 No fixes applied）；git diff --check 及任务校验通过；独立只读审查无可执行发现；已审查受托两个diff及最终源码diff。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 持久化孩子 warm followup 文件身份修复

- Status: done
- Owner: coordinator
- Objective: 修复完成后 chmod 改变 ctime，造成下一轮 SessionManager 拒绝写入。
- Inputs and prerequisites: 新持久化 warm delivery 回归在旧代码稳定失败；sameSessionFileIdentity 比较 ctimeNs。
- Scope or files: packages/coding-agent/src/extensions/pi-child-session-host.ts；test/pi-child-observability.test.ts。
- Expected output: 权限设置发生在 SessionManager 捕获身份之前；保留后续文件身份防护。
- Dependencies: None.
- Execution steps:
  1. 移除运行后冗余 chmod，在已有文件加载前设置权限并复测持久化两轮。
- Acceptance criteria:
  - 持久化孩子 deliver_result 后无需冷加载即可再次执行，文件仍私有。
- Verification method:
  - 新 warm followup 定向离线回归。
- Validation evidence: 旧代码持久化 warm 回归抛 Session changed since it was loaded；移除运行后 chmod 后 targeted successful delivery 回归通过（1 passed / 2 skipped）。诊断两项回归按预期失败，T-002 处理。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

使用 packages/subagent 的 controller、targeted-wait、progress 测试及 packages/coding-agent 的 child-session-host、collaboration-tools 测试。测试只用 faux/fake host，避免真实账户/provider。根 npm run check 可能自动格式化，结束后核对文件归属。最终校验任务文档与 git diff。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

错误脱敏不可放宽；诊断写入本身失败时必须诚实标记来源不可用。活动不能当健康性/完成证明，不持久化会在冷加载后未知。共享 cwd 不自动隔离；本任务只提供操作约束建议。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-19: 执行授权确认；仓库工作区干净，分支 my-pi；T-001 进入执行，独占委派。
- 2026-10-19: 新回归发现持久化 warm followup 的 ctime 身份失配；新增 T-005 进入执行，与 T-001 文件无重叠。T-002 诊断回归已准备并观察旧代码失败。
- 2026-10-19: 审查 T-001 diff 并接回 controller 所有权；T-001、T-005 标记完成，T-002 进入实现。
- 2026-10-19: 安全诊断和 controller fallback 完成并通过定向回归；T-002 完成，T-003 开始。
- 2026-10-19: T-003 活动接线与边界测试通过；T-004 开始集成，补协作说明并委派单文件测试fixture对齐；已知故障注入用例需明确断言shutdown的新storage_error，不能全局吞错。
- 2026-10-19: 集成测试暴露旧monitor测试将历史结果与瞬时活动整体比较；改为断言历史结果及耗时稳定、旧turn不携带活动。指定故障fixture显式期待storage_error，冷重开后仍要求正常关闭。
- 2026-10-19: 最终19文件354项离线回归通过；npm run check通过且无额外改写；独立审查无发现；补充warm持久化回归经验。全部实现与验证完成，本记录随本任务提交保存。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 全部完成；packages/subagent 下 `node ../../node_modules/vitest/dist/cli.js --run test/collaboration-*.test.ts` 为236/236；packages/coding-agent 下 `node ../../node_modules/vitest/dist/cli.js --run test/pi-child-*.test.ts test/pi-collaboration-*.test.ts` 为118/118；根 `npm run check` exit0；任务校验与diff检查通过。
- Limitations: 无真实 provider、已安装二进制或物理终端验收，未构建发布，运行中进程不热更新。持久化warm复用缺陷已在合成文件精确红绿复现，但没有原即时失败的被吞异常，故不宣称它是该历史事件唯一原因。活动不证明任务健康、进展或完成。
