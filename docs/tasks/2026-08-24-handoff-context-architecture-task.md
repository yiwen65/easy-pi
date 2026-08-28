# Task Plan: Handoff-first context architecture

- Created: 2026-08-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求废弃当前 contract 机制，以 handoff 总结作为主要连续性上下文，并授权实施改造；随后明确要求删除无实际执行价值的 Task Ledger，并追加授权真实供应商评测、完整 build 和完整 `npm test`。

<!-- task-doc-section:background-goal -->
## Background and goal

当前高保真 compaction 将 `TaskContract` 作为永不压缩的固定层，并同时把全局 contract、当前焦点任务 contract、跨任务约束和待确认目标变更投影到 provider system prompt。该设计把目标理解、验收条件、权限、预算、版本和审批生命周期绑定在同一机制中，导致普通语义演进也表现为 contract proposal/version 更新。目标是移除运行时 `TaskContract`/proposal/approve 权威链，让增量更新的 handoff 成为主要工作语义；原始事件仍是真相来源，确定性 snapshot 仍裁决工具、错误和完成状态，最新可信用户指令以小型、自动派生的只读投影补充 handoff，但不恢复手工 contract 生命周期。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- 移除 `packages/coding-agent` compaction 运行路径中的 `TaskContract`、`ContractStore`、proposal/approve 和 `contractRef`。
- 以自动合并 prior summary 与新增事件的 `HandoffSummary` 作为主要语义连续性层。
- 从可信用户事件自动构建有界 user-directive 投影；它不创建权限，只保留来源和冲突优先级。
- 保留 raw event log、typed runtime state、recent tail、recall、CAS 和 fail-closed 校验。
- 更新 prompt zone、context inspection、公开 session API/命令、持久化恢复和相关测试。
- 对旧 snapshot/contract 数据采用 schema bump 后 raw-rebuild/fail-closed 路径，不维护双写兼容层。
- 删除 Task Ledger、Goal Interpreter、task reconciliation、Tool Ledger、snapshot runtime `tasks`、snapshot branch binding、snapshot CAS 和相关 API、配置、事件与测试。
- 保留 session 原始事件、handoff/directives、recent tail/recall 和单一 active snapshot 的最小持久化；compaction 不再维护第二套任务/工具生命周期或并发版本协议。

Non-goals:

- 不修改 `packages/agent` harness 架构、非 compaction provider API 或无关 TUI。
- 不运行 release 流程；真实供应商 API、完整 build 和完整 `npm test` 已由用户在 T-013 至 T-015 明确授权。
- 不提交 Git；除非用户另行明确要求。
- 不把 handoff 提升为权限、工具结果、完成状态或副作用事实的唯一权威。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | `TaskContract` 当前是 schema v1 固定层，含 goal、acceptance、constraints、permissions、budgets、authority、provenance、版本有效期和 allowed updaters。 | `packages/coding-agent/src/core/compaction/subsystem/types.ts:43-103` |
| F-002 | `ContractStore` 对更新采用 proposal/approve/version 机制；verified local user 的显式 update 实际会立即自动批准。 | `task-contract.ts:28-40`; `session-integration.ts:359-371` |
| F-003 | 模型归纳的 goal 被写为 `derivedGoal.confirmed=false`，之后 `/contract confirm` 再提升为权威 goal。 | `session-integration.ts:382-465` |
| F-004 | 当前 provider 固定层由 global contract、focus task contract、其他任务索引和 pending goal changes 组成，并动态注入 system prompt。 | `prompt-builder.ts:149-300`; `agent-session.ts:756-779` |
| F-005 | 当前 handoff/narrative 已支持合并 prior narrative 与新增事件，并有 exact-value、completion 和 injection 校验。 | `narrative.ts:84-279`; `narrative.test.ts:64-102` |
| F-006 | raw event log、typed snapshot、recent tail 和 recall 已独立存在，因此删除 contract 不要求把 handoff 变成确定性事实存储。 | `types.ts`; `orchestrator.ts`; `prompt-builder.ts` |
| F-007 | worktree 有大量其他会话改动，且 compaction 文件中已有本会话前序未提交修改，必须基于当前内容做窄范围集成。 | 2026-08-24 `git status --short` |
| F-008 | Task Ledger 在生产中仅由首条用户消息自动创建 task，`permissions` 默认为空；`interpretGoalChange()` 没有生产调用，Task Ledger 权限不参与工具 dispatch。 | `session-integration.ts:582-590`; `task-ledger.ts:305`; `rg interpretGoalChange packages/coding-agent/src` |
| F-009 | Task Ledger 仍污染 snapshot schema、orchestrator/validator CAS、branch restore、reconciliation 内部调用和公开 host API，但这些能力不承担 raw event、Tool Ledger 或 snapshot CAS 的必要职责。 | `types.ts:269-277`; `orchestrator.ts:186-234`; `validator.ts:130-163`; `session-integration.ts:193-470` |
| F-010 | 用户进一步明确 Tool Ledger、snapshot runtime `tasks`、branch binding 和 snapshot CAS 也不需要；目标不是为 Task Ledger 寻找替代锚点，而是删除整套 compaction ledger/CAS 投影。 | 2026-08-24 用户指令 |
| F-011 | 用户明确要求运行真实供应商评测、完整 build 和完整 `npm test`，覆盖仓库默认限制所需的额外授权。 | 2026-08-24 用户指令；`AGENTS.md` Commands |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户所说“以 handoff 总结为准”指 handoff 是主要语义工作上下文，而不是允许模型摘要覆盖系统规则、用户权限、工具结果或确定性完成状态；否则会产生权限和事实漂移。验证方式是按上一轮已确认的目标分层实现，并让冲突测试证明 typed state/raw user events 优先。
- Assumption: 不要求保留 `/contract`、`setTaskContract` 等旧 API 的向后兼容；仓库规则明确默认不保留兼容层。影响是这是 breaking internal/public API change，需要同步导出和测试。
- Decision: 用户已否定先前“暂时保留 Task Ledger”的假设；Task Ledger 及其 Goal Interpreter/reconciliation/ref/CAS 整体删除，不保留兼容导出或空壳。
- Decision: 用户已明确连同 `StructuredSnapshot.tasks`、Tool Ledger、snapshot branch binding 和 snapshot CAS 一并删除；不再将这些机制列为 Task Ledger 删除的保护边界。
- Assumption: “分支绑定不需要”限定于 compaction snapshot 的 branch ref/祖先选择/drift 校验，不删除 SessionManager 自身的分支树或当前分支条目选择；compaction 仍只总结调用方给出的当前可见 entries。
- Assumption: “snapshot CAS 不需要”意味着 active snapshot 可由串行 compaction 直接替换；不再报告或重试 snapshot version conflict，并由宿主 single-flight 阻止同 session 并发发布。
- Decision: 删除 CAS 后不接受无约束的并发覆盖；AgentSession 对每个 session 实施 compaction single-flight，snapshot store 提供一次性 `publishActive`，写入失败时旧 active 与 live messages 保持不变。
- Decision: snapshot 不再保存 branch ref，也不做祖先快照选择。为避免 sibling handoff 泄漏，host 首次同步清空已加载 active；后续仅当旧 path 不是新 path 的前缀（rewind/sibling switch）时清空，普通 append 保留 active/tail。这会主动放弃跨重启/切分支复用，而不是引入另一种持久 branch contract。
- Open question: None. 当前目标、权限和验收边界足以开始执行。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 生产 compaction 请求不再构建或注入 `[contract]`/`Task Contract`/`Global Contract` zone。
- `TaskContract`、`ContractStore`、proposal/approve、`derivedGoal` 和 `/contract confirm` 不再位于活动 coding-agent compaction 路径；不保留静默双写。
- 活跃上下文顺序为 system → user directives → handoff → runtime snapshot → recall guide → recent tail/current input/recall，并参与完整 token accounting。
- handoff 自动合并上一版摘要与新增覆盖事件，无需人工批准；最新可信用户消息和确定性 runtime state 在冲突时优先。
- snapshot schema 不再要求 `contractRef`；旧 schema 不能被误读为当前状态，并可通过 raw events fail closed 重建。
- `/context inspect` 显示新 zones，且默认不泄露 system/tools。
- 生产源码和 snapshot schema 不再包含 TaskLedger、taskLedgerRef、Goal Interpreter、task reconciliation、ToolLedger、snapshot runtime `tasks`、snapshot branch ref 或 snapshot CAS；旧 ledger/task-update 事件可作为未知历史留在 raw log，但不再被重放或投影。
- handoff/directive、recent tail/recall、raw rebuild 和单一 active snapshot 继续工作；session 分支管理仍由 SessionManager 负责，但 compaction snapshot 不保存或校验分支身份。
- 同一 session 的 compaction 是 single-flight；snapshot 通过一次 `publishActive` 生效，持久化失败不改变旧 active 或 live messages；首次加载及 rewind/sibling 导航清空无法证明来源兼容的 active snapshot，普通 path append 不清空。
- 相关单元、集成和 compaction 聚合测试通过；根 `npm run check` 通过且自动改写范围已核对。
- 根 `npm run build`、根 `npm test` 全部通过；两个显式 opt-in 的 real-provider compaction eval 文件实际运行且报告至少一个 activated round、无 hard-gate 失败。若外部 provider/auth/network 阻塞，必须记录精确可复现证据，不能把 skip 当通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001, T-002, T-003 → {T-004, T-009}; T-004, T-009 → {T-005, T-006, T-007} → T-008 → T-010 → {T-011, T-012 dedicated-test deletion}; T-011 → T-012 API-dependent migration/final validation → T-013 → T-014 → T-015.
- Parallel batches: Batch A = T-001/T-002/T-003（只读、边界独立）；Batch A2 = T-004/T-009（核心类型与新 directive 模块文件不重叠）；Batch B = T-005/T-006/T-007（仅在前置稳定后且文件所有权无重叠时并行）；Batch C = T-008（串行集成验证）；Batch D = T-010（删除边界审计）→ T-011（生产删除）→ T-012（测试迁移和最终集成）；Batch E = T-013/T-014/T-015 串行执行，避免 build 产物、完整测试与付费 provider 调用相互干扰。
- Serialization constraints: `types.ts`、snapshot schema、`prompt-builder.ts`、`session-integration.ts` 和 task document 由 coordinator 串行集成；其他 agent 不得编辑任务文档。共享测试 fixture 或相同源文件的修改不得并行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 映射 contract 的生产依赖与删除边界

- Status: done
- Owner: subagent:contract-production-map
- Objective: 找出生产路径中所有 `TaskContract`、ContractStore、contractRef 和 contract projection 依赖，并区分必须替换与可直接删除部分。
- Inputs and prerequisites: F-001 至 F-007；当前 dirty worktree。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/**`，只读。
- Expected output: 按文件和调用链组织的删除/替换清单，含 schema/rebuild 风险。
- Dependencies: None.
- Execution steps:
  1. 追踪类型、存储、orchestrator、validator、rebuild 和 prompt 调用链。
  2. 标出可并行实现边界与共享文件。
- Acceptance criteria:
  - 清单覆盖所有 production `TaskContract`/`contractRef` 引用。
- Verification method:
  - `rg` 结果与调用点逐项核对。
- Validation evidence: 子代理只读追踪覆盖 `TaskContract`/ContractStore/contractRef/prompt/orchestrator/validator/rebuild/snapshot/eval 全部生产引用；确认 event 与 snapshot schema 版本必须拆分，并保留 task-ledger/branch CAS。未修改文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 映射公开 API、命令和测试影响

- Status: done
- Owner: subagent:contract-api-map
- Objective: 查清 `/contract` 命令、AgentSession API、RPC/导出和测试中依赖 contract 的用户可见行为。
- Inputs and prerequisites: F-001 至 F-007。
- Scope or files: `agent-session.ts`、interactive/RPC mode、`src/index.ts`、compaction tests，只读。
- Expected output: API/命令移除或替换清单和必须更新的回归集合。
- Dependencies: None.
- Execution steps:
  1. 追踪 public methods、commands 和 exports。
  2. 将测试分为删除、改写、保留三类。
- Acceptance criteria:
  - 所有用户可见 contract 入口都有明确处理决定。
- Verification method:
  - `rg` 与测试调用点核对。
- Validation evidence: 子代理只读追踪 `/contract`、AgentSession、RPC、exports、README 与测试入口；识别 extension user-role 不能仅凭 role 升级为 verified directive，以及 goal interpreter 对 queue/faux 调用顺序的邻接风险。未修改文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 定义 handoff-first 投影与安全不变量

- Status: done
- Owner: subagent:handoff-projection-design
- Objective: 基于现有 narrative、event log、snapshot 和 recall 设计最小 user-directive/handoff/runtime-state 投影及冲突优先级。
- Inputs and prerequisites: F-004 至 F-006；用户确认的目标架构。
- Scope or files: `narrative.ts`、`prompt-builder.ts`、`state-extractor.ts`、相关测试，只读。
- Expected output: 具体输入输出结构、预算、grounding 和失败回退要求。
- Dependencies: None.
- Execution steps:
  1. 验证 handoff 能承担语义连续性的现有能力和缺口。
  2. 定义 user directives 的自动派生、预算和冲突语义。
- Acceptance criteria:
  - 设计不会让模型摘要创造权限、完成或副作用事实。
- Verification method:
  - 用反例审查权限漂移、目标漂移和摘要遗漏。
- Validation evidence: 子代理完成反例审查并给出 `userDirectives(2048) → handoff(4096) → runtimeSnapshot(12288)` 的有界 system 固定层、逐项 provenance、领域化冲突优先级和 schema v1 fail-closed 要求。未修改文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 实现有界 verified-user directive 投影

- Status: done
- Owner: subagent:user-directive-projection
- Objective: 从已给定的 branch-visible events 中确定性选择、校验和渲染完整 verified-user 消息，形成硬预算 userDirectives zone 输入。
- Inputs and prerequisites: T-003 完成；EventEnvelope 已携带 authority、seq、eventId、payloadHash。
- Scope or files: 新建 `packages/coding-agent/src/core/compaction/subsystem/user-directives.ts` 和 `packages/coding-agent/test/compaction-subsystem/user-directives.test.ts`；不得修改其他文件或任务文档。
- Expected output: 支持可信筛选、recent-tail 去重、文本去重、原子预算、protected overflow fail-closed 和来源 ref 的独立模块及测试。
- Dependencies: T-003.
- Execution steps:
  1. 先写可信/不可信、去重和预算失败测试。
  2. 实现最小无状态投影函数并运行目标测试。
- Acceptance criteria:
  - 不可信、非 user、control 和被 recent tail 覆盖的事件不进入 directive 文本。
  - 消息不被截断；保护项超预算时抛错；结果按 seq 正序并保留 eventId/hash。
- Verification method:
  - 目标 Vitest `user-directives.test.ts`。
- Validation evidence: 子代理先红（模块不存在）后绿；目标 Vitest 5/5 通过，目标 Biome 和 `git diff --check` 通过。coordinator 复跑 `user-directives.test.ts` 与 `schema-v2.test.ts` 共 6/6 通过并审阅实现。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 替换核心 schema 与固定层模型

- Status: done
- Owner: coordinator
- Objective: 移除 TaskContract/contractRef 核心依赖，定义 handoff-first 输入和 user-directive 投影所需类型及 schema 演进。
- Inputs and prerequisites: T-001、T-002、T-003 完成。
- Scope or files: `types.ts`、新 directive 模块、schema/version、核心 exports。
- Expected output: 无 contract 的核心类型和可 fail-closed 读取策略。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 先增加失败测试锁定新 schema 和 zone。
  2. 修改类型与核心模块，删除过时导出。
- Acceptance criteria:
  - 新代码不以 TaskContract 作为 compaction 前置条件。
- Verification method:
  - 目标 Vitest 和 TypeScript check。
- Validation evidence: `schema-v2.test.ts` 先因缺少新常量失败，增加独立 `EVENT_SCHEMA_VERSION=1`、`SNAPSHOT_SCHEMA_VERSION=2` 后 1/1 通过；核心类型已删除 TaskContract/contractRef/constraints，TokenStats 和 budgets 改为 directives/handoff，event log 固定使用 event schema v1。下游编译修复属于 T-005/T-006/T-007。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 实现 handoff-first prompt 和 narrative

- Status: done
- Owner: subagent:handoff-prompt
- Objective: 让 handoff 成为主要语义层，并加入有界可信用户指令和 runtime snapshot 投影。
- Inputs and prerequisites: T-004、T-009。
- Scope or files: `narrative.ts`、`prompt-builder.ts`、对应测试。
- Expected output: 新 zone 顺序、预算、增量 handoff 和冲突优先级。
- Dependencies: T-004, T-009.
- Execution steps:
  1. 写 projection/narrative 回归。
  2. 实现并验证 token accounting。
- Acceptance criteria:
  - 无 `[contract]` zone；handoff 合并与 fail-closed 校验通过。
- Verification method:
  - narrative、prompt-builder、scale 测试。
- Validation evidence: 子代理以缺失新 API/zone 的 20 项失败作为红灯，完成 deterministic/model handoff、grounding/conflict 检查和 `directives → handoff → snapshot` prompt zone 后 30/30 通过；coordinator 复跑 `narrative.test.ts`、`prompt-builder.test.ts`、`scale.test.ts` 共 30/30 通过，并审阅 handoff 失败由 orchestrator 使用 deterministic fallback 收口的接口约束。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 改造 session 接线和用户入口

- Status: done
- Owner: subagent:session-contract-removal
- Objective: 从 AgentSession/HfCompactionHost/UI/RPC 移除 contract 生命周期和命令，动态注入新 directive/handoff 层。
- Inputs and prerequisites: T-004、T-009。
- Scope or files: `session-integration.ts`、`agent-session.ts`、interactive/RPC mode、公开导出及对应测试。
- Expected output: 无 `/contract` 审批路径的运行时接线。
- Dependencies: T-004, T-009.
- Execution steps:
  1. 删除 contract API/命令和 system prompt 注入。
  2. 接入新 projection 并更新 inspection。
- Acceptance criteria:
  - 普通 handoff 更新不需确认，且用户指令仍高于 handoff。
- Verification method:
  - session、command、context inspection、queue/extension 目标测试。
- Validation evidence: 删除 ContractStore 生命周期、AgentSession contract/derived-goal API、`/contract`、RPC 入口，并将 snapshot directive refs 以 branch/seq/hash fail-closed 校验后注入 dynamic system prompt；session/context/durability/recall/reconciliation 24/24、最终定向集 25/25、prompt/queue/concurrency/retry/extensions/RPC 邻接 52 passed + 8 skipped，限定 Biome 与 `git diff --check` 通过。根 check 的 TypeScript 阶段仅剩 T-007 与旧 contract 测试迁移错误，无 T-006 生产文件报错。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 改造 orchestrator、恢复和校验链

- Status: done
- Owner: subagent:compaction-schema-integration
- Objective: 删除 orchestrator/extractor/validator/rebuild/eval 的 contractRef 和 contract 前置条件，保留 raw rebuild、CAS 和确定性事实校验。
- Inputs and prerequisites: T-004、T-009。
- Scope or files: `orchestrator.ts`、`state-extractor.ts`、`validator.ts`、`rebuild.ts`、reducer/eval 及对应测试。
- Expected output: 无 contract 的 candidate/activation/rebuild 链。
- Dependencies: T-004, T-009.
- Execution steps:
  1. 更新 snapshot 候选与 validator。
  2. 更新 rebuild/eval 和 schema 拒绝测试。
- Acceptance criteria:
  - 旧 contract snapshot 不会被误激活；raw events 可重建当前 schema。
- Verification method:
  - orchestrator、validator、rebuild、failure-mode、eval 单元测试。
- Validation evidence: 删除 ContractStore/TaskContract 生产文件与导出；candidate/activation/rebuild 改用 userDirectiveRefs + 必填 handoff，保留 snapshot/task-ledger/branch CAS；validator 校验 schema v2、frozen-boundary 内 verified user authority/seq/hash，并阻止 handoff 授权或误报 task/tool completion；JSONL 跳过 legacy v1 且保持真实版本号，raw rebuild 仅生成 v2 deterministic handoff。核心、failure 与 eval 共 10 files、99/99 通过，限定 Biome、`git diff --check` 和核心 src `tsgo --noEmit` 通过；完整类型检查只剩 T-008 负责的旧测试夹具迁移。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 集成、回归和最终审阅

- Status: done
- Owner: coordinator
- Objective: 集成所有变更，证明依赖路径、context 输出、compaction 回归和静态检查满足验收标准。
- Inputs and prerequisites: T-005、T-006、T-007。
- Scope or files: 全部本任务文件；只修复由本任务引入的问题。
- Expected output: 通过的目标测试、compaction 聚合、邻接回归、`npm run check` 和最终 diff 审阅。
- Dependencies: T-005, T-006, T-007.
- Execution steps:
  1. 合并并审阅各任务报告和 diff。
  2. 运行最小目标测试，再扩大到 compaction aggregate 和仓库 check。
  3. 核对共享 worktree 中自动格式化范围。
- Acceptance criteria:
  - 所有前置任务 done；任务文档 validator 和代码检查通过。
- Verification method:
  - 任务文档记录的完整命令和结果。
- Validation evidence: 迁移 CAS、drift、circuit-breaker、shadow、recall、default-on 和 AgentSession 测试，删除只验证废弃 TaskContract 生命周期的测试；清除活动源码中的 TaskContract/ContractStore/contractRef/`PATCH_TASK_CONTRACT`/`/contract`/旧 pinned-ledger API，并将 eval fixture 改为 task + directives。集成时复现并修复 offload-only 已有 snapshot 的 directive ref 校验错误：candidate 从完整冻结历史生成 refs，但 validator 曾只接收 live tail，现用完整冻结事件边界解析并以 baseEventSeq 构建 deterministic state。最终 compaction 聚合 368 passed + 8 skipped；compaction + AgentSession/RPC 回归 396 passed + 8 skipped；prompt/queue/concurrency/retry/extensions/RPC 邻接 64 passed + 8 skipped；根 `npm run check`、`tsgo --noEmit`、`git diff --check` 和任务文档 validator 全部通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 审计 ledger/CAS/runtime-task 删除边界

- Status: done
- Owner: subagent:task-ledger-removal-map
- Objective: 追踪 Task Ledger、Goal Interpreter、reconciliation、Tool Ledger、snapshot runtime tasks、branch binding 和 snapshot CAS 的全部生产与测试依赖，定义删除后的最小 compaction 状态模型。
- Inputs and prerequisites: 用户明确要求删除全部 ledger/CAS/runtime-task 投影；F-008 至 F-010；共享 dirty worktree。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/**`、AgentSession 接线与对应 tests，只读。
- Expected output: 文件级删除/修改清单、行为保留矩阵和最小回归集合。
- Dependencies: T-008.
- Execution steps:
  1. 追踪 imports、types、host fields/API、snapshot schema、orchestrator/validator、branch restore、eval 和 tests。
  2. 追踪 reducer runtime tasks、Tool Ledger、snapshot CAS 和 branch binding，并区分 SessionManager/raw event 自身能力。
- Acceptance criteria:
  - 清单覆盖全部生产 ledger/runtime-task/branch-ref/CAS 引用，并明确删除后仍存在的最小 raw-event/snapshot 行为。
- Verification method:
  - `rg` 与调用链逐项核对。
- Validation evidence: 子代理两轮只读追踪覆盖 TaskLedger/Goal Interpreter/reconciliation、ToolLedger dispatch gate/durability、StructuredSnapshot.tasks/reducer/prompt/validator/eval、snapshot branch ancestry selection 与 expected-version CAS。确认删除后最小一致性模型为 session single-flight、冻结 entries、一次 publish、失败不替换 active/live messages，以及首次加载/path 变化清空不兼容 active；未修改文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 删除生产 ledger/runtime-task/branch/CAS 子系统和接线

- Status: done
- Owner: coordinator + bounded implementation subagents
- Objective: 删除 Task Ledger、Goal Interpreter、reconciliation、Tool Ledger、snapshot runtime tasks、branch binding、snapshot CAS 及其 orchestrator/session/public API 接线，同时保持 handoff/directive/raw events/recent tail/recall 和最小 active snapshot。
- Inputs and prerequisites: T-010 done。
- Scope or files: compaction subsystem production files、AgentSession/HfCompactionHost 配置和必要公开导出。
- Expected output: 活动生产源码无 ledger/runtime-task/branch-ref/snapshot-CAS 接线；schema、恢复和直接激活链一致。
- Dependencies: T-010.
- Execution steps:
  1. 删除专用模块和导出，移除 host lifecycle/config/API。
  2. 从 types/orchestrator/validator/snapshot store/rebuild/narrative/extractor/reducer 移除 ledger、runtime tasks、branch refs 和 CAS。
  3. 将 snapshot store 收敛为 session 级单一 active snapshot 的直接 publish，不再做 branch ancestry 或 expected-version 比较；增加 session single-flight，并在首次/incompatible path 变化时清空 active。
- Acceptance criteria:
  - 生产 `rg` 无 TaskLedger/ToolLedger/taskLedgerRef/Goal Interpreter/reconciliation/runtime snapshot tasks/branch snapshot/CAS 活动引用。
  - handoff/directive/recent tail/recall/raw rebuild 和 session 自身 branch entries 不退化。
- Verification method:
  - 目标 TypeScript、session/orchestrator/validator/snapshot/branch/tool tests。
- Validation evidence: 删除 TaskLedger/ToolLedger/Goal Interpreter/reconciliation 模块及导出；snapshot schema v3 删除 runtime tasks/taskLedgerRef/branch ref，SnapshotStore 改为 `publishActive/clearActive` 并删除 candidate/activate/expected-version/min-base/branch-select CAS；orchestrator shadow 只验证不持久化。AgentSession/host 删除 ledger tool gate/replay/config/API，增加 session single-flight，首次或 incompatible path 清 active。coordinator 复跑 coding-agent src `tsgo --noEmit`、生产旧引用 `rg` 与 `git diff --check` 均通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 删除旧测试并完成集成验证

- Status: done
- Owner: coordinator + subagent:session-contract-removal
- Objective: 删除只验证 Task Ledger 的测试，迁移仍有价值的 branch/snapshot/CAS/eval 回归，并执行最终静态与聚合验证。
- Inputs and prerequisites: T-011 done。
- Scope or files: coding-agent Task Ledger 相关 tests、eval fixtures、任务文档。
- Expected output: 无过时测试夹具，关键行为由 raw event、handoff/directive、recent tail/recall 和直接 snapshot activation 测试覆盖。
- Dependencies: T-010 for dedicated-test deletion; T-011 for API-dependent migration and final validation.
- Execution steps:
  1. 删除 task-ledger/goal-interpreter/reconciliation 专用测试。
  2. 删除 Tool Ledger/runtime tasks/branch snapshot/CAS 专用测试，迁移 orchestrator/validator/snapshot/eval/AgentSession fixture。
  3. 运行目标测试、compaction aggregate、邻接回归、`npm run check` 和 diff 审阅。
- Acceptance criteria:
  - 完整 TypeScript 和相关测试通过；任务文档 validator 通过。
- Verification method:
  - 目标 Vitest、compaction aggregate、邻接回归、`npm run check`、`git diff --check`。
- Validation evidence: 删除 TaskLedger/ToolLedger/Goal Interpreter/reconciliation/ledger-CAS 专用测试，迁移 semantic/eval/snapshot-store/orchestrator/rebuild/session/recall/shadow/branch/AgentSession 测试到 schema v3 与 `publishActive/clearActive`。最终 compaction aggregate 36 passed files + 2 skipped（285 passed + 8 skipped）；AgentSession/queue/concurrency/retry/extension/RPC 邻接 8 passed files + 3 skipped（54 passed + 23 skipped）；根 `npm run check`（Biome 无改写、依赖/import/shrinkwrap/install-lock/TypeScript/browser-smoke）通过；production/test 旧引用扫描、`git diff --check` 和任务文档 validator 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — 运行完整 build

- Status: done
- Owner: coordinator
- Objective: 在当前共享 worktree 上运行仓库根完整 build，验证所有 workspace 生产构建与在线模型生成链。
- Inputs and prerequisites: T-012 done；用户明确授权完整 build；继承当前代理环境并为 Node fetch 启用 `NODE_USE_ENV_PROXY=1`。
- Scope or files: 全仓库构建；仅修复由本任务改造导致的失败，不清理无关改动。
- Expected output: 根 `npm run build` exit 0，且不泄露凭据。
- Dependencies: T-012.
- Execution steps:
  1. 记录代理变量是否存在但不输出值。
  2. 运行 `NODE_USE_ENV_PROXY=1 npm run build`，保留完整输出。
  3. 若失败，定位 first divergence，并区分代码、依赖、网络和环境问题。
- Acceptance criteria:
  - 所有 workspace build 完成，生成物不产生非预期源码/锁文件变更。
- Verification method:
  - 命令退出码、完整日志、前后 `git status` 范围核对。
- Validation evidence: `NODE_USE_ENV_PROXY=1 npm run build` 在真实评测修复前后均 exit 0；tui/grok-tui/telemetry/ai/agent/session-backends/protocol/client/server/coding-agent 全部构建完成，models.dev/NVIDIA/OpenRouter/Vercel 在线模型生成成功。构建后 `packages/ai/src/models.generated.ts`、provider data 与 dist 均无新增工作树差异。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — 运行完整 npm test

- Status: done
- Owner: coordinator
- Objective: 运行仓库定义的完整 `npm test`，覆盖 scripts 和所有 workspace tests。
- Inputs and prerequisites: T-013 done；用户明确授权完整 test。
- Scope or files: 全仓库测试；不主动设置 real-provider opt-in flags，真实评测由 T-015 定向运行。
- Expected output: 根 `npm test` exit 0；默认 real-provider suites 仍按 opt-in 设计 skip。
- Dependencies: T-013.
- Execution steps:
  1. 运行 `npm test` 并保留完整输出。
  2. 对失败按 first divergence 分类，只修复本任务相关回归。
- Acceptance criteria:
  - 所有默认测试通过，无未解释失败。
- Verification method:
  - 命令退出码与 workspace 汇总。
- Validation evidence: 首轮 `npm test` 精确暴露 coding-agent 4 项测试迁移回归：3 项工具清单漏列 `recall_search`，1 项 manual compact fixture 残留 Goal Interpreter 响应；其他 workspace 通过。最小修复后三个目标文件 8/8 通过，第二轮根 `npm test` 全绿。修复真实评测暴露的 directive 预算问题后，最终根 `NODE_USE_ENV_PROXY=1 npm test` 再次 exit 0：scripts 5/5；agent 470 passed + 1 skipped；ai 970 passed + 795 skipped；client 36/36；coding-agent 2290 passed + 57 skipped；evals 23/23；protocol 147/147；server 50/50；telemetry 15/15；sqlite-node 87/87；grok-tui/tui node tests 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-015 — 运行真实供应商 compaction 评测

- Status: done
- Owner: coordinator
- Objective: 显式启用并运行 Kimi K3 与 openai-codex 多模型真实供应商 compaction eval，验证 schema v3/handoff-first 在真实输出下能激活并满足 hard gates。
- Inputs and prerequisites: T-014 done；用户明确授权真实 API 与付费 token；本地 AuthStorage 或相应 env 凭据可用。
- Scope or files: `real-model-eval.test.ts`、`multi-model-real-eval.test.ts` 两个 opt-in 文件；缓存写入 `/tmp/hf-eval-cache`。
- Expected output: 测试实际执行而非 skip；报告 activated/rejected、retention、oracle 与 token reduction；不打印凭据。
- Dependencies: T-014.
- Execution steps:
  1. 使用 `NODE_USE_ENV_PROXY=1` 与两个 opt-in flag 定向运行两个 eval 文件。
  2. 检查每个 provider 的 activated rounds、hard gates 和拒绝原因。
  3. 若 provider/auth/network 阻塞，记录可复现证据；若模型输出暴露代码缺陷，最小修复后重跑。
- Acceptance criteria:
  - 至少 Kimi K3 与默认两个 openai-codex 模型实际调用；各自测试断言通过，无 vacuous retention。
- Verification method:
  - 定向 Vitest 完整输出、测试数量、评测报告。
- Validation evidence: 两个 opt-in 文件均实际调用供应商而非 skip。openai-codex `gpt-5.4-mini` 与 `gpt-5.4` 各 2/0 activated/rejected，F/C/T/P 保留率均 100%，oracle consistent=true，34,204 token 分别降至 1,051/1,063。Kimi K3 的 large/tool/coding/drift fixtures 均满足 hard gates、保留率 100% 且 oracle consistent=true；少量极小后续轮因 token gain 非正而按策略拒绝。首次完整执行 7/8 通过，唯一失败在 full-scale provider 调用前确定性抛出 directives 2,052/2,048：投影只预算正文，最终 renderer 另加标题。统一 renderer 并按最终 provider-visible 文本预算后，directive/prompt/scale 27/27 通过；定向重跑 Kimi 完整 1,018 entries/~156k token、4-round soak exit 0，4/0 activated/rejected，F/C/T/P 100%，oracle consistent=true，53,773 token 降至 3,104。最终 `npm run check` exit 0。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 每个行为变更先运行对应 Vitest 文件并保留先红后绿证据。
2. 核心目标集至少覆盖 narrative、prompt-builder、orchestrator、validator、rebuild、context inspection、session contract/API replacement。
3. 运行 `node .../vitest --run test/compaction-subsystem` 作为 compaction 聚合回归；真实 provider eval 仅在用户明确授权后以 opt-in 定向运行。
4. 根据固定层接线经验，补跑 prompt、extension、queue、concurrent/retry 邻接测试。
5. 运行根 `npm run check`，随后 `git status --short`、任务范围 diff 和 `git diff --check`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Breaking schema/API：不做兼容层会使旧 snapshot 走 raw rebuild；必须证明不会静默误读。
- 权限漂移：handoff 不能成为系统/工具权限来源；通过 injection、completion、deterministic-state 冲突测试防护。
- token 反弹：user directive 和 handoff 必须有硬预算，不能把全部用户消息重新钉住。
- 共享 dirty worktree：`npm run check` 会写文件；运行前后必须核对，不得覆盖其他会话改动。
- 并发覆盖：删除 snapshot CAS 后由 AgentSession/HfCompactionHost single-flight 拒绝同 session 并发 compaction；必须确认不存在绕过 host 直接并发 publish 或依赖旧 conflict report 的路径。
- 分支快照：删除 compaction branch binding 后，active snapshot 不再按祖先选择；切分支时只能依赖调用方当前 entries 触发新的 compaction/raw rebuild，不能把旧 snapshot 误称为 branch-scoped。
- 文件耦合：`types.ts`、`prompt-builder.ts`、`session-integration.ts` 由 coordinator 串行处理，避免并行冲突。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: 创建 execute 模式任务文档；记录用户授权、当前架构证据、目标分层和验证边界。
- 2026-08-24: 项目经验要求固定层继续走 system prompt 而非普通 user message，并在改动后覆盖 prompt/extension/queue/concurrency 邻接回归。
- 2026-08-24: Batch A 启动 T-001/T-002/T-003，只读并行映射生产依赖、用户入口和 handoff-first 安全投影；任务文档由 coordinator 独占写入。
- 2026-08-24: T-001/T-002/T-003 完成；确认删除 global TaskContract、保留 Task Ledger/CAS/raw truth，并拆分 event schema v1 与 snapshot schema v2。T-004 由 coordinator 开始核心类型改造。
- 2026-08-24: 新增必要工作 T-009，独立实现 verified-user directive 原子预算投影；与 coordinator 的 T-004 核心类型改造并行且文件不重叠。
- 2026-08-24: T-004 完成；schema 版本拆分测试先红后绿，snapshot v2 核心字段改为 userDirectiveRefs/handoff 并移除 global contractRef/constraints。
- 2026-08-24: T-009 完成；verified-user directive 投影目标测试由子代理 5/5、coordinator 集成复跑 6/6 通过。Batch B 启动 T-005/T-006/T-007，按 prompt、session、orchestrator 文件边界并行。
- 2026-08-24: T-005/T-006/T-007 完成；handoff/prompt 30/30、session 接线与邻接回归通过、orchestrator/schema/rebuild/eval 99/99；完整类型错误仅剩旧测试夹具。
- 2026-08-24: T-008 迁移旧测试和历史命名，删除 TaskContract 生命周期测试；定向测试 61/61 与 ledger/reconciliation/eval 68/68 通过，完整 TypeScript 通过。
- 2026-08-24: compaction 聚合首次发现 offload-only directive ref 仅用 live tail 校验的集成缺陷；改用 frozen full event boundary 后目标回归和聚合通过。
- 2026-08-24: 最终 compaction + AgentSession/RPC 396 passed + 8 skipped，邻接回归 64 passed + 8 skipped，根 `npm run check`、`git diff --check` 与任务文档 validator 通过。
- 2026-08-24: 用户确认 Task Ledger 无实际价值并授权整体删除；重新打开任务文档，新增 F-008/F-009 与 T-010/T-011/T-012。项目经验要求删除 task-ledger CAS 时保留独立 branch-visible boundary、snapshot CAS 和 Tool Ledger durability。
- 2026-08-24: T-010 启动只读删除边界审计，任务文档继续由 coordinator 独占维护。
- 2026-08-24: 用户扩大删除范围：Tool Ledger、snapshot runtime tasks、branch binding、snapshot CAS 也不保留；T-010 审计随之扩展，目标模型改为无 ledger/CAS 的单 active snapshot。
- 2026-08-24: T-010 扩展审计完成；选择不持久化 branch 身份、首次/path 变化清空 active、session single-flight + 单次 publish 的最小一致性模型，解锁 T-011。
- 2026-08-24: T-011 核心与 session 接线分文件并行实施；T-012 仅将不依赖新 publish API 的专用测试删除/语义夹具迁移并行，其余集成等待 T-011。
- 2026-08-24: T-011 完成；生产模块已无 Task/Tool ledger、runtime tasks、snapshot branch binding 或 snapshot CAS，src TypeScript 与 production rg 通过。T-012 解锁全部 API-dependent 测试迁移。
- 2026-08-24: T-012 完成；首次聚合命令因误用不存在的 package-local Vitest 路径未执行，改用根 `npx vitest` 后 compaction aggregate 285 passed + 8 skipped，邻接回归 54 passed + 23 skipped；根 `npm run check` 全部通过且 Biome 未改写文件。
- 2026-08-24: 用户追加授权真实供应商评测、完整 build、完整 `npm test`；新增串行 T-013/T-014/T-015，重新打开 overall validation，T-013 开始。
- 2026-08-24: T-013 完整 build 通过，Node 代理生效且在线模型数据生成成功，无新增 generated/dist diff；T-014 开始完整 `npm test`。
- 2026-08-24: T-014 首轮完整测试发现 4 项 stale fixture/assertion，最小迁移后目标 8/8、第二轮完整 `npm test` 全部通过；T-015 开始两个 opt-in real-provider eval。
- 2026-08-24: T-015 首次真实评测完成 7/8，openai-codex 两模型与 Kimi K3 均实际调用；唯一失败为 full-scale 在 provider 调用前暴露 directives renderer 标题未计入 2,048 token 预算。
- 2026-08-24: 将 directive 选择与 prompt 构建统一到同一最终 renderer，预算完整 provider-visible 区块；目标 27/27、Kimi full-scale soak 4/4 activated 且 100% retention/oracle consistent。最终 `npm run check`、完整 build、完整 `npm test` 全部通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-015 全部完成；根 `npm run check`、修复后完整 build、修复后完整 `npm test` 均 exit 0；openai-codex 与 Kimi K3 真实评测已实际执行，最终 full-scale 4-round soak 通过且关键保留率为 100%。
- Limitations: 尚未提交 Git；共享 worktree 中大量其他任务改动保持原状。无 branch binding 的设计主动放弃跨重启/rewind/sibling snapshot 复用，首次加载或不兼容 path 导航会清 active 并回退当前 SessionManager raw messages。真实评测仍受供应商输出与服务状态影响，本次通过是当前模型/凭据/网络条件下的运行时证据。
