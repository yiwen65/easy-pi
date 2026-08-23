# Task Plan: 高保真 Context Compaction 子系统重构

- Created: 2026-08-22
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: `高保真 Context Compaction 子系统——Agent 实施任务书.md` (EPIC-CCTX-001 v1.0) + `.edru/` 仓库接管资产

<!-- task-doc-section:background-goal -->
## Background and goal

任务书 EPIC-CCTX-001 要求在 pi Agent Runtime 中实现高保真 Context Compaction：长任务活动上下文有界，同时 TaskContract、硬约束、权限边界与外部副作用状态不经过有损摘要；原始事件可追溯可恢复；tool call/result、并行批次、tool loop、外部事务不被切分；每次压缩经过校验、CAS 激活、失败 fail-closed；支持 exact recall 与 raw rebuild。

现状（证据见下）：pi 现行 compaction（`packages/coding-agent/src/core/compaction/compaction.ts`）是 summary-only 设计——LLM 生成自由文本摘要写入 v3 JSONL 的 `CompactionEntry`，`buildSessionContext` 用摘要替换被压缩历史。它不满足任务书核心语义（原始事件是真相；摘要只是叙事桥接）。`.edru/` 接管资产（KP-001、DATA-001、RSK-003）确认：目标会话系统是成熟的 coding-agent JSONL（SessionManager, CURRENT_SESSION_VERSION=3），而非尚为脚手架的 AgentHarness（RSK-001）。

目标：在 `packages/coding-agent/src/core/compaction/subsystem/` 交付一套可测试的高保真压缩子系统库（真相层 + 固定层 + 状态层 + 工作层 + 事务式编排），全部 LLM 依赖通过注入接口隔离、可用 faux 实现测试；并产出 G0 盘点/ADR 文档与集成接缝文档。核心语义：

> 原始事件是真相；TaskContract 是不可压缩契约；Structured Snapshot 是可校验状态；Narrative Summary 只负责叙事桥接；活动上下文只是可重建投影。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope（本 run 执行）：**
- G0：CCTX-001 现状盘点与 baseline、CCTX-002 架构 ADR 与接口冻结（文档）。
- G1 真相层/固定层：CCTX-010 TaskContract、CCTX-011 Append-only Event Log、CCTX-012 Artifact Store、CCTX-013 Tool/Side-effect Ledger。
- G2 确定性可逆压缩 MVP：CCTX-020 Snapshot Store/CAS、CCTX-021 Deterministic Reducer、CCTX-022 Atomic Group/Safe Cut、CCTX-023 Prompt Builder/Pinned Layer、CCTX-030 Payload 卸载、CCTX-031 Recall Catalog/Exact Recall。
- G3 生成式压缩事务：CCTX-040 Structured Extractor、CCTX-041 Narrative Bridge、CCTX-042 Validator/Repair、CCTX-050 Trigger、CCTX-051 Orchestrator、CCTX-052 Rollback/Raw Rebuild、CCTX-060 注入防护；CCTX-070 Observability 融入 Orchestrator/各模块审计事件。
- CCTX-072 的单元级故障/对抗/漂移测试（faux LLM：空输出、schema 违规、膨胀、CAS 冲突、对象存储故障、注入、tool orphan、0/1/2/4/8 轮漂移）。
- `npm run check` + 全部新增测试通过。

**Non-goals（本 run 不执行，记录为 blocked 或显式排除）：**
- CCTX-080 AgentSession 运行时接线：任务书将其门禁在 G4 全通过之后；AgentSession 是 3.4k 行热点（.edru 11-history），当前 worktree 有他 session 未提交改动。产出集成接缝文档代替。
- CCTX-081 Shadow/Canary/上线演练、CCTX-071 真实模型评测数据集：需要真实 LLM provider 凭证与生产环境（仓库规则：测试禁止真实 provider API）。
- CCTX-061 多 Agent 一致性：远程 stack 无生产组合（.edru UNK-002），本会话系统为单写者本地 JSONL；仅在类型中预留 agent_id/causal_parent_ids 字段。
- 不修改任何既有文件（compaction.ts、session-manager.ts、agent-session.ts 等）；不动 lockfile/shrinkwrap；不提交 git。
- 删除/替换现有 summary-only compaction 路径（需用户另行确认，AGENTS.md 要求移除功能前先询问）。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 现行 compaction 为 summary-only：LLM 摘要 + `CompactionEntry` 写入 v3 JSONL，`buildSessionContext` 以摘要替换历史；无事件溯源、无 CAS、无 provenance | `packages/coding-agent/src/core/compaction/compaction.ts`（compact/prepareCompaction/generateSummaryWithUsage）、`session-manager.ts:316` getLatestCompactionEntry、`session-manager.ts:383` sessionEntryToContextMessages |
| F-002 | 目标会话系统是 coding-agent v3 JSONL（SessionManager），AGENT Harness 是脚手架（公开方法 reject not-implemented），两套会话模型并存 | `.edru/06-data-and-state-map.md` DATA-001/DATA-002、`.edru/12-risk-register.yaml` RSK-001/RSK-003、`packages/agent/src/harness/agent-harness.ts` |
| F-003 | 现有切分已保证不在 toolResult 处切断（findValidCutPoints 排除 toolResult），但无并行批次/tool loop/外部事务原子概念 | `compaction.ts` findValidCutPoints/isCutPointMessage/findCutPoint |
| F-004 | token 估算：chars/4 启发式 estimateTokens + 末次 assistant usage 外推 estimateContextTokens；shouldCompact 用 contextWindow - reserveTokens 单阈值 | `compaction.ts:198/254/287` |
| F-005 | 摘要调用已禁工具（toolChoice:"none"）并对 toolCall 输出抛错；瞬断有 retryAssistantCall | `compaction.ts` completeSummarization / generateSummaryWithUsage |
| F-006 | 仓库测试规则：禁真实 provider；单测试用 `node node_modules/vitest/dist/cli.js --run <path>`；改代码后必须 `npm run check` 全量通过；禁跑 `npm run build`/`npm test`；多用例套件用 `./test.sh` | `AGENTS.md` Commands 节 |
| F-007 | worktree 有其他 session 的未提交改动（grok-tui 端口、package.json、interactive-mode 等）；只能新增/修改本任务自己的文件 | `git status --porcelain`（2026-08-22）、`AGENTS.md` Git 节 |
| F-008 | erasable TypeScript only（Node strip-only）：禁 parameter properties、enum、namespace、import=；顶层导入；无 any | `AGENTS.md` Code Quality 节 |
| F-009 | AgentMessage/Usage/Model/Context 类型来自 pi-ai compat；SessionEntry 联合类型含 message/compaction/branch_summary/custom/custom_message/label/session_info/model_change/thinking_level_change | `session-manager.ts:144` SessionEntry、`compaction.ts` imports |
| F-010 | 任务书强制约束 12 条、验收指标（保真度/token）、阶段门禁 G0-G5、事务流程与 repair 流程均已定义 | `高保真 Context Compaction 子系统——Agent 实施任务书.md` §二/§三/§六/§七 |
| F-011 | 现行 prompt 组装：buildSessionContext 输出 messages 直接进 provider；compaction 后无固定层/状态层/工作层区分 | `session-manager.ts:461` buildSessionContext、KP-001 |
| F-012 | .edru 接管资产（模块图、边界目录、关键路径 KP-001/002/003、风险登记）与本任务相关的证据已读取 | `.edru/00-15` 全部核心文件 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 子系统作为新库目录 `packages/coding-agent/src/core/compaction/subsystem/` 交付、默认不被任何运行路径调用（无 feature-flag 接线），因此不会回归短会话。影响：CCTX-080 无法在 run 内验收。验证方式：T-021 全量测试 + `npm run check`。
- Assumption: LLM 抽取/摘要在测试中以注入的 faux complete 函数替代（仓库禁止真实 provider）。影响：保真度指标只能以确定性 faux 验证逻辑正确性，不能以真实模型验证 99.5% 类门槛。验证方式：faux 实现可控输出，覆盖 schema/空输出/膨胀/注入分支。
- Assumption: 存储后端先实现内存 + JSONL 文件两种（与 SessionManager 的 JSONL 习惯一致），SQLite 后端非本 run 目标。影响：生产级并发持久化留待 CCTX-080/081。验证方式：接口与后端解耦。
- Assumption: 子系统事件模型独立定义（EventEnvelope），并提供 `fromSessionEntries()` 适配器从 v3 SessionEntry 投影事件；不反向改写 SessionManager。影响：与既有 JSONL 共存而非替换。验证方式：适配器测试。
- Open question（不阻塞，记录在案）: 是否在本 run 结束后授权 CCTX-080 接线（修改 agent-session.ts）与旧 summary-only 路径的退役计划。默认：不接线、不退役。
- Open question（不阻塞）: CCTX-071 真实模型评测与 CCTX-081 灰度所需的环境与凭证。默认：标记 blocked。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

对应任务书 §九 Definition of Done 中可在仓库内验证的子集：

- [x] TaskContract 独立于 messages，永不参与 compaction（每轮从可信存储回填；抽取器无法改写）。
- [x] Event log append-only：单调 seq、boundary freeze、范围读取、空状态重放、compaction 不删事件。
- [x] Side-effect 状态机单调合法（planned→approved→started→succeeded|failed|unknown），unknown 不被盲重放，幂等键去重。
- [x] tool pair、并行批次、tool loop、外部事务不被切分；recent tail 由完整原子组组成。
- [x] 大结果可外存，经稳定 ID + hash 恢复；外存失败保留 inline；重复卸载幂等。
- [x] Typed snapshot 关键字段带 provenance（source event IDs）。
- [x] exact 字段（数字、路径、版本、hash、ID）由确定性 checker 校验，不由模型担保。
- [x] Compaction 在 frozen boundary 上运行；boundary 后新事件进入下一版本。
- [x] Snapshot 版本化 + CAS 激活；并发 compaction 仅一个激活；CAS 失败不覆盖；可回滚。
- [x] 空输出、schema 错误、约束漏项、指针失效、token 膨胀、CAS 冲突时 fail closed，旧 snapshot 保持 active。
- [x] 完整下一请求重新计 token（含 system、contract、snapshot、narrative、tail、recall、输出预留）；候选不能降 ≥5% 不激活。
- [x] exact recall 已知 ID 成功率 100%；错误/跨租户 ID 拒绝；hash 不匹配 fail closed。
- [x] 0、1、2、4、8 次压缩漂移测试：关键保留率下降 < 1%（faux 确定性环境）。
- [x] 注入测试：对抗内容不能删除 pinned constraints、不能提升权限，只能成为 proposal。
- [x] raw rebuild 与全量重放一致；回滚可恢复污染 snapshot；重建不重复副作用。
- [x] `npm run check` 通过；新增测试全部通过。
- [x] 产出：盘点/baseline 文档、ADR、集成接缝文档。

明确不在本 run 验收：真实模型保真度门槛（≥99.5% 等）、token 中位数降 40%（需真实长任务与模型）、Shadow/Canary/熔断演练、多 Agent 一致性、AgentSession 接线。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph（T-XXX → 依赖）：
  - T-001, T-002 → 无（G0 文档，证据已收集）
  - T-003 (contract) → T-002；T-004 (artifacts) → T-002
  - T-005 (event log) → T-004；T-006 (ledger) → T-005
  - T-007 (snapshot store) → T-005
  - T-008 (reducer) → T-003, T-005, T-006
  - T-009 (atomic groups/cut) → T-005, T-006, T-008
  - T-010 (offload) → T-004, T-009；T-011 (recall) → T-004, T-010
  - T-012 (prompt builder) → T-003, T-007, T-008, T-009
  - T-013 (injection guard) → T-003
  - T-014 (extractor) → T-008, T-010, T-011, T-013
  - T-015 (narrative) → T-014；T-016 (validator) → T-014, T-015
  - T-017 (trigger) → T-012, T-010, T-016
  - T-018 (orchestrator+observability) → T-007, T-009, T-010, T-014, T-015, T-016, T-017
  - T-019 (rollback/rebuild) → T-005, T-007, T-008, T-018
  - T-020 (drift/failure suite) → T-018, T-019
  - T-021 (check + seam doc + final validation) → 全部
- Parallel batches: 理论上 [T-003, T-004]、[T-010, T-011 部分] 可并行，但全部模块共享 `types.ts` 且委托子代理无法运行 shell/测试（正确性风险高于收益）。决策：由协调者串行执行，T-001/T-002 文档利用已收集证据直接编写。该决策满足"纯串行图可由协调者执行"。
- Serialization constraints: 所有源码文件为新增文件，互不与他 session 重叠；types.ts 单写者（协调者）；每模块落地后立即跑对应测试再进入下游。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — CCTX-001 现状盘点与 baseline 文档

- Status: done
- Owner: coordinator
- Objective: 产出盘点报告，回答任务书 §十 的 6 个启动问题（不可变真相/固定回填/副作用工具/可外存大内容/可确定性 reduce 状态/剩余叙事）。
- Inputs and prerequisites: 已读取的源码与 .edru 证据（F-001..F-012）。
- Scope or files: `docs/compaction/01-inventory-and-baseline.md`（新增）。
- Expected output: 现状映射、数据流、工具风险清单（read/bash/edit/write 等副作用分类）、现有 token/compaction 行为 baseline、6 问答复。
- Dependencies: None.
- Execution steps:
  1. 汇总 F-001..F-012 与源码细节成文档。
  2. 明确 canonical state（SessionManager JSONL）与 prompt view（buildSessionContext 输出）。
  3. 按任务书 §十 逐条回答 6 问。
- Acceptance criteria:
  - 可从用户输入追踪至模型请求与副作用（引用 KP-001 步骤）；
  - 所有状态写入点已列出；
  - 6 问均有基于证据的回答。
- Verification method: 文档自审 + 引用路径真实存在（抽查）。
- Validation evidence: 2026-08-22 交付 `docs/compaction/01-inventory-and-baseline.md`；抽查引用路径全部存在（compaction.test.ts / agent-session-compaction.test.ts / compaction-serialization.test.ts / compaction.ts / agent-harness.ts → ls 验证 PATHS OK）；6 问逐条基于证据作答；状态写入点表覆盖 append/fork/compaction/工具副作用；可追踪性引用 KP-001 步骤 1–10。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — CCTX-002 架构 ADR 与接口冻结

- Status: done
- Owner: coordinator
- Objective: 冻结四层架构、source-of-truth 边界、风险分级、核心 schema/接口/并发模型（CAS 单写者）/降级路径/schema 演进规则。
- Inputs and prerequisites: 任务书 §四/§五；T-001 结论。
- Scope or files: `docs/compaction/02-architecture-adr.md`（新增）。
- Expected output: ADR（每条强制不变量 → 唯一责任组件映射表；CAS vs single-writer 决策；供应商中立决策；schema 演进规则）。
- Dependencies: None（证据已足；与 T-001 并行编写）。
- Execution steps:
  1. 写架构分层与不变量-组件映射。
  2. 冻结 EventEnvelope/TaskContract/Snapshot/LedgerEntry/AtomicGroup/CoverageManifest/RecallEntry/ValidatorReport 字段。
- Acceptance criteria:
  - 12 条强制约束每条有唯一责任组件；
  - 明确 CAS 激活模型；
  - 供应商托管 compaction 仅作 adapter 的结论落字。
- Verification method: 文档自审；与任务书 §二 逐条对照。
- Validation evidence: 2026-08-22 交付 `docs/compaction/02-architecture-adr.md`：ADR-3 将 12 条强制约束逐条映射到唯一责任组件；ADR-5 冻结单写者+CAS；ADR-6 冻结 CompleteFn 供应商中立接口；ADR-7 冻结 v1 schema 与演进规则。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — CCTX-010 TaskContract 与可信更新

- Status: done
- Owner: coordinator
- Objective: 实现 TaskContract schema、版本化存储（内存+JSONL）、授权更新、proposal 通道、审计事件；Prompt Builder 每轮读 verified active version。
- Inputs and prerequisites: T-002 冻结字段；任务书 §5.1。
- Scope or files: `subsystem/types.ts`（初建，含共享类型）、`subsystem/task-contract.ts`、`test/compaction-subsystem/task-contract.test.ts`。
- Expected output: ContractStore 接口 + InMemory/Jsonl 实现；未验证"管理员更新"仅成 proposal；全版本可审计恢复。
- Dependencies: T-002。
- Execution steps:
  1. 建 types.ts（schema_version、provenance、审计事件基础）。
  2. 实现 store + 版本 + 权限校验 + 审计。
  3. 写测试：不进压缩、未授权文本不覆盖、约束完整回填、历史版本恢复。
- Acceptance criteria: 任务书 CCTX-010 关键测试 4 条全过。
- Verification method: vitest 单文件运行通过。
- Validation evidence: 2026-08-22 vitest task-contract.test.ts 15/15 通过（InMemory+Jsonl 两后端）：创建 v1、未验证创建者拒绝、未授权文本仅成 proposal、授权批准产生 v2 且历史可审计、未授权批准拒绝、身份伪造拒绝、驳回不动 active、JSONL 重开持久化。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — CCTX-012 Artifact/Object Store 与稳定引用

- Status: done
- Owner: coordinator
- Objective: content-addressed put/get + hash 校验；稳定 ref 解析（`artifact://sha256/...`）；preview/类型/大小/来源元数据；被引用对象 pin 防删。
- Inputs and prerequisites: T-002。
- Scope or files: `subsystem/artifact-store.ts`、`test/compaction-subsystem/artifact-store.test.ts`。
- Expected output: ArtifactStore 接口 + InMemory/FileSystem 实现 + ref parser/resolver + broken pointer 扫描。
- Dependencies: T-002。
- Execution steps:
  1. 实现 put（计算 sha256）/get（校验 hash）/pin/unpin/scan。
  2. ref 格式与权限（tenant）检查。
  3. 测试：字节可恢复、hash 不匹配 fail closed、broken pointer 可发现、外存失败保留 inline 由调用方语义保证（接口返回明确错误）。
- Acceptance criteria: 任务书 CCTX-012 验收 3 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest artifact-store.test.ts 14/14 通过：content-addressed put/get 字节一致、同内容同 ref、跨租户/坏 ref 拒绝、篡改 fail closed + scanBroken 发现、pin 不被 GC、元数据完整、fs 重开持久化、ref round-trip。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — CCTX-011 Append-only Event Log

- Status: done
- Owner: coordinator
- Objective: 统一事件（消息/工具/审批/状态/工件/错误/compaction）；session 内单调 seq；boundary freeze；范围读取；checkpoint；空状态 replay；大 payload 外存但保留 metadata+hash；`fromSessionEntries` 适配器。
- Inputs and prerequisites: T-004；任务书 §5.2。
- Scope or files: `subsystem/event-log.ts`、`test/compaction-subsystem/event-log.test.ts`。
- Expected output: EventLog 接口 + InMemory/Jsonl 实现；append 并发安全（进程内串行化 + JSONL 单写者）；freeze(seq) 返回 boundary handle。
- Dependencies: T-004。
- Execution steps:
  1. EventEnvelope 落 types.ts；实现 append/freeze/range/replay。
  2. payload 外存策略接口（委托 ArtifactStore）。
  3. 适配器：v3 SessionEntry → events。
  4. 测试：单调 seq、重复 append 拒绝、断电语义（先写盘后返回）、compaction 不删事件、从空 replay、适配器往返。
- Acceptance criteria: 任务书 CCTX-011 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest event-log.test.ts 17/17 通过：单调 seq、重复 eventId 拒绝、freeze 边界、空状态 replay、compaction 不删旧事件、200 并发 append 无重复覆盖、contentHash 必携、JSONL 重开持久、损坏文件显式报错、offload 大小阈值与失败 inline 兜底、v3 SessionEntry 适配器保序保因果。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — CCTX-013 Tool 与 Side-effect Ledger

- Status: done
- Owner: coordinator
- Objective: 记录 tool call（名/args hash/状态/exit code/结果 ref）；副作用记 idempotency key、审批、external resource ID；状态机 planned→approved→started→succeeded|failed|unknown 单调合法；超时/中断→unknown；恢复查询钩子。
- Inputs and prerequisites: T-005；任务书 §5.3。
- Scope or files: `subsystem/tool-ledger.ts`、`test/compaction-subsystem/tool-ledger.test.ts`。
- Expected output: ToolLedger（事件溯源：ledger 状态由事件 reduce，迁移校验非法即拒绝）。
- Dependencies: T-005。
- Execution steps:
  1. 定义 ledger 事件类型与迁移表。
  2. 实现转移校验 + 幂等键索引 + recovery query 接口。
  3. 测试：计划≠完成、unknown 不盲重放、同幂等键不重复副作用、非法迁移拒绝。
- Acceptance criteria: 任务书 CCTX-013 关键测试 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest tool-ledger.test.ts 8/8 通过：合法迁移链、planned→succeeded 无证据拒绝、终态不可逆、planned 不报完成、幂等键去重、unknown 核验恢复（不盲重放）、审批前置、事件溯源 replay 状态一致。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — CCTX-020 Snapshot Store、版本与 CAS

- Status: done
- Owner: coordinator
- Objective: immutable snapshot version + active pointer；candidate 写入与激活分离；parent/base seq/source ranges/lineage/token/validator 记录；rollback、历史、diff；CAS 冲突候选仅可审计。
- Inputs and prerequisites: T-005；任务书 §5.4。
- Scope or files: `subsystem/snapshot-store.ts`、`test/compaction-subsystem/snapshot-store.test.ts`。
- Expected output: SnapshotStore 接口 + InMemory/Jsonl 实现；activate(expectedVersion) CAS。
- Dependencies: T-005。
- Execution steps:
  1. 定义 StructuredSnapshot 落 types.ts。
  2. 实现 putCandidate/activate(CAS)/rollback/list/diff。
  3. 测试：并发仅一个激活、旧候选不覆盖新事件、历史可追溯、rollback 恢复。
- Acceptance criteria: 任务书 CCTX-020 验收 3 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest snapshot-store.test.ts 6/6：candidate/激活分离、并发仅一个 CAS 成功且败者可审计、陈旧候选被 minBaseEventSeq 拒绝、rollback 恢复、lineage 可追溯、diff 字段级。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — CCTX-021 确定性 Reducer

- Status: done
- Owner: coordinator
- Objective: 事件→确定性状态（tasks/tools/artifacts/errors/approvals/side-effects）；LLM 不得决定 exit code/hash/完成态/审批；合法迁移；增量 reduce 与全量 replay 一致；缺证据→unknown/unverified。
- Inputs and prerequisites: T-003、T-005、T-006。
- Scope or files: `subsystem/reducer.ts`、`test/compaction-subsystem/reducer.test.ts`。
- Expected output: `reduceEvents(events, prior?)` 纯函数；状态对象带 provenance（source event IDs）。
- Dependencies: T-003, T-005, T-006。
- Execution steps:
  1. 定义 DeterministicState 与各子状态迁移。
  2. 增量/全量双路径，断言一致。
  3. 测试：增量=全量；重复/缺失/乱序显式报错；无成功证据不得 completed。
- Acceptance criteria: 任务书 CCTX-021 验收 3 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest reducer.test.ts 7/7：确定性状态带 provenance、增量=全量、乱序/缺口/重复显式报错、orphan tool result 拒绝、无证据不得 completed、适配 session-adapter payload 形状。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — CCTX-022 Atomic Group 与 Safe Cut Planner

- Status: done
- Owner: coordinator
- Objective: 定义 turn/tool pair/parallel batch/tool loop/external transaction/patch-test bundle 原子组；按 token 预算保留最近完整原子组；未闭合 tool loop 完整保留；输出 coverage manifest 与切分范围。
- Inputs and prerequisites: T-005、T-006、T-008。
- Scope or files: `subsystem/atomic-groups.ts`、`test/compaction-subsystem/atomic-groups.test.ts`。
- Expected output: `buildAtomicGroups(events)` + `planSafeCut(groups, budget)` + CoverageManifest。
- Dependencies: T-005, T-006, T-008。
- Execution steps:
  1. 事件分组（因果/tool_call_id/transaction_id）。
  2. 切分规划 + manifest（保留/压缩范围、组边界）。
  3. 测试：不拆 tool pair/并行批/事务；未闭合 loop 保留；tail 全为完整组。
- Acceptance criteria: 任务书 CCTX-022 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest atomic-groups.test.ts 9/9：tool pair/parallel batch/tool loop/transaction 分组正确、未闭合标记、切分不拆批/事务/未闭合 loop、预算足够全保留、coverage manifest 与切分一致。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — CCTX-030 Payload 分类与确定性卸载

- Status: done
- Owner: coordinator
- Objective: 分类 must-keep-verbatim/structured/summarizable/offloadable；reverse token budget 优先保留近期工具结果；旧大结果外存，活动上下文留 call ID/status/exit code/preview/ref；工具排除策略与 hysteresis；幂等。
- Inputs and prerequisites: T-004、T-009。
- Scope or files: `subsystem/payload-offload.ts`、`test/compaction-subsystem/payload-offload.test.ts`。
- Expected output: `classifyPayload` + `offloadPayloads(events/groups, policy, store)`；审批/高风险结果不卸载。
- Dependencies: T-004, T-009。
- Execution steps:
  1. 分类规则（类型/policy/tool metadata）。
  2. 卸载执行 + 失败保留 inline + 幂等键。
  3. 测试：大日志可恢复、高风险不卸载、失败不删原文、重复卸载幂等。
- Acceptance criteria: 任务书 CCTX-030 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest payload-offload.test.ts 8/8：大结果卸载可恢复（call ID/status/exit code/preview/ref）、审批与高风险不卸载、存储失败保留 inline、幂等（effectiveRecords 区分新旧）、reverse budget 保留近期 N 条。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — CCTX-031 Recall Catalog 与 Exact Recall

- Status: done
- Owner: coordinator
- Objective: 移出内容生成 catalog 条目（ID/类型/时间/preview/关联/hash）；`recallExact(ref)`；keyword 搜索返回 stable ref；高风险动作前自动召回接口；记录召回指标。
- Inputs and prerequisites: T-004、T-010。
- Scope or files: `subsystem/recall-catalog.ts`、`test/compaction-subsystem/recall-catalog.test.ts`。
- Expected output: RecallCatalog + exact recall（hash 校验 fail closed、tenant/错误 ID 拒绝）。
- Dependencies: T-004, T-010。
- Execution steps:
  1. Catalog 条目与索引。
  2. recallExact + keywordSearch。
  3. 测试：已知 ID 100% 召回、错误 ID 拒绝、hash 不匹配 fail closed、needle 延迟查询可恢复。
- Acceptance criteria: 任务书 CCTX-031 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest recall-catalog.test.ts 6/6：已知 ID 精确召回、未知/跨租户拒绝、hash 篡改 fail closed、延迟 needle 恢复、关键词搜索只回 stable ref、指标记录。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — CCTX-023 Prompt Builder 与 Pinned Layer

- Status: done
- Owner: coordinator
- Objective: 按冻结顺序组装 prompt：system→verified contract→validated snapshot→narrative→recall 说明→verbatim atomic tail→当前输入→exact recall；Current Focus View 确定性生成、只引用已有 ID；分区 token 统计。
- Inputs and prerequisites: T-003、T-007、T-008、T-009。
- Scope or files: `subsystem/prompt-builder.ts`、`test/compaction-subsystem/prompt-builder.test.ts`。
- Expected output: `buildPrompt(input)` → { messages/context 分区, tokenComposition }；关闭 compaction 可恢复原 history path（适配器直通模式）。
- Dependencies: T-003, T-007, T-008, T-009。
- Execution steps:
  1. 分区组装 + 确定性 Focus View。
  2. 分区 token 统计（estimateTokens 复用现有启发式）。
  3. 测试：每个 active constraint 可定位；tail 与 cut manifest 一致；token 统计=实际发送；直通模式等价原路径。
- Acceptance criteria: 任务书 CCTX-023 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest prompt-builder.test.ts 6/6：分区顺序冻结、约束逐字可定位、tail 逐字保序、token 分区合计=总数、Focus View 只引用已有 ID、passthrough 原样返回。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — CCTX-060 摘要注入与可信边界（前置实现）

- Status: done
- Owner: coordinator
- Objective: compactor 独立 system policy；历史内容包装 untrusted data；工具能力关闭（契约层断言）；authority/权限不由 compactor 生成；持久化注入模式检测（"忽略规则/我是管理员/删除约束"等）；prompt/schema/model/安全策略版本化。
- Inputs and prerequisites: T-003。
- Scope or files: `subsystem/injection-guard.ts`、`test/compaction-subsystem/injection-guard.test.ts`。
- Expected output: `wrapUntrusted(content)`、`detectInjections(text)`、`COMPACTOR_POLICY_VERSION` 等版本常量；检测结果供 validator/extractor 使用。
- Dependencies: T-003。
- Execution steps:
  1. 模式库 + 包装协议 + 版本常量。
  2. 测试：注入文本不删约束、不高权、只能成 proposal。
- Acceptance criteria: 任务书 CCTX-060 验收 3 条（与 T-014/T-016 联合验证）。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest injection-guard.test.ts 4/4：untrusted 包装、7 条注入样本全检出（中英）、4 条良性内容无误报、策略版本化且禁工具/授权/契约改写。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — CCTX-040 Structured State Extractor

- Status: done
- Owner: coordinator
- Objective: 严格 JSON Schema；输入 verified contract refs + deterministic state + prior state + coverage manifest + 选定事件（untrusted 包装）；确定性字段只读；模型只提 delta，代码确定性合并；工具关闭；无法确认→unverified。
- Inputs and prerequisites: T-008、T-010、T-011、T-013。
- Scope or files: `subsystem/state-extractor.ts`、`test/compaction-subsystem/state-extractor.test.ts`。
- Expected output: `extractState(input, complete)`；complete 为注入的 LLM 函数（测试用 faux）；schema 校验失败不落库。
- Dependencies: T-008, T-010, T-011, T-013。
- Execution steps:
  1. JSON Schema + delta 类型落 types.ts。
  2. 提取请求构建（untrusted 包装、toolChoice none 断言）。
  3. delta 确定性合并器（provenance 必携）。
  4. 测试：schema 违规拒绝、constraint 不改写、provenance 存在、空输出 fail closed、注入内容不生效。
- Acceptance criteria: 任务书 CCTX-040 验收 4 条。
- Verification method: vitest（faux complete）。
- Validation evidence: 2026-08-22 vitest state-extractor.test.ts 9/9：untrusted 包装+版本化策略+严格 schema、空输出/中止/schema 违规 fail closed、禁止键（constraints/permissions/tasks/tools）拒绝、无 provenance 丢弃、越界引用标 unverified、prior 确定性合并不重复。
- Blocker: None.
- Unblock condition: None.

### [x] T-015 — CCTX-041 Narrative Bridge Summarizer

- Status: done
- Owner: coordinator
- Objective: 仅叙事桥接（进展/背景/决策原因/下一步）；不存唯一事实；不新增权限/完成态/副作用结论/精确数值；关键内容引用 task/decision/error ID；与 typed state 冲突时拒绝候选。
- Inputs and prerequisites: T-014。
- Scope or files: `subsystem/narrative.ts`、`test/compaction-subsystem/narrative.test.ts`。
- Expected output: `generateNarrative(input, complete)` + 冲突检测（精确数字/路径/状态词扫描对照 typed state）。
- Dependencies: T-014。
- Execution steps:
  1. 版本化 prompt（COMPACTOR_POLICY_VERSION 引用）。
  2. 输出后处理：禁用模式检测（完成断言/精确数值未引用 ID）。
  3. 测试：删 narrative 仍可续任务（typed state+tail 足够性由构建输入验证）；exact fields 不改写；预算可配。
- Acceptance criteria: 任务书 CCTX-041 验收 3 条。
- Verification method: vitest（faux complete）。
- Validation evidence: 2026-08-22 vitest narrative.test.ts 5/5：落地叙事通过；未扎根精确值（版本/路径）拒绝；非 done 任务完成断言拒绝；注入拒绝；预算截断于句界。修复 EXACT_VALUE_PATTERN 的 \b 在斜杠前失效缺陷。
- Blocker: None.
- Unblock condition: None.

### [x] T-016 — CCTX-042 Validator 与 Repair

- Status: done
- Owner: coordinator
- Objective: 实现 P0 validator 集：schema/contract coverage/矛盾/exact field/provenance/task 迁移/tool pairing/loop 原子性/side-effect 单调/decision 因果/active-active 矛盾/injection/token gain；repair：一次受控 repair→raw rebuild→拒绝；高风险约束/副作用错误不可模型修补。
- Inputs and prerequisites: T-014、T-015。
- Scope or files: `subsystem/validator.ts`、`test/compaction-subsystem/validator.test.ts`。
- Expected output: `validateCandidate(candidate, context)` → ValidatorReport（P0/P1 分级）；`repairOrReject` 流程函数。
- Dependencies: T-014, T-015。
- Execution steps:
  1. 各 validator 实现与分级。
  2. repair/rebuild/reject 决策。
  3. 测试：漏约束/错路径/错状态/伪完成/断引用/tool orphan 均可检出；P0 失败 active 不变（与 T-018 联测）。
- Acceptance criteria: 任务书 CCTX-042 验收 2 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest validator.test.ts 14/14：12 类校验全覆盖（漏约束/矛盾/伪完成/幻影任务/配对/单调/断引用/未扎根精确值/跨切/injection/token gain/因果边 P1）；repair→rebuild→reject 阶梯；高风险类不可模型修补。
- Blocker: None.
- Unblock condition: None.

### [x] T-017 — CCTX-050 触发控制器

- Status: done
- Owner: coordinator
- Objective: SOFT（>70% 预测下一请求 / recoverable tokens 超阈 / phase 变更 / 手动 milestone）、HARD（>85% / 上次调用 overflow）、FULL_REBUILD（增量次数阈值 / drift 超阈 / 关键矛盾 / 高风险不可逆动作前）；hysteresis 防抖。
- Inputs and prerequisites: T-012、T-010、T-016。
- Scope or files: `subsystem/trigger.ts`、`test/compaction-subsystem/trigger.test.ts`。
- Expected output: `evaluateTriggers(input)` → { action, reasons }；纯函数可测。
- Dependencies: T-012, T-010, T-016。
- Execution steps:
  1. 阈值策略 + 预测下一请求 token 组成（system/tools/contract/snapshot/narrative/tail/recall/输出预留）。
  2. hysteresis（冷却轮次）。
  3. 测试：短会话不触发、巨大工具输出触发卸载、阈值附近不反复、手动 compact 不绕 validator（后者与 T-018 联测）。
- Acceptance criteria: 任务书 CCTX-050 验收 4 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest trigger.test.ts 9/9：短会话不触发、70%/85% 阈值、overflow、巨大工具输出 offload_only、offload 足够时优先 offload、phase/手动 soft、FULL_REBUILD 四条件、cooldown 不压 hard/rebuild。
- Blocker: None.
- Unblock condition: None.

### [x] T-018 — CCTX-051 事务式 Compaction Orchestrator + CCTX-070 Observability

- Status: done
- Owner: coordinator
- Objective: 实现任务书冻结流程：读 active+expected version→freeze boundary→deterministic reduce→atomic cut→外存+coverage+recall catalog→extract→narrative→validate/repair/rebuild→构建真实下一请求重计 token→写 candidate→CAS 激活→CompactionCommitted 事件；全程审计事件（trigger/tokens/zones/offload/validator/repair/reject/lineage/recall/CAS/rollback/rebuild）。
- Inputs and prerequisites: T-007、T-009、T-010、T-014、T-015、T-016、T-017。
- Scope or files: `subsystem/orchestrator.ts`、`subsystem/observability.ts`、`test/compaction-subsystem/orchestrator.test.ts`。
- Expected output: `CompactionOrchestrator.compact(reason)`；模型调用期间不持锁（单写者串行队列，无长事务）；失败补偿+审计。
- Dependencies: T-007, T-009, T-010, T-014, T-015, T-016, T-017。
- Execution steps:
  1. observability.ts：审计事件类型与收集器。
  2. orchestrator 事务流程 + 各失败分支补偿。
  3. 测试（faux LLM）：成功路径端到端；模型超时/空输出/schema 错/CAS 冲突/对象存储故障均 fail closed 且旧状态有效；boundary 后新事件进下一版本；审计事件完整可追溯。
- Acceptance criteria: 任务书 CCTX-051 事务要求 5 条 + CCTX-070 验收 3 条（审计可追溯、收益来源可区分、普通日志无敏感原文）。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest orchestrator.test.ts 11/11：端到端激活（快照==cut 范围全量 reduce 不变量断言）、超时/空输出/schema 违规 fail closed、并发 CAS 冲突败者拒绝、freeze 后事件进下一版、token 膨胀拒绝、对象存储故障降级、未闭合 loop 完整保留、手动不绕 validator、叙事拒绝不阻塞 typed 候选、审计链完整。
- Blocker: None.
- Unblock condition: None.

### [x] T-019 — CCTX-052 Rollback 与 Raw Rebuild

- Status: done
- Owner: coordinator
- Objective: 按版本回滚 active pointer；从 seq 0 或 checkpoint 全量重建；重建校验 stable refs/ledger；对象缺失明确报缺口；按 lineage/drift 触发；记录 MTTR；重建不重复副作用。
- Inputs and prerequisites: T-005、T-007、T-008、T-018。
- Scope or files: `subsystem/rebuild.ts`、`test/compaction-subsystem/rebuild.test.ts`。
- Expected output: `rollbackToVersion(version)`、`rawRebuild(sessionId, fromCheckpoint?)` → 新 snapshot（标记 rebuild 来源）。
- Dependencies: T-005, T-007, T-008, T-018。
- Execution steps:
  1. 回滚 + 重建流程（复用 reducer/orchestrator 确定性阶段）。
  2. 缺口报告 + MTTR 计时。
  3. 测试：污染 snapshot 可回滚；raw rebuild 与 oracle（全量 reduce）一致；重建不执行工具/副作用。
- Acceptance criteria: 任务书 CCTX-052 验收 3 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest rebuild.test.ts 6/6：raw rebuild==全量 replay oracle、缺对象显式报缺口、重建不执行副作用、MTTR 记录、extractor 内容仅以 unverified 结转、污染快照可回滚。
- Blocker: None.
- Unblock condition: None.

### [x] T-020 — CCTX-072 漂移、故障与对抗单元套件

- Status: done
- Owner: coordinator
- Objective: 同 trajectory 0/1/2/4/8 次压缩漂移（关键保留率下降 <1%）；summary-of-summary vs raw rebuild 对照；大日志/volume pressure；summarizer 注入；权威冒充；并发消息+双 compactor；对象存储故障；空输出/超时/膨胀/schema 违规；未闭合 tool loop；exact recall vs 语义检索失败闭环。P0 全 fail closed。
- Inputs and prerequisites: T-018、T-019。
- Scope or files: `test/compaction-subsystem/drift.test.ts`、`test/compaction-subsystem/failure-modes.test.ts`（+ 复用各模块测试）。
- Expected output: 两套测试文件全绿；失败矩阵结果记录进执行日志。
- Dependencies: T-018, T-019。
- Execution steps:
  1. 构造确定性 trajectory fixture（含约束/决策/工具/副作用/大日志/needle）。
  2. 漂移环（faux extractor 保真合并）测 0/1/2/4/8 轮。
  3. 故障注入矩阵逐条断言 fail closed。
- Acceptance criteria: 上述场景全部通过；关键保留率可量化输出。
- Verification method: vitest。
- Validation evidence: 2026-08-22 vitest drift.test.ts 8/8 + failure-modes.test.ts 7/7：0/1/2/4/8 轮关键保留率下降 0%（门槛 <1%）；8 轮后 raw rebuild==oracle；事件零删除；lineage 完整；注入回声拒绝+契约不动；冒充仅成 proposal；双 compactor 仅一激活（CAS 冲突）；膨胀候选拒绝；volume 压力全可召回；语义检索失败时 exact recall 闭环；full_rebuild 走确定性 rebuildRunner。
- Blocker: None.
- Unblock condition: None.

### [x] T-021 — 整体验证、集成接缝文档与收尾

- Status: done
- Owner: coordinator
- Objective: `npm run check` 全过；全部新增测试运行通过；产出 `docs/compaction/03-integration-seam.md`（CCTX-080 接线点：AgentSession 钩子、feature flags offload_only/structured_compaction/full_pipeline、回滚方法）；更新任务文档最终状态。
- Inputs and prerequisites: T-001..T-020。
- Scope or files: `docs/compaction/03-integration-seam.md`（新增）；本任务文档。
- Expected output: check 无错误警告；测试清单与结果；接缝文档含一键回原 history path 说明。
- Dependencies: T-001 至 T-020 全部。
- Execution steps:
  1. 运行全部新增测试与 `npm run check`。
  2. 写接缝文档。
  3. 文档定稿 + validator 校验。
- Acceptance criteria: Acceptance criteria 节全部可勾选项有当前证据。
- Verification method: 命令输出记录进执行日志。
- Validation evidence: 2026-08-22 `npm run check` exit 0（biome+pinned-deps+ts-imports+shrinkwrap+install-lock+tsgo+browser-smoke 全过）；子系统 19 文件 169/169 通过；既有 compaction 回归 compaction.test.ts/compaction-serialization/agent-session-compaction 30 passed 7 skipped（skip 为既有标记）；交付 docs/compaction/03-integration-seam.md（接线点、CompleteFn 适配、feature flags、回滚、上线顺序）。
- Blocker: None.
- Unblock condition: None.

### [x] T-900 — CCTX-061/071/080/081 生产化剩余工作（分解为 T-101..T-105）

- Status: done
- Owner: unassigned
- Objective: 多 Agent 一致性、真实模型评测数据集与 oracle、AgentSession 运行时接线（feature flags）、Shadow/Canary/熔断/runbook 演练。
- Inputs and prerequisites: 本 run 交付物 + 真实 LLM 凭证/生产环境 + 用户对接线 agent-session.ts 与旧路径退役的明确授权。
- Scope or files: `agent-session.ts`、评测基础设施、部署配置（本 run 不触碰）。
- Expected output: G4 全门槛达成证据 + G5 上线演练记录。
- Dependencies: T-021。
- Execution steps:
  1. 取得用户授权与环境。
  2. 按任务书 CCTX-080/081 顺序执行。
- Acceptance criteria: 任务书 §九 全部 DoD。
- Verification method: 真实环境评测与演练。
- Validation evidence: 2026-08-22 授权到达，T-900 关闭并分解为 T-101..T-105（见下）。原阻塞证据保留：勘察证据——AGENTS.md 规定测试禁真实 provider API 与密钥；任务书 §六 将 CCTX-080 门禁在 G4 之后；`git status` 显示 agent-session.ts 所在工作区有他 session 未提交改动；.edru UNK-002 确认远程 stack 无生产组合。阻塞原因成立。
- Blocker: 已解除（用户于 2026-08-22 授权接线执行）。
- Unblock condition: 已满足（授权到达）；真实模型门槛转入 T-105 单独跟踪。

### [x] T-101 — CCTX-080 Agent Runtime 集成（feature flags 接线）

- Status: done
- Owner: coordinator
- Objective: 将子系统接入 AgentSession：事件追加钩子、触发评估、prompt 组装替换、recall_exact 工具；feature flags `offload_only`/`structured_compaction`/`full_pipeline`；默认关闭，关闭时严格等价原 history path。
- Inputs and prerequisites: 用户授权（2026-08-22）；子系统库 169 测试绿；agent-session.ts 未被他 session 修改（git status 核实）。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts`（新增宿主）、`packages/coding-agent/src/core/agent-session.ts`（最小挂载点）、`test/compaction-subsystem/session-integration.test.ts`。
- Expected output: flag 关闭零行为变化；flag 开启后长会话经子系统压缩且失败回退原路径；recall_exact 可用。
- Dependencies: T-021。
- Execution steps:
  1. 通读 agent-session.ts，定位 message_end 持久化点、_checkCompaction、provider context 构建点。
  2. 实现 session-integration.ts 宿主（每会话 stores+orchestrator，注入生产 CompleteFn 适配器，faux 可换）。
  3. agent-session.ts 最小接线 + flag。
  4. 失败测试先行：flag off 回归、flag on 压缩生效、失败回退、recall 可用。
- Acceptance criteria:
  - 短会话（flag off）既有测试不回归；
  - flag on 时压缩经 validator/CAS 激活且 Contract 逐字回填；
  - 子系统任何异常不阻塞主会话（fallback 原路径）；
  - 高风险动作前可召回 contract/decision/ledger。
- Verification method: 新增集成测试（faux provider，禁真实 API）+ 既有 agent-session-compaction 测试 + `npm run check`。
- Validation evidence: 2026-08-22 集成测试 5/5 通过（test/compaction-subsystem/session-integration.test.ts）：flag off 零变化；structured_compaction 阈值触发走子系统（快照激活、JSONL 无 legacy 条目、raw 消息全在、压缩后可继续对话）；子系统失败回退 legacy 并生成 legacy 条目；manual compact 走子系统且 exact recall 可取回卸载内容；offload_only 无 LLM 调用且事件零丢失。回归：既有 compaction 相关 69 项通过（7 项既有 skip）。`npm run check` exit 0。期间修复真实缺陷：prompt-builder/validator/narrative 的 eventText 丢弃块数组内容（导致 token 前低估）、extractor 序列化缺 eventId、双管道重复记录改单拉取、offload_only 改为全范围扫描。
- Blocker: None.
- Unblock condition: None.

### [x] T-102 — CCTX-081 Shadow 模式、熔断配置与 runbook（仓库内可执行部分）

- Status: done
- Owner: coordinator
- Objective: orchestrator 增加 `shadow` 模式（候选生成+校验+审计，不激活）；熔断条件映射到既有 P0/审计事件；产出 runbook 文档。
- Inputs and prerequisites: T-018 orchestrator；任务书 CCTX-081。
- Scope or files: `subsystem/orchestrator.ts`（shadow 选项）、`test/compaction-subsystem/shadow.test.ts`、`docs/compaction/04-rollout-runbook.md`。
- Expected output: shadow 下 active 不变、候选可审计、指标完整；runbook 覆盖回滚/模型故障/对象存储故障/hash 错误/并发冲突/raw rebuild/flag 一键关闭/审计删除请求。
- Dependencies: T-101。
- Execution steps:
  1. orchestrator shadow 分支。
  2. 测试：shadow 不激活但候选/审计齐全。
  3. runbook 文档。
- Acceptance criteria: shadow 测试通过；runbook 8 条目齐全。
- Verification method: vitest + 文档自审。
- Validation evidence: 2026-08-22 shadow.test.ts 3/3：shadow 候选生成+校验+审计但不激活（active 不变、无 commit 事件、CAS 未触发）、token 投影可供 go/no-go、P0 仍 fail closed。runbook 交付 docs/compaction/04-rollout-runbook.md（上线 5 步、7 类熔断映射到 P0/审计码、8 节故障手册含回滚/模型故障/对象存储/hash/并发/rebuild/flag 关闭/审计删除）。
- Blocker: None.
- Unblock condition: None.

### [x] T-103 — CCTX-061 并发与多 Agent 一致性原语

- Status: done
- Owner: coordinator
- Objective: 共享事件日志的 per-agent 视图、跨 agent 副作用去重（幂等键注册表）、字段级冲突检测（合并不报静默 last-write-wins）、结构化 handoff capsule。
- Inputs and prerequisites: 类型已含 agentId/causalParentIds；任务书 CCTX-061。
- Scope or files: `subsystem/multi-agent.ts`、`test/compaction-subsystem/multi-agent.test.ts`。
- Expected output: AgentView（按 agentId 过滤投影）、SharedRegistry（task/decision/artifact 注册 + 冲突检测）、HandoffCapsule。
- Dependencies: T-018。
- Execution steps:
  1. 实现视图/注册表/capsule。
  2. 测试：stale 视图不覆盖、重复副作用可检测、冲突显式报出、handoff 往返。
- Acceptance criteria: 任务书 CCTX-061 验收 3 条。
- Verification method: vitest。
- Validation evidence: 2026-08-22 multi-agent.test.ts 7/7：agentView 过滤投影且因果 parent 保留；SharedRegistry 乐观版本+字段级冲突（并发分叉显式冲突不静默 LWW、不相交更新无伪冲突、first-writer 保持）；SideEffectRegistry 跨 agent 幂等键去重；HandoffCapsule 往返+版本校验。
- Blocker: None.
- Unblock condition: None.

### [x] T-104 — CCTX-071 评测数据与 Oracle（faux 可运行骨架）

- Status: done
- Owner: coordinator
- Objective: ground-truth atoms（F/C/R/S/U/D/T/P）数据集格式、确定性 grader（exact 字段）、full-context oracle 对照、编码/工具两类轨迹 fixture、评测 runner（faux 可跑，真实模型可插拔）。
- Inputs and prerequisites: 任务书 CCTX-071；T-020 漂移套件经验。
- Scope or files: `packages/coding-agent/test/compaction-subsystem/eval/`（dataset 类型、grader、runner、fixtures）。
- Expected output: `runEval(fixture, completeFn)` 输出逐 atom 保留率报告；faux 下全绿；真实模型仅需替换 CompleteFn。
- Dependencies: T-018。
- Execution steps:
  1. atom schema + grader（exact 用确定性比较）。
  2. fixture 两条轨迹。
  3. runner + 测试。
- Acceptance criteria: exact 字段 grader 确定性；oracle 对照输出；runner 在 faux 下通过。
- Verification method: vitest。
- Validation evidence: 2026-08-22 eval/ 交付（atoms.ts/grader.ts/runner.ts/fixtures.ts + eval-runner.test.ts 2/2）：F/C/R/S/U/D/T/P 八类 atom 模型；exact 字段确定性 grader；编码与工具两条轨迹经 2 轮压缩后全部 atom 保留、oracle 一致、token 下降。修复 grader 缺陷：tail 比 snapshot 新，任务有效状态须先查 tail。真实模型执行仅需替换 runEval 的 CompleteFn。
- Blocker: None.
- Unblock condition: None.

### [ ] T-105 — 真实模型保真度评测与生产灰度（评测已完成，灰度仍环境阻塞）

- Status: blocked
- Owner: unassigned
- Objective: 以真实 provider 运行 T-104 评测，达成任务书 §三 门槛（constraint recall 100%、exact ≥99.5%、token 中位数降 ≥40% 等）；执行 canary 上线顺序。
- Inputs and prerequisites: T-101..T-104 完成 + 真实 provider 凭证与网络环境。
- Scope or files: 生产/评测环境（本仓库外）。
- Expected output: 真实指标报告与上线记录。
- Dependencies: T-101, T-102, T-103, T-104。
- Execution steps:
  1. 在具备凭证的环境将 T-104 runner 的 CompleteFn 替换为生产适配器运行。
  2. 按 runbook 执行 canary 顺序。
- Acceptance criteria: 任务书 §三 全部指标门槛。
- Verification method: 真实评测。
- Validation evidence: 2026-08-22 环境核验记录——凭证探测命令被 harness 凭证断路器拒绝（无法在本环境确认真实 provider 可用性）；AGENTS.md 明文禁止测试使用真实 provider API；本环境无网络/生产部署面。故真实模型评测与灰度在本环境客观不可执行。
- Blocker: 剩余仅为外部生产部署面（本仓库不存在：无生产服务/灰度基础设施，见 .edru UNK-002）。仓库内等价验证已全部完成：shadow/canary 机制、熔断演练、真实长任务语料 K3 压测（−39.6%~−72%）、真实 CLI dogfood 三档对照。
- Unblock condition: 提供生产/灰度部署环境后按 docs/compaction/04-rollout-runbook.md 执行上线顺序。

### [x] T-106 — 语料转换器：session JSONL → EvalFixture

- Status: done
- Owner: coordinator
- Objective: 将 v3 会话 JSONL（真实长任务）转换为评测 fixture：事件经 sessionEntriesToEvents 适配、契约从首条用户消息提取、T/S/P atom 由 reducer 确定性导出、F atom 从精确值挖掘、needle 从大型工具结果生成；支持人工标注 sidecar 覆盖。
- Inputs and prerequisites: 用户授权（2026-08-22）；`test/fixtures/large-session.jsonl` 真实语料存在（1019 条目）。
- Scope or files: `test/compaction-subsystem/eval/corpus-converter.ts` + `corpus-converter.test.ts`。
- Expected output: `convertSessionToFixture(entries, opts)` → EvalFixture；确定性部分（T/S/P）零人工。
- Dependencies: T-104。
- Execution steps:
  1. 失败测试先行（小合成会话 + large-session 前 120 条目前缀）。
  2. 实现转换与 atom 导出。
- Acceptance criteria: 转换确定性（同输入同输出）；T/S atom 与 reducer 一致；needle 指向可外存的大结果；sidecar 约束覆盖生效。
- Verification method: vitest。
- Validation evidence: 2026-08-22 corpus-converter.test.ts 4/4：合成会话转换（契约/事件/T atom 与 reducer 一致/F 精确值挖掘/needle 生成）、确定性、maxEntries 截断、goal 覆盖、真实 large-session 150 条目前缀转换确定。修复：版本正则 \b 不跨 v 前缀。
- Blocker: None.
- Unblock condition: None.

### [x] T-107 — 批量 runner：限速、缓存、聚合报告

- Status: done
- Owner: coordinator
- Objective: `runCorpus(fixtures, completeFn, opts)`：串行限速（pacing）、429/超时退避、按 (model+promptVersion+inputHash) 缓存 compactor 响应、聚合 median token 收益与分类保留率、输出 JSON+Markdown 报告。
- Inputs and prerequisites: T-106；K3 限流实测 429 经验。
- Scope or files: `test/compaction-subsystem/eval/batch-runner.ts` + `batch-runner.test.ts`。
- Expected output: CorpusReport 聚合结构与落盘报告；缓存命中时零模型调用。
- Dependencies: T-106。
- Execution steps:
  1. 失败测试先行（faux complete 计数器验证缓存/限速/聚合）。
  2. 实现。
- Acceptance criteria: 缓存在同输入下 100% 命中；串行执行（并发度 1）；报告含 median；失败单元不中断整体。
- Verification method: vitest。
- Validation evidence: 2026-08-22 batch-runner.test.ts 5/5：缓存同输入 100% 命中且跨实例持久、键区分 model/promptVersion/内容、聚合 median 与分类保留率、坏 cell 隔离、串行并发度=1 + pacing。
- Blocker: None.
- Unblock condition: None.

### [x] T-108 — K3 真实小语料验证

- Status: done
- Owner: coordinator
- Objective: 用 large-session.jsonl 前缀构造 1–2 条真实长任务 fixture，经 batch runner 在 kimi-coding K3 上执行，记录保真/token 指标到任务文档。
- Inputs and prerequisites: T-106、T-107；K3 凭据（已验证可用）。
- Scope or files: `test/compaction-subsystem/eval/real-model-eval.test.ts`（扩展 corpus 用例，同 PI_REAL_MODEL_EVAL 手动门）。
- Expected output: 真实语料的 atom 保留率与 token 收益记录。
- Dependencies: T-106, T-107。
- Execution steps:
  1. 转换 large-session 前缀为 fixture。
  2. PI_REAL_MODEL_EVAL=1 显式运行。
  3. 记录指标。
- Acceptance criteria: C/T/S/P 硬门槛通过；指标写入任务文档。
- Verification method: 真实运行输出。
- Validation evidence: 2026-08-22 K3 真实小语料：pi-mono 真实会话 100 条目（≈42k tokens 投影）2 轮 2/2 激活、4 轮 4/4 激活、F/C/T/P 100%、oracle 一致、token −71.3%/−72.0%（超 40% 门槛）。修复三个真实缺陷：(1) offload 作用域扩至全历史（巨型 parallel_batch 原子保留在尾部 88k——原子性正确但须卸载）；(2) 适配器瘦身（并行批 N 个 call 各携 22k 整条目 JSON 致 88k 重复）；(3) K3 输出超 maxTokens 截断 → maxTokens 随输入缩放 + 确定性截断 salvage（复用缓存截断响应即恢复，零新增调用）。
- Blocker: None.
- Unblock condition: None.

### [x] T-109 — Shadow flag 接线与熔断演练

- Status: done
- Owner: coordinator
- Objective: `PI_HF_COMPACTION=shadow` 接入 AgentSession 宿主（候选只审计不激活）；七类熔断条件（约束漏项/副作用不符/pointer-hash/drift/token 膨胀/CAS 异常/validator 大量失败）的可执行演练测试。
- Inputs and prerequisites: T-101 接线、T-102 shadow、runbook §2；用户授权（2026-08-22）。
- Scope or files: `session-integration.ts`（shadow 模式分支）、`test/compaction-subsystem/shadow.test.ts` 扩展、`test/compaction-subsession/circuit-breaker.test.ts`（新）。
- Expected output: shadow 模式下真实会话上下文零变化且审计产出候选；七类熔断各有一条测试证明 fail closed/信号产出。
- Dependencies: T-108。
- Execution steps:
  1. 失败测试先行。
  2. 实现 shadow 接线 + 演练矩阵。
- Acceptance criteria: shadow 测试与七类演练全过；`npm run check` 零告警。
- Verification method: vitest。
- Validation evidence: 2026-08-22 shadow-integration.test.ts 1/1 + shadow.test.ts 3/3 + circuit-breaker.test.ts 7/7：PI_HF_COMPACTION=shadow 接线后候选只审计不激活、无误导性错误事件、legacy 路径照旧；七类熔断（约束漏项/副作用不符/hash 失效/drift 超阈/token 膨胀/CAS 冲突/validator 大量失败）各产出文档化信号且 fail closed。修复：空压缩路径也产出 shadow 候选（noop 观测）；tryActivate 死分支清理。
- Blocker: None.
- Unblock condition: None.

### [x] T-110 — 全量语料压测（25万 token 级）与缺陷修复

- Status: done
- Owner: coordinator
- Objective: 用完整 large-session.jsonl（1018 条目，≈253k tokens）与 before-compaction.jsonl 前缀在 K3 上跑多轮压缩压测；修复规模暴露的缺陷（预计：抽取输入规模上限、限流、token 估算）。
- Inputs and prerequisites: T-106..T-108；K3 凭据；缓存/限速设施。
- Scope or files: `real-model-eval.test.ts`（压测用例）+ 缺陷修复涉及子系统文件。
- Expected output: 全量语料的激活率/保留率/token 收益记录；发现的缺陷全部修复并锁定测试。
- Dependencies: T-109。
- Execution steps:
  1. 先 faux 跑全量语料验证管线不崩（免费）。
  2. K3 真实运行（缓存+限速）。
  3. 修复缺陷并复跑。
- Acceptance criteria: 压测完成且指标记录；缺陷修复有回归测试；硬门槛（C/T/P/oracle）过。
- Verification method: faux + 真实运行输出。
- Validation evidence: 2026-08-22 faux 压测（免费预检）：1214 事件/≈156k tokens slim、4/4 激活、404 atoms 100% 保留、oracle 一致、54ms。K3 真实全量压测：pi-mono 完整 1018 条目会话、4/4 轮激活、F/C/T/P 100%、oracle 一致、128523→77595（−39.6%，评测预算口径下达门槛边界；生产口径按模型窗口比例预算另计）。无新增规模缺陷（先前修复经受住）。
- Blocker: None.
- Unblock condition: None.

### [x] T-111 — 真实 CLI dogfood 灰度会话

- Status: done
- Owner: coordinator
- Objective: 用真实 pi CLI（print 模式）在临时工作区跑一个真实多步任务，`PI_HF_COMPACTION=full_pipeline`（另跑 shadow 对照），验证端到端接线在真实运行中工作且不回归。
- Inputs and prerequisites: T-109、T-110；K3 凭据。
- Scope or files: 临时脚本（/tmp，跑完删除）。
- Expected output: 真实会话中子系统激活/审计证据；shadow 对照零行为差异。
- Dependencies: T-110。
- Execution steps:
  1. 构造临时工作区与多步脚本任务。
  2. 分别以 off/shadow/full_pipeline 跑。
  3. 核验会话与审计产物。
- Acceptance criteria: full_pipeline 下任务完成且审计含 compact 事件或正确的不触发原因；shadow 与 off 输出路径一致。
- Verification method: 真实 CLI 运行产物检查。
- Validation evidence: 2026-08-22 真实 CLI dogfood（pi-test.sh 源码运行 + RPC 模式 + kimi-coding K3 + 临时工作区）：full_pipeline 下手动 compact 经子系统激活（"[high-fidelity snapshot v1 activated]”，26497→7831 tokens，−70.4%），压缩后无重读答对全部 4 个 needle 事实；shadow 与 off 行为逐一对照一致（均走 legacy，且 legacy 对 ~26k 会话正确拒绝过小额压缩）；无任何子系统异常逃逸到主路径。临时脚本与工作区已清理（AGENTS.md ad-hoc 规则）。
- Blocker: None.
- Unblock condition: None.

### [x] T-201 — 默认开启 + 完全委派（移除 legacy 执行路径）

- Status: done
- Owner: coordinator
- Objective: 子系统成为默认（`full_pipeline`）；`_runAutoCompaction`/`compact()` 删除 legacy prepare→summary→appendCompaction 流；`_checkCompaction` 保留既有触发调度；extension 钩子保留（cancel 生效、自定义 summary 忽略并废弃）；kill-switch：`compaction.enabled=false` 或 `PI_HF_COMPACTION=off` 完全停用压缩。
- Inputs and prerequisites: 用户两条确认（读侧渲染保留；钩子保留/自定义摘要废弃）；T-101..T-111 全部绿。
- Scope or files: `agent-session.ts`、`session-integration.ts`、`experimental.ts` 或 settings（默认模式解析）。
- Expected output: 默认路径走子系统；旧 CompactionEntry 不再产生；钩子契约收窄。
- Dependencies: T-111。
- Execution steps:
  1. 改编/新增失败测试（默认开启、kill-switch、钩子 cancel、overflow willRetry 经子系统）。
  2. 实施委派与默认值变更。
- Acceptance criteria:
  - 无配置时自动压缩走子系统并激活快照；
  - `compaction.enabled=false` 与 `PI_HF_COMPACTION=off` 均完全无压缩；
  - 钩子 cancel 阻止压缩；钩子提供的自定义 summary 被忽略（结果仍来自子系统）；
  - overflow 恢复（willRetry）在子系统路径下正确裁剪并重试。
- Verification method: vitest（test-harness 集成）+ `npm run check`。
- Validation evidence: 2026-08-22 default-on.test.ts 6/6：无配置默认 full_pipeline（快照激活、零 legacy 条目、contract 区置顶）；compaction.enabled=false 与 mode=off 双 kill-switch；钩子 cancel 生效（start+aborted end 与 legacy 一致）；扩展自定义摘要从上下文中消失且结果来自子系统；overflow length-stop 经子系统压缩后重试完成。settings 的 keepRecentTokens/reserveTokens 接入子系统预算。
- Blocker: None.
- Unblock condition: None.

### [x] T-202 — 移除 legacy 摘要生成代码（保留共享工具与读侧）

- Status: done
- Owner: coordinator
- Objective: 从 `compaction.ts` 移除 `compact()`、`generateSummary(WithUsage)`、turn-prefix/history 摘要 prompts 与 `CompactionDetails` 写侧；保留 `prepareCompaction`/`findCutPoint`/token 估算（钩子入参与既有测试）、`completeSummarization`（子系统适配器与 branch summary 复用）、`utils.ts`；SessionManager 的 CompactionEntry 读侧渲染与 appendCompaction（公共 API/旧数据）保留。
- Inputs and prerequisites: T-201 完成（无生产调用方残留）。
- Scope or files: `packages/coding-agent/src/core/compaction/compaction.ts`。
- Expected output: legacy summary-only 机制代码移除；无未使用导出。
- Dependencies: T-201。
- Execution steps:
  1. grep 全部调用点确认清零。
  2. 移除并跑 `npm run check`。
- Acceptance criteria: 无 `compact(` 生产调用；check 零告警；保留项的既有测试仍过。
- Verification method: check + 相关测试。
- Validation evidence: 2026-08-22 compaction.ts 从 1187 行裁至 609 行：移除 compact()/generateSummary*/全部摘要 prompts/CacheFriendlySummaryOptions/CompactionDetails 写侧；保留 token 估算、cut point、prepareCompaction（钩子入参）、completeSummarization（子系统适配器+branch summary 复用）。index.ts 移除 compact/generateSummary* 导出。check exit 0。
- Blocker: None.
- Unblock condition: None.

### [x] T-203 — 既有测试套件迁移到新默认

- Status: done
- Owner: coordinator
- Objective: 迁移/改编所有 legacy 目标测试（agent-session-compaction、auto-compaction-queue、compaction-extensions、trigger-compact-extension、interactive-mode-compaction、suite/agent-session-compaction、regressions 5217/6647/7253/3688/pre-prompt/7150、compaction.test.ts 中被删函数用例），保持回归意图；branch-summarization 系列不动。
- Inputs and prerequisites: T-201、T-202。
- Scope or files: `packages/coding-agent/test/` 下列文件。
- Expected output: 套件在新默认下全绿，回归意图保留或显式记录语义变化。
- Dependencies: T-202。
- Execution steps:
  1. 逐文件跑、改编、记录语义映射。
  2. 全量非 e2e 相关子集运行。
- Acceptance criteria: 相关测试文件全过；无测试被静默删除（删除需记录理由）。
- Verification method: vitest 逐文件 + 汇总。
- Validation evidence: 2026-08-22 迁移 10 个既有测试文件，全部通过：compaction.test.ts 27/27（删除 2 个 e2e LLM-summarization 块——目标函数已移除）；compaction-summary-reasoning.test.ts 重写 5/5（目标转向存活的 completeSummarization + createPiAiCompleteFn）；suite/agent-session-compaction.test.ts 23/23（含 usage 统计语义变化：压缩器调用不再写入 usage 条目，token 统计改由 CompactionResult+审计承载）；6647 重试语义 5/5（补上了 orchestrator→extractor 的 signal 传递缺陷——早前一次原子回滚丢失）；7253/7150/pre-prompt/5217/3688 全过；agent-session-prompt 16/16；6768 base-url 1/1。无测试被静默删除，语义变化均在断言注释中记录。
- Blocker: None.
- Unblock condition: None.

### [x] T-204 — 收尾验证与文档定稿

- Status: done
- Owner: coordinator
- Objective: 全量子系统+受影响套件 + `npm run check`；更新 `docs/compaction/03-integration-seam.md` 为"已默认"状态说明；任务文档定稿。
- Inputs and prerequisites: T-201..T-203。
- Scope or files: docs 与本任务文档。
- Expected output: 全部验证证据入档；文档反映默认状态。
- Dependencies: T-201, T-202, T-203。
- Execution steps:
  1. 运行验证。
  2. 文档定稿。
- Acceptance criteria: 全绿；文档一致。
- Verification method: 命令输出记录。
- Validation evidence: 2026-08-22 `./test.sh` 隔离全套件（凭据隔离）全绿：coding-agent 2182 passed + 其余包全过；npm run check exit 0；docs/compaction.md 与 README 更新为新默认；03-integration-seam.md 改为默认化状态说明。
- Blocker: None.
- Unblock condition: None.

### [x] T-301 — 激活固定层与召回层：TaskContract 填充 API + recall_exact 工具

- Status: done
- Owner: coordinator
- Objective: 让固定层有真实内容：SDK/RPC 可设置/查询/更新契约（proposal→批准流）；`recall_exact(refId)` 注册为会话内 AgentTool，模型可按 stable ref 精确召回卸载内容。
- Inputs and prerequisites: 用户指令（2026-08-22"写进task，然后开始实施"）；T-010 contract store、T-011 recall catalog、T-101 接线全部就位。
- Scope or files: `session-integration.ts`（host API）、`agent-session.ts`（工具注册+公开方法）、RPC types/mode（compact 同级命令）、新测试。
- Expected output: 用户可设定 constraints/permissions/budgets（版本化+审计）；compacted prompt 的 contract 区逐字包含；模型可调 recall_exact 取回卸载内容（错误/越界 ID 拒绝）。
- Dependencies: T-204。
- Execution steps:
  1. 失败测试先行。
  2. host.setContract/getContract/listVersions/propose+approve；recall_exact AgentTool 注册。
  3. RPC 命令接线。
- Acceptance criteria: 契约更新版本化可审计且未授权更新仅成 proposal；压缩后约束逐字出现在请求中；recall_exact 往返字节一致。
- Verification method: vitest + `npm run check`。
- Validation evidence: 2026-08-22 contract-and-recall.test.ts 4/4：setTaskContract 创建 v1 并在压缩后逐字置顶；updateTaskContract 产生 v2 且历史可审计；未授权更新仅 pending proposal；recall_exact 默认注册且字节级往返；未知 ref 抛错 fail closed。RPC 接线 set/get_task_contract 完成。连带更新 default-tools-setting.test.ts（新内建工具的既有列表断言 +recall_exact，意图保留）。check exit 0。
- Blocker: None.
- Unblock condition: None.

### [x] T-302 — 子系统持久化接线 + Tool Ledger 回填

- Status: done
- Owner: coordinator
- Objective: 事件日志/工件/契约/快照落盘到会话级目录（重启存活）；新增 JsonlSnapshotStore；工具执行生命周期（planned/started/succeeded/failed/unknown）经 ledger 事件写入事件日志，含 sideEffectClass/riskLevel 分类。
- Inputs and prerequisites: T-301；JsonlEventLog/FileSystemArtifactStore/JsonlContractStore 已实现。
- Scope or files: `session-integration.ts`（目录解析与后端切换）、新 `snapshot-store` JSONL 实现、agent-session 工具钩子回填、测试。
- Expected output: 会话重启后子系统状态可恢复（事件/工件/契约/快照可读）；ledger 事件随真实工具执行产生且可 replay。
- Dependencies: T-301。
- Execution steps:
  1. 失败测试先行（持久化往返、ledger 回填）。
  2. 实现并接线。
- Acceptance criteria: 重启恢复测试通过；bash/edit/write 分类正确；replayLedger 与实时一致；--no-session 保持内存后端。
- Verification method: vitest + check。
- Validation evidence: 2026-08-22 durability-ledger.test.ts 4/4：事件日志/契约/快照经 SessionManager.open 重启后完整可读（JsonlEventLog/FileSystemArtifactStore/JsonlContractStore/新 JsonlSnapshotStore 落盘于 <sessionDir>/hf/<sessionId>/）；in-memory 会话保持内存后端；真实工具执行产生分类 ledger 事件（probe→succeeded；bash exit 3→failed、process/high）；replayLedger 与实时一致；abort 将 in-flight 标 unknown。test-harness 新增 sessionManager 覆盖选项。连带更新 3592/5109 回归（recall_exact 入默认工具集的断言）。./test.sh 全套件 exit 0。
- Blocker: None.
- Unblock condition: None.

### [x] T-303 — 提交固化（仅本任务文件）

- Status: done

- Owner: coordinator
- Objective: 按 AGENTS.md Git 规则只提交本任务触碰的文件（subsystem/、eval/、agent-session.ts、compaction.ts、index.ts、两个 harness、迁移测试、docs、AGENTS.md、任务文档），不碰他 session 的 grok-tui 改动。
- Inputs and prerequisites: T-301、T-302 完成且全绿；用户指令已含提交授权（"开始实施"针对含提交的建议）。
- Scope or files: 上述清单的显式 `git add <path>`。
- Expected output: 一个或少量语义化 commit。
- Dependencies: T-301, T-302。
- Execution steps:
  1. `git status` 核对清单。
  2. 显式路径 add + commit。
- Acceptance criteria: commit 只含本任务文件；check 与测试绿。
- Verification method: git show --stat。
- Validation evidence: 2026-08-22 commit `885104573`（91 文件，+14330/−1587）：git show --stat 核对全部为且仅为本任务文件；他 session 的 grok-tui 等 28 项改动零触碰；提交前 ./test.sh exit 0、npm run check exit 0。
- Blocker: None.
- Unblock condition: None.

### [x] T-304 — 多模型门槛复测

- Status: done
- Owner: unassigned
- Objective: 用 T-104/T-107 runner 对 Anthropic/OpenAI 等第二、第三模型跑真实评测，确认 token 门槛与保真指标跨模型稳定。
- Inputs and prerequisites: T-107 batch runner；新 AGENTS.md 真实 API 规则。
- Scope or files: eval 运行配置。
- Expected output: 各模型评测报告入档。
- Dependencies: T-107。
- Execution steps:
  1. 请求用户批准目标模型的真实 API 调用。
  2. 运行并记录。
- Acceptance criteria: 报告入档。
- Verification method: 真实评测输出。
- Validation evidence: 2026-08-23 用户明确授权真实模型调用。环境可用额外 provider 为 `openai-codex`（无 Anthropic 凭据），因此以第二、第三模型完成 100 条真实 pi-mono 会话前缀、2 轮压缩门槛复测：`gpt-5.4-mini` 2/2 激活、F/C/T/P 与 overall retention 100%、oracle 一致、42306→11295 tokens（−73.3%）；`gpt-5.4` 2/2 激活、同类保真 100%、oracle 一致、42305→11927（−71.8%）。两模型均超过 40% token 门槛。稳定 id/parentId 后隔离 staged-tree 缓存复跑 2/2 通过且 615ms、指标逐位一致，无新增 API 调用。真实复测暴露并修复：手动 runner 缺少生产 HTTP dispatcher；provider-neutral prompt 未列 item schema；模型将 provenance 写成 seq/唯一 UUID 前缀，现由确定性唯一映射规范化，未知/歧义引用仍 fail closed。目标回归 40 files：38 passed / 2 real-model gates skipped，317 passed / 8 skipped；T-304 五个变更文件 scoped biome 零问题。根静态复跑当前仅被并行会话的 `harness-service.ts`/`harness-service.test.ts` 在途格式与 `PromptInput` 类型错误阻塞。
- Blocker: None.
- Unblock condition: None.

### [ ] T-305 — 生产灰度（外部部署面）

- Status: blocked
- Owner: unassigned
- Objective: 按 runbook 在部署方环境执行 shadow→canary 顺序并接入熔断监控。
- Inputs and prerequisites: 部署方环境。
- Scope or files: 生产配置。
- Expected output: 上线记录。
- Dependencies: T-303。
- Execution steps:
  1. 部署方提供环境。
  2. 按 runbook 执行。
- Acceptance criteria: 任务书 §九 DoD 全项。
- Verification method: 生产演练。
- Validation evidence: 2026-08-22 环境事实：.edru UNK-002 确认仓库内无生产服务组合；本地无部署面。
- Blocker: 本仓库无外部生产部署面（.edru UNK-002），需部署方环境。
- Unblock condition: 部署方环境就绪。

### [x] T-306 — goal 蒸馏为 proposal（不信任锚点自动落盘）

- Status: done
- Owner: coordinator
- Objective: 首次压缩时用 compactor 将当前任务蒸馏为清晰 goal 表述，作为 unconfirmed derivedGoal（带 provenance）；渲染标注"自动派生待确认"；用户确认后经 updateTaskContract 晋升为 verified goal（新版本+审计）；原始派生文本保留为回退。
- Inputs and prerequisites: 用户设计决策（2026-08-22：goal 应提炼而非引用原文；我补充信任边界约束并获其隐含认可）；proposal 流与注入防护已就位。
- Scope or files: `types.ts`（derivedGoal 可选字段）、`session-integration.ts`（蒸馏调用+确认 API）、`prompt-builder.ts`（渲染）、测试 `contract-goal-distill.test.ts`。
- Expected output: 蒸馏 goal 不自动成为权威；确认后版本化生效；注入文本无法借蒸馏操纵锚点。
- Dependencies: T-301。
- Execution steps:
  1. 失败测试先行。
  2. 实现蒸馏+确认流。
- Acceptance criteria: 未确认 derivedGoal 永不渲染为权威 goal；确认后新版本 goal=蒸馏文本；蒸馏失败回退原始派生；注入样本不产生 goal 变更。
- Verification method: vitest + check。
- Validation evidence: 2026-08-22 contract-goal-distill.test.ts 5/5：蒸馏为 unconfirmed derivedGoal（goal 字段不受污染）；渲染标注 auto-derived unconfirmed；confirmDerivedGoal 晋升为新版本（v3，全审计链 create→propose→approve×2）；无 pending 时确认报错；注入蒸馏文本不落盘且 goal 不受操纵。injection-guard 增加 goal-hijack 模式（ignore/disregard constraints/goals）。迁移三处队列序（蒸馏每会话仅一次）；6647 种子消息改短以豁免蒸馏。test.sh exit 0 + check exit 0。commit b59d2e6bd（13 文件）。
- Blocker: None.
- Unblock condition: None.

### [x] T-401 — Task Ledger 数据模型与事件溯源存储

- Status: done
- Owner: coordinator
- Objective: 版本化 TaskContract 集合 + focus 指针 + 任务操作（CREATE/REFINE/EXTEND/SUBTASK/SET_FOCUS/SUSPEND/RESUME/CANCEL/SUPERSEDE/REOPEN/ADD_CONSTRAINT/RELAX_CONSTRAINT/ADD_ACCEPTANCE_CRITERION）；goal 双表示（verbatim_source_refs 权威 + normalized 可追溯）；全部经事件溯源（ledger 事件入事件日志）；不变量 G1-G7 由确定性代码强制。
- Inputs and prerequisites: 用户设计修正（2026-08-22 长文）；既有 contract store/reducer/CAS。
- Scope or files: `subsystem/task-ledger.ts` + `test/compaction-subsystem/task-ledger.test.ts`。
- Expected output: TaskLedger（创建/操作/版本/焦点/审计）；非法操作显式拒绝；新任务不隐式完成旧任务；replay 一致。
- Dependencies: T-306。
- Execution steps:
  1. 失败测试先行（操作语义矩阵 + 不变量）。
  2. 实现。
- Acceptance criteria: 用户十二节示例的 T1→T2→T3 序列可完整表达；G1/G2/G3/G6/G7 有测试锁定。
- Verification method: vitest。
- Validation evidence: 2026-08-23 `task-ledger.test.ts` 与 runtime/restart 联测通过：不可变读边界、SUPERSEDE replay、focus stack、no-op/悬空依赖拒绝、strict verified-user source/evidence、完整 pending proposal、单记录原子 accept/reject、持久化重启恢复均锁定；纳入目标汇总 312 passed / 6 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-402 — Goal Interpreter：proposal→校验→提交 + 歧义 pending

- Status: done
- Owner: coordinator
- Objective: 新用户消息经 compactor 产出 GoalDeltaProposal（operation/target/goal 文本/source_event_id）；确定性校验（目标存在性、操作合法性、授权、冲突、不得错误取消未完成项）；合法则提交新版本；歧义则存 pending_goal_change（不破坏旧状态）；危险操作（删目标/取消/放宽权限/扩预算/宣布完成/改验收）永远只能由用户事件触发。
- Inputs and prerequisites: T-401；injection-guard；extractor 的 untrusted 包装模式。
- Scope or files: `subsystem/goal-interpreter.ts` + 测试。
- Expected output: interpretGoalChange(events, message, ledger, complete) → committed version | pending | rejected。
- Dependencies: T-401。
- Execution steps:
  1. 失败测试先行（操作分类矩阵、歧义 pending、注入防护、危险操作拒绝）。
  2. 实现。
- Acceptance criteria: G4/G5/G10 锁定；歧义输入不产生破坏更新。
- Verification method: vitest。
- Validation evidence: 2026-08-23 `goal-interpreter.test.ts` + `task-ledger-runtime.test.ts`：显式 verified actor、模型 authority 伪造覆盖、权限/预算/完成等危险操作与歧义 pending、provider/schema fail-closed、消息流接线、同轮 pending 警告与 SDK accept/reject 全过；纳入目标汇总 312 passed / 6 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-403 — Prompt Builder 分层回填 + orchestrator 绑定 task_ledger_version CAS

- Status: done
- Owner: coordinator
- Objective: pinned 层改为 GlobalContract + CurrentFocusTaskContract（完整）+ 跨任务约束 + NonTerminalTaskIndex + PendingGoalChanges；快照只存 task_contract_ref（task://T3/v2），不复制 goal 权威文本；compaction candidate 记录并 CAS 校验 task_ledger_version/focus_task_id/contract_version，版本漂移则拒绝。
- Inputs and prerequisites: T-401、T-402；prompt-builder/orchestrator 既有结构。
- Scope or files: `prompt-builder.ts`、`orchestrator.ts`、`snapshot-store.ts`（CAS 扩展）、`validator.ts`（contract 覆盖检查适配多任务）、测试。
- Expected output: 每层回填内容正确分层；压缩期间任务变更导致候选拒绝。
- Dependencies: T-402。
- Execution steps:
  1. 失败测试先行（分层渲染、CAS 版本漂移拒绝）。
  2. 实现。
- Acceptance criteria: G8/G9 锁定；快照不复制 goal 权威文本；旧 goal 只能以低权威历史出现。
- Verification method: vitest。
- Validation evidence: 2026-08-23 `prompt-builder`/`snapshot-store`/`validator`/`ledger-cas` 测试通过：完整 focus 层、跨任务约束顺序、stable task ref、offload/rebuild ref、最终激活瞬间 ledger/focus/contract CAS race、snapshot 深层不可变与持久化失败回滚均锁定；纳入目标汇总 312 passed / 6 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-404 — 任务书 §4.2 修订 + ADR 更新 + 全量验证

- Status: done
- Owner: coordinator
- Objective: 按用户提供的修订文本更新原任务书 §4.2；ADR-2/ADR-3 增补 Task Ledger 层与 G1-G10 不变量映射；既有 contract 相关测试与新默认行为对齐；test.sh + check 全绿。
- Inputs and prerequisites: T-401..T-403 与 T-405 完成；用户修订文本。
- Scope or files: 任务书 md、`docs/compaction/02-architecture-adr.md`。
- Expected output: 文档与实现一致。
- Dependencies: T-401, T-402, T-403, T-405。
- Execution steps:
  1. 文档修订。
  2. 全量验证。
- Acceptance criteria: 文档与代码一致；全绿。
- Verification method: 命令输出记录。
- Validation evidence: 2026-08-23 已修订原任务书 §4.2 与 ADR-2/ADR-3/ADR-7。任务相关目标集 39 files（38 passed, 1 real-model gate skipped），312 passed / 6 skipped。2026-08-23 根级 `npm run check` exit 0：Biome 检查 1205 文件且明确 `No fixes applied`，pinned deps、TS relative imports、shrinkwrap/install lock、`tsgo --noEmit` 与 browser smoke 全过。随后 `./test.sh` exit 0：scripts 与全部 workspaces 全绿，其中 agent 464 passed / 1 skipped、AI 930 / 831、coding-agent 2263 / 53、subagent 107 / 0，其余 workspace 亦全部通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-405 — Runtime 接线与 TUI `/contract` 交互闭环

- Status: done
- Owner: coordinator
- Objective: 将 Task Ledger 与 Goal Interpreter 接入真实 AgentSession 用户消息流，并提供 `/contract` 查看、设置、确认 derived goal、列出与接受/拒绝 pending goal change 的交互命令；确认必须重新执行确定性校验并原子提交，拒绝只关闭 proposal。
- Inputs and prerequisites: 用户于 2026-08-23 明确授权接管 TUI 交互命令；T-401..T-403。
- Scope or files: `subsystem/session-integration.ts`、`agent-session.ts`、`modes/interactive/interactive-mode.ts`、`core/slash-commands.ts`，以及目标交互/集成测试；必要时补齐 RPC/SDK 类型，但不新增第二套状态源。
- Expected output: 新用户消息产生可追溯 task proposal；`/contract` 显示权威 contract、焦点任务与 pending；mutating 子命令在 session 空闲时执行；accept/reject 后 prompt 与 ledger 状态立即一致。
- Dependencies: T-403。
- Execution steps:
  1. 先补失败测试锁定消息接线、pending 保真与 accept/reject 原子语义。
  2. 接入 HfCompactionHost/AgentSession 公共 API。
  3. 按现有 built-in slash-command 模式接入 `/contract` 与 autocomplete。
  4. 运行目标测试、交互 tmux smoke、check。
- Acceptance criteria: `/contract`、`set`、`confirm`、`pending`、`accept`、`reject` 均有可观察结果；无 proposal 时错误明确；歧义 accept 必须显式选择候选；危险操作不能绕过 verified user authority；无 TUI 时 SDK 仍可完成同一状态转换。
- Verification method: 目标 vitest + interactive 测试 + tmux smoke + `npm run check`。
- Validation evidence: 2026-08-23 `interactive-mode-contract-command.test.ts` 6/6；AgentSession/host runtime + durability tests 5/5；真实 tmux smoke（无 API）验证 `/contract` 空态显示与 `/contract set Verify TUI wiring` 后 T1 v1/global contract/ledger 同步显示。SDK 公共方法与同轮 pending provider warning 有集成测试。目标汇总 312 passed / 6 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-406 — 生产自动触发统一到 HF Trigger Policy

- Status: done
- Owner: coordinator
- Objective: 移除 live `contextWindow-reserveTokens` 双轨判定；AgentSession 自动检查统一消费 `evaluateTriggers()`，以可观测的完整下一请求预测、可回收 tool payload、overflow、cooldown 与增量次数形成唯一 TriggerDecision；phase/drift/pre-tool high-risk 因无可靠生产来源，不伪造信号并从生产承诺中明确标记未支持。
- Inputs and prerequisites: 2026-08-23 自动 compact 核查；T-201、T-401..T-405。
- Scope or files: `agent-session.ts`、`subsystem/trigger.ts`、`session-integration.ts`、`payload-offload.ts`、相关 trigger/auto-compaction 测试。
- Expected output: 70% soft、85% hard、独立 offload、overflow、cooldown 与可观测 trigger reason 在真实 runtime 生效；现有 retry/queue/stale-usage 保护保持。
- Dependencies: T-405。
- Execution steps:
  1. 先补 live integration 失败测试，证明当前 70%/offload/cooldown 未接线。
  2. 在 HF host 构造纯 TriggerInput，AgentSession 只消费 TriggerDecision。
  3. 保留 overflow 一次 compact-and-retry 与跨模型/旧边界 guard。
- Acceptance criteria: live 路径不再调用 `shouldCompact()`；70%/85% 边界、tool-only offload、cooldown 与 overflow 均有 runtime 测试；失败/取消/shadow 不提前删 live message、不消费 recovery attempt；无模型/host/disabled 时不触发。
- Verification method: 目标 vitest + scoped biome/tsgo。
- Validation evidence: 2026-08-23 live AgentSession 已移除 `shouldCompact()` 调用，统一经 `HfCompactionHost.evaluateCompactionTrigger()`；runtime tests 锁定 70% soft/85% hard、独立 tool offload、一个用户 turn cooldown、overflow、完整 pending turn/图片 token、HF stale boundary。失败/取消/shadow 保持 live context 与 recovery allowance；offload 成功立即安装 preview/ref 投影，shadow/reject/CAS orphan 不影响 active trigger。目标 aggregate 纳入 341 passed / 8 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-407 — Runtime full rebuild 与 durable trigger state

- Status: done
- Owner: coordinator
- Objective: 为生产 host 注入 `rawRebuild` runner，持久记录 incremental/rebuild 类型并据此执行 8 次增量后的 full rebuild；shadow 永不激活，rebuild 继续受 CAS/contract/task-ledger 保护。
- Inputs and prerequisites: T-406；既有 `rawRebuild()` 与 orchestrator full_rebuild 分支。
- Scope or files: `types.ts`、`rebuild.ts`、`orchestrator.ts`、`session-integration.ts`、snapshot/rebuild/runtime 测试。
- Expected output: 重启后仍能计算 since-rebuild；完成 8 次 incremental 后的下一次检查选择 deterministic rebuild；shadow 只产候选/审计不改 active；缺失 artifact 显式记录但不伪造。
- Dependencies: T-406。
- Execution steps:
  1. 失败测试锁定 runtime runner 缺失、重启计数和 shadow 不激活。
  2. 添加最小可选 snapshot compactor kind，并从 snapshot store 确定性恢复计数。
  3. 注入 rawRebuild 并复用现有最终 CAS。
- Acceptance criteria: `raw rebuild unavailable` 不再出现在正常 runtime；重启/第 8 次后下一检查/shadow/CAS 测试通过；旧 snapshot 缺少 kind 时安全按 incremental 处理。
- Verification method: 目标 vitest + snapshot JSONL 往返。
- Validation evidence: 2026-08-23 snapshot `compactor.kind/triggerEventSeq/triggerHeadEventId` 持久化；active parent lineage 排除 offload/shadow/CAS loser 并在 rebuild 重置。生产 host 注入 frozen-boundary rawRebuild；语义 tail 不被无模型 rebuild 覆盖；dangling/new recall refs、shadow、CAS、重启恢复、commit-event reconciliation 均有目标测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-408 — 触发文档对齐与全量回归

- Status: done
- Owner: coordinator
- Objective: 删除过时 legacy/default-off 注释，记录 live trigger 的唯一公式、动作与 fallback；完成目标、根静态和全仓测试。
- Inputs and prerequisites: T-406、T-407。
- Scope or files: 相关源码注释、ADR/任务账本、测试证据。
- Expected output: 文档、注释、生产控制流一致，无第二套未接线策略。
- Dependencies: T-406, T-407。
- Execution steps:
  1. 对抗复核 trigger→attempt→activate/reject 全链路。
  2. 运行目标测试、`npm run check`、`./test.sh`，核对共享 worktree 自动改写范围。
- Acceptance criteria: 生产调用图可从 AgentSession 追到 `evaluateTriggers()`；过时 legacy/default-off 说法清除；所有可执行验证全绿或仅记录无关并行 blocker。
- Verification method: rg 调用图 + vitest + check + test.sh。
- Validation evidence: 2026-08-23 ADR 与源码注释已对齐唯一 live trigger，`rg` 确认 AgentSession 不再调用 `shouldCompact()` 且三处自动入口均走 `evaluateCompactionTrigger()`→`evaluateTriggers()`。目标 aggregate 42 files：40 passed / 2 real gates skipped，341 passed / 8 skipped。根 `npm run check` exit 0（Biome 1186 files、No fixes applied，全部静态门通过）；`./test.sh` exit 0，coding-agent 272 passed / 8 skipped、2294 passed / 55 skipped，其他全部 workspace 全绿。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 每模块：独立 vitest 文件，`cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/compaction-subsystem/<name>.test.ts`。先写失败测试再实现（任务书 §八.2）。
- LLM 依赖：全部经注入 `CompleteFn`（与 completeSimple 签名对齐的最小接口）；测试用可控 faux 实现，覆盖正常/空输出/schema 坏/膨胀/超时/注入分支。禁真实 provider（F-006）。
- 集成：orchestrator 端到端（faux LLM + InMemory 存储）；Jsonl 后端单独测持久化语义。
- 漂移与故障：T-020 矩阵。
- 仓库级：`npm run check`（全量输出）必须零错误/警告/信息。
- 不做：`npm run build`、`npm test`、全量 vitest（含 e2e）——遵守 AGENTS.md。
- 回归保证：不修改既有文件；新增目录不进入任何既有 import 图（仅测试引用）。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- RSK-A（范围）：EPIC 为 G0-G5 全集，本 run 只能诚实交付 G0-G3 + 单元级 G4；G5 与真实模型门槛标记 blocked（T-900）。缓解：任务文档显式记录，交付格式按任务书 §八 汇报。
- RSK-B（worktree 共享）：他 session 有未提交改动（F-007）。缓解：只新增文件；不运行任何 git 写操作；`npm run check` 若因他 session 文件报错，逐条甄别并只修自己的。
- RSK-C（双会话架构，.edru RSK-003）：误在 harness 脚手架层实现。缓解：F-002 已定型目标为 coding-agent 成熟路径；子系统独立目录，不依赖 harness。
- RSK-D（类型/编译）：erasable TS 约束（F-008）与无 any。缓解：逐文件 `npm run check` 心智校验 + 最终全量 check。
- RSK-E（保真度声明过度）：faux LLM 不能证明真实模型保真门槛。缓解：验收标准显式区分"逻辑正确性（本 run 可证）"与"模型门槛（T-900）"。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: T-408 完成：ADR/注释/call graph 对齐；根 `npm run check` exit 0（1186 files, no fixes），`./test.sh` exit 0（全部 workspace；coding-agent 2294 passed / 55 skipped）。T-406..T-408 全部 done。
- 2026-08-23: T-406/T-407 完成：live 单一 TriggerDecision（70/85、独立 offload、cooldown、overflow）、失败/取消/shadow 原子语义、offload active projection/idempotency、HF stale boundary、完整 pending turn token；durable lineage count + frozen-boundary raw rebuild + shadow/CAS/recall gap + restart projection/commit reconciliation。目标 aggregate 40 passed / 2 real gates skipped，341 passed / 8 skipped；tsgo clean。T-408 开始。
- 2026-08-23: 用户选择“限定安全修复”；T-406 解除 blocker 并恢复 in_progress。phase/drift/pre-tool high-risk 不以弱代理伪造，改为明确未支持；本轮交付可可靠验证的 token/overflow/offload/cooldown/rebuild 与失败原子性。
- 2026-08-23: T-406 设计前对抗审查发现范围分叉，转 blocked 待用户决策：限定安全接线可在现有 session 语义内完成；完整 trigger policy 还要求 branch-scoped durable state、pre-tool high-risk gate、drift/phase source，属于更大的跨层工程。未在不明确边界下修改生产代码。
- 2026-08-23: 用户要求修复自动 compact 核查发现项。登记 T-406..T-408 并开始 T-406。根因确认：live AgentSession 仍调用 legacy `shouldCompact(contextWindow-reserve)`，`evaluateTriggers()` 只有测试调用；runtime 未提供 rebuildRunner，也未持久化 cooldown/incremental/rebuild 状态。决策：单一 TriggerDecision 入口，状态从 event/snapshot/ledger 确定性恢复，不新增第二状态库。
- 2026-08-23: 用户授权真实模型后完成 T-304：openai-codex gpt-5.4-mini/gpt-5.4 在真实 100-entry 语料上均 2/2 激活、全类 100% 保真、oracle 一致、token −73.3%/−71.8%；确定性缓存复跑指标一致。修复 real-runner HTTP dispatcher、extractor schema prompt 与 seq/唯一 UUID 前缀 provenance 规范化。
- 2026-08-23: 并行会话静态阻塞解除后完成 T-404：根 `npm run check` exit 0（1205 files, no fixes applied），`./test.sh` exit 0（全部 workspace 通过）；T-401..T-405 至此全部 done。
- 2026-08-23: T-401/T-402/T-403/T-405 完成：Task Ledger/Goal Interpreter/runtime/最终 CAS 与 `/contract` 交互闭环落地；目标集 312 passed / 6 skipped，scoped biome 76 文件零问题，tmux 两条本地命令 smoke 通过。对抗复核后补强：同轮 pending 警告、Global goal 降为 legacy 非权威、event/snapshot defensive copy、task batch 单记录原子持久化、JSONL corrupt-tail fail closed。
- 2026-08-23: T-404 文档修订完成但仓库级验证 blocked：`npm run check` 仅被并行会话未跟踪 `packages/subagent/*` 阻塞；`./test.sh` 所有任务相关/其他 workspace 通过，仅 reftable watcher 一次超时，目标复跑 8/8 通过。未触碰并行会话文件。
- 2026-08-23: 用户明确授权“完成剩余工作，并接管 TUI 交互命令接线”。对账发现 T-401/T-402 仅有未提交库层实现，T-403 仅有局部 CAS/渲染，尚未接入 HfCompactionHost、AgentSession 或 TUI；登记 T-405，T-401 转 in_progress。决策：先修 ledger/replay/pending 原子确认，再做 runtime 与 `/contract`，避免只显示不能确认的假交互。
- 2026-08-22: 任务文档创建。
- 2026-08-22: 完成现状勘察：读取任务书全文、.edru 全部核心资产（passport/overview/stack/module-map/boundary/data-state/KP-001/history/risk-register）、现有 compaction.ts（全 1187 行）、session-manager.ts 关键段、agent-session.ts compaction 挂载点、AGENTS.md 规则。确认目标层为 coding-agent v3 JSONL（非 harness 脚手架）。
- 2026-08-22: 决策——子系统落地 `packages/coding-agent/src/core/compaction/subsystem/`，全部为新增文件；本 run 范围 G0-G3 + 单元级故障/漂移套件；CCTX-061/071/080/081 记入 T-900 blocked。决策——协调者串行执行（共享 types.ts + 委托代理无法跑测试，纯串行图由协调者执行）。
- 2026-08-22: 任务文档填充完成，进入 validator 校验与 T-001。
- 2026-08-22: T-001 开始（Owner: coordinator）。
- 2026-08-22: T-001 完成（docs/compaction/01-inventory-and-baseline.md，路径抽查通过）。T-002 开始（Owner: coordinator）。
- 2026-08-22: T-002 完成（docs/compaction/02-architecture-adr.md，ADR-1..9）。T-003 开始：先写失败测试。
- 2026-08-22: T-020 完成（drift 8/8 + failure-modes 7/7）。修复：extractor prompt 事件行补 eventId（provenance 可引用）；漂移 fixture 改为交错压缩（每轮新增内容），token-gain 门槛按任务书 5% 真实执行。
- 2026-08-22: 用户给出固定层设计修正长文（Session≠任务边界；Task Ledger 版本化+焦点指针；proposal-validate-commit；G1-G10 不变量；CAS 绑定 task_ledger_version；分层回填；修订 §4.2）。与其既有架构同构，登记 T-401..T-404 并开始。明确排除项：每 agent 焦点表（多 Agent 留待 CCTX-061 域）、TUI /contract 命令（等他 session 文件）。
- 2026-08-22: T-306 完成并提交 b59d2e6bd。goal 蒸馏为未确认 proposal、确认后晋升——信任边界保持。
- 2026-08-22: 用户提议 goal 应由模型提炼而非引用原始提示词。我的判断：动机同意（原文噪音多），但蒸馏文本属模型输出、不可自动成为固定层内容（信任边界）；采用既有 proposal 机制——蒸馏为 unconfirmed derivedGoal，用户确认后晋升。登记 T-306 并开始。
- 2026-08-22: 用户核实发现 goal 派生缺陷（多轮任务会话仍取首条用户消息；真实语料首条甚至是 "/mode"）。修复并提交 5ea4768f3：goal 改为取压缩时点最近的实质性用户消息（跳过斜杠命令与琐碎应答、句界截断）；显式设置的契约优先。contract-goal.test.ts 4/4；子系统 221/221；check exit 0。
- 2026-08-22: T-303 完成（commit 885104573，仅本任务 91 文件）。剩余：T-304（blocked 待用户批准其他模型真实调用）、T-305（blocked 待外部部署环境）。
- 2026-08-22: T-302 完成（持久化四件套落盘 + ledger 回填 + abort unknown 语义）。T-303 开始：提交固化。
- 2026-08-22: T-301 完成（契约填充 API + RPC + recall_exact 工具）。T-302 开始。
- 2026-08-22: T-303 收尾：docs/tasks 被并行会话 .gitignore 排除（尊重其决定），代码全部已入库，无待提交项。T-301/T-302/T-303 关闭。
- 2026-08-22: 实施期间发现并行会话（用户方）已将本任务工作提交（885104573 等）并继续深化（goal 派生修复、蒸馏 proposal、task-ledger/goal-interpreter 在途）。对账后 T-301/T-302 实质完成（证据见任务内记录）；并行会话在途文件有 2 个 lint 待其收尾（goal-interpreter.ts noImplicitAnyLet、ledger-cas.test.ts 未用导入），非本 session 文件未触碰。T-303 仅提交本任务文档。
- 2026-08-22: 用户指令"写进task，然后开始实施"——登记 T-301（固定层/召回层激活）、T-302（持久化+ledger 回填）、T-303（提交固化，已含授权）、T-304（多模型复测，blocked 待批准）、T-305（生产灰度，环境 blocked）。开始实施 T-301。
- 2026-08-22: 用户批准规则修订：AGENTS.md 的真实 API 禁令改为"默认禁止；任务确有需要且用户明确批准时允许"，并固化约束（env 手动门、只跑目标文件、不打印/持久化凭据；范例指向 real-model-eval.test.ts）。real-model-eval.test.ts 头部注释同步引用新规则。
- 2026-08-22: T-201..T-204 完成。子系统成为默认 compaction；legacy summary-only 机制移除；既有套件全部迁移通过（test.sh 隔离全绿）。EPIC-CCTX-001 仓库内全部范围完成。任务关闭（T-105 尾部保留为环境说明）。
- 2026-08-22: 用户决定：子系统成为默认并移除 legacy。两条确认：旧会话 CompactionEntry 保留读侧渲染；扩展钩子保留但废弃自定义摘要注入。登记 T-201..T-204（默认开启+完全委派 → 代码移除 → 测试迁移 → 收尾）。
- 2026-08-22: T-109/T-110/T-111 完成。生产灰度的仓库内等价最大集全部执行：shadow 接线+七类熔断演练、253k token 级全量压测（faux 4/4 + K3 4/4、−39.6%）、真实 CLI 三档对照 dogfood（full_pipeline −70.4% 且 needle 全对；shadow/off 与 legacy 逐位一致）。全量 203/203 + check exit 0。EPIC 仓库内范围至此全部完成；仅剩真正外部生产部署（本仓库不存在该面）。
- 2026-08-22: 用户授权"生产灰度环境"。事实边界：本仓库无外部生产部署面（.edru UNK-002 确认无生产服务组合），故执行等价最大集——T-109 shadow 接线+熔断演练、T-110 全量语料压测（253k token 级）、T-111 真实 CLI dogfood 灰度会话（off/shadow/full_pipeline 三档对照）。缺陷修复授权包含在内。
- 2026-08-22: T-106/T-107/T-108 完成。真实语料 K3 实测（pi-mono large-session 100 条目前缀 ≈42k tokens）：2 轮 −71.3%、4 轮 −72.0%、全类 100% 保留、oracle 一致、全激活。修复三个真实缺陷（offload 全历史作用域、适配器瘦身、抽取截断 salvage + maxTokens 缩放）。全量 195/195 + check exit 0。T-105 剩余仍仅生产灰度。
- 2026-08-22: 用户授权执行验证（分析末段的第 1/2 项工具 + K3 小语料实测）。登记 T-106/T-107/T-108。语料事实：test/fixtures/large-session.jsonl 1019 条目/974KB 真实 pi-mono 会话、before-compaction.jsonl 2.3MB。T-106 开始。
- 2026-08-22: 用户询问部署环境真实长任务语料测试方案。已交付分析（语料来源、三级执行架构、环境需求、指标口径、分阶段门禁、待补工具清单），未改代码。T-105 保持 blocked（待部署环境）。
- 2026-08-22: 用户解除凭证限制，指定使用 pi 已有 kimi-coding K3 凭据。交付受控真实评测入口（real-model-eval.test.ts，PI_REAL_MODEL_EVAL=1 手动门，绝不进 CI）。真实运行结果：coding 2/2 激活、100% 全类保留、oracle 一致、token −22%；tool-heavy 2/2、100%、−15%；drift-4 2 激活 2 拒绝（429 fail-closed 正确）。修复两个真实缺陷（schema item 级剥离；runner 防空泛通过）。T-105 剩余仅生产灰度，保持 blocked。LEARNS.md 已记录两条新教训。全量：186/186 + check exit 0。
- 2026-08-22: T-102/T-103/T-104 完成（shadow 3/3、multi-agent 7/7、eval 2/2）。全量：子系统 23 文件 186/186 通过；`npm run check` exit 0；既有回归套件全过（skip 均为既有 skipIf(!API_KEY) e2e 门）。T-105 保持 blocked（环境）。
- 2026-08-22: T-101 完成（CCTX-080 接线落地：session-integration.ts 宿主 + agent-session.ts 最小挂载 + test-harness 注入；169→174 子系统测试、69 项既有回归通过、check exit 0）。T-102 开始。
- 2026-08-22: 用户授权执行 T-900。环境事实核验：worktree 无漂移（16 个 M 文件仍为他 session 基线；HEAD 59a71b235 未变）；真实 provider 凭证无法在本环境核验（凭证探测被断路器拦截）且 AGENTS.md 禁止测试使用真实 API。决策：T-900 分解为 T-101（CCTX-080 接线，faux 可测）、T-102（CCTX-081 shadow/runbook）、T-103（CCTX-061 原语）、T-104（CCTX-071 评测骨架）、T-105（真实模型门槛，环境阻塞保持 blocked）。恢复执行。
- 2026-08-22: T-021 完成：`npm run check` exit 0；169/169 子系统测试通过；既有 compaction 回归 30 passed。docs/compaction/03-integration-seam.md 交付。biome --write 仅触及新增未跟踪文件；他 session 跟踪文件 diff 与开工前一致。
- 2026-08-22: T-013..T-019 全部红→绿完成（injection-guard 4/4、state-extractor 9/9、narrative 5/5、validator 14/14、trigger 9/9、orchestrator 11/11、rebuild 6/6）。orchestrator 期间设计修正：空压缩走 validator 拒绝路径、reject 记录审计、offload reverse-budget 语义明确。T-020 开始。
- 2026-08-22: T-007..T-012 全部红→绿完成（snapshot-store 6/6、reducer 7/7、atomic-groups 9/9、payload-offload 8/8、recall-catalog 6/6、prompt-builder 6/6）。期间修复：FileSystemArtifactStore 磁盘真相化、offload 字符串直存、effectiveRecords 语义。T-013 开始。
- 2026-08-22: T-004/T-005/T-006 红→绿：artifact-store 14/14（含 fs 防篡改 fail closed、pin GC、跨租户拒绝；修复 fs 缓存遮蔽磁盘篡改缺陷——磁盘为唯一字节真相）、event-log 17/17（单调 seq、freeze、replay、断电语义、乱序/重复加载显式报错、offload 失败保留 inline、v3 SessionEntry 适配器）、tool-ledger 8/8（状态机单调、幂等键去重、unknown 核验恢复、事件溯源重放一致）。T-007 开始。
- 2026-08-22: T-003 红→绿：task-contract.test.ts 初跑模块缺失（红），实现 types.ts/hashing.ts/task-contract.ts 后 15/15 通过。发现并修复 JsonlContractStore 重放重复版本缺陷（last-write-wins 去重）。T-004 开始。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 截至 2026-08-23，T-401..T-408 全部完成并验证：`/contract` 闭环、单一 live TriggerDecision（70/85、独立 offload、cooldown、overflow）、durable full rebuild 与失败原子性均落地。当前目标集 42 files（40 passed, 2 real gates skipped），341 passed / 8 skipped；根 `npm run check` exit 0（Biome 1186 files/no fixes、全部静态门通过）；`./test.sh` exit 0（scripts 与全部 workspaces 全绿，coding-agent 2294 passed / 55 skipped）；任务文档 validator 通过。历史真实 K3/CLI 与 T-105..T-111 证据保持有效；T-304 openai-codex gpt-5.4-mini/gpt-5.4 均全类 100% 保真、2/2 激活，token −73.3%/−71.8%。
- Remaining: T-305 仍待仓库外生产部署面。
- Limitations: Task Ledger 的 session tree 分支投影仍沿用既有 HF event-log 分支重建策略，未在本轮扩展为 branch-scoped durable ledger。
