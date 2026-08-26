# Task Plan: 收敛 Compaction Snapshot 契约

- Created: 2026-08-25
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求“执行最佳实践整改”，承接当前会话中对未投影 snapshot 字段的审查结论。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 `StructuredSnapshot` 同时持久化 handoff、累计模型语义数组、运行时状态和审计元数据。目标是让 handoff 成为唯一持久语义连续层，将 snapshot 收敛为可重建、可验证的最小运行时控制状态，并保证 full rebuild 后任务语义仍对 provider 可见。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- In scope: `packages/coding-agent/src/core/compaction/subsystem` 的 snapshot schema、抽取 delta、handoff、rebuild、投影、校验、存储及对应单元/集成测试。
- In scope: 删除无必要的持久字段，更新 schema 版本，验证旧 schema fail closed 到 raw rebuild。
- Non-goals: 不删除 raw event log、recall catalog、运行时 tools/errors/artifacts；不改变正常未触发 compaction 时的 provider context；不调用真实付费供应商；不提交 Git。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | provider 投影只消费 handoff、未完成 tools 和未解决 errors；不会投影 facts/decisions/nextActions/artifacts/recall refs | `subsystem/prompt-builder.ts` 的 `projectSnapshot()` 与 `buildPrompt()` |
| F-002 | facts/decisions/nextActions 当前跨版本累计，并作为下一轮 handoff 输入 | `subsystem/state-extractor.ts` 的 merge；`subsystem/orchestrator.ts` 的 `priorSnapshot` 传递 |
| F-003 | full rebuild 当前依赖 active handoff 和累计语义数组构造确定性 handoff | `subsystem/rebuild.ts` |
| F-004 | `lineage` 未发现运行时读取者，版本遍历已有 `parentVersion`；`validatorReport` 只在发布时嵌入 snapshot | `subsystem/snapshot-store.ts`、`subsystem/orchestrator.ts` |
| F-005 | `sourceEventRanges` 的唯一投影排序消费者以 `seq:N` 匹配 event id，键空间不一致 | `subsystem/prompt-builder.ts` 的 `sourceOrder()` |
| F-006 | 工作树存在大量既有未提交修改，包含本次目标文件 | `git status --short`（2026-08-25） |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 当前 active handoff 已经过激活前验证，可作为 rebuild 的语义连续来源；若没有 active handoff，则 raw event log 是唯一语义真相。
- Assumption: snapshot schema 可直接 bump；仓库规则明确不要求向后兼容，旧 schema 将被忽略并走 raw rebuild。
- Open question: 无阻塞问题。真实供应商质量不在本次授权范围，以 faux provider 和确定性回归验证结构与连续性。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `StructuredSnapshot` 不再持久化 `lineage`、`facts`、`decisions`、`nextActions`、`sourceEventRanges`、`validatorReport`。
- 抽取器只产生当前覆盖区间的有界 semantic delta，不再读取或合并 prior snapshot 语义数组。
- incremental compaction 将 `prior handoff + 当前 delta + 新事件` 合并为新 handoff。
- full rebuild 保留已激活 handoff；无 active handoff 时从 raw covered events 生成有界确定性连续信息，不能退化为空白或无意义 ID。
- 未触发 compaction 的 passthrough 行为不变。
- snapshot、rebuild、prompt、orchestrator、validator 的针对性测试通过；`npm run check` 通过或只剩可证明的仓库既有问题。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；schema、生产实现与测试共享同一契约，顺序执行避免并发冲突。
- Serialization constraints: `types.ts` 的 schema 变更必须先于所有生产消费者和测试夹具更新。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化目标契约和回归边界

- Status: done
- Owner: coordinator
- Objective: 基于真实消费者确定删除/保留字段，并定义连续性与有界增长回归。
- Inputs and prerequisites: 当前源码、测试、AGENTS.md、相关 LEARNS.md。
- Scope or files: 本任务文档；compaction subsystem 源码与测试只读检查。
- Expected output: 可执行字段迁移表、schema bump 和测试边界。
- Dependencies: None.
- Execution steps:
  1. 核对所有候选字段的读取者和写入者。
  2. 确定迁移顺序与行为不变量。
- Acceptance criteria:
  - 每个删除字段均无不可替代持久职责，或已有明确替代路径。
- Verification method:
  - `rg` 消费者扫描；任务文档 validator。
- Validation evidence: `rg` 完成生产/测试消费者扫描；任务文档 validator 通过；确认保留 `parentVersion/baseEventSeq/handoff/tools/artifacts/errors/recallCatalogRefs`，删除六个冗余持久字段。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施 snapshot 最小契约

- Status: done
- Owner: coordinator
- Objective: 删除冗余持久字段，将语义累计改成仅本轮 delta，并修复 rebuild/fallback 连续性。
- Inputs and prerequisites: T-001 done。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/*.ts` 及直接受影响测试。
- Expected output: 当前 schema 的生产代码与夹具一致，handoff 为唯一持久语义层。
- Dependencies: T-001.
- Execution steps:
  1. 先更新针对性测试，覆盖字段消失、delta 不累计和 rebuild handoff。
  2. 更新 schema、提取、handoff、rebuild、orchestrator、validator、snapshot store 和 prompt builder。
  3. 清理仅因本次变更失效的类型、导入和断言。
- Acceptance criteria:
  - 所有目标字段从 durable snapshot 类型和发布 JSON 中消失。
  - prior handoff 在 incremental/rebuild 后保留或被语义合并。
  - deterministic fallback 输出 decision text，不输出无意义 decision id。
- Verification method:
  - 运行受影响 compaction Vitest 文件。
- Validation evidence: schema v5 与所有生产消费者已更新；11 个核心测试文件 104/104 通过；full rebuild 自动触发回归 19/19 通过并证明第九次 rebuild 后 marker 同时存在于 active handoff 和 provider messages；6 个 session/eval/schema 测试文件 22/22 通过；`tsgo --noEmit` 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成验证与差异审计

- Status: done
- Owner: coordinator
- Objective: 验证目标架构、静态质量与未触发路径不变，并审计只包含本任务增量。
- Inputs and prerequisites: T-002 done。
- Scope or files: 受影响测试、`npm run check`、Git diff。
- Expected output: 可复现验证证据和残余风险。
- Dependencies: T-002.
- Execution steps:
  1. 跑针对性回归与必要的 compaction 集成测试。
  2. 跑 `npm run check`，并在执行后核对其自动改写范围。
  3. 检查 schema 字段残留、diff 和工作树边界。
- Acceptance criteria:
  - 目标测试通过。
  - 无本次引入的类型、lint 或格式错误。
  - 未覆盖风险有明确说明。
- Verification method:
  - Vitest、`npm run check`、`git diff -- <owned paths>`、`rg`。
- Validation evidence: 格式化后的合并回归为 18 个文件、145/145 tests passed；完整 `npm run check` 通过（Biome、依赖固定、TS import、shrinkwrap/install lock、tsgo、browser smoke）；目标路径 `git diff --check` 通过；`rg` 确认 durable snapshot 不再引用 `lineage/sourceEventRanges/validatorReport/facts/decisions/nextActions`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

优先运行 `state-extractor.test.ts`、`narrative.test.ts`、`rebuild.test.ts`、`prompt-builder.test.ts`、`snapshot-store.test.ts`、`validator.test.ts`、`orchestrator.test.ts`，再补覆盖自动 full rebuild/provider projection 的现有集成测试。最后运行 `npm run check`，并检查它是否改写无关文件。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 既有 dirty changes 与本次文件重叠：只做小块补丁，完成后用基线 diff 和路径级 diff 审计。
- 删除累计数组后模型 handoff 成为唯一语义压缩层：必须验证 model rejection/fallback 与 full rebuild。
- 旧 v4 snapshot 会被当前 schema 忽略：这是预期 fail-closed 行为，但会触发一次 raw rebuild。
- 真实模型的摘要质量未验证；本次不调用付费供应商。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: 创建 execute 模式任务文档。
- 2026-08-25: 完成消费者扫描，T-001 开始；确认任务图因共享 schema 必须串行执行。
- 2026-08-25: T-001 完成；字段迁移与 full rebuild 连续性边界已固化。T-002 开始。
- 2026-08-25: T-002 完成；snapshot schema v5、临时 semantic delta、model-assisted rebuild handoff 和回归已落地。T-003 开始。
- 2026-08-25: T-003 完成；145 项合并回归与完整 `npm run check` 通过。逆向审查确认 tools/artifacts/errors 是 deterministic checkpoint 控制状态，未做会破坏 full-replay 等价性的过度裁剪。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001、T-002、T-003 全部 done；任务文档 validator、18 文件 145 tests、`npm run check`、`git diff --check` 和删除字段残留扫描通过。
- Limitations: 未调用真实供应商，未运行完整 build 或完整 `npm test`；工作树已有大量与本任务重叠的未提交修改，本次没有提交 Git。
