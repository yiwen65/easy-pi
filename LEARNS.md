# Project Learnings

## 全屏选区复制——屏幕行复制会带上边框/软换行/可见窗口，输入复制必须走编辑器逻辑文本

- What happened: 用户报告“输入控件换行异常，复制已输入的文字会自动加分割线”。真实 TUI 复现：全屏（alt-screen）下拖选输入框或用户消息，剪贴板得到 `╭─ ❯ 20:13 ─…╮` / `│` / `╰────╯` 等边框行、行尾填充空格、在视觉折行处插入的 `\n`；19 行输入只复制到可见 10 行 + `❯ ─── ↑ 9 more ───` 指示器；粘贴占位符 `[paste #1 +12 lines]` 被原样复制。
- Why it failed: `packages/tui/src/tui-alt-screen.ts` 的 `copySelectionToClipboard()` 以 `previousScreen`（整屏渲染行）或 `box.scrollContentLines`（组件渲染行）为数据源，逐行 `join("\n")`，没有任何“UI 装饰 vs 内容”“软换行续行”“组件逻辑文本”的概念；easy-pi 的 grok 引擎又给输入框和每条用户消息都加了边框，编辑器还只渲染 `max(5, rows*0.3)` 行，三者叠加放大了症状。
- Correct approach: 复制“自己输入的文字”不要依赖屏幕选区——新增 `handleCopyShortcut`（`app.message.copy`/ctrl+x）：编辑器非空时复制 `editor.getExpandedText?.() ?? editor.getText()` 的逻辑文本（占位符已展开、无边框、无软换行断点、包含滚出窗口的行），为空时保持复制最后一条助手消息。
- Prevention: 任何“复制输入/消息”需求都要求组件提供逻辑文本，禁止用屏幕行拼接兜底；验证时用 `pbpaste` 断言剪贴板字节（无 `│╭╰❯`、无 `[paste #`、无 UI 填充），再断言 fullscreen 的 `Copied!` flash 与 regular 的状态行。
- Related pitfall（本次误判根因）: `tmux send-keys -l` 会丢弃字符串里的控制字节（LF/CR 静默消失），据此得出的“Ctrl+J/Enter 不插入换行”是假结论；控制键必须用 `tmux send-keys -H 0a`（或 `send-keys Enter`），并用 `stty raw -echo; cat -u -v > file` 先验证字节确实到达 pane。
- Verified by: 2026-09-20 源码运行 `--tui-mode fullscreen`（grok）实测：空编辑器 ctrl+x 得到 `two`（最后助手消息）；含长中文行 + 12 行粘贴占位符的草稿 ctrl+x 得到 14 行纯逻辑文本（无边框/无占位符/长行未被折断）。`packages/coding-agent` vitest 2556 通过（6 个失败均为本 worktree 既有的会话重绑/缓存亲和失败，与本次改动无关）；`tsgo --noEmit` 与改动文件 biome 通过。

## Thinking 点击折叠——必须验证鼠标选择状态机，而非只调用组件方法

- Wrong approach: 只测试 `GrokThinkingTurnGroupComponent.handleOverviewClick` 的行命中，就认定任意行点击可折叠；用户随后报告点击触发 copy。
- Why it failed: `TuiAltScreen` 消费内容点击后仍保留 `lastClick`，快速再次点击被识别为选词，anchor 移到词首，绕过内容点击并复制。另一个已复现边界是同格 motion 被无条件判为拖选。
- Correct approach: 内容点击被消费后清除多击计数；字符选择尚未拖动且 motion 仍在原格时忽略该 motion，真实跨格拖选继续复制。
- Prevention: 用 VirtualTerminal 发送 SGR press/motion/release，覆盖词内部连续点击、同格 motion、展开正文点击及真正拖选；同时断言可见折叠状态与 clipboard 调用，不能只调用组件方法。
- Verified by: `test/grok-thinking-mouse.test.ts` 两例修复前分别复制 Thinking 和未展开；清除计数后仅第一例转绿，再修正同格 motion 后两例通过。Grok 20 项、TUI 45 项及根 check 通过；未替代用户物理终端复测。

## `/agents` 焦点面板——捕获焦点的 UI 必须明确区别于正文

- Wrong approach: `/agents` 只渲染几行列表，overlay 高度随内容收缩；底下主输入框继续可见。测试替换 `ui.custom` 并只断言文字存在，就宣称用户可用。
- Why it failed: 焦点已经转走，但界面仍像普通正文加可输入的主编辑器。用户报告“面板没出现、主 session 卡死”。死 owner 只解释重启后的拒绝，不能据此宣称最初冻结已定位；Host 发出字节也不能证明用户看到了面板。
- Correct approach: 对照同一会话的 Host 输出和实际 App 截图。本次截图证明面板就在正文中间；改为填满 viewport 的明确边框面板，遮住主输入区并显示当前取消键去向。保留 Esc 关闭、原草稿及后台任务。
- Prevention: 使用真实 Grok renderer + InteractiveMode.showExtensionCustom + xterm，放入主输入草稿/正文 sentinel，断言 modal 中不可见、Esc 后焦点及草稿仍保留；覆盖 resize。不要把传输、渲染和视觉识别混为一个 oracle。
- Verified by: 2026-09-09 grok-agents-host.test.ts 普通/全屏两例修复前均因 root draft 仍可见而失败，修复后通过；现有面板/工具共 3 files / 21 tests 通过。未复现进程死锁，不把视觉修复冒充已证明的并发修复。

## Fullscreen TUI 内容边界——禁止渲染内容透传 DEC 私有模式序列

- Wrong approach: 把工具输出/日志中的所有 ANSI 片段原样保留到最终终端行，认为只有 renderer 自己会控制 alternate screen。
- Why it failed: 捕获内容可包含 `ESC[?1049l`（以及 47/1047 等 DEC 私有模式）；最终 write 会直接命令终端退出全屏，后续日志落到普通屏且失去 TUI 布局。
- Recognition signal: renderer 的 `mode` 仍是 `fullscreen`，但终端已离开 alternate screen；`normalizeTerminalOutput()` 对 `ESC[?1049l` 输入原样返回。
- Correct approach: 在 `packages/tui/src/utils.ts` 的最终内容规范化层移除所有 CSI DEC 私有模式 set/reset（`ESC[?...h/l`），同时保留 SGR 颜色样式；renderer 自身的模式控制位于内容管线之外，不受影响。
- Prevention: 终端内容安全测试必须覆盖 alternate-screen enter/exit 注入，并在 `TuiAltScreen` 集成层断言实际 write 中只有 renderer 自己的 enter 序列。
- Verified by: 2026-08-27 `terminal-output-safety.test.ts` 修复前稳定失败、修复后通过；`tui-alt-screen.test.ts` 证明日志注入不会产生 exit write，TUI 全套与 Grok 57/57 通过。

## `npm run check` 会在共享 worktree 中自动改写文件——运行后必须核对改动范围

- What happened: 在实现 compaction 子系统后运行仓库规定的 `npm run check`，其中 `biome check --write` 自动修复了 34+ 个文件（包括本 session 的新增未跟踪文件）。
- Risk: 多 session 共享 worktree 时，自动修复可能触及其他 session 的未跟踪文件；track 文件也可能被改。
- Correct approach: 运行 `npm run check` 后立即用 `git diff --stat` / `git status --porcelain` 核对：tracked 文件 diff 必须与开工前基线一致（本任务已核对：16 个 M 文件与他 session 开工前完全相同）；biome 不可自动修的 lint（noImplicitAnyLet 等）要手工修。
- Related pitfall（本任务实际踩到）: 正则中 `\b` 在 `/` 前不成立（两者均非 word char），匹配绝对路径需把路径分支放在 `\b` 之外（见 subsystem/narrative.ts EXACT_VALUE_PATTERN）；抽取 prompt 的事件序列化必须包含 eventId，否则 extractor 的 provenance 引用无法解析（validator P0）。
- Verified by: 2026-08-22 高保真 compaction 任务，`npm run check` exit 0 且 169/169 子系统测试通过。

## `packages/coding-agent` TUI 组件测试 — 宽度感知组件的测试主题必须用 ANSI 码而非可见标记

- Wrong approach: 为断言样式给测试主题包可见标记（如 `text: (t) => \`<T>${t}</T>\``），再用它渲染按 `visibleWidth` 截断/对齐的布局组件（顶栏、footer/stats bar）。
- Why it failed: `visibleWidth` 会把 `<T>` 等字面字符计入宽度，导致组件提前截断、右侧内容被丢弃，样式断言打在被截掉的文本上而失败。
- Recognition signal: 断言 `toContain("<S>…</S>")` 失败，实际输出里出现截断省略号且右侧区段消失。
- Correct approach: 测试主题用互不相同、可见宽度为零的 ANSI 转义序列包装（如 `\x1b[31m${t}\x1b[0m`），断言匹配转义序列本身；参见 `test/grok-shell-components.test.ts` 的 `markerTheme`。
- Prevention: 给任何调用 `truncateToWidth`/`visibleWidth` 的组件写带样式断言时，先确认包装符的 `visibleWidth` 为 0。
- Verified by: 2026-08-22 Grok stats bar 任务，`markerTheme` 从可见标记改为 ANSI 后 `grok-shell-components.test.ts` 19/19 通过。

## AgentSession 固定层接线——不要把常驻 contract 注入成普通 user message

- Wrong approach: 在 `transformContext` 中把完整 Task Ledger 固定层作为首条 user message 注入每次 provider 请求。
- Why it failed: 它改变了用户消息序列与批处理语义，导致 image/template/extension/queue 断言错位，并让 provider 把固定层当成普通对话；全套件出现 14 个相关回归。
- Correct approach: 稳定固定层写入下一请求的 system prompt；只有同轮刚产生、来不及进入 context snapshot 的 pending warning 才在 transform 阶段临时追加，且不持久化。
- Prevention: 修改 provider context 分层后，除 compaction 测试外必须目标跑 prompt、extension、queue、concurrent/retry 套件。
- Verified by: 2026-08-23 Task Ledger/TUI 接线；改为 system + pending-only transform 后相关回归文件 61/61 通过，coding-agent 整套仅剩无关 watcher flaky。

## 多种内部 LLM 调用共用 faux stream——为 Goal Interpreter 单独注入 CompleteFn

- Wrong approach: Goal Interpreter 与主 agent/compactor 共用测试 faux provider 的顺序响应队列。
- Why it failed: 每条用户消息新增一次内部调用，消费原本属于 assistant/compaction 的下一条响应，表现为自动压缩不触发、queued response 丢失、call-count 偏移，甚至等待主响应的并发测试超时。
- Correct approach: `HfCompactionConfig.goalComplete` 独立注入；生产未配置时仍回退真实 compactor adapter，通用测试 harness 默认注入确定性 noop，只有目标测试显式提供 proposal。直接 `new AgentSession(...)` 且测试范围不含 compaction 的 fixture 应显式 `hfCompaction: { mode: "off" }`；需要覆盖 default-on 的顺序响应 fixture 必须把 Goal Interpreter 响应单独列入队列。
- Prevention: 新增或扩大任何内部模型调用的触发范围时，先审计 common harness 之外的直接 AgentSession fixture 与 faux response queue；目标跑 prompt、queue、concurrent、retry 和 session replacement，再跑 coding-agent 全套件。
- Verified by: 2026-08-23 default-on/queued/retry 回归修复；2026-08-24 移除 goal keyword skip 后，`agent-session-concurrent` 3 个超时、retry call-count 4→5、session-switch 消费错响应，按上述 fixture 隔离后 coding-agent 272 files / 2320 passed。
- Single-pass compaction follow-up: 删除 extractor、把 compactor 从“extraction + handoff”合并为一次 handoff 后，所有 AgentSession faux response queue、stream call-count 与 stage 断言也必须同步从 2 次改为 1 次；否则响应错位会伪装成产品失败。唯一模型调用返回后、进入 deterministic fallback 前必须重新检查本地 `AbortSignal`，避免 fallback 吞掉用户取消并发布 snapshot。预防性验证至少包含 `test/suite/agent-session-compaction.test.ts`、orchestrator 单调用/payload projection 回归和根 `npm run check`。Verified by: 2026-08-26 先触发旧 `extract` audit 类型错误与 3 个 AgentSession 回归，修正后 17 files / 138 tests 及根 check 通过。

## 版本化 optional-list patch——先比较语义默认值再 bump version

- Wrong approach: 用 `JSON.stringify(next) !== JSON.stringify(current)` 直接比较 optional list；空 patch 把 `undefined` 物化为 `[]`，被误判为状态变化。
- Why it failed: 表示差异不等于契约语义差异；虚假版本会制造 ledger 漂移并让仍有效的 pending approval 过期。
- Recognition signal: `addScope: []`、`addExclusions: []` 等空操作在无内容时仍增加 task/ledger version。
- Correct approach: 比较前把 optional list 按领域默认值规范化（如 `current ?? []`）；语义相同则保留原表示并以 no-op 拒绝，只有真实 add/remove 才创建新版本。
- Prevention: 每个版本化 patch 字段都测试 absent、empty、same、add、remove-last 五种边界，并同时断言 task version、ledger version 与 event count。
- Verified by: 2026-08-24 `PATCH_TASK_CONTRACT` 对抗复核；新增 empty optional-list no-op 测试后 focused 57/57、coding-agent 2320/2320 通过。

## Branch-scoped event projection——tag gate 先于 causal closure，boundary 必须是 branch-visible

- Wrong approach: 把当前 path entry ids 直接预填进 visible event set，并用 `branchHeadId visible OR causal parent visible` 判成员；同时 `freeze()` 返回 base log 的全局末尾 seq。
- Why it failed: forged/collision event id 可绕过 branch tag；带 sibling tag 但共享旧 parent 的事件会泄漏；全局 boundary seq 与 branch-visible `triggerHeadEventId` 不配对，刚激活 snapshot 下一轮即被判 detached。
- Correct approach: path ids 只作为 causal/source refs，visible event ids 单独构造；先对 session `entryId` 和显式 `branchHeadId` 做排除 gate，tag 存在时具有权威性，再扩展 causal closure；branch view 的 freeze seq 取当前 visible 最后事件自己的全局 seq。
- Prevention: branch tests 必须包含等长 sibling、tag+shared-parent、path-id collision、sibling 后写导致 global seq 更高，以及 `(triggerEventSeq, triggerHeadEventId)` 成对断言。
- Verified by: 2026-08-24 branch ledger adversarial review与修复；branch/tool/snapshot/CAS focused 57/57、coding-agent 2343/2343 通过。

## 无 snapshot branch binding——普通 path append 不能清 active

- Wrong approach: 删除 branch-bound snapshot 后，只要 SessionManager path signature 变化就清空 active snapshot。
- Why it failed: 普通新消息也会把 path 延长并改变 signature；这样刚激活的 compacted snapshot 会在下一条消息同步时立即失效，tail 无法增量保留。
- Recognition signal: compaction 成功后 `getActive()` 有值，但追加一条同分支消息并 `syncFromEntries()` 后 active 变空，后续请求退回完整 raw context。
- Correct approach: snapshot 不保存 branch ref，也不做祖先选择；host 首次同步清除无法证明来源的 durable active，之后仅在旧 path 不是新 path 前缀（rewind/sibling switch）时清空，普通 append 保留 active 与新增 tail。同一 session compaction 使用 single-flight，snapshot 以一次 `publishActive()` 生效。
- Prevention: 删除 branch binding/CAS 时同时覆盖首次重启同步、同 path append、rewind、等长 sibling、并发 compaction 与 publish failure；不要用“signature 是否变化”代替 prefix compatibility。
- Verified by: 2026-08-24 ledger/CAS 删除任务；目标 session/host 78/78、compaction aggregate 285 passed / 8 skipped，根 `npm run check` 通过。

## 高保真 compaction——真实模型评测暴露的两类 schema 与断言陷阱

- What happened: 用真实模型（kimi-coding K3）跑 T-105 评测时，(1) 抽取器因 K3 给 nextActions 项多加了 `kind` 键而整体拒绝（item 级 additionalProperties:false 过严）；(2) 评测最初报告 100% 保留率，但实际压缩从未激活（tokens 0/0 暴露了假阳性）。
- Wrong assumption 1: "严格 schema = 每个键都必须精确匹配"。真实模型总会附加无害元数据键；真正危险的是 deterministic/forbidden 键（constraints/permissions/tasks/tools）。
- Historical correction 1（该 extractor 已于 2026-08-26 退休）: 当时通过“顶层 unknown/forbidden 硬拒绝、item 级无害未知键确定性剥离并计数”修复 structured extraction；当前实现不要恢复这层 schema。
- Wrong assumption 2: "atom 保留率高 = 压缩保真"。若压缩从未激活，tail 中逐字保留的内容会让 C/T/S 门 vacuously 通过。
- Correct approach 2: 评测报告必须记录 `roundsActivated`/`roundsRejected`/`rejectReasons` 与 token 前后值；保留率指标只有在激活轮次 > 0 时才有意义。见 `test/compaction-subsystem/eval/runner.ts`。
- Historical cross-provider follow-up: `CompactionLLMRequest.responseSchema` 当时并不等于 provider 已实施 structured output；该字段现已删除，不应重新作为“供应商结构化输出”能力标记。
- Manual-runner networking: 直接 Vitest 调真实 provider 必须调用 CLI 同款 `configureHttpDispatcher()`；否则 Node 内置 Undici 在双栈路由上可能 `UND_ERR_CONNECT_TIMEOUT`，即使同机 CLI 正常。真实语料 fixture 还必须稳定化 id/parentId，否则随机迁移 ID 会让响应缓存每次 miss。
- Snapshot v5 lifecycle follow-up（历史阶段）: `facts/decisions/nextActions` 曾短暂作为当前 coverage 的 handoff 输入而非 durable snapshot 字段；它们现已完全退休。终态 tools/artifacts/resolved errors 虽不投影到 warm prompt，仍用于 incremental reducer 的重复 ID 检测和 full-replay checkpoint 等价，不能仅凭“未投影”删除。
- Single-pass v5 update (2026-08-26): `state-extractor.ts`、临时 `facts/decisions/nextActions` 与 `CompactionLLMRequest.responseSchema` 已退休；普通增量路径现在把 offload 后的 ref+preview source packet 只发送给一次 handoff writer。上面的 extractor schema 经验仅解释历史评测，不再是当前实现建议；当前回归必须断言每个 attempt 一次模型调用、正文不进入 source packet、失败使用 deterministic handoff、本地 abort 不发布。
- Verified by follow-up: 2026-08-25 schema v5 整改先触发旧 circuit-breaker 断言失败，按字段生命周期修正后 18 个 compaction 文件 145/145 tests 与根 `npm run check` 通过。
- Verified by: 2026-08-22 T-105 K3 与 2026-08-23 T-304 openai-codex 真实评测；后者 gpt-5.4-mini/gpt-5.4 均 2/2 激活、100% 保真、token −73.3%/−71.8%，稳定缓存复跑 562ms 且指标一致。

## 真实长会话回放暴露的四类 token 膨胀陷阱（子系统）

- What happened: pi-mono 真实会话回放时压缩后仍可能保留大量低价值 token，四类独立缺陷会叠加：
  1. **原子性 vs 卸载的作用域盲区**：巨型 parallel_batch（88k）因不可分割规则整体留在尾部——原子性是对的，但 offload 只扫压缩区，尾部旧大结果永远逐字驻留。
  2. **适配器重复膨胀**：并行批次的 N 个 tool_call 事件共享整条目 payload（22k JSON），N×重复。
  3. **模型输出截断**：K3 抽取输出超 maxTokens 4096 → JSON 截断 → fail closed 正确但永不激活。
  4. **冷存储状态泄漏到 warm prompt**：历史 recall 重建成 `bytesOffloaded: 0` 后写入 snapshot，storage pin 又被当成 prompt protected；表现为大量非空 artifact 显示 `0 bytes, pinned`，成功工具与 recall 目录每轮重复注入。
- Correct approach: (1) offload 扫全历史 + reverse budget 保近期 + priorRecords 跨轮幂等；(2) 适配器只存瘦身投影 + `entryId` 回指（真相仍在会话 JSONL）；(3) maxTokens 随输入规模缩放 + 确定性截断 salvage（切到最后完整数组项闭合并补括号，尾部丢项不产生错项，validator 继续把关）；(4) prior record 从 ArtifactStore 恢复真实 metadata，`event_range` 不参与逐事件 payload 投影，storage pin 只保护冷数据，terminal tools/artifact previews/recall ref 枚举从 warm snapshot 退休。
- Prevention: 至少覆盖“offload-only 后再次 compact”的 artifact size 回归、warm prompt 不含 terminal tool/artifact/ref、`/context` reserve 与运行默认值一致，以及 narrative reject + 空 tail 有确定性桥梁。
- Verified by: 2026-08-22 T-108 真实 K3 实测 token −71.3%/−72.0%、100% 保留；2026-08-24 本轮先红后绿回归，compaction + context command 401 passed / 8 skipped，根 `npm run check` 通过。

## HF 自动压缩接线——TriggerDecision、持久化、校验与 UI 必须共享同一激活边界

- Wrong approach: 生产 AgentSession 继续用 `contextWindow-reserveTokens`，而 70/85/offload/rebuild 只存在于纯策略测试；offload 又在 snapshot publish 前发布 recall 状态；offload-only projection 从完整冻结历史生成 directive refs，却只用 live tail 做 ref 校验；InteractiveMode 还把成功压缩等同于必须存在 legacy `CompactionEntry`。
- Why it failed: policy 与真实下一请求脱节；shadow/reject/publish failure 会污染后续 trigger；已有 snapshot 后的旧 directive ref 在 live tail 中当然无法解析，合法 offload-only 因 `directive-ref ... does not resolve` 被拒；overflow 失败前删除 live message 会破坏重试上下文；HF snapshot 激活本来就不写 legacy entry，UI 的强断言因此在 `compaction_end` 后抛错，异步订阅未接住 rejected promise 又升级为进程级 `uncaughtException`。
- Recognition signal: HF audit/snapshot 已显示激活，但终端随后报 `Completed compaction is missing from the session context` 并退出；或已有 active snapshot 后 offload-only 报 `directive-ref ... does not resolve`。
- Correct approach: 完整 pending provider turn 只计算一次并交给 `evaluateTriggers()`；snapshot 持久化 trigger boundary/kind；recall 只有 active snapshot 引用才影响 projection/trigger；失败与 shadow 不改 live context；raw rebuild 使用 frozen boundary 但保留 active boundary 后的 verbatim tail。token/projection 可以只处理 live tail，但 provenance/directive ref 必须对同一 branch-visible frozen full-event boundary 校验。UI 仅在 legacy entry 确实存在时重建 transcript；HF 成功则保留当前 transcript 并追加摘要，事件订阅边界必须捕获异步渲染错误。
- Prevention: 修改自动 compact 时必须同时测试 trigger→offload/extract→validator→publish→live projection→restart，并覆盖“已有 snapshot + 旧 directive + 新大工具尾部”的 offload-only、成功但无 legacy entry 及 listener rejection；至少保留 shadow、reject、publish failure、overflow retry、重复 payload、重启未同步 tail 与第 8 次后 rebuild。
- Verified by: 2026-08-23 T-406/T-407 aggregate 341 passed / 8 skipped；2026-08-24 无 legacy entry 回归先复现同名错误；本轮 offload-only ref 回归先失败后修复，compaction aggregate 368 passed / 8 skipped，根 `npm run check` 通过。

## Replacement checkpoint 语义——只重放未回答 user，临时 transform 必须作用于终态投影

- Wrong approach: handoff 已总结完整 user episode 后仍无条件把最后一条原始 user 放在 summary 后；provider preflight 又先执行 extension `transformContext`，压缩激活后再用 canonical replacement projection 覆盖 transform 结果。
- Why it failed: 已回答请求被重新放到最新位置会看起来像新的待执行指令；同一 provider boundary 激活 checkpoint 时，provider-only 扩展上下文会静默丢失。
- Recognition signal: replacement roles 对已完成 turn 仍是 `[compactionSummary, user]`；或请求含新 summary 但缺少 context extension marker，durable checkpoint 本身又不应包含该 marker。
- Correct approach: 仅当 latest user 后不存在 assistant/toolResult 时按预算逐字保留；provider 顺序固定为 canonical messages → optional compaction activation → extension transform → `convertToLlm`，临时投影不写入 checkpoint。
- Prevention: 同时覆盖 answered/unanswered latest-user 对照与“provider-boundary activation + provider-only marker”；完整 contract 还应断言 live system/tools/model/thinking、summary、post-checkpoint steering、旧历史排除和 tool-call/result 配对。
- Verified by: 2026-08-30 两个回归先分别收到多余 user 和丢失 marker，修复后 compaction/extension/queue/active-tool/retry 批次 71 tests passed，根 `npm run check` 通过。

## Vitest 更新 inline snapshot——目标文件必须放在 `-u` 前

- Wrong approach: 运行 `vitest --run -u test/interactive-mode-status.test.ts` 更新单文件 snapshot。
- Why it failed: 当前 Vitest CLI 没有把 `-u` 后的路径当作目标过滤器，意外执行了整个 275 文件套件。
- Recognition signal: 输出开始运行与目标无关的 git/package/external-editor 测试，而不是只报告一个测试文件。
- Correct approach: 使用 `vitest --run test/<target>.test.ts -u`；不需自动更新时严格使用 AGENTS.md 的目标测试命令。
- Prevention: snapshot 更新前先确认文件路径位于 `-u` 之前，运行结果中的 `Test Files` 必须等于预期目标数。
- Verified by: 2026-08-23 easy-pi 启动页任务；错误顺序运行 275 文件，改为 `--run test/easy-pi-startup-header.test.ts -u` 后仅运行 1 文件、6 测试。

## npm-link 的 `pi` 仍执行 `dist`——源码 UI 改动后必须重建链接包

- Failure: `packages/coding-agent/src` 已出现新启动页，但终端执行 `pi` 仍显示旧界面。
- Root cause: 全局 `pi` 链接到仓库包，却通过 package bin 执行 `packages/coding-agent/dist/cli.js`；未重建时 `dist` 不含源码改动。
- Recognition signal: `npm list -g` 显示 linked package，而 `rg` 只能在 `src`、不能在 `dist` 找到新界面标识。
- Correct approach: 在 `packages/coding-agent` 执行 `npm run build`，再用实际 `pi` 命令（不是 `pi-test.sh`）做 tmux 启动验证。若 coding-agent 同时依赖本轮修改过的 workspace 包，先重建依赖包；单独构建 coding-agent 会从旧 `dist` 类型检查并可能报已在根 source check 通过的参数类型错误。
- Verified by: 2026-08-23 easy-pi 启动页；重建后 `dist` 出现 `easy-pi`，全局 `pi` 实际启动显示 `eπ easy-pi v0.84.2`。2026-08-30 skill mention 任务中，coding-agent 单独构建因旧 agent `dist` 报 `AgentMessage[]` 类型错误；先构建 `packages/agent` 后同一 coding-agent 构建通过。

- Thinking follow-up: 两轮源码点击回归通过后，用户仍无法点击子行折叠；实际 `pi` 链接的 `dist` 仍含 `localRow !== 0`，根 check 不会更新产物。用户授权后按 TUI → coding-agent 重建，直接导入 dist、通过 `InteractiveMode.handleTranscriptContentClick` 和 VirtualTerminal 验证连续点击、同格 motion、全部展开子行以及拖选复制通过，实际 `pi` 离线全屏启动通过。已有进程不会热替换已加载模块，必须明确要求重启 Pi；不得只要求刷新 UI 或 `/reload`。

## Cache affinity 改动——跨 adapter 与 optional/JSON 边界测试

- Wrong approach: 修改共享 OpenAI cache-key helper 后只跑 completions 测试，并用对象展开直接合并 optional `sessionId`；strict-JSON 清洗又只删除 object property 的 `undefined`。
- Why it failed: Responses、Codex、Azure 三处测试仍断言旧截断；`sessionId: undefined` 覆盖 durable 默认 affinity；array 中的 runtime `undefined` 仍触发 `Durable payload contains undefined`。
- Correct approach: cache-key 改动必须目标跑 completions/responses/Codex/Azure；optional affinity 用 `??` 保留当前或 metadata ID，禁用缓存只用 `cacheRetention: none`；JSON 规范化同时覆盖 object 与 array。
- Prevention: 回归矩阵至少包含 create + setStreamOptions、`streamSimple`/`buildBaseOptions`、Agent/Proxy 转发、64/65 Unicode code point、共享长前缀、各 OpenAI adapter、array/object undefined、cache identity 与 transport session 隔离、disabled cache。
- Verified by: 2026-08-23 cache-affinity hardening；修复前 3 个产品失败和 3 个 stale assertions，修复后 Agent harness 412 passed/1 skipped、AI cache suite 148 passed/4 skipped。

## JSON process observers——在producer端投影，不传完整tool payload与聚合快照

- Wrong approach: 通用`--mode json`把tool results、`turn_end.toolResults`和`agent_end.messages`全部序列化给只需要usage/lifecycle/final text的父进程，再通过不断提高单event阈值缓解。
- Why it failed: 8个普通read输出正文合计191,677 bytes，但截断details重复、JSON转义和run聚合把单个event放大到269,404 bytes；消费者随后忽略正文，传输没有业务价值。
- Recognition signal: 低模型usage时JSONL单event或累计stdout异常大，最大字段是tool `result/details`、turn toolResults或agent messages。
- Correct approach: 保持默认full/RPC兼容，新增additive compact profile并在`JSON.stringify`前只保留usage、hashed tool identity、tool completion和assistant final text；继续保留累计transport valve与backpressure。
- Prevention: Observer协议变更必须测试full兼容、payload sentinel不泄漏、wire size不随tool result/args增长、hash loop identity和assistant required fields；正文确有跨进程消费者时才增加artifact reference生命周期。
- Verified by: `7290-json-stream-linear.test.ts` compact regressions与Harness compact/full consumer测试。

## Regular TUI 长历史恢复——禁止在 transcript 顶部运行定时动画

- Wrong approach: 恢复历史 Session 时仍让顶部启动页每 240ms 更新动画帧。
- Why it failed: `TuiMainScreen` 位于 scrollback 尾部时无法差分改写顶部行；`firstChanged < viewportTop` 会清屏并重画完整 transcript，动画因此把一次恢复放大成持续全量输出。
- Recognition signal: `PI_DEBUG_REDRAW=1` 连续出现 `firstChanged < viewportTop`，变化行靠近顶部，PTY 日志在启动数秒内暴涨。
- Correct approach: 有持久化 transcript 时禁用顶部启动动画；完成最终首屏渲染后再发送宿主可消费的 startup-ready 标记。
- Prevention: 新增定时或动画组件前检查它在 regular layout 中位于 transcript 上方还是下方；用长历史 fixture 断言启动阶段的 full redraw 次数和 PTY 字节量有界。
- Verified by: 2026-08-24 AgentPort Restart 复现；同一 11,000 行 Session 的 5 秒全屏重绘从 22 次降为 2 次，真实新运行从约 165 MB/21 次清屏降为 1.34 MB/1 次清屏。

## Grok composer 状态反馈——固定高度并显式转发 editor 状态色

- Wrong approach: think-level 切换提示通过 `showStatus()` 追加到 transcript；Grok 外框过滤原生 editor 边框后又只用静态 `borderMuted` 重画，footer 还为 level 切换安排一次延迟 fade repaint。
- Why it failed: 提示无法自动消失；可变高度状态行在 `clearOnShrink` 下可能触发 full redraw；外层 frame 丢失 editor 已计算的档位色，footer 的 `max` 也落入默认文本色。
- Recognition signal: `Thinking level: ...` 永久留在历史中，输入框边框切档不变色，`PI_DEBUG_REDRAW=1` 在短暂反馈消失时新增 `fullRender`。
- Correct approach: transient status 使用始终占一行、idle 渲染为空串的 dock slot；只更新该行并复用/重置单个 timeout；Grok frame 显式接收 editor border formatter；footer 直接使用 thinking-level theme token，不做切换 fade。
- Prevention: 修改 composer 反馈时同时断言显示前/中/后行数恒定、`TuiMainScreen.fullRedraws` 不增加、frame 与 footer 使用同一 level formatter，并为 `max` 保留独立紫色断言。
- Verified by: 2026-08-24 think-level UI 修复；目标测试 70/70，通过真实 `pi` 的 `xhigh → max` 冒烟后提示 900ms 清空、边框/footer 同为紫色，debug full-render 日志保持 2 行不变。

## Compaction 事件账本——操作身份、取消、投影与原子区间必须分别守恒

- Wrong approach: 用工具名与参数哈希作为 ledger 幂等键；目标蒸馏不透传 `AbortSignal`；把 ledger/checkpoint 等耐久化内部事件计入下一次 provider 请求；工具原子组只收 call/result，却把二者之间的控制事件另成重叠区间。
- Why it failed: 合法的同参重复调用被误合并并触发 `Unknown tool call`；取消 compact 时仍卡在首个模型调用；内部历史虚增 token 并反复触发 compact；重叠原子区间触发 `loop-atomicity`，正常压缩退化为 raw rebuild 并丢失叙事摘要。
- Correct approach: 每次逻辑调用以 provider `toolCallId` 区分；所有内部模型阶段统一传播并检查取消信号；token 预算只统计真正投影给 provider 的 message/tool call/tool result；工具原子从 call 到最后匹配 result 使用连续、不可重叠区间，并吸收中间 ledger/control 事件。
- Prevention: compaction 回归必须覆盖同参重复工具调用、蒸馏阶段取消、仅增加内部事件时 token 不变，以及原子组序列区间严格不重叠。
- Verified by: 2026-08-24 `task-ledger-runtime`、`agent-session-compaction`、`auto-trigger-runtime`、`atomic-groups` 四个先红后绿回归；compaction aggregate 393 passed / 8 skipped，邻接会话与工具网关 13 passed / 10 skipped。

## Context zone 硬预算——选择后必须按最终序列化投影复核

- Wrong approach: 用每个 atomic group 单独渲染后的 token 数做背包选择，却把组间分隔符和最终拼接开销留到选择完成后才计算。
- Why it failed: 各组局部估算之和小于最终 `renderTail()`；100/1,000/10,000 规模测试出现 `recentTail protected content requires ... exceeding ... budget`，即使仍有可退休的 closed group 也直接 fail closed。
- Correct approach: 初选后用最终 provider-visible 序列化结果重新计量；若超预算，只按完整 closed 原子组从旧到新继续退休，直到满足硬预算。只有剩余 protected/open 原子自身仍超限时才拒绝。
- Prevention: 每个分区预算测试必须断言最终 section token 数而不只是 item 估算和；规模用非整除预算覆盖组间分隔、标题和固定包装开销。
- Verified by: 2026-08-24 `scale.test.ts` 在修复前 100/1,000/10,000 三档触发 recentTail 超限，修复后 scale + projection/prompt 3 files、19 tests passed，目标 compaction 套件 20 files、203 tests passed。

## Node 在线模型生成——代理变量存在不等于内置 `fetch` 会使用代理

- Wrong approach: 看到 `HTTP_PROXY`/`HTTPS_PROXY` 已继承，就假定 `packages/ai/scripts/generate-models.ts` 的 Node 内置 `fetch` 会自动走代理。
- Why it failed: Node 24 默认仍直连；`curl` 经 `127.0.0.1:7890` 返回 200 时，普通 Node `fetch` 对同一 `models.dev/api.json` 仍以 `UND_ERR_CONNECT_TIMEOUT` 失败。
- Recognition signal: 构建前三个包通过，到 `generate-models` 才连接超时；代理端口健康，Node 环境也能看到代理变量。
- Correct approach: 在工作站 shell 与 GUI launchd 环境设置 `NODE_USE_ENV_PROXY=1`，并保留正确的 `NO_PROXY`；已启动的 GUI 进程需要重启才能继承。
- Prevention: 遇到在线模型生成超时时，对同一 URL 分别运行 `curl`、普通 Node `fetch`、启用环境代理的 Node `fetch`，用三者差异区分代理健康与 Node dispatcher 配置。
- Verified by: 2026-08-24 同一 URL 从普通 Node `fetch` 超时变为启用环境代理后 HTTP 200，随后原始 `npm run build` 全包通过。

## Provider-boundary compaction——新请求与手动抢占不能复用旧轮次短路

- Wrong approach: JIT preflight 只携带上一条 assistant；已有 snapshot 时沿用“assistant 位于 trigger boundary 之前就跳过”的旧保护，同时手动 `/compact` 遇到自动事务直接报 already in progress。
- Why it failed: 新 user 已追加到真实下一请求，但旧 assistant 仍被判 stale，hard gate 随后因没有新 activation 阻断本可重新压缩的请求；用户手动压缩又无法接管正在进行的自动 compactor 调用。
- Recognition signal: active snapshot 后追加 user，provider 调用数不再增长并出现 hard-limit block；或 active response 中 `/compact` 返回 `Compaction or branch summarization is already in progress`。
- Correct approach: provider-boundary preflight 显式标记 pending request，让 gate 基于 branch 中已追加的新事件重算而不重复计入 input；手动压缩循环 abort 并 await 自动事务 cleanup，再独占进入 host。若把 continuation preflight 前移到 `prepareNextTurnWithContext`，必须先同步 projection revision、用激活后的 messages 构造 callback 输入，再调用已有 callback；callback 返回后只有新发生的 projection 变化才能覆盖其 messages。
- Prevention: JIT 回归同时覆盖 active snapshot 后的新 user、极小 context 下连续 checkpoint、tool continuation、compaction 期间 steering、已有 prepare callback 的 context marker，以及 manual-vs-auto compaction 竞争；断言 provider 调用顺序、activation 次数、callback marker 和 aborted 事件。
- Verified by: 2026-08-25 `session-integration`/`default-on`/`auto-trigger-runtime` 30/30 与 `7253-manual-compact-during-response` 回归通过；compaction aggregate 294 passed / 8 skipped，根 `npm test` 与完整 build 通过。2026-08-30 前移 post-tool preflight 时 marker 红测证明 callback 后同步会丢更新；改为 callback 前同步后 compaction suite 31 tests、目标批次 52 tests 与根 `npm run check` 通过。

## 统一 compaction 事务——安全 cut 可以是零，不能为追求重放覆盖而吞掉当前工具续接

- Wrong approach: 统一为 full raw replay 后，若 recent-tail 预算放不下任何完整原子组就直接拒绝，或强制把唯一的 tool call/result 原子组划入 covered prefix。
- Why it failed: 前者无法卸载仍留在 tail 的巨型工具结果，后者会从下一次 provider 请求中移除模型继续处理当前工具结果所需的完整工具续接。
- Recognition signal: compaction 在大型开放工具 tail 上反复拒绝，或压缩激活后下一次 provider 请求缺少当前 tool call/result pair。
- Correct approach: 允许统一事务选择 `cutAfterSeq=0`；仍在同一触发事务内卸载 eligible retained-tail payload、保留工具原子组结构，并对完整下一请求重新计数和验证后再原子发布。这不是独立的 `offload_only` 模式。
- Prevention: compaction 执行策略或 cut planner 变更时，覆盖“唯一原子组大于 tail 预算”的 tool-continuation 回归，同时断言 snapshot 激活、payload 已外置、下一次 provider 请求仍含配对工具上下文。
- Verified by: 2026-08-26 单一 `none|compact` 管线整改；修正前目标 tool-continuation 测试失败，允许 zero-coverage cut 后 compaction/AgentSession 回归 36 files / 295 tests 通过，根 `npm run check` 通过。

## AgentSession faux provider——必须使用生产消息转换器观察扩展角色

- Wrong approach: 测试 harness 直接构造底层 `Agent`，却依赖其默认 `convertToLlm`，再用 faux provider context 判断 `compactionSummary`/`custom` 是否进入真实请求。
- Why it failed: 底层默认转换器不知道 coding-agent 扩展角色，会在 provider 边界过滤它们；Agent state 中 checkpoint 明明存在，faux provider 仍只看到新 user，形成错误的产品回归结论。
- Recognition signal: `session.messages`/`Agent.state.messages` 有 compaction checkpoint，但 faux provider 捕获的 `context.messages` 从后续 user 开始。
- Correct approach: AgentSession harness 构造 `Agent` 时显式注入 `packages/coding-agent/src/core/messages.ts` 的生产 `convertToLlm`；provider-visible 断言必须走同一 transform + convert 管线。
- Prevention: 新增 coding-agent 自定义消息角色或 provider-context 测试时，同时断言 Agent state 与 faux provider context，并确认 harness 的 converter 与 SDK 生产接线一致。
- Verified by: 2026-08-25 checkpoint freshness 回归；仅注入生产 converter 后原 `manual compact` provider-context 失败转为通过，随后 session integration 及 compaction aggregate 290/290 通过。

## 本地模拟 Codex Remote Compaction V2——checkpoint 形态与 compact 请求算法必须分别对齐

- Wrong approach: 只实现 replacement-history checkpoint，却把完整历史裁剪、序列化成一个新 user message，配独立 compactor system prompt，并称为 Codex 风格 compact。
- Why it failed: Codex Remote V2 的关键请求边界是 canonical system/messages/tools 后追加 `CompactionTrigger`；扁平化会丢失原始 role/toolResult 与 tool schema，并让 provider prefix cache 无法复用。
- Recognition signal: compactor capture 显示 system prompt 被替换、`messages` 只有一个 `<untrusted-history>` user、`tools` 为空；checkpoint 恢复测试仍可能全部通过，因此不能证明 compact 算法正确。
- Correct approach: 本地请求使用当前 system、生产 `convertToLlm` 后的 active messages、当前 tools，再追加 `local_compaction_trigger`；强制 `toolChoice=none`，沿用 Session routing/cache affinity。仅当超窗阻止 compact 请求时临时重写 tool-result body，durable history 不变；安装为最近真实 users（默认上限 64k）+ 文本 compaction item。
- Prevention: compaction 改造必须分别断言“compactor request shape”和“installed replacement history”；至少捕获 system、message roles、tools、末尾 trigger、overflow-only rewrite、失败不安装与 resume。
- Verified by: 2026-08-26 `narrative.test.ts` 先红（独立 policy/无 tools/单 user）后绿；compaction aggregate 23 files、185 passed / 8 skipped，根 `npm run check` 通过。
- Retired provider-native detour: 曾为 direct OpenAI `/responses/compact` 增加 opaque message、同 provider/API/model 绑定、模型切换 raw recovery 以及跨 lazy API/Provider/runtime 的可选 capability；但项目只有 OpenAI Codex OAuth，没有 direct OpenAI API key，生产路径无法真实验收，额外契约成为无用户价值的死复杂度。
- Current prevention: 能力只有在当前部署可调用且能加入真实回归时才进入核心 compaction 架构；否则所有 provider 统一使用已真实验证的单次 local handoff，不保留 speculative capability。2026-08-26 Kimi K3 真实评测完成 prompt → compact checkpoint → marker continuation，相关 26 files / 204 passed / 5 skipped、根 check 和完整 build 通过；删除后生产源码不再含 native/opaque/`responses/compact` 契约。

## pi-tui 新增默认键位——同时检查解析别名、物理终端输入与系统快捷键

- What happened: grok prompt 列表先用 `alt+p`，被 readline 遗留别名解析成 `alt+up`；改成 `alt+j` 后，tmux 的 `ESC+j` smoke 通过，但 macOS 实际 Option+J 没有触发。相邻跳转使用的 Ctrl+↑/↓ 又被 macOS Mission Control 截获。换成可达键后，plain `pi` 的 regular 模式仍表现为“选择了但不跳”。
- Why it failed: `packages/tui/src/keys.ts` 把 `ESC+p` 硬编码为 `alt+up`（另有 `\x1bb/f/n`）；而 `alt+j` 只有终端将 Option 配为 Meta、实际发送 `ESC+j` 时才成立，macOS 默认可能发送 `∆`。parser smoke 不能证明物理按键可达应用，系统保留键更不会进入进程。regular 模式渲染 `document` 而不是 `transcriptScrollView`，后者虽然存在但未挂载、没有可控 viewport，`scrollTo()` 因此无可见效果。
- Recognition signal: `KeybindingsManager.matches` 和 fullscreen 合成键 smoke 都通过，但目标 OS 的物理按键无反应；或 F6 列表能打开，确认选择后 regular scrollback 完全不移动。
- Correct approach: 默认键位避免依赖 Option-as-Meta 和操作系统保留组合；本次改为 Shift+PageUp/PageDown 跳转、F6 打开列表，并用实际终端序列验证每个 action 唯一命中。grok regular 触发任一 prompt 导航时先切换到 fullscreen，再定位目标。
- Prevention: 新默认键位依次验证 (1) 全部 KEYBINDINGS 命中集合，(2) 目标终端真实发送的字节，(3) 目标 OS 是否抢占，(4) 应用默认运行模式的端到端效果；合成 ESC 序列或非默认 fullscreen smoke 不能替代后两层。
- Verified by: 用户在 macOS 复现两轮失败；`grok-prompt-navigation.test.ts` 对键位和 regular→fullscreen 先红后绿；构建后用 22-prompt session 从 `--tui-mode regular` 实测上一条跳转与 F6 列表均通过，相关 6 files / 29 tests、Biome、tsgo 通过。

## 真实工具 A/B 评测——turn breaker 必须覆盖完整工具链与随机波动

- Wrong approach: 把简单任务的模型轮次先验设为 4，首次超限后只按单次已观察值逐级加 spare；后续 prompt ablation 又沿用了已完成基准的 10/12-turn 上界。
- Why it failed: 每个 search/read/edit/run 反馈都可能触发下一次 assistant turn；多操作任务在 `max` thinking 下既有更长工具链，也有跨运行波动，历史最高 10 轮的同类 control 后来实际达到 14 轮。
- Recognition signal: 真实评测在功能已完成或接近完成时仍报 `exceeded N model turns`，且复杂 task/variant 总在相同 breaker 处中止。
- Correct approach: turn cap 按最复杂预期工具链与多次 pilot 的波动加 bounded headroom 设置，global cap 机械派生为 `sessions × perSessionTurns`；breaker 错误必须打印 observed turns。若 cap 是硬边界，必须在第 N 轮工具执行完成后、下一次 provider request 之前用 `shouldStopAfterTurn` 停止，不能等第 N+1 个 `message_end` 才 abort。校准失败的 partial records 只作诊断，不能混入最终统计 aggregate。
- Prevention: 全矩阵前为每种任务形态与实验 variant 跑多个 calibration seed；至少覆盖 discovery→read→edit→run→final 和 discovery→read→move/update→run→recovery→final，再冻结预算。为 breaker 加确定性测试：第 N 轮最终回答可完成，第 N 轮工具结果会阻止下一请求，且 provider 永远看不到第 N+1 轮。
- Verified by: 2026-08-28 `tool-profile-eval` 中 4-turn、6-turn breaker 分别在 v2 locate/move 停止；后续诊断和 ablation 的 10/12-turn cap 又观察到 11/14 turns。2026-08-29 本轮 held-out 的 reactive guard 在 18-turn 合同下实际观察到第 19 轮并中止；改为 `shouldStopAfterTurn` 后确定性边界回归 7/7 通过，真实 held-out 未重跑。

## Workspace source 测试——package subpath alias 必须与根导出一起覆盖

- Wrong approach: Vitest 只把 `@earendil-works/pi-agent-core` 映射到 workspace source，却让同包的 `/node` subpath 从本地 `dist` 解析。
- Why it failed: source 中新增的 v2 read 依赖 `NodeExecutionEnv.readTextRange`，而未重建的 `dist/node.js` 仍是旧实现；同一测试进程混用了新工具与旧环境，所有文本 read 都报 `bounded_read_unsupported`。
- Recognition signal: workspace 单包测试中 package 根导出的新能力存在，但 subpath 导出的实例缺少对应 prototype method；`import.meta.resolve` 指向 `packages/*/dist`。
- Correct approach: 在共享 Vitest alias 中为每个被 source 测试引用的精确 package subpath 添加 source 映射，并用跨包行为测试实际执行该能力，而非只检查类型或 tool registry。
- Prevention: 新增或使用 workspace package subpath 时，同时检查 package exports、root tsconfig paths、共享 Vitest aliases 和 source CLI resolver；回归应在消费包中调用新能力。
- Verified by: 2026-08-29 v2 read 回归修复前稳定报 `This execution environment does not support bounded text reads`；补充 agent-core `/node` alias 后回归通过，五种子真实诊断从至少 8 次该错误降至 0。

## v2 mutation plan 路径——canonical 只用于同一性比较，不能替换 backend 地址

- Wrong approach: `edit-v2` 解析路径后把 mutation plan 的目标从 addressed absolute path 改成 `canonicalPath`，试图让 Read view 与 Edit 路径直接相等。
- Why it failed: macOS 临时目录的 addressed path 可为 `/var/...`，canonical path 为 `/private/var/...`；journal/overlay backend 的 workspace root 按 addressed namespace 配置，收到 canonical target 后将其判为 `OUTSIDE_WORKSPACE`。
- Recognition signal: 普通 ExecutionEnv mutation 测试通过，但 journal/overlay 集成测试批量在 `mapBasePath`/`assertTargetPath` 报 workspace 外路径，且差异集中在 `/var` 与 `/private/var`。
- Correct approach: mutation plan 和 backend I/O 保留 `absolutePath`；另存 `canonicalPath` 只做 alias 检测以及 view/path 同一性比较。
- Prevention: 修改 workspace path normalization 或 view-bound edit 后，除 Agent edit 测试外必须目标运行 journal 与 overlay backend 测试，特别覆盖含 symlink/canonical alias 的平台路径。
- Verified by: 2026-08-29 locator-safe edit 任务中该改动使 journal/overlay 7 个测试失败；恢复 addressed plan path、仅保留 canonical 比较后相关 3 files / 29 tests 全部通过。

## CompactionSummaryMessage 类型——跨包 declaration merging 必须同步

- Wrong approach: 只在 `packages/coding-agent/src/core/messages.ts` 给 `CompactionSummaryMessage` 增加字段。
- Why it failed: `packages/agent/src/harness/messages.ts` 对同一个 `CustomAgentMessages.compactionSummary` 也有声明；两边结构不同会触发 TS2717。
- Recognition signal: 根 `npm run check` 报 `Subsequent property declarations must have the same type`，且错误同时指向两个同名 `CompactionSummaryMessage`。
- Correct approach: 修改该消息结构时同步更新 agent-core 与 coding-agent 两处声明，再跑根类型检查。
- Prevention: 改 `CustomAgentMessages` 的扩展角色前先用 `rg "interface <Message>|<role>:" packages/agent packages/coding-agent` 找出所有 declaration merging 定义。
- Verified by: 2026-08-30 compaction token-after UI 任务先稳定触发 TS2717；同步两处 optional 字段后根 `npm run check` 通过。

## 嵌套仓库 subagent `focusPaths`——相对路径按 harness workspace 解析

- Wrong approach: coordinator 位于父 workspace `easy-pi/`、实际 Git 根在其 `pi/` 子目录时，给 reviewer 传了从 Git 根起算的 `packages/...` 相对 `focusPaths`。
- Why it failed: subagent 按 harness workspace 根解析相对路径，快照中对应位置不存在；所有目标文件 read 都返回 `ENOENT`，review 虽结束却只能给出 inconclusive 结果。
- Recognition signal: coordinator 可正常读取目标文件，但同一批 subagent 报所有 focus file 缺失，且路径少了嵌套仓库前缀。
- Correct approach: 先分别确认 harness workspace 与 `git rev-parse --show-toplevel`；嵌套仓库的 read-only reviewer/analyst 使用绝对 `focusPaths`，或使用含子目录前缀的 workspace-relative 路径。绝对路径重试后 reviewer 成功读取 live 文件并产出可验证 findings。
- Prevention: 启动 DAG 前比较 `pwd`、Git root 与 task focus path；两者不同时禁止直接使用 Git-root-relative 路径。writer 的 `ownedPaths` 仍须按 subagent workspace 规则填写，不要照搬 reviewer 的绝对路径。
- Verified by: 2026-08-30 v2 Search 优化任务中 run `0185c593-db62-4bc5-b213-c17837879deb` 因相对路径全部 `ENOENT` 而无结论；改用绝对路径的 run `74d43765-d01c-4697-bcb0-d125ef5c5663` 成功识别并驱动 6 类 bounded closure。

## Bash capture adapter——opaque Operations 的 cwd 不能用本机规则解释

- Wrong approach: 将 native Bash 委托共享核心后，在进入自定义 `BashOperations` 前统一调用本机 `NodeExecutionEnv.absolutePath`，以为只需把文件存在性检查交给宿主。
- Why it failed: 路径解析本身也属于宿主语义；`~/remote-work` 被展开成本机 home，relative cwd 被重复拼接，Windows 还会改写远程 POSIX 路径分隔符。
- Recognition signal: 无 spawnHook 的 remote Operations 收到的 cwd 与调用者传入值不同；带重写 cwd hook 的旧回归反而通过。
- Correct approach: capture adapter 拥有 cwd 解析及验证；默认本机 transport 在 prepare 中解析相对路径，opaque Operations 默认原样接收 cwd；有 ExecutionEnv 的宿主通过该环境实施路径策略。
- Prevention: 同时覆盖无 hook 的 opaque absolute/home/relative cwd、本机 absolute/relative 绑定，以及 remote ExecutionEnv policy；不要让测试 hook 掩盖前置转换。
- Verified by: 2026-09-05 `test/bash-tool-contract.test.ts` 三项 opaque cwd 回归先失败，修正后通过；Agent 42 项与 coding-agent 五文件 152 项相关回归通过，Windows 未实机验证。

## AgentToolError——普通 Agent loop 与 durable Harness 必须分别验证

- Wrong approach: 增加显式结构化工具错误后只修改 `agent-loop.ts` 的 catch，并以普通 Agent 的消息测试证明所有宿主均保留 details。
- Why it failed: server 的 `createCodingAgentHarness` 通过独立 `AgentHarness.executeToolCall` 执行相同核心 Bash；其 catch 仍将 details 置为 `{}`，真实非零退出状态在 durable message 中丢失。
- Recognition signal: 直接调用与 SDK Agent loop 都有 exitCode，而 `Session.findEntries()` 中错误 toolResult 的 details 为空。
- Correct approach: 两处执行 catch 都仅对 `AgentToolError` 保留 details，普通 Error 的任意属性/cause 不透传；durable 路径继续使用已有 strict-JSON normalization。
- Prevention: 修改工具错误合同时同时跑 `test/agent-loop-tool-error.test.ts`、`test/harness/agent-harness-tool-gateway.test.ts` 与 coding-agent server consumer；检查真实 Bash 失败、ordinary Error 隔离、undefined 清洗和 replay=never。
- Verified by: 2026-09-05 durable gateway 的显式错误/真实 Bash 两项先失败，最小 catch 修正后 gateway 9/9 及相关 Agent 53、coding-agent 39 项通过。

## Detached baseline 评测——Git revision 不包含被忽略的模型 JSON

- Wrong approach: 为基线创建 detached worktree 并链接现有 node_modules 后，直接运行 source-alias SDK 测试，认为源码 revision 已包含全部运行输入。
- Why it failed: `packages/ai/src/providers/data/` 被 Git 忽略；已跟踪的 `*.models.ts` 仍静态导入这些 JSON，基线进程因此在生成前就报 `Cannot find module './data/amazon-bedrock.json'`。
- Correct approach: 只复制当前已存在的公开模型 JSON，不下载、重新生成或复制认证配置；将目录内容哈希与产品/runner 哈希一起封存。
- Prevention: 版本隔离预检同时验证 tracked 源码、忽略的必需运行输入、实际 package/subpath alias 和生产 schema；不能以 node_modules 链接存在代替加载成功与版本一致性。复制 data 时还必须包含隐藏的 `.manifest.json`，不能只用 `*.json` glob；2026-10-11 codemode 纯树验证首次漏掉它，造成一个 unknown 类型错误与 11 个导入失败，补齐既有公开 manifest 后 check/build、22 文件/262 tests 通过。
- Verified by: 2026-09-05 v2 attribution baseline 首轮两个 suite 导入失败；复制 JSON 并纳入 catalogHash 后，live/baseline 各 21 tests passed，源、catalog、runner 与运行时函数哈希完全一致。

## Pi 原生子会话——共享认证不等于共享可变 provider 注册表

- Wrong approach: 创建多个 AgentSession 时直接复用同一个 ModelRuntime，以为独立的扩展实例足以隔离其关闭行为。
- Why it failed: ExtensionRunner 的 registerProvider/unregisterProvider 最终修改所绑定的 ModelRuntime；子扩展在 session_shutdown 取消 provider 注册，会让主会话 getModel 返回 undefined。
- Correct approach: 使用 ModelRuntime.createSessionView() 为子会话建立独立 provider 注册表和内存 catalog store，保留父级配置、provider 实现与认证能力；不复制凭据到子目录。这不是隔离任意第三方 JS 全局状态的 sandbox。
- Prevention: 原生多会话接线须同时测试 provider 注册/覆盖/注销、共享认证、配置 headers 和子 dispose；仅测试 transcript/工具实例隔离不足。
- Verified by: 2026-09-07 pi-child-session-host.test.ts 的 provider cleanup 回归先失败（root model undefined），接入 session view 后通过；session-view 和宿主/SDK/auth 等 9 files / 56 tests 通过，未调用真实 provider。

## Pi 子会话冷加载——sessionFile 路径不证明历史已经落盘

- Wrong approach: 子宿主返回 sessionFile 后就把会话视为可卸载/恢复，只测试出现 assistant 之后的冷加载。
- Why it failed: SessionManager 默认延迟到首条 assistant 才创建文件；未运行或 preflight 中断的子会话拥有路径但没有文件，reopen 报 ENOENT。
- Correct approach: 新子会话通过公开 header/entries 以 wx、0600 显式写入并 sync，再用 SessionManager.open 建立正常持久追加状态；不伪造 assistant，不改私有 flushed 标志。
- Prevention: 原生宿主至少验证 create→dispose→reopen 全程零 provider 请求，以及 checkpoint fork 在首轮前的冷加载。
- Verified by: 2026-09-07 pi-child-session-host.test.ts 未启动子会话回归先 ENOENT 后通过；实际 controller LRU/冷加载与 fork 测试通过，未处理真实历史。
- Mailbox follow-up: 新 root 同样可能未落盘；接收端不能因 sendCustomMessage 返回或 sessionFile 非空就删除 durable envelope。等 native 文件存在并 sync 后 ack，首条 assistant 或下一请求重试确认；原生消息 ID 防重复。2026-09-07 pi-collaboration-tools.test.ts 验证 idle 不启动、确认失败阻止 provider、显式重启不重复注入，以及后续 checkpoint 不复活原消息。
- Admission follow-up（2026-10-18）: 只关闭 bind-time 自动恢复仍不足：冷 child 的旧 followUp 会在新 assignment 中多触发一次 provider，steer/nextTurn 也会混入请求。host-controlled 策略必须在新 prompt 组装前清理旧 live mirrors，再以 `inheritQueuedInputs:false` 接纳；旧收据保留历史/悬挂状态，不伪造取消或完成。回归同时断言三种队列的请求正文、调用次数、未知效果保留与普通 root 默认恢复；`pi-child-session-host.test.ts` 和 `harness-audit-host-recovery-policy.test.ts` 先红后绿，组合24文件328项通过。

## Pi 邮箱注入——持久消息必须先于 compaction preflight

- Wrong approach: 初版邮箱 adapter 在扩展 context 事件里持久化并追加消息。
- Why it failed: AgentSession 的 transform wrapper 先执行 compaction preflight，再调用扩展 context；新增邮箱正文因此不在同一次压缩门槛的输入内。普通 faux 对话能通过，不能证明顺序正确。
- Correct approach: 在绑定 session_start 时通过公开 Agent.transformContext 宿主接口包住原 transform；先持久化邮箱，再调用原 transform，关闭时只恢复自己安装的 wrapper。不修改私有状态，不从生产者完成回调直接推入接收者 state。
- Prevention: 在已有 Pi transform 入口捕获消息和 durable branch，断言邮箱在进入 preflight 前已存在，同时验证 shutdown 恢复原接口及 checkpoint 去重。
- Verified by: 2026-09-07 pi-collaboration-tools.test.ts 的 preflight 顺序与恢复接口回归通过；最新指定 11 files / 113 tests 和 root check 通过。

## 原生 Subagent 工具权限——卸载不能丢掉实时收窄

- Wrong approach: 子权限取持久化 ceiling 与祖先实时工具列表的交集，但卸载时只删除祖先 getter。
- Why it failed: 祖先禁用 bash 后，后代调用被拒；detach 删除 getter 后又退回较宽的创建 ceiling，后代错误恢复 bash 能力。
- Correct approach: 解除绑定前把当前工具列表与原 ceiling 的交集持久化；失败启动也必须发 child shutdown 释放已安装的绑定，再 dispose。持久化失败仍停止团队，不扩大权限或自动重跑。
- Prevention: 同时覆盖 live revoke→detach/LRU→cold reopen，以及 startup failure→explicit followup。执行门测试必须先证明工具确实被广告：SDK setActiveTools 本身不能突破初始 allowlist，不能把它挡住的调用当作后端权限门证据。
- Verified by: 2026-09-10 collaboration-controller.test.ts 的 unloading a narrowed ancestor 在修正前 detach 后返回 true，修正后及重开 store 均保持 false；原生宿主重新广告 bash 的执行门、失败启动绑定释放回归通过。指定 subagent 64 项、coding-agent 69 项通过，未运行真实模型。
- Live predicate follow-up（2026-10-11 codemode）: 新 session predicate 反查 controller.toolAllowed，而 controller 的 self getter 又读 session.getDelegatableToolNames，实际 production spawn 产生 RangeError。组合本地 ceiling 时使用单独 ancestryToolAllowed：检查 persisted self grant 与全部 live ancestor/root，但不反读自己的 effective getter；原 toolAllowed 仍保留全检查。新增 predicate 时必须画出 getter 依赖方向并跑真实 controller/child，而非仅注入宿主。agent-session-codemode-child.test.ts 原失败转为 4/4，controller/lifecycle/extension 72 项通过。

- Shutdown follow-up（2026-10-11 progress）: 先设置 stopping 再调用解除绑定的实时 getter，会把执行门主动拒绝的 interrupted 当成真正权限不确定，并持久化空 ceiling；cold followup 因此丢失 read。进入 stopping 前捕获已验证 live ceiling，仅供 teardown 与原 ceiling 求交，不用于继续执行；捕获真正失败仍按空列表收窄。必须同时验证允许工具、root/local revoke、真实 getter failure 与 cold reopen。相同 native cold-followup 断言由失败转通过，4 个确定性清理场景及核心定向 182 tests 通过。

## 原生 Subagent 准入——同步状态通知也是取消重入边界

- Wrong approach: 把慢加载移出控制队列后，只在加载前和 running 状态提交前检查取消，忽略 commit 内同步 observer 的重入。
- Why it failed: pending 通知内 shutdown 时 loading 尚未注册，取消扫描漏掉它；running 通知内 shutdown/abort 又发生在最后一次检查之后，随后微任务仍调用 host.run。
- Correct approach: 注册 startup 时继承已有 stopping/failure，首次 host.run 前再次检查控制器状态与 startup signal；跳过执行的已接收回合正常终结为 interrupted，不重跑。
- Prevention: controller 并发回归除异步 host barrier 外，加入 pending/running observer 同步 shutdown 与 running observer abort，断言 create/run 次数和持久状态，不能只断言 abort 被调用。
- Verified by: 2026-09-11 三项 notification 回归修正前分别出现停止后一次 create、两次场景下意外 run；最小边界检查后三项及 controller 全部32项通过，未调用真实模型。

## Vitest 安全升级——先检查完整依赖树再接受 dedupe 的附带变更

- Wrong approach: 只把各 workspace 的 Vitest pin 从 4.1.9 改到 4.1.11，运行一次 `npm install --ignore-scripts` 后就认为 audit 已清零。
- Why it failed: `vitest-evals` 的 peer 解析仍在 root 保留 4.1.9，`npm audit` 继续报告 `@vitest/mocker` 和 `vitest`；随后 `npm dedupe` 虽解决了旧 peer，却同时改写了无关 transitive lock 条目。
- Recognition signal: `npm ls vitest @vitest/mocker @vitest/coverage-v8 --all` 仍显示 4.1.9，或 lock diff 出现与目标依赖无关的 undici/picomatch/workspace metadata 变化。
- Correct approach: 统一更新直接 pin 后运行 `npm ls` 和全量/production `npm audit`；必要时 `npm dedupe --ignore-scripts`，再逐项审查并恢复无关 lock 变化，最后运行生成 lock checks。
- Prevention: 安全依赖升级的验收必须同时检查完整树、audit 两种模式和 lock diff，不能只看 manifest 或 npm install 的 summary。
- Verified by: 2026-09-12 Vitest 4.1.11 升级；初次安装后仍有 2 个 moderate，dedupe 后全量及 production audit 均为 0，代表性测试和 root check 通过。

## `packages/*` 新增导出后 CLI 子进程测试挂掉——vitest 别名不到子进程,先重建对应包 dist

- Wrong approach: 给 `packages/agent` 增加新导出(如 BackgroundTaskManager)并改 coding-agent 源码引用后,只跑 vitest 套件就认为 CLI 路径安全。
- Why it failed: vitest 经 `vitest.base.ts` 别名把工作区包解析到 src,但 session-id-readonly/startup-session-name 等测试 spawn 的 CLI 子进程走 node_modules → `packages/agent/dist`(无别名);stale dist 没有新导出,import 直接抛错,子进程 exit 1 且测试用 `stdio: ignore` 吞掉 stderr,表象像 CLI 逻辑回归。
- Recognition signal: 进程级 CLI 测试 exit code 1 而无明显原因;`npx tsgo` 与 vitest 全绿;手动用 `node --import tsx src/cli.ts ...` 复现才看到真实的 import 错误。
- Correct approach: 改了 `packages/agent`(或其他被 CLI 子进程 import 的包)的导出面后,先 `cd packages/<pkg> && npm run build` 再跑 CLI 子进程测试。
- Prevention: 新增跨包导出时,把"重建被依赖包 dist + 跑一个 CLI 子进程测试"列入验收;诊断 CLI 子进程失败时先手动复现拿到 stderr,不要从测试断言反推。
- Verified by: 2026-09-13 background task 特性,session-id-readonly 与 startup-session-name 两个测试在重建 packages/agent dist 前 exit 1、重建后 4/4 通过;vitest 全程绿掩盖了该问题。

## 真实 provider 评测 subagent——kimi-coding 并发额度会让 root 回合静默死亡

- Wrong approach: 在 kimi-coding/k3 上跑 root+child 协作链路评测(或任何子代理场景)。
- Why it failed: 子代理开始推理后,root 的继续请求必然撞上 403 permission_error("concurrent request limit");该状态码不在重试分类里,root 回合以 `assistant(error)[empty]` 静默终结,表象像模型不遵守指令。
- Recognition signal: 消息轨迹末尾出现 `assistant(error)[empty]`;errorMessage 为 `403 ... "concurrent request limit"`;会话单独推理正常、叠加子代理即挂。
- Correct approach: subagent/多会话并发评测用 openai-codex(gpt-6-astra); diagnosing 模型"不听话"先 dump 消息轨迹与 stopReason,再怀疑指令遵循。
- Prevention: 真实 provider 测试文件默认 provider 设为 openai-codex;如未来要为 kimi-coding 支持子代理并发,候选修复是在 pi-ai `provider-retry` 加 `403 + /concurrent request limit/i` 的限定重试分类(2026-09-13 已实现过并按用户指示回退,见 subagent-real-provider 任务文档)。
- Verified by: 2026-09-13 subagent-real-provider 任务;k3 两次复现 403 轨迹,openai-codex 四场景全过。

## macOS 的 ps 没有 etimes——进程启动时间探测改用 etime 解析

- Wrong approach: 用 `ps -o etimes= -p <pid>` 取进程启动秒数(PID 复用防护需要)。
- Why it failed: macOS(BSD)ps 不支持 etimes 关键字,直接报 "keyword not found",防护静默退化为纯 kill 探测,测试报出相反的 busy/interrupted 结果。
- Recognition signal: BSD ps 输出 "etimes: keyword not found";防护分支看似写了却不生效。
- Correct approach: 用 `ps -o etime=`(两类系统都有)并解析 `[[dd-]hh:]mm:ss`;win32 直接返回 undefined 走降级路径。
- Prevention: 任何 ps 关键字用法先在本机 `ps -o <kw>=` 验证再写进代码;POSIX 与 BSD 的 ps 关键字集差异大。
- Verified by: 2026-09-13 collaboration-store PID 复用防护;etime 版本测试 37/37(含复用/存活/迁移三用例)通过。

## Computer UniFFI 离线生成——目标平台 fetch 不覆盖无过滤的 metadata

- Wrong approach: 只执行 `cargo fetch --locked --target aarch64-apple-darwin`，在 SDK 编译和目标 metadata 通过后就认为绑定生成的离线缓存齐全。
- Why it failed: UniFFI/UBRN 内部 `MetadataCommand::new().exec()` 不过滤平台，会读取锁中的其他平台依赖；生成检查因缺 `aes 0.8.4` 尝试联网，被 offline 正确阻止。
- Recognition signal: SDK release 已通过，失败停在生成器的 `error running cargo metadata` / `attempting to make an HTTP request, but --offline was specified`，而非 stale generated files 或 ABI mismatch。
- Correct approach: 在已批准依赖范围的受控副本中执行 `cargo fetch --locked` 补齐同一锁的全平台缓存；校验锁 hash 不变，再恢复 offline 重跑原生成命令。不要升级依赖或开放在线生成。
- Prevention: 离线生成前单独运行无 `--filter-platform` 的 `cargo metadata --locked --offline --format-version 1`；同时确认生成器和临时 N-API workspace 各自有锁，不能用 SDK 锁代替。
- Verified by: 2026-09-18 Computer P02；`bindings-check.log` exit 1，补齐缓存后 `cargo-metadata-all` 与原命令 `bindings-check-retry` exit 0；Cua Cargo.lock hash 未变、Python/TS 生成结果与固定源码一致，未加载原生库。

## Computer macOS TCC——先核对实际授权条目，避免重复重启诊断

- Wrong approach: 用户报告已勾选权限后，先要求重启并重复getter，尚未核对勾选项是否当前TCC责任宿主的调试bundle。
- Why it failed: 用户后来确认此前勾选的是另一项；前台重启不能替代对实际责任身份授权。后台进程年龄、磁盘签名有效或日志里的private-entitlement warning都不足以证明权限失败原因。
- Correct approach: 用本次行动进程的tccd请求定位责任app，再核对显示名、bundle ID和路径。requesting Node PID与responsible宿主PID是不同角色；有界捕获后按requesting PID/msgID和(tccd PID, activityIdentifier)关联完整context/subject/Allowed/reply族，只落盘自己的记录。仅按日志正文含PID过滤会漏掉Allowed行，不能据getter补造完整准入。
- Prevention: 同名release/debug app并存时，在再次要求重启前核对具体条目；逐行动进程验证精确requester binary/UID、responsible bundle/path和两服务Allowed链。更正授权后重新getter，不复用旧进程资格或要求不同角色PID相同，不杀宿主/重置TCC/改签名。
- Verified by: 2026-09-18 P02用户更正条目后getter与live通过；P03 `p03-recovery`暴露错误同PID条件及漏Allowed，`p03-tcc`保存trace先红后绿、26证据/8父协议测试通过，三个live行动进程各自完整准入通过。

## Computer UniFFI 终态通知——foreign waker 可能同步阻塞并重入

- Wrong approach: 公开 `ComputerOperation::terminal()` 直接等待 core watch channel，以普通 Tokio/noop waker 测试推断跨语言通知不会阻塞。
- Why it failed: 固定 N-API bridge 在发送 JS continuation 后同步 `rx.recv()`；core `finish()` 通知时仍持有 gate/state 锁，JS 同步 cancel 或再次 poll 又需要这些锁，形成循环等待。
- Correct approach: 公开 future 等待独立 native proof monitor 的 JoinHandle，只有原生 waker 接入 core channel；monitor 只持有 proof state，不拥有 producer/facade，不改变终态或 lease 规则。
- Prevention: 跨语言并发回归应同时挂起 result/terminal，用 barrier 阻塞 foreign wake，再从另一线程执行同步取消和重新 poll；另测丢弃订阅不取消 producer、不跳过 cleanup drain。不要只增加超时或强杀解锁。
- Verified by: 2026-09-18 `p03-offline-repair/regression-paired-wake-before` exit101、同回归修复后0，SDK14/14与全部50项定向Rust测试通过；证明局部锁循环修复，未把它当作原GUI挂起的已验证修复或原生终态证明。

## Computer macOS GUI 准入——TCC 与 fixture 可见不证明 console 已解锁

- Wrong approach: TCC两项Allowed、fixture isVisible/activeSpace及主线程ack通过后，连续做只读AX拒绝诊断，最后才检查console锁屏状态。
- Why it failed: 这些检查并不测量console lock；本轮六次observe失败后，metadata明确CGSSessionScreenIsLocked=true。尚无解锁对照，不能称锁屏是AXApplication/self根或全部AX拒绝的唯一原因。
- Correct approach: 创建fixture/SDK/TCC/owner前先查有界session metadata；known locked或不可用local console拒绝并等待人工处理。缺失private lock key不等于已解锁，原有TCC/Stop/exact-window gate仍必要。
- Prevention: 无法排除锁屏时先处理环境门禁，不修改AX根分类/complete/tokens让测试通过，不自动解锁；失败需独立核对native terminal、close/destroy与实际退出，不从counter0推断终态。
- Verified by: 2026-09-18 `p04/console-state`明确locked；console-gate6/6，`locked-console-admission`在零children前拒绝、C9不变；`blocked-verification.json`核对六次自然失败及零表单输入。

## Computer macOS 进程组清理——先证明是否已退出，再决定是否发信号

- Wrong approach: 保留Child作为PID锚后，仍在每次close先发SIGKILL，再检查根进程与组内成员是否已退出。
- Why it failed: 本机私有fixture已自然退出、WNOWAIT仍能取终态且组内无live成员时，killpg返回EPERM，初稿把已收敛误判为cleanup失败并隔离。
- Correct approach: 仅在“根进程waitable exit且组内无live成员”不能同时成立时发信号；保留unreaped Child直到组收敛后才reap。不把任意EPERM当成功，也不把仅root exit当全部子进程退出。
- Prevention: 同测自然退出的空组、已退出root+仍活grandchild、外部提前reap后禁止发信号；group proof不能推广为setsid逃逸helper或完整profile writer终态。
- Verified by: 2026-09-19 `p04-browser/process-first`与exact diagnostic均exit101，诊断exited=true/errno1/live=false；修复后process11/11、五轮10/10、platform28/SDK41/core66全0。仅私有测试进程，无Chrome/GUI资格。

## Computer macOS 临时 CfT——独立 HOME/profile 不隔离系统加密钥匙串

- Wrong approach: 给固定CfT创建私有HOME和空白profile后，就认为导航不再依赖个人钥匙串。
- Why it failed: Page.navigate已发出网络请求却20秒无响应；自有browser stack停在SecItemAdd→makeLoginAuthUI→AuthorizationCopyRights。匹配版本的OSCrypt默认仍选择系统KeychainV2。
- Correct approach: 对不重用的临时测试profile固定启用该版本提供的`--use-mock-keychain`，使用内存FakeKeychainV2，不点击授权弹窗或访问个人keychain；不能据此承诺持久凭据/加密，也不禁用TLS或sandbox。
- Prevention: 无登录临时browser准备必须审计OSCrypt provider而非仅user-data-dir；导航停顿先区分CDP是否收到、网络是否开始及exact自有进程等待点，不扩大超时或盲重放。
- Verified by: 2026-09-19 `p04-browser/navigation-network-live-1`等待栈与matching153源码；launcher参数回归before101/afterpass，固定flag后HTTP200/导航返回、对照sample无原授权等待，最终`form-fixed-live-1`八步/Press及clean close通过。

## Computer typed browser producer——public ActionResult 不能替代内部执行记录

- Wrong approach: 新controlled DOM producer仅返回合法typed `ActionResult` JSON，忽略canonical dispatch还要求内部`ActionExecutionRecord`。
- Why it failed: legacy adapter不识别public `dom` route，publish_action_result因此在真实Fill之后拒绝；字段已经改变，但plan只能返回prefix0/unknown。纯序列化测试与fake host没经过这个接缝。
- Correct approach: 实际producer附加DOM/background内部记录；只有真实固定函数readback才提供确认依据，Press保持Unverifiable并另做plan后置观察，不绕过canonical发布或补造旧成功。
- Prevention: 新typed执行通路同时测试producer→internal record/legacy fallback→public projection，不只测试JSON可反序列化；真实独立effect oracle必须与返回prefix/unknown对照。
- Verified by: 2026-09-19 `keychain-form-live-1`只改变Name后unknown/C32；canonical seam回归before101/afterpass，`form-fixed-live-1`真实8/8＋Press、精确10事件/六terminal/两自然exit0/C33，platform59/SDK45通过。

## Computer macOS image catalog——完整观察必须正确表示 zombie 和读取间退出

- Wrong approach: `proc_listpids`列出PID后，以`PROC_PIDTBSDINFO(arg=0)`读取所有成员，认为变化总能靠短暂重读消除；路径读取失败又一律当不可恢复错误。
- Why it failed: arg=0不查询已退出但未reap的zombie，其PID仍在目录中，等待不能解决；live身份读取后进程也可退出，使随后的`proc_pidpath`返回ESRCH。
- Correct approach: BSD信息查询使用非零arg，保留经过PID/UID/start证明的zombie条目；路径读取的实际ESRCH只标记catalog不完整，允许既有预算内重新读取。其他错误仍拒绝，完整双catalog一致后才能过滤，绝不把读取失败当空集。
- Prevention: 用私有Child+WNOWAIT维持zombie，用cat/EOF barrier制造身份与路径读取间退出；两种情况分别回归，不增加超时或跳过未知PID。
- Verified by: P05十次zombie前/中/后对照，两项native回归before101→after0；held-zombie真实prepare/close通过，最终13browser/十AppKit及platform70/SDK45/core69通过。旧D65/D70/D83缺少低层分支证据，未声称唯一历史根因。

## Computer 补丁资格——git apply成功退出不证明嵌套目录实际应用

- Wrong approach: 在主仓库内的未初始化scratch目录直接`git apply --check`及apply，以退出0当应用成功；新增文件diff还缺少Git的new-file头。
- Why it failed: Git按外层仓库相对cwd跳过所有补丁路径，verbose明确输出Skipped；独立Git根后才暴露新增文件被误解为dev/null来源。
- Correct approach: 私有验证目录先建立独立Git根，新增文件保留`new file mode`元数据；apply后逐文件比较预期hash，再reverse并比较原hash及新增文件消失。
- Prevention: 补丁资格必须检查应用后的实际字节，不能只检查exit0；失败副本和原patch保留，不在已资格源树试应用。
- Verified by: P05 `final-patch-capture`字节断言拒绝静默跳过，`final-patch-verify-fixed`拒绝dev/null，补齐头后`final-patch-verify-complete`九文件正反应用/hash全部通过。

## Computer Full Access TTL——先追实际上下文构造，不能只看配置和getter

- Wrong approach: 看到entry的3600/600秒配置与`computer_authority_live()`调用`is_expired()`，就把已冻结候选描述为仍有人工授权过期。
- Why it failed: `bind_computer_session`早已对unrestricted/no-manifest上下文把实际timers设为None；配置字段与共用getter不证明该分支会到期。
- Correct approach: 沿创建入口、具体context字段、canonical admission/commit和maintenance调用链核实；用旧timestamp矩阵区分Computer Full Access与普通/manifest会话，不制造TTL失败基线。
- Prevention: 生命周期修复工单先附当前context构造与实际计时器证据；发现的独立缺陷单独归因，本次实际修复是canonical祖先撤权传播，不是新增no-TTL。
- Verified by: `general/full-access-lifetime-worker/report.md`与冻结源hash复核；old-timestamp矩阵、完整SDK81/core85及独立安装C349/C350通过。

## Task recovery 退役截图——关闭恢复资格，不能伪造执行结果

- Wrong approach: 已移除的 `computer.capture` 因缺失结果永久留在 suspended task，并将完整旧任务记录反复放入 provider 请求。
- Why it failed: 观察结果缺失被当作不可重复的外部写入；临时尾部消息破坏请求前缀，搬到 system 又混入用户与工具数据。
- Correct approach: 仅在组件确实未安装且未完成调用全部为已派发截图时，持久化 cancelled + retirement，保留缺失结果与原始审计，拒绝旧任务恢复；真实写入仍保留未知结果保护。其他恢复事实在历史中追加一次，不写入 system。
- Prevention: 区分移除与禁用，覆盖混合写入、重载、迁移重入、提交后提示写入失败，以及连续请求前缀。
- Verified by: 2026-10-11 目标 session 副本迁移，135239136 原始字节保持一致、未知活跃调用 1→0、未伪造结果；13 个离线测试文件、214 个测试通过，根 check 通过。

## Bash 启动前失败——错误结果不等于未知副作用

- Wrong approach: 本地后台 manager 在 cwd 不存在、shell 准备或容量准入失败时返回错误，Bash 包装却省略执行确定性，默认成为 `unknown`。
- Why it failed: TaskRecoveryJournal 因缺少确认结果进入 `needs_reconciliation`，同一用户任务额外启动恢复调用；实际命令未启动，命令里的 mkdir 也无法修复初始 cwd。
- Correct approach: 在明确没有启动命令的拒绝边界保留 `not_started`；原错误结果仍持久化并交给模型正常处理。不要按错误码 blanket 重分类后启动或不透明 adapter 的异常。
- Prevention: 同时测试 core Bash 与实际 coding-agent Bash/faux，断言 shell/后台任务/目录副作用均为零、只有一次 start/end/settled，以及真实未知效果仍暂停。当前恢复 state.tools 会在下一 assistant step 清空，历史结果断言应读取 canonical toolResult/journal 记录。
- Verified by: 2026-10-11 core 七项及会话额外恢复回归先红后绿；最终 Agent 四文件 59/59、coding-agent 十三文件 189/189 与根 check 通过。

## TUI 任务收尾——内部 end 不是 settled，扩展重入前先通知订阅者

- Wrong approach: 在 `agent_end(!willRetry)` 写 worked 并重置时钟；改用 settled 时又沿用“先 await 扩展、后通知 UI”的顺序。
- Why it failed: 一次 prompt 可包含恢复/续跑的多个内部 run；前者产生同任务历史 worked 与新 Working，后者允许 settled 扩展启动 B 后，A 的旧通知清空仍活跃 B 的状态和时钟。
- Correct approach: 最终 `agent_settled` 才清理指示器/活动组和结算耗时；公开通知先于可重入扩展 hook，用 finally 保留订阅者抛错后的扩展收尾及已有 idle waiter 解析。
- Prevention: 用真实 faux Session + UI 覆盖同输入内部恢复、异步 settled hook 启动持有 gate 的下一运行，以及订阅者抛错时已经 pending 的 waitForIdle；再验证 retry/compaction/新任务和历史重放。
- Verified by: 2026-10-11 UI 提前结算与活跃 B 丢失 Working 分别稳定红测；`b824062c-bash-task-timing.test.ts` 四项组合回归、248 项定向测试及根 check 通过。

## AI 离线目标选择——PI_OFFLINE 与大量 skipped 不证明没有真实 provider 路径

- Wrong approach: 把离线 `test/overflow.test.ts` 误选成 `test/context-overflow.test.ts`，再从 34 skipped 推断真实 provider 全部未运行。
- Why it failed: 后者不检查 PI_OFFLINE，顶层调用 OAuth credential helper（可读取、刷新及保存），至少一项测试仍调用 `complete`；summary 不列出该项，现有日志无法证明远端请求或认证更新是否发生。
- Correct approach: 停止该路径并更正回执；最终只运行完整核对过的 `overflow.test.ts` 等离线文件，不通过查看个人凭据补证。
- Prevention: 执行 AI 定向测试前读取目标文件及顶层 imports/credential helper，区分 unit 与 provider/e2e；不能把 PI_OFFLINE、skip 数或无网络日志当门禁证明。真实测试必须另有用户授权和显式 opt-in。
- Verified by: 2026-10-11 recovery remediation 的误选 log 为 191 passed/34 skipped（其中 context-overflow 至少1项执行）；改用离线目标后协调者 9 files/224 tests passed，已向用户披露偏差及未证明边界。

## AgentSession 并发 fixture——等待真实准入，删除私有目录前收敛 pending prompt

- Wrong approach: `agent-session-concurrent.test.ts` 启动 prompt 后 sleep 10ms 就断言 streaming；失败后 dispose 并删除 auth fixture，未等待 pending prompt。
- Why it failed: 大批测试负载下 disk/auth/extension preflight 尚未完成；主断言先失败，teardown 再导致异步 `No API key`，后者不是原产品故障。
- Correct approach: 等待 agent_start 和真实非 aborted assistant_start；extension queue 等 queue_update。清理时 shutdown、allSettled pending prompt 后才删除目录，不放宽断言或增加睡眠。
- Prevention: 所有依赖 AgentSession 运行状态的异步 fixture 用生命周期 barrier，并对 held preflight 覆盖“10ms 已过但尚未准入”；assertion failure 也要完整 drain。
- Verified by: 2026-10-11 35-file矩阵在旧10ms断言失败并产生未处理拒绝；held-preflight旧 helper确定性ready过早红测，修正后协调者全文件8/8，无未处理错误。

## 恢复结果关联——provider call ID 不跨 response 唯一，发布 receipt 必须写前持久化

- Wrong approach: 以全历史 raw toolCallId Map 的最后结果重配所有 assistant；canonical append 后才记录对应 journal receipt。
- Why it failed: 正常两轮 call_0 的 FIRST/SECOND 变为 SECOND/SECOND；canonical成功、receipt journal失败后重试又追加同一已确认结果，实际provider wire出现重复。仅断言faux context里有result，不能发现wire转换合成的No result provided。
- Correct approach: 用canonical assistant occurrence与branch-visible result receipt关联；先持久化稳定UUID发布意图，再以同ID追加，实际canonical存在才证明发布。祖先fork里的off-path已消费ID必须重绑，不改旧audit；source离开checkpoint时在原位置替换historicalfact，保持请求前缀。
- Prevention: 同时验证canonical、production convertToLlm/wire；覆盖不同response重用ID、partial A/B、reserve/append/ack三个failpoint的warm/cold恢复及ancestor fork，不能按rawID全局去重或把reserved当完成。
- Verified by: 2026-10-11 实际普通FIRST/SECOND、双重发布和固定checkpoint前缀反例先失败；34永久driver回归、独立原trigger复核及922项离线矩阵通过。

## MCP 子会话 bootstrap——未注册不等于未授权

- Wrong approach: 将子会话已注册/已声明工具作为 controller 的实时权限全集，只用注入宿主回调测试 MCP。
- Why it failed: controller 在连接完成前绑定 child getter，合法 MCP grant 因尚未注册被撤掉；canConnectServer 再检查祖先权限形成循环，实际 production child 只剩 deliver_result，MCP 调用 not found。
- Correct approach: 仅保留创建 ceiling 中明确、未注册的 MCP 名称用于 bootstrap；仍交集实时 root/祖先与 exclusions，generic resources 不获得额外 scope。配置取 root 当前 runtime 的批准快照，不重新读改动过的配置文件。
- Prevention: 用真实 registerPiCollaborationRoot/controller + 本地 stdio 覆盖 spawn、晚连接、撤权、未批准服务器及外部配置漂移；注入宿主测试不是生产接线证明。
- Verified by: 2026-10-11 agent-session-mcp-child.test.ts 生产回归修正前仅 root PID，修正后 child 调用与批准配置断言通过；协调端 MCP 12 files / 163 tests 全过。

## Unknown outcome 回归——跟踪原 task ID，不把核验 successor 当原操作

- Wrong approach: 看到 session.taskRecovery.status=completed，就断言断线的 MCP 操作被错误确认；要求后续模型响应不能被消费。
- Why it failed: 最新活跃 state 是独立 task-interruption-recovery successor；原任务仍在 suspendedTasks，needs_reconciliation、safe:false、dispatched:true 且无 result。
- Correct approach: 按派发时捕获的 original task ID 检查未确认记录；保留既有核验机制，另断言重复调用在 dispatch 前被拒、远端副作用只发生一次。
- Prevention: 区分“当前核验任务完成”与“原副作用已确认”，同时观察 executionOutcome、original/suspended state 与真实 RPC 次数，避免为了错误断言禁用恢复功能。
- Verified by: 2026-10-11 agent-session-mcp-migration.test.ts unknown-drop：outcome unknown、两次 dispatch 尝试但一次 RPC、原任务无 terminal result；协调端回归通过。

## ESM CLI main guard——比较 canonical 路径，并验证实际产物

- Wrong approach: 直接比较 `import.meta.url` 与 `pathToFileURL(process.argv[1])`，用 exit0 判断目录工具已执行。
- Why it failed: Node 会将模块路径解析到真实位置，而 argv 可保留 symlink 地址；macOS `/tmp` 与 `/private/tmp` 不相等，main 被跳过，进程无输出且没有 publication 产物。
- Recognition signal: CLI exit0，但预期日志/输出文件不存在；通过绝对 symlink 调用才能复现，普通路径单元测试仍通过。
- Correct approach: CLI main guard 对 argv 用 `realpathSync()` 后再转 file URL；仅做同一性比较，不改写操作对象的 I/O 地址。
- Prevention: import-safe `.mjs` CLI 同时测试普通路径与绝对 symlink 启动，断言实际日志、输出内容及副作用，而非只断言退出码。
- Verified by: 2026-10-11 catalog publisher/diff 两项 symlink guards先RED（静默跳过），canonical guard修复后53项工具测试及完整1523chat/45image离线bundle dry-run/diff通过；源码归档补充后父61/61通过。

## Codemode 跨 VM 投影——terminal payload 与协议 metadata 必须覆盖所有位置

- Wrong approach: 只限制 text/image/console helper 输出，并只剥离 MCP result 顶层 _meta。
- Why it failed: 大 return 和巨大 error JSON 绕过 16 Mi 硬预算进入宿主；合法 content blocks/embedded resource 自带的 _meta 也进入脚本。软 token 截断发生在 host 解码/保存之后，不能替代桥接前硬门。
- Correct approach: prelude.done 在跨桥接前按已有输出加 serialized terminal payload 计量，return 计一个 item，超限改有界诊断且不报告 storeWrites；MCP 按协议定义剥离 result/block/resource 位置的 _meta，保留 business structuredContent 的同名数据字段。
- Prevention: bridge 测试同时覆盖大 return、输出加 return、item 上限加 return、巨大 throw，以及 successful/error MCP 的各 protocol metadata 位置。不要用递归删所有 _meta 损坏应用数据。
- Verified by: 2026-10-11 terminal-output-budget.test.ts 四项修复前全部红、修复后与 sandbox 合计 160 项通过；真实 QuickJS MCP metadata/wildcard 红测修复后及 unit/native-child/nested 4 文件 42 项通过。

## `packages/pi-web-search` 离线 harness——隧道桩不能用内存 PassThrough,计时不能用 Date.now()

- Wrong approach: 在 offline 测试里用两个 `new PassThrough()` 充当守卫隧道两端,并依赖生产代码的 `client.pipe(upstream); upstream.pipe(client)`;同时用 `Date.now()` 打时间戳判断各阶段耗时。
- Why it failed: 内存 PassThrough 互相对向 pipe 会自我回声(写入→读出→再写回),形成无限循环把 CPU 占满约 15s,表象酷似"事件循环被阻塞"或"存在 15s 定时器";而该 harness 用 `t.mock.method(Date, "now")` + 伪 `timers.setTimeout`,所有 `Date.now()` 差值读的是假时钟,阶段耗时结论完全不可信。
- Recognition signal: 单个用例耗时逼近 `--test-timeout=15000`;自加的 `Date.now()` 阶段日志自相矛盾(如"execute 5s"但用例总时长 14.8s);`--cpu-prof` 顶部是 `Transform._write`/`writeOrBuffer`/`onwrite` 且采样间没有空档(在跑,不是在等);`process._getActiveHandles()` 只有 stdio 三个 Socket。
- Correct approach: 隧道桩换成"只写不回声"的 Duplex——`class SilentSocket extends Duplex { _read(){} _write(c,e,cb){cb();} setTimeout(){return this;} }`;真实耗时一律用 `process.hrtime.bigint()`,并以 node:test 报告的用例时长为准。
- Prevention: 给 pi-web-search 写涉及守卫出网的用例时不要用 PassThrough 表示隧道 socket;该 harness 内不要用 `Date.now()` 计时;单用例超过约 1s 先按 harness 假象排查(先怀疑桩与 mock,而不是产品回归)。
- Verified by: 2026-10-11 fake-ip 兼容任务;同一用例从 14.8s 降到 2.25ms,88/88 通过;回声循环由 CPU profile 定位。

## 本机 fake-ip DNS——DNS 钉扎类工具(web_fetch)整体失效而 curl 正常

- Wrong approach: 见 `web_fetch` 报 `net::ERR_TUNNEL_CONNECTION_FAILED` 就去查 Chrome/CDP/守卫代理实现,或怀疑 127.0.0.1:7890 代理不通。
- Why it failed: 本机 Shadowrocket 以 TUN + fake-ip 模式运行,系统解析器是 198.18.0.2(utun),所有公网域名返回 `198.18.0.0/15`;pi-web-search 守卫原先把该段当保留地址一律拒绝 → 对 CONNECT 回 403 → Chromium 上报隧道错误,报文只谈"公网守卫",看不出真因是 DNS。
- Recognition signal: 同一 URL `curl`(直连或走代理)200 但 web_fetch 必失败;`scutil --dns` 的 nameserver 是 198.18.0.2;`node -e 'dns.lookup("example.com",{all:true},console.log)'` 返回 198.18.x.x 或 `::ffff:0:c612:*`;报错里的 rejected 计数只是重试次数。
- Correct approach: fake-ip 现默认被放行——守卫直连该 fake IP 交由本机 TUN 选路,并在 `details.dns_mode=local_fake_ip_client` 与 warnings 中披露;要恢复"只连已校验公网 IP"设 `PI_WEB_FETCH_FAKE_IP_DNS=block`;若想让工具改用真实 IP,则打开 Shadowrocket 的「总是真实IP」(`always-real-ip`)。连通性实测:直连 fake IP 的 TLS 仍通过证书校验(SNI 匹配),HTTPS 多一层保护,HTTP 没有。
- Prevention: 遇到"浏览器能上网但某个 DNS 相关工具失败"先跑 `scutil --dns` + 上面的 dns.lookup 确认 fake-ip;改 `packages/pi-web-search/src` 后必须 `node scripts/build-easy-pi-product.mjs` 重建 dist,并重启 pi 进程才会生效(会话内已加载的旧模块不会更新)。
- Verified by: 反证实验——只把 `dns.lookup` 换成公共解析器的真实 A 记录,未改动的 `readPage` 立即成功(911 字符、blocked=0);放行落地后 dist 路径 example.com 911 字符、iana.org 1245 字符,blocked 仅剩 1 个非标准端口拒绝;`PI_WEB_FETCH_FAKE_IP_DNS=block` 仍按原样拒绝。

## SessionManager 大会话恢复——流式读取不等于有界内存

- Wrong approach: 分块读取 JSONL 后仍将每条完整 `pi-task-recovery` 快照驻留在 entries；初版改为惰性数据后，又遗漏每次结果归属查询会遍历所有历史快照的消费者。
- Why it failed: 真实 3.06 GB 会话中 6697 条重复恢复快照占 95%，触发 V8 OOM；压缩后仍有 2.12 GB。单纯惰性化会让 `resultEntrySources` 每次同步重读数 GB，不能只验证最新 state 能打开。
- Recognition signal: `/resume` 后 Node 原生 OOM、回到 Shell 并出现鼠标协议残片；先核对 epi 的实际父进程与会话文件，不把外层 AgentPort Session ID 当作 epi 会话 UUID。
- Correct approach: 内部不可变 journal payload 按需读取，保留原 inode 的共享只读描述符；修复/换文件后旧分支仍可访问。常用归属查询只索引 assistant/result/call/tool ID，并保留 canonical branch 校验；不得删历史分支来降内存。
- Prevention: 先流式统计文件大小与条目类型；做受限堆的加载、clone/fork、连续 append 回归，另用 throwing getter 证明频繁查询不解码历史正文。数据恢复只操作完整副本并核验原始 SHA256。
- Verified by: 2026-10-15 `01a0c4e0-large-recovery-session.test.ts` 修复前 96 MiB 堆下 OOM、修复后通过；真实 9272 条记录在 512 MiB 堆限制下约 1.94 秒恢复，GC 后堆约 171 MB，875 个结果归属重复查询约 6 ms，原始文件未修改。

## Codex 摘要重试——已解析的“未指定”也是请求快照

- Wrong approach: 只透传明确的 Fast/Standard，未指定时省略选项；用替换 `agent.streamFunction` 的 custom-stream 测试证明摘要重试已固定档位。
- Why it failed: 实际 SDK stream seam 将缺失字段解释为“重新读取当前偏好”；摘要首次失败期间用户开启 Fast，会把同一摘要的重试从省略档位升级为 Fast，产生额外消费。custom stream 绕过了这次解析，原测试发现不了。
- Recognition signal: 实际 SDK + mocked runtime 的 manual/auto/branch 回归捕获 `[undefined, "fast"]`，而期望 `[undefined, undefined]`。
- Correct approach: 摘要边界固定完整解析结果，包括省略状态；内部 snapshot 标记在 SDK 消费后移除，不向 provider 泄漏，也不拿 Standard/null 代替省略。普通请求的 undefined 仍继承当前默认值。
- Prevention: 涉及动态默认配置的重试，必须穿过真实 SDK seam 验证 unset、显式值、重试间切换和下一条普通请求；不要只测替换掉 SDK 的 custom stream。
- Verified by: 2026-10-15 `suite/codex-service-tier-sdk-summaries.test.ts` 修复前仅三个 unset 场景失败，修复后九个场景通过；协调者独立复跑六文件 67/67 通过。

## Native team 数据清理——保护实际会话生命周期，不能只看团队 owner 或 Bash writer

- Wrong approach: 只用 team registry owner 与懒创建的 Bash 日志租约判断历史是否活跃。
- Why it failed: `--session` 可直接续开旧团队内的 child JSONL；新 root 锁的是另一 team，尚未执行 Bash 时原文件没有租约，清理原团队会删掉正在使用的历史。
- Recognition signal: 真实 SDK 打开 child、零 Bash/零 provider 后，原团队 delete 返回 `deleted` 而不是 `protected`；仅测正常 spawn/close 无法覆盖此入口。
- Correct approach: 持久会话在推理前建立生命周期租约；源 team 删除标记在租约建立前后复核，provider 前再次验证文件身份。SessionManager 必须在 mkdir/缺失 header 初始化及 append 前就拒绝已删除 native 路径，不能等 AgentSession 再拦截重建。失败启动释放租约，隔离删除重试复核活跃租约。按实际源路径识别 foreign agentDir，不能只比较当前 root ID。
- Prevention: 清理功能同时覆盖普通 spawn、直接/foreign child reopen、独立进程删除、marker/rename 竞态、SDK 最终化失败与 shutdown；`close` 释放运行资源不等于删除历史。
- Verified by: 2026-10-18 `suite/tool-output-storage-lifecycle.test.ts` 原始活跃文件误删 red→green；`session-manager-team-deletion.test.ts` 在旧代码复现删除后 open 重建等9项失败，前置保护后回归通过；协调者定向矩阵通过，全部合成目录与 faux provider，无真实数据清理。

## Codex Fast 能力——catalog 合并之后还有自定义模型替换层

- Wrong approach: 只在内置 catalog 和旧远端记录合并时保留 Fast 声明，未覆盖 `models.json.models` 的同 ID 替换。
- Why it failed: `provider-composer.ts` 的 `modelFromJson` 重建元数据，仅合并 provider/model compat；旧自定义定义未写新字段，最终能力丢失，即使全局 Fast 已开启也不发送档位、不显示 `fast`。
- Recognition signal: 内置模型 `supportsFastMode: true`，实际组合模型却缺失；仅移除自定义定义或显式补能力可恢复。
- Correct approach: 仅同 provider、同 ID、同 Codex API 继承已有 Fast 布尔声明；显式 provider/model/modelOverrides 仍优先，其他元数据保留替换语义，不改用户配置。
- Prevention: 能力新增必须穿过完整 registry/composer 层，覆盖旧同 ID 定义、显式 false、未知 ID 和 API/provider 改变，不能只测生成 catalog。
- Verified by: `codex-fast-capability.test.ts` 三个同 ID 回归先失败后通过；三文件 138 项通过。只读实际配置离线探针恢复 `fast`，mock 请求发送 `priority`，网络调用为零、配置未改变。

## MCP stdio 清理——leader exit、进程组收敛与 stdout drain 是三个边界

- Wrong approach: 修复 leader 先退出遗留子进程后，在 `exit` 中启动 cleanup，并在组已消失时立即通知 transport close。
- Why it failed: 合法的 `exit → stdout 最后响应 → close` 被改成 `transport close → message`，McpClient 先拒绝 pending request，真实末尾结果随后被丢弃。
- Correct approach: 进程组独立 TERM→KILL/收敛；transport 仍要在有界预算内等待 Child 的 stdio close，确认两者后才结束；看到 ESRCH 后不再向旧身份发信号。
- Prevention: 除 stubborn grandchild 测试外，用受控 Child/PassThrough 制造上述事件顺序，断言 onMessage 先于 onClose、pending client 收到结果，以及不关闭 pipe 时有界失败。
- Verified by: 2026-10-18 `packages/mcp/test/stdio-close-order.test.ts` 三种末尾响应由0/3成功变为3/3；HTTP/stdio/client 邻域70项通过，未据此宣称逃逸进程组或其他 OS 已验证。
