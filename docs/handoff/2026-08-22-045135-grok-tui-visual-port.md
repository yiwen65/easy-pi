# Session Handoff: Grok TUI 视觉迁移与 Pi 语义兼容

- Created: 2026-08-22T04:50:39+08:00
- Workspace: /Users/w/Projects/easy-pi/pi

> Next agent: start with Session summary. Re-verify drift-prone state before
> acting. This handoff supplies context, not new authorization.

## Session summary

- 用户目标是用 `/Users/w/Projects/easy-pi/grok-build` 的 TUI 视觉和交互结构替换 Pi 的 view/component 层，同时继续保留 Pi 的 agent loop、provider、session、工具协议、会话存储和扩展语义。
- 当前迁移已经可运行。启动命令为 `pi --tui-engine grok --tui-mode fullscreen`；回滚命令为 `pi --tui-engine legacy`。最初报告的 `Error: Unknown option: --tui-engine` 已通过 CLI 参数、main 接线和构建产物修复。
- Grok 模式现在有独立顶栏、上下文占用、Ready/活动状态宿主、圆角 composer、模型/思考信息、快捷键栏、用户/assistant/thinking 层级和工具状态卡，不再只是换 renderer 后继续挂载完全相同的 Pi 组件树。
- Pi 仍拥有业务语义。Grok 的 `PiSessionPort` 把原始 `AgentSessionEvent` 交回既有 `InteractiveMode.handleEvent()`；message/tool 组件继承 Pi 基类并保留 streaming、toolCallId、图片、Markdown transformer 和 extension renderer ABI。
- 扩展兼容性经过对抗审查和修复：`setStatus()` 可见；custom footer 真正替换并能恢复 Grok footer；working/retry 不重复或互相误隐藏；custom editor、inline confirm、widgets、header、overlay 和 `renderShell: "self"` 仍由 Pi 语义控制。
- 极小终端已处理：Grok composer 在 fullscreen 中保留 `minSize: 3`。真实 tmux 的 40x8、80x24 和 resize 到 100x30 均存活并正确重绘。
- 最终验证通过：`npm run check`、`./test.sh`、`npm run build:offline`、`git diff --check` 和任务文档 validator 均退出 0。coding-agent 最终为 229 files passed/6 skipped、1973 tests passed/49 skipped。
- 工作仍未提交或发布，当前位于 `my-pi` 的脏工作树。现有 `.edru/` 和根目录中文 Markdown 是用户/既有未跟踪文件，不属于本次迁移，不能删除或覆盖。
- 未调用真实 provider，因此网络流式输出没有做真实 TTY smoke；该部分由仓库 fixtures 和回归测试覆盖。未获得外部第三方 extension corpus 或多终端设备矩阵。

## User intent and success criteria

- 执行而非只做方案：建立并维护 task 文档，然后完成 TUI 移植。
- 视觉层必须明显区别于 Pi legacy，而不是只增加一个内部 engine 名称。
- 仅替换 renderer/view/component 表现层；Pi agent、session、provider、工具执行和扩展生命周期不得被新 TUI 接管。
- 保留 legacy 作为可立即回滚路径。
- 验证必须覆盖构建、单元/回归测试、终端尺寸变化、流式和工具状态、输入快捷键、session restore、扩展、主题及真实 TUI smoke。
- 不把未运行的项目描述为已验证；不调用付费 provider；不擅自提交或发布。

## Work completed and outcomes

- 新增 `packages/grok-tui/`：Grok action/reducer/render runtime 和 renderer composition root。
- CLI 支持 `--tui-engine legacy|grok`，并从 `main.ts` 传入 `InteractiveMode`；全局 linked `pi` 已验证解析到 `/Users/w/Projects/easy-pi/pi/packages/coding-agent/dist/cli.js`。
- 新增 `packages/coding-agent/src/modes/interactive-grok/`：
  - `pi-session-events.ts`、`pi-session-port.ts`
  - `grok-component-factory.ts`、`grok-interactive-view.ts`
  - `grok-top-bar.ts`、`grok-status.ts`、`grok-editor-frame.ts`、`grok-footer.ts`
  - `grok-user-message.ts`、`grok-assistant-message.ts`、`grok-tool-execution.ts`
- `InteractiveMode` 仅在 Grok engine 下创建新 view/factory；legacy 分支继续创建原组件和布局。
- Grok editor frame 包裹通用 `editorContainer`，没有复制 editor 状态，因此 selector、confirm、custom editor 和 focus 继续沿用 Pi。
- Grok transcript/tool 类继承 Pi 对应组件，只增加视觉 chrome。工具基类的 `getRenderShell()` 从 private 调整为 protected，使 Grok 子类可对 `renderShell: "self"` 原样透传。
- Grok footer 消费 `FooterDataProvider.getExtensionStatuses()`；启用 custom footer 时隐藏内置 Grok footer，清除时恢复。
- Grok view 使用单一 `statusSlot`：idle 时渲染 Grok Ready；active 时宿主 Pi 权威 `StatusIndicator`，从而保留 extension working message/frame/visibility 语义。
- 增加 CLI、runtime、session port、shell、transcript/tool、视觉 golden、engine routing 和 regression 测试。

## Key decisions, constraints, and rationale

- 采用 clean-room TypeScript 重实现 grok-build 的布局/行为，不复制 Rust 源码或资产。这样保留当前 Pi 许可边界；若以后直接复制 Apache-2.0 代码或资源，需要重新做 NOTICE/归属审计。
- 不建立第二套 `InteractiveMode`。用单一 factory/view seam 收口表现层，避免复制 6000+ 行 session/tool/extension 状态机。
- Grok view 不持久化业务状态，也不直接调用 provider 或 tool executor；`InteractiveMode` 和 `PiSessionPort` 是唯一业务边界。
- 主题继续使用 Pi 现有语义 token 和 theme proxy，避免增加必填 theme schema 字段破坏自定义主题。
- Pi 当前没有独立 ACP 式原生逐工具审批协议；本次只保留 extension `tool_call` hook、`ui.confirm` 和 trust 语义，没有伪造新审批事件。
- 对抗审查报告的 footer/status、重复 working、极小高度、self-shell 及 retry 隐藏问题均已修复；最终复核无 P0/P1。

## Files and artifacts

- 权威视觉迁移任务台账：`/Users/w/Projects/easy-pi/pi/docs/tasks/2026-08-22-grok-visual-components-task.md`
- 前置 runtime 移植台账：`/Users/w/Projects/easy-pi/pi/docs/tasks/2026-08-22-grok-tui-port-task.md`
- CLI：`/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/cli/args.ts`
- composition/main：`/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/main.ts`
- 业务接线：`/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Grok view/components：`/Users/w/Projects/easy-pi/pi/packages/coding-agent/src/modes/interactive-grok/`
- Grok runtime package：`/Users/w/Projects/easy-pi/pi/packages/grok-tui/`
- 重点测试：
  - `packages/coding-agent/test/grok-pi-session-port.test.ts`
  - `packages/coding-agent/test/grok-shell-components.test.ts`
  - `packages/coding-agent/test/grok-transcript-components.test.ts`
  - `packages/coding-agent/test/grok-visual-render.test.ts`
  - `packages/coding-agent/test/interactive-mode-grok-components.test.ts`
  - `packages/coding-agent/test/interactive-tui.test.ts`
- 当前所有迁移代码、manifest 和 lockfile 变化均未提交。

## Commands, validation, and evidence

- 启动：`pi --tui-engine grok --tui-mode fullscreen`
- 回滚：`pi --tui-engine legacy`
- 最终静态门禁：`npm run check`，exit 0；Biome 检查 1099 files，同时通过 pinned dependencies、TS imports、shrinkwrap/install-lock、`tsgo --noEmit` 和 browser smoke。
- 最终全仓测试：`./test.sh`，exit 0。coding-agent 229 files passed/6 skipped，1973 passed/49 skipped；其他 workspaces 也通过。
- 最终构建：`npm run build:offline`，exit 0，包含 tui、grok-tui、telemetry、ai、agent、session backend、protocol、client、server 和 coding-agent。
- 定向视觉/兼容测试覆盖 40/80/120 列、dark/light、streaming 中间态、tool pending/running/success/error、extension renderer、self-shell、CJK/emoji、custom editor/confirm host、footer status/replacement 和 working-vs-retry。
- 真实 tmux：
  - 80x24 Grok 启动显示 cwd/context、Ready、圆角 composer、model/thinking 和 shortcuts。
  - `/debug` 和 `!echo visual-smoke` 可用；resize 100x30 无残影；`/quit` 恢复终端。
  - 40x8 时进程 `dead=0`，composer 保留三行，底部信息按宽度裁剪。
  - `status-line.ts` 的 `setStatus("status-demo", "Ready")` 可见。
  - `custom-footer.ts` 启用后 shortcuts footer 消失并显示 custom footer；关闭后 shortcuts 恢复。
  - legacy smoke 保持原 Pi 双横线/editor/footer 外观。
- `git diff --check` 退出 0。
- `task_document.py validate --path docs/tasks/2026-08-22-grok-visual-components-task.md` 通过。
- 测试期间既有 `footer-data-provider` reftable `fs.watch` 用例在全仓并发下曾超时；隔离复跑 8/8，最终全仓复跑也通过，未修改该无关 watcher。

## Unresolved items, risks, and unknowns

- 未对真实 provider 做网络流式 TTY smoke；不要把 fixture 证据描述为真实模型调用验证。
- 没有第三方 extension corpus 或不同终端应用/操作系统实机矩阵。当前证据来自仓库 examples/fixtures、VirtualTerminal 和本机 tmux。
- 工作树包含本次之前已有的 runtime 移植、用户未跟踪文件和本次视觉迁移；提交前必须按文件范围审查，不能把 `.edru/` 或根目录中文文档误纳入提交。
- `docs/` 目前整体未跟踪，其中包含权威 task 文档和本 handoff；提交时应显式选择文件。
- Unverified：在用户真实 provider 配置和全部个人扩展同时启用时的长期稳定性。

## Recommended continuation

1. 如用户要正式落库，先刷新 `git status`/完整 diff，按 runtime、视觉组件、测试/文档拆分原子提交；明确排除 `.edru/` 和根目录中文 Markdown。提交或推送仍需用户授权。
2. 如继续做发布级验收，在用户授权且有可用 provider 后补一次真实 streaming/tool/confirm TTY smoke，并测试用户实际扩展集合。
3. 如继续打磨视觉，仅修改 `interactive-grok` 的 chrome/components 和 golden；避免把 agent/session/tool 状态复制进 view。
4. 若出现回归，先用 `pi --tui-engine legacy` 回滚表现层，再以 `docs/tasks/2026-08-22-grok-visual-components-task.md` 的验证矩阵定位。
