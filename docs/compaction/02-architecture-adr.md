# CCTX-002 架构 ADR 与接口冻结

日期：2026-08-22  
状态：已冻结（本子系统 run 内）；变更需新版本 ADR  
上游：`高保真 Context Compaction 子系统——Agent 实施任务书.md`（EPIC-CCTX-001 v1.0）、`docs/compaction/01-inventory-and-baseline.md`

---

## ADR-1：目标层与落点

**决策**：子系统实现于 `packages/coding-agent/src/core/compaction/subsystem/`，目标会话系统为成熟 coding-agent v3 JSONL（SessionManager）。不使用 `packages/agent/src/harness/` 脚手架（.edru RSK-001：AgentHarness 公开方法未实现）。

**理由**：F-002/RSK-003 要求显式命名目标会话系统；现有 CLI 的真实压缩行为在 coding-agent；harness 完成度不足以承载验收。

**兼容性**：全部为新增文件；不修改既有 compaction/session-manager/agent-session；旧 summary-only 路径原样保留，退役需另行授权。

## ADR-2：四层架构与 source-of-truth 边界

| 层 | 组件（本 run 文件） | 真相地位 |
|---|---|---|
| 真相层 | `event-log.ts`（append-only EventEnvelope）、`artifact-store.ts`（content-addressed）、`tool-ledger.ts`（事件溯源 ledger） | **唯一真相**；compaction 永不删除/改写 |
| 固定层 | `task-contract.ts`（GlobalContract）、`task-ledger.ts`（版本化任务集合 + focus）、`goal-interpreter.ts`（proposal→确定性校验→提交）、`prompt-builder.ts`（分层回填） | 永不参与 compaction；每轮按 GlobalContract→完整 focus contract→跨任务约束→非终止索引→pending changes 回填 |
| 状态层 | `reducer.ts`（确定性状态）+ `state-extractor.ts`（LLM delta，代码合并）+ `snapshot-store.ts`（版本化/CAS） | 可校验状态；关键字段带 provenance；不是真相 |
| 工作层 | `narrative.ts`（叙事桥）、`atomic-groups.ts`（verbatim tail）、`recall-catalog.ts` | 有损、可重建；与 typed state 冲突时拒绝 |

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
| G5 | 模型只能提 proposal，确定性代码校验后才能提交 | `goal-interpreter.ts` + `TaskLedger.applyAtomic` |
| G6 | 创建新任务不隐式完成、取消或覆盖旧任务 | `task-ledger.ts` focus stack 与独立状态机 |
| G7 | 完成必须有可解析 evidence event 或显式用户确认 | `TaskLedger.completeTask` |
| G8 | 固定层按 Global/focus/cross-task/index/pending 分层回填 | `prompt-builder.ts` |
| G9 | snapshot 绑定 ledger/focus/contract version，最终激活原子复核 | `orchestrator.ts` + `snapshot-store.ts` final assertion |
| G10 | 歧义或危险 goal change 保留完整 proposal 并进入 pending | `goal-interpreter.ts` + `task-ledger.ts` accept/reject |

### Live 自动触发策略（唯一生产入口）

- `AgentSession` 在 agent run 结束及下一 prompt 完整组装后调用 `HfCompactionHost.evaluateCompactionTrigger()`；生产路径不再使用 legacy `contextWindow-reserveTokens`。
- 预测值覆盖 system、tools、Global/Task Ledger 固定层、active snapshot、narrative、recall、已投影 tail、完整 pending turn（含图片估算）与 output reserve。
- `>70%` 选择 SOFT，`>85%` 或 overflow 选择 HARD；可回收 tool payload 净收益达到 8192 tokens 时可独立选择 OFFLOAD_ONLY；一次成功激活后一个用户 turn 的 cooldown 只抑制 soft/offload，不抑制 hard/rebuild。
- active lineage 中完成 8 次 incremental 后，下一次检查选择 FULL_REBUILD；offload/shadow/CAS loser 不计数，rebuild 重置。kind 与 trigger branch head 随 snapshot 持久化，重启后恢复。
- raw rebuild 使用 orchestrator 已冻结边界，但 coverage 只推进到旧 active boundary；其后的语义消息继续作为 verbatim tail，避免无模型 rebuild 吞掉未抽取语义。shadow 永不激活，最终仍受 validator、contract/task-ledger assertion 与 snapshot CAS。
- phase、numeric drift、critical contradiction、pre-tool irreversible 等字段仅是有权威 detector 的显式 policy hook；默认 runtime 当前不提供弱代理。

## ADR-4：风险分级

- `low`：只读工具、纯文本消息。
- `medium`：文件系统写入（edit/write）、可逆本地操作。
- `high`：bash（任意进程/网络/删除）、外部服务写入、审批要求动作、扩展申报为高风险的工具。

高风险约束：副作用错误/约束不得由模型修补（validator repair 排除）；已知 high-risk 工具结果不参与自动 offload。`trigger.ts` 保留高风险不可逆动作前 FULL_REBUILD 的显式策略 hook，但默认 runtime 尚无可靠的 pre-dispatch irreversibility signal，因此不伪造该信号；完整 pre-tool gate 留待 branch/tool-dispatch 专项。

## ADR-5：并发模型——单写者 + CAS 激活

**决策**：会话作用域内单写者（orchestrator 串行队列）+ Snapshot Store 的 `activate(expectedVersion)` CAS。

**理由**：SessionManager 已是进程内单实例语义（.edru EV-007）；CAS 防御跨实例/未来多写者；候选与激活分离使并发 compaction 只有一个成功，败者仅留审计。

**排除方案**：数据库长事务（违反"模型调用期间不持长锁"）；last-write-wins（任务书明禁静默覆盖）。

## ADR-6：供应商中立

LLM 依赖只有一个注入点：`CompleteFn = (request: CompactionLLMRequest) => Promise<CompactionLLMResponse>`（request 含 systemPrompt/messages/maxTokens/signal/responseSchema；response 含 text/usage/stopReason）。生产适配器在集成阶段对接 pi-ai `completeSimple`（`toolChoice:"none"` 强制）。供应商托管 compaction 只能作为 CompleteFn 的 adapter 实现，**不能替代真相层**（事件日志/ledger/contract 始终本地持有）。

## ADR-7：冻结的核心 schema（v1）

所有 schema 带 `schemaVersion: 1`；演进规则：只允许增加可选字段；破坏性变更 bump `schemaVersion` 并提供迁移函数；旧 snapshot 不可读时 fail closed 回滚到可重建路径（raw rebuild）。

- **TaskContract**：`contractId, version, goal, acceptanceCriteria[], constraints[]{id,kind(positive|negative),text,authority}, permissions{allow[],deny[],approvalRequired[]}, budgets{maxTokens?,maxToolCalls?,maxDurationMs?}, outputContract?, authority, provenance, validFrom, validUntil?, allowedUpdaters[]`。
- **EventEnvelope**：`eventId, sessionId, seq, agentId, taskId?, eventType, timestamp, causalParentIds[], toolCallId?, transactionId?, payloadRef?|payload, contentHash, authority, schemaVersion`。eventType ∈ `message|tool_call|tool_result|approval|state_change|artifact|error|compaction|contract|ledger|task`。
- **LedgerEntry**：`operationId, toolCallId, idempotencyKey, sideEffectClass, riskLevel, requestRef, resultRef?, externalResourceId?, exitCode?, approval?, state, lastVerifiedAt?`；状态机 `planned→approved→started→succeeded|failed|unknown`（approved 可跳过当无需审批；迁移单调）。
- **StructuredSnapshot**：`snapshotVersion, parentVersion, baseEventSeq, lineage[], contractRef, taskLedgerRef{ledgerVersion,focusTaskId?,focusContractVersion?,taskRef?}, constraints[], facts[], decisions[], tasks[], tools, artifacts[], errors[], nextActions[], recallCatalogRefs[], sourceEventRanges[], compactor{model?,promptVersion,schemaVersion}, tokenStats, validatorReport, createdAt`。`taskRef` 采用 `task://<task_id>/v<version>`，不得复制 task goal 权威文本。
- **AtomicGroup**：`groupId, kind(turn|tool_pair|parallel_batch|tool_loop|transaction|patch_test), eventRange{fromSeq,toSeq}, tokenEstimate, closed`。
- **CoverageManifest**：`cut{afterSeq}, keptGroupIds[], compactedGroupIds[], offloadedRefs[], unclosedGroupIds[]`。
- **RecallEntry**：`refId, kind, createdAt, preview, artifactRef?, eventIds[], hash, tenant`。
- **ValidatorReport**：`passed, failures[]{code,severity(P0|P1),message,refs[]}, repaired, rebuilt, rejected, checkedAt`。

## ADR-8：降级路径

1. 生成式压缩任何 P0 失败 → 保留旧 snapshot，仅保留确定性 offload 结果（若其自身校验通过）。
2. 对象存储故障 → 保留 inline，候选可继续但记录 offload 缺口。
3. 漂移/矛盾/迭代上限 → FULL_REBUILD（从 raw events 重建，不经 LLM）。
4. 全子系统故障 → 调用方回退原 history path（集成接缝提供 feature flag 直通）。

## ADR-9：retention / tenant / authority / audit

- 事件与对象：append-only，retention 由部署策略决定；被 snapshot 引用的对象必须 pin。
- 每个事件/快照/契约版本携带 `authority`（创建主体）与审计事件；recall 校验 tenant。
- 审计事件写入事件日志自身（`eventType: compaction|contract|ledger`），保证可重放。
