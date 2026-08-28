# Task Plan: Grok TUI 折叠概览与 Prompt 跳转

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户确认的需求契约（clarify-requirements 共享理解摘要，2026-08-26 当轮确认）

<!-- task-doc-section:background-goal -->
## Background and goal

grok TUI（`pi --tui-engine grok --tui-mode fullscreen`）当前把工具调用、文件编辑 diff、thinking 完整渲染在 transcript 中，user prompt 和 assistant 正文被淹没（用户截图证据）。目标：

1. 工具调用、文件编辑 diff、thinking 默认折叠为一行概览；失败/错误自动展开；运行中显示实时一行状态；单击单行可展开/收起该块，全局快捷键（复用 `app.tools.expand` / Ctrl+O）展开/折叠全部。
2. user prompt 快速跳转定位：快捷键在相邻 prompt 间循环跳转并高亮 + 弹出可筛选 prompt 列表选择跳转。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope（仅限表现层）：

- `packages/coding-agent/src/modes/interactive-grok/`（grok transcript 组件）
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`（仅加法式 hook，legacy 默认行为不变）
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`（键位接线、跳转、点击映射）
- `packages/coding-agent/src/core/keybindings.ts`（新增 app 键位，遵守 AGENTS.md 不硬编码键检查）
- `packages/tui/src/tui-alt-screen.ts`（可选点击回调 hook，加法式）
- 对应测试文件

Non-goals（明确排除）：

- legacy 引擎不改（保持回滚路径原样）
- agent/session/provider/tool 业务语义不改
- 不做可配置折叠开关（固定默认折叠）
- `renderShell: "self"` 的工具块保持完全自渲染，不强制折叠
- 不提交、不发布；不调用真实 provider

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 需求契约已由用户确认：仅 grok 引擎；工具+编辑+思考全折叠、失败展开；跳转=快捷键+列表；展开=点击单行+全局快捷键；运行中实时一行、结束按结果折叠；固定默认折叠 | 本会话 clarify-requirements 流程，用户逐项选择并确认 |
| F-002 | grok transcript 组件位于 `packages/coding-agent/src/modes/interactive-grok/components/`，`GrokToolExecutionComponent` 继承 `ToolExecutionComponent`，collapsed 状态仍渲染完整 body（截图中 COLLAPSED 仍有大卡片） | `grok-tool-execution.ts` render()；`tool-execution.ts` 全文 |
| F-003 | 已有 `Expandable` 接口（`setExpanded`）与 `app.tools.expand`（Ctrl+O）全局切换；`setToolsExpanded` 遍历 `chatContainer.children` 调用 `setExpanded` | `interactive-mode.ts:182-189, 2899, 4153-4172`；`core/keybindings.ts:86` |
| F-004 | thinking 已有折叠机制：`AssistantMessageComponent.hideThinkingBlock` 为 true 时每个 thinking run 渲染一行静态 label（默认 "Thinking..."）；Ctrl+T 全局切换 | `assistant-message.ts:115-141`；`interactive-mode.ts:2900` |
| F-005 | `GrokUserMessageComponent` 继承 `UserMessageComponent`；chatContainer 中 user 消息可用 `instanceof UserMessageComponent` 识别（既有先例 line 4653） | `grok-user-message.ts`；`interactive-mode.ts:655-668, 4653` |
| F-006 | transcript 由 `TuiLayouts.ScrollView`（`follow:"end"`）承载，支持 `scrollTo(scrollTop)`、`scrollTop` getter | `interactive-mode.ts:1048-1056`；`packages/tui/src/components/scroll-view.ts` |
| F-007 | 已有 `UserMessageSelectorComponent`（fork 用，列出 user 消息可选），可复用为跳转列表 | `components/user-message-selector.ts`；`interactive-mode.ts:5016-5051` |
| F-008 | 鼠标左键当前只用于文本选择/URL 打开；release 路径已区分 click（无拖拽）与 drag，并有 `clickedUrl` 先例；无组件级点击分发 | `packages/tui/src/tui-alt-screen.ts:957-1003` |
| F-009 | `ctrl+p` 已被 `app.model.cycleForward` 占用；`ctrl+up`/`ctrl+down` 在 editor/app 键位中未占用 | `core/keybindings.ts`（`app.model.cycleForward`）；`packages/tui/src/keybindings.ts:71-140` |
| F-010 | AGENTS.md 约束：新增键位必须加入 KEYBINDINGS 定义，禁止硬编码键检查；改代码后必须 `npm run check`；测试用 `./test.sh` 或定向 vitest；不擅自运行 `npm run build`/`npm test` | `pi/AGENTS.md` |
| F-011 | 多 session 共享 worktree：`npm run check` 的 biome --write 可能改写他人文件，运行后必须 `git status --porcelain`/`git diff --stat` 核对改动范围 | `pi/LEARNS.md` 第一条 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: prompt 列表键位用 `ctrl+u` 之外的空闲键，候选 `alt+p`（grep 未发现占用）；实现时先验证无冲突，若冲突则换键并在执行日志记录。Impact: 仅影响默认键位。Verify: 实现时 grep 全部 KEYBINDINGS/TUI_KEYBINDINGS。→ 已解决：tmux smoke 发现 `alt+p`（ESC+p）被 pi-tui keys.ts 的 readline 遗留别名表硬编码为 `alt+up`（LEGACY_MODIFIER 序列 `\x1bp → alt+up`），与 `app.message.dequeue` 冲突且先注册者胜；改用 `alt+j`（用 KeybindingsManager.matches 实测 `\x1bj` 无任何 action 命中）。
- Assumption: 跳转用"按当前渲染宽度累计渲染子组件高度"计算组件行偏移，按点击/跳转触发即时计算，长会话性能可接受。Impact: 超长 transcript 跳转可能有可感知延迟。Verify: T-004 实现后在测试与 tmux smoke 中观察；若慢则加缓存（宽度+子组件版本失效）。
- Assumption: 单击判定复用 tui-alt-screen 现有 press/release 无拖拽逻辑（`selectionDragged === false` 且 anchor==focus），与文本选择兼容：点击折叠行触发展开，拖拽仍选择文本。Impact: 若事件序列与预期不符，点击展开可能误触发选择复制。Verify: T-003 的 tui 单测 + tmux smoke。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- grok transcript 中工具调用/编辑 diff 默认渲染为一行概览（状态 · 工具名 · 参数摘要），单击该行可展开/收起；Ctrl+O 可全部展开/折叠。
- 失败的工具调用自动展开详情，不受折叠状态影响。
- 工具运行中显示实时一行状态（RUNNING + 摘要），成功后收为一行。
- thinking 流式时实时显示，回合完成后折叠为一行 label；Ctrl+O 全局切换同样作用于 thinking。
- Ctrl+↑/Ctrl+↓ 在相邻 user prompt 间循环跳转并高亮目标；prompt 列表快捷键弹出可筛选列表，回车跳转到所选 prompt。
- session 恢复后历史块按折叠态渲染；legacy 引擎行为完全不变。
- `npm run check` 通过；定向测试（grok transcript/visual render、tui click hook、跳转）通过；tmux smoke 验证折叠/展开/跳转。
- 改动范围核对：tracked diff 仅含本任务文件（防 biome --write 误改他人文件，依 F-011）。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-003 → T-004 → T-005 → T-006；T-002 → T-003。T-001 与 T-002 互不依赖。
- Parallel batches: 批次1 = [T-001, T-002]（文件不重叠，可并行）；批次2 = T-003；批次3 = T-004；批次4 = T-005；批次5 = T-006。
- Serialization constraints: T-003/T-004/T-005 都修改 `interactive-mode.ts`（且 T-004/T-005 复用 T-003 的行偏移 helper），必须串行。T-006 依赖全部完成。T-001 与 T-002 文件不相交（tool-execution vs assistant-message 链路）。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — grok 工具/编辑块一行概览折叠

- Status: done
- Owner: coordinator
- Objective: `GrokToolExecutionComponent` 折叠态只渲染单行概览（`╭─ TOOL · <STATE> · <toolName> · <args 摘要>`，无 body、无 footer 卡片）；展开态保持现有完整卡片；`isError` 时强制展开；运行中（pending/running/流式 partial）单行实时反映状态变化。
- Inputs and prerequisites: F-002, F-003；`tool-execution.ts` 基类 API（`setExpanded`、`updateResult`、`markExecutionStarted`、`getRenderShell`）。
- Scope or files: `packages/coding-agent/src/modes/interactive-grok/components/grok-tool-execution.ts`；测试 `packages/coding-agent/test/grok-transcript-components.test.ts`、`grok-visual-render.test.ts`（按需）。
- Expected output: 折叠=单行概览（含参数摘要，如 read→路径、bash→命令首行）；展开=现有卡片；错误强制展开；`renderShell:"self"` 透传不变。
- Dependencies: None.
- Execution steps:
  1. 在 `GrokToolExecutionComponent` 增加 collapsed 单行渲染路径与 args 摘要 helper（截断到可用宽度）。
  2. `updateResult`/`markExecutionStarted` 维持状态机；`isError` 覆盖折叠。
  3. 补充/更新定向测试：折叠单行、展开完整、错误自动展开、self-shell 透传、宽度截断（CJK/emoji 安全）。
- Acceptance criteria:
  - 折叠态渲染结果只有 1 行且包含状态/工具名/摘要；展开态与现状一致；error 时渲染完整 body。
- Verification method:
  - `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/grok-transcript-components.test.ts`（在 packages/coding-agent 下）及 visual render 测试。
- Validation evidence: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/grok-transcript-components.test.ts` → 6 passed；`--run test/grok-visual-render.test.ts test/grok-shell-components.test.ts` → 24 passed。实现：collapsed=前导空行+单行概览（状态/工具名/args 摘要，SUMMARY_KEYS 优先、首字符串降级、JSON 兜底不抛错）；isError 强制展开并显示 "ERROR (auto-expanded)" footer；self-shell 透传保留。既有 2 个工具测试按新契约更新（默认折叠断言改为展开后断言）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — grok thinking 默认折叠、流式可见

- Status: done
- Owner: coordinator
- Objective: grok 模式下 thinking 在流式期间实时展开显示，回合结束后折叠为一行 label；组件实现 `Expandable` 使 Ctrl+O 全局切换同时作用于 thinking；legacy 行为不变。
- Inputs and prerequisites: F-003, F-004；`AssistantMessageComponent.hideThinkingBlock` 机制。
- Scope or files: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`（仅加法 hook）、`packages/coding-agent/src/modes/interactive-grok/components/grok-assistant-message.ts`；测试 `grok-transcript-components.test.ts`（按需新增用例）。
- Expected output: grok assistant 消息：streaming 中 thinking 完整可见；非 streaming 时 thinking 折叠为一行（label 含展开提示）；`setExpanded(true/false)` 控制折叠；legacy 默认构造行为逐字节不变。
- Dependencies: None.
- Execution steps:
  1. 在基类增加可选的折叠 label 文本/提示定制点（或确认现有 `hiddenThinkingLabel` 足够），不改动 legacy 默认渲染。
  2. `GrokAssistantMessageComponent`：按 `isStreaming` 动态决定 thinking 展开；实现 `setExpanded` 覆盖（非流式时）。
  3. 定向测试：streaming 展开、完成折叠、setExpanded 切换、legacy 回归（既有 assistant-message 测试保持通过）。
- Acceptance criteria:
  - 非流式 grok thinking 只渲染一行 label；流式中可见；`setExpanded` 生效；既有 `assistant-message` 相关测试全部通过。
- Verification method:
  - 定向 vitest：`grok-transcript-components.test.ts` 及既有 assistant message 相关测试文件。
- Validation evidence: `grok-transcript-components.test.ts` 9 passed（含新增折叠/展开/用户隐藏优先级 3 用例）；`assistant-message.test.ts` + `interactive-mode-grok-components.test.ts` 14 passed。实现：基类新增 protected `setThinkingHiddenSilently`（加法 hook）；grok 子类按 streaming/expanded 动态计算折叠；折叠时省略 THINKING header 避免双行；interactive-mode `createAssistantMessageComponent` 对 grok 组件追加 `setExpanded(toolOutputExpanded)` 保持全局开关一致。偏差记录：label 未加 Ctrl+O 提示（hiddenThinkingLabel 可被扩展定制，尊重既有语义）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 单击折叠行展开/收起该块

- Status: done
- Owner: coordinator
- Objective: grok fullscreen 下，左键单击（press+release 无拖拽、非 URL）落在折叠块概览行时切换该块展开态；拖拽选择文本与 URL 点击行为不变；legacy 不受影响。
- Inputs and prerequisites: T-001、T-002 完成；F-008；ScrollView/selection 代码。
- Scope or files: `packages/tui/src/tui-alt-screen.ts`（可选 `onContentClick` hook）、`packages/coding-agent/src/modes/interactive/interactive-mode.ts`（grok 路径接线 + 行→组件映射 helper `computeTranscriptChildOffsets`）、tui 侧测试、coding-agent 侧映射测试。
- Expected output: 新增 hook 回调（scrollView + 内容行/列）；interactive-mode 将内容行映射到 documentContainer 子组件，若为可折叠 grok 块则 toggle 并 requestRender；helper 供 T-004 复用。
- Dependencies: T-001, T-002
- Execution steps:
  1. tui-alt-screen release 路径：无拖拽、无 URL 且命中 primary ScrollView 时调用可选 `onContentClick`，返回 true 表示已消费（跳过选择复制）。
  2. interactive-mode grok 路径注册回调；实现按当前内容宽度渲染 documentContainer 子组件累计高度的行→组件映射。
  3. 命中可折叠块（grok tool / grok assistant thinking）时切换展开态。
  4. tui 单测（click vs drag vs URL）+ 映射单测。
- Acceptance criteria:
  - 单击折叠行展开对应块，再单击收起；拖拽仍选择并复制；URL 点击仍打开；legacy 路径无行为变化。
- Verification method:
  - packages/tui 定向 node:test / vitest（按该包既有测试方式）；coding-agent 定向测试。
- Validation evidence: `node --test test/tui-alt-screen.test.ts`（packages/tui）→ 44 passed（含新增 2 用例：click 消费跳过 OSC52 复制、drag 不触发且未消费 click 仍走选择复制）；coding-agent `grok-transcript-components.test.ts` 11 passed（新增 handleOverviewClick / handleThinkingLabelClick 用例）；`interactive-mode-grok-components` + `grok-pi-session-port` 8 passed；`npx tsgo --noEmit` 无输出。实现：`TuiAltScreenOptions.onContentClick`（release 无拖拽无 URL 且同行同列时回调，返回 true 则消费）；interactive-mode grok-only 接线 + `computeChatChildOffsets` helper；grok tool/assistant 组件各加点击切换方法。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — Ctrl+↑/↓ 相邻 prompt 循环跳转

- Status: done
- Owner: coordinator
- Objective: 新增 `app.prompt.prev`/`app.prompt.next`（默认 `ctrl+up`/`ctrl+down`），在 grok fullscreen transcript 中相对当前滚动位置跳至上/下一条 user prompt 并滚动定位、短暂高亮目标；到底/到顶循环或提示。
- Inputs and prerequisites: T-003 的行偏移 helper；F-005, F-006, F-009, F-010。
- Scope or files: `packages/coding-agent/src/core/keybindings.ts`、`interactive-mode.ts`、`grok-user-message.ts`（高亮支持，如需）；定向测试；`/help` 键位表更新。
- Expected output: 键位注册进 KEYBINDINGS（可配置）；跳转后 ScrollView 定位到目标 prompt；高亮约 1s 后消退；跟随流式输出的 follow-end 语义不被破坏（用户滚回底部后恢复 follow）。
- Dependencies: T-003
- Execution steps:
  1. keybindings.ts 增加两个 app 键位定义。
  2. interactive-mode 注册 action：枚举 chatContainer 中 `UserMessageComponent` 子组件，用 helper 算偏移，相对 `scrollTop` 找目标，`scrollTo` 定位。
  3. 高亮：grok user message 组件增加临时高亮渲染 + 定时消退。
  4. 更新帮助键位表；定向测试（跳转目标选择逻辑、循环边界）。
- Acceptance criteria:
  - Ctrl+↑/↓ 在多条 prompt 间正确循环定位并高亮；无 prompt 时状态提示不崩溃；legacy 不注册或行为不变。
- Verification method:
  - 定向 vitest；`npm run check`。
- Validation evidence: 新增 `test/grok-prompt-navigation.test.ts` 8 用例通过；`grok-transcript-components.test.ts` 高亮用例通过（合计 18 passed）；`npx tsgo --noEmit` 干净。实现：`app.prompt.prev/next`（ctrl+up/ctrl+down）注册进 KEYBINDINGS；`findPromptJumpTarget` 纯函数（循环 wrap）；GrokUserMessageComponent `setHighlighted`（searchMatchBg _band_，1.2s 消退）；帮助键位表已加行。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — prompt 列表弹出选择跳转

- Status: done
- Owner: coordinator
- Objective: 新增 `app.prompt.list` 键位（默认候选 `alt+p`，实现时验证无冲突），弹出 user prompt 列表（复用/扩展 `UserMessageSelectorComponent` 的跳转模式，不 fork），回车后滚动定位到该 prompt。
- Inputs and prerequisites: T-004 的跳转定位能力；F-007, F-010。
- Scope or files: `core/keybindings.ts`、`interactive-mode.ts`、`components/user-message-selector.ts`（仅加法：jump 模式或复用现有组件+新回调）；定向测试。
- Expected output: 列表显示历史 prompt 摘要（可滚动选择），确认后跳转定位；取消无副作用；与 fork 选择器互不干扰。
- Dependencies: T-004
- Execution steps:
  1. 验证 `alt+p` 未被占用（grep 全部键位定义），冲突则换键并记录。
  2. 复用 `UserMessageSelectorComponent` 增加跳转入口（onSelect → scrollTo 对应 entry 的组件，而非 fork）。
  3. 需要 entryId→组件 的映射：在渲染 user 消息时记录 entryId 关联，或用序号对齐（实现时按代码证据选择，记录在案）。
  4. 定向测试。
- Acceptance criteria:
  - 快捷键弹出列表，选择后正确跳转；空历史有提示；fork 功能不受影响。
- Verification method:
  - 定向 vitest；`npm run check`。
- Validation evidence: 新增 `test/user-message-selector.test.ts` 2 用例（默认 fork 文案不变 + jump 文案覆盖）；`user-message.test.ts` 新增 getText 用例；合计 4 文件 24 passed；tsgo 干净。实现：`app.prompt.list`（alt+p，已 grep 验证无冲突）；UserMessageComponent 加 `getText()`；UserMessageSelectorComponent 加可选 title/description（默认行为不变）；数据源为 chatContainer 中的 UserMessageComponent 实例顺序（合成 index id，不经 session entryId——记录为设计选择：纯表现层导航，不触碰 session 语义）。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 集成验证与改动范围核对

- Status: done
- Owner: coordinator
- Objective: 全量静态门禁 + 定向测试 + tmux smoke + 改动范围核对，确认契约验收标准全部满足。
- Inputs and prerequisites: T-001 至 T-005 全部 done。
- Scope or files: 无新增代码；任务文档证据更新。
- Expected output: 验证证据记录到各任务与本节。
- Dependencies: T-001, T-002, T-003, T-004, T-005
- Execution steps:
  1. `npm run check`（全量输出），随后 `git status --porcelain`/`git diff --stat` 核对改动范围（F-011）。
  2. 定向跑全部触及的测试文件。
  3. tmux smoke：`pi --tui-engine grok --tui-mode fullscreen`，验证折叠单行、点击展开、Ctrl+O、Ctrl+↑/↓、prompt 列表、`/quit` 恢复。
  4. legacy 冒烟：`pi --tui-engine legacy` 外观行为不变。
- Acceptance criteria:
  - 上述全部通过；改动范围仅含本任务文件；任务文档 validator 通过。
- Verification method:
  - 本节步骤命令与结果记录。
- Validation evidence: (1) `npm run check` 全链路 exit 0（biome 修 3 个文件均为本任务文件；pinned-deps/ts-imports/shrinkwrap/install-lock/tsgo/browser-smoke 全过）。(2) 定向测试：coding-agent 10 文件 81 passed；tui `node --test test/tui-alt-screen.test.ts` 44 passed。(3) 改动范围核对：check 前后 `git status --porcelain` 快照 diff 为空；近 5 分钟修改文件全部属于本任务。(4) `npm run build:offline` exit 0（tmux smoke 前提，契约已含 smoke 授权）。(5) tmux smoke（grok，构造含 thinking/成功工具/失败工具的 3-prompt session 恢复）：折叠单行 `╭─ TOOL · SUCCESS · read · /tmp/README.md` ✓；错误工具自动展开 `╰─ ERROR (auto-expanded)` ✓；thinking 折叠 "Thinking..." ✓；Ctrl+↑/↓ 相邻跳转 ✓；Alt+J 弹出 Jump to Prompt 列表并回车跳转 ✓；单击折叠行展开、单击 header 收起 ✓；单击 thinking label 展开 ✓；拖拽选择文本不受影响 ✓；/quit 恢复终端 ✓。(6) legacy 冒烟：thinking 完整展开、无 grok chrome，行为不变 ✓。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 每个实现任务：定向 vitest（coding-agent 用 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <file>`，在包目录下执行）；tui 包按其既有 node:test 方式。
- 遵循 AGENTS.md：不跑 `npm run build`/`npm test`；不直接跑全量 vitest；`./test.sh` 仅在需要全仓回归时使用。
- 最终：`npm run check` + `git status --porcelain` 范围核对 + tmux 真实终端 smoke（grok 与 legacy 各一次）。
- 测试主题样式断言必须用零宽 ANSI 包装（LEARNS.md 教训），禁止可见标记。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- R-1（T-003）：renderer 层点击 hook 可能干扰文本选择复制。缓解：只在无拖拽 click 且命中可折叠行时消费事件；单测覆盖 click/drag/URL 三分支。
- R-2（T-004/T-005）：超长 transcript 全量渲染计算偏移的性能。缓解：按需计算；若 smoke 中可感知再加缓存。
- R-3（T-001）：折叠单行需从各类工具 args 提取摘要；未知结构降级为工具名+首键截断，不得抛错。
- R-4：`npm run check` biome --write 误改共享 worktree 他人文件（LEARNS.md 已验证发生过的教训）。缓解：运行后立即核对 diff 范围。
- R-5：`renderShell: "self"` 工具块不参与折叠，其内部高度仍可能很大——契约已明确排除，不处理。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 任务文档创建；clarify-requirements 契约确认（范围/折叠策略/跳转交互/展开方式/运行中行为/固定默认）。
- 2026-08-26: 完成只读侦察（F-001~F-011），确定依赖图与并行批次；文档填充完毕待校验。
- 2026-08-26: validator 通过。批次1启动：T-001/T-002 标记 in_progress，经 subagent DAG 并行委托（文件不相交）。
- 2026-08-26: DAG run fa5f95b9 启动即失败，resume 重试仍失败：T-001 task_inconclusive（未落盘），T-002 403 并发限额。T-001/T-002 标记 blocked，等待用户决策执行策略。
- 2026-08-26: 用户授权协调者串行执行。T-001 解除 blocked → in_progress（Owner: coordinator），T-002 回 pending（Owner: coordinator），后续任务全部串行由协调者执行。
- 2026-08-26: T-001 完成并验证（6+24 定向测试通过），标记 done；T-002 → in_progress。
- 2026-08-26: T-002 完成并验证（9+14 定向测试通过），标记 done；T-003 → in_progress。T-002 偏差：触碰了 interactive-mode.ts 一行接线（createAssistantMessageComponent），原计划属 T-003+ 范围，已在 Scope 记录。
- 2026-08-26: T-003 完成并验证（tui 44、coding-agent 11+8 定向通过，tsgo 干净），标记 done；T-004 → in_progress。
- 2026-08-26: T-004 完成（导航纯函数 8 用例+高亮用例通过，tsgo 干净），标记 done；T-005 → in_progress（串行）。
- 2026-08-26: T-005 完成（4 测试文件 24 passed，tsgo 干净），标记 done；T-006 → in_progress。注：T-004 期间曾将 promptPrev/promptNext 帮助文本先于 const 声明写入导致 tsgo 报错，已当轮修复。
- 2026-08-26: T-006 smoke 中发现 alt+p 与 readline 遗留别名冲突（ESC+p=alt+up→dequeue），改默认键为 alt+j，重建后全部 smoke 通过。T-006 标记 done；最终验证 passed。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001~T-006 全部 done；任务文档 validator 通过；`npm run check` exit 0；定向测试 coding-agent 81 + tui 44 全过；tmux smoke（grok 折叠/展开/点击/跳转/列表 + legacy 回归）全部通过；改动范围核对无越界。
- Limitations: 未对真实 provider 做流式 TTY smoke（契约禁止真实调用）；运行中"实时一行状态"的动画观感仅经单元与静态验证；点击展开仅验证 macOS 本机 tmux，未测其他终端仿真器。

## Post-validation keybinding correction

- macOS 物理键复验推翻了原键位结论：Alt+J 的 tmux smoke 只合成了 `ESC+j`，未覆盖 Option+J 常见的 `∆` 输入；Ctrl+↑/↓ 被 Mission Control 抢占。
- 用户确认新默认键位：Shift+PageUp/PageDown 跳转相邻 prompt，F6 打开 Jump to Prompt。
- `grok-prompt-navigation.test.ts` 对新终端序列建立回归；定向 5 files / 25 tests 与 `npx tsgo --noEmit` 通过。此前文档中的 Alt+J、Ctrl+↑/↓ smoke 结论仅保留为历史记录，由本节取代。
- 后续真实复验又发现 plain `pi` 默认 regular 模式没有挂载 transcript ScrollView，按键虽命中但无法移动 scrollback。修复为 grok regular 首次触发 prompt 导航时自动切到 fullscreen；构建后用 22-prompt session 从 regular 实测上一条跳转与 F6 列表通过。
- 最新 UX 变更取代原错误自动展开契约：错误工具默认保持红色 `✕` 单行折叠，用户点击后展开详情，再点 header 收起；5 个相关文件 44 tests、Biome、tsgo 与 build 通过。
