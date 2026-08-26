# Task Plan: Compaction single-pass handoff pipeline

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求执行“单次 source projection、单次模型总结、单次原子激活”的最佳整改方向。

<!-- task-doc-section:background-goal -->
## Background and goal

当前普通 compaction 先调用 structured extractor，再调用 handoff summarizer；两个请求都序列化同一批 `compactedEvents`。目标是让 offload 只在冻结边界内形成一次有界 source projection，以一次模型调用生成 handoff，并保持候选校验通过后才原子激活 snapshot 与 recall 数据。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`packages/coding-agent/src/core/compaction/subsystem` 内的 orchestrator、handoff summarizer、临时 structured extraction 契约及其针对性测试。

非目标：不改变触发阈值、系统提示词、工具 schema、recent tail 选择、真实供应商配置或仓库其他既有改动；不运行完整 build、完整测试或付费供应商评测，除非用户另行要求。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 普通增量压缩对同一 `compactedEvents` 先执行 `extractState`，再执行 `generateHandoff`。 | `packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts` 的 generative loop。 |
| F-002 | structured delta 只用于构造 handoff/fallback，不持久化到 snapshot。 | orchestrator happy-path 测试与 `StructuredSnapshot` v5 字段。 |
| F-003 | offload records 在最终 `publishWithOffloads` 前不会进入活动 recall catalog，snapshot 也只在同一发布回调中激活。 | `orchestrator.ts::tryPublish`。 |
| F-004 | offload 未缩小 extractor 与 handoff 的输入；两者仍接收原始 `compactedEvents`。 | `orchestrator.ts` 的 offload、extract、narrative 调用参数。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: structured facts/decisions/nextActions 没有独立持久化消费者，移除这层临时模型契约符合用户要求；影响是模型拒绝时 fallback 只依赖确定性 runtime state、prior handoff 与新事件。
- Open question: None. 用户已经授权实施目标架构；若发现外部导入该内部 extractor，则保留最小兼容边界并记录限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每次普通增量 compaction 最多发起一次 compactor 模型请求；repair 每次重试也只发起一次。
- compactor 模型输入使用 offload 后的 ref+preview 投影，不重复序列化被卸载的大型 payload。
- offload artifacts、recall catalog 与 snapshot 仍只在最终校验通过后一次性发布；失败保持旧活动 context。
- handoff injection、未落地精确值、模型错误仍被拒绝或回退到确定性 handoff。
- 针对性 compaction 测试与 `npm run check` 通过，且只保留本任务相关格式化改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；三项修改共享 orchestrator/narrative 类型与测试契约，必须串行。
- Serialization constraints: 工作区存在大量既有未提交改动；协调者独占本任务文件，逐路径核对 diff，不使用批量暂存或回滚命令。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化单次调用与投影行为

- Status: done
- Owner: coordinator
- Objective: 用回归测试明确一次 compactor 调用，以及大型已卸载 payload 不进入 handoff source packet。
- Inputs and prerequisites: F-001 至 F-004；现有 faux `CompleteFn` 测试模式。
- Scope or files: `packages/coding-agent/test/compaction-subsystem/orchestrator.test.ts`, `narrative.test.ts`。
- Expected output: 旧双调用实现下失败、目标实现下通过的调用次数与 prompt 投影断言。
- Dependencies: None.
- Execution steps:
  1. 调整 faux completion 为单一 handoff 请求。
  2. 增加一次调用和 offload ref+preview 输入断言。
- Acceptance criteria:
  - 测试能检测重复模型调用或完整大型 payload 泄漏到 compactor prompt。
- Verification method:
  - 运行目标 Vitest 文件。
- Validation evidence: 目标 Vitest 运行 19 项，新增回归按预期失败（旧实现首个 extractor 请求无法接受单一 handoff 输出），其余 18 项通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现单次 source projection 与 handoff

- Status: done
- Owner: coordinator
- Objective: 删除运行时临时 structured extraction 阶段，让 projected source packet 只进入一次 handoff 模型调用。
- Inputs and prerequisites: T-001。
- Scope or files: `orchestrator.ts`, `narrative.ts`, `rebuild.ts`, `types.ts`, `index.ts`, `state-extractor.ts` 及对应测试。
- Expected output: 单调用 compaction pipeline；无已失去消费者的 extraction 契约。
- Dependencies: T-001.
- Execution steps:
  1. 提取确定性的 offload 事件投影并复用于模型 source packet 与 token 计数。
  2. 简化 handoff 输入与 fallback，不再依赖 extractor delta。
  3. 移除未使用 extractor 模块、类型和测试导出。
- Acceptance criteria:
  - 普通 compaction 每个 attempt 只调用一次 `CompleteFn`。
  - 模型看到的巨型 payload 已替换为稳定 ref 与 preview。
  - snapshot 发布事务和 validator 边界不变。
- Verification method:
  - 运行 orchestrator、narrative、rebuild 相关目标测试。
- Validation evidence: 16 个 compaction 目标测试文件共 111 项通过；涵盖 orchestrator、narrative、rebuild、validator、auto trigger、repair/circuit breaker、shadow、session integration、durability、drift 与 faux eval。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成与静态验证

- Status: done
- Owner: coordinator
- Objective: 验证 compaction 相关行为和仓库静态检查，审计本任务 diff。
- Inputs and prerequisites: T-002。
- Scope or files: 本任务涉及的 compaction 源码、测试与任务文档。
- Expected output: 目标测试和 `npm run check` 的当前结果与边界记录。
- Dependencies: T-002.
- Execution steps:
  1. 运行目标 Vitest。
  2. 运行根 `npm run check` 并核对自动改写范围。
  3. 审查 diff 与任务文档状态。
- Acceptance criteria:
  - 目标测试通过。
  - `npm run check` 通过，或明确记录与本任务无关的既有失败。
  - 未修改任务范围外文件。
- Verification method:
  - 命令输出、`git diff --check`、显式路径 diff。
- Validation evidence: 根 `npm run check` 通过；17 个目标测试文件共 138 项通过；`git diff --check` 通过；全仓 compaction 源码与测试不再引用 `state-extractor`、`responseSchema` 或 extractor provenance。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行 orchestrator/narrative/rebuild 目标 Vitest；实现后重复运行。最后按仓库要求运行 `npm run check`，随后检查共享 worktree 是否被格式化器改写了任务范围外文件。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 删除 extractor 可能影响内部 barrel export；通过全仓 `rg` 与 TypeScript check 验证没有消费者。
- 模型输入投影会隐藏大型工具输出正文；正文仍保存在 artifact store，并通过 stable recall ref 恢复。
- `npm run check` 会写文件；运行前后记录 status，只保留本任务路径上的必要改写。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 建立执行任务文档并确认当前双模型调用、未投影 compactor 输入及原子发布边界。
- 2026-08-26: T-001 开始；协调者编写单调用与 source projection 回归。
- 2026-08-26: T-001 完成；新增回归在旧双调用实现上按预期失败。T-002 开始。
- 2026-08-26: T-002 完成；移除临时 extractor 与 responseSchema 契约，单次 projected handoff pipeline 的 16 文件 111 项目标回归通过。T-003 开始。
- 2026-08-26: T-003 完成；AgentSession 单调用回归加入后 17 文件 138 项通过，根 `npm run check` 与 `git diff --check` 通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001、T-002、T-003 全部完成；任务文档 validator、17 文件 138 项目标测试、根 `npm run check`、`git diff --check` 均通过。
- Limitations: 未运行完整 `./test.sh`、完整 build 或真实供应商评测；用户本次未要求这些高成本验证。共享 worktree 的大量既有改动未被回滚、暂存或提交。
