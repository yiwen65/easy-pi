# Task Plan: Grok TUI 信息对齐与布局/动效重构

- Created: 2026-08-22
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户反馈移植后的 Grok TUI 缺失原生 Pi TUI 信息（cwd+分支、token 统计、缓存命中、成本、上下文占用、provider/model/thinking），布局分散，要求重构布局并提升美感与交互特效。

<!-- task-doc-section:background-goal -->
## Background and goal

Grok 视觉迁移完成后，chrome 仅有顶栏 cwd+context 文本、composer caption 的 model/thinking 和快捷键栏；原生 `FooterComponent` 的 `↑in ↓out R/W CH $cost ctx%/window (auto)` 与 `(provider) model • thinking` 全部缺失。本轮在不触碰 Pi 业务语义的前提下，为 Grok chrome 恢复完整信息对等，并加入适度动效（用户确认方案：底部状态条 + 适度动效）。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### Scope

- 顶栏：`~/path (branch) • session` 位置区（分支左截断保护）+ 右侧上下文用量迷你进度条（绿→黄→红变色）。
- 新增 `GrokStatsBar`：左侧 token/缓存/成本/上下文统计（与 legacy footer 完全同源），右侧 `(provider) model • thinking`。
- 应用户要求移除快捷键栏；`GrokFooter` 仅保留扩展状态（无状态时零行），`GrokShortcut`/`setShortcuts` 已删除。
- 交互特效：统计段数值变动时 accent 闪烁 1.2s 后淡出；idle `Ready` 状态点 ○↔◎ 呼吸；上下文按阈值变色。无 `ui` 驱动时完全静态、零定时器。
- Thinking level 突出：`off→dim, minimal→muted, low→text, medium→accent, high→warning, xhigh→error` 热力分级（未知等级如 `max` 回退 text）；model/thinking 切换瞬间右侧整体 accent 闪烁后回落至等级色。
- composer 底部 caption 移除（model 信息归入状态条），底边恢复纯圆角线。
- `footer.ts` 提取 `computeSessionUsageStats()` 供 legacy footer 与 Grok 状态条共用，保证两侧数字一致。
- session rebind / autoCompact 切换 / dispose 生命周期接线。

### Non-goals

- 不修改 Pi agent/session/provider/工具协议与扩展 ABI。
- 不引入逐工具审批等新业务状态；不把统计复制进 view 持久状态（render 时实时计算）。
- 不做 composer 边框流光等"丰富动效"（用户选择适度档）。
- 不提交、不发布、不调用付费 provider。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | legacy footer 的信息全部来自 `AgentSession` + `ReadonlyFooterDataProvider`，Grok 模式下该 footer 未挂载（footerContainer 保持空）。 | `src/modes/interactive/components/footer.ts`; `interactive-mode.ts` `setExtensionFooter` 分支 |
| F-002 | 组件级动画的既有模式是组件持有 `setInterval` + `ui.requestRender()`，dispose 清理。 | `components/countdown-timer.ts`, `status-indicator.ts` (Loader) |
| F-003 | `handleEvent` 每个 session 事件都会 `refreshGrokChrome()` 并触发重绘，统计条在 render 中实时计算即可保持新鲜。 | `interactive-mode.ts` handleEvent 入口 |
| F-004 | rebind 后 legacy footer 通过 `setSession/setAutoCompactEnabled` 重绑；Grok stats bar 在 `applyRuntimeSettings` 同点接入。 | `interactive-mode.ts` `applyRuntimeSettings` |

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 80+ 列时可见：`~/path (branch)`、上下文仪表、`↑ ↓ R CH $ ctx% (auto)`、`(provider) model • thinking`，与 legacy footer 数值一致。
- 40 列窄终端不溢出：右侧 model 区先截断，再左截断统计区；顶栏优先保留分支。
- 数值变化时对应段 accent 闪烁并可淡出；无 ui 驱动时无任何定时器（既有 no-timer 契约保持）。
- 40-col golden 锁定新布局；`npm run check`、coding-agent 全量测试、tmux 真实 smoke（40x8 / resize / git 分支目录）通过。

<!-- task-doc-section:execution-log -->
## Execution log

### 2026-08-22 — 实现与验证

- 改动文件：
  - `src/modes/interactive/components/footer.ts`：提取 `computeSessionUsageStats()`，FooterComponent 改用它（行为不变）。
  - 新增 `interactive-grok/components/grok-context-meter.ts`：`renderContextMeter()` + `contextColorFor()`（70/90 阈值与 legacy 一致）。
  - 重写 `grok-top-bar.ts`：`GrokLocation { path, branch, sessionName }` + `setContextPercent(number|null)`；路径左截断、分支/会话名优先保留。
  - 新增 `grok-stats-bar.ts`：段式渲染（符号 dim、数值 text、ctx 阈值变色）、变动段 accent 闪烁 1200ms（`unref` setTimeout + `ui.requestRender`）、宽度不足时先截右侧再截左侧。
  - `grok-status.ts`：idle ○↔◎ 呼吸（900ms，仅 active+idle+有 ui 时运行），新增 `setActive/dispose`。
  - `grok-editor-frame.ts`：移除 model/thinking caption，底边恢复纯 `╰─…─╯`。
  - `grok-interactive-view.ts` / `grok-component-factory.ts`：stats bar 挂载于 composer 与快捷键栏之间；新增 `setLocation/setContextPercent/setSession/setAutoCompactEnabled/dispose`。
  - `interactive-mode.ts`：`getGrokLocation()`（`formatCwdForFooter`+branch+session name）、`refreshGrokChrome()` 简化、`createInteractiveView` 传入 session/ui、rebind 与 `stop()` 生命周期接线。
- Validation evidence:
  - `npx tsgo --noEmit` exit 0。
  - coding-agent 全量：229 files passed/6 skipped，1982 passed/49 skipped。
  - 快捷键栏移除后：`npm run check` exit 0、`npm run build:offline` exit 0、定向 grok/interactive-tui 测试 34/34 通过。
  - Thinking level 分级+切换闪烁后：全量 1984 passed/49 skipped；真实 tmux 确认 `high` 以 warning 黄渲染（ANSI `38;2;255;255;0`）。注：本机 kimi k3 仅支持单一 level，shift+tab 切换无变化，切换闪烁由 fake-timer 单测覆盖。
  - `npm run check` exit 0（Biome/pinned/imports/install-lock/tsgo/browser-smoke）。
  - `npm run build:offline` exit 0。
  - tmux 真实 smoke：100x28 显示 `~/Projects/easy-pi/pi (my-pi)` + 仪表 + `$0.000 (sub) 0.0%/1.0M (auto)  (kimi-coding) k3 • high` + 快捷键 + 扩展状态；40x8 存活且右侧优雅截断；resize 到 110x30 无残影。
  - `git diff --check` exit 0。
- 备注：`task_document.py` validator 在当前机器已不可用，本文档按既有台账结构手工对齐。

<!-- task-doc-section:risks-unresolved -->
## Risks and unresolved

- 未对真实 provider 流式做 TTY smoke；闪烁/变色逻辑由 fake-timer 单测覆盖。
- idle 呼吸每 900ms 触发一次重绘请求（仅 idle 且可见时）；对极端慢终端的影响未实测。
- 工作树仍未提交；提交需用户授权并排除 `.edru/` 与根目录中文文档。
