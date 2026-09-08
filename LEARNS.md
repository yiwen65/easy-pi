# Project Learnings

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
- Prevention: 版本隔离预检同时验证 tracked 源码、忽略的必需运行输入、实际 package/subpath alias 和生产 schema；不能以 node_modules 链接存在代替加载成功与版本一致性。
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

## Pi 邮箱注入——持久消息必须先于 compaction preflight

- Wrong approach: 初版邮箱 adapter 在扩展 context 事件里持久化并追加消息。
- Why it failed: AgentSession 的 transform wrapper 先执行 compaction preflight，再调用扩展 context；新增邮箱正文因此不在同一次压缩门槛的输入内。普通 faux 对话能通过，不能证明顺序正确。
- Correct approach: 在绑定 session_start 时通过公开 Agent.transformContext 宿主接口包住原 transform；先持久化邮箱，再调用原 transform，关闭时只恢复自己安装的 wrapper。不修改私有状态，不从生产者完成回调直接推入接收者 state。
- Prevention: 在已有 Pi transform 入口捕获消息和 durable branch，断言邮箱在进入 preflight 前已存在，同时验证 shutdown 恢复原接口及 checkpoint 去重。
- Verified by: 2026-09-07 pi-collaboration-tools.test.ts 的 preflight 顺序与恢复接口回归通过；最新指定 11 files / 113 tests 和 root check 通过。
