# easy-pi Runtime 改造实施计划

> 面向 coding agent 的执行规格，不是另写一套 runtime 的需求说明。
>
> 版本：1.0 · 编写日期：2026-09-14
>
> 目标：在保留 easy-pi 当前产品行为、Pi 扩展兼容、多模型、原生子代理与上下文压缩能力的前提下，借鉴 Codex 的请求快照、执行准入和资源所有权设计，收紧运行时边界。

## 0. 给执行 Agent 的总指令

你是本次 easy-pi runtime 改造的实施 Agent。**先执行 P00，校准本地代码和测试基线，再按 P01—P08 顺序实施。不要重新撰写一份泛化架构报告后停止，也不要跳过测试直接做大规模重构。**

每个阶段都必须留下源码证据、最小改动、测试结果和可恢复的进度记录。达到当前阶段验收门槛后可以继续下一阶段；涉及真实阻塞时，记录阻塞原因并保留可审查结果，不得伪造通过、删除测试或擅自扩大范围。

### 0.1 输入与权限

| 输入 | 含义 | 默认规则 |
|---|---|---|
| `EASY_PI_DIR` | 用户本地 easy-pi 克隆的绝对路径 | 唯一允许修改的业务仓库；优先在独立工作区实施 |
| `CODEX_DIR` | 用户本地 Codex 克隆的绝对路径 | **只读参考**，不修改、不构建、不运行 Codex |
| `EXECUTION_SCOPE` | 本次允许执行的阶段 | 默认 P00—P08；用户指定单阶段时只执行该阶段及必要校准 |
| `ALLOW_REAL_APIS` | 是否允许真实模型请求 | 默认 false；本计划不依赖真实模型、密钥或付费 token |
| `ALLOW_DEPENDENCY_CHANGES` | 是否允许依赖变化 | 默认 false；先使用仓库已有类型、库和测试设施 |

用户只给了目录名称而未给绝对路径时，先检查当前目录和已明确授权的相邻目录；不要扫描整个磁盘。确认两个仓库的 git 根目录和身份，不要根据文件夹名字猜测。

**此计划的兼容性目标是本任务的明确要求**：保留当前支持的公开 API、扩展调用约定和产品行为，不为无关、未使用的历史代码新增兼容层。本地 `AGENTS.md` 或更深层规则与本计划发生实质冲突时，不要静默覆盖；将冲突列为阻塞项。

### 0.2 参考版本与证据边界

此前源码分析固定在以下版本，本地实施不要求回退到这些版本：

```text
easy-pi: yiwen65/easy-pi
         dba1626064e8fd5339c18d7430355c985e2956e9
Codex:   openai/codex
         516f2780fd227a80cd9fe89488f5039245090b71
```

**本地 HEAD + 本地未提交修改 + 实际测试结果是实施依据。** 若本地已修复本文提到的问题，应记录“已存在／仅补测试”，不要重复实现。若本地结构变化，按符号和调用链定位，不按旧行号硬套补丁。

上一轮取消竞态的独立最小复现只是一条调查线索，不能作为本仓库测试已失败的证据。P01 必须调用真实的 loop 入口验证。

### 0.3 不在本次范围内

不替换现有 `AgentSessionRuntime → AgentSession → Agent → agent loop` 主链；不迁移到另一套 durable workflow 引擎；不重新启用已退役 DAG／旧 child worker 路径；不实现任意 shell 的自动重放或 exactly-once；不新增 MCP、远程 exec-server、OS sandbox、Guardian 或审批 UI；不改变默认 Full Access 行为；不重新设计 IDE、TUI、模型目录、计费策略或压缩算法。

`Auto` 或其他权限模式可作为将来的扩展方向，但本次不新增模式、不切换用户默认值。发现真实安全缺陷应记录和修复其明确边界，不以“大重构顺便做掉”为理由改变整个权限产品。

---

## 1. 成功标准与不可破坏的不变量

### 1.1 本次真正要保证什么

| 编号 | 不变量 | 精确定义 |
|---|---|---|
| I01 | 不晚启动 | runtime 已观察到 run 取消、关闭或 generation 失效后，不得再准入新的受管 provider 请求、工具调用或子进程 |
| I02 | 结果不被晚到取消覆盖 | 执行层已经产生明确成功／失败结果后，后续取消或记录错误不能把“已执行”伪装成“未执行” |
| I03 | 展示与执行一致 | 同一 step 的 model-visible tool schema 与 handler binding 来自同一个已完成的 ToolPlan |
| I04 | 请求配置一致 | messages 投影、system prompt、model settings、工具计划和环境绑定在一个请求准备边界内确定 |
| I05 | 快照不是永久授权 | 运行时仍重新检查当前祖先权限、host 强制限制和取消；权限收紧可以阻止旧快照中的调用 |
| I06 | 控制与执行分开 | 不在串行控制队列内等待依赖该队列才能结束的 provider、工具、child 或 shutdown |
| I07 | 单一所有者 | 每个 run、工具 invocation、后台进程、输出 writer 和共享服务具有明确所有者或明确引用共享规则 |
| I08 | 关闭可以等待 | 关闭报告准确区分已完成、失败、超时和遗留资源；发出 kill 不等于已经关闭 |
| I09 | 历史顺序可解释 | 并发工具的实时完成事件可乱序，模型历史中的 tool result 按既有 assistant 源顺序物化；不得重复、串 run 或污染新 session |
| I10 | 控制能力不等于工作区能力 | stop、cancel、状态查询和释放资源不得因等候被它们停止的工作区锁而死锁 |
| I11 | 缓存关联不等于会话身份 | prompt cache／cache affinity 可以受控继承；认证、连接、history、取消和执行身份不能因此混用 |
| I12 | 证据真实 | 未执行测试、已有基线失败、平台未覆盖和无法强制终止的资源必须明确报告 |

I01 只覆盖 runtime 管理的入口。任意同进程 JavaScript 扩展若直接使用 Node API 或不合作地持续运行，不能靠一个 AbortSignal 强制隔离。不得把本次改造宣称为 OS 安全边界。

### 1.2 保持不变的行为

保留 Pi 扩展和 SDK 当前有效的工具签名、stream function 约定、工具覆盖优先级、steer/follow-up drain 语义；保留用户模型设置、原生子代理动态权限收紧、有效的 preserve/fork 缓存关联和已支持的压缩恢复；保留现有按文件修改协调。

`agent_end`、`agent_settled`、`waitForIdle()`、`abort()`、session replacement 的**实际既有顺序必须先做 characterization test**，再决定内部如何重构。不得为了满足新类型名称改名公共事件。

内部可以增加细分执行状态；不得未经兼容分析直接扩展外部穷尽 union、替换 RPC 响应形状或改变模型收到的错误格式。

---

## 2. 源码导航与目标结构

### 2.1 优先阅读 easy-pi 主线

| 区域 | 已知文件或需要定位的符号 | 阅读目的 |
|---|---|---|
| Agent | `packages/agent/src/agent.ts`、`agent-loop.ts`、`types.ts` | activeRun、取消、预检、并发工具、事件顺序 |
| Session | `packages/coding-agent/src/core/agent-session.ts` | prompt preflight、压缩投影、hook 安装、provider context、settled |
| 会话替换 | `packages/coding-agent/src/core/agent-session-runtime.ts` | new/resume/fork 的 abort、dispose、rebind 顺序 |
| 构建主链 | `packages/coding-agent/src/core/sdk.ts`，实际 CLI 入口 | 确认运行路径，而不是只看同名旧文件 |
| 原生协作 | `packages/subagent/src/session-host.ts`、`collaboration-controller.ts` | child 所有权、动态权限、控制队列与生命周期队列 |
| Child adapter | 搜索 `createPiChildSessionHost` | 原生 child 的异步启动、取消、关闭与缓存继承 |
| 执行环境 | `packages/agent/src/harness/types.ts`、`harness/env/node-process-executor.ts` | 已有 ExecutionEnv、进程控制、前后台所有权转移 |
| 后台任务 | `packages/agent/src/harness/env/background-task-manager.ts` | task 状态、输出 writer、等待、cleanup |
| 工具接入 | `packages/coding-agent/src/core/tools/bash.ts`；搜索 `withFileMutationQueue` | BashOperations、spawnHook、真实命令、按文件协调 |
| 策略 | `packages/permissions/src/permissions.ts`；搜索 `decidePermission` 的调用点 | Full Access 行为、硬拒绝、实际强制位置 |
| 模型 | `packages/ai/src` 内搜索 `cacheAffinityId`、`promptCacheKey`、`cleanupSessionResources` | 身份分离与认证切换资源 |
| 测试 | `packages/coding-agent/test/suite/README.md` 与 `harness.ts` | 使用现有 faux provider 与 CI-safe harness |

`harness` 目录存在不代表主 CLI 已使用那里的全部 runtime。需要用 imports、工厂调用和测试证明实际连接关系。

### 2.2 Codex 只读参考

| 参考文件 | 借鉴概念 | 不要求复制的实现 |
|---|---|---|
| `codex-rs/core/src/session/step_context.rs` | 请求作用域的 settings 与 capability binding | Rust Arc、完整 MCP／executor 结构 |
| `codex-rs/core/src/tools/router.rs` | schema 与 executable registry 的同源计划 | 所有 namespace、code-mode 细节 |
| `codex-rs/core/src/tools/parallel.rs` | dispatch 准入、取消与终态竞争、等待／执行计时 | Tokio task abort 与全局读写锁照搬 |
| `codex-rs/core/src/session/turn_input.rs` | 输入接收与长时间执行分离 | 整套 Op 协议移植 |
| `codex-rs/core/src/session/handlers.rs`、`turn_suspension.rs` | 停止生产者、结束 writer、最后发布完成 | 无证据的外部 effect 自动恢复 |
| `codex-rs/core/src/tools/orchestrator.rs`、`sandboxing.rs` | policy、approval、executor 的职责分离 | 完整审批产品、自动提权 |
| `codex-rs/core/src/client.rs` | session／turn／认证归属的状态作用域 | 替换 easy-pi 多 provider API |

参考设计优先独立用 TypeScript 实现，不直接搬运大段 Rust 代码。确需复制非平凡代码或注释时，先检查本地 LICENSE/NOTICE 和仓库规则，保留所需归属并记录来源；不假定两个仓库许可相同。

### 2.3 建议的内部结构，不是强制的新文件列表

```text
现有 AgentSessionRuntime / AgentSession
  ├─ SessionLifetime：generation、接收状态、关闭报告
  ├─ 现有原生 CollaborationController
  └─ 现有 Agent
       └─ RunScope：生命周期与 effect 准入的单一所有者
            └─ StepSnapshot：这次请求的版本化视图
                 └─ ToolPlan：schemas + handlers + binding leases
                      └─ 统一 dispatch
                           → 最终策略
                           → 调度准入
                           → 最终取消／撤权检查
                           → 现有 tool / ExecutionEnv
```

可以按职责新增 `run-scope.ts`、`step-snapshot.ts`、`tool-plan.ts`、`execution-admission.ts`、`resource-scheduler.ts`。若本地已有等价模块，扩展原模块；不要每个概念都新建 package，也不要给同一状态制造两个权威所有者。

新增 TypeScript 遵循本地 strip-only／erasable syntax 要求：不使用 parameter properties、enum、namespace 或动态类型 import；使用现有依赖类型，不为消除错误引入不必要的 any。测试和产品代码都适用。

跨包依赖保持单向：通用 agent 层接收注入的 host authority／executor 契约，不反向 import coding-agent SDK。通用 agent 模块不得引入 Node-only 依赖，必须保持现有 browser smoke 通过。

---

## 3. 阶段总表与依赖

| 阶段 | 内容 | 阶段完成物 |
|---|---|---|
| P00 | 本地校准、工作区隔离、基线和 characterization | baseline、命令清单、实际调用图、测试状态 |
| P01 | 最终取消检查的最小修复 | 仓库内 RED/GREEN 回归与小补丁 |
| P02 | 公共 RunScope 与单次执行终态 | root/child 取消一致性、失效代际阻断 |
| P03 | ToolPlan + StepSnapshot | 单一请求边界、版本绑定、实时撤权保留 |
| P04 | 可等待的关闭与输出收尾 | shutdown report、后台任务 drain、child 资源归属 |
| P05 | host-owned 最终策略与 PreparedExecution | 不改 Full Access 行为的统一强制入口 |
| P06 | 有界并发与资源协调 | 保留兼容语义、跨 native session 的资源协调 |
| P07 | 关联观测与模型身份契约 | 执行阶段轨迹、认证切换与缓存隔离测试 |
| P08 | 集成验收、文档和交接 | 非真实 API 回归、残余风险、实施总结 |

默认按 `P00 → P01 → P02 → P03 → P04 → P05 → P06 → P07 → P08` 实施。P04 的独立后台进程测试可以在 P02 契约明确后准备；P07 的事件字段设计可以提前，但不得在核心文件中并行改写。

**第一批可交付边界为 P00—P04。** 若用户把执行范围限于 P0，完成这里后停止，后续阶段标记为尚未执行，而不是“已完成总体改造”。

一个阶段可以拆成数个小提交，但每个交付提交都必须可构建／检查且相关测试通过。RED 测试失败证据可以在工作中记录，不提交一个故意破坏默认测试的最终阶段结果。

---

## 4. P00 — 本地校准与隔离基线

### 目标

确认实际需要改什么、现有测试证明了什么、哪些接口不能动。校准结果是后续阶段的输入，不得省略。

### 执行步骤

1. 读取 easy-pi 根及目标子目录的 `AGENTS.md`、相关测试规则；修改前完整阅读目标文件，不以片段代替完整调用链。
2. 记录两仓库绝对路径、HEAD、branch、工作区状态；不要在日志中打印带 token 的 remote URL、环境变量或配置文件内容。
3. 选择独立、干净的 easy-pi 工作区。若与其他 Agent 共用 dirty worktree，不执行全仓库格式修正；不要 stash、reset 或清理别人的文件。现有未提交修改包含目标文件时先隔离或明确协调。
4. 记录 Node 版本与本地脚本要求。检查依赖是否已存在，缺失时仅按本地规则安装；依赖变更不属于本次默认范围。
5. 用符号搜索确认主链、native child 接入、所有模型／工具／进程启动入口、关闭调用者、权限调用者、结果持久化调用者。
6. 标注“在用／仅兼容／已退役／未接入”的路径。特别核对旧 DAG、`pi-rpc-runtime` 与 native child，不因目录存在而改错路径。
7. 运行已有的定向测试；只给与本次有关而尚无覆盖的行为补 characterization。记录基线失败，区分环境问题与代码失败。
8. 输出 `runtime-refactor-baseline.md`、`runtime-refactor-progress.md`、`runtime-refactor-test-matrix.md`。建议放入现有设计文档目录；没有约定时用 `docs/runtime-refactor/`，P00 确定后不反复换位置。

### 只读校准命令示例

以下变量由用户路径或已验证的工作区位置填入，不可原样保留占位符运行。

```bash
export EASY_PI_DIR="/absolute/path/to/easy-pi"
export CODEX_DIR="/absolute/path/to/codex"

git -C "$EASY_PI_DIR" rev-parse --show-toplevel
git -C "$EASY_PI_DIR" rev-parse HEAD
git -C "$EASY_PI_DIR" status --short
git -C "$CODEX_DIR" rev-parse --show-toplevel
git -C "$CODEX_DIR" rev-parse HEAD
git -C "$CODEX_DIR" status --short

cd "$EASY_PI_DIR"
rg -n 'createPiChildSessionHost|withFileMutationQueue|decidePermission|executePreparedToolCall' packages
rg -n 'createContextSnapshot|prepareNextTurnWithContext|onProviderContext|agent_settled' packages
rg -n 'cleanupSessionResources|cacheAffinityId|promptCacheKey|spawnHook' packages
```

独立 worktree 可以由用户预先创建，或在本地授权范围内创建新分支和新 worktree；不得移动正在被其他会话使用的分支。记录所选工作区并在之后所有命令中保持一致。不要用软链接共享会被重写的 node_modules／workspace 包产物来假装隔离。

### 必须冻结的现状表

```text
主 CLI → SDK → AgentSession → Agent 的实际路径
root prompt / child run 的接收点与 settled 点
低层 Agent 和高层 AgentSession 的 idle 差异
工具 schema、handler、hook、authority 的各自来源
provider context transform 的执行顺序及副作用
native child 在本地 HEAD 是否同进程
后台进程与资源管理器的归属和共享范围
会话写入是同步写、异步队列还是其他形式
当前 Full Access 及 hard deny 的实际行为
已有 file mutation queue 的位置、锁键和作用域
```

### 验收

上表有具体文件、符号和测试支撑；后续改造候选分别标记 `confirmed-gap`、`already-present` 或 `needs-characterization`。本地没有的函数不能写成已存在 API。P00 不改业务架构。

---

## 5. P01 — 最终取消检查：先修最小窗口

### 源码线索

分析版本的并行工具流程先逐个预检，收集延迟函数，最后通过 `Promise.all` 执行；`executePreparedToolCall()` 入口没有再次检查 signal。预检还允许异步 hook，因此“预检通过”与“实际启动”之间可能发生取消。[SRC-04]

### 必须先建立的仓库回归

使用真实 `Agent` 或仓库导出的真实 loop 入口、faux stream、两个受控工具，不另写一份 loop 当作被测对象。

```text
A 的预检完成
B 的 beforeToolCall 到达 barrier，停住
测试发出 abort
释放 B 的 barrier
让批次继续结算
断言：A.execute 没有被调用，B.execute 没有被调用
断言：run 可以结算，没有悬挂 promise 或重复终态
```

用 deferred/barrier 控制调度，不用短 sleep 猜测时序。测试不得执行真实 bash。若本地 HEAD 已通过这条测试，记录已有修复位置，只补必要相邻回归。

### 最小改动

在真正调用 `prepared.tool.execute(...)` 前检查取消；确保并行、串行和低层直接 loop 都覆盖到同一个最终检查。取消产出的错误应沿用当前工具结果协议，不引入新的公共 event 类型。

此阶段不顺手引入 RunScope、重写事件流、改变整个 batch 顺序或更换工具调度器。

### 回归与完成条件

- C01：上述 A/B 竞态不会启动任何已取消的待执行工具。
- C02：串行队列等待期间取消，后续工具不执行。
- C03：没有取消的批次，调用次数和结果顺序不变。
- C04：已启动工具收到 signal，runtime 不把它宣称成未启动。
- 记录变更前后测试结果；修改过的测试、相关已有测试、`npm run check` 通过后交付本阶段。

## 6. P02 — 公共 RunScope、代际与执行终态

### 目标

把分散在 root、child adapter、Agent 和 Session 的晚启动保护统一到公共运行作用域；不复制第二个 activeRun 状态机。

### 实施步骤

1. 根据 P00 映射，以现有 activeRun 为唯一运行所有者，提取或内聚 `RunScope`。它至少区分 run identity、session generation、取消请求、是否允许新 effect、结算 promise。
2. 在异步 prompt preflight 之前建立可取消的 reservation／scope。reservation 不代表模型已开始，不应提前改变公共 `agent_start` 的既有时机。
3. 接收另一个 prompt 时沿用已有拒绝／steer/follow-up 行为，不要因新增 scope 允许两个并发 root run。
4. provider 和工具入口均进行最终准入。已有 native child adapter 的关闭／中断保护，在公共层真实覆盖之前不得删除。
5. 取消时停止准入新 effect，但允许已经启动的 effect 报告结果和收尾。不要用“scope 已关闭”拒绝它自己的结果写入。
6. session 替换、dispose 或 generation 失效后，旧请求、旧队列任务、旧 async hook 的迟到结果只能归属旧 run，不能进入新 session。
7. 将执行结果与后处理／持久化／清理错误分开记录，最终对外仍使用兼容 adapter。

### 准入的线性化点

“线性化点”指 runtime 判断一次执行正式开始的单一时刻。对本地 JS 管理的同步启动入口，最终检查和调用实际入口之间不得再次 `await`：

```text
异步准备 / 等待资源 / 异步决策
         ↓
同步重查 signal、generation、authority revision
         ↓
标记 invocation 已进入 executing
         ↓
立即调用工具 / provider transport / process spawn 入口
```

若准入前还需要异步检查，必须先完成它，再重查版本和取消。版本变化时重新决策或拒绝，不可拿旧批准直接启动。这个保证不等于工具内部所有异步副作用都受控：受管 `ExecutionEnv` 在实际进程启动前还要检查，任意扩展的直接 Node 调用仍在信任边界内。

### 最小内部状态语义

无需新增大型 FSM 库，可以用小 union 和单一 settle 函数实现。

```text
Run：reserved → active → settling → settled
     cancelRequested 是独立标记；不与阶段笛卡尔积膨胀

Invocation：prepared → waiting → executing → outcome_known → finalized
             └─ 未启动即取消：cancelled_before_start
```

既有 `tool_execution_start` 可能在预检之前就已发出，不能把它当作真实副作用开始的证据。保留外部事件兼容性，内部另行记录 handler 准入时刻。取消后未执行调用的协议配对／恢复行为要沿用或补全现有规范化路径；合成取消结果不等于工具执行过，禁止因此再次调用工具。

执行结果与后续错误采用两个维度：

| 维度 | 示例 |
|---|---|
| Execution outcome | `not_started`、`succeeded`、`failed`、`interrupted_outcome_unknown` |
| Settlement problems | postprocess error、event delivery error、persistence error、cleanup error |

已完成工具随后写日志失败，不允许自动重跑。中断中的副作用结果未知，也不允许自动标记“没有写文件”。内部原始结果可以短期保留用于结算，不因此新增明文敏感数据持久化。

### 生命周期细节

- 终态只设置一次；成功返回、signal、timeout 和异常竞争都走同一 finalize guard。
- 先保存执行结果，再等待进度投递／输出收尾，避免把后处理异常误认为工具未执行。
- afterToolCall 的既有结果改写、内容过滤仍保留；执行事实与模型最终显示内容不能混为一谈。
- `waitForIdle()` 的范围遵循现有公开约定；需要更强的内部 settled 屏障时新增内部方法，不悄悄改变外部事件含义。
- 不在 `agent_end` 的 awaited listener 中等待包含该 listener 自己的 idle promise。用不同的执行结束与宿主结算层级解决循环等待。

### 测试

C05：prompt preflight 停在 barrier 时取消，释放后不启动 provider。  
C06：工具产生明确结果后取消，结果保留且没有第二个终态。  
C07：进度 listener／后处理失败，工具调用次数仍为一次。  
C08：旧 generation 的迟到 callback 不进入新 session。  
C09：root 与 native child 使用同一取消语义；child 创建／加载自身不启动 turn。  
C10：连续 abort、并发 abort/finish、正常 idle 均无未处理 rejection。

### 完成条件

以上测试通过；原生 child 的特例保护被保留或由等价测试证明可以删除；没有新增 Node-only 依赖到通用 agent 层；P01 回归仍通过。

---

## 7. P03 — ToolPlan 与 StepSnapshot

### 目标

整合 easy-pi 已有请求刷新、压缩投影 revision、provider context identity，创建一次请求对应的稳定配置和工具绑定。借鉴 Codex `StepContext` 的职责，而非复制整个对象图。[SRC-05][SRC-06][SRC-11]

### P03-A：先建立 ToolPlan

由**一个构建过程**同时产出模型可见工具定义与执行绑定。构建发生在实际工具选择、覆盖和过滤规则确定之后。

建议保存以下信息：

```text
ToolPlan identity / revision
规范化工具名称 → 复制后的 schema 和描述
规范化工具名称 → 当前选定 handler 的稳定绑定
extension / registry generation
tool execution metadata
必要的 binding lease
```

保持现有有意的 builtin／extension 覆盖优先级。不要简单把所有重名注册都拒绝而破坏已支持覆盖；最终计划中的歧义才是错误。

未知工具按当前协议返回错误，不能在模型请求回来后自动按同名去最新 registry 找另一个实现。动态工具加载若已有合法流程，应定义“在哪个边界加入哪个计划”，不隐式漂移。

**TypeScript readonly 不是足够的实现。** 对 schema 和小配置使用复制／冻结；对 handler 使用注册时稳定的绑定，不依赖会被原地替换的对象属性；对闭包捕获的可变状态不能假装 deep freeze 有效。

### P03-B：统一请求准备边界

完整覆盖首个请求和后续请求。建议按下面的职责顺序整合，实际 hook 顺序须与 P00 characterization 一致：

```text
1. 确认 RunScope 仍有效
2. 按既有语义接收本次可消费的 steer / mailbox / notification
3. 执行需要产生副作用的准备：hook、压缩 checkpoint、消息入库
4. 从已发布状态读取一致的 context projection 与配置
5. 解析本次 ToolPlan 和 environment binding
6. 完成受支持的语义转换，形成 StepSnapshot
7. 获取／刷新请求认证；认证秘密不进入 snapshot
8. 最终准入并发送 provider request
9. 本响应的 tool calls 保留该 StepSnapshot 的 ToolPlan
10. 本 step 工具和必要后处理结束后释放 binding
```

这是职责序列，不授权随意调整已有 extension 顺序。必要时让现有函数返回明确的 prepared result，而不是再套一层会重复调用它们的 pipeline。

建议的 snapshot 内容：

```text
sessionId / sessionGeneration / runId / stepId
contextProjectionRevision / checkpoint identity
captured model identity / thinking settings
有效 messages projection 与 system prompt
ToolPlan
execution environment identity / binding
最终 provider context identity（诊断用途）
```

不要把 API key、OAuth token、WebSocket 对象、整个 process.env 或用户认证缓存写入 snapshot，也不要把 `stepId` 自动加入 provider payload 或 system prompt 破坏缓存前缀。

### 一致性与重试规则

准备过程可能 await。期间 revision 改变时，只能重建**纯投影**或返回明确的 stale-preparation 结果。不得自动重复运行已经发出外部行为的 hook、再次消费同一条队列消息或再次执行压缩持久化。

因此要把“有副作用的准备”与“纯读取和构建”区分开：前者最多按原语义执行一次并发布 revision，后者才可重试。设置有界重试；持续变化时返回可诊断错误，不进入无限重建循环。

`onProviderContext` 若定义为观察者，应只看到隔离副本／不可变视图，异常不阻止其他观察者，不允许借观察回调修改实际请求。

`onPayload` 或 provider-specific hook 若能改变工具清单、messages 或模型设置，必须纳入最终一致性分析。不能一边允许它任意改变语义，一边宣称模型看到的就是 ToolPlan。保留既有合法能力的方法是：把变化纳入 finalization，或建立明确的 provider adapter 校验。**不能为了完成快照默默移除这个扩展能力。** 无法兼容时记录具体冲突，暂停相关部分。

不要每次请求深拷贝整段大历史；优先保留已有不可变投影／copy-on-write／append 边界。用合成大历史验证没有多引入每次工具调用都复制全历史的路径。

### Extension generation 与实时授权

分开处理两种状态：

| 状态 | 处理 |
|---|---|
| 该请求看到的 schema、handler、语义 hook binding | 按 step 固定 |
| 当前 run 是否取消、祖先是否撤权、host 硬限制 | 执行前实时检查，不能永久冻结 |

旧 generation 的 binding 在仍被使用时不能提前 dispose。若现有 extension runner 无法安全并存两个 generation，优先在 step／run 安全边界推迟切换；涉及 cwd／session 所有权变化时先中断旧 run，再重建。不要引入一套复杂版本共存系统只是为了热重载。

有效权限表达为：

```text
step 捕获的工具上限 ∩ 当前祖先权限 ∩ 当前 host 强制约束
```

新增权限或新增工具通常在下一个 step 生效；收紧权限可阻断当前 step 尚未开始的调用。native child 的 `toolAllowed` 与 `getPermissions` 必须继续在执行时发挥作用。[SRC-07]

### 测试

S01：请求发出后注册同名新 handler，旧响应仍调用旧绑定；下一 step 使用新绑定。  
S02：模型和 thinking 在异步准备期间变化，一次请求不混用两个版本。  
S03：压缩激活时 messages、system prompt、context revision 一起切换。  
S04：首个请求与后续请求都通过统一 finalization。  
S05：copy 后修改原始 schema 数组或对象，不改变已发布计划。  
S06：祖先在工具排队期间撤权，旧 ToolPlan 不能绕过。  
S07：重建 snapshot 不重复消费 steer、通知或触发有副作用的 hook。  
S08：旧 runner 延迟释放；session generation 失效不会把旧结果投递到新 session。  
S09：observability callback 不能修改有效请求；其异常可诊断但不阻断。  
S10：preserve/fork、已支持的动态工具流程、tool override 与合法 payload hook 回归通过。

### 完成条件

没有“prompt 用一个数组、dispatch 查另一个全局表”的未说明路径；动态撤权仍有效；没有把 snapshot hash 当作代码一致性或权限证明；不会为配置更新重放外部副作用。

---

## 8. P04 — 资源所有权、可等待关闭与输出收尾

### 目标

关闭可证明，不以发出 SIGTERM/SIGKILL、调用 `stream.end()` 或清空 Map 作为全部资源已结束的证据。Codex 的生产者停止与 writer 关闭顺序是参考，不意味着直接复制其持久化 API。[SRC-08][SRC-15]

### P04-A：建立资源所有权表

从代码中确认每项资源的 owner、共享方式和结束条件：

| 资源 | 需要回答的问题 |
|---|---|
| run／tool invocation | 谁请求取消，谁接受最后结果，谁设置 settled？ |
| native child | controller、host、AgentSession 分别负责什么？ |
| foreground process | 谁持有进程句柄，什么时候属于 background manager？ |
| background process | 属于哪份 session／child，session 关闭是否必须终止？ |
| stdout/stderr／日志 writer | 谁暂停、恢复、结束和等待？ |
| provider 连接与缓存 | 哪些 session 共享，child dispose 是否会误关 root？ |
| persistence 与通知 | 是同步写还是队列，怎样等待已接受的写完成？ |
| ToolPlan／extension binding | 最后一个使用者是谁，什么时候释放？ |

不要给已经有 owner 的资源再套一个互不协调的 manager。尽量利用已有 `CollaborationController` 生命周期，而不是把慢工作塞回其串行控制队列。

### P04-B：区分取消当前运行与关闭整个 session

内部至少有两个语义清楚的操作：

- `abortRun`：不再开始新工作，取消当前 run，等待该 run 的结算；不隐式终止用户明确保留的其他 session 资源。
- `shutdownSession`：关闭这份 session 拥有的资源，返回结构化关闭报告。

这些名称可以只作为内部方法，不强制替换现有 SDK API。现有同步 `dispose()` 若无法承担 async join，可增加内部 awaitable shutdown 并使所有宿主 teardown 路径先 await；不得偷偷改公开返回类型又遗漏调用者。

建议内部关闭报告至少记录 `complete`、失败项、超时项和仍未确认结束的资源。重复调用应共享关闭 promise／一致结果，而不是再次启动清理。

### 关闭顺序

```text
seal 新输入、新 child 与新 effect 准入
  → 请求取消并停止生产者
  → 在控制队列外等待 run／child／进程结束
  → drain 已接受输出、通知、postprocessing
  → 等待既有持久化完成
  → 释放本 session 独占的 bindings／连接
  → 发布关闭报告
  → 只有满足交接条件才 invalidate／rebind 新 session
```

注意：清理本身可能需要受管操作；为 host 自己的有限清理动作保留明确 cleanup scope，不把它误认为新模型任务，也不允许关闭 hook 借此启动无限新 run。

进度写入和已有 effect 结果在收尾期间可以进入**旧 owner**。关闭完成之后不应再有旧 owner 向新会话投递事件。child 关闭不能清理 root 或 sibling 的共享资源。

### 超时与不合作代码

设置可测试的关闭 deadline，按 graceful stop、force termination、报告遗留资源推进。deadline 到期不是成功；无法停止同进程工具时报告限制，不把 idle 设置为“全部停止”。

仍有 producer 或 writer 未确认结束时，不得宣布同一持久化资源可安全移交。对已隔离、仍存在的不合作对象，是否允许新 session 在不同资源上继续，必须有明确 owner/generation 隔离，不得默认共写。

不要用等待任意长时间掩盖死锁，也不要用 `Promise.race` 超时后遗弃仍可写入的 promise 而不封闭其写权限和事件归属。

### P04-C：后台任务与输出

1. `BackgroundTaskManager` 跟踪进程退出、输出 drain 和 writer 结束的完成 promise；task status 与 I/O settled 可内部区分。
2. `cleanup` 等待所有要求关闭的资源，未成功项进入报告，不能清空 Map 后丢失追踪。
3. `logStream.end()` 之后等待 finish/error；不要声称 finish 等于 fsync 或掉电耐久性。若原持久化层没有 fsync 约定，本次不添加虚假的“完全持久化”承诺。
4. 日志写入 `write()` 返回 false 时处理背压；对 stdout/stderr 有明确的暂停、drain、恢复策略和取消路径。
5. 对 UI 进度更新可以合并，但不得丢失最终结果或持久化事实；对日志不可静默丢弃。设置有界队列，无法完整记录时提供明确错误／截断事实。
6. 前台超时转后台是**所有权转移**：仅一个 owner 观察进程、结算或终止；捕获旧输出与新日志边界保持既有契约。
7. 用假进程覆盖复杂时序，用测试创建的真实子进程覆盖 OS 行为；只能终止本测试创建并验证归属的进程组。

### 测试

L01：shutdown 在 spawn／preflight 等待时开始，之后不再生成新进程或请求。  
L02：进程已退出但 writer 尚未 finish，强关闭屏障仍等待。  
L03：kill 失败、writer error、不合作工具和 deadline 到期，报告不是 complete。  
L04：连续／并发 shutdown 不重复清理或重复通知。  
L05：前台转后台与 abort 同时发生，不重复拥有、重复结果或遗漏终止。  
L06：child dispose 不关闭 parent/sibling 的共享资源。  
L07：高输出量与慢 writer 时内存队列有上界，abort 能解除背压等待。  
L08：session replacement 只在交接条件满足后发布新 session；旧事件不会串入。  
L09：关闭流程不在控制队列内等待会回调该队列的 child，避免自等待。

### 完成条件

所有宿主 teardown 调用者均已审计；关闭路径准确报告能力边界；测试结束无受管遗留进程、timer、writer 和未处理 rejection；现有后台任务用户行为未无说明改变。

---

## 9. P05 — 统一 PreparedExecution 与 host-owned 最终策略

### 目标

把现有策略放到最终执行的可信位置，保持默认 Full Access 与当前 hard deny 行为。借鉴 Codex 的分层，不移植审批产品。[SRC-10][SRC-13]

### 执行管线

```text
ToolPlan 解析调用
  → parse / initial schema validation
  → 既有 extension preflight / 参数修改
  → 最终 schema validation
  → 解析真实操作：路径 / 命令 / cwd / 环境绑定
  → PreparedExecution
  → host 强制策略评估
  → 等待调度资源
  → 最终取消 + generation + 实时权限版本重查
  → 实际执行
  → 记录执行事实
  → 既有结果转换 / 结算
```

`PreparedExecution` 是内部不可变描述，至少能关联 callId、stepId、tool identity、最终参数、目标环境和策略版本。不把完整秘密 env 放入诊断或持久化。

### 必须解决的覆盖问题

P00 建立入口清单，P05 对每个实际在用入口填入“策略位置／真正启动点／测试”，包括：

```text
内置 read / edit / write
模型 bash
用户 !command / user_bash
直接启动 background task
foreground → background promotion
native child 中的对应工具和嵌套 delegation
可替换 BashOperations / executionEnv / spawnHook
合法的 SDK 自定义工具与 extension tool
```

路径或命令在后续 `spawnHook` 中改变时，策略必须看到**真正执行的最终目标**。已有 hook 后 schema revalidation 要保留；类型正确并不等于路径／命令仍获准。

对于任意 JS 自定义工具，dispatcher 只能控制该工具调用的启动和宿主能力，无法证明其内部没有直接用 fs/network。标记这个信任边界，不以通用 gate 名称冒充全面隔离。

### 强制约束与普通扩展分开

取消、失效 generation、当前祖先工具上限与 host 硬拒绝由宿主控制，不能只依赖可替换的 extension runner 链。普通 hook 可以修改输入或增加限制，但 host 最终检查必须在其后。

实时 authority 注入 agent 层，不反向引入 coding-agent 依赖。当前 SDK 没有宿主权限的调用采用明确的默认 adapter，不能默认给空权限导致普通 Agent 全部失效，也不能伪造存在 OS sandbox。

异步决策在取得调度资源前或期间可能过期；执行前重查 authority revision。不要在持有控制队列／工作区独占锁时等待未来用户审批。未来需要审批时要释放等待资源并在批准后重新准入，本阶段不新增 UI。

### 错误和重试规则

区分 policy denied、cancelled、invalid input、executor failure 与结果记录失败。通过已有兼容层映射到用户和模型；不得把 sandbox/权限拒绝当作普通暂态错误自动提权，也不得因为工具结果没记录成功自动重跑 shell。

### 测试

A01：hook 修改路径或命令后，hard policy 检查最终参数而非旧参数。  
A02：调度等待期间祖先撤权，最终执行被拒绝。  
A03：重载扩展不能移除 host 强制 gate。  
A04：root 与 nested child 的策略上限一致，新增工具仅在合法新计划出现。  
A05：`!command`、后台任务和自定义 shell adapter 不漏掉对应宿主约束。  
A06：普通 Full Access 命令没有新审批、权限模式或默认拒绝；hard deny 既有回归通过。  
A07：执行错误与持久化错误分开，拒绝与取消不触发工具自动重试。

### 完成条件

入口覆盖表没有未说明空白；所有强制检查看到最终执行目标；本次没有新增 Auto 模式、审批提示、提权重试或 OS 安全宣传。

## 10. P06 — 有界工具并发与资源协调

### 目标

控制并发占用，避免独立 native session 在同一工作区互相破坏，同时保留 easy-pi 既有按文件协调和批次语义。Codex 的共享／独占准入仅作为设计参考。[SRC-12]

### 兼容性红线

本地若保留“任一工具声明 `executionMode: sequential`，整批串行”的契约，默认必须继续保持。不要把它改成“只有这一个调用串行”，也不要静默提前启动尚在整个 batch preflight 阶段的工具。

优化先发生在**原本就允许并行的批次**：增加有界调度和资源冲突协调。真实完成事件可按完成顺序发出，tool result 历史顺序仍与 assistant 源顺序一致。

### 实施步骤

1. 核对现有 tool execution、文件队列、native child quota 的作用域，避免建立相互不知情的两个限流器。
2. 对实际执行工具设置可注入上限，测试用 1、2 和更高值覆盖。生产优先使用已有 host 并发配置；不存在时，在 decisions 中说明选择的内部默认值与合成负载证据，不擅自新增 CLI 配置面。
3. 将调度等待与真正执行分开计时。队列项保留 run、step、authority revision，等待时取消应及时移除。
4. 以执行环境与工作区为作用域共享 coordinator，覆盖同进程 root 和 native children；不要为每个 Agent 单建互不协调的工作区锁。
5. 对同一路径修改复用现有队列或将它的实现接到同一个 coordinator，保留对外 helper 契约。不要在 dispatcher 和 tool 内重复获取同一不可重入锁。
6. 控制类工具、child 创建准入和等待结果不得占住被等待工作的执行 slot／workspace lock。长等待可以持有轻量等待状态，不能占用唯一执行资源。
7. 输出 writer、process handle 的存活时间与工具调用的 slot 生命周期分开管理。

### 首版资源分类

| 类型 | 建议协调方式 |
|---|---|
| 明确的只读操作 | 可有界并行；不声称得到整个文件系统的快照 |
| 内置文件修改 | 复用现有按路径修改串行化，不同文件继续允许并行 |
| 不透明 shell／已知仓库级修改 | 保守使用对应 environment/workspace 独占准入 |
| `task_stop`、abort、状态查询、释放资源 | 控制路径，不等待被控制资源的工作锁 |
| `spawn_agent`／等待子代理 | 创建与调度完成后释放执行 slot，不能持锁等待 child 完成 |
| 未声明副作用的自定义工具 | 不依据工具名称猜“只读”；使用明确的 host 默认类别并保留兼容说明 |

“共享锁”表示与其他同类工作可并发，不代表工具已经通过安全审查。工作区锁也是一致性协调，不是安全 sandbox；其他进程和任意 JS 扩展仍可能绕过它。

路径键使用 ExecutionEnv 的路径约定和既有解析规则，不能将远程／Windows 路径用当前 host 的 `path.resolve()` 硬规范化。不要为了锁键额外改变 WorkspacePolicy 对 symlink 的产品行为。

### 后台进程的锁转移

前台工具转后台后，工具调用 slot 可以释放；仍在写工作区的进程若被资源策略约束，其资源 lease 不能随工具返回提前释放。由 background process owner 持有 lease，直到退出／强制终止得到确认。

`task_stop` 和 shutdown 必须能绕过这把工作锁进入控制路径，否则永远不能停止持锁进程。若某类常驻后台任务的副作用无法准确建模，记录该限制并保守处理，不伪称“已完成冲突隔离”。

### 死锁审计清单

禁止以下依赖：

```text
父代理持有 workspace 独占锁 → 等子代理 → 子代理等同一锁
关闭函数持有 control queue → 等 child abort → child 回调 control queue
dispatcher 持有 file lock → tool 再进同一 file mutation queue
最后一个 execution slot 被 wait 工具占用 → 被等待工具无法启动
日志 drain 等待已销毁 writer → cleanup 永不返回
```

### 测试

Q01：两个可并行读取确实重叠执行；pending 数不超过注入上限。  
Q02：同路径修改保持序列，不同路径仍可并行。  
Q03：同 workspace 的独占 shell 与受管冲突操作不重叠。  
Q04：排队期间取消／撤权不执行，排队资源释放。  
Q05：parent spawn/wait child 时无 slot 或工作区锁死锁。  
Q06：任一 sequential 工具仍使整批保持既有串行顺序。  
Q07：background promotion 后资源 lease 正确转移，task_stop 可停止持锁任务。  
Q08：两个 native child 使用相同 workspace 时共享协调，不同环境身份不错误互锁。  
Q09：执行顺序变化不改变 tool result 在历史中的源顺序。

### 完成条件

并发上限、队列取消、锁归属和顺序均有测试；没有依据名字解析任意 shell 以推断完整副作用；没有覆盖掉现有细粒度文件协调；不以假模型测试结果推导真实模型性能提升。

---

## 11. P07 — 关联观测与模型状态作用域

### 目标

让新增边界可排障，并巩固现有多 provider 与 cache affinity 设计。不是重写 `packages/ai`，也不默认增加连接预热。[SRC-05][SRC-07][SRC-14]

### P07-A：低侵入关联观测

复用已有 telemetry 接口和 provider context observation。关联标识建议为：

```text
sessionId / sessionGeneration
runId
stepId / contextProjectionRevision / toolPlanRevision
toolCallId / executionAttemptId
```

按以下阶段观测：

```text
输入被接受 → preparation → provider request → tool preflight
→ policy decision → scheduler wait → handler execution
→ execution result ready → postprocess / persistence → resource settled
```

只增加内部字段或向后兼容的 diagnostic event；不为了一个 ID 重写所有 public events。时间间隔使用单调时钟，测试注入 clock；wall clock 仅用于展示和外部关联。

日志默认记录标识、原因码、时长、数量和必要版本，不记录原始 prompt、完整工具参数、文件内容、API key、cookie、完整 env 或 token 派生哈希。标识不得进入 system prompt 破坏缓存前缀。

### P07-B：模型连接／缓存契约测试

查清当前 provider adapter 的身份归属，再针对本次路径补测试。可改受影响的资源失效逻辑，不扩展成无关 provider 重构。

| 场景 | 要验证的结果 |
|---|---|
| 同 session 继续 | 合法的 cache affinity 按既有规则保留 |
| preserve/fork child | child 拥有独立 native session、history、取消与请求身份 |
| 更换认证主体 | 旧连接归属、增量 response 关联与路由状态不被错误继承 |
| 压缩替换 history | 新 context identity 被观察到，不能继续假装旧 prefix 未变 |
| 模型／工具计划变化 | 观察记录与本 step 绑定一致，不混入另一步的设置 |
| child dispose | 只清理 child 所有资源，不误清理 parent 的共享 provider 状态 |

认证测试使用 fake auth owner 和 fake transport，不需要用户登录、真实 token 或网络请求。认证主体版本应来自内部身份／凭据版本，不用原始 token 作为日志标签。

### 测试

O01：一次调用可从 run 关联到 step、toolPlan 和执行结果。  
O02：scheduler wait 与 execution duration 分开，fake clock 下值可预测。  
O03：观察者异常／试图修改数据不改变实际请求与执行。  
O04：日志脱敏测试不包含哨兵密钥、完整 payload 或秘密环境变量。  
M01：parent/child cache affinity 合法继承但执行身份独立。  
M02：认证主体变化正确失效旧资源。  
M03：压缩后 context identity 与 prefix 行为符合既有约定。  
M04：本次未涉及的 provider adapter 行为不被全局重构波及。

### 完成条件

可以解释一次慢调用耗时在哪个阶段，可以定位一次被取消的晚启动尝试；已有模型测试通过；没有新增真实 API 依赖、provider payload 噪声或敏感日志。

---

## 12. P08 — 集成验收与交付

### 12.1 集成场景

必须通过以下端到端的本地模拟场景，使用真实主链 + faux provider，而非用一组互不相连的 mocked 新类代替：

**场景 E01：工作中取消。** 请求产生多个工具；一个已运行、一个预检中、一个排队；用户取消。未启动的不得启动，已运行的结果真实结算，输出与事件不重复。

**场景 E02：运行中变更配置。** 模型请求进行时替换工具 registry／模型设置，随后返回旧 tool call。旧 step 保持绑定，下一 step 使用新配置；中间祖先撤权立即阻断尚未执行的调用。

**场景 E03：压缩与通知并发。** provider preparation 激活压缩，同时到达 steering／后台完成通知。消息按原语义消费一次，system prompt 和 projection 一致，工具结果配对不被插断。

**场景 E04：关闭与 session replacement。** root 有 native child 和后台进程；同时出现 tool result、log drain、child abort 和 session switch。旧资源不能污染新 session，未收尾不能报告安全移交。

**场景 E05：共享工作区。** 两个 native child 修改同一文件、不同文件和执行仓库级 shell。验证既有文件修改序列、允许的并行和控制路径无死锁。

**场景 E06：失败的收尾。** writer error、持久化失败、取消中的工具、清理 deadline 分别发生。工具不自动重放；执行结果与收尾失败分开；关闭报告准确。

### 12.2 性能与资源验证

使用可复现的合成历史、工具流和慢 writer，记录改造前后相同参数的样本，不使用真实 provider。

至少检查：没有每个 tool call 复制全历史；队列和 listener 不随已结束 run 单调增长；旧 binding 在最后使用后释放；日志背压有界；不同文件仍能并行；注册了大量工具时计划构建和查找无明显意外平方级路径。

墙钟性能数字不能作为噪声环境下唯一 pass/fail 门槛。结构性上界和调用次数断言优先；需要量化阈值时在 P00 记录环境、样本和理由。

### 12.3 最终完成定义

- P00—P07 的全部适用必测项通过，且阶段没有未说明的 blocker。
- 修改过的测试逐个运行；相关既有 suite 通过；`npm run check` 通过；经隔离 wrapper 运行的 `./test.sh` 通过。
- 对当前宿主无法测试的平台明确标记未覆盖；不能声称跨平台全部通过。
- 本地原有失败与本次新增失败逐条区分；出现本次引入的失败不得以“看起来无关”忽略。
- 公开 API／扩展／事件兼容验证通过；没有新增 default permission mode、审批 UI 或真实请求。
- 提交范围仅包含本任务拥有的文件；没有模型生成数据、锁文件、认证资料和无关格式修改混入。
- `baseline`、`decisions`、`test-matrix`、`progress`、`summary` 与代码一致，结论可追溯到实际命令和 diff。

存在测试环境缺失或基线阻塞时，可以交付部分补丁与报告，但状态必须是 `partial/blocked`，不是“改造全部完成”。

---

## 13. 测试组织与安全运行命令

### 13.1 测试位置

以下为**建议新增名称**，不是宣称仓库已有文件；P00 发现同职责测试时扩展现有文件，避免重复设施。

| 包 | 建议测试 |
|---|---|
| agent | `test/runtime-cancel-admission.test.ts` |
| agent | `test/run-scope.test.ts` |
| agent | `test/step-snapshot.test.ts`、`test/tool-plan.test.ts` |
| agent | `test/background-task-lifecycle.test.ts` |
| agent | `test/resource-scheduler.test.ts` |
| coding-agent | `test/suite/runtime-request-boundary.test.ts` |
| coding-agent | `test/suite/runtime-shutdown.test.ts` |
| coding-agent | `test/suite/runtime-tool-authority.test.ts` |
| coding-agent | `test/suite/runtime-refactor-integration.test.ts` |
| subagent | 与 native host/controller 对应的现有测试，必要时新增 scoped lifecycle 测试 |
| ai | 在实际受影响 provider 的现有 fake transport 测试中扩展 |

coding-agent suite 使用 `test/suite/harness.ts` 与 `packages/ai/src/providers/faux.ts`。[SRC-03] 不凭空编造 issue 编号；没有真实 issue 的广义 lifecycle 回归放在 suite 根目录，遵循本地规则。

### 13.2 环境隔离

定向测试也不能默认继承真实用户 HOME、代理认证或 API 环境。优先复用本地测试 wrapper 的 env 白名单与临时 HOME 规则；若不支持定向运行，在 Agent 自有临时目录创建小 runner 复用该隔离方式，不修改产品默认测试脚本来省事。

测试资源只能在带明确归属标记的临时目录中创建和清理。禁止读取用户 `~/.epi`、`~/.pi`、SSH、云凭据或本地模型 endpoint。需要 OS 进程测试时运行测试创建的 Node fixture，不运行任意项目脚本或真实构建命令。

### 13.3 定向 Vitest 命令

确认文件已存在后，在**已隔离的测试环境**里从对应 package 根目录执行；不通过 npx 临时下载另一版本工具。

```bash
cd "$EASY_PI_DIR/packages/agent"
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/runtime-cancel-admission.test.ts

cd "$EASY_PI_DIR/packages/coding-agent"
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/suite/runtime-request-boundary.test.ts
```

如果本地 HEAD 改了 runner、测试目录或 package 配置，以检查后的实际命令为准，更新 baseline，不继续执行不存在的路径。

### 13.4 检查与最终非真实 API 回归

```bash
cd "$EASY_PI_DIR"
npm run check
./test.sh
```

分析版本的 `npm run check` 含 `biome check --write`，**会修改文件**；只能在本任务可控的隔离工作区运行，并检查产生的全部 diff。[SRC-02]

`./test.sh` 从空环境启动并隔离 HOME、临时文件和凭据；它内部调用测试脚本，不等于允许你在未隔离环境直接运行根 `npm test`。[SRC-01][SRC-16]

不直接运行全 Vitest suite，不自动运行 `npm run build`、`npm test`、release、publish、真实 smoke prompt。构建确实成为验证必需且已获用户授权时，才使用检查后的 offline 构建路径；不能让 build 顺带刷新模型目录或访问网络。

命令输出必须完整保留，不用 `tail` 截掉错误。保存日志时可使用带 `pipefail` 的 tee 或等价 runner，记录真实退出码；日志中不得包含凭据。文档本身不等于任何命令已经运行。

### 13.5 测试编写要求

用 deferred/barrier 控制竞态，用 fake timers/clock 控制 deadline，用 fake process/writer 注入错误；不要用任意短 sleep 作为 correctness 证据。

覆盖所有权和副作用次数，不仅断言函数返回某个字符串。涉及真实子进程时严格验证测试创建的 pid／进程组，不用名称匹配杀掉用户进程。每个测试都应有 finally 清理，失败路径也不能遗留资源。

---

## 14. 提交、并行 Agent 与暂停规则

### 14.1 提交纪律

遵循本地 AGENTS：每个已验证阶段按规则提交，只 stage 自己本阶段拥有的明确路径，提交前检查 staged diff；不等待额外指示才记录已完成改动，但不得越权 push、发布或创建远程 PR。[SRC-01]

存在他人预先 staged 的修改或同文件混合修改时，不直接 commit 整个 index。切换到隔离工作区或先解决文件所有权，不能用 stash/reset 隐藏问题。

禁止：`git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、`git add -A`、`git add .`、`git commit --no-verify`、force push。不要自动撤销 user 或其他 Agent 的未提交修改。

推荐提交意图示例，具体 prefix 遵循本地规则：

```text
fix(agent): prevent cancelled prepared tools from starting
feat(agent): centralize run admission and settlement
feat(agent): bind request tool plans to step snapshots
fix(coding-agent): await owned runtime shutdown
feat(agent): enforce final host execution admission
feat(agent): bound tool execution with scoped coordination
feat(agent): correlate runtime boundary diagnostics
```

不为了拆提交将失败测试长期留在主执行路径。changelog 按当前分支和本地规则处理；非 main 分支禁止新增 changelog 时，在 summary 保留待发布说明，不擅自修改已发布条目。

### 14.2 多 Agent 协作

**默认一个实现 Agent 拥有共享核心文件。** `agent-loop.ts`、`agent.ts`、`agent-session.ts`、共享 types 和 native host 不允许多个写 Agent 同时修改。

可以并行的是只读代码审计、测试设计、独立 reviewer，以及接口冻结后互不重叠文件的测试实现。所有写任务需要明确 owned files、基础 HEAD、契约版本和集成负责人。

不创建两个相互独立的 RunScope／scheduler／permission dispatcher 再在最后“合并”。P02 的状态归属和 P03 的 snapshot 契约必须先统一。reviewer 应检查实际 diff 与测试，不只读实施 Agent 的总结。

### 14.3 真正需要暂停的情况

| 情况 | 正确动作 |
|---|---|
| 本地与参考代码不同，但能找到等价主链 | 更新导航并继续，不强制回退源码 |
| 缺陷已修复 | 记录证据，补缺失回归，不重复改造 |
| dirty worktree 与目标文件冲突 | 停止修改冲突文件，保留现场；不清理他人工作 |
| 需要破坏公开 API 或删除有意功能 | 记录具体兼容冲突、最小替代方案，等待产品决策 |
| 需要新增依赖、真实 API、OS sandbox 或安全模式 | 列为范围外，不偷偷执行 |
| 发现测试已有基线失败 | 单独记录；不修改无关模块掩盖，不能宣称全部验证通过 |
| 同进程工具无法强制终止 | 返回真实关闭限制，不能靠丢弃 promise 伪装完成 |
| 控制队列／资源锁出现循环等待 | 停止叠加补丁，回到 owner 与锁依赖设计 |
| 本次上下文或执行预算不足 | 更新进度、保留绿色边界、写精确 next step，交付已完成部分 |

“暂停相关部分”不要求放弃所有不受影响的验证；但不得跳过失败的依赖阶段继续改依赖它的生产代码。

---

## 15. 进度、证据与交接模板

### 15.1 `runtime-refactor-progress.md`

```markdown
# Runtime Refactor Progress

## 工作区
- Easy-pi root:
- Easy-pi starting HEAD:
- Current HEAD / branch:
- Codex reference root / HEAD:
- Execution scope:
- Working tree ownership / pre-existing changes:

## 阶段
| Phase | Status | Owned files | Evidence | Commit / diff | Next action |
|---|---|---|---|---|---|
| P00 | pending | | | | |
| P01 | pending | | | | |
| P02 | pending | | | | |
| P03 | pending | | | | |
| P04 | pending | | | | |
| P05 | pending | | | | |
| P06 | pending | | | | |
| P07 | pending | | | | |
| P08 | pending | | | | |

## 当前阻塞
- 事实：
- 影响的不变量与阶段：
- 未执行／未覆盖：
- 建议处理方式：

## 下一位 Agent
- 首先阅读的文件：
- 首先运行的命令：
- 必须保留的修改：
- 精确下一步：
```

状态只使用 `pending / in_progress / passed / already_present / partial / blocked / deferred`。`already_present` 必须引用实际源码和测试；`passed` 必须有执行证据。

### 15.2 `runtime-refactor-test-matrix.md`

```markdown
| Test ID | Invariant | Actual test file + test name | Baseline | After change | Command/log | Platform |
|---|---|---|---|---|---|---|
| C01 | I01 | | not_run | not_run | | |
| S01 | I03 | | not_run | not_run | | |
| L02 | I08 | | not_run | not_run | | |
| A02 | I05 | | not_run | not_run | | |
| Q05 | I10 | | not_run | not_run | | |
```

为本文所有适用 Test ID 补行。结果写 `pass / fail / baseline_fail / not_run / not_applicable`；不适用必须解释。本机通过不能代表所有平台通过。

### 15.3 `runtime-refactor-decisions.md`

每项非平凡选择用以下格式，避免抽象口号：

```text
问题与具体时序：
考虑过的最小方案：
选择及必要性：
真实代码落点：
兼容影响：
失败／取消语义：
对应测试：
本次没有解决的边界：
```

至少记录 RunScope 单一所有者、StepSnapshot finalization、extension generation、live authority、shutdown deadline、资源锁所有权、并发上限、认证资源失效。

### 15.4 最终 `runtime-refactor-summary.md`

必须包含：起止 HEAD、已完成与未完成阶段、最终调用图、关键不变量如何由代码保证、API／事件兼容性、真实测试命令及结果、平台覆盖、性能／资源样本、残余风险和最小恢复方式。

回退说明按阶段提交描述，但不要自动回退用户工作。取消与 hard policy 的修复不能通过“默认 fallback 到旧不安全路径”来回退。若 snapshot／scheduler 暂时回到旧路径，也必须保留 P01/P02 的最终准入与安全收尾保证。

---

## 16. 源码依据与实施时复核方法

本节来源用于解释计划为何这样拆分，不代替 P00 的本地复核。路径均为仓库相对路径。引用的是代码／仓库规则，实施要求和建议模块是本计划设计，并非声称 Codex 或 easy-pi 已有相同 API。

### easy-pi 参考 SHA

`dba1626064e8fd5339c18d7430355c985e2956e9`

| ID | 源码 | 支撑内容 |
|---|---|---|
| SRC-01 | `AGENTS.md` | 完整阅读、TypeScript 规则、定向测试、check、真实 API 禁用、提交与共享工作区纪律 |
| SRC-02 | `package.json` | check 包含自动写格式修正、browser smoke；Node 与 workspace 脚本 |
| SRC-03 | `packages/coding-agent/test/suite/README.md` | 新 suite 使用 harness 与 faux provider，禁止真实 API |
| SRC-04 | `packages/agent/src/agent-loop.ts` | 预检／并行启动、hook 后 revalidation、最终 execute 入口、结果归一化 |
| SRC-05 | `packages/agent/src/agent.ts` | context snapshot、activeRun、loop config、cache identity 字段 |
| SRC-06 | `packages/coding-agent/src/core/agent-session.ts` | 压缩投影 revision、provider context observation、request refresh |
| SRC-07 | `packages/subagent/src/session-host.ts` | native child contract、实时 ancestry 工具限制、权限 provider、独立缓存关联 |
| SRC-08 | `packages/agent/src/harness/env/background-task-manager.ts` | 前后台进程管理、日志、终态通知、cleanup |
| SRC-09 | `packages/agent/src/harness/tools/workspace-policy.ts` | 路径检查为 best-effort，不是对抗性文件系统安全边界 |
| SRC-10 | `packages/permissions/src/permissions.ts` | Full Access 类型、当前 hard deny 决策 |
| SRC-16 | `test.sh` | 空环境白名单、临时 HOME、凭据隔离的默认测试入口 |

### Codex 参考 SHA

`516f2780fd227a80cd9fe89488f5039245090b71`

| ID | 源码 | 支撑内容 |
|---|---|---|
| SRC-11 | `codex-rs/core/src/session/step_context.rs` | request-scoped settings、环境与同一步 advertised/executed ToolRouter |
| SRC-12 | `codex-rs/core/src/tools/parallel.rs` | 保留 StepContext、共享／独占准入、执行终态与取消竞争 |
| SRC-13 | `codex-rs/core/src/tools/orchestrator.rs`、`sandboxing.rs` | approval／policy／sandbox／attempt 的职责分离 |
| SRC-14 | `codex-rs/core/src/client.rs` | model client 的 session／turn 作用域与认证变更失效 |
| SRC-15 | `codex-rs/core/src/session/handlers.rs`、`turn_suspension.rs` | 停止生产者、flush、writer 关闭与交接顺序 |

本地保有参考 commit 时，可以用只读方式比对，无需 checkout：

```bash
git -C "$CODEX_DIR" show 516f2780fd227a80cd9fe89488f5039245090b71:codex-rs/core/src/session/step_context.rs
git -C "$EASY_PI_DIR" show dba1626064e8fd5339c18d7430355c985e2956e9:packages/agent/src/agent-loop.ts
```

浅克隆没有参考 commit 时不要因此停止：阅读本地 HEAD 的等价源码，记录差异；未经需要不自动 fetch 整个历史。

---

## 17. 给 Agent 的最后检查

在宣布一个阶段完成前，回答：

**这次请求使用哪个版本的配置和工具？此刻是否仍允许开始副作用？发生取消后哪些结果仍然真实？关闭返回时哪些资源确实结束？我有什么实际测试证据？**

回答不清楚时，不再增加抽象层或新功能，先补事实、归属和测试。

本次交付应是一组可验证、可审查的小改动，而不是把 easy-pi 改造成另一个 Codex。
