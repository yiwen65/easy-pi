# Task Plan: Native subagent 落盘数据生命周期整改

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求“编写开发计划并实施，同时参考 best-practice 完成整改”。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 native collaboration 保留团队数据库、子会话 JSONL 和工具日志；close/unload/shutdown 释放运行资源但不删除历史。目标是提供明确、可审计、失败可重试的磁盘生命周期，避免父会话删除遗留团队，补齐统计、准入预算和可选冷团队/日志回收。实施只使用合成测试目录，不删除真实用户数据。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：native team 统计、安全整团队删除、父会话删除联动、托管工具日志、前台日志预算、可选自动 GC、全局配置与文档、定向回归。
- 保持 close_agent/ack/recovery 的历史保留语义；无自动任务重跑。
- 自动 GC 默认关闭；配置时间/容量限制必须显式启用。未消费消息、未完成/中断工作、活跃 owner、不可验证目录受保护。人工删除需要明确确认和影响提示。
- 工作区、artifact 引用、旧 DAG/worktree 数据、无法证明归属的旧 OS 临时日志不删除。
- 冷历史压缩与跨 child 去重延期：目前没有收益测量，不为清理引入额外恢复格式。
- 不运行真实 API、不执行 build/npm test/完整 vitest，不更改依赖。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | native team 使用 agentDir/teams/rootSessionId/registry.sqlite，child JSONL 位于 child UUID 子目录 | packages/coding-agent/src/extensions/pi-collaboration-root.ts:26-37; packages/subagent/src/collaboration-controller.ts:854-884 |
| F-002 | close/卸载/shutdown 不删除持久历史；store.close 仅释放 owner | collaboration-controller.ts:834-851,1079-1174; collaboration-store.ts:954-965 |
| F-003 | /resume 删除仅 trash/unlink 单个 session 文件，不级联团队 | packages/coding-agent/src/modes/interactive/components/session-selector.ts:645-680,832-856 |
| F-004 | compaction 为 append，不缩小 JSONL | packages/coding-agent/src/core/session-manager.ts:1264-1338,1386-1425 |
| F-005 | 前台输出无磁盘预算；后台每文件默认64MiB；正常结束仅关流 | core/tools/output-accumulator.ts; packages/agent/src/harness/env/background-task-manager.ts:357-410,543-631 |
| F-006 | 当前仅导出 native collaboration，旧 delivery-cleanup 不属产品入口 | packages/subagent/package.json; packages/subagent/src/index.ts; extensions/easy-pi.ts |
| F-007 | 开始工作时 git 工作区干净，HEAD 4bce19e82 | git status --short; git rev-parse --short HEAD |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用户授权实施上轮整改建议，但不授权删除已有真实数据；验证仅用临时合成目录。
- Assumption: JSON 配置和 /agents 操作入口足以覆盖第一版，不新建独立守护进程或模型可调用删除工具。
- Assumption: 容量预算是新任务准入保护，不承诺对已运行推理/文件写入的硬磁盘配额；不能截断已提交历史。
- Open question: 无阻塞问题；保留天数/容量默认不启用，部署者根据统计显式配置。压缩需未来测量后另行授权。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 可以统计 team 数据及可清理/受保护状态；损坏或身份不明数据不能被当作空团队删除。
- 显式删除拒绝活跃 owner，验证路径/身份/符号链接；隔离后的中断删除可安全重试，不会被自动重建成空团队。
- /resume 删除有团队关联的父会话时明确选择整组删除或保留团队，不静默遗留。
- close/ack/recovery 与现有结果查询保持历史保留契约。
- 新工具日志归属可验证；前台/后台单文件写入均有预算；过期回收保护活跃 writer，不扫描删除旧未知临时日志。
- 可选 GC 默认关闭，仅处理可验证、无待收信、无未完成工作且符合保留策略的冷团队/日志；不触碰工作区。
- 原有4096 turn/2048 retained agent限制保持；新增字节预算只拒绝新任务，既有查询/关闭可用。
- 定向测试、npm run check、计划校验通过；本次改动单独提交。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-005 -> T-003; T-001 + T-002 + T-003 -> T-004。T-003以已发布并通过定向测试的稳定API检查点为输入；内核最终修正与不重叠接线可并行，整体验收等待三者完成。
- Parallel batches: 第一批 T-001 团队存储、T-002 工具日志，文件所有权互斥；第二批 T-003 协调者串行接线；第三批 T-004 验证与独立审查。
- Serialization constraints: 计划文档、settings-manager、根操作命令/会话选择器、文档由 coordinator 独占；T-001 独占 subagent 存储维护模块/contract/controller/store/package exports/产品打包清单；T-002 独占日志模块/bash/output-accumulator/agent-session/background-task-manager。更改公共API先发回声明，避免重叠。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 团队存储统计与安全删除

- Status: done
- Owner: coordinator -> /root/team-storage
- Objective: 实现身份/owner保护的团队统计、整组隔离删除和可选GC候选策略，以及原store防止待删除团队重开。
- Inputs and prerequisites: F-001,F-002,F-006；安全默认及不触碰真实数据契约。
- Scope or files: packages/subagent/src/collaboration-storage*.ts、collaboration-store.ts、collaboration-controller.ts、对应测试、package exports、scripts/build-easy-pi-product.mjs。
- Expected output: 可复用存储维护API、删除保护与故障恢复测试、只对新任务的可选准入检查挂点。
- Dependencies: None.
- Execution steps:
  1. 完整读取有关源码与测试，定义最小维护API。
  2. 实现统计/保护/隔离删除及默认无副作用的候选计算。
  3. 用临时合成团队验证并交付API和差异。
- Acceptance criteria:
  - 活跃/竞态owner、篡改路径/符号链接/未知文件和中断删除不会误删；待删除状态不会变空团队。
- Verification method:
  - packages/subagent 下定向 vitest。
- Validation evidence: 子任务7文件209测试通过；coordinator重跑storage/history/controller 3文件101测试通过。复审修掉合法历史总量>16MiB永久阻断，新增256x64KiB fixture后storage 32测试通过；npm run check、git diff --check通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 托管日志与写入预算

- Status: done
- Owner: coordinator -> /root/tool-log-storage
- Objective: 为内置前台/后台bash提供可验证归属的托管日志和安全回收API，限制前台完整日志写入。
- Inputs and prerequisites: F-005；保持工具preview与生命周期语义。
- Scope or files: coding-agent/src/core/tool-output-storage*.ts、core/tools/bash.ts、output-accumulator.ts、agent-session.ts、core/bash-executor.ts；packages/agent/src/harness/env/background-task-manager.ts及对应测试。
- Expected output: 原生会话日志归属、活跃writer保护、TTL/容量回收API、前台日志预算和回归。
- Dependencies: None.
- Execution steps:
  1. 读取调用链并给协调者说明最小配置API。
  2. 接线托管目录与单文件预算；独立函数回收过期/容量候选。
  3. 定向验证；不清理已有未知临时日志。
- Acceptance criteria:
  - 日志受预算保护；活跃writer不被回收；普通完成/关闭不会无提示删除结果。
- Verification method:
  - coding-agent与agent包相关定向 vitest。
- Validation evidence: 子任务coding-agent定向131通过/2平台跳过，日志新增2文件最终23测试通过；agent 5文件47测试通过（含promotion factory/stream故障回收）。coordinator集成批次中日志测试通过；npm run check与diff审查通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 操作入口、配置与级联接线

- Status: done
- Owner: coordinator
- Objective: 集成 /agents 存储管理、可选启动GC/准入预算、/resume明确删除范围和用户文档。
- Inputs and prerequisites: T-001/T-002已发布且初轮定向验证通过的维护API签名；T-005全局配置完成。API变更必须协调者确认；内核最终修复不改接线所有权。
- Scope or files: coding-agent extensions/pi-collaboration-root.ts及新操作模块、core/settings-manager.ts、session-selector/cli/session-picker及相应集成、docs/collaboration.md、docs/settings.md。当前分支my-pi，依AGENTS不改CHANGELOG。
- Expected output: 默认只读盘点/显式确认删除、默认关闭GC、根会话联动和准确文档。
- Dependencies: T-005.
- Execution steps:
  1. 配置解析严格校验，自动操作默认关闭。
  2. 接线维护API及新任务容量保护；明确parent删除选项。
  3. 补操作入口/集成测试与文档。
- Acceptance criteria:
  - 未确认不删除；无UI不隐式确认；关闭/查询在容量满时仍可用；删除失败可检查重试。
- Verification method:
  - 定向coding-agent集成/selector/config测试；静态diff审查。
- Validation evidence: coordinator root/storage/selector新集成3文件16测试通过；已有selector/config/log批次均通过。首次整合暴露测试只等一次setImmediate的异步unlink竞态，改为等待可观察删除与恢复列表后通过；npm run check通过且自动格式化仅本次文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 对抗审查、验证与提交

- Status: done
- Owner: coordinator
- Objective: 检查删除竞态、历史契约和日志保护；完成项目检查和独立审查后提交。
- Inputs and prerequisites: T-003完成；所有实现差异。
- Scope or files: 本次全部差异与测试、此计划。
- Expected output: 定向测试/npm run check/独立审查记录、单独git提交。
- Dependencies: T-001,T-002,T-003.
- Execution steps:
  1. 独立只读审查实际差异，修复证据明确的问题。
  2. 运行定向回归与npm run check，核对自动格式化范围。
  3. 校验计划、仅stage本次文件、提交。
- Acceptance criteria:
  - 所有必要验证通过、无未解决高风险删除问题，无真实数据破坏。
- Verification method:
  - 定向vitest、npm run check、git diff --check、task_document.py validate。
- Validation evidence: 最终717项定向测试通过、2平台跳过（见下方最终矩阵）；npm run check全链路exit0、source-resolver6/6、diff检查通过；独立审查的1项P1及后续P2已修复并加永久回归。git commit -m "feat(coding-agent): manage native subagent storage lifecycle" 已成功，仅包含本次43文件；计划完成状态随后纳入同一实现提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 全局保留配置解析

- Status: done
- Owner: coordinator
- Objective: 独立实现严格校验、global-only且默认关闭的存储策略，供后续集成使用。
- Inputs and prerequisites: F-001,F-005；计划中的安全默认。
- Scope or files: coding-agent/src/core/subagent-storage-policy.ts、settings-manager.ts、相应定向测试。
- Expected output: subagentStorage配置与纯解析器；项目设置/临时override不能启用破坏性GC。
- Dependencies: None.
- Execution steps:
  1. 完整读settings-manager，新增最小类型和getter。
  2. 验证默认、非法值、global-only优先级与detached结果。
- Acceptance criteria:
  - 未配置不回收；非法类型/负数/溢出拒绝；项目不能越权。
- Verification method:
  - 定向settings/parser vitest。
- Validation evidence: 2026-10-18 coding-agent包根执行 node ../../node_modules/vitest/dist/cli.js --run test/subagent-storage-policy.test.ts，1文件16测试通过；验证默认禁用、严格类型/溢出、global-only与detached结果。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 独立审查发现的生命周期与集成回归

- Status: done
- Owner: coordinator + /root/tool-log-storage
- Objective: 修复审查发现的活跃原地续开child保护、合法含点session ID、自定义agentDir传递及日志发现不完整低报。
- Inputs and prerequisites: T-001/T-002/T-003实现；两名隔离只读reviewer的源码证据。
- Scope or files: T-002日志owned文件/AgentSession/SessionManager及必要SDK接线；interactive-mode/session-picker传递agentDir；discovery与相应回归；subagent存储完成墓碑压缩/合法大库检查；product验收清单与source-resolver测试。协调者独占UI/计划，日志agent独占lease生命周期及SessionManager删除前置保护，team-storage独占完成墓碑修正。
- Expected output: 无Bash也保护被直接续开的child JSONL，lease与tombstone握手防竞态，合法ID与自定义目录保持可用，未知日志不被当作完整总量。
- Dependencies: T-001,T-002,T-003.
- Execution steps:
  1. 源码追踪复核review finding，补合成faux回归。
  2. 建立持久会话生命周期保护并验证启动/退出/删除竞态；修复ID及实际agentDir接线。
  3. 重跑定向验证并请reviewer复核关键补丁。
- Acceptance criteria:
  - 当前打开的child在同进程/跨进程team维护中受保护；不删除活跃JSONL。
  - 含点合法ID仍可执行后台/大输出bash；非默认agentDir删除范围正确。
  - SessionManager在首次mkdir/初始化header前拒绝已删除/隔离native历史；不能先重建空目录再由AgentSession拒绝。
- Verification method:
  - faux/session、storage、selector定向测试，独立只读复核，npm run check。
- Validation evidence: 独立review发现均经源码/红测复核；真实SDK无Bash/跨Node进程/foreign源/含点ID/启动失败租约等14项通过；SessionManager新增16项覆盖前置拒绝与mkdir后rename空目录清理，旧实现对应红测。coordinator最终coding-agent28文件451通过/2平台跳过，subagent7文件213通过，agent5文件47通过，source-resolver6通过；npm run check(1562文件，无自动修改)、git diff --check通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

### 最终执行矩阵（均已实际完成）

- coding-agent包根，canonical `TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)"` 后运行 `node ../../node_modules/vitest/dist/cli.js --run`，目标：`test/subagent-storage-policy.test.ts test/settings-manager.test.ts test/session-manager test/session-team-deletion.test.ts test/session-selector-path-delete.test.ts test/interactive-session-storage-wiring.test.ts test/pi-collaboration-storage.test.ts test/pi-collaboration-root.test.ts test/tool-output-storage.test.ts test/suite/tool-output-storage-session.test.ts test/suite/tool-output-storage-lifecycle.test.ts test/pi-child-session-host.test.ts test/pi-child-session-lifecycle.test.ts test/pi-collaboration-tools.test.ts test/bash-tool-contract.test.ts test/background-task-wiring.test.ts test/tools.test.ts test/bash-close-hang-windows.test.ts test/suite/agent-session-prepare-request.test.ts test/agent-session-dynamic-tools.test.ts`。28文件中27通过/1平台跳过，451测试通过/2 Windows专用跳过。
- subagent包根，同一vitest入口，目标：`test/collaboration-storage.test.ts test/collaboration-history-store.test.ts test/collaboration-controller.test.ts test/collaboration-contract.test.ts test/collaboration-progress.test.ts test/collaboration-targeted-wait.test.ts test/collaboration-lifecycle.test.ts`。7文件213测试通过。
- agent包根，同一vitest入口，目标：`test/harness/background-task-log-admission.test.ts test/harness/background-task-manager.test.ts test/harness/background-task-lifecycle-regression.test.ts test/harness/background-task-tools.test.ts test/harness/background-wait-cancellation.test.ts`。5文件47测试通过。
- 根目录 `npm run check && node --test scripts/source-resolver.test.mjs && git diff --check`：全部exit0；Biome 1562文件无修改；pinned deps/imports/shrinkwrap/install-lock/tsc/browser-smoke通过；source-resolver6测试通过。合计717测试通过，2平台跳过，不是全套测试。
- 首次邻接SessionManager批次有4项macOS `/var` vs `/private/var`路径断言失败；使用canonical TMPDIR后通过，未改无关产品路径语义/测试断言。另两项fixture同步拒绝与.rejects不匹配，改async helper以保留严格拒绝断言。

- 只用mkdtemp合成session/team/log；伪provider，不调用真实API。
- 核心边界：live/dead owner与PID复用；获取owner与删除竞争；符号链接/未知文件/身份不符；隔离中断后重试；待收信/中断任务的自动GC保护；未启用无删除；预算满只拒绝新任务；root-only与cascade选择；日志TTL/容量/活跃保护/写入截断。
- 执行命令遵守AGENTS：包根 node <repo>/node_modules/vitest/dist/cli.js --run <specific files>；不运行全套或build。
- npm run check 会改写文件，完成后核对git diff并修复；子任务不能提交，最终协调者统一提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 磁盘删除不可逆：默认关闭自动清理，显式确认，隔离+可重试，严格验证归属，禁止artifact路径递归删除。
- 跨SQLite/JSONL无事务：删除标记必须先阻止重新获取，再隔离/清除，不声称跨文件原子操作。
- 实际运行中历史可超过准入阈值：如实说明不是硬磁盘quota，不截断历史。
- 共享worktree并发：按任务文件所有权分工，仅coordinator写计划/提交。
- 实际安装dist与源码可能不同：本轮未授权build，不将源码测试称为已安装版本验收。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18: 用户授权计划并实施；读取best-practice与计划skill，重新确认工作区干净。
- 2026-10-18: 计划建立；T-001/T-002进入in_progress，派发team-storage/tool-log-storage互斥子任务；协调者保留配置/UI/计划所有权。
- 2026-10-18: 将独立配置工作显式拆出T-005，与第一批并行；T-003接线等待全部API与配置验证。
- 2026-10-18: T-005实现并定向16测试通过，标记done。T-002新增发现内置用户bash另一路落盘，批准纳入core/bash-executor.ts与测试（仍由日志agent独占）。
- 2026-10-18: T-005与既有settings-manager组合回归72测试通过。确认分支my-pi，按仓库规则不改CHANGELOG。
- 2026-10-18: T-001/T-002稳定API与初轮测试已交付，确认T-003文件互斥且接口可用，进入接线；调整DAG使最终整体验证等待全部内核与接线。T-001补合法大团队统计边界，T-002补promotion日志失败资源回收，均保持已发布API。
- 2026-10-18: 接受并复核T-001/T-002；完成T-003操作命令、/resume明确范围、启动GC与预算接线，默认不删除。首轮npm run check通过，修正测试异步等待而非产品逻辑；T-001/T-002/T-003标记done，T-004进入独立审查与最终回归。
- 2026-10-18: 两名隔离reviewer发现1项P1原地续开child无生命周期保护、2项P2合法含点ID与自定义agentDir接线；协调自审发现日志discovery低报。新增T-006统一修复，T-004最终done gate等待T-006验收；未将首轮测试通过当作整体完成。
- 2026-10-18: T-006补充已验证边界：完成墓碑原子压缩避免默认scan预算永久溢出；去除低于原契约的物理DB512MiB硬拒绝，改有限行探测；retry重新核验live lease；SDK memory日志纳入托管发现。自定义agentDir生产接线回归red->green；source resolver 6测试通过；最新subagent7文件211测试通过。
- 2026-10-18: 协调者最终批次coding-agent318通过/2平台跳过、subagent213通过、agent47通过。新隔离reviewer发现保护仍晚于SessionManager.open的mkdir/header初始化，追加T-006前置文件操作保护与缺失native禁止重建回归；此问题修复前不提交/不宣称passed。
- 2026-10-18: 连续review确认前置保护关闭原P2，补充mkdir成功后rename的空目录恢复窗口；inode约束清理通过空/非空两条红绿回归。coordinator复核并运行最终28文件coding-agent矩阵451通过/2平台跳过；与core/log/node测试合计717通过，npm run check全链路通过。T-006标记done，T-004待提交。记录一条持久生命周期保护经验到LEARNS.md；未改其他历史条目。
- 2026-10-18: 已核对43文件全部为本次所有权范围，git commit成功。T-004与整体标记done；仅补此完成记录并纳入同一提交，不再修改已验证代码。自动GC仍默认关闭，真实用户数据未清理。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001至T-006全部done；717项定向测试通过/2平台跳过，npm run check、source-resolver、diff与计划校验通过；实现已提交，本次无阻塞任务。
- Limitations: 未运行真实provider、完整suite、安装产物build或Windows实机验证；未清理真实用户数据。准入预算不是硬磁盘quota，未知/新出现的数据保护并要求检查；冷历史压缩明确延期。
