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
| 固定层 | `task-contract.ts`（版本化 TaskContract + 审计） | 永不参与 compaction；每轮完整回填 |
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

## ADR-4：风险分级

- `low`：只读工具、纯文本消息。
- `medium`：文件系统写入（edit/write）、可逆本地操作。
- `high`：bash（任意进程/网络/删除）、外部服务写入、审批要求动作、扩展申报为高风险的工具。

高风险约束：副作用错误/约束不得由模型修补（validator repair 排除）；高风险不可逆动作前强制 FULL_REBUILD + 自动召回（trigger + recall）；高风险结果不卸载（payload-offload 排除）。

## ADR-5：并发模型——单写者 + CAS 激活

**决策**：会话作用域内单写者（orchestrator 串行队列）+ Snapshot Store 的 `activate(expectedVersion)` CAS。

**理由**：SessionManager 已是进程内单实例语义（.edru EV-007）；CAS 防御跨实例/未来多写者；候选与激活分离使并发 compaction 只有一个成功，败者仅留审计。

**排除方案**：数据库长事务（违反"模型调用期间不持长锁"）；last-write-wins（任务书明禁静默覆盖）。

## ADR-6：供应商中立

LLM 依赖只有一个注入点：`CompleteFn = (request: CompactionLLMRequest) => Promise<CompactionLLMResponse>`（request 含 systemPrompt/messages/maxTokens/signal/responseSchema；response 含 text/usage/stopReason）。生产适配器在集成阶段对接 pi-ai `completeSimple`（`toolChoice:"none"` 强制）。供应商托管 compaction 只能作为 CompleteFn 的 adapter 实现，**不能替代真相层**（事件日志/ledger/contract 始终本地持有）。

## ADR-7：冻结的核心 schema（v1）

所有 schema 带 `schemaVersion: 1`；演进规则：只允许增加可选字段；破坏性变更 bump `schemaVersion` 并提供迁移函数；旧 snapshot 不可读时 fail closed 回滚到可重建路径（raw rebuild）。

- **TaskContract**：`contractId, version, goal, acceptanceCriteria[], constraints[]{id,kind(positive|negative),text,authority}, permissions{allow[],deny[],approvalRequired[]}, budgets{maxTokens?,maxToolCalls?,maxDurationMs?}, outputContract?, authority, provenance, validFrom, validUntil?, allowedUpdaters[]`。
- **EventEnvelope**：`eventId, sessionId, seq, agentId, taskId?, eventType, timestamp, causalParentIds[], toolCallId?, transactionId?, payloadRef?|payload, contentHash, authority, schemaVersion`。eventType ∈ `message|tool_call|tool_result|approval|state_change|artifact|error|compaction|contract|ledger`。
- **LedgerEntry**：`operationId, toolCallId, idempotencyKey, sideEffectClass, riskLevel, requestRef, resultRef?, externalResourceId?, exitCode?, approval?, state, lastVerifiedAt?`；状态机 `planned→approved→started→succeeded|failed|unknown`（approved 可跳过当无需审批；迁移单调）。
- **StructuredSnapshot**：`snapshotVersion, parentVersion, baseEventSeq, lineage[], contractRef, constraints[], facts[], decisions[], tasks[], tools, artifacts[], errors[], nextActions[], recallCatalogRefs[], sourceEventRanges[], compactor{model?,promptVersion,schemaVersion}, tokenStats, validatorReport, createdAt`。
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
