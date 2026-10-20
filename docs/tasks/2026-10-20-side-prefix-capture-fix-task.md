# Task Plan: 修复真实会话旁聊前缀捕获失败

- Created: 2026-10-20
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户报告普通对话后 /btw 仍报 No parent request prefix，并授权必要的不记录内容/密钥的诊断、最小修复、离线回归与提交；不自动 push。

<!-- task-doc-section:background-goal -->
## Background and goal

用户最初报告恢复会话无法取得旁聊缓存前缀；运行时诊断后当前可复现错误是已注册payload hook被一律拒绝。修复当前已证明阻塞：允许真实父请求中已观察到不改变payload的hook，不伪造或静默重建缓存前缀。最初missing-prefix的具体原因仍未证明。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：provider context 观察器、side prefix 生命周期、必要的隐私安全诊断与离线复现、回归与提交。非目标：真实付费 API、凭据读取、改用户会话文件、生产调试端口、服务端缓存保证、自动 push。保留既有 AI provider/CHANGELOG/测试三项外部改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户在普通消息回复后仍得到相同错误。 | 用户本轮反馈 |
| F-002 | 当前运行进程22:25:30启动；launcher指向仓库 pi-test.sh。 | ps与仅筛选路径的 /proc launcher cmdline，无密钥输出 |
| F-003 | 调查开始时功能提交604aadc25，HEAD80b2b4a9e，工作区仅有原始三项外部改动。 | 初始git status/log |
| F-004 | Side prefix保存在WeakMap；observer复制失败会被吞掉并清除旧capture。 | src/core/side-conversation-prefix.ts |
| F-005 | agent-loop在通知observer前复制messages，外层catch也会隐藏异常。 | packages/agent/src/agent-loop.ts:542-556 |
| F-006 | 用户当前/btw已取得快照，报payload-transforming extensions enabled。 | 用户最新反馈；该guard在capture/model/branch检查后 |
| F-007 | 当前Qoder扩展只修改qd/模型，当前Codex模型不受修改；仅注册hook导致blanket拒绝。 | 只读全局扩展与prefix源码；两种Responses wire回归在修复前均以同一错误失败 |
| F-008 | 修复后的两种真实Responses序列化器在mock transport下保持instructions/tools/input前缀与cache key相同，hook仅调用父请求一次。 | test/side-conversation.test.ts定向红绿回归，无真实API |

除显式包路径外src/相对packages/coding-agent。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 当前用户错误确由这条源码路径产生，launcher入口一致；不以全局旧dist作为已证根因。
- 未解决的历史问题：最初missing-prefix的具体原因没有被证明；503条恢复上下文离线捕获成功，实际请求callback/stream及clone状态也正常。当前错误已转为可复现的blanket payload-hook拒绝，不再要求用户反复reload/hello。
- 信任边界：可信payload hook必须在return/promise settle前完成修改；不支持脱离promise的延后修改，不把本次no-op观察宣称为hook永久纯函数。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 用离线固定输入/可控时序复现真实等价失败，定位因果链。
- 最小修复不改父请求前缀、权限或资源生命周期契约；新捕获失败不得复用陈旧capture。
- 诊断只输出阶段、错误类别/计数等无内容事实；不写会话内容/密钥，不更改用户原始文件。
- 回归先观察坏基线后修复并通过；定向邻近测试与npm run check通过后提交。
- 如实际运行时证据无法取得，诚实记录blocked和下一步，不声称修复。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；定位结果决定修复点，串行处理。
- Serialization constraints: 协调器独占此计划、诊断/修复代码和测试，不修改其他会话改动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 只读证据与离线复现

- Status: done
- Owner: coordinator
- Objective: 找到真实恢复会话与新会话通过路径的首个有意义差异。
- Inputs and prerequisites: 用户错误、当前源码、用户授权的无内容诊断。
- Scope or files: prefix/agent-loop生命周期源码；临时隔离诊断程序；/home/w/.epi/agent/extensions/side-prefix-diagnostic.ts临时可逆探针（仅目标session生效）；只读当前session上下文，不复制到磁盘。
- Expected output: 坏基线、竞争假设与可证根因或明确证据缺口。
- Dependencies: None.
- Execution steps:
  1. 核对实际入口、observer调用链与恢复行为。
  2. 通过假provider/内存manager复现，不调用真实API。
- Acceptance criteria:
  - 不输出用户消息、工具参数或秘密；可区分未观察与复制失败。
- Verification method:
  - 固定fixture的成功/失败与捕获状态。
- Validation evidence: 原会话完整尾行只在内存解析，503条有效消息可clone，假provider恢复请求成功捕获503条前缀（task-2），未输出内容/写原文件/调用真实API。临时.pi/extensions/side-prefix-diagnostic.ts经真实jiti加载+内存SDK假provider验证，callback/stream各1次，model/messages/schema复制均ok；独立tsc含该扩展通过（task-8）。完整npm run check exit0（task-6）。用户随后将/btw-diagnose发送到模型，说明诊断处理器未触发；将自有探针移至全局扩展并限定精确sessionID，删除项目副本。真实global discovery在projectTrusted=false时目标session回调/stream各1，其他session被拒绝（task-9）；全局JITI扩展的独立ESM/Bundler tsc通过（task-10）。私有native-binding相对导入在jiti产生独立WeakMap，诊断已改用宿主公共SDK类桥接并按精确manager身份限制可逆包装；不会将此测试装配差异误判为产品根因。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 修复已证明根因并增加回归

- Status: done
- Owner: coordinator
- Objective: 最小修复首次偏离，不以降级/造前缀掩盖失败。
- Inputs and prerequisites: T-001证据。
- Scope or files: core/side-conversation-prefix.ts、test/side-conversation-prefix.test.ts、test/side-conversation.test.ts；必要的用户文档/changelog更新。保留header-hook拒绝与所有权限/身份边界。
- Expected output: 可回归修复或明确blocked记录。
- Dependencies: T-001.
- Execution steps:
  1. 固化坏基线回归。
  2. 修复并验证原oracle和邻近边界。
- Acceptance criteria:
  - 保留缓存/权限/关闭语义，失败文案有真实原因。
- Verification method:
  - 定向Vitest，不运行真实模型。
- Validation evidence: 修复前两种Responses wire回归2/2因原始guard失败（task-11）；修复后相同回归通过。七文件127/127通过（task-15）：side-conversation-prefix、side-conversation、side-owned-shutdown、grok-side-panel、pi-side-conversation、codemode-extension、codemode-settings。包含变更/awaited mutation/吞错、pending/disposal/raw throw、身份新增替换排序重载、重复/重入、旧前缀证据、不安全序列化边界。捕获已绑定但payload未settle时同值重捕获的测试先失败，改为按settled判定歧义后通过。完整check首次发现测试替换handler返回void而非Promise，已按HandlerFn类型修正；task-16完整npm run check exit0。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 检查、文档与提交

- Status: done
- Owner: coordinator
- Objective: 验证修复范围并提交，不自动push。
- Inputs and prerequisites: T-002通过。
- Scope or files: 自有diff、必要changelog/文档与本计划。
- Expected output: 检查通过的提交及使用限制说明。
- Dependencies: T-002.
- Execution steps:
  1. 运行修改测试、邻近测试和完整npm run check。
  2. 审查diff、显式stage自有路径，提交。
- Acceptance criteria:
  - 不纳入外部改动；未验证的真实运行时状态明确披露。
- Verification method:
  - 定向测试、npm run check全输出、计划validator、git diff/status。
- Validation evidence: task-16完整npm run check通过（Biome、固定依赖、静态imports、shrinkwrap/install-lock、tsc、browser smoke）；最终格式化后task-17七文件127项离线回归通过。仅三项自有TS文件被Biome格式化，外部AI三文件SHA256与check前一致；git diff --check通过。side-conversations.md及Unreleased Fixed已更新，临时全局诊断扩展已删除且确认不存在。独立只读审查最终SHA256 bb568201645342bde41966c29f34a1a4f02eab03ecb149103e4c0725c12e5bc4未发现支持串行路径缺陷；身份为内容关联而非request token，未知歧义保守拒绝。修复已显式stage五个自有文件并提交543d520fa（task-18），未push。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

使用假provider/内存credentials与隔离资源loader。读取既有session仅供内存结构诊断，不调用SessionManager.open以免迁移/修复原文件；不记录内容。复现callback时序与uncloneable输入时，必须区分输入真因与测试装配错误。修改的测试定向运行。代码修改后npm run check全输出；不运行npm test/build，不启用真实provider。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 当前长寿命进程的内存回调状态不可由文件直接证明；源码诊断修改通常需重启才能生效，不能声称已热修该进程。
- 复制失败可能发生在side observer之前，不能只改最后的错误文案。
- 原会话并发写入中，只读快照可能截断最后一行，诊断必须忽略未完成尾行而不修文件。
- 请求关联仍基于context值而非独立request token；支持常规串行AgentSession路径，手工/任意并发观察回调不作安全承诺；中断于stream前的同值重试可能被保守拒绝，需新的父消息恢复。
- 已证明修复当前payload-hook误拦截，不声称定位了已消失的历史missing-prefix具体原因。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-20: 用户授权定位修复与离线回归/提交，不自动push。已确认此前“恢复后首次请求”解释不足；T-001 in_progress。
- 2026-10-20: 原始严格session reader因实时追加报Session changed（诊断装配竞争，不是产品故障）；改为仅解析完整尾行的只读内存快照后，原会话503条有效消息与假provider捕获均通过。
- 2026-10-20: 临时诊断首次private native-binding导入无法附着，已用宿主SDK虚拟模块类桥接、精确manager身份检查的可逆包装修正；假provider+真实jiti加载验证通过。独立tsc曾因临时config缺types/shim及command handler非async失败，已按真实类型修正后通过。
- 2026-10-20: npm run check全输出通过；诊断不发送模型请求、不记录内容/参数/密钥。T-001 blocked等待实际进程JSON诊断，T-002/T-003尚未实施，不宣称已修复。临时隔离程序目录验证后删除。
- 2026-10-20: 用户输入/btw-diagnose仍被模型接收，不能误当命令输出。将仅本次自有诊断扩展移至全局目录并加目标sessionID限制，不更改用户trust/settings，不覆盖qoder扩展。用真实global discovery验证projectTrusted=false目标生效、非目标拒绝，且类型检查通过；项目旧副本移除。再次等待/reload后的实际JSON，尚无生产修复。
- 2026-10-20: 用户提供真实进程无内容JSON：binding attached、activeAtAttach false、callbacks=1、streams=1、idle true、agentStreaming false；stream messages614/tools22与stored messages559/tools22均clone成功，model也ok。排除本次请求未执行及输入复制失败；side专属observer是否写入未被此探针覆盖。请求当前/btw结果，不要求再reload或反复hello。
- 2026-10-20: 用户当前错误已变为payload-transforming extensions enabled，证明快照已存在且通过model/branch前置检查。实际全局Qoder hook仅改qd/，Codex为no-op；源码blanket拒绝所有registered hook导致当前阻塞。新增两种Responses真实serializer+mock transport用例，未改生产代码先红测：2/2以同一错误失败（task-11）。T-001 done，T-002 in_progress；修复按真实parent请求hook前后body是否相同建立证据，拒绝改变/异常/未知，不能直接删guard。

- 2026-10-20: T-002 done。实际parent onPayload前后JSON比较只保存结论，保留原hook单次调用/返回/throw；捕获证据按prefix和observer生命周期绑定，身份变更与歧义/重复结果fail closed。task-15七文件127/127通过；task-16完整npm run check exit0。T-003 in_progress，用户文档/changelog已更新；自有临时全局探针已移除，用户Qoder/trust/settings未改动。完整check前后外部三文件hash一致。

- 2026-10-20: 最终独立只读复核未发现支持路径问题，coordinator核对SHA与当前文件一致；格式化后task-17七文件127/127再通过。task-18提交543d520fa成功，仅含五个自有修复/测试/用户文档文件。T-003 done；任务记录单独提交，未push。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003均done。当前blanket hook拒绝已复现并有离线wire红绿回归；七文件127项通过，完整npm run check通过，独立最终只读复核和git diff --check通过，临时探针已移除。修复提交543d520fa，未push。计划validator通过。
- Limitations: 未调用真实API，未证明服务端缓存命中；最初missing-prefix原因未证明。长寿命TUI需完整重启/resume加载core改动，/reload不足。探针文件已移除，已加载的临时包装在进程关闭时释放。
