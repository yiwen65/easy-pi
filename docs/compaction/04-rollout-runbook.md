# CCTX-081 上线 Runbook：高保真 Context Compaction

日期：2026-08-22  
适用范围：`packages/coding-agent/src/core/compaction/subsystem/`（经 `PI_HF_COMPACTION` / `hfCompaction` 配置启用）

---

## 1. 上线顺序

1. **Shadow**：orchestrator `shadow: true`（或集成侧接入后仅生成候选）。候选不激活，指标入审计（`shadow_candidate`）。观察：候选通过率、token 投影收益、validator 失败分布。
2. **Offload-only canary**：`PI_HF_COMPACTION=offload_only`。不经 LLM；仅外存大结果 + recall。熔断监控 `offload.failed`、recall 失败率。
3. **Structured snapshot canary**：`PI_HF_COMPACTION=structured_compaction`。无 narrative；typed snapshot + CAS。
4. **低风险任务 full pipeline**：`PI_HF_COMPACTION=full_pipeline`（加 narrative 桥）。
5. **高风险工具 Agent 最后启用**：确认 ledger/审批路径与 FULL_REBUILD 前置策略生效后。

## 2. 熔断条件（任一命中即关闭 flag 回退 legacy）

| 熔断条件 | 对应信号（审计/校验器代码） |
|---|---|
| constraint 漏项 | validator P0 `contract-coverage` |
| side-effect 状态不符 | validator P0 `side-effect-monotonicity` / `tool-pairing` |
| pointer/hash 失效 | recallExact hash mismatch 异常、artifact `scanBroken()` 非空 |
| drift 超限 | 多轮评测保留率下降（T-104 runner）；trigger `driftScore` |
| token 膨胀 | validator P0 `token-gain` 连续拒绝 |
| CAS 异常 | 审计 `cas_conflict` 频率突增 |
| validator 大量失败 | 审计 `reject` + `validate{passed:false}` 比例 |

熔断动作：`PI_HF_COMPACTION` 置空/移除配置 → 立即回到原 history path（legacy compaction 未被修改）。

## 3. 故障处置手册

### 3.1 Snapshot 污染回滚
```
rollbackToVersion({ sessionId, eventLog, artifactStore, contractStore, snapshotStore, audit }, <version>)
```
选择污染前的版本；回滚只移动 active 指针，历史版本保留可审计。

### 3.2 Compactor 模型故障
症状：审计 `reject{reason:"extraction failed ..."}`。旧 snapshot 保持 active（fail closed）。处置：检查 provider/凭证；恢复后无需操作——下一轮触发会重新尝试。持续故障 → 熔断回 legacy。

### 3.3 对象存储故障
症状：`offload.failed > 0`；recallExact 抛 artifact 缺失。语义：原始 inline 内容保留在事件中，无数据丢失。处置：恢复存储；用 `rawRebuild` 重建（其 gaps 报告列出缺失对象）；`scanBroken()` 盘点。

### 3.4 Hash / pointer 错误
症状：recallExact 抛 hash mismatch（fail closed，绝不返回未校验内容）。处置：该 ref 内容视为不可用；`scanBroken()` 列出全部坏引用；受影响范围仅在被压缩区域——raw events 仍有 inline 内容时可直接从事件恢复。

### 3.5 并发冲突（双 compactor / 多实例）
症状：`cas_conflict` 审计。语义：败者候选保留可审计，胜者状态完整，无覆盖。处置：通常无需处理；频发说明存在并发写者，应收敛为单写者（每会话一个 orchestrator）。

### 3.6 多轮漂移
症状：评测保留率下降 / validator 矛盾增多。处置：trigger FULL_REBUILD（增量次数阈值、drift 阈值、关键矛盾、高风险不可逆动作前自动触发）或手动 `rawRebuild()`——从 raw events 全量重建，不经 LLM，不重复执行副作用。

### 3.7 Feature flag 一键关闭
移除 `hfCompaction` 配置或将 `PI_HF_COMPACTION` 置为其他值/不设置 → 下一请求即回原路径。子系统状态（内存/JSONL 目录）不影响既有会话文件，可独立清理。

### 3.8 用户审计与删除请求
- 审计：子系统全部操作在 `AuditTrail`（无敏感原文）；契约变更在 ContractStore 审计日志；事件日志 append-only 可重放。
- 删除：子系统状态目录独立于会话 JSONL；删除 `eventLogDir`/artifact 目录不影响 SessionManager 会话。会话删除走既有 SessionManager 流程；子系统工件随之失效（ref 失效后 recallExact fail closed）。

## 4. 上线前检查清单

- [ ] Shadow 候选通过率 ≥ 99%（faux 验证逻辑后接真实模型 shadow）
- [ ] T-104 评测在真实模型上达到任务书 §三 门槛（T-105）
- [ ] 熔断监控接入上述审计信号
- [ ] 回滚演练：rollback、raw rebuild、flag 关闭各演练一次
