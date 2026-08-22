# Task Plan: 将 grok-build TUI 移植到 Pi

- Created: 2026-08-22
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求“按照推荐方案，编写 task 并执行，完成 TUI 移植”。

<!-- task-doc-section:background-goal -->
## Background and goal

Pi 当前由 TypeScript `InteractiveMode` 直接驱动 `@earendil-works/pi-tui` 组件树。grok-build 的 Rust TUI 使用 Action → Reducer → State → View → Frame Diff 边界，但其 Agent/ACP/session/permission 语义与 Pi 不兼容。本任务在 Pi 内实现可运行的 Grok 风格 TypeScript 表现层引擎，保留 Pi 的 agent loop、provider、工具协议、会话存储和扩展语义，并保留 legacy 回滚路径。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 新增 TypeScript Grok TUI 内核：action/state/reducer/effect queue、frame scheduling、resize coalescing 和终端能力状态。
- 将新引擎接入 Pi interactive mode，通过 `legacy|grok` 引擎选择保留回滚。
- 保留现有 `Component`/`TUI`/`EditorComponent` 作为扩展兼容 ABI，不改 session schema。
- 增加 reducer、scheduler、CLI、session/event、extension 兼容和 tmux 烟测证据。
- 更新必要的 manifest/lock/build 接线，不提交、不发布。

### Non-goals

- 不修改 `../grok-build` 或嵌入其 Rust agent/shell/ACP/session/auth/MCP 栈。
- 不修改 Pi provider、agent loop、工具执行协议或 session 持久化格式。
- 不删除 legacy TUI 或 `@earendil-works/pi-tui` 扩展 ABI。
- 不调用付费 provider，不进行生产变更。
- 不要求首版对 grok-build 所有视觉细节字符级复制；优先完成结构、交互和终端行为移植。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | Pi CLI 在 `main.ts` 中构造 `InteractiveMode`。 | `packages/coding-agent/src/main.ts:917-961` |
| F-002 | Pi extension UI 进程内传递 `TUI`、`Component` 和 custom editor 工厂。 | `packages/coding-agent/src/core/extensions/types.ts:125-245` |
| F-003 | Pi RPC 不支持 raw input、component widget、custom header/footer/UI/editor，不是保真 sidecar 边界。 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts:163-215,228-283` |
| F-004 | Pi 工具阻断/审批由 extension `tool_call` 前置钩子完成，不是 ACP permission。 | `packages/coding-agent/src/core/agent-session.ts:481-501`; `packages/coding-agent/README.md:494-504` |
| F-005 | `Component` 契约是 `render(width)`、`handleInput` 和 invalidate，可被新引擎宿主。 | `packages/tui/src/tui.ts:23-46` |
| F-006 | grok-build dispatch 明确分离同步状态更新与 I/O effects。 | `../grok-build/crates/codegen/xai-grok-pager/src/app/dispatch/mod.rs:1-10`; `app/actions.rs:1-40,1415-1478` |
| F-007 | grok-build 使用事件批处理、resize debounce 和 frame diff。 | `../grok-build/crates/codegen/xai-grok-pager/src/app/event_loop.rs:2351-2597`; `../grok-build/crates/codegen/xai-grok-pager-render/src/render/draw.rs:430-521` |
| F-008 | 开始时 Pi tracked diff 为空；已有未跟踪 `.edru/` 和 Markdown 不属于本任务。 | 2026-08-22 `git status --short --branch`; HEAD `59a71b235dadb4ad0d67557a8abb0aaa093e68b4` |
| F-009 | 仓库要求改代码后运行 `npm run check`，改过的测试必须定向运行；用户已明确授权执行。 | `AGENTS.md:31-44`; 当前用户请求 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “按照推荐方案”授权 TypeScript 原生行为移植，而非 Rust sidecar。
- Assumption: 完成门槛为新引擎可显式启动，主链路、session 和 extension UI 有自动化证据，并保留 legacy 回滚；不在本任务删 legacy。
- Assumption: 首版可复用 Pi `Component` 内容组件，但交由 Grok 式 action/render scheduler 管理帧与生命周期；这是扩展 ABI 的必要兼容边界。
- Open question: 真实第三方扩展集和终端矩阵未提供；本次以仓库测试与 tmux 80x24 为基线，将外部兼容性列为限制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 存在经验证的 `@earendil-works/pi-grok-tui` workspace，具有 action/reducer/effect/render scheduler，不依赖 grok Rust runtime。
- Pi CLI 支持 `--tui-engine legacy|grok`，新引擎不修改 agent loop、provider、工具协议或 session schema。
- grok 引擎的 streaming、tool start/update/end、queue/cancel 订阅经过 `PiSessionPort` 有序事件边界，session hydrate 保持只读；组件 invalidation/render 经过新 UI action 边界。
- extension UI 不经 RPC 降级；不支持项必须明确失败，不得静默丢失。
- legacy 引擎保留，同一 session 可在两引擎间往返，无数据迁移。
- 新增/修改测试、隔离全量测试、`npm run check`、完整 workspace `npm run build:offline` 通过，完成无付费 provider 的 tmux 80x24 启动/输入/退出烟测。
- 任务文档 validator 通过，done 任务包含实际验证证据。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> {T-002, T-003}`; `T-002 -> T-007`; `{T-002, T-003, T-007} -> T-004 -> T-005 -> T-006 -> T-008`.
- Parallel batches: T-001 串行；T-002 与 T-003 分别独占 `packages/grok-tui/**` 和 `packages/coding-agent/src/modes/interactive-grok/**`；T-007 串行接入 workspace；之后串行 T-004、T-005、T-006。
- Serialization constraints: 根 manifest/lockfile、coding-agent manifest、CLI/main/modes exports 和本文档由 coordinator 串行修改；subagent 不编辑本文档。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 冻结交互契约和基线

- Status: done
- Owner: coordinator
- Objective: 固化必须保留的 TUI/session/extension 行为，定义新包与 Pi adapter 契约。
- Inputs and prerequisites: 当前 HEAD、前置架构分析、现有测试。
- Scope or files: 现有 TUI/coding-agent 基线测试和本文档；不改生产代码。
- Expected output: 基线结果、公开 action/session adapter 契约、无重叠分工。
- Dependencies: None.
- Execution steps:
  1. 运行最小 TUI、args、session event 和 extension 测试。
  2. 固定 action/state/effect 与 Pi event/command 映射。
  3. 验证 T-002/T-003 无文件所有权重叠。
- Acceptance criteria:
  - 基线测试有实际通过证据，或把现存失败记为 blocker。
  - T-002/T-003 接口与所有权可独立执行。
- Verification method:
  - `node --test test/tui-render.test.ts test/editor-history-keybindings.test.ts` from `packages/tui`.
  - 定向 Vitest：`args`、`agent-session-runtime-events`、`extensions-input-event`、`custom-editor-history-keybindings`.
- Validation evidence: `packages/tui`: `node --test test/tui-render.test.ts test/editor-history-keybindings.test.ts` passed 26/26. `packages/coding-agent`: targeted Vitest passed 95/95 across `args`, `agent-session-runtime-events`, `extensions-input-event`, and `custom-editor-history-keybindings`. Initial runs exposed missing local dependencies/model data; `npm ci --ignore-scripts` succeeded with 0 vulnerabilities. Online model hydration timed out, so the matching cached `@earendil-works/pi-ai@0.84.2` tarball was extracted into the gitignored model-data directory; `check-model-data.ts` then passed. No tracked production file changed by baseline setup.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现 Grok TUI 状态与终端内核

- Status: done
- Owner: worker-grok-core
- Objective: 新建 TypeScript workspace，实现 action/reducer/effect queue、frame scheduling、resize coalescing 和 Pi Component 兼容宿主。
- Inputs and prerequisites: T-001 契约；Pi TUI 公开 API；grok-build action/event/render 作为行为参考。
- Scope or files: 独占 `packages/grok-tui/**`；不修改 coding-agent、根 manifest 或 lockfile。
- Expected output: `@earendil-works/pi-grok-tui` 包、稳定公开 API 和包内测试。
- Dependencies: T-001.
- Execution steps:
  1. 实现 `UiAction`、`UiState`、pure reducer 和 effect queue。
  2. 实现 `GrokTuiRuntime`，将 resize/input/invalidate 转为 action 并批处理 frame。
  3. 宿主现有 `Component` 树的 focus/overlay/input 契约。
  4. 增加 reducer/coalescing/resize/stop 测试。
- Acceptance criteria:
  - reducer 无 I/O；连续 resize 只提交最新尺寸；repeated invalidate 合并为一帧。
  - Runtime 满足 coding-agent 所需 `TUI` 契约，未处理事件不静默丢失。
  - 包内 test/build 通过。
- Verification method:
  - `node --test test/*.test.ts` and `npm run build` from `packages/grok-tui`.
- Validation evidence: Worker package checks passed; coordinator reran package test/build successfully. Adversarial lifecycle review then fixed `stop()` before `start()` cleanup parity and added a regression; final worker test passed 12/12 and build/Biome passed. Source review confirmed renderer-only reducer state, full `TuiMainScreen`/`TuiAltScreen` inheritance, no copied grok-build source, and no edits outside owned files.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实现 Pi session/event 适配层

- Status: done
- Owner: worker-pi-adapter
- Objective: 不改 AgentSessionRuntime、session 存储和 tool hooks，建立新 TUI 的 session port 和 event-to-action 适配。
- Inputs and prerequisites: T-001 契约；`AgentSessionRuntime`、`AgentSessionEvent`、`SessionManager` API。
- Scope or files: 独占 `packages/coding-agent/src/modes/interactive-grok/**` 及对应新测试；不改 main/args/exports/manifests/任务文档。
- Expected output: `PiSessionPort`、event adapter、session hydrate 与单元测试。
- Dependencies: T-001.
- Execution steps:
  1. 封装 prompt/steer/follow-up/abort/bash/session/model/thinking 命令。
  2. 映射 message/tool/queue/retry/compaction 事件，保留 `toolCallId` 和顺序。
  3. 从现有 session entries hydrate UI，不新建持久化。
- Acceptance criteria:
  - 测试覆盖 streaming、tool start/update/end、queue/cancel 和 hydrate。
  - 无 `any`、dynamic import 和 session 双写。
- Verification method:
  - 定向运行新 adapter 测试；T-006 覆盖 `tsgo --noEmit`。
- Validation evidence: Worker targeted Vitest passed 5/5 and targeted Biome passed. Coordinator read all adapter files and reran `test/grok-pi-session-port.test.ts`; 1 file and 5 tests passed. Hydration uses read-only SessionManager APIs and the event mapping is exhaustive. Final adversarial review wired grok production subscriptions through `PiSessionPort`; its listener retains the original typed Pi event only as the compatibility-view payload, and the regression verifies the neutral event and source-event order/tool IDs together.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 接入扩展 UI 和交互主链路

- Status: done
- Owner: worker-renderer-integration
- Objective: 将 Grok renderer 注入唯一现有 `InteractiveMode`，通过稳定 TUI proxy 继续宿主 extension UI、editor、keys、tools、theme 和 restore 语义，不复制第二个交互主类。
- Inputs and prerequisites: T-002, T-003 产物和 T-007 workspace 接线。
- Scope or files: `packages/coding-agent/src/modes/interactive-grok/**`、必要的 `packages/grok-tui/src/compat/**` 和定向测试；不改 CLI/main/manifests。
- Expected output: `createInteractiveTui`/`InteractiveModeOptions` 支持 Grok engine，mode switch 不退回 legacy，现有 extension UI 实现原样复用，并有兼容测试。
- Dependencies: T-002, T-003, T-007.
- Execution steps:
  1. 为 renderer factory 和 `InteractiveModeOptions` 增加严格 engine 参数，初始构造与 regular/fullscreen switch 使用同一 engine。
  2. 通过现有 `createInteractiveTuiReference` 保留 dialog/status/widget/header/footer/custom/raw-input/editor/autocomplete/theme 契约。
  3. 使用 runtime 继承的 Component/overlay/focus/input 行为，不引入 ACP permission 或第二份业务状态。
  4. 验证 engine × mode、renderer switch、stable proxy、right-click paste 和 fullscreen capability。
- Acceptance criteria:
  - 新 mode 可 construct/init/run/stop，保留 extension UI 契约。
  - streaming/tools/approval/input/restore/theme 有定向证据。
- Verification method:
  - 新 mode/extension/session 定向 Vitest，并回归既有 interactive/custom-editor/extensions-input 测试。
- Validation evidence: Worker targeted `interactive-tui.test.ts` passed 12/12, Biome and `git diff --check` passed. Coordinator inspected the complete integration diff and reran the targeted test from `packages/coding-agent`; 1 file/12 tests passed. Tests cover engine x mode, ViewportTUI, lifecycle, regular/fullscreen round trips, stable proxy, original terminal reuse, focus/input, and copy feedback. Adversarial review additionally removed the dead adapter seam by routing grok session subscriptions through `PiSessionPort`; legacy subscriptions remain direct.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — CLI、包和可回滚集成

- Status: done
- Owner: coordinator
- Objective: 将新 mode 接入 CLI/workspace，提供严格 engine 选择和安全回滚。
- Inputs and prerequisites: T-004 可运行组合根。
- Scope or files: 根 manifest/lockfile、coding-agent manifest/shrinkwrap、`src/cli/args.ts`、`src/main.ts`、`src/modes/index.ts`、测试/docs。
- Expected output: `--tui-engine legacy|grok`、workspace build 接线和实际启动分流。
- Dependencies: T-004.
- Execution steps:
  1. 增加 CLI 枚举解析/help。
  2. interactive 分支选择 engine，默认 legacy，支持显式 grok。
  3. 用 `--ignore-scripts` 更新 lockfile，按现有脚本生成 shrinkwrap。
- Acceptance criteria:
  - 非法值报明确错误，help 列出选项。
  - legacy/grok 均可启动，切换不改 session。
  - manifest/lock 只包含本任务必要变更。
- Verification method:
  - 定向 args/startup 测试；T-006 执行 workspace build。
- Validation evidence: Added strict `--tui-engine legacy|grok` parsing/help, passed the parsed value into `InteractiveMode`, and exported `TuiEngine`. Coordinator ran targeted `args`, `interactive-tui`, and `grok-pi-session-port` tests: 3 files/102 tests passed. Targeted Biome over 10 changed source/test paths passed after one import-order correction; `git diff --check` passed. Workspace package/lock/shrinkwrap evidence is recorded in T-007.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 端到端验证、对抗审查和交付

- Status: done
- Owner: coordinator
- Objective: 证明新 TUI 在 build/check/交互/尺寸/session/回滚上可用，并审查整体 diff。
- Inputs and prerequisites: T-005 完成。
- Scope or files: 本任务全部 diff、测试、tmux 烟测和本文档；只修复范围内问题。
- Expected output: 完整验证证据、审查结论和交付记录。
- Dependencies: T-005.
- Execution steps:
  1. 运行新增/修改测试和相关回归。
  2. 运行 `npm run check` 并处理 error/warning/info。
  3. 运行完整 workspace 离线构建；在线模型目录生成不作为本改造的编译门禁。
  4. tmux 80x24 启动 legacy/grok，执行本地输入、resize、退出烟测。
  5. 审查 diff/status、许可证、session schema 和回滚。
- Acceptance criteria:
  - 必需 tests/check/build/tmux 通过。
  - 对抗审查无未解决 P0/P1，无意外用户文件变更。
- Verification method:
  - 记录命令、exit code、关键结果和限制；运行 task document validator。
- Validation evidence: `./test.sh` 在隔离 HOME、无 API key 环境下退出 0，覆盖全部具有 test script 的 workspace；其中 coding-agent 225 files/1955 passed/49 skipped，grok-tui 12/12，且其余 workspace 均通过。最终相关回归为 TUI 26/26、coding-agent 6 files/116 tests、session/renderer 集成 3 files/21 tests，全部通过。`npm run check` 退出 0，Biome 无修复，pinned deps/imports/shrinkwrap/install-lock/tsgo/browser smoke 全通过。`npm run build:offline` 退出 0，完整编译 tui、grok-tui、telemetry、ai、agent、sqlite backend、protocol、client、server 和 coding-agent；没有运行会重新抓取动态外部模型目录的在线 `npm run build`。`npm pack --dry-run --workspace packages/grok-tui` 通过，预期仅打包 manifest 和 28 个 dist 文件，未生成 tarball。CLI help 显示 `--tui-engine`，非法值返回明确错误。最终 tmux 烟测对 legacy/grok 均在 80x24 启动、处理本地 `/debug`、resize 至 100x30 重绘并通过 `/quit` 退出；全程 `--offline --no-approve`、隔离 agent dir、无 provider 凭据。`git diff --check` 通过；差异审查确认未改 session/provider/tool protocol，未复制 Apache-2.0 grok-build 源码，新增包沿用 Pi MIT 元数据，未触碰用户 `.edru/` 和既有未跟踪 Markdown。无未解决 P0/P1。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 接入新 workspace 依赖与构建拓扑

- Status: done
- Owner: coordinator
- Objective: 在 coding-agent 引用新 renderer 前，将 `@earendil-works/pi-grok-tui` 接入 root TypeScript paths、workspace build 顺序、coding-agent dependency 和 lock/shrinkwrap。
- Inputs and prerequisites: T-002 已验证的 package manifest 和公开 API。
- Scope or files: 根 `package.json`、`tsconfig.json`、`package-lock.json`、`packages/coding-agent/package.json`、`packages/coding-agent/npm-shrinkwrap.json`；不改生产 TypeScript 逻辑。
- Expected output: 新 package 可被 root typecheck、coding-agent tests 和构建通过 workspace package name 解析。
- Dependencies: T-002.
- Execution steps:
  1. 把 grok-tui build 插入 tui 之后、coding-agent 之前。
  2. 添加 root tsconfig path 和 coding-agent workspace dependency。
  3. 按仓库规则使用 `--ignore-scripts` 更新 lockfile，再生成/check coding-agent shrinkwrap。
- Acceptance criteria:
  - `node_modules/@earendil-works/pi-grok-tui` 正确解析当前 workspace。
  - lock/shrinkwrap 只反映新的内部 workspace dependency。
  - 新 package 仍 test/build 通过。
- Verification method:
  - `npm install --package-lock-only --ignore-scripts`; `npm install --ignore-scripts`; shrinkwrap generator/check; package test/build。
- Validation evidence: `npm install --package-lock-only --ignore-scripts` and `npm install --ignore-scripts` passed with 0 vulnerabilities; workspace symlink resolves to `../../packages/grok-tui`; shrinkwrap generator wrote 139 packages/10 platform-specific entries and `--check` passed; grok-tui test (11/11 at this checkpoint) and build passed. Diff review showed only the new workspace/dependency/build/path entries.
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 修复当前 shell 的全局 Pi 启动入口

- Status: done
- Owner: coordinator
- Objective: 让用户直接执行的 `pi --tui-engine grok` 命中本仓库已构建的新 CLI，而不是同版本号的旧全局副本。
- Inputs and prerequisites: T-006 完成；用户提供的 `Unknown option: --tui-engine` 复现。
- Scope or files: 当前 FNM Node 24.15.0 的全局 npm package link；不改生产代码、配置或用户项目文件。
- Expected output: `command -v pi` 对应的真实路径解析到当前 workspace，原始参数被接受，真实 Grok TUI 可启动和退出。
- Dependencies: T-006.
- Execution steps:
  1. 对比全局 `pi` 和仓库 `dist/cli.js` 的 help，定位第一处分歧。
  2. 拒绝会大范围重装依赖的 global install，使用 `npm link --ignore-scripts` 将 coding-agent 链接到当前 workspace。
  3. 用全局 `pi` 复跑参数解析和真实 PTY 启动。
- Acceptance criteria:
  - `pi --tui-engine grok --help` 不再报 unknown option。
  - 全局 `pi` 可在离线无凭据环境启动 Grok fullscreen、处理本地输入并退出。
  - 其他顶层全局 npm package 保留，仓库状态不新增意外变化。
- Verification method:
  - `realpath $(command -v pi)`、CLI help、`npm list -g --depth=0` 和 tmux 80x24 烟测。
- Validation evidence: 失败基线中全局 `pi` 解析到 FNM 的 registry 安装副本，其 help 只有 `--tui-mode`；同一时刻仓库 `dist/cli.js` 已列出 `--tui-engine`，证明首个分歧在 shell 启动入口。`npm install -g --dry-run` 显示会移除 139 个旧 Pi 私有依赖，因此未执行；改用 `npm link --ignore-scripts`。修复后全局 bin 的 realpath 为 `/Users/w/Projects/easy-pi/pi/packages/coding-agent/dist/cli.js`，`pi --tui-engine grok --help` 通过，其他顶层全局包仍在。最终使用全局 `pi` 的 tmux 80x24 烟测成功启动 Grok fullscreen、处理 `/debug` 并由 `/quit` 干净退出；仓库 status 未出现额外变化。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Baseline: render/editor history/args/session events/extensions/custom editor 定向测试。
2. New core: reducer 确定性、action 顺序、resize coalescing、invalidation、stop/restore。
3. Adapter: streaming chunks、toolCallId、queue/cancel、hydrate 和 extension component lifecycle。
4. CLI/package: enum/help、legacy/grok startup、workspace build、lock/shrinkwrap check。
5. Terminal: 既有虚拟终端尺寸/宽字符回归；tmux 80x24 启动、输入、resize 到 100x30、退出。
6. Repository gates: 所有修改测试、`npm run check`、`npm run build:offline`、diff/status 审查。
7. No paid runtime: 流式和工具链路使用 faux provider/fixtures。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Extension Component/overlay/focus/custom editor 是最高风险；使用兼容宿主和既有测试，不经 RPC 降级。
- 新旧引擎共存可产生漂移；仅抽取必要 session/event 边界，不借机重构无关 InteractiveMode。
- raw/alt screen 恢复失败可影响终端；使用 PTY/tmux 验证并保留 legacy 回滚。
- grok-build 为 Apache-2.0 导出；优先行为重实现。如复制非平凡源码/资产，必须增加归属与 NOTICE。
- `npm run check` 会格式化写入；执行前记录 diff，仅保留范围内机械变更。
- 已有未跟踪 `.edru/` 和 Markdown 属于用户，不删除、移动或纳入本任务。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-22: Task document created in execute mode.
- 2026-08-22: Read requested Skills and repository `AGENTS.md`; confirmed authority, test rules, dirty-worktree boundaries, and no project-root `LEARNS.md`.
- 2026-08-22: T-001 set to in_progress under coordinator ownership; no production code modified yet.
- 2026-08-22: Installed dependencies with `npm ci --ignore-scripts`. Online model hydration timed out; restored matching versioned model data from npm's local cache into a gitignored directory and validated it.
- 2026-08-22: T-001 completed after 26/26 TUI tests and 95/95 coding-agent baseline tests passed.
- 2026-08-22: T-002 and T-003 started in parallel with disjoint ownership; coordinator retains authority-document and integration-file ownership.
- 2026-08-22: T-002 completed after coordinator source review and rerun of 11/11 package tests plus package build.
- 2026-08-22: T-003 completed after coordinator source review and rerun of 5/5 adapter tests.
- 2026-08-22: Integration review rejected a duplicated `InteractiveMode`; renderer injection through the existing factory/stable TUI proxy preserves extension semantics with the smallest complete diff. Added T-007 because workspace resolution is a prerequisite for testing that integration.
- 2026-08-22: T-007 started under coordinator ownership.
- 2026-08-22: T-007 completed after workspace symlink, lock/shrinkwrap generation/check, package test/build, and focused dependency diff review passed.
- 2026-08-22: T-004 started with renderer-factory injection as the selected least-complex complete integration seam; no second `InteractiveMode` will be created.
- 2026-08-22: T-004 completed after coordinator diff review and rerun of 12/12 interactive renderer integration tests.
- 2026-08-22: T-005 started under coordinator ownership for strict CLI parsing, help, exports, and startup wiring.
- 2026-08-22: T-005 completed after 102 targeted tests, targeted Biome, and diff whitespace validation passed.
- 2026-08-22: T-006 started for repository gates, terminal smoke, adversarial review, and final task reconciliation.
- 2026-08-22: First repository `check` exposed stale install-lock/model data and two new test type annotations; regenerated the repository-owned install lock, hydrated current model data through the configured proxy, fixed only the test typings, and obtained a clean final check.
- 2026-08-22: Adversarial review found `PiSessionPort` was tested but not connected. Wired grok production subscriptions through the adapter while retaining the raw source event as a documented compatibility-view payload; targeted session/renderer/runtime regressions passed 21/21.
- 2026-08-22: Isolated full `./test.sh` completed with exit code 0. Final `npm run check` and full workspace `npm run build:offline` completed with exit code 0.
- 2026-08-22: Final tmux matrix passed for legacy and grok at 80x24 -> 100x30 using local `/debug` input and `/quit`, with offline/no-credential/no-project-resource isolation.
- 2026-08-22: T-006 completed after diff/license/session-schema/rollback review found no unresolved P0/P1 and no user-owned file changes.
- 2026-08-22: Final task validation first rejected the unsupported overall-status word `complete`; changed it to the validator's required `done` enum and reran validation.
- 2026-08-22: Final task document validation passed with all tasks done and final result `passed`.
- 2026-08-22: New workspace `npm pack --dry-run` passed with 29 expected files and no generated tarball; task document validation was rerun after recording this evidence.
- 2026-08-22: User reported global `pi --tui-engine grok` as unknown. Proved the FNM global registry copy was stale while the repository build was good, linked the global coding-agent package to the workspace, and verified the original argument plus a real global-command PTY smoke. T-008 completed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 through T-008 are done with current evidence. The new renderer package, production CLI/session/renderer wiring, legacy rollback, full isolated test suite, repository check, complete offline workspace build, package dry-run, dual-engine PTY smoke, global command wiring, and final task document validator all passed.
- Limitations: 默认仍为 `legacy`，需显式 `--tui-engine grok` 启用，以保留一键回滚；首版有意复用 Pi Component 视图和扩展 ABI，不是 grok-build 字符级视觉复制。真实第三方扩展、非 tmux 终端矩阵、付费 provider 和动态在线模型目录再生成未运行；没有把这些项目描述为已验证。
