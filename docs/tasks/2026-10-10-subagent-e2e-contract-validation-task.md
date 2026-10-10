# Task Plan: Subagent 第一性原理端到端契约验证与修复

- Created: 2026-10-10
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求从subagent第一性原理设计真实模型端到端测试、发现各方面问题并修复；默认gpt-6.1-sol medium。

<!-- task-doc-section:background-goal -->
## Background and goal

Subagent 是根会话授予有限任务、上下文和能力的独立执行者。根控制器负责准入与生命周期，子会话负责执行与报告，持久化记录负责恢复和可查证性。测试必须验证这些边界的行为和效果，而不把模型的自然语言声明当作执行证明。实现并执行可复用端到端测试，修复复现的缺陷，明确有限覆盖。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

目标仅pi/原生collaboration协议/controller/store、coding-agent adapter/host/context/recovery及相关测试文档。已授权真实模型、测试隔离状态、最小修复和正常限定提交。实际入口pi-test.sh --mode rpc；SDK用于细粒度故障/动态权限补充，不能替代CLI证据。只引用现有认证，不复制或输出凭据。不修改真实用户team/session，不build/安装/push，不清理其它会话TUI/LEARNS/candidate工作。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 基线my-pi HEAD7d76539456c4e87c565fba3cf8f54bd5b1ed7283 | 当前git readback |
| F-002 | 默认真实测试必须为gpt-6.1-sol medium，root和child均适用 | AGENTS.md Commands；上轮用户规则 |
| F-003 | 现有3个真实测试仍写死旧模型/low，不能直接继承运行 | subagent-real-provider/lifecycle/cli-real-provider.test.ts |
| F-004 | isolated/curated/fork明确上下文选择，能力只能收窄，结果查询不执行 | pi-collaboration-tools.ts/context.ts；collaboration-contract.ts |
| F-005 | 基线fresh-child拒绝和explicit team-tool委派拒绝位于持久化准入前，但抛generic CollaborationError | 后续确定性与真实CLI证明错误产生unknown effects；已在3个throw点修复 |
| F-006 | 上轮生命周期已有真实验证和5类修复，但没有穷尽上下文、权限、失败恢复各维度 | docs/tasks/2026-10-10-subagent-lifecycle-real-validation-task.md；不把旧模型结果计入本轮 |
| F-007 | 本轮真实root/child默认gpt-6.1-sol medium，CLI state/child metadata通过readback | subagent-e2e-harness.ts launch配置断言；E2E context测试child.model断言 |
| F-008 | 最终7个CLI契约、5个生命周期、4个原SDK、1个CLI smoke真实通过 | 各定向真实文件最新工具输出；共17场景 |

### 最终契约证据

| 契约 | 最终证据 |
| --- | --- |
| I-01/I-04 | 真实CLI isolated/curated子JSONL无root canary；curated只含所选range且无外部line canary，fork含有效root背景但仅做当前任务；curated hash拒绝没有任何child/turn |
| I-02 | child先真实bash输出ready，再通过公开扩展API撤销root bash/write；child实际write调用被拒绝且forbidden.txt不存在，outcome partial；精确越权/权限门由已有定向回归补边界 |
| I-03 | 实际模型调用fresh-reviewer错误请求；修改前没有新增turn却写needs_reconciliation；修改后turn仍1、角色仍continue、未知状态0。确定性新增nested spawn/followup、reviewer/explorer共4变体通过；既有uncertain commit回归保持通过 |
| I-05 | passive send后child JSONL逐条不变且turn仍1；explicit followup后消息ID恰好入场1次，turn2；pinned wait仍返回FIRST_READY及旧turn ID；close/resume /agents没有agent_start |
| I-06 | Unicode结果格式valid且bytes≤8192；真实bash exit7仅调用一次，结果outcome failed但执行turn completed，未被错误挂成未知效果；精确超限/invalid envelope已有确定性回归 |
| I-07 | 同cwd两个真实CLI独立session/team，第二root访问第一root独有child被拒绝；第一snapshot未变；生命周期真实并发4children、pressure16/17 native detach及transport metadata关闭通过 |
| I-08 | 实际bash文件effect出现且child仍running时SIGKILL测试process group；恢复后interrupted、completionPending false，/agents零推理、effect bytes不变、turn仍1；正常EOF退出owner=NULL |

### 可复用命令

从packages/coding-agent运行：

```bash
PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run test/subagent-e2e-real-provider.test.ts --silent=false
PI_REAL_MODEL_EVAL=1 node ../../node_modules/vitest/dist/cli.js --run test/subagent-lifecycle-real-provider.test.ts --silent=false
```

默认真实模型统一由subagent-real-config.ts提供；model/effort显式override独立生效，非法effort在调用前拒绝。普通运行四个真实测试文件默认全部skip，不隐式启用网络。CLI harness先确认请求模型与effort，再确认accepted→provider终态→工具→持久化/效果，清理process group和临时状态。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: existing openai-codex认证支持gpt-6.1-sol；先从现有目录/真实响应确认，不能自动换模型。
- Open question: 无阻塞决定；测试使用合成canary/临时文件和有界场景，异常效果未知时保留记录、不重放。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 从不变量推导测试矩阵，每一维给出行为oracle、证据和适合的验证层。
- 真实CLI的root/child均使用gpt-6.1-sol medium，有持久化model/effort readback；默认非opt-in运行不会访问API。
- 上下文隔离/curated/fork、工具权限、消息与结果、负面准入、失败结果、并发/配额、取消/关闭/恢复各有端到端或有因果证据的确定性覆盖。
- 修复需要修改前失败、修改后通过；不把测试fixture、模型未执行测试动作或外部服务限制误判为产品bug。
- 保留未知效果保护、历史和其它会话改动；完整check及限定提交通过，不能承诺穷尽所有问题。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001→T-002；T-001→T-003；T-002/T-003→T-004。已证明失败允许交替实测/修复，T-004最终验证必须通过。
- Parallel batches: 无；共享CLI harness/测试/协议接线，协调者串行执行，独立只读查询可以并发。
- Serialization constraints: 本轮owned文件和authority文档由协调者维护；共享工作区外部变更保持。

### 第一性原理测试矩阵

| 不变量 | 潜在破坏 | 验证与oracle |
| --- | --- | --- |
| I-01 有限任务/当前身份 | fork携带root旧目标、模型误当root或越出任务 | CLI isolated/curated/fork child原始有效消息、任务身份、合成canary、明确产物 |
| I-02 最小能力/实时收窄 | 只隐藏schema而执行未拦截，child可nested delegate、followup可扩权 | 真实模型受限任务；SDK动态收窄/确定性强制调用；文件未写、门错误、无新增turn |
| I-03 准入原子性 | 重名/越权/角色不独立等无效果拒绝变成unknown，污染根恢复 | CLI负面调用及journal/readback；确定性重现not_started、agent/turn不增、unknownTools=0 |
| I-04 上下文语义 | isolated泄露根canary，curated越range/hash失效，followup误称fresh | child原始消息与文件hash/range，explicit roles；已有prefix/compaction离线回归补边界 |
| I-05 通信不等于执行 | idle send启动推理、丢信/重复投递、query变补跑、wait选错turn | CLI passive message→followup、pinned ID、结果历史/ack；观察新assistant/turn及消息ID |
| I-06 完成不等于验收 | outcome failed被当成功，非ASCII/格式错误/预算被静默丢弃 | 真实失败任务报告/Unicode结果；format/outcome/execution分开，确定性预算负例 |
| I-07 身份/共享资源独立 | 两root同cwd串team、provider关闭影响root、配额/卸载误杀 | 双CLI root隔离、source owner readback；已有生命周期压力/权限/cleanup回归及默认模型复测 |
| I-08 取消/恢复不重放 | kill后原task自动重跑、persisted effect重复、正常退出漏owner | CLI未完成child crash→恢复；effect append次数/retained状态、owner及零推理查询；明确不是unknown效果自动重试 |

真实模型负责真实请求、工具选择、执行/结果链；权限强制绕过、存储故障和精确竞态用确定性回归证明运行时门，避免把“模型没尝试”当安全通过。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 契约设计与生产路径审计

- Status: done
- Owner: coordinator
- Objective: 明确上述不变量和端到端证据源。
- Inputs and prerequisites: AGENTS、当前源码、已有真实/离线测试、上轮报告。
- Scope or files: collaboration tools/controller/context/store/host/recovery及测试。
- Expected output: 本文矩阵和可执行场景，假设不冒充已证实bug。
- Dependencies: None.
- Execution steps:
  1. 审查关键路径并记录基线，按公开CLI/SDK边界制定oracle。
- Acceptance criteria:
  - 各测试维度明确证据/负例/覆盖边界。
- Verification method:
  - 源码对照与任务validator。
- Validation evidence: I-01～I-08已映射生产工具/上下文/controller/journal及CLI/SDK/确定性oracle；当前协议与关键路径已审查，validator通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 真实端到端基线与默认模型落地

- Status: done
- Owner: coordinator
- Objective: 创建可复用门控CLI harness与契约场景，实测故障基线。
- Inputs and prerequisites: T-001；现有认证；PI_REAL_MODEL_EVAL=1。
- Scope or files: 现有真实测试默认模型、共享测试配置/CLI harness、subagent-e2e-real-provider.test.ts。
- Expected output: 模型/effort、CLI及持久化证据、通过/失败/未触发的真实分类。
- Dependencies: T-001.
- Execution steps:
  1. 统一默认模型和medium，检查可用性；保持offline门控。
  2. 分场景有界执行，收集磁盘效果、模型/工具/turn事件及恢复journal。
- Acceptance criteria:
  - 每个基线有实际执行路径与oracle；拒绝后不得按模型说法断言成功。
- Verification method:
  - 定向opt-in真实测试，临时隔离session；状态及效果readback。
- Validation evidence: 配置default/override回归通过；真实CLI baseline1/1（29.26s）；新增E2E基线fresh拒绝57.37s失败且磁盘turn不增，满足真实故障oracle；其余场景及最终完整E2E7/7（246.85s）通过，原生命周期5/5（100.15s）及SDK4/4（77.54s）均使用新默认。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 已证明缺陷的最小修复

- Status: done
- Owner: coordinator
- Objective: 修复基线证明的因果缺陷并建立稳定回归。
- Inputs and prerequisites: T-002失败证据/重现。
- Scope or files: 对应协议/controller/adapter/recovery源与必要测试。
- Expected output: 修改前失败/修改后通过及原始真实场景复测。
- Dependencies: T-001.
- Execution steps:
  1. 最低稳定边界编码失败，修复首次坏状态，不放宽未知效果门。
  2. 检查邻近路径和实际root恢复状态，保留scope。
- Acceptance criteria:
  - 不重放/丢弃未知工作，不删历史，不扩大child权限。
- Verification method:
  - 定向离线回归及真实CLI失败场景复测。
- Validation evidence: 已证明“准入前无效果拒绝被当unknown”的一类产品缺陷；3个throw改AdmissionError，nested spawn/followup及fresh reviewer/explorer4变体通过，真实原fresh场景通过；现有commit uncertainty测试仍通过。未用catch-all或自动retry放宽保护。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 最终真实验证、完整检查与提交

- Status: done
- Owner: coordinator
- Objective: 验证最终契约/修复并形成可复用测试与证据。
- Inputs and prerequisites: T-003最终owned diff。
- Scope or files: 本轮测试与修复、协议说明、本文。
- Expected output: 真实与离线结果、检查、限定提交及剩余边界。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 运行必要最终真实/离线场景，完整check在隔离检出进行。
  2. 审查diff、正常限定提交、回读资源与外部文件，清理本轮测试。
- Acceptance criteria:
  - 必需检查通过；真实进程/测试会话已关闭；外部dirty工作未改变。
- Verification method:
  - 实际CLI/provider及持久化状态、npm run check、git show --check、document validator。
- Validation evidence: 真实17场景、离线231 passed/17 gated skipped、隔离完整check及validator通过；10个源码/测试/协议文档与checked副本逐字节一致；正常源码提交aee5b7c59并ff合入my-pi；git show --check与owned状态通过，外部5文件hash保持。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

显式opt-in定向文件；模型gpt-6.1-sol medium、provider沿用现有openai-codex。新CLI场景与旧生命周期互补，不无限重复。模型遵循不足、服务不可用和runtime缺陷分开。边界/竞态精确断言用faux或fixture，不把静态/SDK测试称为真实CLI。临时auth只引用既有来源，不打印/复制值。全量检查不改写共享工作区。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

有限测试不能证明所有潜在缺陷已消除。LLM负例可能不触发需测动作，需要检测触发并用确定性回归区分。shared cwd不是OS隔离；只测试合成文件/指令，不主动接触外部应用或敏感状态。存储/进程死后效果未知必须保留恢复边界；不要用自动重试掩盖。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-10: 用户授权execute与真实模型；按新规则默认gpt-6.1-sol medium。创建唯一新authority文档，T-001启动；HEAD7d7653945，外部dirty TUI/LEARNS保持。
- 2026-10-10: T-001 done，T-002 in_progress；8条契约已明确。统一3个原真实测试的配置来源为gpt-6.1-sol medium，新增独立override/default回归；开始CLI harness/负面准入基线。
- 2026-10-10: 默认配置1/1与真实source CLI1/1通过（29.26s）。确定性nested/fresh拒绝2/2失败；真实fresh-reviewer负面场景57.37s失败：turn仍为1、原角色仍continue，却写入needs_reconciliation。T-003启动，对3个持久化准入前拒绝改为CollaborationAdmissionError；持久化之后未知效果路径保持。图调整为交替执行，T-002其余真实场景继续验证。
- 2026-10-10: 已修复分类，新增4变体及相关工具/config回归共38通过。初轮6个真实E2E有5通过，passive场景初始root没有创建child，原测试没有保留足够终态证据，原因未确定；不是已证实产品bug。加强harness provider终态/实际工具判定、初始指令明确执行，单场68.05s及最终全套7/7均通过；不把一次重测通过当根因证明或零flakiness保证。
- 2026-10-10: 实时撤权单场29.33s通过。最终E2E7/7（246.85s）、lifecycle5/5（100.15s）、原SDK4/4（77.54s）、CLI smoke1/1（29.26s），真实17场景使用gpt-6.1-sol medium。默认离线coding-agent88 passed/17 gated skipped、subagent143 passed，共231通过。
- 2026-10-10: T-002/T-003 done，T-004 in_progress。隔离检出7d7653945，只拷owned文件+现有ignored模型JSON，完整npm run check通过（Biome1552无改写、pinned deps、TS imports、shrinkwrap/install-lock、全量tsgo、browser smoke）；共享工作区外部改动保留。
- 2026-10-10: 源码及测试/协议文档10files正常提交aee5b7c59，ff合入my-pi；root与checked代码逐字节一致，show --check通过，owned工作区干净，外部TUI/LEARNS与测试文件5项hash未变。T-004 done，本文单独docs提交；未build/安装/push。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001～T-004均done；真实17场景、离线231项/17 gated skip、隔离完整check通过；源码aee5b7c59已提交并回读；authority validator通过。
- Limitations: 有限测试不证明穷尽/长期稳定性；首次passive未触发原因未确定，最终单场及全套通过。未做真实Computer/native-app副作用、长期soak、最大payload/RSS/物理磁盘配额、全provider故障矩阵或已安装binary验收；shared cwd不是OS隔离。
