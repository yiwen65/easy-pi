# Project Learnings

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
- Why it failed: 每条用户消息新增一次内部调用，消费原本属于 assistant/compaction 的下一条响应，表现为自动压缩不触发、queued response 丢失和 call-count 偏移。
- Correct approach: `HfCompactionConfig.goalComplete` 独立注入；生产未配置时仍回退真实 compactor adapter，通用测试 harness 默认注入确定性 noop，只有目标测试显式提供 proposal。
- Prevention: 新增任何内部模型调用时，先审计 faux response queue；不要静默复用主 agent 的测试序列。
- Verified by: 2026-08-23 default-on/queued/retry 回归修复，目标 compaction + AgentSession 312 passed / 6 skipped。

## 高保真 compaction——真实模型评测暴露的两类 schema 与断言陷阱

- What happened: 用真实模型（kimi-coding K3）跑 T-105 评测时，(1) 抽取器因 K3 给 nextActions 项多加了 `kind` 键而整体拒绝（item 级 additionalProperties:false 过严）；(2) 评测最初报告 100% 保留率，但实际压缩从未激活（tokens 0/0 暴露了假阳性）。
- Wrong assumption 1: "严格 schema = 每个键都必须精确匹配"。真实模型总会附加无害元数据键；真正危险的是 deterministic/forbidden 键（constraints/permissions/tasks/tools）。
- Correct approach 1: 顶层 additionalProperties 保持 false；forbidden 键硬拒绝；item 级未知键确定性剥离并计数（`strippedUnknownKeys` 入审计）。见 `subsystem/state-extractor.ts`。
- Wrong assumption 2: "atom 保留率高 = 压缩保真"。若压缩从未激活，tail 中逐字保留的内容会让 C/T/S 门 vacuously 通过。
- Correct approach 2: 评测报告必须记录 `roundsActivated`/`roundsRejected`/`rejectReasons` 与 token 前后值；保留率指标只有在激活轮次 > 0 时才有意义。见 `test/compaction-subsystem/eval/runner.ts`。
- Cross-provider follow-up: `CompactionLLMRequest.responseSchema` 不等于 provider 已实施 structured output；`createPiAiCompleteFn` 当前仍靠 prompt 约束。provider-neutral prompt 必须逐项写明 `text`/`sourceEventIds` schema；模型把 provenance 写成 seq 或 UUID 唯一前缀时，只能由确定性唯一映射规范化，未知/歧义引用继续 fail closed。
- Manual-runner networking: 直接 Vitest 调真实 provider 必须调用 CLI 同款 `configureHttpDispatcher()`；否则 Node 内置 Undici 在双栈路由上可能 `UND_ERR_CONNECT_TIMEOUT`，即使同机 CLI 正常。真实语料 fixture 还必须稳定化 id/parentId，否则随机迁移 ID 会让响应缓存每次 miss。
- Verified by: 2026-08-22 T-105 K3 与 2026-08-23 T-304 openai-codex 真实评测；后者 gpt-5.4-mini/gpt-5.4 均 2/2 激活、100% 保真、token −73.3%/−71.8%，稳定缓存复跑 562ms 且指标一致。

## 真实长会话回放暴露的三类 token 膨胀陷阱（子系统）

- What happened: pi-mono 真实会话（100 条目）回放时压缩后仍有 80k tokens，三个独立缺陷叠加：
  1. **原子性 vs 卸载的作用域盲区**：巨型 parallel_batch（88k）因不可分割规则整体留在尾部——原子性是对的，但 offload 只扫压缩区，尾部旧大结果永远逐字驻留。
  2. **适配器重复膨胀**：并行批次的 N 个 tool_call 事件共享整条目 payload（22k JSON），N×重复。
  3. **模型输出截断**：K3 抽取输出超 maxTokens 4096 → JSON 截断 → fail closed 正确但永不激活。
- Correct approach: (1) offload 扫全历史 + reverse budget 保近期 + priorRecords 跨轮幂等；(2) 适配器只存瘦身投影 + `entryId` 回指（真相仍在会话 JSONL）；(3) maxTokens 随输入规模缩放 + 确定性截断 salvage（切到最后完整数组项闭合并补括号，尾部丢项不产生错项，validator 继续把关）。
- Verified by: 2026-08-22 T-108 修复后真实 K3 实测 token −71.3%/−72.0%、100% 保留、oracle 一致。

## HF 自动压缩接线——TriggerDecision 与副作用必须共享同一激活边界

- Wrong approach: 生产 AgentSession 继续用 `contextWindow-reserveTokens`，而 70/85/offload/rebuild 只存在于纯策略测试；offload 又在 validator/CAS 前发布 recall 状态。
- Why it failed: policy 与真实下一请求脱节；shadow/reject/CAS loser 会污染后续 trigger；overflow 失败前删除 live message 会破坏重试上下文；无模型 raw rebuild 推进到最新消息会吞掉未抽取语义。
- Correct approach: 完整 pending provider turn 只计算一次并交给 `evaluateTriggers()`；snapshot 持久化 trigger boundary/kind；recall 只有 active snapshot 引用才影响 projection/trigger；失败与 shadow 不改 live context；raw rebuild 使用 frozen boundary 但保留 active boundary 后的 verbatim tail。
- Prevention: 修改自动 compact 时必须同时测试 trigger→offload/extract→validator→CAS→live projection→restart；至少覆盖 shadow、reject、CAS loser、overflow retry、重复 payload、重启未同步 tail 与第 8 次后 rebuild。
- Verified by: 2026-08-23 T-406/T-407；目标 aggregate 341 passed / 8 skipped，根 check 与 `./test.sh` 全绿。
