# Task Plan: TUI 全量可靠性与交互整改

- Created: 2026-10-02
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求修复上轮 TUI 审查的全部问题项。

<!-- task-doc-section:background-goal -->
## Background and goal
修复六项确定问题，并落实状态可信度、最新预览的失败汇总、统一折叠交互、模式提示、格式一致性、窄屏降级、显示布局复用和长会话基准。保留现有渲染引擎及工具调度。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals
范围：packages/tui 的布局/滚动和基准；coding-agent 的消息显示、任务面板、chrome、交互接线及相关测试文档。
非目标：替换 renderer、实模型调用、凭据/发布/依赖修改、未经测量的虚拟化重构、修改其它 session 的候选目录。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence
| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 不合规 summary 类型可使 subagent 显示异常，completed 不代表 outcome succeeded。 | subagent-group.ts parseDeliverResult/addMailboxResult；上轮 summary:42 和 outcome:blocked 源码复现。 |
| F-002 | 仅数字 scrollTop 会在上方块变高时丢失阅读对象。 | scroll-view.ts updateLayout；上轮 READING_TARGET→EARLIER_4 复现。 |
| F-003 | 提示跳转目标会被 scrollTo 边界截断而重复选取。 | prompt-navigation.ts；目标90/实际70三次复现。 |
| F-004 | tasks 面板索引可移至可见窗口外；copy 提示实际插入草稿。 | grok-tasks-panel.ts renderList/handleInput；pi-background-tasks.ts onCopyPath。 |
| F-005 | 后台日志先按完整宽度换行，再添加两列缩进，会超宽。 | background-task-group.ts taskDetail；40列输出42列复现。 |
| F-006 | 默认 regular 与 fullscreen 的鼠标能力不同，现有显示布局与点击定位分别计算。 | createInteractiveTui/computeChatChildOffsets；tui-alt-screen.ts currentLayout。 |
| F-007 | 150行模拟基准快，不能代表长会话或真实终端。 | render-churn-bench.ts；上轮 static 0.037/editor 0.074 ms/frame。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions
- Assumption: 保持现有日志路径插入功能，纠正动作名称；复制与插入不混称。用户已授权修复全部问题，采用最小兼容行为修正。
- Assumption: 共用现有 formatWorkedDuration 的可读单位格式；不新增主题或全套国际化。
- Assumption: 阅读锚点保留组件身份与组件内行偏移，删除时回退到存活父级/邻近位置；不承诺未知第三方组件的源码字符级重排定位。
- Open question: 无阻断决策；真实终端/字体人工验收单独报告限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria
- 六项确定问题均有修复前失败、修复后通过的回归证据。
- Subagent 对不合规输入安全降级，区分 lifecycle/outcome/validation，不推断验收。
- 保留 latest-entry/turn-completion/no-scroll 行为，同时折叠可见失败汇总。
- 任务面板选择始终可见且以任务身份保持；动作提示符合实际副作用。
- 阅读历史时上方增长/折叠/重排不丢失当前组件；末尾跟随保持原语义。
- 点击、提示跳转优先复用已显示的布局快照；键盘支持局部展开，提示明确模式差异。
- 窄宽度/小高度保留编辑区和正文优先级，耗时/空状态/路径提示一致，状态不仅依赖颜色。
- 长会话基准覆盖大量历史、中文/Markdown、编辑更新和缩放；不把 NullTerminal 数据称为实终端延迟。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches
- Dependency graph: T-001/T-002/T-003/T-004 → T-005；T-001/T-003/T-004 → T-007；T-004 → T-008；T-001 → T-009；T-005/T-007/T-008/T-009 → T-006。
- Parallel batches: 首批 T-001/T-002/T-003/T-004 文件互斥；第二批交互接线 T-005 与释放文件上的内部点击快照 T-007 并行；第三批验证与提交。
- Serialization constraints: interactive-mode.ts 和 task doc 只由 coordinator 修改；TUI 核心只由 renderer worker 修改；共享格式采用已有 API，无并发改同文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 子代理结果安全与状态可信度
- Status: done
- Owner: /root/tui-results-fix
- Objective: 安全解析不合规结果，保留原文并显示警告，区分运行完成/任务结果/校验；统一耗时和 disclosure 标记。
- Inputs and prerequisites: F-001；现有子代理卡片和 formatWorkedDuration。
- Scope or files: subagent-group.ts；subagent-group/transcript-routing/mouse 相关测试。
- Expected output: 最小显示修复及畸形字段/partial/blocked/failed 回归。
- Dependencies: None.
- Execution steps:
  1. 回归复现并修复显示数据边界和标记。
  2. 验证实时/历史结果和现有控制竞态。
- Acceptance criteria:
  - 不合规结果不能使渲染失败；原文保留；任务 outcome 清晰，不隐含验收。
- Verification method:
  - 特定 subagent Vitest 文件及 diff 审查。
- Validation evidence: coordinator 已审查全部 source diff 与测试；三项 subagent 目标文件85/85 passed（task-9，1.56s），类型检查第一批通过（task-10）。worker 初始18失败、review16失败；修复包括未知字段安全降级、Diagnostics-only 原始JSON、envelope outcome/fence/prose fallback、enum warning、窄宽度长名称关键状态与最新预览。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 任务面板选择和动作语义
- Status: done
- Owner: /root/tui-tasks-fix
- Objective: 选中项始终可见，身份在排序变化后保持；纠正 copy/insert 提示；旧 y/End 绑定的配置注册在 T-005 接入。
- Inputs and prerequisites: F-004；grok-tasks-panel 与 pi-background-tasks。
- Scope or files: grok-tasks-panel.ts；pi-background-tasks.ts；相关任务面板测试；如需 keybinding 只向 coordinator 提出合同。
- Expected output: 可见选择窗口及正确的插入提示/焦点行为。
- Dependencies: None.
- Execution steps:
  1. 覆盖小高度和状态排序更新的选择回归。
  2. 修正列表窗口、动作提示和反馈。
- Acceptance criteria:
  - Down/PgDn/Enter 对应可见同一任务；插入不会误称复制。
- Verification method:
  - grok-tasks-panel 及相关 extension 特定测试。
- Validation evidence: coordinator 审查 owned diff；packages/coding-agent 下 node ../../node_modules/vitest/dist/cli.js --run test/grok-tasks-panel.test.ts，11/11 passed（task-4，3.30s）。worker 修复前4失败/9测试；已验证列表窗口、排序身份、删除、插入顺序及完整路径。全局类型与 keybinding 重映射待 T-005/T-006。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 显示布局快照、阅读锚点与长会话基准
- Status: done
- Owner: /root/tui-layout-fix
- Objective: 提供可复用显示几何快照，保留非跟随阅读锚点，扩展有界基准。
- Inputs and prerequisites: F-002/F-006/F-007；TUI Component/Container/ScrollView/LayoutFrame 合同。
- Scope or files: packages/tui/src/tui.ts、layout.ts、components/scroll-view.ts、tui-alt-screen.ts、相关 TUI 测试与 render-churn-bench.ts。
- Expected output: current displayed frame 的子组件内容行 offsets API，组件身份锚点及基准证据。
- Dependencies: None.
- Execution steps:
  1. 复现上方增长导致阅读漂移；记录已渲染 plain Container 子节点范围，不额外调用 render。
  2. 接入 ScrollView 锚点，并暴露当前帧组件 offsets。
  3. 增加增长/删除/重排/resize/follow 和长会话测试基准。
- Acceptance criteria:
  - 非跟随时保留阅读组件；跟随模式不退化；几何命中与实际帧一致。
- Verification method:
  - 特定 node:test TUI 文件；静态和长会话模拟基准。
- Validation evidence: coordinator 检查 source diff；layout/layout-snapshot/tui-alt-screen/layout-click 四个 node:test 文件70/70 passed（task-5，4.10s）。修复前 growth 与 sole-child tie 均失败。API getRenderedChildOffsets(scrollView,container) 保留实际显示快照；scrollRevision 记录显式请求。coordinator 重跑600组件1900/4800行 NullTerminal 基准（task-8）：collapsed0.154、expanded0.253、editor0.163、resize10.873 ms/frame；resize含10次切换/100混合帧，不代表实终端延迟。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 失败汇总、格式规范和窄屏 chrome
- Status: done
- Owner: /root/tui-presentation-fix
- Objective: 保留最新预览并汇总失败；修日志缩进；统一耗时；窄屏优先正文和输入。
- Inputs and prerequisites: F-005 和最新折叠行/停止滚动合同。
- Scope or files: background-task-group/view.ts；grok-tool/thinking-turn-group.ts；grok-agents-panel.ts；grok-interactive-view/chrome 组件及各自测试；不得改 interactive-mode/keybindings 或 subagent/tasks-panel。
- Expected output: 一致 disclosure/时间、失败可见、无超宽日志、可预测小高度布局。
- Dependencies: None.
- Execution steps:
  1. 为 ANSI/CJK/极窄日志和混合失败建立回归。
  2. 对齐现有耗时 helper 和 disclosure 标记。
  3. 增加低高度 chrome 降级和 editor 可见测试。
- Acceptance criteria:
  - 最新记录不被旧错误替换；失败汇总可见；日志字符不丢失；输入区优先保留。
- Verification method:
  - 特定 background/grok component/shell/agents 测试。
- Validation evidence: coordinator source diff 审查及五个目标文件104/104 passed（task-6，5.78s）；全量类型检查通过（task-10），先前两项 required lastOutputAt fixture errors 已修正。worker修复前7失败，review3失败；覆盖width1安全省略、width2+保留CJK、ANSI日志、失败/timed_out汇总、真实nativeRetry/Compaction自定义status的高度3+紧凑投影、Completed生命周期、耗时和只显示路径helper。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 统一键盘/鼠标局部交互和提示导航
- Status: done
- Owner: /root/tui-interaction-fix
- Objective: 接入布局快照，按提示身份连续跳转，支持键盘局部选择/展开；明确 regular/fullscreen 能力。
- Inputs and prerequisites: T-001/T-002/T-003/T-004 的接口和测试；app keybindings。
- Scope or files: interactive-mode.ts；prompt-navigation.ts；core/keybindings.ts；custom-editor.ts；grok-tasks-panel.ts 的注册 keybinding 接线（T-002 释放后）；startup header、对应测试和用户文档。
- Expected output: 可配置局部 transcript 操作，命中几何复用及末尾循环跳转修复。
- Dependencies: T-001, T-002, T-003, T-004
- Execution steps:
  1. 审查和集成首批 diff，不使用未验收接口。
  2. 修提示导航clamp，接入局部 transcript selector/toggle 和模式提示。
  3. 覆盖键鼠/focus/copy/resize 和全局展开。
- Acceptance criteria:
  - 末提示→首提示循环；局部操作不改全局默认；鼠标不误复制；regular 明确显示键盘入口。
- Verification method:
  - 导航和鼠标 VirtualTerminal integration 特定测试。
- Validation evidence: coordinator source/API/fixture diff审查；最终21个目标文件296/296 passed（task-17，5.91s），包含导航clamp/手动scrollRevision/移除、Alt+O局部选择、配置重映射、真实SGR未绘制Activity点击和扩展后暂停follow、编辑草稿/focus保留。邻近旧fakeMode缺新helper/ScrollView，修fixture后保留原断言，无削弱production安全门。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 综合验证与提交
- Status: done
- Owner: coordinator
- Objective: 审查全部 diff、运行有意义的验证、更新本权威记录并只提交本任务文件。
- Inputs and prerequisites: T-005 和各任务实测证据。
- Scope or files: 本任务全部变更、task doc；不修改无关候选资源/LEARNS 未提交改动。
- Expected output: 经验证提交和真实的最终状态/剩余限制。
- Dependencies: T-005, T-007, T-008, T-009
- Execution steps:
  1. 运行分层目标测试、类型/格式、npm run check，并审查共享 worktree 自动格式修改。
  2. 运行文档 validator，记录基准和无法验证的内容。
  3. 明确路径 stage/commit。
- Acceptance criteria:
  - 原始失败回归通过；修改的测试实际执行；共享无关内容保留；检查阻断不得伪称通过。
- Verification method:
  - 目标测试、tsgo、Biome、npm run check、git diff --check、task validator。
- Validation evidence: coordinator最终21个coding-agent文件296/296、packages/tui全部36个node:test文件946/946、深JSON独立probe3/3通过；scope Biome42个TS文件无修改、owned git diff --check无问题。check:shrinkwrap/install-lock/types/browser-smoke分别exit0（task-20）。npm run check在check:pinned-deps被其它session候选材料包semver范围阻断（task-18）；独立check:ts-imports也被同一材料里的.js import阻断（task-19），未冒称通过。自动格式变动4个无关文件已按检查前内容精确复原、cmp相等。代码及用户文档44文件已明确stage并提交83265a270；本权威记录另行docs提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 卡片内部点击命中复用实际显示快照
- Status: done
- Owner: /root/tui-click-snapshot-fix
- Objective: 将布局复用完整落实到 opaque 折叠卡片内部，避免未绘制的新结果/日志使按钮行位置变化。
- Inputs and prerequisites: T-001/T-003/T-004 已验收；coordinator 新复现旧 Activity row8 在新结果尚未绘制时 handleOverviewClick 返回 false。
- Scope or files: packages/tui 渲染结果 metadata/布局/alt-screen 快照 API 与导出、snapshot 测试；释放后的 subagent/background/thinking/tool-group/compaction 点击映射和目标测试；grok-tool-execution.ts 的只读展开状态getter；不改 interactive-mode 或 T-005 文件。
- Expected output: getRenderedContentClickHandler(scrollView,component) 提供实际帧内 local-row 点击映射，无额外 render；卡片控制位置/成员身份 captured，与外部 child offsets 一起使用。
- Dependencies: T-001, T-003, T-004
- Execution steps:
  1. 用真实显示帧后追加未绘制结果/输出复现错误按钮定位。
  2. 将信任的 UI-only 点击映射绑定返回 lines，plain Container 合并，LayoutFrame 复制；特殊卡片记录真实渲染时的行映射。
  3. 向 T-005 owner 交付 public handler API；验证移除/resize、不误复制及无工具执行副作用。
- Acceptance criteria:
  - 点击实际显示 Activity/任务/tool 行正确命中原控制，不被新文本偏移；不重新 render 计算命中，不运行工具或调度动作。
- Verification method:
  - 特定 TUI snapshot 与 coding-agent group/mouse 文件；full source diff 审查。
- Validation evidence: coordinator core/card source diff审查；packages/tui全部36个node:test文件946/946 passed（task-11，5.46s）；coding-agent相关最终21文件296/296。原未绘制Activity row8回归、empty-expanded renderer的true state、sole/snapshot/resize/root-reset均验证。coordinator物理SGR再probe：上方3→10行、同物理press/release时 clicks1/copies[]，旧代码clicks0且fabricated copy。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 常规 fullscreen 状态栏不能挤掉输入
- Status: done
- Owner: /root/tui-presentation-fix
- Objective: 修复 roomy dock 的长 native working message 不可收缩而使输入落到视口外的回归。
- Inputs and prerequisites: T-004 已完成；独立 review 实际24×12 WorkingStatusIndicator 复现草稿消失，单改 shrink1 后草稿恢复。
- Scope or files: grok-interactive-view.ts 与 grok-shell-components.test.ts；不改其它 source/任务文档/renderer。
- Expected output: 长状态标签有界/可收缩，至少显示有效状态文字而非空padding；正文和草稿/cursor 始终保留。
- Dependencies: T-004
- Execution steps:
  1. 以 native WorkingStatusIndicator 和支持的 setWorkingMessage 内容建立24×12失败回归。
  2. 修有界状态布局，维持正常足够空间时状态内容、compact override、focus及后端逻辑。
  3. 回归12/24/80列和12+高度、retry/compaction/idle/长自定义消息边界。
- Acceptance criteria:
  - 状态不会将编辑区放到clip外；有效警告/工作状态文字仍可见；不改变backend状态和调度。
- Verification method:
  - grok-shell-components 和 native status/互动目标测试；独立 review 复验。
- Validation evidence: coordinator审查roomyStatus去除Loader前置空行、shrink1/min1的源码；最终21文件296/296包含shell40项。独立review复跑shell40/40，确认24×12、80×12真实WorkingStatus/native retry/compaction、custom警告的draft/cursor/status/transcript与高窗口完整内容；原2失败草稿消失已转绿。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 不合规深层 JSON 的显示归一化必须有界
- Status: done
- Owner: /root/tui-results-fix
- Objective: 完成结果安全降级的递归边界，避免对合法summary的无关深字段或畸形深数组归一化时栈溢出。
- Inputs and prerequisites: T-001 已完成；coordinator Vitest/source alias probe 两项均复现RangeError，4000层数组仅8KB，低于消息尺寸上限。
- Scope or files: subagent-group.ts 的 readableValue/parseDeliverResult 与 subagent-group.test.ts；已释放文件，不改其它worker来源。
- Expected output: 有界可读化，忽略无需展示的深额外字段；原始text和envelope仍在Diagnostics完整保存。
- Dependencies: T-001
- Execution steps:
  1. 将 /tmp/tui-result-depth-probe.test.ts 的两个失败复现加入正式测试。
  2. 给fallback/section的显示归一化合理深度界限与明确Diagnostics提示，不提前遍历已知合法结果的无关字段。
  3. 运行subagent目标文件与整体类型/格式检查。
- Acceptance criteria:
  - 深不合规JSON不throw；已知summary仍显示；原始JSON未改写；普通嵌套结构可读输出保持。
- Verification method:
  - 特定subagent tests与原probe；diff审查。
- Validation evidence: coordinator diff审查及21文件296/296；原probe2项RangeError、后续deep wrong text开启Diagnostics RangeError已修。helper8层有界，known summary不遍历ignored extra，原wire WeakMap在pretty JSON序列化失败时精确保留原始body；正式测试保存WIRE_SENTINEL和完整原wire。worker三个subagent目标92/92与extended probe3/3通过，coordinator最终group/route/mouse亦通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan
以修复前失败为基线，先运行各 worker 的目标文件，再运行交互依赖路径和 TUI 布局/鼠标/搜索/overlay 邻近测试。禁止全量 vitest/实API/build。npm run check 可能被现有候选目录未固定版本依赖阻断；单独运行类型/范围内格式/目标测试，并如实记录。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers
整体全仓检查被其它session候选材料的未固定依赖版本与原始.js imports阻断；所有本任务implementation IDs完成。解除条件：这些材料的owner修正/隔离全仓检查输入，重新运行完整check；本任务不改其源文件。
共享 worktree，现有 LEARNS 和候选目录属于其它工作。布局锚点不得破坏 follow/search/cursor/image；已显示几何不能被额外 render 污染。格式统一不隐藏失败、不把合同 valid 当验收、不停止后台任务。实终端/字体对比度不以模拟测试冒充。

<!-- task-doc-section:execution-log -->
## Execution log
- 2026-10-02: 用户明确授权全量整改；刷新 HEAD 8d76b9a65 与共享工作区基线；创建唯一 task doc。
- 2026-10-02: T-001/T-002/T-003/T-004 进入 in_progress，按文件互斥委派；coordinator 保留 T-005/T-006 和 task doc 写权。
- 2026-10-02: T-001 review 要求 structured fallback 保持 Diagnostics-only raw JSON，并补 envelope outcome/enum guards；T-003 review 要求相同 bounds 的 ancestor/leaf anchor tie 回归，均继续 in_progress。
- 2026-10-02: T-002 coordinator 验收完成（11/11），置 done；onCopyPath 明确改为 onInsertPath，无兼容别名；剩余原 y/End 注册配置接线归 T-005。
- 2026-10-02: coordinator 完成 T-001/T-003/T-004 diff/目标测试审查，分别85/70/104测试通过；T-003 tie 与显式scrollRevision、T-004实际native status/width1约束纳入；全部第一批类型检查通过。
- 2026-10-02: 首批全部 done 后启动 T-005 单一 owner 接线，keybindings/interactive-mode/task面板旧键接线无并发编辑；T-006 仍 pending。
- 2026-10-02: coordinator 复现卡片内部旧 Activity row8 被未绘制新结果挤走（consumed:false）；新增必要 T-007，在第一批已释放的 source 上扩展 immutable render-result 点击 metadata，和 T-005 文件互斥并行。
- 2026-10-02: T-007 review 再复现阅读锚点移动期间静止鼠标被当作拖选复制，加入物理press cell回归；expanded empty tool renderer不能由高度推测state，增加公开只读isExpanded getter与真实state快照。
- 2026-10-02: 独立 review 复现24×12 roomy native长WorkingStatus使编辑草稿消失，新增 T-008修复状态布局。
- 2026-10-02: coordinator source-alias Vitest复现两个深JSON显示RangeError（4000层数组及合法summary+深ignored字段），新增 T-009小范围有界归一化；源码新增export尚未build，直接Node源import不能替代Vitestalias，未把该环境错误当产品缺陷。最终验收依赖T-005/T-007/T-008/T-009。
- 2026-10-02: coordinator 验收T-005/T-007/T-008/T-009，所有production任务done；21个coding-agent目标296/296、TUI全部946/946；进入T-006综合检查/文档验证/只提交本任务文件。
- 2026-10-02: npm run check在候选材料的未固定dependency版本处失败；独立TS import扫描也被材料原始.js imports阻断。其余shrinkwrap/install-lock/tsgo/browser-smoke通过。恢复Biome自动改写的4个无关文件，逐字节cmp检查前备份一致；候选资源和LEARNS及其它user变动未提交。
- 2026-10-02: 代码44文件提交83265a270，完成T-006；scope代码/行为验收通过，整仓pipeline因无关材料仍记录partial，本任务无未完成implementation IDs。

<!-- task-doc-section:final-validation -->
## Final validation result
- Result: partial
- Evidence: T-001至T-009全部done；代码提交83265a270。coordinator已审查子任务全部diff，回归/目标296项与TUI全946项通过；独立原始deep JSON probe3项通过；格式、类型、browser-smoke、shrinkwrap和install-lock检查通过；文档validator通过。首次和追加各失败基线与实测证据记录在任务项/日志中。
- Limitations: 全仓npm run check/check:ts-imports被其它session的computer-native-*候选材料依赖范围与原始.js imports阻断，非本任务source错误，未修改这些资源；因此整体结果不写passed。实终端/fonts/TTY端到端延迟未人工测量，未运行build/实模型API。Node直接源码import不能代表Vitest/source alias或将来构建产物。极窄width1双单元字符以有界省略标志显示，原文在日志/Diagnostics保留；任意opaque第三方组件只有rendered-row身份锚点，没有源码字符级重排保证。
