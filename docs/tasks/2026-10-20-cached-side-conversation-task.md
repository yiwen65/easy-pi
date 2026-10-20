# Task Plan: 缓存复用旁聊 /side 与 /btw

- Created: 2026-10-20
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户确认缓存优先方案后，明确要求编写开发计划并实施、完成交付。

<!-- task-doc-section:background-goal -->
## Background and goal

提供 /side 与 /btw 临时旁聊。主会话运行不中断，旁聊使用独立内存会话。保留父 provider 请求前缀及缓存路由，不把共享 key 当作命中证明；关闭后等待旁聊资源清理，不删除父数据。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：请求前缀捕获与兼容检查、内存旁聊控制器、只读执行边界、聚焦旁聊面板、命令接线、可配置按键、离线回归、文档与提交。
非目标：真实付费 provider 请求、服务端 KV 操作、命中率保证、旁聊写入工作区、旁聊子代理、持久化旁聊和自动合并回答。Bash/MCP 等不受信任可变工具保留声明但不能执行；本地内建只读工具及受限 codemode 可执行。严格 replay 首版仅接受已本地 wire 验证的 openai-responses/openai-codex-responses 文本前缀；图片前缀与 Anthropic 等未验证 API 明确拒绝，避免图片投影泄露或缓存标记移动后误称原样复用。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 /fork 关闭原 runtime，不适用于并存旁聊。 | core/agent-session-runtime.ts:187,289 |
| F-002 | 内存 SessionManager 不生成 JSONL；createSessionView 隔离 provider 注册表。 | core/session-manager.ts:2325；core/model-runtime.ts:243 |
| F-003 | 现有 native prefix observer 捕获实际 neutral provider context 并验证规则、工具和分支。 | extensions/pi-collaboration-context.ts |
| F-004 | Codex 已分离缓存 key/affinity 与 session/request 身份，cache-affine 路径强制 SSE。 | packages/ai/src/api/openai-codex-responses.ts:272-315,1680 |
| F-005 | AgentSession.shutdown 可等待并返回 complete；dispose 不提供清理确认。 | core/agent-session.ts:1685-1748 |
| F-006 | 工具日志即使内存会话也可能落盘，close 不默认删除日志。 | core/tool-output-storage.ts:246,339 |
| F-007 | 执行基线 2f85ccfdd，已有他人 AI provider/CHANGELOG/测试改动，禁止纳入本次提交。 | git status --short，2026-10-20 |

以上 core/ 与 extensions/ 路径均相对 packages/coding-agent/src/。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 首版 TUI 聚焦浮层，一个主会话最多一个可复用旁聊；回答完成保留，隐藏不销毁，显式关闭或父 shutdown 才销毁。
- Assumption: 继承父模型、推理及服务档位；精确前缀不可验证时拒绝，不静默重建。真实 cacheRead 仅显示服务端 usage，不以离线值声称真实命中。
- Open question: 无阻塞决策；真实服务端验证不在授权范围，作为明确交付限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- /side 与 /btw 可在主模型运行期间启动/打开旁聊，不向父 transcript 提交问题。
- 旁聊独立 session ID、内存 manager 与 model runtime view；不生成会话文件或 team registry。
- 首个旁聊最终 provider body 保留父 instructions/tools/message 前缀；Codex 缓存亲和/key 一致，原生身份独立且 SSE。
- 不加入旁聊协议工具；危险声明保留但执行在副作用之前拒绝。codemode 不得绕过执行限制或扩大父授权。
- 缺少快照、规则/工具/模型/压缩或 payload hook 不兼容时明确拒绝；普通同分支 append 不误判为不兼容。
- 面板具备追问、流式显示、隐藏、取消、关闭与父状态提示；释放 UI 不等于关闭 session。
- 创建中关闭、运行中关闭、重复关闭、父 shutdown 清理有离线覆盖；清理不完整有明确报告。
- 所有新增/修改测试定向通过，npm run check 全输出通过，变更仅包含本任务文件并提交。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> {T-002,T-003,T-004,T-008}; {T-002,T-003,T-004,T-008} -> T-005; {T-005,T-007} -> T-006.
- Parallel batches: T-002 前缀、T-003 UI 与 T-004 宿主均使用 T-001 与委派时固定的 API，可并行实现；T-005 才集成并验收全部依赖。
- Serialization constraints: T-002 独占 side-conversation-prefix.ts 及其测试；T-003 独占新面板、入口扩展、keybindings.ts、extensions/index.ts 及相应测试；协调器独占控制器、类型接口、计划、用户文档与 changelog。共享文件不得交叉修改。宿主无原子 DAG 工具，使用可用 spawn_agent 为两个边界明确任务启动并行 child turns；不虚构 DAG 接口。计划仅协调器更新。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定契约与开发基线

- Status: done
- Owner: coordinator
- Objective: 固定行为、资源与缓存验收边界，提供面板/控制器接口。
- Inputs and prerequisites: 已确认方案与当前源码。
- Scope or files: 本文；core/side-conversation-types.ts。
- Expected output: 可验证计划和稳定类型接口。
- Dependencies: None.
- Execution steps:
  1. 检查工作区、相关文档与源码，记录非本次改动。
  2. 定义控制器 snapshot/subscription/prompt/open/abort/close/shutdown 契约。
- Acceptance criteria:
  - 并行任务能不编辑同一文件完成；无真实 API 权限外扩。
- Verification method:
  - 计划 validator；接口静态复核。
- Validation evidence: 已核对基线与源码；稳定接口 side-conversation-types.ts 已写入；委派前运行计划 validator。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 缓存前缀捕获与兼容验证

- Status: done
- Owner: side-prefix
- Objective: 捕获不含执行实现的父 provider 前缀，保留路由并 fail closed。
- Inputs and prerequisites: T-001 接口及现有 collaboration prefix。
- Scope or files: core/side-conversation-prefix.ts；test/side-conversation-prefix.test.ts。
- Expected output: 独立前缀 API、定向离线测试。
- Dependencies: T-001.
- Execution steps:
  1. 同步冻结 provider context、模型、thinking、routing、leaf/checkpoint 与规则。
  2. 验证父 model/rules/tools/branch/hooks；保留父已有 observer，不写磁盘。
  3. 测试缺捕获、append/branch/compaction、模型/工具变化与独立 routing。
- Acceptance criteria:
  - 不过滤协议工具后谎称 wire 相同；不复制 execute 实现；不静默降级。
- Verification method:
  - 包内定向 Vitest。
- Validation evidence: child 23/23；父级读完源码/测试并移除在途模块 mock 后，11 文件综合定向回归 143/143 passed（task-4）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 旁聊面板与命令入口

- Status: done
- Owner: side-ui
- Objective: 基于稳定控制器契约接入 TUI 旁聊，不替换父 runtime。
- Inputs and prerequisites: T-001 类型接口与现有 extension overlay。
- Scope or files: modes/interactive-grok/components/grok-side-panel.ts；extensions/pi-side-conversation.ts；extensions/index.ts；core/keybindings.ts；对应新测试。
- Expected output: /side、/btw 入口、面板及 UI 测试。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取相关 pi extensions.md/tui.md 及引用 API，按项目按键约定实现。
  2. 用 ctx.ui.custom 浮层展示独立 transcript、输入、状态/usage 与关闭错误。
  3. 父 session_start 绑定 controller；session_shutdown 等待 shutdown；非 TUI 明确拒绝。
- Acceptance criteria:
  - 主编辑器/任务不被替换；UI dispose 只退订；危险命令不从旁聊输入执行；测试覆盖焦点和销毁。
- Verification method:
  - 包内定向 Vitest；后续受控终端 smoke。
- Validation evidence: child 两文件 21/21；父级读完入口与 UI 源码，11 文件综合定向回归 143/143 passed（task-4），包含 VirtualTerminal 真实 TUI 浮层焦点恢复测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 内存旁聊宿主与资源清理

- Status: done
- Owner: coordinator
- Objective: 独立内存运行时保持父前缀，并提供只读执行与可等待关闭。
- Inputs and prerequisites: T-001 与委派时固定的 prefix API；T-005 集成 T-002/T-003。
- Scope or files: core/side-conversation.ts；test/side-conversation.test.ts；extensions/codemode/tool.ts 与 execute.ts 的宿主输出存储注入；必要的小范围接线修正。
- Expected output: 生产 controller 与 integration 回归，真实最终序列化请求校验。
- Dependencies: T-001.
- Execution steps:
  1. 构造内存 manager/settings、独立 ModelRuntime view、受控 ResourceLoader。
  2. 模型声明冻结到父快照；仅允许父已授权的标准内建 read/grep/find/ls 与受限 codemode，其他执行拒绝。
  3. 追加边界与问题，冻结 provider 上下文；不执行 slash/skill/template，不自动恢复父任务。
  4. 生命周期包含 creation cancellation、运行取消、幂等关闭及 cleanup report；不操作父数据。
- Acceptance criteria:
  - 缓存、权限、并发、资源和不落盘验收均有针对性回归。
- Verification method:
  - 定向 Vitest；Mock transport 比较最终 body/headers。
- Validation evidence: 宿主 12/12 passed（task-2）；11 文件综合 143/143 passed（task-4）。覆盖真实 Codex serializer 的 zstd body 解压后 instructions/tools/input 前缀与 headers、native ID、mock usage、创建/关闭竞态及 codemode spill 删除。首次测试 4 个 fixture/断言问题已纠正：去除 Context.execute 函数再 clone、解压真实 zstd、区分空 manager 与无 manager、接受工具变更引起的规则先行失效。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 独立审查与端到端离线验证

- Status: done
- Owner: coordinator
- Objective: 审查冻结实现，反例验证缓存前缀和资源/权限边界。
- Inputs and prerequisites: T-004 完成实现与定向测试。
- Scope or files: 本次 diff、新增测试、必要修复。
- Expected output: 独立审查结果，缺陷修复与离线 UI smoke 证据。
- Dependencies: T-002, T-003, T-004, T-008.
- Execution steps:
  1. 冻结修改集后给只读 verifier 明确文件与版本，不授权 bash。
  2. 修复证实问题并复跑相关测试；受控终端用 faux/offline 路径验证或明确能力缺口。
- Acceptance criteria:
  - 无已知阻塞缺陷；未测试的 provider 命中不宣称通过。
- Verification method:
  - 独立源码审查与目标测试。
- Validation evidence: 第一轮5条发现均补边界：图片/未验证API拒绝、dispatch live predicate、turn取消token、父owned资源聚合；第二位隔离只读 reviewer 报告 No actionable issues found。父级13文件166 tests passed（task-8），含真实Codex/OpenAIResponses serializer+mock fetch、grammar/additional_tools/tool_search_output。受控tmux真实CLI+faux离线smoke：主8秒运行期间/btw已答且main running；隐藏回MAIN_SMOKE_REPLY；/side保留旧问答；显式关闭后再次/btw只有新问答；正常退出，无JSONL，已删除仅本次临时目录/终端。未调用真实模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 文档、全静态检查与提交交付

- Status: done
- Owner: coordinator
- Objective: 更新用户文档/changelog，验证并提交本次变更。
- Inputs and prerequisites: T-005 通过。
- Scope or files: packages/coding-agent/README.md；packages/coding-agent/CHANGELOG.md；docs/side-conversations.md、docs/sdk.md；本任务文件及所有自有变更。
- Expected output: 完整检查通过的提交及简明交付说明。
- Dependencies: T-005, T-007.
- Execution steps:
  1. 记录缓存与权限/持久化/资源边界及命令使用。
  2. npm run check 全输出；git diff --check；核对共享 worktree 格式化影响。
  3. 仅显式暂存自有文件并提交；记录实际测试与未授权真实验证限制。
- Acceptance criteria:
  - 计划验证通过、检查通过、提交不包含他人 AI provider 改动。
- Verification method:
  - 计划 validator；定向测试；npm run check；git status/diff 审核。
- Validation evidence: 用户文档/README/SDK/changelog已更新；完整 npm run check（task-12）exit 0，1656文件，依赖/import/shrinkwrap/install-lock/tsc/browser smoke均通过；13文件166项通过，末次类型修正后2文件30项复跑通过；AI隔离12文件80pass/661skip；git diff --check通过。功能提交 604aadc25（32个显式自有路径）；提交后仅剩原有AI provider/CHANGELOG/未跟踪provider测试三项改动，未纳入本次提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 解阻既有模型目录测试失配

- Status: done
- Owner: model-test-baseline
- Objective: 在用户许可下修复阻塞全量 tsc 的既有模型测试引用，不改 provider 行为或运行真实 API。
- Inputs and prerequisites: npm run check task-3 完整输出；生成目录/报错测试均无本次 diff。
- Scope or files: packages/ai/test 下 tsc 报错的模型引用；必要的现有离线模型断言。不得修改依赖、凭据、provider功能或移除测试。
- Expected output: 用户明确授权后完成最小模型引用更新，或记录用户要求保留基线并停止提交。
- Dependencies: None.
- Execution steps:
  1. 请求用户确认是否将既有基线修复纳入交付范围。
  2. 如获授权，保留相同 provider/测试目的，使用当前生成目录支持的模型；定向离线测试/静态检查。
- Acceptance criteria:
  - 无删除测试、降低类型检查或未经授权的真实 API 调用；全量检查通过。
- Verification method:
  - npm run check 全输出；受影响离线测试；git diff 复核。
- Validation evidence: 用户明确授权。父级已审查12文件diff；使用当前同provider模型MiMo2.6Pro、Sonnet4.5、Nemotron3.5VL、DeepSeek4.1Flash；保持测试数与精确预期，按新metadata更新DeepSeek等级和MiMo API描述。隔离无凭据环境父级复跑12文件：80 passed、661门控skipped（task-9），未调用本地/真实模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 父会话资源所有权与失败报告

- Status: done
- Owner: side-shutdown-owner
- Objective: 将旁聊纳入父 session 可等待资源集合，避免普通扩展事件吞掉清理失败后父仍报告成功。
- Inputs and prerequisites: T-005 独立审查 finding 4；T-001 已固定生命周期要求。
- Scope or files: core/agent-session.ts；test/side-owned-shutdown.test.ts（协调器独占 controller 集成）。
- Expected output: registerShutdownResource(name,cleanup) API、失败聚合/幂等注销与真实父 shutdown 回归。
- Dependencies: T-001.
- Execution steps:
  1. 读取完整 AgentSession 并按现有 shutdown 报告聚合拥有资源的清理结果。
  2. 资源失败不能阻止其他清理，complete=false 且失败标签可追踪；运行后不得新注册。
  3. 协调器把 controller.shutdown 注册为父拥有资源；只有成功后注销。
- Acceptance criteria:
  - 真实 ExtensionRunner/parent.shutdown 路径的旁聊清理失败不能被报告为 complete=true。
- Verification method:
  - 新增定向离线测试与 side controller 集成回归。
- Validation evidence: child新资源测试8/8；父级审阅diff，task-8综合166项通过，包含真实parent.shutdown+真实ExtensionRunner吞错时仍报告side-conversation失败的集成回归。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

使用 packages/coding-agent 内定向 Vitest，不运行 npm test/build 或全 vitest。假 provider/本地 mock transport，不调用真实 API。重点验证 final wire prefix（而非过滤中间 Context）、缓存 routing/native identity、父 streaming 并存、声明不变但执行拒绝、内存 manager、compaction/branch invalidation、close/shutdown races、UI 焦点与 late events。所有修改测试必须运行。交付前运行 npm run check 全输出与 git diff --check。真实服务端 cacheRead 不在本轮可验证范围。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 最终 provider 序列化和 hooks 可能破坏 neutral prefix，必须 mock wire 验证；不支持路径明确失败。
- 保留危险工具声明不授予执行能力；禁用 Bash/MCP 副作用入口，不把声明/注释当权限。
- 内存 session 只保证正文不持久化；旁聊不开放 Bash，避免 managed bash 日志；父文件引用不可删除。
- 关闭等待底层资源可能不完整，必须上报，不承诺安全擦除或任意后代进程终止。
- 他人已有 AI package 修改，不纳入本次提交；全检查若受在途代码影响必须记录真实阻塞。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-20T21:32+08:00: 用户授权实施；确认基线/共享 worktree。创建计划，T-001 in_progress。真实 API 未获授权。
- 2026-10-20T21:40+08:00: T-001 done；接口已固定，计划 validator passed。T-002/T-003 in_progress，分别委派 side-prefix 与 side-ui，文件独占。
- 2026-10-20T21:46+08:00: 依赖图修正：宿主与 UI 只共享冻结接口，并无 UI→宿主依赖，T-004 可并行。T-004 in_progress；发现 codemode 溢出输出/图片也落临时文件，增加宿主输出 writer 注入以获得清理所有权，不依赖模型返回路径删除文件。
- 2026-10-20T21:48+08:00: T-002/T-003/T-004 经父级源码审查与综合定向 11 文件/143 项回归接受为 done。T-005 in_progress，冻结生产文件给独立只读审查。首次 npm run check 格式/依赖/import/shrinkwrap 通过，tsc 被 AI 既有生成模型目录与测试引用失配阻塞；无 coding-agent 类型错误，尚未宣称全量通过。
- 2026-10-20T21:51+08:00: 新增 T-007 blocked，等待用户决定是否纳入既有模型测试引用修复；不自行扩大源码修改范围。
- 2026-10-20T21:53+08:00: 用户明确授权“修复基线并交付”，T-007 blocked→in_progress，委派 model-test-baseline，仅改失效模型测试引用；不运行真实 API。
- 2026-10-20T21:54+08:00: T-005 独立审查返回五条待验证发现：图片投影、异步授权撤销、Anthropic cache marker、父 shutdown 报告、prompt 入场取消。冻结审查结束，进入反例测试与修复；先前 done 是阶段验收，不代表最终交付无缺陷。
- 2026-10-20T21:57+08:00: T-008 in_progress，委派 side-shutdown-owner 独占 AgentSession 资源聚合 API 与新测试；协调器处理 controller live dispatch、入场取消和 fail-closed provider/图片边界。
- 2026-10-20T22:07+08:00: 第二轮隔离审查无actionable finding；综合13文件166 tests passed。T-005/T-007/T-008 done；T-006 in_progress。完成tmux+真实CLI+faux并行交互smoke并清理临时产物；AI12文件父级无凭据复跑80pass/661skip。准备用户文档、完整静态检查与显式路径提交。
- 2026-10-20T22:12+08:00: task-10全检查发现3处新测试/类型接线问题（AgentMessage.content需narrow、SDK无hfCompaction参数、background mock缺completed）；已根据实际类型修正，30项相关测试复跑通过。task-12完整npm run check exit 0（含tsc和browser smoke）。所有worker已关闭，临时tmux/fixture已清理。
- 2026-10-20T22:14+08:00: 显式暂存自有32文件并正常提交604aadc25；提交后git status仅保留初始他人三项改动。T-006 done；全部T-001..T-008完成，关闭本开发计划。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001..T-008全部完成；两轮独立审查后无actionable finding；相关13文件166pass、AI12文件80pass/661门控skip、末次2文件30pass、真实CLI离线tmux smoke、完整npm run check与git diff --check均通过；功能提交604aadc25。
- Limitations: 未调用真实provider，不能把mock/faux cacheRead当服务端命中证明；严格wire复用首版仅两种Responses API、无图片继承前缀，未验证API明确拒绝。
