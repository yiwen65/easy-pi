# Task Plan: Subagent Luna max 真实 Provider 验收

- Created: 2026-09-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户确认gpt-5.6-luna/max、最多30次真实请求或20分钟，隔离验收不自动修复。

<!-- task-doc-section:background-goal -->
## Background and goal

验证新构建Subagent功能与交互在真实Provider上的表现，不以模型自述代替运行证据。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

六个协作工具、model/effort默认与覆盖、嵌套、上下文/权限边界、取消回收、/settings与/agents。使用独立会话、临时配置、合成材料；真实请求锁定gpt-5.6-luna/max，不可用即停。不读取/发送真实历史，不改全局设置，不重启当前会话，不触碰冻结tool-profile-eval及旧恢复材料，不自动修复或提交。串行协调；测试中的子会话只执行合成验收，不承担实现委派。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户批准真实Provider预算30请求/20分钟，含root/child/后代/重试 | 本轮两次结构化确认 |
| F-002 | 当前dist已包含全局defaults接线，离线181项通过 | 2026-09-11-subagent-model-defaults-task.md |
| F-003 | 生产SDK可注入临时settings/agentDir和ModelRuntime；host创建隔离runtime | sdk.md、model-runtime.ts、subagent-model-defaults.test.ts |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 本地存在唯一明确匹配的可用Provider；启动前核验。
- Open question: 无业务决策待确认；若模型歧义或不支持max，暂停，不绕过。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 真实请求model/effort、次数与截止时间受测试级共享预算约束；不泄露凭证。
- 逐项输出通过/失败/未覆盖和证据层级；到预算或阻塞停止，不声称全面通过。
- 保留脱敏报告/用量；测试会话结束关闭，当前用户会话不受影响。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无。
- Serialization constraints: 共享请求计数与预算，串行测试协调。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 模型与预算预检

- Status: done
- Owner: coordinator
- Objective: 核验准确模型/Provider/max与隔离预算方案。
- Inputs and prerequisites: 用户授权、当前dist。
- Scope or files: 只读模型元数据、/tmp测试脚本、本文件。
- Expected output: 脱敏模型信息和全局请求守卫。
- Dependencies: None.
- Execution steps:
  1. 只读本地目录与runtime接口，核验模型和max支持。
  2. 建立opt-in、请求计数、20分钟deadline、凭证脱敏和shutdown。
- Acceptance criteria:
  - 不自动回退；模型不明确则blocked。
- Verification method:
  - 本地预检输出及预算边界自检，无模型请求。
- Validation evidence: 本地唯一可用openai-codex/gpt-5.6-luna，支持max；`PI_OFFLINE=1 node /tmp/epi-luna-real-validation.mjs --dry`：预算30次拒绝/错误模型拒绝、四种renderer-layout设置键盘持久化、非法defaults零预留全部通过，0真实请求，shutdown成功。凭证复制到内存、catalog读入内存；SSE实际fetch含重试统一计数，wire检查model/max/store=false。harness初版自建ResourceLoader遗漏内置extensions，干跑发现只有read；补上SDK同款createBuiltInExtensions接线，不改产品。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 有界真实功能与交互验收

- Status: done
- Owner: coordinator
- Objective: 对协作功能与交互采集真实证据。
- Inputs and prerequisites: T-001成功。
- Scope or files: /tmp隔离harness、合成会话和脱敏结果。
- Expected output: 逐场景实际状态、工具调用、Provider用量及UI断言。
- Dependencies: T-001.
- Execution steps:
  1. 真实基本spawn/消息/followup及嵌套，再测上下文/权限/取消与UI。
  2. 所有调用共享30次/20分钟上限，失败不无限重试。
- Acceptance criteria:
  - 实际状态与调用证据判定；失败及未覆盖如实记录。
- Verification method:
  - PI_REAL_MODEL_EVAL=1门控临时harness、真实provider传输与真实renderer键盘输入。
- Validation evidence: 有界验收程序执行完成，产品结论partial而非全部通过。4个独立合成运行累计27次实际HTTP尝试（序号1..27连续），25次HTTP200，1次初始网络错误、1次主动取消未收到响应；557798ms（9分18秒）含最初网络排查，未重置deadline。13份child final中12份合法、1份curated evidence类型不合法。其余覆盖见下表；所有4个运行shutdown成功。停止消费余下3次预算。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 证据归档与清理

- Status: done
- Owner: coordinator
- Objective: 给出可追溯结论并结束测试资源。
- Inputs and prerequisites: T-002完成或有界停止。
- Scope or files: 本文件、脱敏证据，移除本任务临时脚本。
- Expected output: 验收矩阵、用量、缺陷和未覆盖限制。
- Dependencies: T-002.
- Execution steps:
  1. 核对请求预算、session关闭、无产品修改和秘密泄漏。
  2. 更新authority，验证文档，保留必要脱敏证据。
- Acceptance criteria:
  - 不把部分覆盖写成全面正常；不改产品或当前用户会话。
- Verification method:
  - 输出文件、diff检查、task_document.py validate。
- Validation evidence: 聚合4次run事件，实际HTTP编号严格为1..27且均luna/max，所有run shutdown=true；ps确认无测试Node进程。编译契约独立重验13份child final，12合法/1非法，诊断副本仅改evidence元素类型即valid，原文不改。临时4个脚本已删除，合成证据/日志/聚合摘要保留；git diff --check和任务校验通过。仅新增本authority文档，未改产品/真实全局设置/当前会话；无需build或自动format。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先无模型请求预检，再显式PI_REAL_MODEL_EVAL=1启动预算。使用当前编译产物，临时agentDir/cwd，禁止无关网络和工具。UI断言需真实renderer/终端输入；若仅离线或程序化工具调用，分别标明。次数上限包含重试，20分钟从第一项真实请求起计；时间到取消本轮活动，远端计费停止不作保证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

最终阻塞：F-REAL-001使“全部功能正常”验收不能通过；T-001..T-003测试执行与归档已结束，停止自动执行。解除条件：用户另行授权处理结构化输出协议问题，并在新预算下验证；或明确接受该已知限制。任务校验器只允许overall=done搭配final=passed，因此保留overall=blocked/final=partial，不把执行完成冒充功能全部通过。

max可能耗时且目录成本数据不代表账单；Provider或SDK可能内部重试，预算必须覆盖实际传输，不只计session.prompt。当前共享worktree含其他任务变更，测试不build或format。预算内未覆盖项保留，发热问题不在本任务结论内。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 用户确认；T-001开始，未发送模型请求。
- 2026-09-11: T-001完成，T-002开始。临时脚本采用当前dist与原生root接线，仅测试进程内观察runtime/阻止真实home材料暴露；锁定SSE以计数实际请求。WebSocket、物理终端观感不在本轮实际覆盖。干跑证据 `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-luna-real-rEQhYM/report.json`。

- 2026-09-11 01:59: 首次真实尝试1请求无HTTP响应，尚未子会话预留，测试shutdown成功。发现harness缺少CLI的configureHttpDispatcher/applyHttpProxySettings；补齐原样代理初始化后请求2获得HTTP200，未修改endpoint/模型/产品。累计计数与最初deadline沿用，未重置预算。
- 2026-09-11 02:01: 第二次隔离运行累计14请求，原生root主动spawn/list/wait、idle被动消息不启动、followup旧history、nested读取live默认值及显式覆盖均通过。curated得到HTTP200、正确17及marker、未泄露root marker、工具为空，但模型把evidence写成对象数组，契约要求字符串数组；runtime标记contract=invalid/acceptance=not_reviewed，整项不通过。保留失败原文 `/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-luna-real-xW151J/events.jsonl`，未修复产品或自动格式修复。
- 2026-09-11 02:02: 第三次为剩余项目建立新的合成fixtures，不重跑失败curated；继续上下文/冷加载/UI/interrupt验证，继承累计14请求与最初20分钟deadline。格式invalid单独记录失败后允许其余独立场景继续，绝不改判passed。

- 2026-09-11 02:05: T-002有界执行完成，T-003归档开始。第三运行fork rebuild/preserve、LRU卸载及冷followup、Grok两layout面板历史/消息/resize/焦点、真实请求取消及重用slot通过。第四运行三child真实wait占满执行槽，第四spawn零请求拒绝；/agents错误followup草稿保留、键盘interrupt、键盘followup/权限收窄通过；拒绝权限扩张及continue改verify，取消其余children并成功新建child。累计27请求，无后续模型调用。

- 2026-09-11 02:10: T-003完成；聚合/编译契约重验/进程检查/任务校验通过，临时脚本已删除。执行任务全部结束，功能验收final=partial，原因F-REAL-001保留待用户单独授权修复；剩余预算不再消费。

## Verified coverage and findings

| 场景 | 结论 | 实际证据与边界 |
| --- | --- | --- |
| Provider/model/effort | passed | 所有27次实际发送前检查openai-codex/gpt-5.6-luna、wire reasoning.effort=max、store=false；仅SSE，无模型替换。 |
| /settings | passed | 真实compiled InteractiveMode settings handler + renderer + xterm键盘；Grok/legacy × regular/fullscreen四组合选择模型/max、全局临时文件重开、返回焦点/草稿保持，零provider调用；随后native child实际luna/max。不是物理终端人工点击，也未测试其他模型/effort真实推理。 |
| spawn_agent/list_agents/wait_agent | passed | 真实root模型主动发起这三个工具，child完成42、JSON合法，list显示completed；wait超时语义正常（timeout_ms按既有10秒下限归一化，非即时poll）。 |
| send_message/followup_task | passed | idle被动message不触发请求；followup首次payload含MAIL_SYNTHETIC_21和既有历史，child实际42+21=63；nested child模型主动send_message到root。followup另有真实UI提交。 |
| 默认优先级/嵌套live | passed | parent显式luna/max覆盖非法全局默认；随后全局恢复luna/max，旧parent无override创建leaf成功，leaf请求luna/max；reset后新child继承root max。跨不同有效模型/effort的真实切换未测。 |
| isolated/curated | passed（数据/权限） | child payload无root-only marker；curated含哈希钉住的fixture和17，空tools。后续独立本地重验raw captures通过；错hash与请求bash权限在预留/请求前拒绝。 |
| curated结构化结果 | **failed** | actual evidence为`[{path,sha256,observation}]`，`DelegationResultSchema`要求string[]；runtime正确标记contract=invalid/acceptance=not_reviewed，无自动修复。13份实际child final有1份违反schema，不将此小样本比例外推。 |
| fork rebuild/preserve | passed | 两种native child实际完成；payload保留root marker，preserve通过原生严格prefix guard，无回退。真实模型冲突preserve拒绝及compaction后fork未测。 |
| LRU卸载/冷加载 | passed | 持久child worker由loaded变unloaded；followup新增runtime view，保留已有history并正确输出；历史与记录仍保留。不是自动记录退休或内存/磁盘预算证明。 |
| /agents查看/消息/resize/焦点 | passed | Grok regular/fullscreen渲染真实child历史/model/max；主draft不可见；发送消息无模型请求；60×18 resize；Esc回root保留草稿和焦点。 |
| /agents错误草稿/中断/followup | passed | Grok regular：invalid JSON提交明确拒绝、draft保留、无请求；ctrl+k确认使真实waiting child interrupted；ctrl+f提交合法新task，实际provider返回，tools收窄为空。 |
| interrupt_agent/执行槽 | passed | 对已发HTTP的child主动取消，控制调用15ms返回interrupted（远端停止计费未证实）；3个真实child tool wait占满slot，第四spawn limit_reached且零额外请求；取消后新child正常完成。 |
| 权限/关系拒绝 | passed | followup不能把空tools扩大到read；continue不能改成独立verify；均零额外请求。不代表OS sandbox或任意扩展JS隔离。 |
| 根关闭 | passed | 4个实际运行均原生session_shutdown/dispose完成；检查无测试Node进程残留，用户当前会话未操作。 |

### Findings

**F-REAL-001 — 结构化输出契约未被模型稳定遵守。**

可重放原始片段：`"evidence":[{"path":"evidence.txt","sha256":"dd04b89cadf9af64537e008365c20ff80f5f87d6278a9c91fa6bbe796c85f429","observation":"8+9=17"}]`。
`packages/subagent/src/collaboration-contract.ts:248-263`限定evidence为非空字符串数组。对实际输出运行已编译validateDelegationResult得到invalid；只在诊断副本把evidence元素转为字符串后得到valid，定位到该字段类型，不是数据抽取错误。原始输出不变、未再调用模型修复。
`pi-child-session-host.ts`提供JSON样例空数组，但没有完整说明所有数组元素类型；这可能是改进点，不声称已实验证明它是模型选择对象的唯一原因。建议后续单独授权补全字段类型说明和失败反馈，再做有预算回归。本轮不改产品。

### Budget, usage and artifacts

- 请求编号：1..27；25次HTTP200。#1为harness初始网络接线问题，无子会话执行；#21为主动取消请求，未收到HTTP响应。两次均计入额度，不声称零远端成本。
- 累计elapsed：557798ms，自第一次请求到最后shutdown，包含排查/续测等待；低于20分钟。
- Provider返回用量合计：input 32807、output 2693、cacheRead 10240、cacheWrite 0、totalTokens 45740；reasoning 1525是output内的子项，不重复相加。取消/未返回用量的调用费用未知。
- 目录元数据估算cost合计0.0099978；仅SDK估算，非实际账单/订阅额度，不能据此保证费用。
- 脱敏聚合：`/tmp/epi-luna-real-summary.json`，SHA256 `3da49c0262d463f4ef7d0c3b2e972f3f48ac3fe99e031f86171769b19a0632fc`。
- 原始合成证据目录公共前缀：`/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/`；各含`events.jsonl`/`report.json`：
  - `epi-luna-real-WDSvGG`：初始网络失败，1请求。
  - `epi-luna-real-xW151J`：核心真实功能及curated协议失败，新增13请求，累计14。
  - `epi-luna-real-g3zf91`：上下文、LRU/UI/取消，新增8请求，累计22。
  - `epi-luna-real-L3G73z`：3slot及UI操作/拒绝，新增5请求，累计27。
- 实际执行门控：`PI_REAL_MODEL_EVAL=1 PI_OFFLINE=1 node /tmp/epi-luna-real-validation.mjs`；PI_OFFLINE禁用目录刷新，显式fetch守卫只允许此次授权的模型请求。续测使用EPI_REAL_PRIOR_REQUESTS/EPI_REAL_STARTED_MS继承累计次数与最初deadline，先关闭前次运行再启动。
- 最终临时harness SHA256：`bbf3736b896545ff76ba98856e21b2b6070c04d13eba582ae554c934b4a2ccd0`。不将其安装为常驻扩展或注册自动测试；完成后删除脚本，保留上述合成证据和摘要。
- 未覆盖：WebSocket/transport cache安全性、付费模型切换比较、32-agent/depth4/mailbox64全部极限、cold startup非合作扩展取消、故障恢复/跨进程exactly-once、compaction历史、物理终端观感和长期内存/磁盘/温度。不可宣称Subagent所有情形均正常。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 验收执行完成，27次真实HTTP尝试、25次200、9分18秒，功能/交互覆盖见矩阵。真实curated输出evidence类型违约，13份child final为12 valid/1 invalid，因此不能判定全面正常；runtime拒绝格式并保留not_reviewed正确。无自动修复、提交、真实历史删除或当前会话重启。
- Limitations: 仅指定luna/max与SSE、合成任务、隔离SDK/native/renderer环境；未覆盖项见矩阵末尾。运行结束不证明远端取消即时停止计费，也不是发热诊断。无新LEARNS条目：协议问题未修复，网络接线修正仅记录本次harness证据，不外推产品故障。
