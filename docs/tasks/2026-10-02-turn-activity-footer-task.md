# Task Plan: Turn 尾部固定活动分组

- Created: 2026-10-02
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求“把subagent也折叠到一行，然后 Background、Subagent、Thinking、Tools折叠行保持这个顺序相邻，并且始终处于该turn最下方”；随后要求continue。

<!-- task-doc-section:background-goal -->
## Background and goal

每个用户turn只有一个subagent折叠总览，可展开到各agent及原详情。所有存在的活动类别固定按Background → Subagent → Thinking → Tools相邻排列在该turn正文、提示和worked时长之后。晚到回执只更新其原turn，不跨到新turn。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：turn级挂载/边界、subagent聚合与路由、实时/历史重建/快捷键/显示帧点击、定向测试。保留符号及颜色、无标题无首部折叠箭头；不隐藏失败原详情、不变更backend调度、权限、子代理协议。不build、不实模型API、不push；不改其它session内容。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 四组自行移位，Thinking插在assistant之前，Tools及Background追加chat末尾。 | interactive-mode.ts addToolComponentToChat/updateTurnThinking/ensureBackgroundTaskGroup。 |
| F-002 | router按path跨turn持有agent组，每次触碰移到chat末尾。 | components/subagent-group.ts SubagentTranscriptRouter.groupFor。 |
| F-003 | 点击以实际显示帧快照为准，不能为新聚合重新render旧点击目标。 | interactive-mode.ts handleTranscriptContentClick；packages/tui/src/tui.ts rendered metadata。 |
| F-004 | 用户turn边界与历史重建已有统一入口；worked/custom/status可能在活动创建后追加。 | renderUserMessage/renderSessionItems/agent_end/showStatus/addCustomEntryToChat。 |
| F-005 | 当前HEAD baa59d491239e9eddb069add5fe0bc9991b03848，工作区有其它session的LEARNS/candidate/docs/scripts内容。 | git rev-parse HEAD/git status --short，实施前刷新。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 只显示存在的类别，不强行生成四个空行；展开组仍位于尾部固定顺序，详情只在该类别内展开。
- Assumption: 无已知assignment/child turn ID的孤立旧回执只归接收时turn，不猜历史；已知ID始终回到原turn。
- Assumption: turn边界仍按user消息，不把agent内部tool/assistant边界当新turn；willRetry不得提前停滚动。
- Open question: 无阻断实现的决定。全仓check若仍被其它session材料阻断，如实记录，不绕过hooks；沿用本session已确认限定提交边界，不push。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

1. 同turn多个agent折叠时只有一个Subagent总览行，展开保留各agent完整任务/结果/Activity/Diagnostics。
2. 每turn所有活动块严格B/S/Thinking/Tools顺序且相邻；晚正文、独立工具、状态、worked、compaction notice不能插入四组之间或之后。
3. user新turn后老BG更新和旧child回执不移位；同agent新followup属于新parent turn，旧result ID仍能定位旧组。
4. 流式与renderSessionItems/rebuild相同结构；legacy及没有user的恢复内容有合理隐式turn。
5. Ctrl+O及局部选择/真实VirtualTerminal SGR展开/收起继续工作，快照定位不重新读取可变布局；选区、窄屏、turn结束停止滚动不回归。
6. dispose/clear/session swap释放所有旧组/归属，不复用不同session记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002/T-003 → T-004；T-003 → T-005 → T-004。
- Parallel batches: T-002 root负责subagent组件/路由及其测试；T-003 worker负责turn容器/interactive接线、布局测试和其它fixture；固定API后并行，无重叠写文件。
- Serialization constraints: authority文档仅root写；最终集成后独立只读审查，root复测验收；使用当前native spawn，不使用退役DAG。

固定接线合同：
- 新 `TurnTranscriptContainer extends Container`（不override render，以保留Container原生frame offsets）；`currentTurn: object`为不透明稳定token，`beginTurn(): void`切边界；`mountActivity(kind: "background"|"subagent"|"thinking"|"tools", component: Component, owner?: object): void`将组件放到所属turn尾部固定顺序；普通addChild自动保持当前尾部在正文之后。clear重置token/maps。
- 新 `SubagentTurnGroupComponent extends Container`：setExpanded、handleOverviewClick(row,width)、completeTurn、dispose；折叠一行，展开各child原组件。
- Router constructor原container/getExpanded后增加可选 `{getTurn:()=>object,mount:(group:SubagentTurnGroupComponent,owner:object)=>void}`；`groupFor(path)`仍返回当前turn leaf；`currentGroups()`返回所有leaf方便introspection；`turnGroups()`返回外层组。Router按receipt child turn_id保存owner，跨turnmailbox仅更新原组，fallback不猜旧归属。
- `SubagentGroupComponent.overviewLine(width): string`供外层预览，不临时切换expanded；聚合鼠标用child.render返回lines绑定的不可变handler，而不是重新layout。TUI已有getRenderedContentClickHandlers从index追加导出，读元数据不授予权限。
- 缺失原构造字段的fakeMode应更新fixture使用新container，不能通过取消生产instance门来迁就测试。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定turn尾部与聚合接线合同

- Status: done
- Owner: coordinator
- Objective: 固定最小接口与ownership，避免parallel writer互相覆盖。
- Inputs and prerequisites: 用户请求及F-001～F-005；现有TUI metadata实现。
- Scope or files: 本文；packages/tui/src/index.ts仅已有getter再导出。
- Expected output: 上述固定合同、验证矩阵和文件归属。
- Dependencies: None.
- Execution steps:
  1. 检查入口、turn边界、frame元数据与已有受影响测试。
  2. 固定布局不嵌套chat正文，聚合只嵌套subagent子卡片。
- Acceptance criteria:
  - 单owner且合同可支持旧turn回执和不可变点击快照。
- Verification method:
  - 源码检查、task validator。
- Validation evidence: 检查interactive-mode 相关完整方法、Container render/frame metadata及router现状；合同已固定。设计任务，不宣称实现通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Subagent每turn聚合及归属路由

- Status: done
- Owner: coordinator
- Objective: 一个parent turn一个subagent折叠行，旧child回执回原turn。
- Inputs and prerequisites: T-001固定合同。
- Scope or files: packages/coding-agent/src/modes/interactive/components/subagent-group.ts；test/subagent-group.test.ts、subagent-transcript-routing.test.ts、subagent-mouse.test.ts、transcript-category-headers.test.ts；新subagent-turn-group.test.ts；packages/tui/src/index.ts getter导出。
- Expected output: 外层聚合、leaf安全预览、receipt归属、snapshot click；更新subagent fixtures。
- Dependencies: T-001.
- Execution steps:
  1. 保留leaf详情，外层collapsed一行及两级展开。
  2. 按parent token建leaf组，并按child turn/result ID匹配mailbox。
  3. snapshot handler捕获child控制范围；clear清归属。
- Acceptance criteria:
  - 多agent一行，跨turn同agent/followup和旧回执正确；原安全解析/诊断/查询dedup保留。
- Verification method:
  - 定向actor/router/mouse及新聚合tests；VirtualTerminal。
- Validation evidence: Root5个actor/router/aggregate/mouse/category文件143/143通过，新聚合及跨turn/fast result/snapshot7项全通过；真实VirtualTerminal嵌套SGR点击且copySelection=0；scopedBiome7files、全量tsgo通过。Root原leaf安全解析/诊断回归保留。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Turn尾部容器与所有入口接线

- Status: done
- Owner: /root/turn-footer-layout
- Objective: 稳定每turn尾部四类相邻固定顺序，覆盖实时/重建和附加正文。
- Inputs and prerequisites: T-001固定合同；T-002 export按合同并行供应，集成验收等二者齐备。
- Scope or files: 新src/modes/interactive/components/turn-transcript-container.ts；interactive-mode.ts；新test/turn-transcript-container.test.ts、turn-activity-footer.test.ts；background-task-group.test.ts、grok-transcript-components.test.ts、transcript-interaction.test.ts及必要timing/rebuildfixtures；background-task-group.ts仅新增removeTask供晚promotion归属更正保留阅读状态。不改T-002 owned测试。
- Expected output: 稳定container、root边界/挂载/clear/BG ID归属、global/local toggles、历史回放。
- Dependencies: T-001.
- Execution steps:
  1. 普通append与挂载都维护当前/旧turn末尾，保留原render/offsets。
  2. 四类挂载入口用mountActivity，不再独立append或按组件增长移位。
  3. independent工具不再拆出多个Tools组；worked/status等内容在尾部之前。
  4. 旧BG/task ID不误入新turn；clear/session swap清映射，willRetry保持alive。
  5. replay入口使用同一逻辑，fake fixtures显式补构造。
- Acceptance criteria:
  - 乱序到达、多turn、late result、late text/status/worked、replay排序及SGR无回归。
- Verification method:
  - layout/interactive/footer/Background/Grok tests、tsgo、scopedBiome。
- Validation evidence: Root检查container完整源码、interactive接线diff和footer测试；独立运行13个集成文件232/232通过（包含worker所有8文件及晚promotion保留身份/展开详情回归）。修正后removeTask只移除转属ID，不重建剩余组；已验收并关闭writer。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成复测、独立审查及提交

- Status: done
- Owner: coordinator
- Objective: 验证真实消费路径和历史位置，不把writer完成当验收。
- Inputs and prerequisites: T-002、T-003 done。
- Scope or files: owned diff/tests、必要邻近fixtures、本文。
- Expected output: 因果回归/检查记录、owned提交；无关全仓阻断明确标记partial。
- Dependencies: T-002, T-003, T-005.
- Execution steps:
  1. 检查diff并跑两个依赖路径和实际VirtualTerminal鼠标/selector。
  2. 独立fresh read-only审查冻结源码，root验证问题并复测。
  3. npm run check前备份其它文件，确认并精确恢复无关formatter改写；全仓失败单独分类。
  4. 只提交owned文件，不skip hooks、不push。
- Acceptance criteria:
  - 所有本任务目标测试/类型/格式通过；布局截图序列/行类型验证支持固定尾部及跨turn归属。
- Verification method:
  - 定向vitest、全量tsgo、scopedBiome/diff、完整npmcheck、task validator。
- Validation evidence: Root13目标文件232/232，邻近4文件34/34；fresh静态review未发现可操作问题，root检查了报告范围/限制。完整npmcheck格式通过后在无关computer-native材料pin检查失败；全量tsgo、shrinkwrap/install-lock、browser smoke独立通过。18个owned源码/测试文件正常hooks提交2e565d10e；未push。scopedBiome18files无修复，最终tsgo通过；其余外部全仓gate不作为本任务passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 邻近fixture合同修正

- Status: done
- Owner: coordinator
- Objective: 更新仍以普通Container模拟InteractiveMode的status/skill fixtures。
- Inputs and prerequisites: T-003 container变更；邻近4文件运行显示4个fixture TypeError。
- Scope or files: test/interactive-mode-status.test.ts、interactive-mode-skill-mentions.test.ts。
- Expected output: 仅fixture容器更新；不增加生产fallback、不改原断言。
- Dependencies: T-003.
- Execution steps:
  1. 复现旧fixtures缺beginTurn/currentBodyChildren。
  2. 使用生产TurnTranscriptContainer并复测邻近4文件。
- Acceptance criteria:
  - 原status coalescing及skill presentation断言完整保留且通过。
- Verification method:
  - retry/skill/status/context-command定向Vitest。
- Validation evidence: 修正前4/34失败均为旧fixture容器API缺失；修改两个fixture后4文件34/34通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

仅指定文件，faux/VirtualTerminal，无real API、build、npm test或全量vitest。
- coding-agent cwd：`node ../../node_modules/vitest/dist/cli.js --run test/subagent-group.test.ts test/subagent-transcript-routing.test.ts test/subagent-mouse.test.ts test/subagent-turn-group.test.ts test/transcript-category-headers.test.ts`。
- 同cwd：`node ../../node_modules/vitest/dist/cli.js --run test/turn-transcript-container.test.ts test/turn-activity-footer.test.ts test/background-task-group.test.ts test/grok-transcript-components.test.ts test/grok-thinking-mouse.test.ts test/transcript-interaction.test.ts`。
- root：`node_modules/.bin/tsgo --noEmit`、owned `biome check`/`git diff --check`、`npm run check`完整日志及无关变化保护；validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 新分组不能破坏opaque卡片的显示帧控制快照，不能临时改leaf expansion获得preview。
- Root module大，worker读取完整interactive-mode，再修改所有添加路径；避免只调整单一tool回调。
- BG及child异步回执须保留owner映射，未知历史不猜；manager/session替换清理映射。
- fakeMode类/shape变更会影响邻近tests，修fixture不能削弱实际frame命中门。
- 全仓检查已有其它session candidate材料阻断，不能声称全仓passed；4个无关formatter文件需保护。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-02: 用户明确实现要求，刷新HEAD/status并查四组挂载、Root user边界/replay/点击以及TUI元数据。读取相关LEARNS仅鼠标/共享formatter保护。
- 2026-10-02: T-001合同固定done，T-002 root/T-003 worker并行不同文件，本文root独占。不使用退役DAG。
- 2026-10-02: Root实现聚合/router和显示帧嵌套handler，初测96项95通过（剩余旧router断言3顶层卡片应改1聚合行），7项新聚合/跨turn/fast receipt/snapshot tests通过。worker T003首报87项通过，root未直接验收。
- 2026-10-02: root审查发现晚promotion重建provisional BG导致无关阅读状态重置，派必要followup（不是重发）增加removeTask并保留旧组身份；worker新增有限owned scope，root不写其文件。
- 2026-10-02: T-002 done，root5文件143/143、scopedBiome与tsgo通过，含实际SGR嵌套点击无copy。Router旧3卡片断言改为1turn aggregate+3leaf，未删除leaf安全或诊断断言。

- 2026-10-02: 恢复时HEAD41e4ce732；Root复测13文件232/232，T003验收done，writer关闭。T004开始，fresh只读review启动；npmcheck formatter4处已确认hash并恢复，check仍被无关computer-native材料依赖pin阻断，后续gates独立验证。

- 2026-10-02: T005新增并done：邻近4文件首次4处旧fixture TypeError，使用实际TurnTranscriptContainer后34/34通过，无生产降级。freshreview无可操作问题，静态限制保留；13主文件232/232 + 邻近34/34 = 266/266。全量tsgo及两个lock/browser gates通过。仅owned源码提交，不push。

- 2026-10-02: 18个owned源码/测试文件正常提交2e565d10e，无hook bypass；T004 done。外部全仓gate仍阻断，Final partial/Overall blocked。临时formatter备份确认恢复原bytes；未push。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T001～T005全部完成；root17文件266/266、全量tsgo、scopedBiome18files/diff、shrinkwrap/install-lock/browser smoke通过，fresh静态review无可操作问题。实现提交2e565d10e。完整npmcheck运行后在其它session的computer-native材料依赖pin检查失败，故Overall blocked且最终保留partial，不宣称全仓通过。
- Limitations: 不build、不real API、不push，未做物理终端/字体截图验收；VirtualTerminal及render行序列已验证。无receipt旧mailbox不猜原turn，按接收turnfallback。未更改其它session的LEARNS.md；晚promotion阅读状态的因果回归已记录本文，受owned文件边界限制不写learns。
