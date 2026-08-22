# Task Plan: Grok TUI 视觉与组件迁移

- Created: 2026-08-22
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求执行视觉迁移方案，重写 view/component 层，同时保留 Pi agent、session、工具和扩展语义。

<!-- task-doc-section:background-goal -->
## Background and goal

上一轮已加入 `--tui-engine legacy|grok`、Grok action/reducer/render runtime 和 `PiSessionPort`，但两个引擎仍挂载同一棵 Pi `InteractiveMode` 组件树，所以可观察外观基本一致。本轮在 coding-agent 内新增 Grok 专属 `InteractiveView + ComponentFactory`，重写全屏 shell、消息、工具、编辑器 chrome、状态与快捷键呈现；Pi 继续唯一拥有 agent loop、provider、session、tool hook、extension lifecycle 和持久化。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 为 Grok engine 建立独立、可测试的 view/component 层和明确视觉签名。
- 重写 top bar、transcript message blocks、tool cards、activity/status、boxed composer、model/context info 和 shortcuts bar。
- 将 Grok view 接入现有 `InteractiveMode` 的 slots、stream/tool 更新、history restore 和 extension UI 宿主。
- 保留 legacy 外观与行为，保留 Pi `Component/TUI/EditorComponent` 扩展 ABI。
- 增加确定性 render golden、engine-neutral 语义断言、尺寸/theme/CJK/overlay 回归和真实 tmux 烟测。

### Non-goals

- 不移植 grok-build 的 Rust agent、ACP/session/auth/MCP/permission 实现，不复制其非平凡源码或资产。
- 不修改 Pi provider、agent loop、工具协议、session schema 或扩展语义。
- 不把 Pi 当前不存在的“逐工具审批状态”伪造成 view 状态；仅保留并重绘 extension `ui.confirm`/trust 等现有确认语义。
- 不删除 legacy TUI，不提交、不发布、不调用付费 provider。
- 首版不重写全部 selector、Markdown/image/Mermaid 和第三方 extension component；它们由 Grok shell 兼容宿主。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 Grok engine 只替换 renderer，仍挂载与 legacy 相同的组件树。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:376-426,628-654,943-972`; `packages/grok-tui/src/grok-tui-runtime.ts:25-35,72-87` |
| F-002 | Pi fullscreen 是 transcript `ScrollView` 加固定 dock；这是安全的 view/layout 替换边界。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:943-972` |
| F-003 | streaming 和 tool 生命周期由 `InteractiveMode` 原地更新 message/tool components，toolCallId 是关联键。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3222-3365` |
| F-004 | 扩展 UI 依赖进程内 `Component/TUI/EditorComponent`、header/footer/widget/status/overlay/custom editor 和 tool renderer ABI。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2434-2485`; `packages/coding-agent/src/core/extensions/types.ts:125-245,464-497` |
| F-005 | 稳定 TUI proxy 和 renderer switch 会保留组件对象、focus 和 extension 引用。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:429-457,868-917` |
| F-006 | Pi 主题经 registry/controller/global proxy 驱动，并在变化时 invalidate 全树；Grok 组件应消费现有语义 token。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:660-667,983-984,1067-1072`; `packages/coding-agent/src/modes/interactive/theme/theme.ts:606-668,840-857` |
| F-007 | Pi 当前工具阻断来自 extension `tool_call` hook，通用确认 UI 是 `ExtensionUIContext.confirm`；不存在独立 Grok/ACP approval event。 | `packages/coding-agent/src/core/agent-session.ts:481-500`; `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2434-2485,2547-2553`; `packages/coding-agent/src/modes/interactive-grok/pi-session-events.ts:15-130` |
| F-008 | grok-build 的可见结构包含 full-screen top/status bars、user band、boxed prompt、`❯`、model/mode info、shortcuts 和分层 tool blocks。 | `../grok-build/crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs:9-18,144-191`; `../grok-build/crates/codegen/xai-grok-pager/src/scrollback/blocks/user.rs:197-277`; `../grok-build/README.md` product screenshot |
| F-009 | 现有测试只证明 engine/lifecycle/resize/compatibility，没有 Grok 视觉差异 oracle；Pi VirtualTerminal 可作为确定性 golden 基座。 | `packages/coding-agent/test/interactive-tui.test.ts:42-201`; `packages/grok-tui/test/runtime.test.ts:26-133`; `packages/tui/test/virtual-terminal.ts:8-48,107-184` |
| F-010 | 工作树已有上一轮未提交迁移和用户未跟踪文件，本轮必须只追加范围内改动。 | 2026-08-22 `git status --short --branch`; 前置任务 `docs/tasks/2026-08-22-grok-tui-port-task.md` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “视觉迁移”以 grok-build 当前产品截图与源码结构为设计参考，采用 clean-room TypeScript 重实现，不追求字符级复制。
- Assumption: `--tui-engine grok` 在用户未显式设置 `--tui-mode` 时可默认 fullscreen；显式 mode 和 settings 仍受尊重。
- Assumption: 第三方 extension component 保持 Pi 原生内部呈现，但必须嵌入 Grok slots 且 focus/input/lifecycle 不退化。
- Open question: 未提供真实第三方扩展集合和多种终端实机；以仓库 fixture、VirtualTerminal 和当前 tmux 为最低证据，外部兼容性列为限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `pi --tui-engine grok` 在 80x24 可观察到与 legacy 不同的 Grok top bar、user band、assistant/thinking hierarchy、tool card、boxed composer、info/status/shortcuts；至少存在不依赖 ANSI 颜色的稳定正向视觉签名。
- 同一 stream/tool/history/extension fixture 在 legacy/grok 下的输入文本、event 顺序、toolCallId、工具结果、审批决定、session 操作、extension callback 和 focus 语义一致。
- Grok view 不持久化业务状态，不直接调用 provider/tool executor，不更改 session schema；`PiSessionPort` 和现有 `InteractiveMode` 仍是业务事件/命令边界。
- extension header/footer/widget/status/custom component/custom editor/overlay/theme/tool renderer 继续可用；legacy 路径无视觉或行为变更。
- 40x8、80x24、120x36 resize，streaming 中间态，tool success/error，confirm allow/deny，history restore，dark/light，CJK/emoji 和 overlay 有自动化证据。
- 修改测试、相关回归、`./test.sh`、`npm run check`、`npm run build:offline` 和真实 tmux smoke 通过；未运行的项目不得记为已验证。
- 本文档 validator 通过，只有拥有实际证据的任务才标记 done。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002, T-003}`; `{T-002, T-003} -> T-004 -> T-005 -> T-006`.
- Parallel batches: T-002 独占 Grok shell/chrome/factory 文件；T-003 独占 transcript/tool components 和 component tests；完成后由 coordinator 串行接入 `InteractiveMode`。
- Serialization constraints: `interactive-mode.ts`、CLI/default-mode 行为、root/package manifests/locks、公共 exports 和本文档由 coordinator 独占；subagent 不编辑本文档，也不回退其他人的工作树改动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 冻结视觉契约与语义基线

- Status: done
- Owner: coordinator
- Objective: 固化 Grok 正向视觉签名、可复用 Pi ABI 和 legacy/grok 语义等价账本。
- Inputs and prerequisites: 当前源码、两侧 `.edru`、grok-build view 源码/README 截图、现有回归测试。
- Scope or files: 本文档、只读基线命令；不修改生产代码。
- Expected output: 可并行实现的 view/factory 接口、视觉 oracle、基线结果。
- Dependencies: None.
- Execution steps:
  1. 运行 interactive renderer、tool、editor、theme、session-port 和 TUI resize 基线。
  2. 固定 `InteractiveView` slots 与 `InteractiveComponentFactory` 返回契约。
  3. 固定三类 oracle：Grok positive signatures、render golden、engine-neutral semantic ledger。
- Acceptance criteria:
  - 基线结果有实际命令/数量证据或记录现存 blocker。
  - T-002/T-003 文件所有权无重叠，公共接口可独立实现。
- Verification method:
  - 定向 Vitest/Node tests；task document validator。
- Validation evidence: `packages/tui` 定向 Node tests 通过 76/76，覆盖 fullscreen dock/scroll/overlay/focus、resize/diff render、CJK/emoji；`packages/grok-tui` runtime tests 通过 6/6；`packages/coding-agent` 的 interactive renderer、PiSessionPort、tool component、custom editor history、theme controller 定向 Vitest 通过 5 files/48 tests。接口冻结为 coding-agent 内的 engine-aware `InteractiveView + ComponentFactory`，T-002/T-003 文件所有权互斥；oracle 固定为 positive signatures、render golden、semantic ledger 三类。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 Grok view shell 与交互 chrome

- Status: done
- Owner: worker-grok-shell
- Objective: 实现 Grok 专属 layout、top bar、activity/info/footer、shortcuts 和 boxed editor 宿主。
- Inputs and prerequisites: T-001 接口；Pi `Component/TUI/EditorComponent`；grok-build view 结构证据。
- Scope or files: `packages/coding-agent/src/modes/interactive-grok/grok-interactive-view.ts`、`grok-component-factory.ts`、`components/grok-{top-bar,footer,editor-frame,status}.ts` 及独占单元测试；不改 `interactive-mode.ts`。
- Expected output: 可由 coordinator 注入的 Grok view/factory，40 列降级布局和明确 signature。
- Dependencies: T-001.
- Execution steps:
  1. 定义 view slots、regular/fullscreen roots、mount/focus/dispose。
  2. 实现 cwd/context top bar、boxed composer、model/thinking/status 和 shortcuts。
  3. 宿主 custom editor/header/footer/widget slots，不吞 input/focus。
  4. 增加 40/80/120 列 render tests。
- Acceptance criteria:
  - Grok shell 无 agent/session/provider/tool 依赖。
  - narrow layout 不越宽；组件不含未清理 timer/watcher。
  - positive signature 和固定尺寸 render tests 通过。
- Verification method:
  - 定向运行新增 view/component tests 和 Biome。
- Validation evidence: 新增 Grok top bar/status/rounded editor frame/shortcuts footer、`GrokComponentFactory` 和同时提供 regular/fullscreen mount structures 的 `GrokInteractiveView`。editor frame 包裹通用 Component host，不接管内部 editor/selector/extension input focus。定向 Vitest 5/5、root `tsgo --noEmit` 和 7 文件 targeted Biome 均通过；40/80/120 列宽度与无 timer 断言通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实现 Grok transcript 与 tool components

- Status: done
- Owner: worker-grok-transcript
- Objective: 重写 user/assistant/thinking/tool 的可见层级，同时保持旧更新方法和 extension tool renderer ABI。
- Inputs and prerequisites: T-001 契约；Pi message/tool component API；grok-build scrollback/tool 结构证据。
- Scope or files: 独占 `packages/coding-agent/src/modes/interactive-grok/components/grok-{user-message,assistant-message,tool-execution}.ts` 及 `test/grok-transcript-components.test.ts`；不改 component factory、`interactive-mode.ts` 或其他测试。
- Expected output: 可替换现有 component creation sites 的类型兼容组件和 streaming/tool 状态测试。
- Dependencies: T-001.
- Execution steps:
  1. 实现带 timestamp/accent 的 user band 和 assistant/thinking hierarchy。
  2. 实现 pending/success/error、collapsed/expanded 的 tool card chrome。
  3. 保留 `updateContent`、tool partial/result/expand/image/custom render 行为。
  4. 增加 streaming 中间态、toolCallId、CJK/emoji 和宽度测试。
- Acceptance criteria:
  - 不复制 tool/session 状态，不绕开 extension `renderCall/renderResult`。
  - streaming 和 tool 原地更新 API 与 `InteractiveMode` 调用兼容。
  - Grok message/tool signatures 与 golden 通过。
- Verification method:
  - 新组件测试、既有 `tool-execution-component.test.ts` 和 targeted Biome。
- Validation evidence: 新增 Grok user/assistant/tool subclasses，通过继承保留 Pi constructor/update/stream/image/extension renderer ABI；定向及既有 component Vitest 通过 4 files/43 tests，root `npx tsgo --noEmit` 通过，targeted Biome 通过。测试覆盖 40/80/120 宽度、streaming 中间态、tool pending/running/success/error、collapsed/expanded、自定义 renderer、CJK/emoji 和稳定非 ANSI signatures。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 接入 InteractiveMode 并保留 Pi 语义

- Status: done
- Owner: coordinator
- Objective: 按 engine 注入 view/factory，接线主布局、stream/tool/history、editor/status/footer 和 extension slots。
- Inputs and prerequisites: T-002, T-003 产物；现有 `PiSessionPort`、stable TUI proxy 和 extension UI context。
- Scope or files: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`、`packages/coding-agent/src/modes/interactive-grok/**` 必要 exports、相关 integration tests；manifest 仅在确有必要时改。
- Expected output: `--tui-engine grok` 真正使用新组件树；legacy 路径保持原组件与默认 mode。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 建立 engine-aware component creation 和 view mount/switch。
  2. 将 stream/tool/history component creation sites 路由到 factory。
  3. 将 extension header/footer/widget/custom editor/overlay 继续挂入 Pi ABI slots。
  4. 验证 session-port event 顺序、confirm/trust、theme invalidate 和 renderer switch。
- Acceptance criteria:
  - Grok 可见组件全部经 factory，legacy output 未改变。
  - agent/session/tool/extension 公共协议和存储文件无修改。
  - mode switch、session restore、custom editor/overlay focus 不退化。
- Verification method:
  - Grok integration/semantic tests及既有 interactive/session/extension/theme 回归。
- Validation evidence: `InteractiveMode` 仅在 `tuiEngine === "grok"` 时创建 `GrokInteractiveView`，regular/fullscreen root、top bar、editor host、extension slots 和 Grok message/tool subclasses 已接线；legacy 仍创建原 Pi components。新增 routing test 验证 Grok/legacy 选择与 Pi base ABI。相关 Vitest 首批 9 files/92 tests 通过；compaction/session restore、extension input/status/theme/PiSessionPort 回归 5 files/56 tests 通过；root `tsgo --noEmit` 和 13 文件 targeted Biome 通过。一次 partial-context 回归测试暴露无条件 helper 调用，已改为仅在 Grok view 存在时刷新并复跑通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 建立视觉 golden 与最小验证矩阵

- Status: done
- Owner: coordinator
- Objective: 用确定性 fixtures 同时证明视觉有意不同和业务语义相等。
- Inputs and prerequisites: T-004 可运行集成。
- Scope or files: `packages/coding-agent/test/grok-visual-*.test.ts`、`test/fixtures/grok-visual/**`，必要时只读复用/最小扩展 VirtualTerminal helper。
- Expected output: positive signatures、text/styled golden、semantic ledger 和 40/80/120 尺寸矩阵。
- Dependencies: T-004.
- Execution steps:
  1. 建立 user/assistant/stream/tool/confirm/restore/extension/CJK fixture。
  2. 对 idle、stream、tool、confirm、restore、extension 保存少量稳定 golden。
  3. 比较 legacy/grok engine-neutral semantic ledger。
  4. 覆盖 resize、dark/light、overlay、CJK/emoji。
- Acceptance criteria:
  - 三类 oracle 同时通过；不得仅以 `grok !== legacy` 验收。
  - golden 不包含不稳定时间、绝对临时路径或 raw 全量 ANSI。
  - 失败能指出 layout、style 或 semantic regression。
- Verification method:
  - 定向运行新增 visual tests 及相关 TUI/component regressions。
- Validation evidence: 新增固定 40-column shell golden、Grok positive signatures、Pi inline confirm/custom editor host mutation、dark/light plain-layout-equal/style-different oracle；shell/transcript tests 另覆盖 40/80/120、stream、tool states、CJK/emoji。合并定向 coding-agent matrix 通过 13 files/120 tests；Pi VirtualTerminal/TuiAltScreen resize/diff/overlay/CJK/emoji 通过 76/76；16 文件 targeted Biome 通过。PiSessionPort、tool/extension renderer、compaction restore、extension input/status/theme/history tests 共同作为 semantic ledger，未仅以输出不相等验收。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 全量验证、真实 TTY 烟测与交付审查

- Status: done
- Owner: coordinator
- Objective: 完成构建、测试、真实终端、回滚和整体 diff 的最终证据闭环。
- Inputs and prerequisites: T-005 全部 oracle 通过。
- Scope or files: 本轮全部 diff、本文档和验证记录；仅修范围内问题。
- Expected output: 完整验证证据、无未解决 P0/P1、清晰限制与 legacy 回滚方法。
- Dependencies: T-005.
- Execution steps:
  1. 运行修改测试和相关回归、`./test.sh`、`npm run check`、`npm run build:offline`。
  2. tmux 中对 legacy/grok 80x24 启动、local input/extension confirm、resize 100x30、session restore/退出，并捕获 Grok signature。
  3. 审查 diff/status、许可证、schema/protocol、用户文件和 global linked CLI。
  4. 更新本文档并运行 validator。
- Acceptance criteria:
  - 所有必需 gate 退出 0，tmux 捕获能证明 Grok visual signatures 和终端恢复。
  - legacy 回滚命令可用，未改 session schema/provider/tool protocol。
  - 无意外用户文件变更，无未解决 P0/P1。
- Verification method:
  - 记录实际命令、exit code、测试数量和限制；task document validator。
- Validation evidence: 最终 `npm run check` 退出 0（Biome 1099 files、pinned deps/imports/shrinkwrap/install-lock、`tsgo --noEmit`、browser smoke）；最终 `./test.sh` 退出 0，其中 coding-agent 229 files passed/6 skipped、1973 tests passed/49 skipped，其他 workspace 也通过；`npm run build:offline` 退出 0。全仓测试曾两次命中既有 `footer-data-provider` reftable `fs.watch` 超时，单测隔离复跑 8/8 且最终全仓复跑通过，未改无关 watcher。真实 tmux 已验证 Grok 80x24 启动、`/debug`、本地 `!echo visual-smoke`、100x30 resize、40x8 生存与 composer 三行、`/quit` 终端恢复；legacy 80x24 外观与回滚命令可用。真实 extension smoke 证明 `setStatus()` 文本可见，custom footer 启用时替换 Grok shortcuts footer、关闭时恢复。全局 linked `pi` 解析到本工作区 dist，Grok signature 启动通过。对抗审查最初发现 footer/status、重复 working、极小高度和 `renderShell: "self"` 四项兼容问题，均修复并加回归；最终复核无 P0/P1，随后又修复 `setWorkingVisible(false)` 不应隐藏 retry 的条件性 P2 并新增断言。`git diff --check` 和任务文档 validator 通过。未调用 provider；streaming/tool/confirm/session/theme 由确定性 fixtures 和既有回归验证。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Baseline: renderer/session-port/tool/editor/theme/extension 与 TUI resize/CJK tests。
2. Visual component: 40x8、80x24、120x36 的 shell/message/tool positive signatures 和稳定 golden。
3. Semantics: stream event order、toolCallId/result/approval decision、input/history/focus、session restore 和 extension callbacks 在两引擎下等价。
4. Theme/terminal: dark/light、truecolor/256、resize storm、overlay、CJK/emoji 和无残影。
5. Repository gates: 修改测试、相关回归、`./test.sh`、`npm run check`、`npm run build:offline`、`git diff --check`。
6. Real TTY: 全局 linked `pi` 的 legacy/grok 80x24→100x30 启动、输入、confirm/extension、恢复和退出；不调用 provider。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- `InteractiveMode` 约 6500 行且创建组件的路径分散；使用单一 factory 收口，不复制第二个交互主类。
- extension components 使用 Pi ABI 并可能自行绘制；Grok shell 只提供 slot/chrome，不能无损改写第三方内部布局。
- theme schema 是公共扩展面；首版复用现有语义 token，避免新增必填 token 破坏 custom themes。
- regular/fullscreen switch、overlay focus 和 terminal restore 易回归；保留 stable TUI proxy，并用 VirtualTerminal+tmux 双层验证。
- tool approval 不是 Pi 内建协议；仅验证 extension `tool_call + ui.confirm`，若需逐工具原生审批必须另立业务任务。
- grok-build 是 Apache-2.0；本轮只参考行为/布局结构并 clean-room 重实现，不复制源码/asset，避免 NOTICE/衍生许可义务扩大。
- `npm run check` 可能格式化写入；执行前后审查 diff，仅保留范围内机械变化。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-22: 创建本轮唯一 execute-mode authority document；完成两侧 `.edru`、当前源码、grok-build view 和验证基础设施的只读证据采集。
- 2026-08-22: T-001 started；冻结视觉 signature、view/factory seam 和定向基线命令。
- 2026-08-22: T-001 done；三组基线均退出 0（TUI 76/76、Grok runtime 6/6、coding-agent 48/48），未发现现存 blocker。
- 2026-08-22: T-002/T-003 started in parallel；shell/factory 与 transcript/tool components 采用互斥文件所有权，coordinator 保留 `interactive-mode.ts` 和任务文档。
- 2026-08-22: T-003 done；三个 Grok transcript/tool components 保留原更新 ABI，组件相关 43 tests、typecheck 和 Biome 均通过。
- 2026-08-22: T-002 done；Grok shell/factory 的 5 tests、typecheck 和 Biome 通过，通用 editor host seam 保留所有 Pi inline UI 替换路径。
- 2026-08-22: T-004 started；coordinator 开始串行接入 `InteractiveMode`、Grok-only component factory 和 extension slots。
- 2026-08-22: T-004 done；engine-aware root/factory/message/tool/status/footer 接线完成，routing/restore/extension/theme 相关回归通过。
- 2026-08-22: T-005 started；补充固定宽度 shell golden、theme/style oracle 和 extension host mutation 视觉断言。
- 2026-08-22: T-005 done；视觉 golden/signature/theme/host oracle 与 120 + 76 个相关测试通过。
- 2026-08-22: T-006 started；进入全量 tests/check/offline build、真实 tmux 和最终 diff/许可审查。
- 2026-08-22: 对抗审查发现 extension footer/status 契约、working 重复、composer 最小高度和 self-shell framing 问题；以单一 status slot、可替换/可读 extension status 的 Grok footer、editor `minSize: 3` 和 self-shell passthrough 修复，新增回归测试。
- 2026-08-22: 真实 extension smoke 证明 `setStatus` 可见且 custom footer 能替换/恢复；40x8 真终端保留完整 composer，进程存活并正常退出。
- 2026-08-22: 最终复核无 P0/P1；追加修复 `setWorkingVisible(false)` 不隐藏 active retry，并以定向回归覆盖。
- 2026-08-22: T-006 done；最终 check、全仓 test、offline build、tmux/global CLI、diff check 和 task validator 完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 视觉 view/component 重写、Pi 语义保留、legacy 回滚和验证矩阵均达到验收标准。最终门禁：`npm run check` exit 0；`./test.sh` exit 0；`npm run build:offline` exit 0；coding-agent 1973 passed/49 skipped；真实 Grok/legacy/global linked CLI/40x8/resize/local command/extension status/custom footer/terminal restore smoke 通过；最终只读对抗复核无 P0/P1；`git diff --check` 与本文档 validator 通过。限制：未调用真实 provider，故真实网络流式响应未做 TTY smoke；未提供外部第三方 extension corpus 或多终端设备矩阵，相关结论来自仓库 fixtures、examples、VirtualTerminal 和当前 tmux。
- Limitations: 真实第三方扩展集和多终端设备未提供；当前计划以仓库 fixtures、VirtualTerminal 和本机 tmux 为最低验证边界。
