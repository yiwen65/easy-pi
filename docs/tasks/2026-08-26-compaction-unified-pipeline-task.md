# Task Plan: Unify compaction execution pipeline

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求按最佳实践移除 SOFT/HARD 增量压缩分支，统一为只在触发时执行的一条完整 compaction 管线。

<!-- task-doc-section:background-goal -->
## Background and goal

当前实现把同一职责拆成 `offload_only`、`soft_compact`、`hard_compact` 和 `full_rebuild` 四种动作，并用 snapshot kind、连续增量次数及 70%/85% 两档执行策略维持分支。目标是收敛为 `none | compact`：未触发时不改变 provider context；触发后冻结边界、从 raw events 重放确定性状态、外置大型 payload、用有界增量生成 handoff、依据目标请求预算选择最大安全 recent tail，经完整校验后一次原子激活。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`packages/coding-agent/src/core/compaction/subsystem` 的 trigger、orchestrator、rebuild、session host、snapshot 元数据，以及 `AgentSession` 接线、`/context` 展示和直接受影响测试。

非目标：不改变 system prompt 或工具 schema；不在 compaction 未触发时重写 active context；不恢复已删除的 contract、task/tool ledger、structured extraction；不修改仓库其他既有改动；不运行真实供应商评测、完整 build 或完整测试，除非用户另行要求。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 自动门当前以手动请求、预计请求超过 70%/85% 或上次 overflow 打开；策略层再选择四种动作。 | `packages/coding-agent/src/core/compaction/subsystem/trigger.ts`。 |
| F-002 | HARD 与 SOFT 的执行差异仅是 `keepRecentTokens` 是否减半；FULL_REBUILD 则走 raw rebuild。 | `packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts:237-240,319-330`。 |
| F-003 | raw rebuild 的确定性状态从 raw event log 完整 reduce；handoff 只合并 prior handoff 与新覆盖事件。 | `packages/coding-agent/src/core/compaction/subsystem/rebuild.ts:40-125`。 |
| F-004 | feature mode、snapshot kind、连续增量计数和 action 名称继续把已无必要的策略暴露到运行时与 `/context`。 | `session-integration.ts`, `types.ts`, `agent-session.ts`, `interactive-mode.ts` 的引用。 |
| F-005 | 工作区存在大量与本任务无关的既有修改。 | `git status --short`；本任务按显式路径编辑和核对 diff。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 70% 继续作为单一自动触发阈值；overflow 绕过 cooldown。影响是移除 85% 这一执行模式分界，但不削弱 overflow 恢复入口。
- Assumption: 动态 recent-tail 预算以配置的 `keepRecentTokens` 为上限，以目标请求 token 预算所需降幅为下限；原子组可能使实际 tail 小于计算值，最终以真实 next-request 重计和 validator 为准。
- Open question: None。用户已明确授权移除这些策略分支，仓库规则不要求保留向后兼容。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `TriggerAction` 仅包含 `none | compact`，TriggerInput 不再携带 offload、SOFT/HARD、drift 或增量次数策略字段。
- `PI_HF_COMPACTION` 运行模式仅保留 `off | shadow | full_pipeline`；offload 与 handoff 是统一管线的内部阶段。
- 每次成功 compact 的确定性 snapshot 均来自 frozen raw events 重放；模型 handoff 只接收 prior handoff 与 offload 后的新覆盖投影。
- recent tail 预算由目标请求预算动态计算，并受配置上限约束，不再使用固定减半策略。
- snapshot 与 `/context` 不再暴露恒定且无区分度的 compaction kind。
- 候选仍在真实 next-request 重计、validator 通过后一次性发布；失败保持旧 active context。
- 针对性 Vitest 与 `npm run check` 通过，且不覆盖无关工作区改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无；生产契约、运行时接线和测试共享同一 action/type，必须串行迁移。
- Serialization constraints: 协调者独占本任务文件；不使用 stash/reset/checkout/批量暂存；`npm run check` 后逐路径检查自动格式化影响。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化单一触发契约

- Status: done
- Owner: coordinator
- Objective: 将纯策略收敛为单一触发阈值和 `none | compact`，用测试锁定 manual、threshold、cooldown、overflow 行为。
- Inputs and prerequisites: F-001；70% 单阈值与 overflow 恢复假设。
- Scope or files: `trigger.ts`, `trigger.test.ts`。
- Expected output: 无 SOFT/HARD/offload/rebuild 策略字段的最小触发契约。
- Dependencies: None.
- Execution steps:
  1. 重写 TriggerInput/Decision 与 evaluateTriggers。
  2. 更新纯策略回归，确认维护信号不再存在于触发契约。
- Acceptance criteria:
  - 仅真实压力、manual 或 overflow 返回 `compact`；冷却只抑制普通阈值触发。
- Verification method:
  - 运行 `trigger.test.ts`。
- Validation evidence: `trigger.test.ts` 7/7 通过；确认唯一 action、单阈值、manual、cooldown、窗口溢出与 overflow 恢复行为。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 统一完整 compaction 管线

- Status: done
- Owner: coordinator
- Objective: 删除执行分支，始终执行 raw replay、offload、projected bounded handoff、验证和原子发布。
- Inputs and prerequisites: T-001；F-002、F-003。
- Scope or files: `orchestrator.ts`, `rebuild.ts`, `types.ts`, `validator.ts` 及对应单元测试。
- Expected output: 一个 `compact` 入口；无 offload-only、incremental/rebuild kind 或 repair-to-rebuild 分支。
- Dependencies: T-001.
- Execution steps:
  1. 计算动态 tail 上限并形成 safe cut。
  2. 对 live tail 执行 offload，并把 ref+preview 投影传入 raw rebuild handoff。
  3. 对候选执行真实 next-request 重计、validator 和原子发布。
- Acceptance criteria:
  - 成功 snapshot 的 deterministic state 等价于 frozen raw event reduce；大型 payload 不进入模型 handoff prompt。
- Verification method:
  - 运行 orchestrator、rebuild、validator 针对性测试。
- Validation evidence: `orchestrator.test.ts`、`rebuild.test.ts`、`validator.test.ts` 共 33/33 通过；覆盖动态 tail、full replay、offload projection、模型失败 fallback、验证失败和原子发布。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 收敛运行时和观察面

- Status: done
- Owner: coordinator
- Objective: 让 AgentSession、host、feature mode 与 `/context` 只表达统一 compact 行为。
- Inputs and prerequisites: T-002；F-004。
- Scope or files: `session-integration.ts`, `agent-session.ts`, `interactive-mode.ts` 及直接受影响测试。
- Expected output: 无旧 action/mode/count/kind 的生产引用和一致的自动、手动 compact 接线。
- Dependencies: T-002.
- Execution steps:
  1. 删除旧 feature modes、snapshot kind 与连续增量统计。
  2. 传递目标请求预算到 orchestrator。
  3. 更新 summary、inspection 与 faux runtime fixtures。
- Acceptance criteria:
  - `rg` 在生产代码中找不到已退休 action/mode/strategy 字段；手动和自动路径均调用 `compact`。
- Verification method:
  - 运行 session integration、auto-trigger、context command 与 AgentSession 回归。
- Validation evidence: 18 个目标测试文件 140/140 通过；`tsgo --noEmit` 通过；生产 `rg` 无旧 action/mode/count/kind 引用。工具续接回归确认 cut=0 的统一 offload 事务不会吞掉当前原子 tail。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证和差异审查

- Status: done
- Owner: coordinator
- Objective: 验证单一管线的类型、格式、核心回归和工作区隔离。
- Inputs and prerequisites: T-003。
- Scope or files: 本任务修改的生产、测试与任务文档。
- Expected output: 目标测试和 `npm run check` 通过，最终 diff 可追溯。
- Dependencies: T-003.
- Execution steps:
  1. 运行受影响测试集合。
  2. 运行 `npm run check` 并核对自动写入。
  3. 对最终 diff 做反例审查并验证任务文档。
- Acceptance criteria:
  - 所有验收项有实际证据；无本任务外新增修改。
- Verification method:
  - 目标 Vitest、`npm run check`、`git diff --check`、精确 `git diff`。
- Validation evidence: compaction/AgentSession 回归 36 文件 295/295 通过；`npm run check` 通过且 Biome 未产生额外修改；`git diff --check` 通过。当前行为文档已收敛到 `off|shadow|full_pipeline`，显式旧值或拼写错误会 fail fast，不再静默启用默认管线。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001: `trigger.test.ts` 验证单阈值、manual、cooldown、overflow。
- V-002: `orchestrator.test.ts` 与 `rebuild.test.ts` 验证 full raw replay、动态 cut、offload projection 和原子发布。
- V-003: session/AgentSession/context 针对性测试验证真实接线。
- V-004: `npm run check` 验证仓库静态检查；按规则不运行完整 build 或完整测试。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 原子组可能阻止精确达到目标预算：保留 validator fail-closed，并在审计中记录计划 tail 与真实 tokensAfter。
- handoff 输出长度在 cut 前未知：使用目标降幅和现有 tail 估算动态预算，最后用完整 next-request 重计兜底。
- raw replay 随历史线性增长：只在 compaction 门打开时运行；不在普通 provider turn 做维护性重放。
- 工作区高度脏：任何格式化产生的无关变化都必须识别并保留，不回滚他人修改。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 创建 execute 任务文档；确认生产路径与旧策略引用，T-001 开始。
- 2026-08-26: T-001 完成；`trigger.test.ts` 6/6 通过。T-002 开始。
- 2026-08-26: T-002 完成；3 个核心测试文件 33/33 通过。T-003 开始。
- 2026-08-26: T-003 完成；18 个目标测试文件 140/140 通过，`tsgo --noEmit` 通过。T-004 开始。
- 2026-08-26: T-004 完成；36 个 compaction/AgentSession 测试文件 295/295 通过；`npm run check` 与 `git diff --check` 通过；同步当前配置与 rollout 文档。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 单一 `none|compact` 触发契约、统一 raw replay/offload/handoff/validation/CAS 管线、运行时接线和配置文档均已实施；36 文件 295/295 回归通过；仓库静态检查与差异空白检查通过。
- Limitations: 按本任务范围和仓库规则未运行真实供应商评测、完整 build 或完整 `npm test`；这些属于独立、成本更高的验证层，不影响本次定向回归与静态验收结论。
