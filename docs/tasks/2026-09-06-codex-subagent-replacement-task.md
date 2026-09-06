# Task Plan: Codex 式 Subagent 原生替换

- Created: 2026-09-06
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求“分析 @codex/ 的 subagent 实现，计划迁移到 easy pi，替换现在的 subagent”，并通过结构化选择确认 Codex V2 语义、Pi 原生实现、共享工作目录和本轮只规划。

<!-- task-doc-section:background-goal -->
## Background and goal

将 easy-pi 的模型驱动委派从“一次调用执行持久 DAG，返回工件/候选”改为“可命名、可交流、可追加任务的子会话”。以本地 Codex 源码为行为参考，不把 Rust 文件直接搬入 TypeScript，也不嵌入 Codex CLI/app-server。

**确认状态：用户已明确要求“实施改造计划”，授权按本文串行实施；真实数据处理/模型/发布边界不变。** 本文是替换工作的唯一状态记录；原 `2026-09-06-easy-pi-product-integration-task.md` 仍管理产品总体整合、官方 Pi 兼容与发布。本计划不是原整合验收已完成的证据；执行切换时须同步原文档的 T-002/T-004/T-005 相关验收，不能沿用旧 DAG 的通过记录认证新实现。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

已确认：
- Codex V2 六工具的交互语义，以 Pi 会话、provider、登录和公开扩展接口实现。
- 所有 Agent 共享主工作目录；不再强制 Writer worktree、独立 Reviewer 门禁、候选 ref/自动合并。并行编辑冲突不再由工作树隔离解决。
- 保留 `.epi`、easy-pi 权限（默认 full-access，允许凭据读取，保留灾难性删除拦截）、自定义压缩、主会话兼容边界。
- 中断不回滚编辑、不自动续跑；持久化成果和历史清理仍须遵守显式交付/丢弃确认。
- 规划阶段只写本文；现已授权修改 easy-pi 相关实现和任务记录。Codex 源码只读，现有未提交成果保全，不处理真实用户数据。

明确排除：Codex 二进制/Rust 构建依赖、Codex 认证/Responses 私有消息协议、OS sandbox 承诺、Pi 已退休的 V2 文件工具、真实 provider 调用、npm 发布、旧 DAG 数据直接转为新子会话、删除原 WJ 源码。Codex 的 MultiAgentV2 与 Pi 退休的工具 V2 没有关联。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

### 基线和证据等级

- 源：`../codex`，HEAD `a9519cbcdd2d664530edb2469224ee03c1056799`，`git status --short` 空。仅指该本地修订，不声称官方最新。
- 目标：HEAD `879821596a00f491b1ced4d1a856007b8a180f21` 加 dirty 工作区。T-005 清理/中断保护改动尚未提交，root lock 既有 accounts 35 行和未跟踪包/文档保留。
- 分析时 tracked 差异指纹：`git diff -- packages/coding-agent/src/extensions/easy-pi.ts packages/subagent | shasum -a 256` = `6a0671e5ef060f41d52f7c01abe506c64fab0e1a10c0d6be8b1f7bd64dfe7f35`。
- 未跟踪 `delivery-cleanup.ts` SHA256 `9d104eaf7fd1f106f1a3044dfbb7d41a2365848f1e80c780478b29738f9348f6`；其测试 `0404f3fb5ddea05e36e8fdd6330fb9b27e9d9a757216936ddc99204e39a0421a`。执行前重新核对，不把指纹当备份。
- 下表均为静态实现/声明证据（C2），测试源码只佐证设计意图；本轮没有运行 Codex 或 Pi 行为测试，不能标记 C4 或推断性能更好。

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Codex 同时维护 V1/V2；本地 feature 表均标 Stable，但 V1 默认 true、V2 默认 false | `../codex/codex-rs/features/src/lib.rs:1205-1216`；core `tools/spec_plan.rs#add_collaboration_tools:1275` |
| F-002 | V1 为 spawn/send_input/resume/wait/close；V2 为 spawn/send_message/followup_task/wait/interrupt/list，按 feature/模型能力注册 | core `tools/spec_plan.rs:654-693,1275-1360`；`tools/handlers/multi_agents_spec.rs:65-353` |
| F-003 | 控制器按根会话树共享 registry，而不是跨整个 ThreadManager 的全局 Agent 名册 | core `agent/control.rs#AgentControl:113-134` |
| F-004 | spawn 在核心中创建逻辑会话，保留父/根 turn 来源；不是为每个子 Agent 启动 Codex CLI | core `agent/control/spawn.rs#spawn_agent_internal:584-788` → `thread_manager.rs#spawn_thread:1864` → `Session::spawn:1990` |
| F-005 | V2 用规范任务路径命名；spawn 需要 message/task_name，fork_turns 支持 all/none/正整数字符串，默认 all | core `tools/handlers/multi_agents_v2/spawn.rs:93-330`；protocol `src/agent_path.rs` |
| F-006 | 子配置继承 live turn 的 model/provider/推理设置/cwd/权限快照，再协调角色覆盖；冷加载校验所属根树/父信息并重建配置 | core `tools/handlers/multi_agents_common.rs:177-262`；`agent/control/spawn.rs#ensure_v2_agent_loaded:296-428` |
| F-007 | send_message 与 followup_task 的关键差别是 trigger_turn；followup 禁止指向 root | core `tools/handlers/multi_agents_v2/message_tool.rs:12-153` |
| F-008 | V2 wait 不接收 agent ID 列表，而订阅当前会话邮箱/steer 活动；超时不取消 Agent | core `tools/handlers/multi_agents_v2/wait.rs:40-216`，不同于 V1 `multi_agents/wait.rs` |
| F-009 | V2 子会话完成向父 Agent 投递结果且不触发父新 turn；发起方活动事件和父结果路由不是同一概念 | core `session/mod.rs#forward_child_completion_to_parent:2124-2230`；`tests/suite/subagent_notifications.rs#multi_agent_v2_peer_followup_completion_notifies_initiating_turn:2640` |
| F-010 | interrupt 禁止 root/self，返回 previous_status；list 返回已加载 Agent，可按路径前缀筛选，不等同持久化历史 inventory | core `tools/handlers/multi_agents_v2/interrupt_agent.rs:32-104`；`agent/control.rs#list_agents:498-571` |
| F-011 | 执行配额与内存驻留是两层；LRU 卸载前 materialize rollout、shutdown，再移除内存对象，不等于删除历史文件 | core `agent/control/execution.rs:14-98`；`agent/control/residency.rs:81-158`；`agent/control/spawn.rs:155-226,296-582` |
| F-012 | Codex V2 明确声明共享 cwd/文件系统，已检视 spawn 路径继承 cwd；未见当前 easy-pi 式 ownedPaths/worktree/candidate gate | core `session/multi_agents.rs:54-65` 与 `multi_agents_common.rs:235-262`、`agent/control/spawn.rs:584-788`；结论仅覆盖这些协作路径 |
| F-013 | easy-pi 当前工具为单个 subagent(tasks[]) DAG，依赖/reviewOf/ownedPaths；child 默认由 Node RPC 子进程执行 | `packages/subagent/src/extension.ts:1612-1630`、`types.ts:119-174`、`process-runner.ts:1191,1366` |
| F-014 | Pi SDK 提供创建独立会话、事件、abort/dispose、自定义消息；但 steer/followUp/sendCustomMessage 不天然等于 Codex 邮箱 | `packages/coding-agent/docs/sdk.md:46-120`；`src/core/sdk.ts:38-86`；`src/core/agent-session.ts:1576-1717` |
| F-015 | fork 必须处理 Pi 的 replacementHistory，不能仅复制历史 JSONL 最后 N 条；会话替换 API 属 AgentSessionRuntime | `packages/coding-agent/src/core/session-manager.ts:512-536,1505,1672`；`docs/sdk.md:120-127` |
| F-016 | 现有装配读取进程环境 child context；权限代码特判旧 subagent 名；Grok 渲染特判旧工具；打包 joint compile 包含私有 subagent | `src/extensions/easy-pi.ts:45,104-110,210-303`；`packages/permissions/src/permissions.ts:821-823`；`grok-tool-execution.ts:104-105`；`scripts/build-easy-pi-product.mjs:17-24`；coding-agent `tsconfig.product-build.json:32-53` |
| F-017 | Codex 仓库许可证 Apache-2.0，NOTICE 含 OpenAI 及第三方声明 | `../codex/LICENSE`、`../codex/NOTICE`；移植代码/文本须逐文件审查来源和声明要求 |

### 三条关键执行路径

1. **创建**：模型 spawn → 参数/AgentPath/配置解析 → 根树 AgentControl → 执行/驻留/名称预留 → 新建或 fork Pi 等价会话 → 持久化父子关系 → 投递初始任务 → 返回 Agent 引用。失败必须释放预留；“返回引用”不等于任务成功。
2. **交流与完成**：模型 send/followup → 同根树目标解析 → 必要时加载子会话 → 队列投递（是否触发 turn 独立判断）→ 子 turn 完成 → 有身份的结果消息投递父邮箱 → 当前 wait 唤醒或下次显式 turn 消费。不能把模型正文当操作命令，也不能把结果当用户授权。
3. **中断与恢复**：interrupt → 校验 root/self/所属树 → abort 当前执行 → 保留会话与共享目录编辑；进程退出后恢复索引只展示 interrupted/待处理状态。用户明确追加任务才重启推理；加载历史与重放副作用必须分开。

### 替换差异与后果

| 维度 | 当前 easy-pi | 目标 |
| --- | --- | --- |
| 编排 | 一次提交 DAG、拓扑执行、统一返回 | 主 Agent 按需创建/联系子 Agent，持续多轮 |
| 写入 | ownedPaths、隔离工作树、候选/门禁 | 同 cwd 直接写入；不创建自动 commit/merge/ref |
| 质量 | 结构化 handoff 与 Controller gate | 结果消息；测试/独立审阅是明确任务，不再冒充平台保证 |
| 生命周期 | run/task/attempt/lease | root-session/agent/turn/message；Completed 是一轮结束，可再分配任务 |
| 通信 | 依赖投影与最终返回 | 独立邮箱、触发式任务、被动结果通知 |
| 状态 | SQLite DAG ledger/工件/任务 runtime | Pi 子会话 + 轻量版本化团队索引/邮箱，不复用旧 DAG 表语义 |
| 中断 | 当前正在补工作树保留保护 | 停止执行但不撤销已经发生的共享目录修改 |
| 配额 | 任务 token/重试/角色预算 | 根树并发 + 总 Agent/深度/消息/上下文限制；保留真实用量统计，不承诺沿用旧任务预算语义 |

**源码中不能照抄的细节**：V2 使用说明声称完整 fork 不接受模型覆盖，但 spawn 实现仍调用模型覆盖/角色解析，且存在完整 fork 模型优先级测试。计划优先规定可测试的 easy-pi 行为：省略则继承，显式覆盖须支持该 provider/model/effort，顺序写入契约；不得仅复制 prompt 当验证。Codex root-inclusive 并发说明与子 Agent 执行 guard/配置换算也须整体理解，不能抄单个 counter。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

### 用户已确认的决定

- 共享工作区、Codex V2 交互语义、Pi 原生实现；无需再次询问这三项。
- 用户后续授权实施。既有保护未交付成果、无自动续跑约束继续有效。

### T-001 固定契约

实现位置：`packages/subagent/src/collaboration-contract.ts`。六工具输入均禁止未知字段，不强制兼容 Codex provider 专有 wire 格式：

| 工具 | 输入 | 返回/语义 |
| --- | --- | --- |
| spawn_agent | task_name、message；可选 fork_turns、model、reasoning_effort | task_name 规范路径；只确认创建，不确认交付 |
| send_message | target、message | message_id/status=accepted；不唤醒 idle |
| followup_task | target、message | message_id/status=accepted；idle 开新 turn，running 拒绝 busy（先 interrupt 或等待）；不得指向 root |
| wait_agent | 可选 timeout_ms | reason=mailbox/user_input/timeout 和 timed_out；不取消 Agent |
| interrupt_agent | target | previous_status；不得 root/self，不回滚编辑 |
| list_agents | 可选 path_prefix | agents 的 task_name/status/loaded；显式 loaded 避免将持久 Agent 误报为当前执行 |

- AgentPath 是逻辑地址 `/root/<name>`，单段最多 64 ASCII 字符，子级上限 4；相对目标允许 `..` 但不可越过 root。实际授权还须检查调用者 rootSessionId 和 controller 内注册关系，路径格式不是授权。
- 根树最多 32 个 Agent（含 root/已卸载），最多 4 个活动会话，固定留 1 个 root 控制槽；每邮箱最多 64 条 pending，每消息最多 8192 UTF-8 bytes，fork 快照最多 256 KiB，超限明确失败。上限不是操作系统隔离。
- wait 默认 30 秒，0 至 10 秒夹至 10 秒，上限 1 小时，非整数/负数/超限拒绝。无 busy polling。
- fork 缺省 all；none 或 1–999999 的完整 turn 数；模型必须 provider/model，推理值采用 Pi 的 off/minimal/low/medium/high/xhigh/max（T-003 按实际 ThinkingLevel 类型补全 max）。省略继承；不支持的 model/effort 拒绝而非静默降级。暂不暴露没有实现角色解析的 agent_type。
- 状态 pending→running→completed/failed/interrupted；completed/failed/interrupted 可显式进入下一 running 或 closed；closed 不可复活。completed 不代表交付。权限/容量/上下文/存储/busy 错误分门别类，不回显任意异常内容。
- 旧模型工具 subagent(tasks[])、ownedPaths/reviewOf 与旧预算/模型路由命令在最终切换时显式退休；旧数据过渡检查仍另行保留，不让旧 DAG 继续接受新任务。

### 实现建议（不是已验证代码）

- 沿用私有 `@easy-pi/subagent` 包边界，但替换内部控制器；纯控制逻辑只依赖 `ChildSessionHost` 一类小接口，由 coding-agent 装配真实 SDK，避免 subagent 反向运行时导入 coding-agent 的循环依赖。
- 优先同进程多 `AgentSession`，接近 Codex 逻辑线程；T-002 必须先证明扩展、权限、事件和 dispose 隔离。不依靠 `process.chdir()` 或修改 `process.env` 传子身份；若现有扩展全局状态使此边界不可满足，停止该切换并提交证据，重新评估复用 RPC transport，不能暗中换成 Codex 进程。
- 使用版本化团队目录（例如 `.epi/agent/teams/<root-session-id>/`）保存索引/子 session/邮箱元数据。具体格式在 T-003 定稿，不新建另一套完整 DAG 数据库；是否需要 SQLite 由跨进程所有权/原子投递实验决定。
- 配额建议首版最多 4 个同时执行的会话（含 root）、明确保留 root 控制通路；并发 admission 必须原子化。总 Agent 数、最大深度、消息字节/数量和上下文上限必须在 T-001 固定，禁止无限制递归或邮箱增长。wait 的业务等待不应误用子任务执行超时。
- `send_message` 不唤醒空闲 Agent，`followup_task` 才安排新一轮；主用户消息优先于邮箱，父结束后结果不自动启动推理。实际运行过程中的消息注入时机以 T-001 规范和 T-004 测试为准。
- fork 默认 all，支持 none/正整数；all 指当前分支有效上下文，不是所有历史分支/被压缩淘汰的上下文。无法从 checkpoint 可靠恢复 N 个完整 turn 时应明确拒绝或报告不可用，不能伪装已完整继承。
- 将 Codex 明文身份消息转换为 Pi 有界 custom message；不依赖 OpenAI 专属 analysis recipient/encrypted_content。消息包含来源、目标、turn、message ID；不扩展为技能命令、不授予权限。跨 provider 一致性单独验收。
- 新模型工具面只注册六工具，不保留隐藏的 DAG 调度双栈。旧历史仅提供显式只读检查/导出和确认清理的过渡入口；旧 `subagent` API 是易见的破坏性变更，不宣称语义兼容。

### 执行前待落实

- 真实旧任务目录的处理需要单独授权；先用合成数据证明兼容出口，不因“替换”而读取或清除真实 ledger。
- 对仍在运行的旧进程，切换须有 drain/退出门槛；不热切换其 run，不自动接管。
- 自定义第三方扩展是否使用全局可变状态目前未知；同进程隔离不能由 SDK API 名称推导。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 六工具按固定契约注册，CLI/SDK 默认可用；未暴露虚假的 Codex 私有能力，旧 DAG 不参与新任务调度。
- 根会话间不可访问 Agent/邮箱；同树 nested spawn/peer message 按明确定义工作；子 Agent 不能扩大父权限。
- all/none/N fork 尊重 replacementHistory、工具调用/结果配对和 branch；模型/effort/工具/权限继承可验证。
- mailbox 等待无丢唤醒、无 busy polling；send 不唤醒闲置 Agent、followup 触发、完成通知不自动续跑父会话。
- 并发预留/失败回滚/abort/释放无泄漏；超时不隐式重放 provider 请求或文件修改；用量未知不得填零冒充。
- 共享写入真实可见，中断不删除/回滚编辑；不再创建 worktree/候选 ref/合并，文档和工具 prompt 不再承诺旧 gate。
- 重启只恢复可检查状态；索引/邮箱/子历史持久化故障不假成功；显式恢复不重放已执行 shell/edit。
- 新可回收历史/日志预算 256 MiB / 7 天；未确认结果只告警不删除。主会话和 auth 不纳入任务 GC；旧格式无法识别时 fail closed。
- 旧未交付成果可检查/导出/显式处置，新运行时不改写旧 ledger。保护现有未提交文件、accounts lock、冻结评测。
- 定向合成 provider/并发测试、root check、离线构建/包安装/启动验收通过；无真实 provider 和 npm 发布。官方 Pi 公共兼容仍由原 T-006 单独验证。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006 -> T-007.
- Parallel batches: 无必须并行批次；按上述顺序逐阶段落地，避免调度、会话、权限和状态协议并行漂移。
- Serialization constraints: coordinator 独占本文、默认装配、权限接线、会话核心、生成锁文件和历史过渡；新旧切换仅在其余 gates 通过后进行。沿用用户既有串行许可，不重试已失败的 Subagent 委派编排。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定替换契约与保护基线

- Status: done
- Owner: coordinator
- Objective: 将本文行为映射变为参数/返回值/状态转换契约，保全旧实现和未提交成果。
- Inputs and prerequisites: 用户授权实施；本文确认决定、F-001 至 F-017、当前 Git 状态。
- Scope or files: 本文；拟新增 packages/subagent 新契约与定向 contract tests；原产品整合任务的关联说明。
- Expected output: 六工具 schema、Agent/turn/message 状态定义、配额、错误/取消/兼容规则、可回退旧基线。
- Dependencies: None.
- Execution steps:
  1. 重新核对 dirty 指纹；只保存本任务既有修改，禁止 stash/reset 或夹带 accounts。
  2. 规定命名、同根授权、fork、idle/running followup、wait、模型优先级及有限资源参数。
  3. 固定旧 API 移除清单和历史导出/清理边界，同步原整合任务依赖而非标完成。
- Acceptance criteria:
  - 每项六工具能力有成功/失败 oracle；共享写入和破坏性兼容变化明确；执行原子性/失败状态不含糊。
- Verification method:
  - 静态消费者搜索与 schema/状态定向测试；逐项审查冻结/用户改动边界。
- Validation evidence: 新 collaboration-contract.ts 与定向测试固定 schema/path/fork/wait/status 边界；30/30 tests 通过，root npm run check exit 0（只格式化两个新文件）。备份 tar 已校验，旧消费者与打包接线见 F-013/F-016，原整合任务已关联替换验收。未切换默认工具。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 证明 Pi 子会话与权限宿主边界

- Status: done
- Owner: coordinator
- Objective: 建立可注入的子会话宿主，证明同进程独立会话不会串根树身份/权限/生命周期。
- Inputs and prerequisites: T-001 的 contract；Pi SDK/ResourceLoader 和当前权限组合证据。
- Scope or files: 拟新增 packages/subagent/src/session-host.ts；coding-agent/src/extensions 的 Pi adapter、easy-pi.ts；相关 SDK/permission 合成测试。
- Expected output: create/load/prompt/observe/abort/dispose 和上下文快照宿主；显式传入 root/agent 身份与权限。
- Dependencies: T-001.
- Execution steps:
  1. 由 coding-agent 提供 SDK factory，避免 subagent 对其运行时循环依赖。
  2. 替换进程环境 child identity 的新路径；共享认证能力，但经已验证的 createSessionView 隔离可变 provider 注册表，不复制 auth/token 到子目录。
  3. 验证不同 session 的扩展实例、工具注册、授权、事件解绑和 shutdown；dispose 子不能终止 root 或共享模型运行时。
- Acceptance criteria:
  - 两个根树同时运行合成子会话无交叉身份/消息/授权；full-access 与受限模式各有行为断言。
- Verification method:
  - 新 session-host integration tests；现有 easy-pi-harness/default-composition、sdk-session-manager 等指定离线测试。
- Validation evidence: 新 session-host.ts 能力边界与 pi-child-session-host.ts SDK adapter；native harness 显式身份/实时权限回调，不读旧 Child 环境、不注册旧 DAG、不自动批准 ask。宿主 10 项、session view 2 项及既有 SDK/harness/auth/credential/modify-models 共 9 files / 56 tests 通过。root check exit 0。真实写入只在合成 temp cwd；创建/冷加载/抢先取消无 provider 请求，关闭单个 child 不影响 peer/root，未知 usage 不填零。createSessionView 额外修复了被回归实证的 provider 注销串扰（见执行记录）。未验证任意第三方插件模块全局状态隔离，trusted extension 非 sandbox 的边界不变。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 会话树、持久化和原子资源限制

- Status: done
- Owner: coordinator
- Objective: 实现轻量 root-scoped AgentController/registry 和可恢复但不自动运行的状态。
- Inputs and prerequisites: T-002 宿主，T-001 状态和限额。
- Scope or files: packages/subagent/src/collaboration-controller.ts、collaboration-store.ts、test/collaboration-controller.test.ts；coding-agent 原生宿主及测试；契约 reasoning max 补全。
- Expected output: AgentPath/ID 注册、父子关系、执行 admission、有限驻留、版本化索引及故障恢复规则。
- Dependencies: T-002.
- Execution steps:
  1. 原子预留名字/执行槽/状态，失败回滚；区分逻辑 Agent、当前 turn、已加载对象。
  2. 验证 parent/root ID 与真实会话路径；原子保存索引，不记录凭据。
  3. crash 后 running 转待显式恢复；仅卸载 idle 且已持久化会话；不删除成果，不自动重跑。
- Acceptance criteria:
  - 并发 spawn 不超限/重名；释放/重复 abort 幂等；目录/版本不可信时拒绝；历史加载没有 provider 请求。
- Verification method:
  - 确定性并发 barriers；失败注入、重复关闭、跨根访问、断电写入/损坏索引、冷启动合成测试。
- Validation evidence: controller/store + contract 两文件 43 tests passed；实际 Pi host + model runtime view 两文件 14 tests passed。验证并发/同名/总量/嵌套容量、CAS、live-owner 拒绝、dead-owner 显式恢复、未知版本和符号链接不改写、存储失败停止调度、LRU 冷加载不重放。原生未启动子会话冷加载回归先 ENOENT 失败，显式以公开 header/entries 落盘再 reopen 后通过。未模拟硬件断电；SQLite FULL 事务和失败关闭不等于文件系统抗所有断电保证。无真实数据/模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 邮箱、六工具与上下文继承

- Status: done
- Owner: coordinator
- Objective: 实现 Codex V2 式通信、等待和 fork，保证 Pi 上下文/压缩语义正确。
- Inputs and prerequisites: T-003 controller/store；T-001 语义契约。
- Scope or files: packages/subagent/src/collaboration-mailbox.ts、collaboration-controller.ts、collaboration-store.ts、context-fork.ts、contract/session-host；coding-agent/src/extensions/pi-collaboration-tools.ts、pi-child-session-host.ts；指定测试与 docs/collaboration.md。
- Expected output: spawn_agent/send_message/followup_task/wait_agent/interrupt_agent/list_agents 与有界自定义消息。
- Dependencies: T-003.
- Execution steps:
  1. 接入六工具，同步能力/权限检查；禁止 followup root、interrupt root/self，路径限定同树。
  2. mailbox 以消息 ID 和持久消费位置识别重投，订阅与检查待收状态原子化；用户输入可唤醒 wait，超时不取消 child。
  3. 结果先持久化再发送/确认投递；不声称跨存储和 session 无事务情况下的 exactly-once，消除可重现重复上下文注入。
  4. fork 当前有效分支/checkpoint，剔除未完成 spawn 调用等悬空 tool pair；N 按完整 turn 而非 JSONL 行数计算。
  5. 明确 mailbox 与 Pi sendCustomMessage 行为差异，禁止并发直接改 AgentSession 内部 state；必要的安全注入点单独验收。
- Acceptance criteria:
  - 六工具返回与事件可验证；wait 前/中/后到达消息不丢；闲置父不因结果启动；fork 压缩前后都无错配/历史复活。
- Verification method:
  - mailbox/六工具指定测试；faux provider 检查实际请求上下文；checkpoint、嵌套 fork、消息命令注入和模型覆盖测试。
- Validation evidence: 完成内部原生根/子会话接线：subagent controller/mailbox/contract/fork 4 files / 55 tests passed；coding-agent 六工具/host/model-view/checkpoint/harness/default-composition/sdk-stream 7 files / 58 tests passed；root npm run check exit 0。实际 faux 执行六工具、嵌套 spawn/peer message、不同 provider 覆盖、unsupported effort 拒绝、原生 user steering 唤醒 wait；send/完成通知不启动 idle。完成前预留父邮箱容量，结果与终态同事务保存；调用取消在创建期间不启动 child。native 文件 sync 后确认，失败阻止请求、重启不重投，后续 checkpoint 不复活旧正文。公开 Agent.transformContext wrapper 在原 Pi preflight 前注入且 shutdown 恢复原接口，无私有字段修改。all/none/N 与 256 KiB 边界保持，N 仅计最新 compaction 后原始完整 turn。docs/collaboration.md 说明内部装配接口；CLI/SDK 默认切换仍归 T-005，未运行真实 provider/旧数据清理/发行打包。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 产品交互、状态和共享工作区验收

- Status: pending
- Owner: coordinator
- Objective: 默认装配新控制器，显示真实 Agent 活动/结果，验证替代旧 DAG 的用户路径。
- Inputs and prerequisites: T-004 六工具通过；新旧默认接线切换尚未对用户发布。
- Scope or files: packages/subagent/src/extension.ts；coding-agent/src/extensions/easy-pi.ts、index.ts；interactive-grok/components/grok-tool-execution.ts；相关 prompt/权限映射与产品文档。
- Expected output: /agents 等最小检查/显式控制入口、根树活动和中断展示；去除新路径 DAG/ownedPaths/Reviewer 保证措辞。
- Dependencies: T-004.
- Execution steps:
  1. CLI/SDK 默认工厂和子工厂绑定同一个根树 controller；第三方自定义 ResourceLoader 仍由 host 负责。
  2. 新工具全部接入权限和审计，不能只改旧 subagent 名字后绕开特判；共享目录不是权限扩大授权。
  3. 结果有可检查来源，等待/完成/错误/中断区分；重启只展示保留任务。
  4. 在临时目录实证 child 写入主会话可见、abort 不回滚；不产生 worktree/候选 ref/隐式提交。
- Acceptance criteria:
  - headless/RPC 和 Grok 使用相同真实状态；读/写/消息权限一致；主交互取消和 session replacement 无 stale callback。
- Verification method:
  - faux provider 集成、指定 Grok 渲染/默认组合回归、临时 Git 与非 Git cwd 共享编辑测试。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 旧任务退出路径与新数据预算

- Status: pending
- Owner: coordinator
- Objective: 安全保留旧 undelivered 数据，完成新子会话历史的显式交付/丢弃及磁盘预算。
- Inputs and prerequisites: T-005 产品语义；旧格式的干净/dirty 两种样本；真实数据处理仍另需授权。
- Scope or files: packages/subagent 旧格式只读检查/导出与确认清理边界、新 store 保留策略；当前未提交 delivery-cleanup/retained marker 作为安全证据，不盲目覆盖。
- Expected output: 旧格式检测/导出说明；新旧独立目录；显式清理入口；256 MiB / 7 天实际占用统计和保护告警。
- Dependencies: T-005.
- Execution steps:
  1. 旧 ledger/工件/worktree 只做合成兼容检查，不转换状态、不自动 resume/GC；旧正在运行进程须退出后切换。
  2. 为未交付 Writer 保留原工件/分支/工作树检查出口；清理仅在确认且所有权证据完整时可用。
  3. 新 root session/team 关联可靠，删除仅覆盖已确认、非活动的任务数据；共享项目文件永不属于 task GC。
  4. 核算 ledger/索引、子历史、消息、日志/cache 的实际字节；保护数据超额只告警，不通过删除 auth/主会话达标。
- Acceptance criteria:
  - 旧合成数据哈希不变；没有无确认删除；重复清理安全；主工作目录编辑不被 GC；未知/损坏版本拒绝。
- Verification method:
  - fixture 哈希、释放失败/进程中断/符号链接测试；时钟与磁盘预算合成测试，无真实任务删除。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-007 — 退役旧调度与离线发行验收

- Status: pending
- Owner: coordinator
- Objective: 新行为验收后删除不再调用的 DAG 调度/进程编排路径，完成单一默认实现和可回退交付。
- Inputs and prerequisites: T-001 至 T-006 通过；保存的旧基线；明确旧数据检查出口。
- Scope or files: packages/subagent exports/旧 DAG/worktree/merge/quality/process 路径的消费者闭包；coding-agent 构建/包/锁与活跃文档；原整合任务关联状态。
- Expected output: 无隐藏双调度栈的发行包、许可声明、破坏性变化说明、离线验证与回退记录。
- Dependencies: T-006.
- Execution steps:
  1. 按消费者证据删除旧运行路径，保留仍需用于旧数据保护的最小检查/清理逻辑；共享 permissions/journal 不因包名相似而删除。
  2. 若移植 Codex 实际代码/文本，添加合适 license/NOTICE 和修改说明；不宣称官方兼容认证。
  3. 运行全部本次修改文件的定向测试和 root check；按授权离线构建、pack、临时精确 lock 安装与无 provider smoke。
  4. 审查 tarball 不含 Codex 运行时/真实数据，冻结历史评测无 diff；显式 stage 自有路径后提交。
  5. 更新原整合计划的验收映射，仍保留官方 Pi 兼容/发布授权阻塞；不得删除原 WJ 源码冒充本任务收尾。
- Acceptance criteria:
  - 新 spawn 链路不依赖旧 dag-orchestrator/ownedPaths/candidate gate；默认只一套工具；包外启动可创建 faux 子会话；风险和回退条件写明。
- Verification method:
  - 定向测试、静态消费者检查、npm run check、offline build、tarball 检查和临时隔离安装/RPC smoke；task document validator。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

规划阶段只做静态分析；授权实施后已执行 T-001/T-002 定向合成测试和 root check，见各任务证据。尚未构建新产品包；没有运行 Rust、真实模型、委派或发布。旧整合 T-005 的 148/149 等记录不作为本次替换的通过证据。

实施时的优先矩阵：

| Gate | 主要 oracle | 边界 |
| --- | --- | --- |
| V-001 合同 | 六工具解析/返回/错误与状态转换 | 空/重复路径、跨根、未知 ID、root/self、超限 |
| V-002 宿主 | 两根树无权限/事件/生命周期串扰 | 插件共享状态、auth 不落盘、无 process.env/chdir 注入 |
| V-003 并发 | atomic admission、释放幂等、可控等待 | nested spawn、同时 followup、abort 与完成竞争、队列满 |
| V-004 消息 | accepted 不等于已消费，持久消费 ID；无丢唤醒 | wait 订阅前/中/后到达，用户 steer 优先，idle send 不启动 |
| V-005 上下文 | faux 请求消息真实符合 all/none/N | replacementHistory、分支、tool pair、模型/effort 继承、消息来源 |
| V-006 故障 | 恢复不调用 provider、不重放工具 | crash 注入、损坏索引、断续写、父会话替换、已卸载 child |
| V-007 文件/权限 | child 共享编辑可见但 GC 永不动项目 | Git/非 Git、两人同文件不承诺隔离、拒绝越权、abort 保留 |
| V-008 历史/预算 | 旧数据哈希保留，仅确认历史可回收 | 部分清理、7 天/256 MiB、未交付超限告警、auth/主会话排除 |
| V-009 包与兼容 | 指定 tests/check/build/install 各自 exit 0 | root lock 既有改动不夹带、Bun/真实 provider 未测明确披露 |

已定位可借鉴的 Codex 测试源码（不执行，不直接复制整个 suite）：`core/tests/suite/agent_execution.rs` 的 nested capacity/residency，`multi_agent_resume.rs` 的 cold root/role restore，`subagent_notifications.rs` 的 parent notification/fork/peer followup，`agent/control/execution_tests.rs` 与 `residency_tests.rs`。

Pi 回归仅运行指定文件，新测试按 T-001 至 T-007 实际新增路径确定。现有重点：coding-agent `test/easy-pi-harness.test.ts`、`easy-pi-default-composition.test.ts`、`sdk-session-manager.test.ts`、`sdk-stream-options.test.ts` 和受影响 compaction/Grok 测试。禁止全 Vitest discovery；`packages/coding-agent/test/tool-profile-eval/**` 永远不修改/运行。

回退触发：权限扩大、跨根串扰、消息丢失/重复副作用、主会话压缩损坏、旧成果不可检查任一出现，则停止默认切换。回退只恢复此前保存的新旧装配版本，保留新团队数据为只读供检查；不反向自动转换、不 reset 用户工作目录、不回滚共享编辑。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

1. **高：共享写入是能力变化，不是优化。** 两个 Agent 可相互覆盖；用户已接受共享模式。仍需 prompt 明确任务文件范围、避免重复提交/重置，但这些约定不是 sandbox 或隔离保证。
2. **同进程隔离范围。** T-002 已验证身份/权限/生命周期及 provider 注册隔离；直接共享 ModelRuntime 的方案被测试否定并改为 session view。任意第三方 JS 模块自有全局变量仍是可信扩展的边界，不承诺进程/OS sandbox。
3. **高：Pi 队列不同于 Codex 邮箱。** 现有 `followUp()` 是排队不是完整 turn 调度；`sendCustomMessage(triggerTurn:false)` 可立即追加内部消息而非安全邮箱。必须用 adapter/受支持注入点证明时序，不用方法同名充当迁移。
4. **高：fork 会碰深度 compaction。** JSONL 截尾/复制历史可能复活淘汰上下文、丢工具结果或继承父待执行调用；必须用实际请求验证。
5. **高：旧未提交安全补丁和真实成果未收尾。** 不以重写名义丢弃；执行前建立可回退代码基线和旧历史出口。旧历史不受新 schema 自动管理。
6. **中：Codex 语义也依赖版本/feature/provider。** 已看到说明与模型覆盖实现存在差异；移植确定行为而非宣传文本，保留来源修订。
7. **中：内存驻留上限不是磁盘预算，成功输出也不是交付。** LRU 卸载不能代替 256 MiB/7 天确认清理规则。
8. **中：外部消费者未知。** 私有包仍导出大量旧 DAG 类型/子路径；先搜索 workspace/扩展消费者，显式列出破坏性变化，不静默同名改语义。
9. **发布仍阻塞。** 本计划不会解决官方 Pi 参考版本核实、npm 包名/权限和发布授权问题。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-06: 定位用户 @codex/ 为 `/Users/w/Projects/easy-pi/codex`，只读核对两个仓库修订/状态，检视 V1/V2 工具注册、AgentControl、spawn、邮箱、恢复、配额、权限和 Pi SDK/装配消费者。
- 2026-09-06: 用户结构化选择“共享工作区”和“Codex V2 语义，Pi 原生实现”，随后明确确认范围摘要；确认不包括实施。
- 2026-09-06: 新建并填写本文，规划七个串行阶段。未继续修复旧 DAG 的超时，未修改运行时代码、原产品任务文档或 Codex 源；未启动 subagent。

- 2026-09-06: 用户授权实施，T-001 开始。保存原 T-005 12 个代码/测试/任务文件至 `.git/easy-pi-migration-baseline/pre-codex-replacement.tar`，SHA256 `2ed18755bd073b520183f2049a20d73d557ab6e24477d60915c33eb04cda87ab`；不包含 accounts/lock/凭据/冻结评测。后续在默认切换前保留此回退快照，未声明旧超时已修复。

- 2026-09-06: T-001 完成，30/30 契约测试及 root check 通过；T-002 开始。下一步验证 native 会话权限不能继承旧 headless child 的自动批准行为，创建/关闭子会话不能影响其他根树。

- 2026-09-07: T-002 完成。新增宿主不改 cwd/env、不复制 auth，显式 parent permissions 拒绝旧 headless auto-allow；支持 create/load/run/context/abort/dispose。初次并发测试因复制带 execute 函数的 Context 导致 DataCloneError，仅修正测试为快照 messages。随后 provider shutdown 独立回归实证 child.unregisterProvider 删除 root provider；通过 ModelRuntime.createSessionView 保留认证/配置并隔离注册表修复，修复前失败、修复后通过。另验证抢先取消 preflight 和活动 stream 取消。9 files / 56 tests 与 root check 通过；计划后续控制器、邮箱/fork、产品切换、旧数据出口和打包仍未完成。

- 2026-09-07: 用户要求继续剩余任务；复核工作区，T-003 开始。采用独立轻量 SQLite registry 保存团队快照及进程所有权，借助事务防止两个控制器同时写入；不复用旧 DAG 表，不读取真实任务数据。死进程遗留所有权只能显式恢复，恢复仅标 interrupted，不执行任务。
- 2026-09-07: T-003 定向验证完成（43 + 14 tests），最终 root npm run check exit 0、无格式变动/info，task validator 通过。首轮 root check 发现 Pi ThinkingLevel 含 max，契约/存储补齐而非降低继承值；宿主仍拒绝具体模型不支持的 effort。实际宿主证明惰性 session 文件会导致无 assistant 的子会话 ENOENT，已通过公开 entries 独占写入、sync、reopen 修复；不改 SessionManager 内部状态。interrupt 的 abort 在队列外等待，嵌套控制回归通过。旧 DAG/锁/快照未清理，默认尚未切换。

- 2026-09-07: T-003 已提交 `00a67f052`；T-004 开始，coordinator 先实现从宿主有效上下文生成有界 fork，再接持久邮箱和工具。保持新工具未默认接线。
- 2026-09-07: T-004 fork 子部分验证通过（47 + 33 tests，root check exit 0）。TypeScript lib 不含 findLast，改用已有兼容 reverse/find，不改 tsconfig。审查确认 checkpoint 不证明原始 turn 边界，N 保守只接受最近 compaction 后完整 turn，不足明确拒绝；all 保留有效 summary。新增子会话提前落盘 lesson。下一续接点：coordinator 实现持久消息 ID/消费位置和完成通知，然后安全注入与六工具；T-004 保持 in_progress。

- 2026-09-07: 用户要求继续邮箱和六工具接线，T-004 继续由 coordinator 串行实施。邮箱与 task receipt 作为 version 1 snapshot 的可选扩展，旧快照仍可只读式恢复状态；每轮启动前预留父邮箱 completion 槽，结果与终态同事务提交，不能因邮箱被填满丢完成通知。send 不加载/启动目标；wait 仅订阅 mailbox/user-input，无轮询。新 Pi adapter 初版在 awaited extension context 边界使用公开 sendCustomMessage(triggerTurn:false) 持久写入并按 ID 去重；后经 preflight 顺序审查前移到公开 Agent.transformContext 宿主接口（见下条）；没有首条 assistant 的 root 尚未落盘时不提前 ack。默认装配/T-005 尚未切换。

- 2026-09-07: T-004 完成，最新 11 files / 113 tests passed、root check exit 0。六工具首轮测试的立即 interrupt 在 child preflight 内生效，故第二次 provider 请求未发生；测试增加显式 provider-start barrier 后验证 active-stream interrupt，不通过延时猜测。审查发现 extension context 在 compaction preflight 后，改为 session_start 安装公开 transform wrapper，并新增原 preflight 入口/关闭恢复回归。接收端处理 root 惰性文件和 ack 失败，原生重启/checkpoint 测试证明不重复或复活旧消息。保留 root lifecycle/default switch 为 T-005；本轮无 legacy/lock/frozen eval 修改。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 最新 subagent 4 files / 55 tests、coding-agent 7 files / 58 tests passed，共 113 tests；root npm run check exit 0。真实 provider/冻结评测未执行，原安全改动快照保留。
- Limitations: T-001 至 T-004 已完成；T-005 至 T-007 待实施。六工具已在显式装配的原生根/子 SDK 会话验收，尚非默认 CLI/SDK 工具面。下一步 T-005 默认装配、Grok/生命周期与共享写入验收，再做历史预算/旧调度退役/打包。不宣称 Codex 全量兼容或可发布。
