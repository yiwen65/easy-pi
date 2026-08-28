# Task Plan: Harness 执行可靠性改进路线

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 2026-08-23 会话分析《根据 harness 方法论并结合 .edru 分析 pi 值得改进的地方》给出的推荐实施顺序；`docs/harness/Agent Harness 最佳实践方法论.md`；`.edru/` 接管资产

<!-- task-doc-section:background-goal -->
## Background and goal

2026-08-23 的静态分析结论：Pi 的上下文质量（HF Compaction）已领先于执行可靠性。生产执行路径 `AgentSession` 的 Run/控制命令/队列/重试主要驻留进程内存；`AgentHarness` 虽有持久记录与恢复 Reducer，但全部关键执行方法抛 `HarnessNotImplemented`；SessionManager JSONL、HF derived stores、Harness SessionRepo 三套状态系统并存。

目标：按推荐顺序推进 harness 执行可靠性。全部路线任务（T-001..T-012）已完成：Task Ledger 修复、durable coordinator 三切片、工具网关、控制安全点/预算/无进展/Interrupt、Recall 持久化与确定性、canonical-first 持久化、coding-agent 网关接线、远程参考服务、.edru 刷新与故障注入矩阵。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope（已执行）：**
- T-001：`task-ledger.ts`/`goal-interpreter.ts` 三缺陷修复（不接线）。
- T-002（T-009/T-010/T-011）：AgentHarness durable coordinator（方案 A，用户确认）。
- T-003：工具契约/operation identity/unknown-outcome（packages/agent）。
- T-004：provider 重试接入、RunBudgets、无进展 fingerprint、pause/resume。
- T-005：Recall 持久化、确定性 ID、toolsTokenEstimate。
- T-006：AgentSession canonical-first 持久化。
- T-007：HarnessPiServerService（coding-agent→pi-server，用户拍板）。
- T-008：故障注入矩阵 + .edru full rebaseline。
- T-012：coding-agent 网关接线（hook 复检 + ledger 门控 + 保守分类）。

**Non-goals（显式排除并记录）：**
- manual drive（peekAction/executeAction/runToCompletion）、多 lane 执行、hooks 注册表：无仓库内消费者（YAGNI）。
- 每请求完整 Context Manifest 持久化（存储量级决策留后续）。
- Resource Key/乐观版本、审批通道、durable 长任务 handle、跨进程 lease、sandbox profile。
- deferred provider 响应（fail-closed 为 deferred_unsupported）；model_change 条目接线；driver 并行工具。
- 真实 provider API 验证（仓库规则禁止）。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Task Ledger 三缺陷（SET_FOCUS replay 丢失、resolvePending 无版本无事件、interpreter 批量非原子） | `task-ledger.ts`、`goal-interpreter.ts`（修复前 Red 复现） |
| F-002 | AgentHarness 原为 scaffold（全部执行方法 HarnessNotImplemented）；reducer/storage/conformance 已成熟 | `agent-harness.ts`（修复前）、`session/types.ts`、`reducer.ts` |
| F-003 | AgentSession 先通知后持久化；hook 改参不复检；HF ledger 镜像静默吞错；未知工具默认 none/low | `agent-session.ts:717-788`（修复前）、`session-integration.ts`（修复前） |
| F-004 | Recall catalog 仅内存；group/recall id 走进程 counter；pinned message 用 Date.now()；工具定义 token 未计入 | `recall-catalog.ts`、`atomic-groups.ts`、`orchestrator.ts`（修复前） |
| F-005 | 仓库规则：`npm run check` 必跑且会改写共享 worktree；禁真实 provider；不提交；erasable TS | `AGENTS.md`、`LEARNS.md` |
| F-006 | 方案 A 用户确认；T-007 落点 coding-agent→pi-server 用户拍板；并发 session 文件 2026-08-23 确认可接管 | 会话决策记录 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption（已验证）: dirty 的 Task Ledger 与并发 session 的未提交改动均属本路线工作产物，可接管。验证：用户两次确认。
- Open question（已解决 2026-08-23）: T-002 边界——用户选方案 A（完成 AgentHarness 控制核，AgentSession 维持至 parity）。T-007 依赖边——coding-agent→pi-server。
- Open question（留给后续）: 双执行路径（AgentSession vs AgentHarness）的 parity 与收敛时间线（.edru UNK-W003）。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- [x] Task Ledger live==replay；批量失败零残留；不接线生产。
- [x] AgentHarness 崩溃在每个安全点可恢复；重复投递幂等；单一权威工具结果。
- [x] 工具契约强制：超时→unknown；重试仅幂等；approval fail-closed；operationId 稳定。
- [x] 预算/无进展兜底终止；pause 可恢复；abort 优先。
- [x] Recall 重启可解析且 ref 确定；工具 token 计入下一请求。
- [x] 订阅者抛错不阻止权威持久化。
- [x] hook 改参复检；ledger 拒绝即阻断派发。
- [x] 远程参考服务可建会话/恢复/投影快照。
- [x] .edru 结构校验通过；全部测试套件绿；`npm run check` exit 0 且无范围蔓延。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph：T-001 → 无；T-002(T-009→T-010→T-011) → T-001；T-003 → T-002；T-004 → T-002；T-005 → T-001；T-006 → T-002；T-007 → T-003,T-004；T-008 → T-002..T-007；T-012 → T-003。
- Parallel batches: 全部由 coordinator 串行执行（共享文件与状态）。
- Serialization constraints: agent-harness.ts 单写者；coding-agent 文件在并发 session 结束后接管。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Task Ledger replay/事务修复（不接线生产）

- Status: done
- Owner: coordinator
- Objective: 修复 SET_FOCUS replay 丢失、pending 解决无事件无版本、interpreter 批量非原子。
- Inputs and prerequisites: 分析证据 F-001；既有 untracked 测试。
- Scope or files: `task-ledger.ts`、`goal-interpreter.ts` 及对应测试。
- Expected output: live==replay；批量失败零残留。
- Dependencies: None.
- Execution steps:
  1. Red 回归 → 修复 → Green → check。
- Acceptance criteria:
  - replay 保真；版本化 resolve；applyAtomic 事务。
- Verification method: 定向 vitest + 全目录 + npm run check。
- Validation evidence: 2026-08-23 完成。新增 replay 保真/原子性回归用例；实现 applyFocusReplay/applyPendingResolutionReplay、resolvePendingGoalChange 版本化事件、applyAtomic（事件缓冲+快照回滚）；interpreter 改走 applyAtomic。compaction-subsystem 254 passed/6 skipped；npm run check exit 0 无蔓延。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 完成 AgentHarness durable coordinator（伞任务：T-009/T-010/T-011）

- Status: done
- Owner: coordinator
- Objective: 以 SessionRepo+reduceLaneState 实现 create.restore/prompt/resume/abort/steer/followUp/action 驱动；安全点崩溃可恢复且不重复工具观察。
- Inputs and prerequisites: T-001 done；用户确认方案 A。
- Scope or files: `packages/agent/src/harness/` 及测试。
- Expected output: 三切片全部落地。
- Dependencies: T-001。
- Execution steps:
  1. T-009 主路径+崩溃恢复；2. T-010 控制账本；3. T-011 compact/navigation/parity 收尾。
- Acceptance criteria:
  - 每个安全点注入崩溃恢复一致；重复投递幂等。
- Verification method: 定向 vitest + 全量 + check。
- Validation evidence: 2026-08-23 完成（三切片证据见各子任务）。agent 包最终 464 passed/1 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — coordinator 切片一：create.restore + prompt 单 lane 主路径 + 崩溃恢复

- Status: done
- Owner: coordinator
- Objective: create 恢复开放 operation；prompt 记录先行驱动至终态；崩溃后 resume 不重复提交。
- Inputs and prerequisites: T-001 done。
- Scope or files: `agent-harness.ts`、新增 run 测试。
- Expected output: 主路径 durable；replay:never 不盲重放。
- Dependencies: T-001。
- Execution steps:
  1. Red 先行；2. driver 实现；3. 全量验证。
- Acceptance criteria:
  - 新测试矩阵全绿；恢复后无重复语义 entry。
- Verification method: vitest + biome/tsgo。
- Validation evidence: 2026-08-23 完成。`agent-harness-run.test.ts` 9 用例。修复：prompt 首个 await 前 LaneBusy 竞态；历史 batch 完成判定死循环。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — coordinator 切片二：steer/followUp/abort/nextRun 控制命令账本

- Status: done
- Owner: coordinator
- Objective: 队列记录持久化、安全点消费、abort 回收。
- Inputs and prerequisites: T-009 done。
- Scope or files: `agent-harness.ts`、新增 controls 测试。
- Expected output: 命令崩溃后不丢不重；Cancel 优先。
- Dependencies: T-009。
- Execution steps:
  1. Red；2. enqueue/cancel/drain/abort 回收；3. 验证。
- Acceptance criteria:
  - one-at-a-time 每 turn 一条；abort 后不再派发。
- Verification method: vitest + biome/tsgo。
- Validation evidence: 2026-08-23 完成。`agent-harness-controls.test.ts` 9 用例。修复：第二个 LaneBusy 竞态、operationReady 门（unknown_operation 腐败）、queueLock + driver 取消权（invalid_queue_cancellation 腐败）。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — coordinator 切片三：compact/navigateTree/parity 与公开 API 收尾

- Status: done
- Owner: coordinator
- Objective: compact/navigateTree/skill/template/runWhenIdle/watch/lanes/watchSession；resume 全 kind。
- Inputs and prerequisites: T-010 done；compaction/branch-summary helper；fauxProvider。
- Scope or files: `agent-harness.ts`、新增 operations 测试；scaffold 同步。
- Expected output: 全 kind durable；resume 全 kind。
- Dependencies: T-010。
- Execution steps:
  1. Red；2. driveCompaction/driveNavigation；3. 验证。
- Acceptance criteria:
  - scaffold 未完成清单仅剩手动 drive/多 lane（YAGNI 记录）。
- Verification method: vitest + 全量 + check。
- Validation evidence: 2026-08-23 完成。`agent-harness-operations.test.ts` 9 用例。修复 findEntriesOnBranch oldestFirst+stopAtId 丢锚点后续条目导致的多 run 死循环。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 工具网关：四类契约、稳定 operation identity、unknown-outcome 对账

- Status: done
- Owner: coordinator
- Objective: ToolContract/ToolExecutionInfo；executeWithInfo；超时→unknown；重试仅幂等；approval fail-closed；replay 派生。
- Inputs and prerequisites: T-002 done。
- Scope or files: `packages/agent/src/types.ts`、`harness/agent-harness.ts`、`harness/session/types.ts`、测试。
- Expected output: 契约声明式；driver 门禁。
- Dependencies: T-002。
- Execution steps:
  1. Red；2. 类型+门禁；3. 验证。
- Acceptance criteria:
  - 副作用非幂等不重试；超时/崩溃不盲重放；attempt 递增。
- Verification method: vitest + 全量 + check。
- Validation evidence: 2026-08-23 完成。`agent-harness-tool-gateway.test.ts` 6 用例。设计修正：execute 第 5 参与 ToolDefinition.ctx 冲突 → executeWithInfo 可选入口。修复重试成功 isError 未重置 bug。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — coding-agent 侧工具网关接线（hook 改参复检 + HF ledger 门控）

- Status: done
- Owner: coordinator
- Objective: hook 原地改参后重新校验；ledger 接受后才派发；未知工具保守分类。
- Inputs and prerequisites: T-003 done；用户确认接管并发 session 文件。
- Scope or files: `agent-loop.ts`、`agent-session.ts`、`session-integration.ts`、`extensions/types.ts` 注释、测试。
- Expected output: 分析证据点关闭。
- Dependencies: T-003。
- Execution steps:
  1. Red；2. 三处接线；3. 验证。
- Acceptance criteria:
  - 非法改参不执行；ledger 冲突阻断。
- Verification method: vitest + check。
- Validation evidence: 2026-08-23 完成。`agent-session-tool-gateway.test.ts` 3 用例；agent-loop characterization 测试更新为新契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 控制命令账本、安全点、预算与无进展检测

- Status: done
- Owner: coordinator
- Objective: provider 重试接入；RunBudgets；无进展 fingerprint；pause/resume 与 Cancel 分离。
- Inputs and prerequisites: T-002 done。
- Scope or files: `agent-harness.ts`、`session/types.ts`、`codec.ts`、`reducer.ts`、测试。
- Expected output: budget_exceeded/no_progress 兜底；pause 可恢复；abort 优先。
- Dependencies: T-002。
- Execution steps:
  1. Red；2. 记录类型+reducer+driver；3. 验证。
- Acceptance criteria:
  - 循环有界；pause 后 resume 不丢状态。
- Verification method: vitest + 全量 + check。
- Validation evidence: 2026-08-23 完成。`agent-harness-budgets.test.ts` 8 用例；新增 pause_requested/pause_cleared 记录类型；sqlite 后端 87 passed。修复 no-progress 采集点交替导致永不触发的缺陷。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — Recall Catalog 持久化 + Context Manifest（确定性部分）

- Status: done
- Owner: coordinator
- Objective: RecallEntry 持久化；确定性 ID；toolsTokenEstimate 计入。
- Inputs and prerequisites: T-001 done；用户确认接管。
- Scope or files: `recall-catalog.ts`、`atomic-groups.ts`、`orchestrator.ts`、`session-integration.ts`、`agent-session.ts`、测试。
- Expected output: 重启 recall 可解析；同状态同上下文。
- Dependencies: T-001。
- Execution steps:
  1. persister + 确定性 ID + token 接线；2. 测试。
- Acceptance criteria:
  - 重启 recall 100%；确定性 ID。
- Verification method: vitest + check。
- Validation evidence: 2026-08-23 完成。JsonlRecallPersister（stateDir/recall.jsonl）；rc-<hash16> 与 g-<from>-<to>-<kind> 确定性；pinned timestamp=active.createdAt；orchestrator/host/agent-session 接线工具 token 估计。测试：recall 重启+ref 确定性、group id 确定性、token 差额 5000。遗留：每请求完整 manifest 持久化未建（存储量级决策留后续）。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Canonical Event 提交与 Projection 隔离（AgentSession 顺序修复）

- Status: done
- Owner: coordinator
- Objective: 完整 Item 先提交再通知。
- Inputs and prerequisites: T-002 done；用户确认接管。
- Scope or files: `agent-session.ts`、测试。
- Expected output: listener 抛错不阻止持久化。
- Dependencies: T-002。
- Execution steps:
  1. Red；2. 重排；3. 回归。
- Acceptance criteria:
  - 通知前已持久化。
- Verification method: vitest + check。
- Validation evidence: 2026-08-23 完成。`agent-session-canonical-persistence.test.ts`：订阅者抛错时 assistant 条目已持久化且存活。说明：listener 错误仍上抛（run 失败可见）但 canonical 已先提交；完整 Outbox/cursor 为后续独立工作。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 远程 PiServerService 参考实现

- Status: done
- Owner: coordinator
- Objective: SessionRepo+AgentHarness 实现 PiServerService；open 自动 resume；快照投影。
- Inputs and prerequisites: T-003/T-004 done；用户拍板 coding-agent→pi-server。
- Scope or files: `packages/coding-agent/src/server/harness-service.ts`、`index.ts` 导出、package.json/lock/shrinkwrap/install-lock、测试。
- Expected output: 仓库内远程会话可运行。
- Dependencies: T-003, T-004。
- Execution steps:
  1. 依赖边；2. adapter；3. 测试。
- Acceptance criteria:
  - 崩溃后 open 自动 resume 且 replay-never 不重放。
- Verification method: vitest + check。
- Validation evidence: 2026-08-23 完成。`harness-service.test.ts` 4 用例。修复真实工具 details undefined 被严格 JSON 持久层拒绝的集成 bug（driver 深剥 undefined）。遗留：跨进程 lease/长任务 handle/sandbox profile 未建；协议无 resume 命令（以 open 自动 resume 代替）。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — .edru 更新与故障注入验证

- Status: done
- Owner: coordinator
- Objective: 故障注入矩阵；.edru full rebaseline。
- Inputs and prerequisites: T-002..T-007 done；update 协议。
- Scope or files: `packages/agent/test/harness/agent-harness-faults.test.ts`、`.edru/`。
- Expected output: 矩阵绿；.edru 结构校验通过。
- Dependencies: T-002, T-003, T-004, T-005, T-006, T-007。
- Execution steps:
  1. 矩阵；2. 历史归档 + 资产更新；3. validator。
- Acceptance criteria:
  - §14 适用项有记录结果；结构校验 PASSED。
- Verification method: vitest + validate_edru_assets.py。
- Validation evidence: 2026-08-23 完成。矩阵 5 用例一次通过。run EDRU-20260823-080000（parent EDRU-20260822-175032 归档 history/）：CLM-U009/EV-U012 superseded，新增 CLM-W001..W007/EV-W001..W006（C4 测试证据），新 unknowns UNK-W001..W003。validator PASSED。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 每任务 Red→Green 定向 vitest；完成后包级全量（agent 464 passed/1 skipped；coding-agent suite+compaction+service 542 passed/8 skipped；sqlite 87 passed）。
- 全仓库 `npm run check` exit 0 且检查前后 git status 一致（无自动改写蔓延）。
- .edru：`validate_edru_assets.py .edru --operation update --mode takeover` PASSED。
- 禁真实 provider；全部模型调用经 faux/脚本化 streamFn。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-1（已应验并处理）：`npm run check`/biome 自动改写——每次检查后核对 git status，无蔓延。
- R-2（已应验并处理）：并发 session 文件交叠——先避让后由用户确认接管。
- R-3：双执行路径漂移（.edru UNK-W003/RSK-W001）——待 maintainer 收敛决策。
- R-4：远程服务部署安全（UNK-W002/RSK-W002）——部署侧责任。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 文档创建；登记 T-001..T-008 路线。
- 2026-08-23: T-001 done（Task Ledger 三缺陷）。
- 2026-08-23: 用户选方案 A；T-002 拆 T-009/T-010/T-011 并全部完成。
- 2026-08-23: T-003 done（工具网关；executeWithInfo 设计修正）。
- 2026-08-23: T-004 done（重试/预算/无进展/pause）。
- 2026-08-23: 用户指示完成剩余；T-005/T-006/T-012 因并发 session 交叠暂 blocked；T-008 矩阵部分完成。
- 2026-08-23: 用户确认接管并发文件、T-007 落点 coding-agent→pi-server。T-006、T-012、T-005、T-007 依次完成。
- 2026-08-23: T-008 .edru 刷新完成（validator PASSED）；全仓库 check exit 0。全部任务 done。
- 2026-08-23: 事故记录：一次文档更新脚本因 join 异常在 open("w") 时截断任务文档；已从会话记录完整重建并复核全部状态。教训：写前先在内存完成全部变换。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 全部 10 项任务 done（T-001、T-002[T-009/T-010/T-011]、T-003、T-004、T-005、T-006、T-007、T-008、T-012）。当前证据：packages/agent 464 passed/1 skipped；coding-agent suite+compaction+service 542 passed/8 skipped；sqlite 后端 87 passed；全仓库 `npm run check` exit 0 且无范围蔓延；.edru 结构校验 PASSED；任务文档 validator 通过。
- Limitations: 显式排除/遗留——manual drive、多 lane、hooks（YAGNI）；deferred fail-closed；model_change 未接线；driver 工具串行；自动 compaction 触发未接入 durable driver；每请求 Context Manifest 未建；Resource Key/审批通道/长任务 handle/跨进程 lease/sandbox profile 未建；双执行路径 parity/收敛未定（UNK-W003）；远程部署安全为部署侧责任（UNK-W002）；真实 provider 行为无 C4（仓库规则）。
