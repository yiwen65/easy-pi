# Task Plan: Context Compaction Target Architecture

- Created: 2026-08-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求在 `packages/coding-agent/src/core/compaction` 审查结论基础上实施建议的目标架构。

<!-- task-doc-section:background-goal -->
## Background and goal

当前高保真 compaction 已具备事件日志、原子切分、结构化快照、CAS 激活与精确召回等基础，但活跃提示词仍可能随历史增长，增量压缩会重复处理已压缩前缀，冷层只保存瘦身文本投影，召回不可搜索，且候选阶段可能提前发布召回副作用。目标是把实现收敛为有界 Hot/Warm/Cold 分层：Hot 保留近期完整原子区间与未完成操作，Warm 保留受预算和生命周期约束的结构化状态，Cold 保留可搜索且可精确重建的原始消息/制品；压缩只消费新增事件，并在验证与 CAS 成功后原子发布。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Scope: `packages/coding-agent/src/core/compaction/subsystem` 的预算、生命周期、增量快照、事件/制品引用、原子分组、召回检索、候选发布事务；`agent-session.ts` 中自动 Goal Interpreter 接线；相应单元/集成/规模回归测试与 compaction ADR。
- Scope: 保持现有 SessionManager JSONL 为冷层事实源，保持现有 fail-closed validator、shadow 与 CAS 语义。
- Non-goal: Session v5 存储迁移、供应商 API/模型协议修改、TUI 重构、非 compaction 的既有脏改动。
- Non-goal: 删除 legacy compaction 或改变用户可见命令；如需兼容桥接，仅做目标架构所需的最小接线。
- Authority extension (2026-08-24): 用户随后明确授权修复范围外既有类型错误、运行真实供应商评测、完整构建并提交 Git；该授权仅覆盖本任务可归属改动，不包含共享工作树的其他任务内容。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 活跃快照会累积 prior facts/decisions/nextActions 和全部确定性 tool state，缺少逐区硬预算与退休策略。 | `subsystem/state-extractor.ts`, `subsystem/orchestrator.ts`, `subsystem/prompt-builder.ts` 当前实现审查。 |
| F-002 | 每次压缩把 `seq <= cut` 的完整前缀再次交给 reducer/extractor/narrative，长会话累计输入可能退化为 O(N²)。 | `subsystem/orchestrator.ts` 的 `compactedEvents` 构造与 extractor 调用。 |
| F-003 | 事件日志从 SessionEntry 生成瘦身文本事件并以 `entryId` 回指，不能独立重建多模态 AgentMessage。 | `subsystem/event-log.ts` 的 `sessionEntriesToEvents()`。 |
| F-004 | 原子分组类型声明了 turn/patch_test，但 builder 当前主要生成 transaction/tool/singleton。 | `subsystem/atomic-groups.ts` 与对应测试。 |
| F-005 | 生产 recall tool 只暴露 `recall_exact`，`RecallCatalog.search()` 未形成模型可调用的发现路径。 | `subsystem/recall-tool.ts`, `subsystem/recall-catalog.ts`。 |
| F-006 | recall catalog/pin 的持久化可发生在快照 CAS 之前，失败候选可能留下不可见或孤立副作用。 | `subsystem/orchestrator.ts` 候选装配和 `tryActivate()` 路径。 |
| F-007 | 工作树包含多个并行会话的既有修改，必须按文件边界保留且不能清理或回退。 | 2026-08-24 `git status --short`。 |
| F-008 | 根规则要求代码变更后运行 `npm run check`，但该命令会写文件且已有非本任务类型错误风险。 | `/Users/w/Projects/easy-pi/pi/AGENTS.md` 与 `LEARNS.md` 相关经验。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户所说“目标架构”指上一轮审查提出的 Hot/Warm/Cold、有界预算、真增量、无损冷层、嵌套原子区间、可搜索召回和事务化发布；影响是本任务覆盖多个 compaction 模块；通过本文验收项和实现测试验证。
- Assumption: 供应商在发请求前不提供精确 tokenizer；本轮以“最终 provider 投影 + 可注入估算器 + 最近真实 usage 校准”为可实现边界，不伪称预请求 token 为供应商精确值。
- Assumption: 现有未提交 compaction 修改属于用户/其他会话；实现必须建立在其上并只报告本轮实际差异。
- Open question: 无阻塞问题。若目标测试暴露必须迁移 Session schema 或修改 provider API，将新增 blocked 任务并请求扩权。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Active prompt 的 Hot/Warm/Recall 各区都有确定性硬预算；超预算时按生命周期/相关性退休，未完成工具、未解决错误和固定合同不得被静默丢弃。
- 连续压缩只把上次 coverage 之后的新事件交给结构化/叙事处理；FULL_REBUILD 能把 cut 推进到当前安全边界，而不是停在旧 active boundary。
- Cold 层能通过稳定引用重建文本及多模态内容块，引用内容具有可验证摘要；不在事件中复制大二进制。
- 原子切分至少覆盖完整 user→assistant/tool turn、transaction/tool loop 和 patch→test 区间，cut 不落在这些区间内部。
- 提供模型可调用的 recall 搜索与 exact 两阶段路径；只有成功激活快照引用的 catalog/pin 才对 active prompt 和触发器可见。
- 默认无 compaction 压力时不额外调用 Goal Interpreter；任务解释由明确开关/独立调度控制。
- 规模与故障测试覆盖 100/1,000/10,000 事件有界性、增量输入线性、多模态摘要一致、reject/shadow/CAS loser 无可见副作用。
- 目标 Vitest 文件通过；`npm run check` 实际运行并记录本任务内结果及任何已存在的无关阻塞。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-004 → T-006 → T-008；T-002 → T-005 → T-006；T-003 → T-006；T-004 → T-007 → T-008；T-005 → T-008；T-006 → T-008；T-008 → T-009 → T-010 → T-011。
- Parallel batches: Batch A = T-001, T-002, T-003（文件边界独立）；Batch B = T-004, T-005（依赖 Batch A 且彼此核心文件分离）；Batch C = T-006, T-007（共享契约稳定后串行接线）；Batch D = T-008（全路径验收）。
- Serialization constraints: `types.ts`/`prompt-builder.ts` 由 T-001 独占；`event-log.ts`/recall 文件由 T-002 后 T-005 串行；`orchestrator.ts`/`rebuild.ts`/`session-integration.ts` 由 T-004 后 T-006 串行；`agent-session.ts` 仅 T-007；权威任务文档仅 coordinator 修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 有界 Hot/Warm 投影与生命周期

- Status: done
- Owner: coordinator
- Objective: 建立分区预算和稳定的状态退休规则，使 active snapshot/prompt 不随历史无界增长。
- Inputs and prerequisites: F-001；现有 snapshot、prompt builder、validator 契约。
- Scope or files: `subsystem/types.ts`, `subsystem/prompt-builder.ts`, 新增投影模块及对应测试。
- Expected output: 可配置 zone budgets、生命周期/优先级投影函数、预算诊断，固定合同与关键未完成状态受保护。
- Dependencies: None.
- Execution steps:
  1. 定义预算与投影契约及默认值。
  2. 实现确定性排序、去重、退休和硬截断。
  3. 在 prompt builder 中按 zone 组装并输出诊断。
- Acceptance criteria:
  - 同一输入产生稳定输出；每区不超过配置预算。
  - unresolved/open/pinned 项优先于已解决/陈旧项，固定合同不参与淘汰。
- Verification method:
  - 运行新增 projection/prompt-builder 目标 Vitest。
- Validation evidence: `node .../vitest --run test/compaction-subsystem/active-projection.test.ts test/compaction-subsystem/prompt-builder.test.ts`：2 files、13 tests passed；目标 `npx biome check` 5 files passed；目标 `git diff --check` passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 无损 Cold 引用与可验证制品

- Status: done
- Owner: subagent:t002-cold
- Objective: 保留原始 AgentMessage 内容结构和多模态块的稳定冷层引用，同时维持事件瘦身。
- Inputs and prerequisites: F-003；现有 ArtifactStore、EventLog、SessionManager entryId。
- Scope or files: `subsystem/event-log.ts`, `subsystem/artifact-store.ts`, `subsystem/recall-catalog.ts`, 对应测试。
- Expected output: 原始消息/内容块引用、SHA-256 摘要、按 entryId/ref 精确重建路径；事件不嵌入图片二进制。
- Dependencies: None.
- Execution steps:
  1. 定义冷层消息引用和序列化边界。
  2. 在 entry→event 适配器中写入/关联内容制品。
  3. 添加文本、多块、图片 round-trip 与去重测试。
- Acceptance criteria:
  - 原始内容块 round-trip 等价且摘要一致。
  - 大二进制仅存一次，事件尺寸与二进制大小无关。
- Verification method:
  - 运行 event-log/artifact/recall 目标 Vitest。
- Validation evidence: 子代理 Cold/事件/Recall/Orchestrator 62 tests passed；coordinator 复跑 4 files、63 tests passed；目标 Biome 6 files 与 diff check passed；既有全局 tsgo 错误位于 `packages/agent/test/agent.test.ts:197`。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 嵌套原子区间

- Status: done
- Owner: subagent:t003-atoms
- Objective: 防止 cut 切断完整 turn、工具循环或 patch→test 因果区间。
- Inputs and prerequisites: F-004；现有 transaction/tool-call 配对规则。
- Scope or files: `subsystem/atomic-groups.ts`, `test/compaction-subsystem/atomic-groups.test.ts`。
- Expected output: 可嵌套/合并的 turn、transaction、tool loop、patch_test 区间与安全 cut。
- Dependencies: None.
- Execution steps:
  1. 从事件角色/工具语义构建候选区间。
  2. 合并重叠区间并保持最外层原子性。
  3. 添加交错 ledger、parallel tool、patch/test 回归。
- Acceptance criteria:
  - 任何安全 cut 都不位于已识别原子区间内部。
  - 已有 toolCallId/transaction 配对行为不回归。
- Verification method:
  - 运行 atomic-groups 目标 Vitest。
- Validation evidence: 子代理目标/邻接测试通过；coordinator 审查 diff 后补强“最后一个 turn 必须保持 open”与 closed oversized atom 硬预算行为，最终 atomic-groups 19 tests passed，目标 Biome passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 真增量压缩与容量型 rebuild

- Status: done
- Owner: coordinator
- Objective: 将 compactor 输入限定为新 coverage delta，并使 full rebuild 推进到当前安全边界。
- Inputs and prerequisites: T-001；现有 active snapshot baseEventSeq、reducer/extractor/narrative。
- Scope or files: `subsystem/orchestrator.ts`, `subsystem/rebuild.ts`, `subsystem/session-integration.ts`, `subsystem/state-extractor.ts`, 对应测试。
- Expected output: coverage checkpoint、delta 输入、capacity rebuild cut 选择、首轮/分支/恢复兼容。
- Dependencies: T-001.
- Execution steps:
  1. 区分 active coverage 与本次 cut，构造 delta events。
  2. 保持 prior snapshot 合并但不重复提交旧事件。
  3. 修正 rebuild runner 并添加累计输入线性断言。
- Acceptance criteria:
  - 第 k 轮 extractor/narrative 只接收 `(previousCoverage, cut]`。
  - FULL_REBUILD 在有新安全区间时 `baseEventSeq` 单调前进。
- Verification method:
  - 运行 orchestrator/auto-trigger/runtime rebuild 目标 Vitest。
- Validation evidence: atomic/orchestrator/auto-trigger/rebuild 4 files、58 tests passed；新增二轮 delta prompt 断言及 rebuild coverage 单调推进断言；目标 Biome 6 files passed。
- Blocker: None.
- Unblock condition: T-001 done.

### [x] T-005 — Recall 搜索与发现路径

- Status: done
- Owner: subagent:t002-cold
- Objective: 提供 search→exact 的模型可调用召回，并把无损冷层引用纳入搜索索引。
- Inputs and prerequisites: T-002；现有 RecallCatalog.search()/recallExact()。
- Scope or files: `subsystem/recall-catalog.ts`, `subsystem/recall-tool.ts`, `subsystem/session-integration.ts` 的工具注册，相关测试。
- Expected output: `recall_search` 工具、受限结果摘要、稳定 refId、与 `recall_exact` 的清晰组合。
- Dependencies: T-002.
- Execution steps:
  1. 定义搜索参数、排序、上限和返回 schema。
  2. 注册 search 工具并联通 exact。
  3. 添加空结果、限额、分支可见性和多模态元数据测试。
- Acceptance criteria:
  - 模型能先按 query/kind 搜索，再用返回 refId 精确读取。
  - 搜索结果本身有严格数量/文本预算且不泄露非 active 分支引用。
- Verification method:
  - 运行 contract-and-recall/session-integration 目标 Vitest。
- Validation evidence: recall-catalog/recall-tool 2 files、12 tests passed；coordinator 完成 AgentSession 注册后，recall-catalog/recall-tool/session-integration/contract-and-recall 目标路径复跑并纳入最终集成套件；搜索硬上限与 inactive/sibling ref fail-closed 均有回归。
- Blocker: None.
- Unblock condition: T-002 done.

### [x] T-006 — 候选发布事务与 active 可见性

- Status: done
- Owner: coordinator
- Objective: 将 catalog/pin/active snapshot 作为同一候选提交边界发布，失败路径无可见副作用。
- Inputs and prerequisites: T-002, T-003, T-004, T-005；现有 validator/shadow/CAS 流程。
- Scope or files: `subsystem/orchestrator.ts`, `subsystem/snapshot-store.ts`, `subsystem/artifact-store.ts`, `subsystem/session-integration.ts`, 对应故障注入测试。
- Expected output: staged candidate effects、CAS 成功后 commit、失败 rollback/不可见、active-ref 过滤。
- Dependencies: T-003, T-004, T-005.
- Execution steps:
  1. 把 candidate recall entries/pins 与持久化 live 状态分离。
  2. 在 CAS 成功后发布，失败时丢弃 staged effects。
  3. 用 reject/shadow/CAS loser/fault injection 验证不变量。
- Acceptance criteria:
  - 四类失败后 active prompt、visible refs、pin set 与调用前一致。
  - 成功激活后 snapshot refs 与 catalog/pins 一致可读。
- Verification method:
  - 运行 orchestrator/snapshot-store/ledger-cas 故障测试。
- Validation evidence: recall catalog 增加 CAS 补偿注册、JSONL tombstone 与 pin 恢复；orchestrator/snapshot/ledger/auto-trigger/recall 5 files、65 tests passed；新增 CAS loser 进程内与 restart 后 catalog/pin 不变量测试。
- Blocker: None.
- Unblock condition: T-003, T-004, T-005 done.

### [x] T-007 — 压缩调度与 token 计量解耦

- Status: done
- Owner: coordinator
- Objective: 无 compaction 压力时不触发额外 Goal Interpreter，并让 trigger 基于最终 provider 投影的统一估算/usage 校准。
- Inputs and prerequisites: T-004；现有 AgentSession pending provider turn 与 trigger evaluation。
- Scope or files: `core/agent-session.ts`, `subsystem/goal-interpreter.ts`, `subsystem/session-integration.ts`, `subsystem/trigger.ts`, 对应测试。
- Expected output: 明确的 task interpretation 调度开关/时机；一次构造的 provider projection token estimate；真实 usage 可校准而不伪称精确预估。
- Dependencies: T-004.
- Execution steps:
  1. 把 Goal Interpreter 从默认 post-first-user compaction 前置路径移到显式策略。
  2. 统一对最终 provider-visible messages 计量并记录 estimate provenance。
  3. 添加 no-pressure 零额外 LLM 调用及阈值回归。
- Acceptance criteria:
  - 默认无压力普通 turn 不调用 Goal Interpreter。
  - trigger 输入排除内部 ledger/control 事件，并与最终 provider 投影一致。
- Verification method:
  - 运行 goal-interpreter/auto-trigger/task-ledger runtime 目标 Vitest。
- Validation evidence: task-ledger-runtime/auto-trigger-runtime 2 files、31 tests passed；新增默认两轮普通 prompt 的 Goal Interpreter/Reconciliation 调用计数均为 0；trigger 记录 provider projection 或 recent usage floor provenance，内部 durability events 不改变估算。
- Blocker: None.
- Unblock condition: T-004 done.

### [x] T-008 — 规模、集成、静态检查与文档收口

- Status: done
- Owner: coordinator
- Objective: 对完整目标架构执行规模/故障/集成验证并更新 ADR。
- Inputs and prerequisites: T-004, T-005, T-006, T-007。
- Scope or files: compaction subsystem 测试、`docs/compaction/02-architecture-adr.md`、本任务文档。
- Expected output: 100/1,000/10,000 规模证据、目标测试结果、check 结果、目标架构/限制说明。
- Dependencies: T-004, T-005, T-006, T-007.
- Execution steps:
  1. 添加确定性规模与失败场景测试。
  2. 运行所有受影响目标 Vitest 与 `npm run check`。
  3. 审查最终 diff，更新 ADR 和本任务验证证据。
- Acceptance criteria:
  - 所有本任务目标测试通过，规模断言满足总体 acceptance。
  - ADR 明确 Hot/Warm/Cold、事务边界、token 精度边界和未实现非目标。
  - check 的本任务问题为零；若被既有无关错误阻塞，提供文件/行号证据并标记整体 partial。
- Verification method:
  - 运行列入下节的目标测试、task document validator、`git diff --check` 和 `npm run check`。
- Validation evidence: 受影响 compaction 目标套件 20 files、203 tests passed；额外 AgentSession mock/type 回归 3 files、40 tests passed；scale 100/1,000/10,000 有界与累计 delta 断言 passed；目标 Biome 与 `git diff --check` passed。根 `npm run check` 实际运行两次且无格式写入，本任务新增 tsgo 问题已清零；命令仅被既有无关 `packages/agent/test/agent.test.ts:197` 的 `string | undefined`→`string` 类型错误阻塞，因此整体标记 partial。
- Blocker: 仓库级 check 被非本任务既有类型错误 `packages/agent/test/agent.test.ts:197` 阻塞。
- Unblock condition: T-004, T-005, T-006, T-007 done.

### [x] T-009 — 修复仓库级既有类型错误

- Status: done
- Owner: coordinator
- Objective: 修复 `packages/agent/test/agent.test.ts:197` 的可选 provider system prompt 类型错误，使仓库级静态检查完成。
- Inputs and prerequisites: T-008 的 root check 失败证据；用户扩权。
- Scope or files: `packages/agent/test/agent.test.ts` 的最小空值归一化。
- Expected output: 目标 Agent 测试与根 `npm run check` 通过。
- Dependencies: T-008.
- Execution steps: 证明 `pi-ai Context.systemPrompt` 可选、添加空字符串 fallback、运行目标测试与 root check。
- Acceptance criteria: 目标 24 tests 通过；tsgo 与 browser-smoke 通过。
- Verification method: Agent 目标 Vitest；两次最终 `npm run check`。
- Validation evidence: Agent `agent.test.ts` 24 tests passed；最终 root `npm run check` passed，Biome 无额外写入，tsgo/browser-smoke 均完成。
- Blocker: None.
- Unblock condition: T-008 done.

### [x] T-010 — 真实供应商多轮评测与缺陷闭环

- Status: done
- Owner: coordinator
- Objective: 用真实供应商验证两轮增长/压缩的保留率、oracle 与 token 收益，并修复首差异。
- Inputs and prerequisites: T-009；用户明确批准真实供应商调用。
- Scope or files: compaction 计量、原子边界、recall/event-range 归档、extractor provenance 边界与 eval corpus/runner。
- Expected output: 两轮均激活、无拒绝、关键原子 100% 保留、oracle 一致、token 降幅不低于 40%。
- Dependencies: T-009.
- Execution steps: 使用独立 cache 执行 `openai-codex/gpt-5.4-mini`；按首次失败修复 fixture 闭合、真实输入计量、用户中断边界、越界 provenance 与 exact recall 覆盖。
- Acceptance criteria: `rounds activated/rejected=2/0`；F/C/T/P=1；oracle=true；gain≥40%。
- Verification method: `PI_MULTI_MODEL_EVAL=1 ... multi-model-real-eval.test.ts`。
- Validation evidence: 最终真实运行 1 file/1 test passed；34,269 → 3,530 tokens，89.7% reduction；F/C/T/P 全 1；oracle consistent；2/0。
- Blocker: None.
- Unblock condition: T-009 done.

### [x] T-011 — 全量构建与受控 Git 提交

- Status: done
- Owner: coordinator
- Objective: 完成全包构建验证，并只提交可证明归属的修复/评测改动。
- Inputs and prerequisites: T-010；共享 dirty worktree 所有权约束。
- Scope or files: root build/check；本轮无重叠 eval/extractor/durability 文件；任务文档。
- Expected output: 官方离线全量构建通过；在线构建外部阻塞有证据；Git 提交不夹带其他任务改动。
- Dependencies: T-010.
- Execution steps: 连续运行在线 build 两次；运行官方 `build:offline`；显式暂存、cached diff check、提交。
- Acceptance criteria: 全包本地编译通过；`git diff --cached --check` 通过；提交成功；共享脏改动保留。
- Verification method: `npm run build`, `npm run build:offline`, `git diff --cached --check`, `git log -1`。
- Validation evidence: 在线 build 两次均仅因 `models.dev` 10s connect timeout 中止；官方 `npm run build:offline` 全部 10 个包通过且 model data valid；提交 `935347b8a fix(coding-agent): harden compaction provider evaluation` 成功。
- Blocker: None（在线 catalog 刷新仍受外部网络限制，但不影响离线全包编译结论）。
- Unblock condition: T-010 done.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 单元：projection/prompt budget、event/artifact round-trip、atomic intervals、recall search、delta coverage。
- 集成：orchestrator activation、auto-trigger runtime、task-ledger runtime、session integration、CAS/fault paths。
- 规模：合成 100/1,000/10,000 events，断言 active zone tokens/字符数受预算约束，累计 delta 消费等于总新增事件量级。
- 静态：受影响文件目标 Vitest；`git diff --check`；代码变更后运行根 `npm run check` 并审查其写入范围。
- 安全边界：用户已明确授权真实 provider、完整构建和 Git 提交；仍不运行无关全量 `npm test`，不暂存或提交其他任务脏改动。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：共享 dirty worktree 中同文件已有用户修改。缓解：任务按文件独占，编辑前全文读取，禁止回退或批量格式化无关文件。
- 风险：硬预算可能误删重要状态。缓解：固定合同、open tool/unresolved error/pinned ref 为保护类，validator fail-closed，测试最坏情况。
- 风险：无 provider tokenizer 时无法在请求前得到精确 token。缓解：明确 provenance，以最终 provider projection 和最近 usage 校准；不把估算标记为 exact。
- 风险：`npm run check` 自动写入或被既有错误阻塞。缓解：运行前后核对精确 diff，保留无关改动并记录阻塞证据。
- 当前 blocker：无代码或静态检查 blocker。在线模型目录刷新仍受 `models.dev` 连接超时影响，官方离线全量构建已通过。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: Task document created in execute mode.
- 2026-08-24: Repository root, AGENTS.md, dirty worktree and current compaction architecture rechecked; implementation scope bounded to compaction target architecture.
- 2026-08-24: Initial dependency graph and acceptance criteria recorded; authority-document ownership reserved for coordinator.
- 2026-08-24: Initial task document validation passed.
- 2026-08-24: Batch A started: T-001 assigned to coordinator, T-002 assigned to subagent:t002-cold, T-003 assigned to subagent:t003-atoms.
- 2026-08-24: T-001 verified done: mutable zones now have deterministic hard budgets, lifecycle priority and fail-closed protected overflow; 13 target tests and target Biome passed.
- 2026-08-24: T-004 started after T-001 gate passed; coordinator owns orchestrator/rebuild/session integration delta path.
- 2026-08-24: T-003 integrated and verified done; coordinator tightened the final user turn to remain open until a following verified user turn proves closure.
- 2026-08-24: T-002 integrated and verified done; Cold AgentMessage/image manifests remain slim in events and round-trip through verified artifacts.
- 2026-08-24: T-004 verified done; extractor/narrative consume only coverage delta and full rebuild advances to the planned safe coverage.
- 2026-08-24: T-005 assigned back to the Cold/Recall subagent for search→exact discovery; T-007 started by coordinator on the independent scheduling path.
- 2026-08-24: T-005–T-007 integrated and verified; recall discovery is active-branch scoped, candidate publication compensates catalog/pins on CAS failure, and task interpretation/reconciliation are explicit opt-ins.
- 2026-08-24: T-008 target suite, 100/1,000/10,000 scale checks, Biome and diff checks passed. Repository check was rerun after fixing all task-local type errors and remains blocked only by the pre-existing out-of-scope agent test type error.
- 2026-08-24: 用户扩权后完成 T-009；可选 provider system prompt 在测试捕获点归一化，Agent 24 tests 与 root check passed。
- 2026-08-24: T-010 真实 `gpt-5.4-mini` 评测驱动修复真实输入计量、增长分轮、用户中断原子边界、越界 provenance 丢弃和 compacted event-range exact recall；最终 2/0、100% retention、89.7% reduction。
- 2026-08-24: Compaction 全套 42 files/389 tests passed（2 files/8 tests conditional skipped）；root check passed。
- 2026-08-24: 在线 build 两次均在 models.dev 外部连接超时；官方 offline full build 构建全部包成功。
- 2026-08-24: 可明确归属的评测与 extractor/durability 修复提交为 `935347b8a`；共享工作树中同文件重叠的目标架构改动保持未暂存，避免夹带其他任务内容。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001–T-011 done；compaction 全套 42 files/389 tests passed（条件跳过 8）；最终真实供应商评测 2/0、F/C/T/P=1、oracle=true、34,269→3,530（89.7%）；root check passed；官方 offline full build 全包 passed；Git 提交 `935347b8a` 成功。
- Limitations: 在线 `npm run build` 连续两次受 `models.dev` connect timeout 阻断，已由仓库官方 `npm run build:offline` 完成代码/签入模型数据的全量构建验证。共享工作树内无法证明整文件归属的既有重叠改动未被提交；本次提交仅含可精确归属的 9 个文件。
