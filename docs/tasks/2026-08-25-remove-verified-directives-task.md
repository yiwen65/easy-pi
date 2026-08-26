# Task Plan: 移除 Verified Directives 附加层

- Created: 2026-08-25
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求；当前 dirty worktree 的 handoff-first compaction 实现；`docs/tasks/2026-08-24-handoff-context-architecture-task.md`

<!-- task-doc-section:background-goal -->
## Background and goal

当前 `Verified user directives` 不是 Pi 原生能力，而是 handoff-first 改造中新增的 verified-user message 投影。它把选中的 user events 保存为 snapshot refs，并在成功 compaction 后追加到 provider system prompt。用户要求移除该附加层，并继续以 handoff 作为压缩后语义衔接的唯一总结层。

目标：完整移除 directives 专区、snapshot refs、system prompt 注入与相关校验/统计；raw event log 继续保存原始用户消息，compactor 从 frozen events 生成 handoff，recent tail 与 recall 继续提供可恢复证据。未触发或成功 compact 都不得因该机制改变 base system prompt 或 tool schema。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- 删除 `user-directives.ts` 及 `userDirectiveRefs`、directives prompt zone/budget/token 统计。
- 删除 AgentSession/host 的 pinned directive system layer，成功 compact 只替换 active messages。
- 将 extractor/narrative/rebuild/orchestrator 改为只使用 frozen event summary、prior handoff 和 deterministic runtime state 生成 handoff。
- 更新 validator、snapshot schema、eval grader、fixtures 与回归测试。

Non-goals:

- 不恢复 Task Contract、Task/Tool Ledger、branch binding 或 snapshot CAS。
- 不改变 base system prompt、工具注册、recall、offload、trigger gate 或 handoff 的模型接口边界。
- 不为当前未提交的 directives schema 增加向后兼容层；旧 snapshot 若不匹配当前 schema，按既有 fail-closed 行为处理。
- 不提交 Git，不运行真实供应商评测或完整 `npm test`/build；除非用户另行要求。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 `user-directives.ts` 从所有 verified user messages 中选择有界投影，并非只识别长期指令。 | `packages/coding-agent/src/core/compaction/subsystem/user-directives.ts`。 |
| F-002 | 当前 snapshot 保存 `userDirectiveRefs`，validator 对来源、权限、边界和 hash 做 P0 校验。 | `types.ts:208-209`；`validator.ts:118-160`。 |
| F-003 | 成功 manual/auto compact 后 AgentSession 调用 `_refreshPinnedDirectiveLayer()`，把投影追加到 base system prompt。 | `agent-session.ts:599-602,2107-2114,2428-2435`。 |
| F-004 | active messages 构建时明确过滤 directives section，因为它已单独进入 system prompt。 | `session-integration.ts:723-748`。 |
| F-005 | 指定架构任务记录该模块为 2026-08-24 后续新增；`git grep HEAD` 没有当前 `Verified user directives` 实现，文件当前未跟踪。 | `docs/tasks/2026-08-24-handoff-context-architecture-task.md:145-167`；当前 Git 状态。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “移除附加层”指完整删除 provider-facing verified-directive mechanism，而不是仅隐藏标题；依据是用户此前明确要求 handoff 总结为准。影响：长期约束是否保留由 handoff、recent tail 和 raw-event recall 负责。
- Assumption: Eval fixture 中的 `request.directives` 可保留为普通用户输入样本，但 grader 不再允许通过 snapshot directive refs 判定保留。
- Open question: None blocking.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 源码与 provider projection 中不存在 `Verified user directives`、`buildPinnedDirectiveLayer`、`userDirectiveRefs` 或 directives prompt zone。
- 成功 compact 前后 base/override system prompt 和 tool schema 保持相同；只有 messages 切换为 handoff/snapshot/tail。
- handoff compactor 仍能读取 frozen user-event 内容，且进行中目标/约束在 handoff 或 verbatim tail 中保留。
- reject/cancel/shadow/no-trigger 行为保持不变；restart/append 仍保留兼容 active snapshot。
- 相关 targeted tests 与仓库规定的 `npm run check` 通过，`git diff --check` 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002`。
- Parallel batches: 无。schema、orchestrator、session host、AgentSession 和共享 fixtures 构成一条 provider-context 状态链。
- Serialization constraints: coordinator 串行修改；不启动 subagent，避免共享 snapshot/test fixture 冲突。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 移除 directives schema、投影和运行时注入

- Status: done
- Owner: coordinator
- Objective: 让 compaction 只拥有 handoff/snapshot/tail message replacement，不再拥有 provider system 附加层。
- Inputs and prerequisites: F-001 至 F-005；用户执行授权。
- Scope or files: `subsystem/user-directives.ts`、`types.ts`、`prompt-builder.ts`、`orchestrator.ts`、`rebuild.ts`、`narrative.ts`、`state-extractor.ts`、`validator.ts`、`snapshot-store.ts`、`session-integration.ts`、`agent-session.ts`、eval grader 与相关测试。
- Expected output: 删除 directives 类型/字段/预算/渲染/校验/注入；handoff 使用 frozen event summary 与 runtime state；无兼容 shim。
- Dependencies: None.
- Execution steps:
  1. 删除 provider-visible directives zone、system pinned layer和 token accounting。
  2. 删除 snapshot refs、validator P0 类别和 durable schema 字段。
  3. 删除 orchestrator/rebuild 的投影依赖，让 handoff/extractor 直接依赖 event summary、prior handoff和 runtime state。
  4. 更新 eval grader 和 fixtures，移除通过 directives refs 获得的保留率捷径。
  5. 删除失去调用方的模块、exports 和测试。
- Acceptance criteria:
  - 全局产品源码无 removed mechanism；system/tool context 守恒测试通过。
  - handoff/continuity、activation、restart 与 reject/shadow 回归保持通过。
- Verification method:
  - 运行 prompt-builder、orchestrator、rebuild、extractor、validator、session/runtime/context identity 目标测试。
- Validation evidence: 删除 `user-directives.ts`；产品源码 removed-symbol 搜索为零；snapshot schema 升至 v4；compaction 模块与 AgentSession/context 集成测试通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 验证集成结果与范围

- Status: done
- Owner: coordinator
- Objective: 验证删除后不存在固定层变化、schema 残留或长任务衔接回归。
- Inputs and prerequisites: T-001 完成。
- Scope or files: 只运行/修正本任务相关测试与任务文档；`npm run check` 可能写文件，运行后核对 status/diff。
- Expected output: targeted regression、静态 check、diff 审计和最终证据。
- Dependencies: T-001.
- Execution steps:
  1. 运行 compaction 目标集合与 AgentSession provider-boundary 测试。
  2. 运行仓库规定的 `npm run check` 并审查写入范围。
  3. 搜索 removed symbols/文案，运行 `git diff --check`，更新任务状态。
- Acceptance criteria:
  - 所有验收条件有当前运行证据；无范围外新增修改。
- Verification method:
  - 精确记录命令、文件数、测试数、退出码和限制。
- Validation evidence: `node .../vitest/dist/cli.js --run test/compaction-subsystem test/suite/agent-session-compaction.test.ts test/interactive-mode-context-command.test.ts`：38 files passed、2 skipped；317 tests passed、8 skipped。`check:pinned-deps`、`check:ts-imports`、`check:shrinkwrap`、`check:install-lock:coding-agent`、`check:browser-smoke` 和 `git diff --check` 通过。`npm run check` 已执行，但被既有 `_findLastAssistantMessage` Biome warning 阻断；随后 `tsgo --noEmit` 另确认仅有既有 Workers AI model-id 与 TriggerDecision fixture 类型错误。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 类型/schema：removed fields 不再可构造或序列化。
2. Prompt：sections/token stats 无 directives；handoff 与 tail 仍存在。
3. Runtime：成功 compact 的 exact provider system/tool identity 与激活前一致，messages 合法切换。
4. Continuity：manual/auto、tool continuation、restart、rebuild、reject/shadow。
5. Static：目标 Vitest、`npm run check`、removed-symbol 搜索、`git diff --check`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 删除 `userDirectiveRefs` 会使当前 worktree 生成的旧 durable snapshot 不再匹配新 schema；按用户要求和仓库规则不加兼容层，加载时 fail closed。
- handoff 模型若遗漏约束，不再有 system-pinned 兜底；必须用 handoff prompt/retention 测试证明 frozen user events 仍可见，并保留 raw log/recall 恢复路径。
- shared dirty worktree 含大量既有改动；禁止 reset/stash/checkout，`npm run check` 后必须核对改动范围。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: 用户授权移除 Verified directives 附加层。核对 live source、Git baseline 和 handoff 架构任务，确认它是后续引入且贯穿 schema/runtime/system prompt 的机制。
- 2026-08-25: 记录以 handoff 为唯一总结层的删除边界；T-001 由 coordinator 串行开始，无安全并行批次。
- 2026-08-25: 删除 directives snapshot field、prompt zone、token budget、validator 类别、orchestrator/rebuild/extractor/narrative 输入和 AgentSession dynamic system injection；schema 升至 v4，eval grader 改为只按 active handoff/tail/recall 判定约束保留。
- 2026-08-25: 全部 compaction-subsystem 与 AgentSession/context 定向回归通过；removed-symbol 搜索和 `git diff --check` 通过。仓库总 check 已运行，但只被任务外既有 lint/type 问题阻断，未越权修改。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 38 test files passed、2 skipped；317 tests passed、8 skipped；system prompt/tool identity 集成断言通过；产品源码 removed-symbol 搜索无结果；依赖锁/import/browser smoke/diff checks 通过。
- Limitations: 完整 `npm run check` 未得到零退出码：Biome 报既有 `agent-session.ts:_findLastAssistantMessage` 未使用 warning；全仓 `tsgo --noEmit` 报既有 Workers AI `kimi-k2.6` model-id 与两个旧 `TriggerDecision` fixture 类型错误。本任务未运行真实供应商评测、完整 `npm test` 或 build，符合既定 non-goals。
