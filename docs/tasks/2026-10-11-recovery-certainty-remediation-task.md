# Task Plan: 修复恢复驱动与执行确定性审查问题

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户在审查确认 A01–A10 后明确要求“执行修复”，并要求遵循 best-practice。

<!-- task-doc-section:background-goal -->
## Background and goal

修复已离线复现的十类恢复/分类问题：内存 driver 错误收尾、Bash/文件/协作准入误标、永久 400 错重试、length 恢复卡死、确认结果未投影、不完整批次提前释放依赖、导航遗留旧队列及取消覆盖已确认结果。按实际执行阶段和所属任务/分支保留事实，不通过全局降级 unknown 消除症状。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 只修改对应恢复/确定性/分类边界和必要回归、契约说明。保留上一轮正确 task-settled/TUI 接线。
- 所有真实未确认副作用、未 ack I/O、启动后/不透明 adapter 异常仍保守；不会把目录已创建误说成 write 未开始或完成。
- 不修改已有用户 session/锁/团队库、不重启用户进程、不调用真实 provider/凭证、不改依赖/锁、无构建/完整测试/推送/发布。
- 其他 session 的 `11067598d` 工作流提示变更保留。共享 worktree 使用互斥文件所有权；协调者独占本文/最终检查/LEARNS/提交。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 开始修复 HEAD=11067598d，worktree 干净；审查基线涉及的恢复/分类源码未被该并发提交更改。 | git status/log；上一轮 git diff --name-only 95d2e3161..11067598d。 |
| F-002 | A01 内存双 preflight 请求覆盖 journal，原 provider 未结束却 isIdle=true/agentStreaming=true/settled=1。 | TaskRecoveryJournal.acquire:584；上一轮 held-faux barrier 回放。 |
| F-003 | A02/A09 前台 cwd、workspacePolicy、write ELOOP 前置拒绝均零执行却 unknown/starts2；A08 成功写入和 acknowledged exit0 后取消也丢结果。 | 审查报告 /tmp/easy-pi-recovery-audit-20261011.md；实际本地调用及源代码链路。 |
| F-004 | A03 标准 SDK 永久 400 的 timeout 字段/512 参数值触发两次 retry、三次请求，非网络错误被网络分类。 | error-body.ts + retry.ts + actual faux Session 回放。 |
| F-005 | A04 length/recoverable=false 仍被选为 resumeToolCalls assistant；A05 verified edit result 在新 prompt 中 callExists=true/resultExists=false。 | AgentSession.resumeTask/_runAgentPrompt；原生 journal/真实 edit 与 reconcile 回放。 |
| F-006 | A06 planned A+B/accounted A，B executions0 却释放 needs-B followup；A07 导航后旧 failed-branch followup 被新分支消费。 | actual sequential Session/readOnly evidence/reconcile_task 与 idle tree 回放。 |
| F-007 | A10 send/interrupt/close 非法目标零团队变化仍调查；send queue admission 前取消零变化仍 unknown。 | 原生工具注册 + Controller + 内存 SQLite + faux 回放。 |
| F-008 | 验证发生权限偏差：子代理误选 context-overflow.test.ts，而非离线 overflow.test.ts；PI_OFFLINE 不门禁该文件。至少一项 provider-completion test 执行；顶层 credential helper 可读取/刷新/保存认证。具体远端请求及认证修改未由日志证明，也未检查个人凭据。 | 实际 log pi-bash-task-8-37420b35.log 为 191 passed/34 skipped；context-overflow.test.ts:25、56–65,511–523；test/oauth.ts:28–86；已主动告知用户，停止使用该路径，后续仅离线矩阵。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 采用最小边界修正和现有恢复语义；如必须引入小型 typed certainty 元数据以跨 backend/capture 保留证据，仅为已证明的接缝添加，不增加配置或新恢复子系统。
- Open question: 无需用户决策。已取消/已完全记账的旧 intent 仍遵循现有新 prompt 替换语义；不得为了 A05 无限归档所有历史失败任务，但替换前必须完成原 call/result 交换，未记账任务必须可恢复。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A01 内存和持久 driver 排他；拒绝的第二请求不覆盖、收尾活跃第一请求；嵌套 queue/reconcile 操作不释放 driver。
- A04 length 只补齐未执行结果并继续新模型步，绝不派发截断参数；A05 所有已验证 journal-only 结果有序进入 canonical/context。
- A06 交接依赖队列前核对全部 planned call IDs；A07 成功导航只恢复目标分支待办，旧 durable 待办保留，cancel/no-op 不清当前队列。
- A02/A09 确认无效果的 preflight/queue/path 拒绝保留 not_started，实际无额外调查；A08 ack 完成的效应保留 confirmed 和原事实，用户取消仍停止后续工作。
- A03 永久 400 不被正文数字/字段名误判，已支持的真实 transient/network/限流/取消/overflow 行为不退化。
- A10 明确 controller 准入拒绝/排队取消保留 AdmissionError，无效果不调查，后准入失败保持 unknown。
- 每个问题有原实现 red 和修复后 green 的永久回归；定向邻接、根 npm run check、任务文档验证及限定 diff 通过，完成提交不推送。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001、T-002、T-003、T-004 独立；T-006 为最终邻接验证 fixture 工作，T-007 为 IO 独立复核发现的两条闭环；T-008 为 driver 独立复核发现的 provider wire/result/receipt 投影闭环；T-009 修复新增 projector 的跨 response call-ID 重用回归；T-010 为外部新增shutdown API的测试double契约对齐；T-011 闭环receipt发布中断/历史fact位置，T-012 修正最终类型检查的fixture定义；T-005 依赖前四项及 T-006/T-007/T-008/T-009/T-010/T-011/T-012。
- Parallel batches: 一次 parallel 包装启动四个有互斥文件所有权的子任务；现有工具无 DAG 批量工具，不虚构。
- Serialization constraints: 所有 AgentSession/TaskRecovery 改动集中在 T-001；所有 native/host I/O/ExecutionError/capture 改动集中在 T-002；T-003 仅 AI 分类、T-004 仅团队边界。子代理不编辑本文/LEARNS、不运行 npm run check --write 全仓库、不 stage/commit。协调者集成阶段才运行写式检查。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 恢复驱动所有权、完整交换与分支队列

- Status: done
- Owner: /root/remediate-driver
- Objective: 修复 A01、A04、A05、A06、A07，保留明确暂停、安全恢复和先持久化事实语义。
- Inputs and prerequisites: F-002、F-005、F-006；已复现报告；完整源代码/仓库规则。
- Scope or files: packages/coding-agent/src/core/agent-session.ts、task-recovery.ts；新 test/suite/regressions/b824062c-recovery-driver-contract.test.ts；必要已有 task-recovery/settled/queue/navigation 测试由该 owner 专有。
- Expected output: 最小 driver/queue/recovery 修正，五个场景永久回归和邻接证据。
- Dependencies: None.
- Execution steps:
  1. 完整读取模块并先跑五个行为 red，保留证据。
  2. 修正内存排他（包括 owned 嵌套操作）、planned-ID 检查、结果补全、length 和成功导航队列重绑。
  3. 运行全部拥有测试和相关邻接，不编辑 IO/AI/团队模块。
- Acceptance criteria:
  - 五个原故障 oracle 满足，未确认效果不重放、队列顺序/receipt/branch ownership 保持一致。
- Verification method:
  - suite/harness + faux、seeded合法 journal、held/barrier；定向 Vitest。
- Validation evidence: 五原故障/nested/persisted system prompt共9行为red；后续provider wire/receipt边界经T-008/T-009/T-011闭环。最终34永久driver回归green、root34/34、完整39-file matrix397passed/13skip、原independent reviewer原触发/clone/receipt/checkpoint再次验证，所有已报告finding corrected且无新actionable finding。根check完整通过（T-005汇总）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 在 backend/capture/工具阶段保留执行确定性

- Status: done
- Owner: /root/remediate-io
- Objective: 修复 A02/A08/A09，区分未开始、未确认在途、已 ack 完成，不把取消展示等同于未知结果。
- Inputs and prerequisites: F-003；前台 executor0、write callback0 和 ack后取消的真实离线证据。
- Scope or files: packages/agent/src/harness/types.ts、env/nodejs.ts、env/node-process-executor.ts、env/background-task-manager.ts、env/background-task-types.ts（必要）、utils/shell-output.ts、tools/bash.ts、edit.ts、write.ts、workspace-policy.ts（必要）；packages/coding-agent/src/core/tools/bash.ts、edit.ts、write.ts；对应专有工具测试和新 test/suite/regressions/b824062c-io-certainty.test.ts。不编辑 agent-session/task-recovery 或 AI 模块。
- Expected output: 只在实际阶段边界增加/传播必要 typed certainty，回归同时覆盖真 unknown 和目录 partial effects。
- Dependencies: None.
- Execution steps:
  1. 先针对 preflight/capture/path/queue 与 ack 后取消写 red。
  2. 在最早有权知道阶段的层保留证据，避免错误文案/泛代码分类和不透明 adapter 降级。
  3. 运行拥有工具/集成回归和截断输出/非零退出/在途取消/队列锁邻接。
- Acceptance criteria:
  - A02/A09 无效果不调查；A08 已确认结果不丢；真失效/部分目录创建不声称未开始或完整成功。
- Verification method:
  - actual local backend + fake deterministic ack/gate + suite/harness faux；定向 Vitest。
- Validation evidence: 原 native/Session各8行为red；typed prelaunch metadata默认unknown，target ack不因晚signal丢失，mkdir/在途reject保持unknown。独立review发现两个缺口，T-007闭环后reviewer全源码/21+19回归复核通过；协调者读取原red与新增3+2red和精确diff，独立10-file Agent矩阵153passed/1skip。owner最终host13-file矩阵141passed/2skip；完整组合和rootcheck由T-005完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 永久 provider 错误与 transient 分类分离

- Status: done
- Owner: /root/remediate-retry
- Objective: 修复 A03，不把 error body 的字段名和普通数字当网络/HTTP 状态。
- Inputs and prerequisites: F-004；当前 classifier/error formatter/所有真实支持的错误测试。
- Scope or files: packages/ai/src/utils/retry.ts、error-body.ts；必要的小型现有 diagnostics/type 与 api catch接线（若确有需要必须限定并报告）；AI retry/error/provider 测试；新 packages/coding-agent/test/suite/regressions/b824062c-permanent-error-retry.test.ts（只测试，无 core 修改）。
- Expected output: 最小、可解释的分类修复，永久400单次请求及 transient 邻接保持正确。
- Dependencies: None.
- Execution steps:
  1. 先跑生产格式化永久400样例的 classifier/network/Session red。
  2. 利用实际可信状态/错误类型或明确状态表示，不依赖裸数字和 body timeout。
  3. 验证 quota precedence、408/409/429/5xx、network、用户取消和正常跨 provider错误格式。
- Acceptance criteria:
  - 样例永久400只一次请求，无 auto retry、非 network；真实临时错误有界重试不退化。
- Verification method:
  - 最终 AI 离线定向测试 + suite/harness faux；发生过一次误选 e2e 文件的偏差，详见 F-008。
- Validation evidence: 两个永久400 classifier 和两个 Session 的行为 red（原3 requests/2 retries）；子代理最终9 AI files/224 tests和5 Session files/9 tests green。协调者完整读取两个生产模块/diff/永久回归与 red/green logs，对抗检查 status 优先级、JSON body 与 genuine timeout；独立重跑同9-file AI matrix 224/224，最终 coding-agent matrix 中本项两例通过（矩阵另一个 fixture 故障归 T-006）。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 协作准入阶段的无效果拒绝

- Status: done
- Owner: /root/remediate-collaboration
- Objective: 修复 A10 的非法 target 与 serialize 内准入前取消，保持后准入未确认事实。
- Inputs and prerequisites: F-007；current controller/wrapper/admission contract 与零团队变化回放。
- Scope or files: packages/subagent/src/collaboration-contract.ts、collaboration-controller.ts；packages/coding-agent/src/extensions/pi-collaboration-tools.ts；专有 collaboration-controller/pi-collaboration-tools tests及新 test/suite/regressions/b824062c-collaboration-admission.test.ts（必要）。
- Expected output: 准确 AdmissionError/早期验证接线和三个 target/三个取消 site 保护回归。
- Dependencies: None.
- Execution steps:
  1. 先跑非法目标/排队取消的 known-not-started red。
  2. 只修明确 guard，不全局按 code 转换后启动错误。
  3. 运行团队/工具/容量/持久化 unknown 邻接，证明未创建 child/receipt/mail。
- Acceptance criteria:
  - 无效果拒绝不调查；已准入后失败不被假定没发生。
- Verification method:
  - memory/private SQLite + faux/host gate；定向 Vitest，不使用真实模型。
- Validation evidence: 原 wrapper 六非法 target 和三个排队取消共 9 个行为 red，controller 三个 AdmissionError red；源码只加纯路径前校验和三 guard 类型。子代理 green：coding-agent 4 files/61 tests、subagent 6 files/148 tests。协调者原命令重跑新永久回归 14/14；独立 verifier 完整边界复核无 actionable findings，并重跑工具组合 47/47 和限定 controller/contract 邻接。排队取消通过真实工具直接调用而非整 session abort；最终 root check/T-005 仍待执行。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 整合、独立复核、全仓库检查与提交

- Status: done
- Owner: coordinator
- Objective: 核对全部 A01–A10 输出，独立重跑有意义的矩阵并关闭跨层/新回归。
- Inputs and prerequisites: T-001–T-004 的已检查 diff 与真实 red/green 结果。
- Scope or files: 本文、必要独占整合测试、LEARNS.md；只修改已授权问题及验证所需文件。
- Expected output: 十项逐项验收表、受限 diff、检查与提交证据。
- Dependencies: T-001, T-002, T-003, T-004, T-006, T-007, T-008, T-009, T-010, T-011, T-012.
- Execution steps:
  1. 阅读子代理结果/源码 diff，串行集成每项证据；独立对抗复核安全负例与跨层组合。
  2. 运行最终定向矩阵、npm run check（完整输出）、diff/status 和文档验证，核对写式检查范围。
  3. 按证实经验更新 LEARNS，显式路径提交代码与最终执行记录，不推送。
- Acceptance criteria:
  - 十类 oracle、邻接和根检查通过；无伪造结果/不透明错误降级/用户进程或记录修改，无未验收宣称。
- Verification method:
  - targeted Vitest + faux/local fixtures；root check；git diff/status；task_document.py validate。
- Validation evidence: 全部写者结束后root独立64-file matrix：AI224、Agent153/1skip、Subagent148、Coding-agent397/13skip，共922passed/14skip；最终fixture converter修正后driver34/34另复跑。npm run check三次完整输出已读，前两次fixture类型错误修正后task-25-229634e1.log exit0，Biome1474 files/no fixes，pin/import/locks/tsgo/browser-smoke通过。实际限定32-file代码/测试/LEARNS提交2507ea5d7cae6a4823a68e54a3011aeefff08fe1。commit前实际staged stat/paths/32count/diffcheck已核对；collaboration只四新增行，外部两格式hunk留worktree。本文另行docs提交；不推送。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 消除并发邻接 fixture 的固定时间准入假设

- Status: done
- Owner: /root/remediate-driver
- Objective: 使既有并发验证等待真实运行/队列事件，而非负载相关的 10ms sleep；不得改产品以隐藏 fixture 失败。
- Inputs and prerequisites: 协调者最终 35-file matrix 的实际 failure log；单独旧组合 14/14、新 driver 16/16 通过。
- Scope or files: packages/coding-agent/test/agent-session-concurrent.test.ts（该 owner 独占）；必要临时只读实验。
- Expected output: 失效证据、因果区分与最小事件 barrier fixture；未结束 prompt 在 assertion failure 时也安全清理。
- Dependencies: None.
- Execution steps:
  1. 阅读完整测试，区分产品错误与 disk/auth preflight 尚未完成的固定 sleep 假设；重复具体失败 case 并保留证据。
  2. 若证实 fixture 问题，以真实 agent_start/queue_update gate 替代 sleep，不放宽断言或扩大超时。
  3. 运行完整修改文件与核心邻接；协调者再跑相同最终矩阵。
- Acceptance criteria:
  - 并发保证与 extension steering 断言保持，任意断言失败不留下异步拒绝或未结束 run。
- Verification method:
  - 指定并发文件 + 确定性 held preflight/barrier；同一矩阵重跑。
- Validation evidence: 35-file matrix 341 passed/1 failed/13 skipped；held preflight/fake10ms 的旧 helper 会错误ready=true，永久fixture regression实际red；真实agent_start+非aborted assistant_start和queue_update gate替代sleep，shutdown+allSettled清理prompt。owner全文件8/8（三次）及7-file邻接48/48；协调者读取red/green logs和完整diff，再独立重跑全文件8/8，无unhandled error。源码未改。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — IO adapter 取消事实与本地非目录 cwd 闭环

- Status: done
- Owner: /root/remediate-io
- Objective: 修复独立 reviewer 确认的 explicit capture.cancelled 被 numeric exit 覆盖，以及存在但非目录 cwd 的无启动拒绝仍 unknown。
- Inputs and prerequisites: verify-io-remediation 的实际 private offline probe；现有 T-002 输出。
- Scope or files: T-002 同一 IO owner 的 Bash/capture/本地 backend 和永久 io-certainty 回归；不改 driver/AI/团队。
- Expected output: 两种 edge oracle 的永久 red/green；保留真实迟到取消 ack 和 opaque adapter unknown。
- Dependencies: None.
- Execution steps:
  1. 增加明确 cancelled=true 同时携 numeric exit 的 custom capture red；普通本地 cwd 为文件的 actual Session/native red，executor/process start=0。
  2. cancelled flag 保持权威，只忽略已 ack 后晚到的 caller signal；本地 cwd stat 确認目录后才执行，合法目录symlink保留，不 blanket 改 spawn_error。
  3. 检查 native foreground/background 同类本地准入边界；重跑所有修改测试和 T-002 邻接。
- Acceptance criteria:
  - adapter 明确取消不显示成功或放行后续工作；本地非目录cwd零启动不调查；原有晚取消ack、安全unknown负例保持。
- Verification method:
  - exact native/custom capture + local Session/faux、private fixtures；定向Vitest。
- Validation evidence: owner永久 native3/Session2行为red，实际callbacks2→1，普通file cwd unknown→not_started；只改六文件。三个本地preflight stat目录（symlink positive），core acknowledgedExit排除capture.cancelled。ownergreen Agent153passed/1skip、host141passed/2skip；原独立reviewer重新读六完整模块/新测试，21/21+19/19通过，两finding已corrected、无新finding；协调者实际redlog/diff和native153passed/1skip重跑通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 确认结果的 provider wire 与历史队列 receipt 投影

- Status: done
- Owner: /root/remediate-driver
- Objective: 闭环独立 driver reviewer 确认的 A05/A07 修复缺口：远离call的结果造成wire重复、partial verified内容缺失和历史receipt无法重新投递。
- Inputs and prerequisites: 独立 reviewer private probes 的实际输出 /tmp/easy-pi-driver-verifier.log、/tmp/easy-pi-driver-verifier-partial.log；T-001三文件输出。
- Scope or files: 同一driver owner的 agent-session.ts、task-recovery.ts及永久driver回归；agent-session-concurrent.test.ts由T-006先完成；不改AI provider转换器或扩大配置。
- Expected output: 模型投影保持完整call/result原子交换，partial已验证内容可见、未知/未派发B仍暂停；历史队列receipt恢复无需复用session全局已消费ID。
- Dependencies: T-006.
- Execution steps:
  1. 永久red覆盖实际 OpenAI convertMessages wire只有一个真实result、A verified/Bpending的正文可见、队列receipt已在descendant消费后回选ancestor。
  2. 保留canonical审计，最小provider-only/receipt身份修正；不伪造未知B结果，不取消旧分支durable队列，不改普通provider transformer掩盖坏输入。
  3. 运行新/修改测试和recovery/cache/queue/navigation邻接，原verifier独立复核更新。
- Acceptance criteria:
  - wire无No result provided重复或孤儿；confirmed内容对模型可见；恢复receipt可投递/取消且无重复ID；unknown、retirement及call顺序安全保持。
- Verification method:
  - harness/faux + production provider serialization（无网络）；private journal/tree receipts；定向Vitest。
- Validation evidence: 四实际行为red→21green；原reviewer三finding corrected。rawID/发布断点新回归经T-009/T-011闭环后最终34永久回归、root全矩阵与independent原触发复核通过，无重复/synthetic/orphan、partial A内容可见，B未执行；branch queue投递/取消/重开、旧audit不改。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — Provider call ID 只标识所属 response，不覆盖已完成交换

- Status: done
- Owner: /root/remediate-driver
- Objective: 修复 T-008 全历史Map按raw callId归并造成的普通多轮历史内容误归属。
- Inputs and prerequisites: root提出反例后，原independent reviewer actual Session/faux两次正常执行确认：canonical FIRST/SECOND，projected SECOND/SECOND、suspended为空；Google/OpenAI真实adapter允许跨response重用ID。
- Scope or files: driver owner 的 agent-session.ts和永久driver回归；ours-only source/patch artifact同步更新；保留MCP同文件外部区域。
- Expected output: 已连续配对的普通call/result不改动；晚recovery输出仅按所属assistant/task occurrence修正，不以全历史rawID最后值覆盖。
- Dependencies: None.
- Execution steps:
  1. 永久red加入普通两轮同call_0、不同参数和返回值；保持canonical与真实provider wire FIRST/SECOND，前缀不被追写。
  2. 最小修正结果所属occurrence，既有连续交换保持，不扩展AI converter或引入新协议。
  3. 重跑完整driver回归/邻接和同independent reviewer复核；更新own-only staging artifacts。
- Acceptance criteria:
  - 无suspended任务的正常多轮不重写已确认历史；T-008四种原故障与未知效果保护仍通过。
- Verification method:
  - actual Session/faux + production OpenAI wire；定向Vitest和对抗复核。
- Validation evidence: 普通重用ID及known FIRST→unknown SECOND/reconcile的2行为red→24green，保留后续THIRD和原prefix。新增一项existing v2 journal resultEntryId关联实际assistant occurrence，不新建协议/版本。原independent reviewer三轮原触发和prepareNextTurn clone验证 corrected；发布断点和checkpoint稳定位置由T-011闭环。最终root34/34+全矩阵+tsgo通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 并发 fixture 对齐新增 shutdown API

- Status: done
- Owner: coordinator
- Objective: 对齐外部MCP工作引入的ExtensionRunner.isInSessionShutdown，仅修两处测试double，不修改或降级产品shutdown语义。
- Inputs and prerequisites: T-009 latest13-file矩阵128pass/2teardownfail/1skip；完整fixture和实际failure log已读取。
- Scope or files: packages/coding-agent/test/agent-session-concurrent.test.ts 两double类型和实现；本文。
- Expected output: 两mock具备isInSessionShutdown:()=>false，保留所有并发/事件/准入断言和cleanup drain。
- Dependencies: None.
- Execution steps:
  1. 读取fresh完整测试和two TypeError logs确认仅teardown契约缺失。
  2. 精确补mock方法及类型；不改source以隐藏失败。
  3. 重跑整个修改文件和最终矩阵。
- Acceptance criteria:
  - 两teardown错误消除，无断言放宽，无MCP/source删除，历史准入barrier仍有效。
- Verification method:
  - 完整concurrent8case +最终矩阵；scoped Biome。
- Validation evidence: 实际log pi-bash-task-25-af30eb58.log两mock afterEach TypeError；fresh完整fixture读后精确补两类型/两实现四行，root全文件8/8通过（task-18-7a0f1027.log），无断言放宽。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 发布receipt写前关联与历史facts原位投影

- Status: done
- Owner: /root/remediate-publication-finality
- Objective: 闭环独立reviewer的新两个边界：canonical result已追加但receipt journal更新失败，以及source在checkpoint外时fact末尾追加破坏续接前缀。
- Inputs and prerequisites: T-009 output；独立scope checkpoint/atomic probe；root观察source/journal当前代码。
- Scope or files: agent-session.ts、task-recovery.ts、永久driver回归；own-only snapshot/patch。新writer独占原driver模块（旧writer已settled）；保留MCP外部区域。
- Expected output: 先持久source-scoped稳定receipt意图、再用同ID发布，重入/冷恢复不重复；存在证明才视为canonical。替换孤儿result的原位置为historicalfact，非末尾每次挪动。并补driver effect schema类型。
- Dependencies: None.
- Execution steps:
  1. 永久red加入after-canonical-append的journal save失败与checkpoint+连续inspect wire前缀case。
  2. 最小write-ahead receipt关联和原位fact投影，不增journal版本/配置/泛provider协议；root类型错误中的driver params以具体effect schema修正。
  3. 全文件与recovery/cache/retirement/queue邻接green，更新own-only artifact排除MCP。
- Acceptance criteria:
  - 发布断点无重复/synthetic结果，checkpoint后第二次模型请求严格延长前一wire；known/unknown、reused IDs、旧audit不退化。
- Verification method:
  - actual private publication failpoint + harness/faux/production wire；定向Vitest、独立review。
- Validation evidence: writer6行为red（append/ack warm+cold、reserved非pub、checkpoint prefix）及branch receipt2red→最终34green/146邻接green1skip。UUID意图先持久化，用同ID追加，actual branch-visible canonical才证明发布，off-path consumed重绑。原independent reviewer重跑2原触发+clone原probe3/3、34永久回归及56邻接green1skip，finding corrected/no新finding。root read完整新回归与精确delta，唯一余TS2322 fixture用production convertToLlm适配Role边界后34/34+rootcheck全通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 三个fixture的真实API类型对齐

- Status: done
- Owner: /root/remediate-fixture-types
- Objective: 修root check里的三处测试类型错误，不放宽产品类型、不改dependency或测试业务oracle。
- Inputs and prerequisites: 实际完整rootcheck task-19-b35e5bd7.log（Biome1474 files/no fixes，tsgo三个fixture类别+driver params）；真实接口。
- Scope or files: agent/test/harness/io-certainty.test.ts、ai/test/retry.test.ts、coding-agent/test/suite/regressions/b824062c-io-certainty.test.ts 三文件专有；不改生产或driver fixture。
- Expected output: BackgroundTaskManagerLike.start准确vi mock函数类型；diagnostics通过实际AssistantMessage赋值；core Bash facade通过真实schema/validated参数适配regular AgentTool，不用any掩盖。
- Dependencies: None.
- Execution steps:
  1. 完整读三测试及实际API类型，定位Root TS2322/TS2353/TS2345。
  2. 最小fixture类型修正，运行三个完整测试和scoped Biome；生产API保持。
  3. Root重新执行完整npm check，不声称未跑类型通过。
- Acceptance criteria:
  - 相同业务回归仍green，类型符合实际函数/工厂契约，无any/inlineimport/deps变更。
- Verification method:
  - 三文件定向Vitest + root tsgo/check重跑。
- Validation evidence: 3类TS错误的真实mock函数/diagnostics返回对象/unknown facade类型已对齐，必要通用类型修正在新writer初读时已由并发会话出现，未伪造作者或行为red。writer补diagnostics前后反例和facade注解/验证说明，21+128+19 tests及readonly tsgo通过；root实际读取regions/diff，最终AI224+Agent153+Coding397矩阵及npm check通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

全部由所属 package 根运行 `PI_OFFLINE=1 node <repo>/node_modules/vitest/dist/cli.js --run <指定文件>`。每个新/修改测试完整运行，保留行为 red、green 与安全负例。禁止 npm test、完整 Vitest 和 build；PI_OFFLINE不替代目标文件的真实API门禁审查（F-008）。根检查仅coordinator在写者结束后执行，读取完整输出并核对改动。

### 最终逐项验收

| Finding | 永久oracle / 安全负例 | 最终结果 |
| --- | --- | --- |
| A01 | memory/persisted双preflight、系统prompt和settled不串任务、nested ownership | passed |
| A02 | 本地missing/file cwd和workspace policy executor0、不透明spawn/lostack仍unknown | passed |
| A03 | standard SDK400 timeout/512只1request；真实408/409/429/5xx/network/配额取消邻接 | passed |
| A04 | 持久length零/部分结果和text-only新步；截断调用执行0 | passed |
| A05 | 全verified结果有序canonical/wire一次、partial A可见/B不执行、重复rawID按occurrence；reserve/append/ack warm/cold | passed |
| A06 | planned A+B/accounted A不释放needs-B；完整记账正常交接 | passed |
| A07 | 成功tree切换所有livequeue重绑；旧durable保留、no-op/cancel不清；ancestor已消费receipt/fork重开 | passed |
| A08 | fulfilled目标write/edit和实际正常exit ack保留；取消阻止后续；inflight/reject/mkdir-only/signal unknown | passed |
| A09 | ELOOP纯queue/path和dispatch前取消callbacks0/not_started；mutation开始后不降级 | passed |
| A10 | 三非法targets/三排队取消无receipt/mail/revision变更；post-admission同code/persistence仍unknown | passed |

### 最终命令（package根运行）

统一runner：`PI_OFFLINE=1 node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run`，后接以下完整目标列表：

- **V-001 AI**，`packages/ai`：`test/retry.test.ts test/error-body.test.ts test/provider-error-body-regression.test.ts test/bedrock-error-metadata.test.ts test/provider-error-body-passthrough.test.ts test/provider-retry.test.ts test/google-shared-retry.test.ts test/openai-completions-retry.test.ts test/overflow.test.ts`。9 files/224 passed；log `pi-bash-task-21-ada32f93.log`。
- **V-002 Agent**，`packages/agent`：`test/harness/io-certainty.test.ts test/harness/bash.test.ts test/harness/node-process-executor.test.ts test/harness/background-task-manager.test.ts test/harness/tools.test.ts test/harness/nodejs-env.test.ts test/harness/truncate.test.ts test/harness/background-task-lifecycle-regression.test.ts test/harness/background-task-tools.test.ts test/harness/background-wait-cancellation.test.ts`。10 files/153 passed/1 skipped；log `pi-bash-task-22-41519f2b.log`。
- **V-003 Subagent**，`packages/subagent`：`test/collaboration-controller.test.ts test/collaboration-contract.test.ts test/collaboration-mailbox.test.ts test/collaboration-lifecycle.test.ts test/collaboration-targeted-wait.test.ts test/collaboration-history-store.test.ts`。6 files/148 passed；log `pi-bash-task-23-1959ca57.log`。
- **V-004 Coding-agent**，`packages/coding-agent`：`test/suite/regressions/b824062c-recovery-driver-contract.test.ts test/suite/regressions/b824062c-io-certainty.test.ts test/suite/regressions/b824062c-permanent-error-retry.test.ts test/suite/regressions/b824062c-collaboration-admission.test.ts test/suite/regressions/b824062c-bash-task-timing.test.ts test/suite/agent-session-task-recovery.test.ts test/suite/agent-session-queue.test.ts test/suite/regressions/6363-agent-settled-event.test.ts test/suite/regressions/tree-during-streaming.test.ts test/suite/regressions/4a61062a-recovery-cache-prefix.test.ts test/suite/regressions/4a61062a-retired-computer-capture.test.ts test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts test/suite/regressions/bevfusion-known-bash-exit.test.ts test/suite/regressions/session-known-tool-failures.test.ts test/suite/regressions/session-tool-execution-outcomes.test.ts test/bash-tool-contract.test.ts test/file-mutation-queue.test.ts test/suite/regressions/5303-bash-output-truncation.test.ts test/bash-close-hang-windows.test.ts test/edit-tool-legacy-input.test.ts test/edit-tool-no-full-redraw.test.ts test/suite/agent-session-bash-persistence.test.ts test/suite/regressions/9068-user-bash-fail-closed.test.ts test/suite/regressions/5208-late-bash-output.test.ts test/suite/regressions/3317-network-connection-lost-retry.test.ts test/suite/regressions/6019-explicit-provider-retry-message.test.ts test/suite/regressions/6904-dns-transport-retry.test.ts test/pi-collaboration-tools.test.ts test/agent-session-concurrent.test.ts test/agent-session-retry.test.ts test/agent-session-tree-navigation.test.ts test/suite/agent-session-retry-events.test.ts test/suite/agent-session-retry-compaction-history.test.ts test/suite/agent-session-socket-retry-budget.test.ts test/agent-session-auto-compaction-queue.test.ts test/suite/agent-session-canonical-persistence.test.ts test/suite/agent-session-stream-checkpoint.test.ts test/suite/agent-session-prompt.test.ts test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts --testNamePattern '^(?!.*a killed native tool remains unknown on restart)'`。39 files（37 passed/2 skipped）、397 passed/13 skipped；log `pi-bash-task-24-eeec1224.log`。其中driver fixture最后production converter类型修正后，单独原runner+该driver文件再跑34/34，log `pi-bash-task-26-78a3e1d6.log`。
- **V-005 Root**：`npm run check`，exit0，完整log `pi-bash-task-25-229634e1.log`；Biome1474 files/no fixes，pin/import/shrinkwrap/install-lock/tsgo/browser-smoke通过。未构建。
- **V-006 Authority/Diff**：`python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-10-11-recovery-certainty-remediation-task.md`；`git diff --check`及最终staged限定diff。

上述root日志完整路径前缀均为 `/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/`。最终matrix合计922passed/14skipped；不把额外复跑重复计入922。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 不透明后端的丢 ack/部分 I/O 不能通过错误文字误说成未执行；typed certainty 仅来自有权观测的 backend/stage。
- mkdir 也是 mutation；调用 write 前不等于零副作用。完成 proof 只在目标写入/正常非 promoted numeric shell exit ack 后成立。
- 悬挂原 call/result 和 queue receipts 必须 branch-scoped、完整且有序；不能把别的分支待办取消、挪用或当完成。
- 多子代理共用源仓库，无自动隔离/merge；所有跨模块影响在整合时实证检查。
- 运行中的既有用户进程不会热加载修改，本次不替用户重启或更正旧审计记录。
- F-008 权限偏差不能用最终离线测试通过抹去；无法宣称本轮零真实 provider/零 incidental credential lookup 或认证文件绝对未变。不通过读取凭据追补证明，不重跑该文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 读取审查报告、用户修复授权、仓库规则及当前 HEAD/干净状态，建立唯一执行记录；T-001–T-004 in_progress，分配互斥模块所有权准备一次并行派发。
- 2026-10-11: 重启点刷新 HEAD=11067598d，唯一新增为本文；文档 validator 通过。一次 parallel 调用实际启动四个隔离实施子代理，分别接收 T-001–T-004、互斥源码与回归所有权、red/green 和禁止真实外部动作契约。
- 2026-10-11: 协调者先重跑上一轮 Bash/task-timing、settled 和 concurrent 三文件，14/14 通过（非最终矩阵）。T-004 回执收到；实际读取其 red log（9 个预期行为失败）、green logs（coding-agent 61/61、subagent 148/148）和永久回归，源码 diff 仅早期纯 target 校验与三处 admission 错误类型。独立只读 verifier 正在复核，尚未最终验收。
- 2026-10-11: T-004 独立复核完成，无 actionable findings；协调者重跑新回归 14/14，验收 done。T-001 回执收到，实际读取 9 个行为 red、98 passed/1 intentional skip 邻接 log、三文件 diff 与 16-case 回归；driver 独立 verifier 开始。另有并发 session 新增 upstream-mcp-migration task doc，明确非本轮所有，保留不提交。

- 2026-10-11: T-002/T-003 实施回执收到；协调者实际读取 IO 两份 red（各8个行为失败）、retry Session red（两个3次调用）及生产 diff。AI 224/224、Agent 148 passed/1 skip、Subagent 148/148 独立重跑通过；T-003 验收 done。恢复驱动/IO 独立复核尚在运行。
- 2026-10-11: coding-agent 最终35-file矩阵341 passed/1 failed/13 skipped，失败在旧 concurrent fixture 的10ms准入假设；新增 T-006 独占该测试，派发因果实验和事件barrier修正，不修改产品以掩盖。
- 2026-10-11: T-006完成；协调者实际held-preflight red/48-testgreen log和精确fixture diff，独立全文件8/8通过，验收done。T-008改in_progress，原owner继续；修复前保存本轮agent-session-only源与patch，外部MCP同文件采用新鲜精确编辑和最终局部stage，不占用其改动。
- 2026-10-11: driver 独立复核三个 actionable findings：完整结果被provider转换合成重复、partial已验证内容在facts里丢失、descendant已消费receipt的ancestor queue恢复抛错。协调者读取实际probe logs，新增 T-008，等待同owner先完成T-006再串行修复，T-001保持in_progress。
- 2026-10-11: 观察到并发MCP迁移扩大至 manifests、root tsconfig/vitest、pack脚本及新增mcp/tool-search模块；非本轮文件，保留、不修改、不stage。最终写式root check需核对这些共享文件drift。
- 2026-10-11: IO 独立复核两条 actionable findings：explicit capture.cancelled 与正常晚signal不同；本地existing-file cwd只F_OK检查。新增 T-007，由原IO owner独占修复，T-002保持 in_progress，最终检查暂缓至全部写者结束。
- 2026-10-11: 子代理更正此前“provider全部跳过”的错误回执。协调者读取实际191passed/34skipped log及 e2e/helper源码，确认 F-008 偏差并立即告知用户；真实请求/认证刷新仍无法由日志确定，未检查凭据文件；最终矩阵已改为已核对的离线 overflow.test.ts。

- 2026-10-11: T-007行为red和精确六文件修正已审；原IO reviewer复核两个finding corrected，独立21+19通过，无新finding。协调者native10-file/153passed/1skip重跑通过，验收T-007/T-002 done。T-008 writer仍运行；MCP与恢复同文件共享变更采用saved ours-only snapshot/patch及精确stage，collaboration四新增行的私有patch已cached --check通过而未实际stage。

- 2026-10-11: T-008回执、四行为red、精确own incremental patch和新增wire/receipt回归已读取；累计AgentSession own-only patch cached --check和hash通过，未stage。原reviewer三finding corrected，但root提出call-ID跨response反例经其真实Session确认新回归（FIRST/SECOND投影成SECOND/SECOND），新增T-009继续同writer；T-001/T-008保持in_progress，不提前最终验收。

- 2026-10-11: T-009回执为partial：24产品回归green，最新neighbor2个teardown失败来自MCP新增shutdown方法/test double不匹配。协调者读取delta、journal helpers、failurelog及fresh完整fixture，原reviewer继续检查24-case与occurrence/clone边界；新增T-010由coordinator独占两mock契约修正，不把外部API降级。

- 2026-10-11: T-010两double类型/实现仅四行修正，root8/8green。所有原writer结束后首次root npm check运行：Biome1474 files/no fixes、pin/import/shrinkwrap/install-lock通过，tsgo明确三fixture类别和driver参数类型错误；未进入browser-smoke，无自动改外部文件。新T-011 source/finality与T-012fixture互斥并行，换隔离新writer避免旧driver累计400k上下文继续膨胀。

- 2026-10-11: T-011六行为red、branch receipt两red和完整34-case回归/精确delta已检查；source receipt写前持久化与fact原位映射闭环，原independent reviewer原三probe和34+56邻接复核无新actionable finding。T-012实际API typing/diagnostics前后oracle验证21+128+19和readonly tsgo通过；三处基础类型修正已由并发会话出现，明确不冒充新writer作品。
- 2026-10-11: root第二次check仅driver fixture AgentMessage[]→Message[] TS2322；完整1196-line测试读后添加production convertToLlm导入与边界调用，不cast/放宽API。root34/34再跑通过；第三次完整npm check exit0、无自动修复，全部静态/锁/浏览器smoke gate通过。
- 2026-10-11: root最终64-file matrix共922passed/14skip（Windows/现有禁用及指定killcase），四新回归和前轮task timing全部通过。T-001/T-008/T-009/T-011/T-012验收done，T-005进入最后stage/commit；三条已验证经验更新LEARNS。
- 2026-10-11: 外部MCP会话已提交d22113e47，index清空；保留全部MCP功能。旧110base累计patch因其tree邻接变化不再适用，root fresh读取HEAD-relative recovery diff确认仅本轮AgentSession改动；collaboration仍有两段外部格式差异，只stage本轮resolveAgentPath四新增行，外部格式留worktree。

- 2026-10-11: 最终validator拒绝Overall done/Result partial组合；保留F-008诚实partial，将Overall标blocked（仅事故外部影响未核验），不把产品green冒充全程合规。所有代码task保持done。
- 2026-10-11: 显式stage31本轮文件+collaboration own四新增行cached patch，staged共32files/3344insertions/220deletions、diffcheck通过；普通git commit成功2507ea5d7（fix(coding-agent): preserve recovery certainty and branch ownership），未改hook配置/绕过检查/推送。实际commit后index空，唯一tracked dirty为collaboration外部11行格式替换，另本文未跟踪，保留不碰。T-005done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Blocker: 仅F-008过程偏差的外部影响未核验，不能宣称全过程passed；代码任务T-001至T-012已交付，无代码blocker。
- Unblock condition: 用户后续决定是否授权/提供事故核验日志；本轮不自动读取个人认证或重放provider请求。
- Evidence: 产品和最终离线验证通过：922passed/14skip、最终driver34/34再复跑、完整root npm check exit0/无自动修复、独立finding全部corrected及无新actionable finding。本轮代码/测试/LEARNS已限定提交2507ea5d7cae6a4823a68e54a3011aeefff08fe1，T-001至T-012全部完成，validator与限定diff gate通过，本文随docs提交。Result仍partial仅指F-008全过程权限/外部影响未证明，不将最终离线通过冒充全程零外部调用；产品修复与最终离线验证passed。
- Limitations: 不宣称执行权限完全合规：发生 F-008 误选 e2e/credential helper 偏差，远端请求/认证更新未知，已告知用户。没有物理TUI/Windows/完整suite/构建或旧用户会话回填验证；user-bash独立展示facade不在本轮模型工具恢复范围。
