# CCTX-002 架构 ADR 与接口冻结

日期：2026-08-22  
状态：已冻结（本子系统 run 内）；变更需新版本 ADR  
上游：`高保真 Context Compaction 子系统——Agent 实施任务书.md`（EPIC-CCTX-001 v1.0）、`docs/compaction/01-inventory-and-baseline.md`

---

## ADR-1：目标层与落点

**决策**：子系统实现于 `packages/coding-agent/src/core/compaction/subsystem/`，目标会话系统为成熟 coding-agent v3 JSONL（SessionManager）。不使用 `packages/agent/src/harness/` 脚手架（.edru RSK-001：AgentHarness 公开方法未实现）。

**理由**：F-002/RSK-003 要求显式命名目标会话系统；现有 CLI 的真实压缩行为在 coding-agent；harness 完成度不足以承载验收。

**兼容性**：SessionManager JSONL 继续作为原始会话真相；`agent-session.ts` 只负责触发、provider 投影替换和 recall 工具接线。Legacy summary 数据仍可读取，但高保真模式不回退到 summary-only 写路径。

## ADR-2：四层架构与 source-of-truth 边界

| 层 | 组件（本 run 文件） | 真相地位 |
|---|---|---|
| 真相层 | `event-log.ts`（append-only EventEnvelope）、`artifact-store.ts`（content-addressed）、`tool-ledger.ts`（事件溯源 ledger） | **唯一真相**；compaction 永不删除/改写 |
| 固定层 | `task-contract.ts`（GlobalContract）、`task-ledger.ts`（版本化任务集合 + focus）、`goal-interpreter.ts`（proposal→确定性校验→提交）、`prompt-builder.ts`（分层回填） | 永不参与 compaction；每轮按 GlobalContract→完整 focus contract→跨任务约束→非终止索引→pending changes 回填 |
| 状态层 | `reducer.ts`（确定性状态）+ `state-extractor.ts`（LLM delta，代码合并）+ `snapshot-store.ts`（版本化/CAS） | 可校验状态；关键字段带 provenance；不是真相 |
| 工作层 | `narrative.ts`（叙事桥）、`atomic-groups.ts`（verbatim tail）、`recall-catalog.ts` | 有损、可重建；与 typed state 冲突时拒绝 |

### 2026-08-24：有界 Hot / Warm / Cold 运行投影

- **Hot**：当前输入、未闭合原子区间及预算内最近完整 turn/tool/transaction/patch→test 区间。`atomic-groups.ts` 先合并重叠候选，再由 `prompt-builder.ts` 按 `recentTail` 硬预算选择；protected 原子无法容纳时 fail closed，不拆分。
- **Warm**：Global/Task Contract 固定层与 active `StructuredSnapshot`。固定合同不淘汰；snapshot、narrative、recall guide 分区独立计量，snapshot 项按 open/unresolved/pinned、状态和新近性确定性退休。
- **Cold**：SessionManager entries、append-only events 与 content-addressed artifacts。每个原始 `AgentMessage` 具有可验证 manifest；图片块独立去重存储，event 只携带固定尺寸 ref/hash。Cold 是可重建真相，不受 active prompt 预算影响。
- **Recall**：`recall_search(query, kind?, limit?)` 只返回 active snapshot refs 与当前分支 visible events 的交集，并限制为 8 条、单 preview 160 字、总 preview 800 字；`recall_exact(refId)` 再做 tenant 与 SHA-256 校验。
- 默认预算：snapshot 16k、narrative 4k、recall guide 2k、recent tail 24k、exact recall 8k estimated tokens。实现支持注入 estimator；预算是 provider 请求前估算边界，不宣称供应商 tokenizer 精确值。

## ADR-3：不变量 → 唯一责任组件映射（任务书 §二 12 条）

| # | 强制约束 | 唯一责任组件 |
|---|---|---|
| 1 | TaskContract 永不 compaction，每轮回填 | `prompt-builder.ts`（组装）+ `task-contract.ts`（存储） |
| 2 | Raw events 不删除/不改写 | `event-log.ts`（append-only  API，无 update/delete） |
| 3 | 摘要不得成为 source of truth | `snapshot-store.ts` + `reducer.ts`（typed state 权威）；`narrative.ts`（标记有损） |
| 4 | 完成/副作用只能由事件、ledger、外部确认 | `reducer.ts` + `tool-ledger.ts`（extractor 对这些字段只读） |
| 5 | 不拆 tool pair/并行批/tool loop/事务 | `atomic-groups.ts`（分组 + safe cut） |
| 6 | 不盲重放副作用，先查真实状态 | `tool-ledger.ts`（unknown 态 + RecoveryQuery 接口） |
| 7 | Snapshot 关键字段带 provenance | `state-extractor.ts` 合并器强制 + `validator.ts` provenance 检查 |
| 8 | 摘要器禁工具，历史为不可信数据 | `state-extractor.ts`/`narrative.ts`（CompleteFn 契约 + untrusted 包装）+ `injection-guard.ts` |
| 9 | 空输出/坏 schema/漏约束/指针失效/膨胀/CAS 冲突 fail closed | `validator.ts` + `orchestrator.ts`（拒绝路径）+ `snapshot-store.ts`（CAS） |
| 10 | 先外存与确定性压缩，再生成式压缩 | `orchestrator.ts`（阶段顺序固定） |
| 11 | 禁止无限 summary-of-summary，周期性 raw rebuild | `trigger.ts`（FULL_REBUILD 条件）+ `rebuild.ts` |
| 12 | 不绑定单一模型供应商 | 所有 LLM 调用经注入 `CompleteFn`（对齐 pi-ai `completeSimple` 最小签名），供应商中立 |

### Task Ledger G1–G10 不变量映射

| # | 不变量 | 唯一责任组件 |
|---|---|---|
| G1 | 首条任务消息只创建 T1，不形成永久 session goal | `session-integration.ts` + `task-ledger.ts` |
| G2 | 每个 active task 的 source event 可解析且来自 verified user | `task-ledger.ts` strict event-source validation |
| G3 | task/goal/constraint 不原地修改，更新只产生新版本 | `task-ledger.ts` version history + defensive clones |
| G4 | goal、验收、权限和约束只能由 verified user event 改变 | `task-ledger.ts` authority/source checks |
| G5 | 模型只能提 proposal，确定性代码校验后才能提交；字段更新使用原子 patch | `goal-interpreter.ts` + `TaskLedger.applyAtomic`/`PATCH_TASK_CONTRACT` |
| G6 | 创建新任务不隐式完成、取消或覆盖旧任务 | `task-ledger.ts` focus stack 与独立状态机 |
| G7 | 完成必须有可解析 evidence event 或显式用户确认 | `TaskLedger.completeTask` |
| G8 | 固定层按 Global/focus/cross-task/index/pending 分层回填 | `prompt-builder.ts` |
| G9 | snapshot 绑定 branch head + ledger/focus/contract version，最终激活原子复核 | `orchestrator.ts` + `snapshot-store.ts` final assertion |
| G10 | 歧义或权限放宽保留完整 proposal 并进入 pending；批准绑定 proposal hash 与 ledger/task base version，过期则 fail closed | `goal-interpreter.ts` + `task-ledger.ts` accept/reject |

### Live TaskContract 更新与投影

- Task Ledger 在真实 compaction/显式 contract 操作时按需建立。逐 user-turn Goal Interpreter 由 `taskInterpretationEnabled: true` 明确启用；默认普通 turn 不产生额外模型调用。确定性 approval selector 仍可独立处理已存在 pending proposal。
- Goal Interpreter 输入完整 CurrentFocusTaskContract（scope、exclusions、验收、约束、权限、预算、输出契约、blockers、关系与 provenance refs）以及其他开放任务的紧凑索引；模型仍只能生成 proposal。
- `PATCH_TASK_CONTRACT` 对 scope/exclusions、验收标准、partial permissions/budgets、输出契约和 blockers 做单版本原子更新；省略字段保持原值，非法 removal/no-op 整体拒绝。
- PendingGoalChange 持久化 `baseLedgerVersion`、目标 task versions 和 canonical operations hash。批准前必须全部匹配；旧格式或任何中间 ledger 变更都返回 `STALE_PENDING`，不得静默 rebase。
- Agent loop 在 awaited user `message_end` listeners 完成后重新解析 live system prompt，再发起第一次 provider 请求。TaskContract 只存在于 system 固定层，不再追加重复的 user-role contract message。

### Branch-scoped durable ledger / snapshot

- SessionManager entry tree 仍是原始会话真相。`BranchScopedEventLog` 只在一个 session 级 append-only durable log 上建立可变读视图，不复制、不重编号、不降级 append 目标。
- 当前状态边界的 `branchId = current head entry id`；它随 append 前进，不是永久 branch label。成员归属由当前 root→head entry ancestry、event `branchHeadId`、session `entryId`、直接 source refs、tool-call identity 和 causal closure 决定。带 branch tag 的事件以 tag 为准，旧共享 causal parent 不得把 sibling event 拉入当前分支。
- 路径签名发生任何变化（含等长 sibling switch）时，TaskLedger 与 ToolLedger 都从 branch-visible events 重放并重新绑定同一个 durable view；失败时清空旧内存 ledger，禁止泄漏 sibling state。
- Snapshot `taskLedgerRef` 增加 `branchId`。SnapshotStore 独立记录实际激活历史；分支切换选择当前 ancestry 上**最深** head 对应的最新已激活 snapshot，不把未激活 candidate 或较新的浅层/sibling snapshot 当作 active。缺少显式 branch binding 的 legacy snapshot 无法安全排序，fail closed 回到 raw/session replay。
- Compaction freeze、validator 与 final CAS 同时比较 branch id、ledger version、focus 与 task contract version。Sibling 分支进展不会制造本分支假冲突；同分支 head/ledger 移动仍 fail closed。
- Task/Tool transition 先 durable append 再提交内存状态；terminal ledger write 失败必须可观察，重启 replay 与进程内状态不得分叉。
- Legacy 未标记内部事件只在能通过 entry/source/tool/causal 关系确定归属时可见；detached event 隐藏并记录 `branch_orphan_event`。

### Periodic semantic TaskContract reconciliation

- Reconciliation 是 branch-local、read-only 的对账，不是 `reconcileActiveSnapshotCommit()`（后者只补 compaction commit event）。报告绑定 branch/task/ledger/event range/evaluator policy，并用 canonical hash 形成稳定 report id。
- 确定性阶段检查 focus、verified provenance、scope/exclusion/permission/constraint contradiction 与 pending version/hash freshness；语义阶段只读取 checkpoint 后的 verified user events 和完整 focus contract。
- 语义 evaluator 经独立 `reconcileComplete`、tool-free `CompleteFn`、bounded event/character budget、response schema、operation parser 与 injection guard。Malformed/hostile/unknown-source 输出只生成 `evaluator_failure`，不能修改 TaskLedger。
- 周期 reconciliation 默认关闭；仅 `reconciliationEnabled: true` 后按配置间隔（默认 8 个 substantive user turns）运行。`/contract reconcile` 可在关闭周期调度时显式强制运行并显示 evidence/suggestions。报告作为 branch-tagged `state_change` event 持久化，checkpoint 后只扫描增量 user events。
- Suggested operations 仅供审阅，不自动 apply、不自动生成 side effect。若 evaluator 期间 branch 或 ledger 移动，report commit 拒绝并记录 `reconciliation_failed`。

### Live 自动触发策略（唯一生产入口）

- `AgentSession` 在 agent run 结束及下一 prompt 完整组装后调用 `HfCompactionHost.evaluateCompactionTrigger()`；生产路径不再使用 legacy `contextWindow-reserveTokens`。
- 预测值从最终 provider-visible projection 一次组装得到，覆盖 system、tools、Global/Task Ledger 固定层、active snapshot、narrative、recall、已投影 tail、完整 pending turn（含图片估算）与 output reserve；内部 ledger/control event 不计入。若存在压缩边界后的可信 provider usage，则只作为保守 floor，并记录 `tokenEstimateProvenance`。
- `>70%` 选择 SOFT，`>85%` 或 overflow 选择 HARD；可回收 tool payload 净收益达到 8192 tokens 时可独立选择 OFFLOAD_ONLY；一次成功激活后一个用户 turn 的 cooldown 只抑制 soft/offload，不抑制 hard/rebuild。
- active lineage 中完成 8 次 incremental 后，下一次检查选择 FULL_REBUILD；offload/shadow/CAS loser 不计数，rebuild 重置。kind 与 trigger branch head 随 snapshot 持久化，重启后恢复。
- incremental compaction 只把 `(previousCoverageSeq, cutAfterSeq]` 交给 reducer/extractor/narrative，并以 prior snapshot 为 seed；累计模型输入随新增 coverage 线性增长。raw rebuild 使用冻结边界并把 coverage 推进到当前 safe cut，避免在旧 active boundary 原地重建。shadow 永不激活，最终仍受 validator、contract/task-ledger assertion 与 snapshot CAS。
- reconciliation 现提供 branch-local semantic findings，但不会把模型 finding 自动伪装成 trigger 的 `driftScore`/`criticalContradiction`；phase、numeric drift、pre-tool irreversible 等字段仍只接受独立权威 detector。

## ADR-4：风险分级

- `low`：只读工具、纯文本消息。
- `medium`：文件系统写入（edit/write）、可逆本地操作。
- `high`：bash（任意进程/网络/删除）、外部服务写入、审批要求动作、扩展申报为高风险的工具。

高风险约束：副作用错误/约束不得由模型修补（validator repair 排除）；已知 high-risk 工具结果不参与自动 offload。`trigger.ts` 保留高风险不可逆动作前 FULL_REBUILD 的显式策略 hook，但默认 runtime 尚无可靠的 pre-dispatch irreversibility signal，因此不伪造该信号；完整 pre-tool gate 留待 branch/tool-dispatch 专项。

## ADR-5：并发模型——单写者 + CAS 激活

**决策**：会话作用域内单写者（orchestrator 串行队列）+ branch-head/ledger final assertion + Snapshot Store 的 `activate(expectedVersion)` CAS。

候选 recall 记录与 pin 在 CAS 周围作为一个补偿事务登记：成功后 snapshot refs/catalog/pins 一致；validator reject、shadow 不登记，CAS loser、外部状态漂移或 activation 持久化失败会恢复旧 catalog、追加持久化 tombstone 并恢复原 pin 所有权。工具可见性始终再与 active snapshot/branch 求交，因此审计候选不会泄漏为 live recall。

**理由**：SessionManager 已是进程内单实例语义（.edru EV-007）；CAS 防御跨实例/未来多写者；候选与激活分离使并发 compaction 只有一个成功，败者仅留审计。

**排除方案**：数据库长事务（违反"模型调用期间不持长锁"）；last-write-wins（任务书明禁静默覆盖）。

## ADR-6：供应商中立

LLM 依赖只有一个注入点：`CompleteFn = (request: CompactionLLMRequest) => Promise<CompactionLLMResponse>`（request 含 systemPrompt/messages/maxTokens/signal/responseSchema；response 含 text/usage/stopReason）。生产适配器在集成阶段对接 pi-ai `completeSimple`（`toolChoice:"none"` 强制）。供应商托管 compaction 只能作为 CompleteFn 的 adapter 实现，**不能替代真相层**（事件日志/ledger/contract 始终本地持有）。

## ADR-7：冻结的核心 schema（v1）

所有 schema 带 `schemaVersion: 1`；演进规则：只允许增加可选字段；破坏性变更 bump `schemaVersion` 并提供迁移函数；旧 snapshot 不可读时 fail closed 回滚到可重建路径（raw rebuild）。

- **TaskContract**：`contractId, version, goal, acceptanceCriteria[], constraints[]{id,kind(positive|negative),text,authority}, permissions{allow[],deny[],approvalRequired[]}, budgets{maxTokens?,maxToolCalls?,maxDurationMs?}, outputContract?, authority, provenance, validFrom, validUntil?, allowedUpdaters[]`。
- **EventEnvelope**：`eventId, sessionId, seq, agentId, taskId?, eventType, timestamp, branchHeadId?, causalParentIds[], toolCallId?, transactionId?, payloadRef?|payload, contentHash, authority, schemaVersion`。`branchHeadId` 是 additive append-boundary metadata，成员关系仍由 ancestry/causal projection 判定。eventType ∈ `message|tool_call|tool_result|approval|state_change|artifact|error|compaction|contract|ledger|task`。
- **LedgerEntry**：`operationId, toolCallId, idempotencyKey, sideEffectClass, riskLevel, requestRef, resultRef?, externalResourceId?, exitCode?, approval?, state, lastVerifiedAt?`；状态机 `planned→approved→started→succeeded|failed|unknown`（approved 可跳过当无需审批；迁移单调）。
- **StructuredSnapshot**：`snapshotVersion, parentVersion, baseEventSeq, lineage[], contractRef, taskLedgerRef{branchId?,ledgerVersion,focusTaskId?,focusContractVersion?,taskRef?}, constraints[], facts[], decisions[], tasks[], tools, artifacts[], errors[], nextActions[], recallCatalogRefs[], sourceEventRanges[], compactor{model?,promptVersion,schemaVersion}, tokenStats, validatorReport, createdAt`。`taskRef` 采用 `task://<task_id>/v<version>`，不得复制 task goal 权威文本。
- **ReconciliationReport**：`reportId, sessionId, branchId?, taskRef?, taskVersion?, ledgerVersion, fromEventSeq, toEventSeq, evaluatorPolicyVersion, findings[], reportHash, checkedAt`。finding kind ∈ `missing_delta|unsupported_contract_item|contradiction|ambiguous_focus|stale_pending|evaluator_failure`；报告只读、不得作为自动提交授权。
- **AtomicGroup**：`groupId, kind(turn|tool_pair|parallel_batch|tool_loop|transaction|patch_test), eventRange{fromSeq,toSeq}, tokenEstimate, closed`。
- **CoverageManifest**：`cut{afterSeq}, keptGroupIds[], compactedGroupIds[], offloadedRefs[], unclosedGroupIds[]`。
- **RecallEntry**：`refId, kind, createdAt, preview, artifactRef?, eventIds[], hash, tenant`。
- **ValidatorReport**：`passed, failures[]{code,severity(P0|P1),message,refs[]}, repaired, rebuilt, rejected, checkedAt`。

## ADR-8：降级路径

1. 生成式压缩任何 P0 失败 → 保留旧 snapshot；候选 offload bytes 可作为未 pin 的内容寻址对象留待 GC，但 catalog/pin 不发布。
2. 对象存储故障 → 保留 inline，候选可继续但记录 offload 缺口。
3. 漂移/矛盾/迭代上限 → FULL_REBUILD（从 raw events 重建，不经 LLM）。
4. 全子系统故障 → 调用方回退原 history path（集成接缝提供 feature flag 直通）。

## ADR-9：retention / tenant / authority / audit

- 事件与对象：append-only，retention 由部署策略决定；被 snapshot 引用的对象必须 pin。
- 每个事件/快照/契约版本携带 `authority`（创建主体）与审计事件；recall 校验 tenant。
- 审计事件写入事件日志自身（`eventType: compaction|contract|ledger`），保证可重放。
