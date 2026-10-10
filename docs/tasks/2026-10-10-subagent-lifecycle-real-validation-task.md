# Task Plan: Subagent 资源生命周期真实模型验证与修复

- Created: 2026-10-10
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求检查 subagent 自动回收和资源释放，使用真实 easy-pi、真实模型验证，修复发现的问题。

<!-- task-doc-section:background-goal -->
## Background and goal

检查原生 collaboration 的资源所有权、复用、卸载、退役、取消和根会话退出/恢复。以生产源码入口及真实 provider 建立证据，修复可复现的生命周期缺陷。有限测试无法证明穷尽所有潜在缺陷，最终明确覆盖与未覆盖边界。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

目标为 pi 的 native subagent/controller/host/runtime 接线及相关测试和文档。允许修复、临时隔离测试会话、现有认证的真实模型调用和正常限定提交。保留其它会话 TUI/LEARNS/candidate 改动。不改用户的真实 team/session 数据；不打印或保存密钥；不发布、不推送、不重建已安装产品，不运行未授权全套 e2e。真实 source CLI 与 SDK 均验证，未把 SDK 测试当作安装版验收。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前基线含上轮自动 dead-owner 恢复修复 | commit 8a3e591fd |
| F-002 | CLI 用户会话使用 pi-test.sh/tsx/source cli.ts | 上轮进程 argv 的只读验证 |
| F-003 | 持久化已完成 child 仍缓存；压力达到15 loaded 时卸载 idle child，close 保留历史 | collaboration-controller.ts load/close/finish |
| F-004 | 原真实 provider 测试仅4场景，cleanup 没有 await shutdown，提示词仍用退役 wire shape | test/subagent-real-provider.test.ts |
| F-005 | 用户本轮明确授权真实模型测试与修复 | 当前用户请求；AGENTS.md 真实API门控要求 |
| F-006 | 故障代码在16-child真实模型压力下终止了已完成child持有的后台任务 | lifecycle real baseline 57.46s；期望running、实测stopped |
| F-007 | 原wake继承能在任务完成后启动未派发推理 | 离线回归调用数1→2；真实baseline通知被消费；修改后真实通知保留且请求数不变 |
| F-008 | 原dispose忽略incomplete报告，shutdown虽报错却仍释放owner | 新离线host/controller回归分别resolved undefined和新owner可成功接管 |
| F-009 | 原Codex原生cleanup只清连接，没有清统计和fallback标记 | codex-session-cleanup 修改前失败，46项相关离线修改后通过；真实auto transport关闭验证通过 |
| F-010 | 最终真实SDK和源码CLI均使用openai-codex/gpt-6-astra；观察到实际api=openai-codex-responses | lifecycle最后完整5/5、原SDK4/4、CLI1/1日志 |

### 资源策略判断与修复结果

| 资源/边界 | 判断与最终行为 | 验证 |
| --- | --- | --- |
| 执行名额 | 最多15 child；完成/取消settled后释放，启动清理未结束继续保留 | controller准入/取消定向回归与真实4-child并发 |
| 已加载原生会话 | 持久化缓存最多15，LRU卸载resource-idle会话合理；后台running/stopping和正在推理/关闭的会话不能当作空闲 | 真实16-child压力、冷followup、17次detach；后台保持运行 |
| 内存会话 | 没有磁盘可供cold load，保留上下文受独立team-agent上限约束 | 既有内存准入/close回归；未做最大payload RSS压力测量 |
| 背景工作 | 完成delegation不代表进程结束；显式close/shutdown停止并等待资源，通知只在显式followup前送入child | 真实sleep600保持到close；close后任务active为空、记录PID探测ESRCH；wake请求数不增加 |
| 取消 | 等待实际前台输出marker才interrupt，不能把tool-start事件当作OS进程已启动 | 真实stdout marker、interrupt→settled→followup→close |
| 释放报告和owner | incomplete drain必须报错；dispose失败保留live owner和native引用，禁止另一controller接管 | 故障注入回归；正常CLI退出readback owner=NULL |
| provider状态 | 子会话关闭只清自身Codex连接、计数和fallback，不清另一会话 | 离线两身份/重开回归；真实auto transport |
| 历史与预览 | 历史结果有意保留，查询不加载、不推理；卸载不退役逻辑身份 | CLI resume /agents无assistant开始事件；SDK冷查请求数不变、cold followup保留2个user任务 |

没有新增TTL或自动删除历史。磁盘历史/背景输出留存不是本轮自动清理范围；逻辑history上限不等于物理磁盘配额。RSS、恶意/不合作扩展、真实Computer/native-app terminal drain和多provider网络故障未被有限场景穷尽。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 使用现有 openai-codex/gpt-6-astra 认证；先验证可用性，按真实响应记录失败，不替换用户全局模型配置。
- Open question: 无阻塞决定；测试采用有限短任务和定向并发，发现预算/服务限制后记录，不无限重试。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 资源生命周期与自动回收合理性有可追溯源码及实测判断。
- 定向真实模型验证至少覆盖完成/结果、复用、卸载/冷加载、close、取消、退出/重启和并发。
- 源码 CLI 至少完成一次真实 root→child→wait→close 流程，零推理查询不额外调用模型。
- 每个修复有修改前失败及修改后通过的稳定回归；真实场景复测有状态/readback。
- 相关离线测试、完整检查、限定diff和凭据不泄漏检查通过；记录无法覆盖的 native/网络异常。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002；T-001 → T-003；T-002/T-003 → T-004。真实验证与修复按已证明的失败交替推进。
- Parallel batches: 无，任务共享同一生命周期实现与真实 provider，协调者串行执行。
- Serialization constraints: 文档、controller/host/真实测试及Git提交由协调者独占本轮改动；保留外部 dirty files。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 生命周期审计和基线

- Status: done
- Owner: coordinator
- Objective: 明确资源所有权与释放边界，定位需要实测的风险。
- Inputs and prerequisites: 当前源码、AGENTS.md、既有定向测试。
- Scope or files: controller/store/session-host/pi-child-session-host/AgentSession/runtime/transport。
- Expected output: 本文中的资源判断、假设及判定条件。
- Dependencies: None.
- Execution steps:
  1. 完整阅读相关生产文件，检查完成/卸载/close/取消/shutdown 的引用与清理。
  2. 运行必要基线并核对真实测试配置。
- Acceptance criteria:
  - 每个重点风险均有具体路径和可观察oracle。
- Verification method:
  - 源码与定向回归对照。
- Validation evidence: 真实原始委派基线1/1通过；原生生命周期新增回归2/2按预期失败：自动卸载将后台任务从running变stopped；dispose忽略complete=false。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 真实模型与源码 CLI 验证

- Status: done
- Owner: coordinator
- Objective: 在隔离状态中验证资源生命周期和真实推理行为。
- Inputs and prerequisites: T-001；现有认证；明确 opt-in flag。
- Scope or files: test/subagent-real-provider.test.ts 与必要的新门控测试；临时 CLI runner。
- Expected output: 真实场景状态、资源指标、失败证据与CLI退出readback。
- Dependencies: T-001.
- Execution steps:
  1. 修正旧测试的协议和 await 清理，添加生命周期状态断言。
  2. 定向真实模型调用；CLI RPC/终端生命周期验证；不读取真实用户会话内容。
- Acceptance criteria:
  - 使用真实模型与生产入口，区分模型执行、工具执行及资源释放。
- Verification method:
  - 显式 PI_REAL_MODEL_EVAL=1 定向测试；隔离 CLI 的事件、持久化team/readback。
- Validation evidence: 最终lifecycle真实5/5（79.26s），原SDK真实4/4（78.19s），源码CLI1/1（23.89s）。均显式opt-in，真实provider/model；故障压力修改前失败，修改后后台进程/冷加载/退出readback通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 最小修复与回归

- Status: done
- Owner: coordinator
- Objective: 修复 T-001/T-002 证明的缺陷，不按猜测扩大行为。
- Inputs and prerequisites: 可复现失败、资源所有权证据。
- Scope or files: 证据对应的controller/host/runtime与定向测试。
- Expected output: 生产修复、失败前/通过后回归、真实复测。
- Dependencies: T-001.
- Execution steps:
  1. 先编码稳定失败，再修改因果位置。
  2. 复测原始场景与邻近路径；记录保留的合理缓存/历史。
- Acceptance criteria:
  - 修复不会删除历史、重放未知任务或破坏共享provider。
- Verification method:
  - 定向离线回归和真实provider复测。
- Validation evidence: 五类生产问题有修改前失败和修改后通过；coding-agent83 passed/10 real opt-in skipped、subagent143 passed、AI46 passed，共272离线通过。全slots资源busy不误杀、不poison；结束任务后可重新卸载。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 最终验收与限定提交

- Status: done
- Owner: coordinator
- Objective: 验证最终源码与生产测试，保留外部改动并正常提交。
- Inputs and prerequisites: T-003 的最终diff。
- Scope or files: 本轮owned文件、本文、相关测试/检查。
- Expected output: 提交、验证结果、资源策略判断和覆盖边界。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 运行完整check（必要时隔离检出，补入已有忽略的模型数据），回读状态与diff。
  2. 只提交本轮文件，清理本轮测试进程/临时数据，记录残余风险。
- Acceptance criteria:
  - 必需检查有真实结果；未泄漏凭据；外部dirty文件不变。
- Verification method:
  - 定向测试、npm run check、git show --check、任务文档validator。
- Validation evidence: 隔离完整npm run check通过；root/隔离12个源码和测试/协议文档逐字节一致；正常源码提交17c22201c并ff合入原工作区；git show --check与owned状态通过。外部LEARNS和4个TUI文件哈希未变化。任务validator通过；未build、安装或push。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先做定向离线回归，再运行 opt-in 真实SDK与source CLI。观察execution/load/residency、history/result、权限getter/subscriptions、背景任务与provider资源清理；资源测量必须等运行settled/cleanup，不从GC/RSS单点推断泄漏。异常包括创建失败、重入、取消、清理失败和恢复。最终完整check在不改写外部工作区的隔离检出执行。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

模型/provider不可用或并发限额是外部限制；不得自动重试未知效果。共享进程不能强制终止不协作的extension/native drain。历史有意保留，释放内存资源不等于删历史；不能将持久化留存误报为泄漏。没有真实屏幕/native mutation授权时不驱动外部应用副作用。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-10: 创建execute文档；T-001启动；用户已授权真实模型。当前源码 HEAD 8a3e591fd，外部dirty工作保持。
- 2026-10-10: T-001 done，T-002 in_progress。原真实委派用openai-codex/gpt-6-astra通过（15.31s）；新资源回归在故障代码2/2失败，真实16-child压力正在执行。原评测cleanup/wire修正，避免模型自行纠正旧协议及未等待team关闭。
- 2026-10-10: 真实16-child压力57.46s失败，实证background owner自动卸载杀掉sleep600。T-003启动；canUnload保护及incomplete drain报告已通过55项离线相关回归；真实修复后复测进行中。依赖图明确调整为从已证明基线交替验证/修复。
- 2026-10-10: wake缺陷先离线1→2调用及真实通知被消费复现，再固定child nextRequest；failed disposal提前释放owner先回归失败，再保护live owner；Codex元数据残留离线回归先失败再修复。所有修复保持已完成输出及无自动重放。
- 2026-10-10: 实验纠正：真实transport指标首次误用未配置Vitest source alias的API subpath，读到了另一份compiled模块的空map；改用明确source相对入口后真实指标创建/清除通过。全slots测试最初把stop请求当terminal，补wait确认settled后通过，没有削弱资源门。
- 2026-10-10: 最终真实lifecycle5/5（79.26s）；原真实SDK4/4（78.19s）；source CLI1/1（23.89s）。默认离线coding-agent83/subagent143/AI46全通过；10项真实测试默认跳过。T-002/T-003 done，T-004 in_progress。
- 2026-10-10: 隔离HEAD8a3e591fd检出仅复制owned文件和现有ignored模型JSON、链接依赖，完整npm run check通过（Biome1547无改写、pinned deps、TS imports、shrinkwrap/install-lock、全量tsgo、browser smoke）；未运行build或重写其它session材料。
- 2026-10-10: 正常限定源码提交17c22201c完成（12files），ff合入my-pi；root/检查文件逐字节一致，git show --check无owned诊断。T-004 done，Final passed，仍明确有限覆盖边界。本文单独docs提交，避免源码commit内自引用hash。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001～T-004均done；真实10场景通过、离线272通过/10 gated skipped、隔离完整check通过；源码提交17c22201c完成并回读，外部dirty文件未改变。
- Limitations: 不能声称穷尽所有潜在缺陷。未重建/安装compiled CLI，未进行物理Computer/native-app副作用验证或最大history/RSS/物理磁盘配额验收。
