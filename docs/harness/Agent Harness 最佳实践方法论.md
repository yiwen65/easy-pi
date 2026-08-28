# AI Agent Harness 最佳实践方法论

## 一、核心架构命题

AI Agent Harness 的本质，不是简单地让模型循环调用工具，而是：

> **把非确定性的模型决策，约束在可恢复、可审计、可干预、可验证的确定性控制系统中。**

系统设计应同时优化两类目标：

1. **模型决策质量**：模型是否获得了完整、相关、可信、低噪声的上下文和工具观察。
    
2. **执行可靠性**：任务是否能够在超时、崩溃、重试、取消、并发和人工干预下保持一致。
    

两者不可分割。错误恢复如果重复注入工具结果，会直接降低模型质量；上下文设计如果忽略工具副作用，则会造成执行事故。

---

# 二、统一概念模型

## 2.1 核心实体

推荐采用以下层级：

```text
Conversation
└── Branch
    └── Run
        ├── User Turn
        ├── Model Turn 0..N
        │   └── Step 0..N
        │       └── Attempt 1..N
        ├── Item 0..N
        ├── Tool Call ↔ Tool Result
        └── Artifact 0..N
```

各实体的建议语义如下。

|实体|定义|
|---|---|
|Conversation|长期对话或任务空间|
|Branch|共享历史前缀、拥有独立后续演化的分支|
|Run|为完成一个已接受目标而进行的一次执行|
|Turn|一次用户输入或一次完整模型决策|
|Step|一个可以独立持久化、恢复和重试的编排步骤|
|Attempt|同一个 Step 的一次物理执行尝试|
|Item|规范化语义对象，如消息、工具调用、工具结果、审批、摘要|
|Tool Call|一个逻辑工具操作请求|
|Tool Result|该逻辑调用对应的权威观察|
|Artifact|文件、补丁、报告、数据集、图像等大体积结果|
|Event|已经发生的不可变事实|
|Command|希望系统接下来采取的控制动作|

必须避免三个常见混淆：

- **Message 不等于所有 Item**。工具调用、审批和执行状态不应伪装成文本消息。
    
- **Run 不等于一次模型请求**。一个 Run 可以包含多轮模型推理和工具调用。
    
- **Event 不等于状态**。Event 是事实记录，状态应由 Event 和 Checkpoint 还原。
    

---

# 三、状态必须分层

推荐把系统状态分为五个平面。

|状态平面|包含内容|权威数据源|
|---|---|---|
|对话状态|用户输入、模型完整输出、工具观察、摘要、约束|追加式语义 Item/Event 账本|
|执行状态|Run、Step、Attempt、等待状态、预算、Lease|Durable Workflow 与 Checkpoint|
|控制状态|Steer、Interrupt、Cancel、Resume、审批、后续请求|有序 Command Ledger|
|展示状态|Token、进度条、阶段名称、临时状态|从权威事件生成的 Projection|
|Artifact 状态|文件、代码、数据、外部系统收据|版本化对象存储或外部系统|

核心原则：

> **展示状态不能反向成为执行状态；控制意图不能直接覆盖已发生事实；对话历史不能代替执行检查点。**

例如，用户已经看到完整文本，不代表 Run 已经完成。系统可能仍在提交状态、保存 Artifact 或处理后续审批。

---

# 四、端到端 Agent Loop

## 4.1 推荐循环

```text
接受输入
→ 创建或更新 Run
→ 编译上下文
→ 调用模型
→ 提交完整模型输出
→ 校验工具调用
→ 权限与审批
→ 执行工具
→ 提交权威工具结果
→ 再次编译上下文
→ 判断完成、暂停、重试或失败
```

参考伪代码：

```text
while run is non-terminal:

    取得或续租 Run Lease

    从已提交事件恢复状态

    在安全点应用控制命令

    if 等待审批、输入、定时器或长任务:
        持久化等待状态
        释放 Worker
        return

    if 需要模型决策:
        context = ContextCompiler(state)
        持久化 Context Manifest
        response = 调用模型
        提交完整语义 Item

    校验并分类工具调用

    if 存在工具调用:
        派发允许并行的调用
        等待必要结果或进入异步等待
        提交唯一权威观察
        continue

    检查完成条件、预算和进展

    if 已完成:
        原子提交最终结果与终态
        return
```

## 4.2 终止不能只依赖模型

Harness 必须独立判断：

- 是否已满足所需输出；
    
- 是否仍有未完成工具调用；
    
- 是否有等待中的审批或输入；
    
- 是否超过预算；
    
- 是否连续多轮没有进展；
    
- 是否重复执行同一错误计划；
    
- 是否存在未解决的外部副作用状态。
    

模型说“完成了”只是一个候选信号，不是最终状态转换的唯一依据。

---

# 五、安全点设计

运行中控制必须在明确的安全点生效。

|安全点|位置|允许的主要动作|
|---|---|---|
|SP0|模型请求之前|应用 Steer、Cancel、Interrupt、预算和策略更新|
|SP1|模型完整计划已提交、工具尚未派发|使旧计划失效并重新规划|
|SP2|工具参数已验证、外部副作用尚未开始|安全阻止执行|
|SP3|工具结果已提交、下一次模型请求之前|应用 Steer、恢复、重编译上下文|
|SP4|当前 Run 结果已提交|创建 Follow-up 或新分支|

系统应分别记录：

```text
command_accepted_at
command_effective_at
effective_safe_point
affected_plan_version
```

不要承诺控制命令在任意毫秒时刻立即改变执行。正确语义是：

> **命令立即被可靠接受，在下一个适用安全点确定性生效。**

---

# 六、工具调用方法论

## 6.1 工具必须具有四类契约

### 1. 接口契约

```text
input_schema
output_schema
error_schema
```

### 2. 语义契约

```text
preconditions
postconditions
business_invariants
```

### 3. 副作用契约

```text
read_only
idempotent
reversible
transactional
external_side_effect
```

### 4. 运行契约

```text
timeout
retry_policy
concurrency_class
isolation_level
approval_policy
cost_estimate
```

JSON Schema 只能解决参数形状问题，不能说明工具是否可重试、是否能并行、是否有不可逆副作用。

## 6.2 工具调用身份

每次工具执行至少包含：

```text
call_id        # 逻辑工具调用
step_id        # 所属编排步骤
attempt_id     # 当前物理尝试
operation_id   # 外部幂等键
```

必须保证：

- Retry 不生成新的逻辑 `call_id`；
    
- 每个 Attempt 有独立 `attempt_id`；
    
- 所有 Attempt 共享稳定 `operation_id`；
    
- 模型只看到一个权威 Tool Result。
    

正确目标不是物理上的“只执行一次”，而是：

> **允许至少一次物理执行，但保证逻辑上只观察一次结果。**

## 6.3 工具结果应结构化

不要直接把原始 stdout、日志或堆栈全部放入上下文。

推荐结果结构：

```text
status:
  success
  business_error
  validation_error
  permission_denied
  transient_error
  unknown_outcome
  cancelled

structured_data
model_summary
artifact_refs
receipts
retryability
side_effects_committed
warnings
diagnostics_ref
```

其中：

- `model_summary` 提供给模型；
    
- `diagnostics_ref` 提供给开发者和观测系统；
    
- 大体积结果通过 `artifact_refs` 引用；
    
- `unknown_outcome` 用于无法判断外部操作是否已经成功的场景。
    

## 6.4 并行调用原则

默认只并行执行满足以下条件的工具：

- 只读；
    
- 幂等；
    
- 相互独立；
    
- 不写同一资源；
    
- 不依赖其他调用结果；
    
- 能在下一次模型推理前完整汇合。
    

对于变更型工具，应采用：

- Resource Key；
    
- 冲突分类；
    
- 乐观版本；
    
- 资源级锁；
    
- Saga 或补偿动作；
    
- 或严格串行执行。
    

## 6.5 长任务

长工具调用不应长期占用一个 HTTP 请求或 Worker。

应返回：

```text
operation_handle
accepted_at
status
subscription_or_polling_handle
cancel_capability
result_schema
```

Harness 随后进入 `WAITING_TOOL`，释放 Worker，并在任务完成事件到达后恢复。

## 6.6 人工审批

审批是持久化状态转换，而不是临时 UI 弹窗。

审批必须绑定：

```text
tool_name
tool_version_hash
validated_arguments_hash
principal
permission_policy_version
run_id
call_id
expiry
```

任何工具版本、参数或权限策略变化，都必须使原审批失效。

---

# 七、上下文质量方法论

模型输出质量主要由输入上下文和工具观察质量决定。

## 7.1 使用确定性的 Context Compiler

每次模型请求的上下文都应由服务端统一编译：

```text
系统和开发者规则
+ 当前目标
+ 当前有效 Steer
+ 固定约束
+ 压缩后的相关历史
+ 未完成义务
+ 工具调用与工具结果
+ 相关 Artifact 摘要
+ 当前允许使用的工具
+ 预算、安全和输出格式约束
```

Context Compiler 的输入只能来自权威状态，而不能由客户端任意回传全部历史。

推荐保存 Context Manifest：

```text
context_manifest_id
source_item_ids
compaction_ids
artifact_versions
tool_registry_version
policy_version
compiler_version
content_hash
```

这样才能回答：

- 模型当时到底看到了什么；
    
- 崩溃恢复后上下文是否一致；
    
- 输出变化来自模型变化还是上下文变化。
    

## 7.2 工具集合应动态收窄

不要在每次请求中向模型暴露全部工具。

推荐根据以下因素动态选择：

- 当前任务阶段；
    
- 用户权限；
    
- 安全策略；
    
- 当前 Artifact 类型；
    
- 已有工具结果；
    
- 预算；
    
- 工具之间的依赖。
    

因果链：

```text
减少工具数量
→ 降低工具选择熵
→ 减少误调用
→ 降低失败观察和修复回合
→ 提高任务完成率
```

## 7.3 Compaction 不能只是摘要

Compaction 必须保留：

- 当前目标；
    
- 用户硬约束；
    
- 未完成承诺；
    
- 已确认事实；
    
- 工具调用与结果配对；
    
- 外部副作用；
    
- Artifact 引用；
    
- 审批和权限状态；
    
- 错误恢复信息。
    

推荐保存：

```text
compaction_id
input_item_range
summary_item_id
compiler_version
model_id
preserved_constraints
open_obligations
open_tool_calls
artifact_refs
source_hashes
```

旧历史不应被直接删除，而应通过 Compaction Lineage 表示其被哪个摘要替代。

---

# 八、事件流方法论

## 8.1 事件分层

|事件类型|示例|是否持久化|
|---|---|---|
|规范语义事件|完整消息、工具调用、结果、审批、最终输出|必须|
|控制与执行事件|Step、Attempt、Retry、Pause、Cancel、Checkpoint|必须|
|运维观测事件|延迟、Usage、Worker、Trace|建议进入 Telemetry|
|临时展示事件|Token Delta、音频帧、Typing、动画|不作为恢复依据|

核心原则：

> **流式 Token 是预览，不是历史。完整 Item 才是语义事实。**

## 8.2 必须持久化的事件

至少包括：

- 用户输入被接受；
    
- Run 和 Branch 创建；
    
- 模型请求 Manifest；
    
- 完整模型输出；
    
- 工具调用和验证后参数；
    
- 审批请求和决定；
    
- 工具派发、Operation ID 和最终结果；
    
- Checkpoint；
    
- Budget 消耗；
    
- Steer、Interrupt、Cancel、Resume；
    
- Compaction；
    
- Artifact 创建；
    
- Run 终态。
    

## 8.3 事件 Envelope

```text
event_id
event_type
schema_version

conversation_id
branch_id
run_id
turn_id
step_id
attempt_id
call_id

aggregate_seq
causation_id
correlation_id
parent_event_id

occurred_at
committed_at
producer
visibility
payload_ref
payload_hash
state_version
```

不需要全系统的全局总顺序，但必须保证：

- 同一 Run 内事件顺序稳定；
    
- Tool Call 与 Tool Result 因果关系明确；
    
- Branch 分叉位置明确；
    
- 并行调用有明确 Fan-out/Fan-in；
    
- 重连后不能越过尚未提交的事件。
    

## 8.4 背压与断线恢复

推荐策略：

- Canonical Event 提交不等待 UI；
    
- 每个订阅者拥有独立 Cursor；
    
- Token Delta 使用有界缓冲；
    
- 缓冲满时可合并或丢弃中间 Delta；
    
- 完整 Item、Tool Result、Approval 和终态不可丢弃；
    
- 重连从 Semantic Cursor 恢复；
    
- 无法追赶时发送 `projection_reset_required`，重新构建视图。
    

必须区分：

```text
transport_disconnected
subscriber_detached
model_request_cancelled
tool_operation_cancelled
run_cancelled
```

浏览器断线不应自动等价于 Run 取消。

---

# 九、Steer、Interrupt、Cancel、Resume、Follow-up 与 Retry

这些命令必须具有不同语义。

|命令|语义|是否创建新 Run|
|---|---|--:|
|Steer|修改当前 Run 尚未完成的目标、约束或优先级|否|
|Interrupt|暂停当前 Run，保留恢复能力|否|
|Cancel|终止当前 Run，并尽力停止在途工作|否，进入终态|
|Resume|从同一 Checkpoint 继续同一 Run|否|
|Follow-up|在当前 Run 完成后创建新的用户 Turn|是|
|Retry|对同一 Step 创建新的 Attempt|否|
|Rollback|从历史 Checkpoint 创建新的执行分支|通常创建新 Branch|

## 9.1 Steer

推荐对象：

```text
SteerCommand {
  command_id
  run_id
  control_seq
  scope:
    objective
    constraint
    priority
    tool_policy
    output_format
  content
  supersedes
  accepted_at
  expires_at
}
```

不同阶段的处理方式：

- 模型请求前：直接进入下一次上下文；
    
- 模型生成中：取消当前请求，或在完整输出后使计划失效；
    
- 工具未派发：废弃旧计划并重新规划；
    
- 工具已开始但尚无副作用：尽力取消；
    
- 副作用已经发生：只能改变后续计划，必要时执行补偿；
    
- Run 已完成：转换为 Follow-up。
    

## 9.2 Interrupt

Interrupt 是可恢复的暂停：

- 停止派发新工具；
    
- 尽力取消可取消任务；
    
- 持久化 Checkpoint；
    
- 进入 `PAUSED`；
    
- 等待 Resume。
    

## 9.3 Cancel

Cancel 是终态意图：

- 优先级高于 Steer 和普通 Retry；
    
- 撤销当前 Lease；
    
- 尽力取消在途工具；
    
- 对已发生副作用执行补偿或进入人工处理；
    
- 进入 `CANCELLED`；
    
- 不允许直接 Resume。
    

## 9.4 Follow-up

Follow-up 默认：

- 不进入当前 Run 的上下文；
    
- 等待当前 Run 在 SP4 完成；
    
- 创建新的 User Turn 和 Run；
    
- 继承已提交的最终状态；
    
- 可以单独取消、重排或升级为 Steer。
    

## 9.5 Retry

Retry 必须：

- 保持原有 Step 和逻辑 Call；
    
- 创建新的 Attempt；
    
- 复用 Operation ID；
    
- 根据错误分类决定是否重试；
    
- 设定次数、时间和预算上限。
    

---

# 十、错误恢复方法论

## 10.1 错误分类

|错误|推荐策略|
|---|---|
|参数结构错误|向模型返回结构化错误，重新生成参数|
|业务约束错误|告知违反的业务规则，不执行工具|
|权限错误|不自动重试，等待授权或审批|
|瞬时网络错误|指数退避，复用 Operation ID|
|限流|根据 Retry-After 和预算重试|
|外部业务拒绝|作为观察返回模型，不盲目重试|
|Worker 崩溃且结果未知|先查询外部收据，再决定是否重试|
|模型安全拒绝|不作为普通瞬时错误重试|
|编排代码异常|Fail Closed，禁止无限循环|

## 10.2 无进展检测

为每轮决策生成 `progress_fingerprint`：

```text
hash(
  unresolved_goals,
  world_state_version,
  successful_tool_results,
  normalized_errors,
  output_coverage
)
```

触发停止或人工接管的条件：

- 多轮 Fingerprint 不变；
    
- 相同 Tool + Args + Error 重复；
    
- 成本增长但没有新状态或 Artifact；
    
- 模型在两个计划间振荡；
    
- 修复次数超过上限。
    

---

# 十一、必须保证的系统不变量

1. 同一个 Run 同一时刻最多只有一个有效控制 Lease。
    
2. 已提交的语义 Item 不可原地修改。
    
3. Token Delta 永远不是完整 Item。
    
4. 一个逻辑工具调用只有一个 `call_id`。
    
5. 同一逻辑调用只能向模型提交一个权威结果。
    
6. 所有副作用工具执行前必须拥有稳定 `operation_id`。
    
7. 超时不能直接解释为“工具未执行”。
    
8. Resume 必须对应明确 Checkpoint。
    
9. Branch 必须记录历史与 Artifact 的分叉位置。
    
10. 审批必须绑定完整参数和版本。
    
11. 控制命令必须按 `control_seq` 顺序应用。
    
12. Cancel 优先级高于 Steer、Follow-up 和 Retry。
    
13. 相同状态和配置应生成相同 Context Manifest。
    
14. 下一次模型请求前，所需工具结果必须完整提交。
    
15. 慢消费者不得阻塞权威状态提交。
    
16. 内部状态回滚不能冒充外部副作用回滚。
    
17. 所有 Retry 都必须有明确上限。
    
18. Run 进入终态后只能创建新 Run 或 Branch，不能重新变为 Running。
    

---

# 十二、推荐参考架构

```text
用户 / API / UI
       ↓
Command API
认证、授权、幂等去重
       ↓
Control Plane
Command Ledger、Desired State、CAS
       ↓
Durable Orchestrator
Run 状态机、安全点、预算、重试、Lease、Timer
       ├───────────┬────────────┐
       ↓           ↓            ↓
Context        Model        Tool Gateway
Compiler       Gateway      Schema、权限、幂等、审批
                               ↓
                        Worker / Sandbox
                               ↓
                       Artifact / Receipt Store

所有组件共同写入：

Semantic Event Log
Checkpoint Store
Transactional Outbox / Inbox

随后生成：

UI Projection
Streaming API
Observability
Audit Log
```

控制核应保持顺序一致，模型调用、工具 I/O 和事件传输采用异步方式。

最佳形态是：

> **顺序一致的控制核 + 异步事件驱动 I/O + 可恢复的长任务 + 受控并行工具执行。**

---

# 十三、分阶段落地

## 第一阶段：基础必备

### 1. 状态分层和统一 ID

**收益：** 消除状态混淆，支持审计和恢复。  
**指标：**

- 状态不一致事故数；
    
- Orphan Tool Result 数量；
    
- 重复 Item 比率；
    
- 恢复后的状态哈希一致率。
    

### 2. Durable Run 状态机和 Checkpoint

**收益：** 支持崩溃恢复、暂停和长任务。  
**指标：**

- 故障恢复成功率；
    
- 平均恢复时间；
    
- 恢复后重复执行率；
    
- Checkpoint 丢失率。
    

### 3. 工具网关和幂等账本

**收益：** 减少错误调用和重复副作用。  
**指标：**

- 工具参数一次通过率；
    
- 工具调用成功率；
    
- 重复副作用率；
    
- Unknown Outcome 比率。
    

### 4. 明确控制命令与安全点

**收益：** 提升中途可控性。  
**指标：**

- Steer 接受到生效的 P50/P95；
    
- Cancel 后新增副作用数；
    
- Interrupt 后恢复成功率；
    
- Follow-up 污染当前 Run 的比例。
    

### 5. Canonical Event 与 Delta 分流

**收益：** 支持可靠重连和一致 UI。  
**指标：**

- 断线后的 Projection 一致率；
    
- 完整事件丢失率；
    
- Token 重复率；
    
- 重连恢复时间。
    

### 6. 预算和无进展检测

**收益：** 防止无界循环和成本失控。  
**指标：**

- 无效循环率；
    
- 每个成功任务的平均成本；
    
- 相同工具重复调用次数；
    
- 错误早停率；
    
- 人工接管率。
    

## 第二阶段：质量增强

### 1. 确定性 Context Compiler

**收益：** 提高上下文一致性与可解释性。  
**指标：**

- Context Manifest 可重复率；
    
- 恢复前后输出差异；
    
- 硬约束保留率；
    
- 上下文利用率。
    

### 2. 动态工具筛选

**收益：** 减少工具误选和上下文占用。  
**指标：**

- 工具选择准确率；
    
- 无效工具调用数；
    
- Tool Definition Token 占比；
    
- 任务成功率变化。
    

### 3. 工具结果整形

**收益：** 减少观察噪声，提高后续推理质量。  
**指标：**

- 工具结果平均 Token；
    
- 修复回合数；
    
- 工具错误理解率；
    
- Raw 与 Structured Result 的任务成功率差异。
    

### 4. Compaction Lineage

**收益：** 支持长上下文而不丢失关键约束。  
**指标：**

- Compaction 前后成功率；
    
- 约束保留率；
    
- Open Obligation 保留率；
    
- Call/Result 配对完整率。
    

## 第三阶段：高阶能力

- Artifact Snapshot 与 Copy-on-Write Branch；
    
- Saga 和业务补偿；
    
- 子代理独立上下文、权限和预算；
    
- 跨 Agent 的远程 Durable Task；
    
- Speculative Branch 与多方案并行探索；
    
- 自动 Reconciliation；
    
- 基于历史事件的策略学习与自适应预算。
    

---

# 十四、核心验证实验

上线前至少完成以下实验：

|实验|验证目标|
|---|---|
|在每个安全点注入进程崩溃|Checkpoint 与恢复一致性|
|重复投递 Command、Tool Job 和 Result|幂等和去重|
|在工具派发前后执行 Cancel|副作用泄漏|
|在模型生成、计划完成、工具执行阶段注入 Steer|Steer 延迟和旧计划失效|
|中断 UI、模型流和工具流|断线恢复和状态独立性|
|对只读和写工具进行并行冲突测试|并发安全性|
|对长历史执行不同 Compaction 策略|约束保留与质量变化|
|对 Raw 和 Structured Tool Result 做对照|工具观察质量|
|构造重复错误和不可满足目标|无进展检测|
|在 Branch 后修改文件和外部资源|对话分支与世界状态隔离|

---

# 十五、最终设计原则

1. 以 Run 状态机为核心，而不是以聊天消息列表为核心。
    
2. 以 Item 和 Event 记录语义，而不是把一切都编码成 Message。
    
3. 分离对话、执行、控制、展示和 Artifact 状态。
    
4. 只将完整语义对象作为权威历史。
    
5. 将模型和工具结果视为非确定性输入，将编排状态机设计为确定性。
    
6. 接受至少一次物理执行，通过幂等机制实现逻辑唯一观察。
    
7. 工具必须声明接口、语义、副作用和运行契约。
    
8. 默认只并行只读、幂等和无冲突的调用。
    
9. 长任务、审批和远程 Agent 必须采用异步持久执行。
    
10. Steer、Interrupt、Cancel、Resume、Follow-up 和 Retry 必须分别建模。
    
11. 控制命令只在明确安全点生效。
    
12. Follow-up 默认不改变当前 Run。
    
13. Branch 必须同时定义历史和世界状态的隔离语义。
    
14. Compaction 必须保留约束、义务、因果链和工具配对。
    
15. 每个循环必须受预算、进展和错误恢复策略约束。
    
16. 所有可靠性能力都必须通过故障注入验证，而不能只通过正常路径测试。
    

最终评价一个 Agent Harness 是否先进，不应看它支持多少模型、工具或代理，而应看它能否稳定保证：

```text
模型看到正确上下文
工具产生可信观察
执行状态可以恢复
外部副作用不会重复
用户控制能够及时生效
事件可以重放和审计
循环能够安全终止
```

这七项共同决定了 Agent 的输出质量、任务完成率、可控性和真实代理能力。