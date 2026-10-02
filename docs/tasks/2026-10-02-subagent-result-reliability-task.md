# Task Plan: Subagent 结果查回与协作闭环修复

- Created: 2026-10-02
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求“分析本session subagent调用过程和结果，反推 subagent模块的问题和优化点”，在分析后要求“制定修复计划”。用户随后明确授权“开始实施，直至完成所有修复”。

<!-- task-doc-section:background-goal -->
## Background and goal

本 session 创建 15 个 child、派发 26 个 followup，父会话持久化了 41 个不同 ID 的结果回执。至少五个 child 的原结果早于协调者的重发请求；6 个 followup 只用于重发旧结论或写出旧报告，另有两次混合重发与新复审。不能据此认定结果存储丢失：日志存在不等于每次 provider 请求可见，更不等于模型注意到了结果。

修复目标：让协调者不重跑推理即可查回指定任务结果；等待绑定确定的 turn；历史、投递状态、报告引用可追踪；保留既有权限边界和独立审查/父代理验收机制。

优先级：第一阶段 P0（T-001～T-004），第二阶段 P1（T-005～T-007），最终集成验收 T-008。本计划是唯一实施状态源；实施已获用户授权。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：
- 当前 native collaboration 的 contract/store/controller/mailbox、coding-agent adapter/host、必要的 monitor/TUI 展示、文档与离线测试。
- 增加只读结果/turn 历史查询、定向等待、可观察的投递阶段和按 turn 的 usage/时间。
- 角色可用性提示、明确报告引用和协调规则。所有新增协议保持有界输出、root 权限和同 team 身份校验。

非目标：
- 不恢复退役 DAG/process/worktree 调度器，不增加自动重试、自动重发推理或后台自动恢复执行。
- 不开放 child 的 root team 控制工具，不改变 continue 默认上下文策略，不承诺缓存命中或费用下降。
- 本轮不实现 child 进度通道、FS lease/OS sandbox/强制 worktree、自动上下文摘要、完整历史导出、provider 全请求追踪。它们缺少必要性或接口决策，后续独立评估。
- 不把 root 的验收 verdict 伪装成 resultValidation，不添加自动事实验收。
- 不改其它 session 文件、真实用户 team 数据或 credentials；不运行 build、全量 vitest、实模型 API，不 push。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 本 session 有 15 spawn、26 followup、41 个不同结果回执；原结果已早于多次重发。 | 父 session `0e88503f-2bd2-4e37-b992-680e6c8ca0ca` JSONL；原回执 line 77/140/405/536/541，重发 line 86/144/424/553；抽取复核 `/tmp/current-subagent-session-summary.txt`。 |
| F-002 | list 不返回结果正文、turn/message ID；内部 inspect 有 result/sessionPath。 | `packages/subagent/src/collaboration-controller.ts:115–152`；`collaboration-contract.ts` 的 CollaborationAgentView/CollaborationResults。 |
| F-003 | wait 只观察当前 pending inbox/user input；ack 从 pending 中删除消息。 | `packages/subagent/src/collaboration-controller.ts:399–433`；`collaboration-mailbox.ts`。 |
| F-004 | 收件在请求边界持久化，之后才 ack；失败停止后续请求，无跨 DB/JSONL 原子事务。 | `packages/coding-agent/src/extensions/pi-collaboration-tools.ts:180–218`；`docs/collaboration.md` Durable ingestion and recovery。 |
| F-005 | followup 清空当前 result/validation/usage；完成状态和结果通知同次提交。 | `packages/subagent/src/collaboration-controller.ts:593–679`。 |
| F-006 | child 的 team tools 被 root-only 执行门拒绝；本 session 有 8 次 send_message 权限拒绝。 | `pi-collaboration-tools.ts:234`；15 个 child 原生 JSONL，复核 `/tmp/current-child-session-summary.jsonl`，只计 toolName=send_message 的真实失败，不计读入报告中的错误文字。 |
| F-007 | 当前存储是 version=1 team snapshot、SQLite owner/CAS；已有显式 dead-owner recovery，不重放任务。 | `packages/subagent/src/collaboration-store.ts`；`test/collaboration-controller.test.ts`。 |
| F-008 | summary 最多 2048 字符、结果最多 8192 UTF-8 bytes；本 session 有超长 deliver_result 拒绝和外部报告引用。 | `collaboration-contract.ts` DelegationResultSchema；tui-click-snapshot-fix child JSONL line 156；本 session `/tmp/tui-*-report.txt`。 |
| F-009 | 查询监控本来不加载 idle child、不启动 provider；preserve 依赖相同 ordered schemas。 | `packages/coding-agent/docs/collaboration.md`；`test/pi-collaboration-tools.test.ts` viewer/permission/preserve 相关验证。 |
| F-010 | 基线在共享工作区，存在不属于本任务的修改；当前 HEAD 为 3f8a04e07814ca35470b238c971fab4fda75e82e，分支 my-pi。 | 规划时 `git status --short`、`git rev-parse HEAD`、`git branch --show-current`。 |

会话权威数据位置：父 JSONL 位于 `/Users/w/Library/Application Support/AgentPort/sessions/ses_01M3VXAC2XX3AZHH/easy_pi/2026-10-01T14-19-00-096Z_0e88503f-2bd2-4e37-b992-680e6c8ca0ca.jsonl`；team 位于 `/Users/w/.epi/agent/teams/0e88503f-2bd2-4e37-b992-680e6c8ca0ca/`。实施测试使用匿名合成 fixture，不复制真实会话或其敏感内容进仓库。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 新增查询工具暂名 `get_agent_result`、`list_agent_turns`，等待扩展现有 `wait_agent`，不另加同义工具。T-001 固定最终 schema，之后下游不得各自改名。
- Assumption: 完整结果保留在 native child history；查询返回有界 preview、来源引用和截断标记，不把整份 JSONL 塞进模型上下文。
- Assumption: 历史从新能力启用后完整记录；旧 team 只提供能被证明的最新/已留存记录，并显式标注 history coverage、unknown 字段。不承诺复原已被 followup 覆盖的全部历史，也不静默扫描旧会话全文。
- Assumption: 增量 ledger 优先采用现有 SQLite 内的按 turn 索引记录，避免每次 snapshot 复制全部历史；T-001 用有界 fixture 比较后确认，不引入新数据库或依赖。
- Decision: 按现有有界 admission 模式，每 team 最多保留 4096 个 turn，不自动删除；超限明确拒绝新 admission（turn_history_full，提示新 root），查询仍可用。ledger 独立 SQLite 索引表且与 snapshot 同事务；task 受现有 40k 字符/256KiB 合同门约束，preview 最多 8KiB；history page 默认10/最多20且只含 metadata，完整 preview 单独查询。旧记录只 seed 可证明最新/queued turn，coverage=retained_only，不扫描旧 JSONL、不推理重放。T-001 固定精确 schema 并校验容量测量。
- Open question: 是否需要 child 中途进度通道/强制文件隔离，尚无本轮实现决定；作为非目标，不阻断 P0 修复。
- Provider 请求投影是否漏呈现原结果仍未证实；本轮仅用 faux observer 验证正常接入，不宣称已修复未知的 provider bug。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

1. 指定 target+turn_id 或 message_id 查回结果，不 run/load child、不消费 mailbox、不新增模型请求；followup、ack、close、cold recovery 后均可读取已记录 turn。
2. 初始派发/followup/list 返回明确 turn 身份；等待进入时钉死 turn，后续 followup 不改变等待目标；已完成且已 ack 的目标立即可返回。
3. 普通 wait_agent 无 target 的 mailbox/user-input 语义保持明确；timeout/取消等待不取消 child；用户输入优先、订阅释放、lost wakeup 和失败启动路径有测试。
4. 执行状态、格式校验、child outcome、投递阶段分别呈现。不能从 acknowledged 推导模型已理解，更不能推导父代理已验收。
5. 每个 turn 有 task/result/message 身份、已知时间和 usage；缺失/不完整使用 unknown/coverage，不补零、不把 creation bytes 当当前 context、不重复累加最新 snapshot。
6. root-only、同 team 校验、live authority、无权限扩张、preserve schema 一致性仍成立。仅补角色提示，不放开 child root 工具。
7. 完整证据可通过可定位 artifact 引用查验；摘要仍有界；hash 和测试结果只表示引用/声明，不能自动得到 accepted。
8. 完整离线复现“原回执已落盘但协调者再次等待”：新查询查回旧回执，child run 次数和 provider 请求数均不增加。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-004；T-004 → T-005/T-006；T-006 → T-007；T-002 → T-009；T-005 → T-010；T-005+T-007+T-009+T-010 → T-008。
- Parallel batches: 核心 T-001～T-004 保守串行（共享contract/controller/adapter/tests）。T-003 与 coordinator T-009 验证fixture修正可并行，文件互不重叠。T-004 完成后 T-005（monitor/group/panel/tests）与 T-006（host/root/tools描述/docs及其tests）可并行，T-006完成后T-007仅改protocol/host/controller/tests/docs，与T-005互不重叠；artifact显示复测在T-008集成。每阶段可用 fresh isolated reviewer 只读审查冻结 diff；运行权限与写文件验证由 coordinator 承担。
- Serialization constraints: schema、store 事务、controller、adapter、同测试文件和本 authority document 单 owner；不得把同文件测试与生产改动分配给并行 writer。实测能拆开 ownership 时，先更新本文再委派。
- Review 权限: 静态 reviewer 使用 `tools:["read"]`，不声称它执行了测试。需要编写 /tmp probe 的验证者不是强制只读 reviewer。任何 bash 都不作为 read-only 安全保证。
- 实施方式: 仅用户授权后将 Mode 改 execute；本 runtime 只有原生 spawn/followup，不使用退役 DAG tool。所有任务回执是待父代理审查证据，不是最终验收。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定最小协议与存储边界（P0）

- Status: done
- Owner: coordinator
- Objective: 固定结果定位、turn ledger、等待与升级/容量合同，防止边实施边追加 API。
- Inputs and prerequisites: F-001～F-010；重新核对 HEAD/工作区；用户授权实施。
- Scope or files: `packages/subagent/src/collaboration-contract.ts`、`test/collaboration-contract.test.ts`；`packages/coding-agent/docs/collaboration.md` 的协议草案；本任务文档。
- Expected output: schema/types 与真值表；错误码、分页、有界预算、旧记录 coverage 规则；T-002～T-007 使用同一合同。
- Dependencies: None.
- Execution steps:
  1. 固定 get_agent_result 选择器：target 必填；turn_id/message_id 二选一，省略时取当前 turn；不一致选择器显式拒绝。
  2. 固定 list_agent_turns 游标/上限、结果 source/preview/truncated、delivery、usage coverage 和 T-007 最小 artifact 字段；查询无读取副作用。协议设计可先以未接线 types/schema 表达；新增 live tool catalog 必须与 T-003 adapter 同步启用，避免中间版本缺 descriptions/execute 分支。
  3. wait_agent 增加可选 target/turn_id；target 模式入场固定当前 turn；保留无 target 行为，结果区分 terminal、user_input、timeout。
  4. 定义 ledger 与 snapshot 同事务写入、旧数据读入边界、容量耗尽/未知历史行为；若需要改变保留策略先请求确认。
- Acceptance criteria:
  - 非法选择器/跨 team/超大分页可被 schema 或 controller 拒绝；accepted 不等于完成或验收。
  - 新旧读取语义、失败启动、close/recovery 和等待 followup 竞态均有明确预期；不得要求热更新现有 session schemas。
- Verification method:
  - V-001 contract 定向测试；审查真值表与依赖接口。
- Validation evidence: Root 核对 diff、contract 真值表和有界策略；contract test 58/58 通过；scoped Biome 与 owned diff 检查通过。将查询响应预算调至64KiB以容纳8KiB raw output JSON escaping；live tools尚未启用。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 持久化按 turn 历史与投递元数据（P0）

- Status: done
- Owner: coordinator
- Objective: followup 不再使旧结果在控制平面不可查，完成/通知/ledger 原子一致。
- Inputs and prerequisites: T-001 合同；既有 owner/CAS/recovery 行为。
- Scope or files: `packages/subagent/src/collaboration-store.ts`、`collaboration-controller.ts`、`session-host.ts`（仅必要类型）；`test/collaboration-controller.test.ts`，必要新增 store 测试。
- Expected output: 有界 turn 索引与分页；task/turn/result message ID、preview/source、已知 admission/start/finish/ack 时间、usage 与 coverage。
- Dependencies: T-001.
- Execution steps:
  1. 将 admission/followup/finish/失败启动/interrupt/recovery 更新绑定 turn ID，不修改历史 terminal turn 的结果。
  2. 同一 SQLite transaction 提交 terminal 记录与父通知；仅在接收者 native 持久化证明成立后标记 ack。
  3. 无 result notification 的 startup failure 仍可通过 turn 状态查询；ack 重试幂等、close 不删历史。
  4. 验证旧 registry 打开/recovery、崩溃回滚与 owner 丢失；不扫描或迁移真实用户 DB。
- Acceptance criteria:
  - 两次以上 followup 后三个 turn 的 task/result/usage 不混用；存储失败不出现半条完成记录。
  - 旧数据未知投递时间不得猜测；历史容量遵守 T-001，权限快路径不得解码整份 ledger。
- Verification method:
  - V-002 controller/store 定向测试，真实临时 SQLite、事务失败注入、重启恢复；验证 memory 模式等价。
- Validation evidence: Root diff review + contract/controller/mailbox/history-store 合计124/124通过；检查了 SQLite同事务、legacy proof、interrupt结算、close保留coverage 和容量门；owned diff检查通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 提供零推理结果和历史查询（P0）

- Status: done
- Owner: coordinator
- Objective: root 可以按 turn/message ID 查回结果，无需 followup 重发。
- Inputs and prerequisites: T-002 ledger；T-001 tool schema。
- Scope or files: `packages/subagent/src/collaboration-controller.ts`、`collaboration-contract.ts`（仅已定接口接线）；`packages/coding-agent/src/extensions/pi-collaboration-tools.ts`；对应 controller/tools tests；相关 tool catalog 断言。
- Expected output: get_agent_result/list_agent_turns；spawn/followup/list 提供 turn 身份与结果引用。
- Dependencies: T-002.
- Execution steps:
  1. 通过已有 root/identity/authority 门查询同 team 历史，支持 closed/unloaded agent。
  2. 返回 bounded preview、validation/outcome、source 与截断；明确 pending/no-result/history-unavailable，不使用空字符串冒充完成。
  3. 查询不得 load/create session、ack inbox 或修改结果；完整原文走已有受权限约束的 read 来源。
  4. 同步 tool descriptions、catalog、preserve 相关 fixture，覆盖按 message ID 查到历史 turn。
- Acceptance criteria:
  - 查询已 ack/已 followup/已 close 的旧结果正确；所有查询 child.run/host.create/provider 次数不增加。
  - 跨 team、错 target/message 组合、所有 child 调用被拒绝；错误不暴露任意内部异常。
- Verification method:
  - V-002、V-003 faux SDK 测试；查询前后比较 pending inbox、run count 与 provider observer count。
- Validation evidence: Root审查查询/receipt/cursor/live guards；subagent4目标129/129、coding-agent tools/host/cache3文件56/56通过；查询无run/load/ack，legacy错误选择器及checkpoint/cold读取覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 定向等待且消除 turn 竞态（P0）

- Status: done
- Owner: coordinator
- Objective: wait 能可靠等待或立即返回指定 turn，不把 mailbox 已消费误判为未完成。
- Inputs and prerequisites: T-003 查询与 turn 身份；原有用户输入优先规则。
- Scope or files: `packages/subagent/src/collaboration-mailbox.ts`、`collaboration-controller.ts`；`packages/coding-agent/src/extensions/pi-collaboration-tools.ts`；mailbox/controller/tools tests。
- Expected output: wait_agent target 模式、事件唤醒与 terminal result 引用；旧无 target 语义保留。
- Dependencies: T-003.
- Execution steps:
  1. 在订阅前/订阅后都检查 pinned turn，复用可观察事件而非轮询。
  2. 已 terminal（包含 failed/interrupted/startup failure）立即返回；ack 不改变此判断，后续 followup 不换目标。
  3. 统一并发 waiter、timeout、用户输入、取消及 shutdown 行为；等待取消绝不自动 interrupt child。
- Acceptance criteria:
  - 覆盖完成先于 wait、完成处于订阅窗口、ack 先于 wait、等待期间 followup、同时用户输入、startup failure、close、dead-owner recovery。
  - 订阅和 timer 释放，无 lost wakeup、busy loop 或后台推理。
- Verification method:
  - V-002、V-003、V-004；可控 clock/事件竞争测试，不使用真实模型或人为长 sleep。
- Validation evidence: 5个subagent文件140/140、3个coding-agent文件57/57通过；scoped Biome7文件通过；root tsgo --noEmit通过。11个targeted-wait回归覆盖ack/close/cold恢复/pinning/startup失败/user/timeout/cancel/shutdown/revocation，无child新增run。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 可观测性和人类可读展示（P1）

- Status: done
- Owner: coordinator
- Objective: 明确区分执行、投递、格式、outcome，并显示按 turn 耗时和 usage 的真实范围。
- Inputs and prerequisites: T-004 稳定读取合同；T-002 已知时间/usage。
- Scope or files: `packages/coding-agent/src/extensions/pi-collaboration-monitor.ts`；`src/modes/interactive/components/subagent-group.ts`；`src/modes/interactive-grok/components/grok-agents-panel.ts`；`src/core/keybindings.ts`（历史入口配置键）；对应 subagent-group/routing/mouse/panel/keybindings tests。
- Expected output: 最新摘要优先；展开查看 turn/task/result/source/投递信息；按需历史分页；unknown/coverage 标签。
- Dependencies: T-004.
- Execution steps:
  1. 复用现有 task/result/Activity/Diagnostics 分层，不把查询回执 JSON 重新堆回主视图。
  2. 分开呈现 completed、outcome、contract、enqueued/acknowledged；缺乏 native 持久化证据时不宣称 ingested。
  3. 按 turn usage 汇总且注明不完整；creation projection、当前 history 与 tokens 不混标；不推导费用。历史入口使用配置化 app.agents.turns（默认Ctrl+T），历史模式上下选择turn、PageDown按需下一页；长结果须有明确可滚动详情入口（Enter详情、PageUp/Down滚动、Escape回历史，再Escape回预览）或独立配置化详情滚动键；不能混用原preview滚动语义。
  4. 保留 immutable displayed geometry、窄屏布局、选区/点击、关闭后状态与历史引用。
- Acceptance criteria:
  - 父模型和人类均可定位上一 turn；completed+blocked 不显示成验收成功；unknown 不显示为 0。
  - 暂不增加永久提示行；query/view 不 load 或启动 child；窄宽和鼠标命中无回归。
- Verification method:
  - V-005 定向 TUI tests、VirtualTerminal 输入与 ANSI 宽度测试；faux monitor provider counter。
- Validation evidence: Root重新核对UI diff；6文件151/151通过（writer148+root长source/NUL3项）；原始/tmp恶意source probe1/1已从失败变通过；tsgo在UI集成后通过；scopedBiome/diff通过。保留原生命周期与immutable鼠标快照。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 角色提示与协调调用规范（P1）

- Status: done
- Owner: coordinator
- Objective: 防止要求 child 调用不可用 team 工具，并把“查结果”和“派新任务”明确分开。
- Inputs and prerequisites: T-004 查询/等待行为已验证；与T-005不同文件ownership。
- Scope or files: `packages/coding-agent/src/extensions/pi-child-session-host.ts`、`pi-collaboration-root.ts`、`pi-collaboration-tools.ts`（描述）；`packages/coding-agent/docs/collaboration.md`；child/root contract 相关 tests。
- Expected output: role-aware runtime 提示、tool help 与协调说明；不新增权限。
- Dependencies: T-004.
- Execution steps:
  1. 明确 child 使用 deliver_result 自动回到 creation parent，不能 send_message/root team tools；保留 preserve 所需 identical schemas。
  2. root 指导：结果不见先 get/query；idle child 新工作用 followup；passive send 不唤醒执行；fresh verifier 与连续复审不同。
  3. 小独立任务说明优先 isolated/curated，不静默修改 continue/fork 默认策略。
- Acceptance criteria:
  - root/child 当前 assignment 提示不被继承 identity 误导；无权限扩张；preserve 不因角色 schema 漂移失败。
  - 明确只读任务的真实 allowlist；bash 不被描述成安全只读。
- Verification method:
  - V-003、V-006 host/context/permission/preserve 定向测试；不以真实模型服从率作离线验收。
- Validation evidence: T006 tools/host/cache-affinity/settings4文件61/61通过；preserve root/child sys/schema相同、角色提示在消息而非系统分叉；scoped Biome5files和owned diff通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 轻量 artifact 引用而非扩张摘要（P1）

- Status: done
- Owner: coordinator
- Objective: 短摘要能指向完整报告且可检验版本，避免靠重发推理获取完整证据。
- Inputs and prerequisites: T-006；T-001 输出预算与最小引用合同已固定，T-005 renderer已有legacy artifact数组支持。
- Scope or files: `packages/subagent/src/collaboration-contract.ts`、`collaboration-controller.ts`（查询时从有界原结果派生refs，避免ledger metadata重复预算）、对应 contract/controller tests；`packages/coding-agent/src/extensions/pi-child-session-host.ts`及test/pi-child-session-host.test.ts；collaboration docs。不与T-005同时改group/monitor；UI集成复测交T-008。
- Expected output: deliver_result 可选有界 artifact 列表（路径、用途、可选 SHA256）；旧 summary/outcome 仍是合法完整输入。
- Dependencies: T-006.
- Execution steps:
  1. 使用少量可选引用，保持 2048 字符摘要和整份 8192 bytes 限制；不增加长自由文本 checks/evidence 大对象。
  2. ledger/查询透传引用；不自动读取路径、不执行引用内容、不用 artifact 赋予权限。
  3. parent 用现有 read 检查引用、hash 和报告对应 revision；临时路径失效/文件变化明确是证据不可用，不自动重跑 child。
  4. 说明 tests/checks 与 base revision 留在报告，自动 acceptance 不在 schema 范围内。
- Acceptance criteria:
  - 无 artifact 的结果合法；引用过多/整份超限/非法 hash 被拒绝；CJK/多字节边界测试通过。
  - artifact 与摘要都不触发隐式文件读取或模型请求；引用可见但不被当作可信验收。
- Verification method:
  - V-001、V-003、V-005、V-006；协议/渲染与超限 delivery 回归。
- Validation evidence: subagent5文件142/142及native tools/host/cache/settings4文件63/63通过；refs由原有界preview派生，未重复ledger metadata或自动读FS；多字节超限/compact retry有回归；scoped Biome与diff通过。UI显示集成在T-008复测。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 端到端回归、独立审查和父代理验收

- Status: done
- Owner: coordinator
- Objective: 证明查回旧结果不再依赖新推理，验证持久性、权限及展示集成。
- Inputs and prerequisites: T-001～T-007 全部 done；冻结 owned diff。
- Scope or files: 上述 owned tests、匿名 faux scenario；`packages/coding-agent/test/pi-collaboration-cache-affinity.test.ts`；`scripts/check-native-subagent-product.mjs` 仅检查 catalog 断言是否需随源码更新，不 build；本任务文档。
- Expected output: 完整验证记录、独立静态审查与复测、每任务验收、源代码变更提交；未验证项明确列出。
- Dependencies: T-005, T-007, T-009, T-010.
- Execution steps:
  1. 匿名重现本 session 的两条链：completed→ingested/ack→wait→get；completed→followup→get old turn→close→get old turn。
  2. cold recovery、compaction/checkpoint 后显式 query 仍能读旧结果；正常上下文不会自动复活已消费原始消息。
  3. 新 fresh reviewer 只读审查 frozen diff；root 检查 findings 并复测。实现 child 不用 followup 自称独立审查。
  4. 复测 T-009 已因果复现的既有验证 fixture，并保持 preserve 生产门与 cold-load 断言。
  5. 运行 V-001～V-007；核对 shared worktree 只保留 owned edits；仅在用户已授权实施后提交 owned changes，不 push。
- Acceptance criteria:
  - scenario 全部离线通过；旧结果 query 前后 run/provider 计数不增加；投递/历史无混 turn。
  - 权限/capacity/recovery/preserve/TUI 回归通过；全仓门如被无关资源阻断，Overall=blocked、Final=partial，不冒称全仓通过。
- Verification method:
  - V-001～V-007；独立 review 后 root 最小复测；本文 validator。
- Validation evidence: 364/364目标tests、2/2原始metadata probes、全量tsgo/browser-smoke/shrinkwrap/install-lock及owned格式/diff通过；静态review发现由T010复现修复。用户明确接受外部全仓阻断下限定提交，正常git commit成功f5e8fa870（26owned files），未跳过hooks、未push。Final仍partial，不宣称全仓passed。
- Blocker: None.
- Unblock condition: None.

用户已明确确认限定提交例外：仅提交本任务已验证文件，保留外部全仓失败/Final partial，不跳过已安装Git hooks、不push。正常commit若仍被hook阻断，重新记录blocked，不自行绕过。

### [x] T-009 — 修正既有冷加载/preserve 验证 fixture

- Status: done
- Owner: coordinator
- Objective: 修复本轮基线三个已复现的测试fixture问题，不修改生产权限/prefix门。
- Inputs and prerequisites: T-002 done；匿名/tmp probe已因果复现 root/child资源发现不一致、slot常数过期及faux response容量不足。
- Scope or files: `packages/coding-agent/test/pi-child-session-host.test.ts`、`test/pi-collaboration-cache-affinity.test.ts`。
- Expected output: 与生产slot/resource policy一致的fixture及准确冷加载/affinity断言。
- Dependencies: T-002.
- Execution steps:
  1. eviction压力按COLLABORATION_LIMITS.maxActiveSessions推导，不写死3/4。
  2. root/child发现策略一致；faux响应数覆盖全部新增压力turn。
  3. 保留创建/冷加载不发provider、preserve相同prefix及native session独立性的断言；不改生产实现。
- Acceptance criteria:
  - 两个target test files通过；证明之前失败来自fixture，不绕过prefix兼容门。
- Verification method:
  - V-006加`pi-child-session-host.test.ts`定向运行；scoped Biome和diff。
- Validation evidence: 两个target test files 25/25通过；tmp因果probe证明资源策略和slot/response预算修正恢复preserve，未改生产门；scoped Biome/owned diff通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 补齐 mailbox 元数据安全显示闭环

- Status: done
- Owner: coordinator
- Objective: 消除新metadata显示对原mailbox未校验字段的String强制转换，不让畸形历史回执破坏展开或followup接线。
- Inputs and prerequisites: T-005 done；root/tmp metadata probe任务task-27实际复现resultValidation.contract={toString:42,valueOf:42}展开TypeError。
- Scope or files: `packages/coding-agent/src/modes/interactive/components/subagent-group.ts`；`test/subagent-group.test.ts`。
- Expected output: 原始mailbox格式/状态只显示已校验enum或unknown；畸形状态不得冒充terminal或停止新turn时钟；原文仍可Diagnostics读取。
- Dependencies: T-005.
- Execution steps:
  1. 去掉mailbox contract和fast-followup status的unchecked String转换。
  2. 补充对象/空值/未知enum回归，保留普通mailbox、legacy及race行为。
  3. 根代理重跑actor/routing/mouse与/tmp前后probe，再交T-008整体审查。
- Acceptance criteria:
  - 畸形contract展开不throw，format unknown且有warning；matching fast receipt的畸形status不throw且不伪造结束。
- Verification method:
  - V-005及root/tmp source-alias probe；scoped Biome/diff；最终tsgo。
- Validation evidence: 原始task27 mailbox oracle失败已在task29变2/2通过；actor/routing/mouse3文件134/134含8个新case通过。取消未校验String，known-terminal guard同时覆盖identified/legacy fast receipt，invalid status不停止时钟；scopedBiome/diff通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

以下是实施后拟运行命令，不是已执行结果。实施开始重新核对测试配置/源码 alias；所有 provider 用 faux，禁止 `npm test`、全量 vitest 或真实 API。

- V-001，cwd=`packages/subagent`：`node ../../node_modules/vitest/dist/cli.js --run test/collaboration-contract.test.ts`。
- V-002，同 cwd：`node ../../node_modules/vitest/dist/cli.js --run test/collaboration-controller.test.ts`；新增 store/history tests 同时定向运行。
- V-003，cwd=`packages/coding-agent`：`node ../../node_modules/vitest/dist/cli.js --run test/pi-collaboration-tools.test.ts`。
- V-004，cwd=`packages/subagent`：`node ../../node_modules/vitest/dist/cli.js --run test/collaboration-mailbox.test.ts`。
- V-005，cwd=`packages/coding-agent`：`node ../../node_modules/vitest/dist/cli.js --run test/subagent-group.test.ts test/subagent-transcript-routing.test.ts test/subagent-mouse.test.ts`；实施确认 agents panel tests 的实际文件后补到此命令，不能猜路径。
- V-006，同 cwd：`node ../../node_modules/vitest/dist/cli.js --run test/pi-collaboration-cache-affinity.test.ts test/subagent-settings-host.test.ts`；child host/context 新回归放既有 faux fixture 或明确新增文件。
- V-007，repo root：`npm run check`，保存完整输出；check 可能自动改写共享文件，先备份可能被 formatter 触及的非 owned 修改，结束后核对并只撤销本次意外改写，不重置其它 session 工作。格式/类型/依赖门失败分类记录；不擅改其它任务资源。本文 `task_document.py validate --path <本文绝对路径>`。

覆盖矩阵：memory/file store；运行/terminal/failed startup/interrupted/closed；pending/ack/retry；初始/多个 followup；query latest/turn/message；用户输入/timeout/abort/shutdown；分页/容量/未知旧记录；ownership loss/崩溃回滚；restrict/preserve；窄屏/immutable mouse hit。

物理终端人工验收、编译发行包、真实 provider 呈现和实际费用改善不属于离线证据；需要时另行授权。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 全仓门存在无关阻断：预检 check:pinned-deps 255项、check:ts-imports 285项失败，全部位于其它session的15个 computer-native-* candidate/diagnostic材料目录；本任务不修改它们或绕过pre-commit。最终T-008仍运行完整check并分别验证后续门；提交若被hook阻断需如实保留未提交结果。
- 最大风险是 registry/history 原子性和旧存储升级：T-001 先固定合同，T-002 使用临时库故障注入，不迁移真实 team 进行试验。
- history 无界会膨胀磁盘与查询；T-001 必须定义预算/coverage/容量门，严禁静默 prune。
- SQLite ack 与 native session sync 不是同事务；只承诺可幂等恢复，不承诺 exactly-once 模型执行。
- 新工具会改变 ordered schemas；preserve 要同版本 root/child，运行中 session 不热切换。测试既有 prefix 兼容门而非绕过它。
- 查询历史不得自动进入正常模型上下文或 resurrect checkpoint 前的原始 mail；显式 query 是用户/协调者主动读取。
- 临时 artifact 生命周期有限，hash 只是版本校验不是事实证明；失效要报告，不触发补跑。
- 本轮不声称能强制模型注意到消息或减少费用，也不把自然语言 ownership 当文件系统锁。
- 用户已授权全部计划实施；保留 build/真实 API/push 等非目标边界。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-02: 用户要求制定修复计划；选择 plan，未授权代码实施或派发新 child。
- 2026-10-02: 刷新 HEAD/共享工作区；核对 native collaboration contract/store/controller/adapter/docs 和现有定向测试入口；排除退役 DAG/process 模块。
- 2026-10-02: 创建唯一 authority document；分为 P0 可查回/可等待、P1 展示/角色/证据与最终验收；暂不实现 progress channel/FS 隔离/自动摘要。
- 2026-10-02: `task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-10-02-subagent-result-reliability-task.md` 通过。仅新增本文；结构校验不代表实现通过。
- 2026-10-02: 用户授权执行全部修复；基线 HEAD/未拥有修改与规划时一致。T-001 in_progress，委派 /root/result-contract，coordinator 保留文档写权限。
- 2026-10-02: 原基线 contract/controller/mailbox 定向测试 94/94 通过。确认 4096-turn 有界保留/显式 admission 拒绝；metadata 分页不批量返回正文；无历史删除/实数据迁移。
- 2026-10-02: coding-agent 七个目标基线 160/163，通过5文件、失败2文件。已有失败：host unload test 写死3 child slots（现为15）；cache-affinity 两个 preserve probe 未观察 child 请求。T-008 必须定位并修正 fixture/实现因果，不以变更前失败为理由削弱 preserve/冷加载验收。

- 2026-10-02: T-001 done：协议审查及58项根代理复测通过，固定4096-turn/metadata分页/64KiB响应预算。

- 2026-10-02: T-002 in_progress，委派 result-ledger，仅拥有 store/controller 与其测试；文档由 coordinator 更新。
- 2026-10-02: root `/tmp` source-alias preserve probe 复现 root noSkills=true/child 默认发现导致 system prefix 不一致而合法拒绝；统一 fixture 资源策略后 first mismatch=-1。eviction 改按现15 slots及增加 faux responses，7/7 cache-affinity probes通过。生产门无需削弱；在 T-008 应用最小 fixture 修正。

- 2026-10-02: T-002 done：接受ledger改动并复测124/124；T-003继续接线。

- 2026-10-02: T-003 in_progress，复用result-ledger实施零推理查询及tool identities；不是独立review。

- 2026-10-02: T-009 done：生产实现不变，修复fixture并通过25/25；与T-003非重叠文件并行完成。

- 2026-10-02: T-003 done，结果查询/历史分页/turn receipts已接入。result-ledger关闭。

- 2026-10-02: T-004 in_progress，root实现按turn等待与race回归；query实现已冻结。

- 2026-10-02: T-004 done：定向等待按入场turn钉死，使用wait自身权限；开始独立ownership的P1两支。

- 2026-10-02: T-005 in_progress，委派result-display拥有monitor/group/panel/keybindings及相关tests；与root T-006无写冲突。

- 2026-10-02: T-006 in_progress，root拥有host/tools/root/docs及host/tool tests的角色说明。

- 2026-10-02: T-006 done：角色提示、query-before-resend协调规范和native docs接入，未扩大权限；root toast completed不称done。

- 2026-10-02: T-007 in_progress：协议中已固定refs shape；仅改contract/host/controller/docs与tests，不写T-005的UI owned files；artifact UI集成在T-008复测。

- 2026-10-02: T-007 done：可选refs仅数据引用，完整byte门移入共享parser；格式valid仍非验收。
- 2026-10-02: 后端冻结后委派 result-backend-review，verify+tools:[read]，仅静态审查，不声称运行测试。无关全仓pinned-deps/ts-imports预检分别255/285项失败，全部candidate材料；原始日志task-20/task-21。
- 2026-10-02: backend reviewer无可操作发现（仅静态）；root已有142+63目标复测，reviewer已close。T-005早期root/tmp probe实际复现query source.session_path对象导致展开TypeError，已通知writer做完整metadata narrowing及回归；另要求长历史结果可滚动和可见artifact refs。

- 2026-10-02: T-005 done：静态writer结果已审查，root追加合法>2048 source与NUL回归、query-only可读Read预览，151/151复测；writerclose。

- 2026-10-02: T-008 in_progress：首批实施任务done，开始全体定向测试、UI独立只读审查和完整check；无关仓库门失败按计划记录不冒称passed。
- 2026-10-02: T-008根审发现原mailbox分支仍有unchecked String转换；task-27实际1/2 probe失败（query已修复，mailbox contract对象仍TypeError）。新增必要T-010 in_progress，作为最终验收依赖，不恢复已done任务或隐藏返工。

- 2026-10-02: T-010 done：实际崩溃回归闭环完成，query/mailbox metadata均安全；继续T-008全部最终门。
- 2026-10-02: Final targeted tests：task-34 subagent142/142，task-33 coding-agent222/222，task-29 metadata probes2/2。task-32 tsgo发现mixed it.each table的6项类型错误；改为object rows后task-35全量tsgo/browser-smoke通过、task-36 UI159/159复测通过。未削弱任何原断言。
- 2026-10-02: task-30完整npm run check在pinned272项失败；task-31独立TS-imports304项失败，全部其它session16个candidate目录，owned诊断0。task-32 shrinkwrap/install-lock通过；task-35 tsgo/browser-smoke通过。check之前保存1416 formatter-scope文件；4个无关改写检查diff仅格式后按expected-after hash精确恢复，compare无剩余变化。
- 2026-10-02: backend/UI静态review各一，均read-only；UI报告1个metadata安全问题由root重现+T-010修复。5个本阶段children全部close，无实模型API或build。HEAD已由其它session推进至6de0cf47cd3ca2ae8c6382bcc2badd7cf6fe63b5，未拥有这些提交/LEARNS等其它改动。
- 2026-10-02: T-008 blocked；源码实施全部完成，尚未stage/commit。请求仅提交已验证owned修复的边界确认，保留外部全仓失败，不跳过hooks、不push。
- 2026-10-02: 用户通过request_user_input明确选择“确认限定提交（推荐）”；T-008 blocked→in_progress。只提交owned文件、保留Final partial，不跳过hooks、不push，不修改其它session内容。

- 2026-10-02: T-008 done（限定验收经用户确认）：正常git commit f5e8fa870成功，26个源码/测试/协议文档owned files，未跳过hook/未push；全仓验证保留partial。
- 2026-10-02: 正常git show/status核对源码提交仅owned26文件，工作区其它session的LEARNS/candidate/docs/scripts保留；authority文档作为单独docs提交收尾，不新增竞争状态源。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001～T-010全部done；364/364离线定向tests、2/2原始metadata probes、全量tsgo和browser-smoke、shrinkwrap/install-lock、owned格式/diff通过。用户明确接受外部阻断下限定提交，源码提交f5e8fa870成功（26files）。Overall blocked仅表示全仓门仍受其它session材料阻断，不代表源码任务未完成；Final partial不冒称全仓passed。
- Limitations: npm run check:pinned-deps 272项、独立check:ts-imports304项失败，全部其它session材料；未改/清理它们。未运行build、实模型API、真实终端/字体人工验收；修改是source-level，运行中session不会热更新。用户已确认限定提交，正常git commit成功，未跳过hooks，未push。
