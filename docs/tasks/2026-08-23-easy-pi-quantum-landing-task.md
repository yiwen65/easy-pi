# Task Plan: easy-pi 量子轨道启动落地页

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 当前会话中用户确认的“量子轨道 + 几何 eπ Logo + 遥测面板”方案

<!-- task-doc-section:background-goal -->
## Background and goal

当前 easy-pi 启动页仍是文本标题与资源列表，用户明确否决该方向。目标是把启动首屏重构为顶部中央的低资源量子轨道动态视觉核心、几何化 eπ Logo、运行遥测面板与快捷入口，并将详细资源清单收进 Ctrl+O 展开态。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：interactive TUI 启动页、响应式动画组件、资源展开行为、相关测试、构建与真实全局 `pi` 启动验证。
- 范围：Grok/legacy、regular/fullscreen、主题变化、40–160 列宽度、extension custom-header 生命周期。
- 非目标：不改 `pi` CLI 命令、不引入图片/Web UI/第三方动画库、不永久高频播放动画、不重构对话与工具执行 UI。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 全局 `pi` npm-link 到当前仓库并执行 `packages/coding-agent/dist/cli.js` | `type -a pi`、symlink 与 npm global list 实测 |
| F-002 | 当前启动 Header 位于 `InteractiveMode.headerContainer`，Grok 与 legacy 共用该文档容器 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` |
| F-003 | Ctrl+O 通过结构化 `setExpanded()` 同步 Header 与资源组件 | `InteractiveMode.setToolsExpanded()` |
| F-004 | 用户确认量子轨道、几何字标、英雄区 + 遥测面板以及约 5 秒后静止 | 当前会话结构化确认 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 动画属于启动 transcript，进入长对话后自然滚出；用户已在确认摘要中接受。
- Assumption: Unicode/ANSI 几何字符在 Pi 当前支持的现代终端中可用，并由宽度测试防止溢出。
- Open question: 无。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 顶部中央显示几何化 eπ Logo 与可观察的量子轨道动态效果。
- 动画使用单一低频、可 `unref` 且可清理的计时器，约 5 秒后停止，不再请求重绘。
- 首屏以遥测面板展示模型、上下文、工作区及 Skills/Prompts/Extensions 数量，不再默认堆叠资源清单。
- Ctrl+O 展开完整 Context、Skills、Prompts、Extensions，并可再次收起。
- 40–160 列每行不溢出，窄屏降级合理；Grok/legacy 和 custom-header 替换行为保持可用。
- 目标测试、格式检查、package build 与真实全局 `pi` tmux 启动验证通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；三个任务共享启动页组件与 `interactive-mode.ts`，顺序执行。
- Serialization constraints: `interactive-mode.ts` 当前含其他 session 的修改，只进行目标化编辑并保持现有差异。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现量子轨道 Logo 动画组件

- Status: done
- Owner: coordinator
- Objective: 将现有文本 Header 替换为响应式、可停止和可销毁的中央动画落地页组件。
- Inputs and prerequisites: 已确认视觉方案；现有 `EasyPiStartupHeader` 与 TUI 宽度工具。
- Scope or files: `packages/coding-agent/src/modes/interactive/components/easy-pi-startup-header.ts`、对应测试。
- Expected output: 几何 eπ Logo、量子轨道帧、遥测与快捷入口渲染，具备 timer 生命周期。
- Dependencies: None.
- Execution steps:
  1. 定义遥测数据与渲染驱动接口。
  2. 实现宽/中/窄三档中心构图和低频有界动画。
  3. 增加宽度、动画停止、dispose、展开态测试。
- Acceptance criteria:
  - Logo、动画、遥测和快捷入口均可渲染。
  - timer 在截止时间或 dispose 后停止，所有测试宽度不溢出。
- Verification method:
  - 运行 `test/easy-pi-startup-header.test.ts`。
- Validation evidence: `test/easy-pi-startup-header.test.ts` 6/6 通过；覆盖 1–160 列、动画帧变化、4.8 秒停止与 dispose 清理。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成遥测落地页与资源展开态

- Status: done
- Owner: coordinator
- Objective: 从 InteractiveMode 提供实时遥测，并将资源清单默认隐藏、仅在 Ctrl+O 展开。
- Inputs and prerequisites: T-001 完成。
- Scope or files: `interactive-mode.ts`、`interactive-mode-status.test.ts` 及必要的集成测试。
- Expected output: 首屏只显示落地页；展开态显示完整资源；custom-header ABI 与 quiet startup 保持。
- Dependencies: T-001.
- Execution steps:
  1. 接入模型、上下文、工作区与资源数量回调。
  2. 调整资源组件 collapsed/expanded 渲染和生命周期。
  3. 更新回归测试。
- Acceptance criteria:
  - compact 首屏没有资源清单堆叠，Ctrl+O 后完整数据可见。
  - Header 替换/恢复和资源展开状态正确。
- Verification method:
  - 运行 startup/status/TUI 目标测试与 Biome。
- Validation evidence: startup/status/TUI 三个目标文件共 41/41 通过；Biome 目标检查通过；80/40 列 `pi-test.sh` smoke 显示首屏隐藏资源、Ctrl+O 展开完整资源、窄屏无溢出。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 构建并验证真实 `pi`

- Status: done
- Owner: coordinator
- Objective: 将源码落地到 npm-linked `dist` 并验证真实启动动画与布局。
- Inputs and prerequisites: T-001、T-002 完成。
- Scope or files: 构建产物（ignored）、实际全局 `pi` 运行路径。
- Expected output: 全局 `pi` 显示新量子落地页。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 运行目标检查与 package build。
  2. 用 tmux 在 40/80/120 列捕获启动及动画结束状态。
  3. 确认退出后无遗留 timer/process。
- Acceptance criteria:
  - 实际 `pi` 显示新 Logo/动画/遥测并在约 5 秒后静止。
- Verification method:
  - `npm run build`；tmux 调用全局 `pi`；检查输出与进程。
- Validation evidence: `packages/coding-agent npm run build` 通过；全局 npm-linked `pi` 在 80 列相隔 280ms 的帧捕获显示轨道粒子位置变化，6 秒后稳定；40 列降级布局无溢出；`pi --version` 为 0.84.2。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 组件：宽度 1/2/8/15/16/31/32/40/64/80/120/160，compact 与 expanded。
- 动画：fake timers 验证帧重绘、有界停止、dispose 清理且 timer `unref` 可调用。
- 集成：资源 compact 隐藏、expanded 完整、quiet startup、custom-header 与 Grok 路由。
- 静态：目标文件 Biome、`git diff --check`。
- 运行：coding-agent package build；真实全局 `pi` 在 tmux 启动捕获。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- `π` 在部分 CJK 终端可能按宽字符显示；避免依赖其右对齐，并保持宽度降级测试。
- 共享 worktree 有大量其他修改；不得覆盖或格式化无关文件。
- 根级 `npm run check` 当前存在与本任务无关的工具执行签名类型错误；以目标检查和 package build 为主，并如实报告。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 用户通过结构化确认接受量子轨道、几何 eπ、遥测面板与 5 秒有界动画方案。
- 2026-08-23: T-001 开始，由 coordinator 执行。
- 2026-08-23: T-001 完成；量子轨道 Logo、三档响应式布局、4.8 秒低频动画和 timer 生命周期测试通过。
- 2026-08-23: T-002 完成；遥测接入、资源默认隐藏/Ctrl+O 展开、custom-header dispose 回归与 40/80 列 smoke 通过。
- 2026-08-23: T-003 开始，准备构建 npm-linked dist 并验证真实全局 `pi`。
- 2026-08-23: reviewer 发现 `--verbose` 会绕过 Ctrl+O 门；已改为 expansion 只由 `toolOutputExpanded` 控制并更新回归测试。
- 2026-08-23: T-003 完成；package build、全局 `pi` 动态/静态帧、40/80 列布局和版本检查通过。
- 2026-08-23: 根级 `npm run check` 全流程通过（Biome、依赖锁、tsgo、browser smoke）。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 3 个目标测试文件 41/41 通过；目标 Biome 与 `git diff --check` 通过；根级 `npm run check` 通过；coding-agent build 通过；真实全局 `pi` 的动态帧、5 秒后静止、40/80 列和 Ctrl+O 展开均经 tmux 验证。
- Limitations: `π` 的 East Asian Ambiguous Width 仍由终端字体决定；实现遵循 Pi TUI 的 `visibleWidth` 窄字符约定。
