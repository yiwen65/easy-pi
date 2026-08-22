# CCTX-001 现状盘点与 Baseline

日期：2026-08-22  
仓库：`/Users/w/Projects/easy-pi/pi` @ `59a71b235`（branch `my-pi`，dirty worktree）  
证据来源：仓库源码 + `.edru/` 接管资产（EV/KP/RSK 编号见其证据台账）

---

## 1. 系统现状映射

### 1.1 关键组件定位

| 关注点 | 位置 | 说明 |
|---|---|---|
| Agent loop | `packages/agent/src/agent.ts`（`Agent.prompt:344`）、`agent-loop.ts` | 流式 turn、工具编排、生命周期事件 |
| 会话宿主策略 | `packages/coding-agent/src/core/agent-session.ts`（3437 行热点） | prompt 守卫、重试、auto/manual compaction、持久化转发 |
| 消息模型 | pi-ai `AgentMessage`（user/assistant/toolResult/bashExecution/custom/branchSummary/compactionSummary） | provider 归一化消息 |
| 工具生命周期 | agent-loop `prepareToolCall` → 校验/hooks → 执行 → `afterToolCall` → toolResult 消息 | 错误归一化为 tool result |
| 会话存储（canonical state） | `packages/coding-agent/src/core/session-manager.ts`（1714 行），v3 JSONL 树，`CURRENT_SESSION_VERSION=3` | append + 全量重写；进程内单 SessionManager |
| 临时 prompt view | `buildSessionContext()` / `buildContextEntries()` | 由 JSONL path 投影，compaction 感知 |
| token counter | `compaction.ts: estimateTokens`（chars/4 启发式）、`estimateContextTokens`（末次 usage 外推） | 触发判断用 |
| checkpoint/重试 | AgentSession 内重试策略 + `retryAssistantCall` | compaction 摘要调用也走此重试 |
| tracing/telemetry | `packages/telemetry` + session 用量条目 | 与压缩无耦合 |
| 现行 compaction | `packages/coding-agent/src/core/compaction/compaction.ts`（1187 行） | **summary-only**：LLM 摘要替换历史 |
| harness 脚手架（非目标层） | `packages/agent/src/harness/`（AgentHarness 公开方法 reject not-implemented） | RSK-001：不得误当可用运行时 |

### 1.2 现行 compaction 行为（baseline）

- 触发：`shouldCompact(contextTokens > contextWindow - reserveTokens)`，reserve 默认 16384；另有 overflow 路径。
- 切分：`findCutPoint` 从尾部累积 `keepRecentTokens`（默认 20000），切点只允许 user/assistant/bashExecution/custom/branchSummary/compactionSummary，**不允许 toolResult**（保证不孤化 toolResult）；可切分 turn（split-turn 前缀再摘要）。
- 摘要：自由文本结构化段落（Goal/Constraints/Progress/Decisions/Next Steps/Critical Context + read/modified files），`toolChoice:"none"`，遇到 toolCall 输出抛错；瞬断走 `retryAssistantCall`。
- 落盘：`CompactionEntry{summary, firstKeptEntryId, tokensBefore, details, usage}` append 到 v3 JSONL；`buildContextEntries` 用最新 compaction 条目替换被覆盖历史。
- 与任务书的差距（核心缺陷）：
  1. 摘要是唯一的历史表示——**summary 成了事实源**（违反约束 3）。
  2. 无 TaskContract 固定层，约束随历史一起被摘要（违反约束 1）。
  3. 无事件溯源/ledger：工具完成、副作用状态只存在消息文本里（违反约束 4）。
  4. 无原子组概念：并行批次、tool loop、外部事务无保护（仅保证不切 toolResult）。
  5. 无校验、无 CAS、无版本化快照、无回滚；摘要失败仅向上抛错。
  6. 大 payload 只能随摘要丢弃，无 content-addressed 外存与 exact recall。
  7. summary-of-summary 无界：迭代更新摘要（`UPDATE_SUMMARIZATION_PROMPT`），无周期性 raw rebuild（违反约束 11）。

### 1.3 数据流与时序（引用 KP-001）

用户输入 → mode → `AgentSession.prompt` → `Agent.prompt` → `runAgentLoop` → provider 流式 → tool 校验/执行 → toolResult 回灌 → 下一 turn → `message_end` → SessionManager JSONL append → `agent_settled`。auto-compaction 在 `agent_end` 后按 `_checkCompaction` 触发；manual 经 `/compact`/RPC。

可从用户输入追踪至模型请求与最终副作用：**满足**（KP-001 步骤 1–10）。

### 1.4 状态写入点与并发覆盖风险

| 写入点 | 位置 | 风险 |
|---|---|---|
| 消息/条目 append | SessionManager（`appendFileSync`/初次 flush） | 无多进程事务；多 pi 实例共享 worktree 仅警告（.edru EV-007） |
| compaction 条目 | AgentSession `_runAutoCompaction`/`compactSession` | 与流式 run 互斥由 `_compactionAbortController` 守卫；无 CAS 概念 |
| fork/rewrite | SessionManager fork、版本迁移 | 多文件操作非原子（EV-007） |
| 模型/ thinking 条目 | model_change/thinking_level_change | 低风险 |
| 工具副作用 | 工具自身（bash/edit/write/read） | 在存储事务外；无 exactly-once 承诺（EV-005/006/014） |

### 1.5 工具风险清单（side-effecting tools 盘点）

| 工具 | 副作用类别 | 可逆性 | 幂等性现状 | 风险级 |
|---|---|---|---|---|
| `read` | 无（只读） | — | 天然幂等 | low |
| `bash` | 进程/文件系统/网络（任意） | 可能不可逆 | 无幂等键 | **high** |
| `edit` | 文件修改 | git 可回滚 | 无幂等键 | medium |
| `write` | 文件创建/覆盖 | git 可回滚 | 无幂等键 | medium |
| 扩展自定义工具 | 不定 | 不定 | 不定 | 需 metadata 申报 |
| 截断/图片处理等内部工具 | 本地临时文件 | 可逆 | — | low |

结论：bash 为高风险通用副作用入口；edit/write 中风险；扩展工具需风险申报接口（本子系统 ledger 以 `sideEffectClass` + `riskLevel` 元数据表达）。

### 1.6 Baseline 指标（静态口径）

- token 估算：chars/4（高估保守）；context = 末次 assistant usage + 尾部估算。
- 触发阈值：单阈值（contextWindow − 16384）。
- 摘要预算：history ≤ 0.8×reserveTokens；turn prefix ≤ 0.5×reserveTokens。
- 现状无任何保真度度量（无 constraint recall / pairing / provenance 概念）。

---

## 2. 任务书 §十 启动六问（基于证据的回答）

**Q1 哪些数据是不可变真相？**  
v3 JSONL 中的消息/工具调用与结果/模型与 thinking 变更/compaction 条目，以及工具副作用的外部结果（文件系统、进程、外部服务状态）。本子系统将这些统一投影为 append-only Event Envelope（消息、tool call/result、审批、状态变更、错误、compaction、工件引用），JSONL 保持权威；事件日志是其在会话作用域内的规范化副本，不删除不改写。

**Q2 哪些约束必须固定回填？**  
任务目标、验收标准、正/负向约束、审批/预算/权限/数据边界、用户明确偏好与输出格式——即 TaskContract 全部字段。现状系统中这些信息散落在用户消息与 system prompt 中，随历史被摘要；必须抽为独立可信存储并每轮完整回填。

**Q3 哪些工具可能产生不可逆副作用？**  
`bash`（任意命令，含网络/删除/发布）、`edit`/`write`（文件系统，git 可回滚属半可逆）、扩展注册的自定义工具（需申报）。ledger 以 `sideEffectClass: none|filesystem|process|network|external_service` 与 `riskLevel: low|medium|high` 标记；超时/断网结果标 `unknown`，恢复时先按 idempotency key 查询真实状态。

**Q4 哪些大内容可以无损外存？**  
工具结果中的大文本/日志（bash 输出、read 大文件、构建/测试日志）、图片以外的二进制引用、网页/PDF 内容。外存为 content-addressed 对象，活动上下文保留 call ID/status/exit code/preview/ref/hash，可无损恢复。审批记录与高风险工具结果不卸载。

**Q5 哪些状态可以由确定性 reducer 生成？**  
任务 DAG 状态迁移、工具 call/result 配对与 exit code、文件读写清单（现有 `extractFileOpsFromMessage` 的泛化）、审批状态、副作用 ledger 状态、错误清单、工件引用集合、token 统计——全部可从事件确定性推导，LLM 无权决定。

**Q6 哪些剩余叙事才需要模型压缩？**  
仅"叙事桥接"：当前进展的连贯叙述、决策理由的衔接、下一步的自然语言说明。它不承担任何唯一事实存储；关键字段必须引用 typed state 的 task/decision/error ID；与 typed state 冲突时以 typed state 为准并拒绝候选。

---

## 3. 可重复运行的 baseline 说明

本 baseline 为静态盘点（编译/测试状态见 UNK-001，遵循仓库规则未跑全量 build/test）。可重复验证方式：

1. 重读 §1.1 表中的文件路径与符号（均在指定行附近可查）。
2. 现行 compaction 行为可由既有测试复现：`packages/coding-agent/test/compaction.test.ts`、`agent-session-compaction.test.ts`、`compaction-serialization.test.ts` 等（仓库规则：用 vitest 单文件命令运行）。
3. 新子系统的对照 oracle（full-context、drift 0/1/2/4/8）由本任务 T-020 的确定性 fixture 提供。
