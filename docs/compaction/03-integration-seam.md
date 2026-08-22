# CCTX-080 集成状态（已完成默认切换）

日期：2026-08-22（更新：默认化）  
状态：子系统**已成为 pi 默认压缩**（T-201/T-202/T-203 完成）。本文档保留为接线参考。

---

## 默认化后的行为

- 默认模式 `full_pipeline`（无配置即启用）；`PI_HF_COMPACTION=off|shadow|offload_only|structured_compaction|full_pipeline` 覆盖；`compaction.enabled=false` 完全停用自动压缩。
- legacy summary-only 机制已移除（`compact()`/`generateSummary*`/摘要 prompts）；`CompactionEntry` 读侧渲染保留（旧会话可恢复）。
- 扩展钩子 `session_before_compact`：cancel 生效；自定义摘要文本被忽略（deprecated）；`session_compact` 事件以合成（非持久化）条目通知。
- 触发调度沿用 `_checkCompaction`（threshold/overflow），预算由 settings 的 `keepRecentTokens`/`reserveTokens` 驱动；子系统 token-gain 门槛（默认 5%）与 CAS/validator 不变。

## 原集成接缝（历史参考）

## 1. 为什么本 run 不接线

- 任务书将 CCTX-080 门禁在 G4（漂移/故障/对抗的全量门槛）之后；真实模型保真度门槛（≥99.5% 精确率等）需要真实 provider 评测基础设施（CCTX-071），仓库规则禁止测试使用真实 API。
- `agent-session.ts` 是 3437 行热点文件（.edru 11-history），当前 worktree 存在他 session 的未提交改动；未经授权不触碰。
- 现行 summary-only 路径的移除/替换属于功能删除，AGENTS.md 要求先询问。

## 2. 子系统交付物

| 模块 | CCTX | 职责 |
|---|---|---|
| `types.ts` / `hashing.ts` | 002 | 冻结 schema v1、provenance、CompleteFn 供应商中立接口；canonical JSON + sha256 |
| `task-contract.ts` | 010 | 固定层：版本化契约、可信更新、proposal 通道、审计（内存 + JSONL） |
| `event-log.ts` | 011 | 真相层：append-only 事件、单调 seq、freeze/range/replay、JSONL 持久化、`sessionEntriesToEvents` 适配器、`appendWithOffload` |
| `artifact-store.ts` | 012 | content-addressed 对象存储、hash 校验 fail closed、pin/GC、内存 + 文件系统 |
| `tool-ledger.ts` | 013 | 副作用状态机、幂等键、unknown 核验恢复、事件溯源 replay |
| `snapshot-store.ts` | 020 | 不可变版本 + active 指针 + CAS 激活 + rollback + diff |
| `reducer.ts` | 021 | 事件→确定性状态；增量=全量；缺口/乱序/重复显式报错 |
| `atomic-groups.ts` | 022 | turn/tool pair/parallel batch/tool loop/transaction 原子组 + safe cut + coverage manifest |
| `prompt-builder.ts` | 023 | 冻结分区顺序、确定性 Focus View、分区 token 统计、passthrough 原路径 |
| `payload-offload.ts` | 030 | 分类、reverse budget、失败保 inline、幂等 |
| `recall-catalog.ts` | 031 | stable ref、exact recall（hash fail closed）、tenant 边界、指标 |
| `injection-guard.ts` | 060 | 版本化 compactor 策略、untrusted 包装、注入模式检测（中英） |
| `state-extractor.ts` | 040 | 严格 schema delta 抽取、确定性合并、禁改确定性字段 |
| `narrative.ts` | 041 | 有损叙事桥、冲突拒绝、预算截断 |
| `validator.ts` | 042 | 12 类 P0/P1 校验、repair→rebuild→reject 阶梯 |
| `trigger.ts` | 050 | SOFT/HARD/FULL_REBUILD 策略 + hysteresis |
| `orchestrator.ts` | 051 | 事务式编排（freeze→reduce→cut→offload→extract→narrative→validate→candidate→CAS→commit 事件） |
| `observability.ts` | 070 | 审计事件（无敏感原文） |
| `rebuild.ts` | 052 | 版本回滚 + 全量 raw rebuild + 缺口报告 + MTTR |

测试：`packages/coding-agent/test/compaction-subsystem/`（19 文件，169 用例；含 0/1/2/4/8 轮漂移、故障与对抗矩阵）。

## 3. 接线点（授权后实施）

### 3.1 生产 CompleteFn 适配器

将子系统的 `CompleteFn` 接到 pi-ai（供应商中立，约束 12）：

```ts
import { completeSimple } from "@earendil-works/pi-ai/compat";
// 适配：CompactionLLMRequest → Context；强制 toolChoice:"none"；
// 复用 completeSummarization 的 retry 策略（compaction.ts 已有 retryAssistantCall 包装）。
```

### 3.2 AgentSession 挂载

- 在 `AgentSession` 持有每会话子系统实例（contract store / event log / snapshot store / orchestrator）。事件追加挂在 `_handleAgentEvent` 的 message_end 持久化点之后（与 JSONL append 同事务边界外、失败仅记审计，不阻塞主路径）。
- 触发：`_checkCompaction` 处先评估 `evaluateTriggers`；`offload_only`/`soft_compact`/`hard_compact` 走 orchestrator；`full_rebuild` 走 rebuild。
- Prompt 组装：orchestrator 激活后，下一次请求的 context 由 `buildPrompt` 输出（system/contract/snapshot/narrative/recall/tail/input/recall-blocks）替换 `buildSessionContext` 的输出。
- `recall_exact(ref)` 注册为运行时工具（高风险动作前自动召回 contract/decision/ledger 条目）。

### 3.3 Feature flags

```
offload_only            — 只做确定性卸载（不经 LLM），其余原路径
structured_compaction   — 完整 typed snapshot 管道
full_pipeline           — 含 narrative 与自动召回
```
默认全关；关闭后 `buildPassthroughPrompt` 等价恢复原 history path（一键回滚）。

### 3.4 回滚方法

1. feature flag 关闭 → 恢复原路径（既有 compaction.ts 未改动）。
2. 运行中快照污染 → `rollbackToVersion(version)` + 审计事件。
3. 多轮漂移 → `rawRebuild` 从事件日志全量重建。
4. 全部子系统状态（contracts/events/snapshots/artifacts）独立于会话 JSONL，可整体删除而不影响既有会话文件。

## 4. 上线顺序与熔断（按任务书 CCTX-081，需生产环境）

Shadow（候选不激活，仅审计）→ offload-only canary → structured canary → 低风险 full pipeline → 高风险最后。熔断条件：constraint 漏项、side-effect mismatch、pointer/hash failure、drift 超限、token 膨胀、CAS 异常、validator 大量失败——全部已在 validator/orchestrator 中有对应 P0 代码与审计事件，接入监控即可。
