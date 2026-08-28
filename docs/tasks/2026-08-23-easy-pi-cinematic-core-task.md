# Task Plan: easy-pi 影院式核心舱启动页

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户确认“影院式核心舱”作为 easy-pi 启动落地页最终艺术方向

<!-- task-doc-section:background-goal -->
## Background and goal

上一版量子轨道在真实宽终端中视觉主体过小、`eπ` 只是灰框文本、信息与英雄区缺少统一层级。目标是将启动页重构为约 110 列的影院式核心舱：块状几何 eπ Logo、椭圆轨道、动态扫描线、遥测芯片与协调的更新提示形成同一视觉系统。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：启动页 Hero 构图、几何 eπ Logo、低资源动画、遥测/快捷入口层级、更新提示样式、组件与集成测试、构建和真实全局 `pi` 验证。
- 范围：Grok/legacy、regular/fullscreen、深浅主题、40–160 列响应式、custom-header ABI。
- 非目标：不改 CLI 命令、不引入第三方动画库或图片、不做永久高频动画、不改对话/工具执行主界面。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户截图显示现有 Hero 只占约 40 列，Logo 为小灰框文本，更新提示左对齐破坏协调 | 用户提供的实际启动截图 |
| F-002 | 全局 `pi` 执行 npm-link 包的 `dist/cli.js`，源码改动必须 package build 后才可见 | `npm list -g` 与上一轮实际验证 |
| F-003 | 资源详情已由 Ctrl+O/`toolOutputExpanded` 门控，首屏不堆叠清单 | 当前 `interactive-mode.ts` 与目标测试 |
| F-004 | 动画要求约 5 秒低频停止并可 dispose | 用户确认的结构化摘要 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 宽于 110 列时核心画幅保持约 110 列，不无限拉伸。
- Assumption: 终端支持现代 Unicode box/block 字符；所有宽度按 Pi TUI 的 `visibleWidth` 约定。
- Open question: 无。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Hero 在宽终端具有约 110 列视觉主体并严格居中。
- `eπ` 以块状几何单体 Logo 呈现，且与品牌文字区分明确。
- 粒子与扫描线可观察地运动，约 5 秒自动静止，timer 可 `unref/dispose`。
- 遥测芯片、快捷入口和更新提示使用一致的圆角/边框/色彩体系。
- 40–160 列不溢出；窄屏有可读降级。
- 目标测试、Biome、package build、真实全局 `pi` 动态帧与静止帧验证通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；共享同一启动页组件和集成点。
- Serialization constraints: 共享 worktree 含其他 session 修改，仅编辑本任务文件并保留既有差异。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 重做影院式核心舱 Hero 与几何 Logo

- Status: done
- Owner: coordinator
- Objective: 用自适应 110 列画幅、块状 eπ Logo、椭圆轨道和扫描线替换当前小型 ASCII Hero。
- Inputs and prerequisites: 已确认视觉方案；现有动画生命周期实现。
- Scope or files: `easy-pi-startup-header.ts`、对应组件测试。
- Expected output: 有品牌感、科幻感、居中的动画落地页核心。
- Dependencies: None.
- Execution steps:
  1. 设计块状 eπ 字形与自适应核心画幅。
  2. 实现粒子轨道、移动扫描线和三档宽度降级。
  3. 更新宽度、动画、Logo 和层级测试。
- Acceptance criteria:
  - 宽终端 Logo/轨道视觉质量明显成立，1–160 列不溢出。
  - 动画帧变化、自动停止和 dispose 回归通过。
- Verification method:
  - 运行 `test/easy-pi-startup-header.test.ts`。
- Validation evidence: `test/easy-pi-startup-header.test.ts` 8/8 通过；160/80 列 `pi-test.sh` smoke 显示约 112/80 列居中核心、块状 eπ、粒子与扫描线，宽度回归覆盖 1–160 列。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 协调遥测芯片与更新提示

- Status: done
- Owner: coordinator
- Objective: 让模型/上下文/工作区/资源芯片和异步更新提示继承同一 Hero 视觉语言。
- Inputs and prerequisites: T-001 完成。
- Scope or files: `easy-pi-startup-header.ts`、`interactive-mode.ts`、相关测试。
- Expected output: 更新提示不再左对齐破坏首屏；遥测为芯片式层级。
- Dependencies: T-001.
- Execution steps:
  1. 增加协调的居中通知组件。
  2. 接入 package/version update 通知并保持命令信息。
  3. 更新集成和通知测试。
- Acceptance criteria:
  - 首屏默认无资源清单，更新提示居中且不压过 Hero。
  - custom-header、quiet startup、Ctrl+O 展开保持。
- Verification method:
  - 运行启动页、interactive status、TUI 目标测试与 Biome。
- Validation evidence: startup/status/TUI 三个目标文件 44/44 通过；遥测芯片在 100 列平衡换行，package update 通过居中 `EasyPiNotice` 卡片渲染，Biome 与 diff 检查通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 构建并用真实全局 `pi` 验证

- Status: done
- Owner: coordinator
- Objective: 将新视觉落到 npm-linked `dist` 并确认实际终端表现。
- Inputs and prerequisites: T-001、T-002 完成。
- Scope or files: 构建产物与实际 `pi` 执行路径。
- Expected output: 用户重新打开 `pi` 即看到影院式核心舱。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 运行 package build 和根级 check。
  2. 在 40/80/160 列捕获动态帧和静止帧。
  3. 检查退出清理与真实命令版本。
- Acceptance criteria:
  - 真实 `pi` 显示新 Hero，动画可观察并静止。
- Verification method:
  - tmux 全局 `pi` 启动捕获；构建与检查命令。
- Validation evidence: `packages/coding-agent npm run build` 通过；真实全局 `pi` 的 160 列相邻帧显示粒子与扫描线移动，静止帧稳定；80 列布局无溢出；`pi --version` 为 0.84.2；`dist` 已包含 `Eπ // CORE`。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 组件：1/2/8/15/16/24/31/32/40/51/52/64/80/120/160 列，compact 与 expanded。
- 动画：fake timers 验证帧差异、4.8 秒停止、dispose 清理。
- 集成：默认资源隐藏、Ctrl+O 展开、verbose 不绕过、custom-header dispose。
- 静态：目标 Biome、`git diff --check`、根级 `npm run check`。
- 运行：coding-agent build；真实全局 `pi` 的多宽度 tmux 捕获。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 块状 Logo 需避免依赖终端把 `π` 当作宽字符；测试用 `visibleWidth` 并保留窄屏降级。
- `biome --write` 可能触碰无关文件；运行后核对本任务 diff。
- 共享 worktree 有大量其他 session 修改；不得回退或格式化无关文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 用户通过结构化确认选择“影院式核心舱”。
- 2026-08-23: T-001 开始，由 coordinator 执行。
- 2026-08-23: T-001 完成；影院式核心舱、块状几何 eπ、扫描线和宽度降级通过组件测试与 80/160 列 smoke。
- 2026-08-23: T-002 完成；遥测芯片与居中更新提示通过目标测试和静态检查。
- 2026-08-23: T-003 开始，准备构建 npm-linked dist 并验证真实全局 `pi`。
- 2026-08-23: reviewer 发现并修复三处问题：粒子颜色死分支、restore custom header 后动画冻结、长 Notice 标题潜在溢出；目标测试增至 45/45 通过。
- 2026-08-23: T-003 完成；package build、全局 `pi` 动态/静止帧和 80/160 列验证通过。
- 2026-08-23: 根级 `npm run check` 在无关 `packages/subagent/src/dag-orchestrator.ts` 的 3 个既有 unused lint warning 处失败；目标 Biome、type/build 与 scoped tests 均通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 3 个目标测试文件 45/45 通过；目标 Biome 与 `git diff --check` 通过；coding-agent build 通过；真实全局 `pi` 160 列动态帧、静止帧和 80 列布局经 tmux 验证。
- Limitations: 根级 `npm run check` 被无关 `packages/subagent` unused lint warnings 阻断；未在本任务中修改该其他 session 的范围。终端字体的 East Asian 宽度仍按 Pi TUI `visibleWidth` 约定处理。
