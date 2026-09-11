# Task Plan: Subagent 动态思维流与工具生命周期

- Created: 2026-09-01
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求先制定开发计划，再执行“视觉和生命周期接近主 Session”的 subagent 动态活动方案。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 bundled `subagent` 扩展通过独立 `pi --mode json` 子进程执行代理。子进程已经产生 thinking/text delta 与工具 start/update/end 事件，但扩展只在完整 message 结束后更新主会话；Grok 中独立的 subagent 默认折叠壳又隐藏了 partial `renderResult`。目标是在不引入完整嵌套 Session 核心组件、不改变模型/工具执行语义的前提下，让 single、chain、parallel subagent 在主会话中以接近主 Session 的视觉语言动态显示思维尾流、工具生命周期、回答进度和最终状态。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- 为子进程 JSON 事件建立有界、可测试的实时活动 reducer。
- 消费 assistant thinking/text delta 与 tool execution start/update/end。
- 对 token 级更新做 80–120ms 合并，生命周期边界立即刷新。
- 修复 stdout UTF-8 分片处理，并移除不存在的 `tool_result_end` 分支。
- 让 subagent 使用独立 self-render shell，在 Grok 普通 tools 折叠时仍显示实时活动。
- 支持 single、chain、parallel 的活动隔离、最终刷新、错误与中止状态。
- 更新示例文档、定向测试、静态检查和实际 coding-agent 构建产物。

**Non-goals**

- 不把子 Session 持久化为主 Session transcript 的一等消息/工具条目。
- 不复用私有 `GrokThinkingTurnGroupComponent` / `GrokToolTurnGroupComponent`，不实现嵌套点击路由。
- 不承诺与主 Session 完全相同的 marquee timer、Ctrl+T thinking 隐藏、内置 diff/image/custom tool renderer。
- 不修改 provider、模型调用、subagent 权限/信任、任务调度和最终模型可见输出语义。
- 本轮不新增 JSON wire profile；继续使用 full JSON，但只在父进程保留有界活动投影。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 子进程使用 full `--mode json`，但 `processLine()` 当前只消费 `message_end`，动态 delta 和工具生命周期被丢弃。 | `packages/coding-agent/examples/extensions/subagent/index.ts#runSingleAgent`；`packages/coding-agent/src/modes/print-mode.ts#runPrintMode`。 |
| F-002 | full JSON 的 `message_update` 保留 thinking/text/toolcall delta，同时移除累计 partial snapshot；其他工具事件原样输出。 | `packages/coding-agent/src/modes/json-event.ts#toJsonEvent`；`packages/ai/src/types.ts#AssistantMessageEvent`。 |
| F-003 | subagent 的 `onUpdate()` 已由 Agent loop 转换为外层 `tool_execution_update`，InteractiveMode 会更新现有工具组件并请求重绘。 | `packages/agent/src/agent-loop.ts#executePreparedToolCall`；`packages/coding-agent/src/modes/interactive/interactive-mode.ts` 的 `tool_execution_update` 分支。 |
| F-004 | Grok 独立 subagent 的 default shell 在折叠状态只显示 overview，隐藏扩展 `renderResult()`；self shell 会保留扩展自有渲染。 | `packages/coding-agent/src/modes/interactive-grok/components/grok-tool-execution.ts#render`；`packages/coding-agent/test/grok-transcript-components.test.ts` 的 self-shell 覆盖。 |
| F-005 | token 级无节流 `onUpdate()` 会让 Agent loop 累积 update Promise，且 full JSON/tool details 可能放大内存与重绘成本。 | `packages/agent/src/agent-loop.ts#executePreparedToolCall`；项目 `LEARNS.md` 的 “JSON process observers” 条目。 |
| F-006 | 当前 stdout 使用 `data.toString()` 拼接，UTF-8 多字节字符跨 chunk 时没有 decoder 保证；`tool_result_end` 不是 canonical Agent event。 | `packages/coding-agent/examples/extensions/subagent/index.ts#runSingleAgent`；`packages/agent/src/types.ts#AgentEvent`。 |
| F-007 | 当前实际全局 `pi` 的 `subagent` 工具由 settings package `wj-pi-harness` 注册，不是本仓库未安装的 example extension；因此 T-001–T-005 的 example 实现不会改变用户当前 subagent UI。 | `~/.pi/agent/settings.json` 的 package `../../Projects/easy-pi/wj-pi-harness`；`~/.pi/agent/extensions` 无 subagent；`wj-pi-harness/src/subagent/extension.ts` 注册 `name: "subagent"`。该外部仓库当前在 `extension.ts`、`process-runner.ts`、types/tests 等目标文件上存在大量其他会话未提交改动。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “接近主 Session”指相同的视觉语义与生命周期反馈（`✦` thinking、pending/running/success/error 工具符号、动态回答尾部），而不是完全复用主 Session 私有组件。影响：允许扩展内实现有界 renderer；通过视觉/生命周期测试验证。
- Assumption: 实时活动是易失 UI 状态；最终 `messages`、usage 和 tool result details 继续作为权威结果。影响：恢复历史时只保证最终输出，不重放逐 token 动画。
- Assumption: full JSON wire 的既有大 payload 风险在本轮通过父端有界投影和更新节流缓解，但不彻底解决子进程 wire 上界。影响：在最终限制中明确记录，后续需要 additive activity profile 才能建立硬上界。
- Open question: 无阻塞问题；若实现发现必须改变 public JSON/extension ABI，则新增任务并先记录影响，不静默扩张范围。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- streaming thinking delta 能在主会话 subagent 独立区域动态更新，并使用 `✦` 与 landing-page accent 颜色。
- tool start/update/end 能按 pending/running/success/error 生命周期动态更新，至少显示名称、参数摘要和有界输出预览。
- text delta 能显示有界回答尾部；`message_end` 和最终 tool result 保持权威，不重复最终消息。
- single、chain、parallel 的活动状态互不串线；并行任务可独立显示运行/完成/失败。
- 更新频率不高于约 10Hz，thinking/text/tool preview 和最近工具列表均有明确上限；终止、错误、中止会立即最终刷新并清理 timer。
- stdout UTF-8 跨 chunk 安全；畸形 JSON 不导致崩溃；不存在的 `tool_result_end` 分支被移除。
- Grok 普通 tools 折叠时，subagent 动态区域仍可见；`Ctrl+O` 继续切换摘要/详细结果。
- 既有 subagent 最终输出、usage、project trust、single/chain/parallel 语义不回归。
- 定向测试、`npm run check`、coding-agent build 和编译产物检查通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-005 → T-006 → T-004。
- Parallel batches: Batch 1 为 T-001；Batch 2 为 T-002；Batch 3 为 T-003；Batch 4 为 T-005；Batch 5 为 T-006；Batch 6 为 T-004。由于后续任务共享 subagent 状态契约与 renderer，执行图有意串行。
- Serialization constraints: `packages/coding-agent/examples/extensions/subagent/index.ts`、subagent renderer 状态、任务文档和最终构建均由 coordinator 串行集成；子任务不得修改任务文档或其他会话的未跟踪文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立有界实时活动 reducer

- Status: done
- Owner: subagent-live-state
- Objective: 定义可独立测试的 subagent activity 状态、JSON 事件归约规则和容量边界。
- Inputs and prerequisites: F-001、F-002、F-005；无前置任务。
- Scope or files: `packages/coding-agent/examples/extensions/subagent/live-activity.ts`；`packages/coding-agent/test/subagent-live-activity.test.ts`。
- Expected output: 可处理 thinking/text/tool lifecycle 的纯 reducer，支持 authoritative message end、并发 call ID、状态上限和渲染所需摘要。
- Dependencies: None.
- Execution steps:
  1. 定义 activity、tool status、bounded tail 和 JSON event subset 类型。
  2. 实现 message start/update/end 与 tool start/update/end 归约。
  3. 对 thinking/text/output/tool count 设置确定性上限。
  4. 添加交错 delta、多工具、错误、截断和新 turn 测试。
- Acceptance criteria:
  - reducer 不依赖 TUI 或子进程，输入相同事件序列得到确定性状态。
  - thinking/text/tool preview 与工具数量不会无界增长。
  - message end 能覆盖增量临时状态而不产生重复最终输出。
- Verification method:
  - 定向运行 `test/subagent-live-activity.test.ts`。
- Validation evidence: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/subagent-live-activity.test.ts`：1 file / 8 tests passed；coordinator 已审阅 reducer 与测试，确认仅新增两个 owned paths。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 接入子进程事件、节流和生命周期清理

- Status: done
- Owner: coordinator
- Objective: 将 full JSON 动态事件接入 reducer，并以有界频率通过现有 `onUpdate()` 传播。
- Inputs and prerequisites: T-001 完成；F-003、F-005、F-006。
- Scope or files: `packages/coding-agent/examples/extensions/subagent/index.ts`；必要时扩展 T-001 测试文件。
- Expected output: UTF-8 安全 JSONL 解析、约 100ms coalescing、生命周期立即 flush、timer/abort/close 清理、single/chain/parallel activity 隔离。
- Dependencies: T-001.
- Execution steps:
  1. 使用 stream encoding/decoder 保证 UTF-8 chunk 安全。
  2. 消费 canonical message/tool events并更新每个 `SingleResult.activity`。
  3. 实现 trailing coalescing 与 immediate lifecycle flush。
  4. 删除 stale `tool_result_end` 分支并确保最终 result 前清理 timer。
- Acceptance criteria:
  - token delta 不会逐个同步触发外层更新。
  - tool/message 终态、错误、中止和 close 不丢最后一帧。
  - chain/parallel wrapper 保持对应 result 的 activity，不发生跨任务覆盖。
- Verification method:
  - reducer/调度定向测试；TypeScript 检查。
- Validation evidence: `test/subagent-live-activity.test.ts` 9/9 passed（含 100ms coalescing/flush/dispose）；目标 Biome 3 files passed；根 `tsgo --noEmit` passed；代码审阅确认使用 `setEncoding("utf8")`、canonical message/tool events、message/tool terminal immediate flush、finally dispose，并移除 stale `tool_result_end`。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实现独立动态 subagent 渲染

- Status: done
- Owner: coordinator
- Objective: 让 subagent 在 Grok 折叠工具组之外持续显示接近主 Session 的 thinking、tool 和 answer 生命周期。
- Inputs and prerequisites: T-002 完成；F-004。
- Scope or files: `packages/coding-agent/examples/extensions/subagent/index.ts`；`packages/coding-agent/examples/extensions/subagent/README.md`；相关 Grok/subagent renderer 测试。
- Expected output: self-render shell；single/chain/parallel live rows；accent thinking；工具状态符号；expanded final Markdown/usage 保持现状。
- Dependencies: T-002.
- Execution steps:
  1. 将 subagent 声明为 self-rendering independent tool。
  2. 为 activity 添加宽度安全的 thinking/tool/text 摘要 renderer。
  3. 在 single、chain、parallel 分支接入 running 与 settled 视觉状态。
  4. 更新文档中的动态行为与已知 fidelity 限制。
- Acceptance criteria:
  - 默认 Grok 折叠状态下可见动态 activity，不被 tools overview 隐藏。
  - thinking 为 `✦` accent；工具符号与主 Session pending/running/success/error 语义一致。
  - completed/expanded 输出、usage 和失败诊断保持可用。
- Verification method:
  - renderer/Grok 定向测试，覆盖 40/80/120 列与 ANSI 宽度。
- Validation evidence: `subagent-live-activity`、`subagent-live-render`、`interactive-mode-grok-components`、`grok-transcript-components` 共 4 files / 38 tests passed；project-trust 2/2 passed；目标 Biome 与根 tsgo passed。测试覆盖 self shell、collapsed Grok 可见性、accent thinking、四种工具状态、single/chain/parallel、宽度上限。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 修复进程边界与终态审查问题

- Status: done
- Owner: coordinator
- Objective: 关闭 T-004 对抗审查发现的进程边界、快照不可变性、abort/signal、失败诊断和 expanded-running 缺陷。
- Inputs and prerequisites: T-003 完成；review run `ab4b7d53-ed00-4fc8-8d8e-ac8e64be74b3` 的 8 项 findings。
- Scope or files: `packages/coding-agent/examples/extensions/subagent/index.ts`；live activity/render/process 测试；任务文档。
- Expected output: event shape validation、immutable partial snapshots、可靠 SIGTERM→SIGKILL、signal exit failure、结构化 abort details、stderr failure rendering、type-safe args formatter、running expanded view 与 process regressions。
- Dependencies: T-003.
- Execution steps:
  1. 修复高风险 malformed event、mutable details 和 abort escalation。
  2. 保留 abort/signal/failure details，所有 mode 显示 stderr/error。
  3. 加固 tool args 格式化和 parallel running expanded 视图。
  4. 添加进程边界/不可变快照/终态测试并复跑 reviewer。
- Acceptance criteria:
  - malformed typed JSON 不崩溃；旧 partial details 不被后续状态突变。
  - abort、signal close 和 SIGTERM-resistant child 均有界终止并保留错误详情。
  - single/chain/parallel 的 stderr-only failure 可见；running expanded 显示 task 与 live activity。
  - 新进程回归与既有 focused tests 通过，复审无 high/medium finding。
- Verification method:
  - 新 process-level Vitest；focused UI/reducer tests；read-only adversarial re-review。
- Validation evidence: `subagent-live-activity`、`subagent-live-render`、`subagent-process-boundary` 共 3 files / 23 tests passed；根 `tsgo --noEmit` 通过；process tests 覆盖 malformed JSON/payload、UTF-8 byte split、immutable snapshot、signal-only close、abort escalation 与 cleanup；renderer tests 覆盖三种 mode 的 stderr-only failure、running parallel expanded 和 malformed known-tool args。只读复审 `46ae6c24-0198-47ea-aa9e-fa386abeae0f` accepted，无 high/medium finding。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 将实现落到当前实际启用的 WJ subagent

- Status: done
- Owner: coordinator
- Objective: 在实际注册当前 `subagent` 工具的 `wj-pi-harness` 事件投影、details 和 renderer 中实现同等的有界 thinking/tool/answer 动态活动。
- Inputs and prerequisites: T-005 完成；F-007。
- Scope or files: `/Users/w/Projects/easy-pi/wj-pi-harness/src/subagent/extension.ts`、`process-runner.ts`、活动 state/types/ledger 与相关 tests；确切边界需与该仓库当前其他会话改动协调。
- Expected output: 当前全局 `pi` 实际加载的 subagent 动态 UI 生效，而非仅更新未安装 example。
- Dependencies: T-005.
- Execution steps:
  1. 协调或等待 WJ Harness 重叠工作树改动稳定。
  2. 从 RPC full events 投影有界 thinking/text/tool lifecycle 到 task details。
  3. 在 WJ self-render shell 中实现 single DAG task 和并发 task 的动态展示。
  4. 运行 WJ focused tests/check，并回到 T-004 做 Pi 集成构建与交付。
- Acceptance criteria:
  - 当前 settings package 注册的 `subagent` 显示真实 thinking、answer 和 tool lifecycle。
  - 不覆盖或误提交 WJ Harness 其他会话改动。
  - 有界投影、coalescing、终态和 renderer tests 通过。
- Verification method:
  - WJ Harness process/orchestrator/extension focused tests 与 `npm run check`；重启全局 `pi` 后加载路径核对。
- Validation evidence: 在 active WJ Harness 中新增 pure bounded reducer/scheduler，并接通 RPC full events → process runner → ephemeral runtime registry → DAG progress overlay → self-shell TUI。focused 4 files / 108 tests passed；完整 `npm run check` 通过（Harness 24/24，Subagent 344 passed/3 skipped）；`node -e 'import("./wj-harness/index.ts")'` import smoke passed；`pi list` 确认全局 settings 加载该本地 package。只读复审 `23f55dd4-7348-43a3-ade8-b456f326bbac` accepted，无 high/medium finding。原 Pi example 候选已全部恢复/删除，避免提交错误目标。
- Blocker: None. 用户已明确授权直接在当前 dirty WJ Harness worktree 上做手术式集成；必须保留并逐项区分其他会话改动。
- Unblock condition: None.

### [ ] T-004 — 集成验证、构建和交付

- Status: blocked
- Owner: coordinator
- Objective: 验证完整路径，更新实际全局 `pi` 使用的 dist，并记录剩余限制。
- Inputs and prerequisites: T-005 完成。
- Scope or files: 本计划涉及文件；`packages/coding-agent/dist` 构建产物（gitignored）；任务文档。
- Expected output: 定向测试、邻接 subagent/trust/Grok 测试、根检查、coding-agent build、dist 证据和最终任务状态。
- Dependencies: T-006.
- Execution steps:
  1. 运行所有新增/修改测试及相关现有回归。
  2. 运行 `npm run check` 并核对共享 worktree 差异。
  3. 重建 coding-agent，确认 dist 包含 activity 接线。
  4. 检查 focused diff，提交仅本任务文件，完成任务文档。
- Acceptance criteria:
  - 所有 required checks 通过，无本任务引入的 warning/type error。
  - dist 与 source 一致，重启 `pi` 后可加载新实现。
  - task document validator 通过，所有任务证据可追溯。
- Verification method:
  - 精确记录测试、check、build、diff 和 commit 结果。
- Validation evidence: active WJ Harness 实现与完整 check 已通过；Pi 根 `npm run check`、coding-agent build 也已通过，active package path/import smoke 已核对。尚未提交：WJ Harness 目标文件混有大量其他会话未提交改动，无法安全按整文件提交本任务。
- Blocker: 共享 WJ Harness worktree 的重叠未提交改动阻止安全提交；运行时代码已可在重启后加载。
- Unblock condition: 其他会话先提交/稳定重叠文件，再只提交本任务 hunks；或用户接受由拥有该共享变更集的会话统一提交。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Reducer unit：thinking/text delta、authoritative end、tool lifecycle、错误、截断、最近工具上限、多 turn。
2. Scheduling/process：更新节流、immediate flush、close/abort cleanup、UTF-8 split、malformed JSON。
3. Modes：single、chain、parallel task identity 与并发隔离。
4. Renderer：running/settled、collapsed/expanded、40/80/120 列、ANSI visible width、accent thinking 与状态符号。
5. Neighbor regressions：`interactive-mode-grok-components.test.ts`、`grok-transcript-components.test.ts`、`suite/regressions/8261-subagent-project-trust.test.ts`。
6. Static/system：根 `npm run check`；`npm run build --workspace=@earendil-works/pi-coding-agent`；dist source marker 检查。
7. 不调用真实 provider，不使用付费 API；动态模型输出以事件 fixture 验证。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- **事件洪泛（高）**：token delta 直接 onUpdate 会累积 Promise/重绘；以约 100ms coalescing、有界 state、终态 immediate flush 控制。
- **wire payload（中）**：full JSON 仍可包含大型工具 payload；本轮只保存 bounded preview，不声称建立 wire 硬上界。若实测仍不可接受，后续设计 activity profile。
- **并发串线（高）**：parallel/chain 共用回调容易覆盖；每个 `SingleResult` 独立 activity，并以 task index + child call ID 管理。
- **渲染回归（中）**：self shell 会同时影响 legacy/Grok 外观；保持现有 renderCall/final renderResult 信息并增加定向 snapshot/文本断言。
- **终态丢帧（高）**：timer、abort、process close 竞态可能漏最终状态；所有 lifecycle boundary immediate flush，finally 清理 timer。
- **共享 worktree（中）**：存在其他会话未跟踪文档；只编辑计划列出的 owned files，check/build 后核对 status，不提交其他文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-01: Task document created.
- 2026-09-01: 完成静态关键路径分析；确认采用 extension-local bounded activity + self-render shell，不实施完整嵌套 Grok 核心组件复用。
- 2026-09-01: T-001 → in_progress；首次委派因 nested workspace owned path 少 `pi/` 前缀触发 path_violation，未留下文件改动；修正 ownership 后重新委派。
- 2026-09-01: T-001 → done；subagent-live-state 新增 pure reducer 与 8 个测试，coordinator 复跑 8/8 通过并完成代码审阅。
- 2026-09-01: T-002 → in_progress；coordinator 开始接入 JSONL、节流和生命周期清理。
- 2026-09-01: T-002 → done；接入 canonical live events、UTF-8 stream encoding、100ms scheduler 与 lifecycle flush；focused tests 9/9、Biome、根 tsgo 通过。
- 2026-09-01: T-003 → in_progress；coordinator 开始实现 self-shell 动态 renderer 与模式覆盖。
- 2026-09-01: T-003 → done；实现 self shell、`✦` accent thinking、工具 lifecycle 与 answer tail；single/chain/parallel、Grok collapsed 和宽度测试通过。
- 2026-09-01: T-004 → in_progress；开始系统检查、构建、dist 验证和最终审阅。
- 2026-09-01: 对抗 review `ab4b7d53-ed00-4fc8-8d8e-ac8e64be74b3` rejected：发现 malformed event crash、mutable partial snapshot、abort escalation、signal exit、失败诊断与 running expanded 缺陷。
- 2026-09-01: T-004 → blocked；新增 T-005 并置为 in_progress，先关闭 review findings。
- 2026-09-01: T-005 → done；新增 process-boundary regressions 并修复 event validation、snapshot、abort/signal、failure rendering 与 expanded-running；3 files / 23 tests、根 tsgo 通过，复审 `46ae6c24-0198-47ea-aa9e-fa386abeae0f` accepted，无 high/medium finding。
- 2026-09-01: T-004 → in_progress；开始完整回归、根 check、coding-agent build、dist 验证与提交。
- 2026-09-01: Pi 侧 6 files / 48 tests、根 `npm run check` 与 coding-agent build 通过；随后 active-path 核对发现全局 settings 中实际 `subagent` 来自 `wj-pi-harness`，example extension 未安装。
- 2026-09-01: 新增 T-006 并置为 blocked；T-004 → blocked。WJ Harness 必要目标文件已有大量其他会话未提交改动，需先协调共享 worktree，未提交当前 example patch。
- 2026-09-01: 用户选择“等待并改 WJ Harness”；保持当前候选未提交，不在 dirty WJ worktree 上叠加修改，待重叠文件稳定后恢复。
- 2026-09-01: 用户随后明确“直接改”；T-006 → in_progress，授权在当前 dirty WJ Harness worktree 上手术式集成，保留其他会话改动。
- 2026-09-01: T-006 → done；active WJ RPC full event 增加有界 ephemeral activity、100ms coalescing、runtime registry overlay、self-shell renderer 和四状态视觉；focused 108 tests、完整 WJ check、import smoke 通过，复审无 high/medium finding。
- 2026-09-01: 恢复/删除之前错误目标的 Pi example 候选，仅保留 active WJ 实现。T-004 继续 blocked 于共享 dirty worktree 的安全提交，不影响重启后从本地 package 加载。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: active WJ tool 的 T-006 实现与完整 check 已通过；T-004 仅因共享 dirty worktree 无法安全提交而 blocked。重启 `pi` 后本地 settings package 会加载当前实现。
- Limitations: RPC transport 仍受既有 line/stdout limits 而非新增 activity wire profile；完整主 Session 组件/交互等价不在本轮范围；本轮修改未独立 commit，必须由共享 WJ 变更集拥有者后续统一提交。
