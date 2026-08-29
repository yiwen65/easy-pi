# Task Plan: 优化压缩后上下文语义连续性

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求执行已识别的 compaction 语义连续性优化

<!-- task-doc-section:background-goal -->
## Background and goal

当前 replacement checkpoint 会把模型生成的 `compactionSummary` 与最近一条原始 user 消息组合。由于 handoff 提示已要求总结每个用户 episode，若该 user 后面已有 assistant 或 tool 结果，原文再次出现在摘要之后会被 provider 误读成新的待执行请求。与此同时，AgentSession 当前先执行扩展 `transformContext`，再在压缩激活时用 canonical replacement projection 覆盖它，导致 provider-only 临时上下文丢失。

目标是只保留仍未得到 assistant/tool 响应的最新 user 原文，并把 provider transform 应用于最终压缩投影；同时建立一个覆盖当前 system prompt、工具 schema、模型/思考配置、summary、steering tail 与旧历史排除的 provider 边界契约测试。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:
- checkpoint 仅在最新 user 后没有 assistant 或 toolResult 时保留该 user 原文，并继续遵守 recent-user token budget。
- provider-boundary 顺序调整为 canonical messages -> optional compaction activation -> existing `transformContext` -> `convertToLlm`。
- 增加 answered/unanswered latest-user、provider-only transform 与完整 provider context 合约回归。
- 对 checkpoint 后的 steering/tool 协议顺序做确定性断言和对抗审查。

Non-goals:
- 不修改 handoff narrative prompt、trigger threshold、token estimation、checkpoint durable format 或 overflow retry policy。
- 不引入真实 provider/API 评测；项目规则要求额外显式授权，且本次行为可由 faux provider 确定性验证。
- 不重构 session storage 或 extension API。
- 不触碰既有未跟踪 `docs/harness_tools/` 文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | narrative 要求按每条真实 user 消息生成 episode，并保留 request、outcome 与 continuation point。 | `packages/coding-agent/src/core/compaction/subsystem/narrative.ts` 中 `LOCAL_COMPACTION_TRIGGER` |
| F-002 | `selectLatestUserMessage()` 当前无条件选择最后一个预算内 user，不检查其后是否已有 assistant/toolResult。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts:73-80` |
| F-003 | provider transform 当前先执行；若同次 preflight 激活 checkpoint，`_compactProviderContextIfNeeded()` 返回 `agent.state.messages` 并覆盖 transform 结果。 | `packages/coding-agent/src/core/agent-session.ts:615-673` |
| F-004 | live system prompt 与 active tools 在 next-turn refresh 中从当前 AgentSession 状态重建，provider request 在 agent loop 中携带 model 与 reasoning options。 | `packages/coding-agent/src/core/agent-session.ts:720-750`; `packages/agent/src/agent-loop.ts:286-339` |
| F-005 | 当前 worktree 仅有两个既有未跟踪 harness 文档和本任务文档；前者必须保持不变。 | `git status --short --branch` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “未回答 latest user”按明确建议定义为该 user 之后不存在 `assistant` 或 `toolResult`；其他 provider-invisible 元数据不把它变成 answered。
- Assumption: 现有 extension context transform 是 provider-only 投影，不应写回 durable checkpoint；因此只调整 provider 边界调用顺序，不改变 session persistence。
- Open question: None. 用户已明确授权执行前述优化，行为定义和验证入口足够确定。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已有 assistant 或 toolResult 跟随的 latest user 不再出现在 replacement history 的 summary 之后。
- 末尾仍未回答的 latest user 在预算内仍逐字保留；超预算仍不保留。
- 同一 provider preflight 中压缩激活后，既有 `transformContext` marker 仍出现在立即发送的请求中，且不持久化到 checkpoint。
- 完整合约测试确认当前 system prompt、精确 active tool schema、当前 model/thinking、summary、steering tail 均进入立即恢复请求，旧历史与已回答 user 原文不在 summary 之后重复出现。
- checkpoint/tail 测试确认正常 post-tool 路径不会留下孤立 toolResult 或未配对 tool call。
- 目标测试、`npm run check`、task validator 与 diff 检查通过，并只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004.
- Parallel batches: 无；红测、两处实现和 integrated contract 共用同一 compaction/provider 边界，按红绿顺序串行执行。
- Serialization constraints: `agent-session-compaction.test.ts` 与 `agent-session.ts` 行为相互依赖；authority document 仅由 coordinator 更新；不编辑未跟踪 harness 文档。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固定两个已验证失败

- Status: done
- Owner: coordinator
- Objective: 用最低稳定 seam 复现 answered-user duplication 与 compaction-activation transform loss。
- Inputs and prerequisites: F-001 至 F-003。
- Scope or files: `packages/coding-agent/test/compaction-subsystem/session-integration.test.ts`, `packages/coding-agent/test/suite/agent-session-compaction.test.ts`。
- Expected output: 两个在当前实现上按目标原因失败的回归测试。
- Dependencies: None.
- Execution steps:
  1. 增加 answered 与 unanswered latest-user 对照断言。
  2. 增加扩展 context marker 与同次 compaction activation 回归。
  3. 分别运行目标测试并记录红阶段失败。
- Acceptance criteria:
  - 失败断言分别指向多余 user 与丢失 transform marker，而不是 fixture、类型或环境错误。
- Verification method:
  - 目标 Vitest 文件。
- Validation evidence: 红阶段 `session-integration.test.ts` 收到 roles `["compactionSummary", "user"]` 而非目标 `["compactionSummary"]`；`agent-session-compaction.test.ts` 的 provider request 含新 summary 但缺少 provider-only marker。两者均为目标行为失败，其他测试分别 8/31 个通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 最小修复 retention 与 transform 顺序

- Status: done
- Owner: coordinator
- Objective: 只在 latest user 未回答时保留它，并让 provider transform 作用于最终 active projection。
- Inputs and prerequisites: T-001 红阶段证据。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts`, `packages/coding-agent/src/core/agent-session.ts`。
- Expected output: 两处局部顺序/谓词变更，不改变 durable checkpoint 与 trigger 行为。
- Dependencies: T-001.
- Execution steps:
  1. 在 latest-user selector 中检查后续 assistant/toolResult。
  2. 在 provider wrapper 中先 compact、后调用 previous transform。
  3. 运行 T-001 目标测试与邻域 compaction 测试。
- Acceptance criteria:
  - T-001 回归转绿；unanswered/oversized user 与无压缩 transform 行为保持。
- Verification method:
  - 两个目标 Vitest 文件及 queue/active-tool 邻域测试。
- Validation evidence: 将 selector 限定为后续无 assistant/toolResult 的 latest user，并把 provider wrapper 改为先 compact 后执行 previous transform；两个红测转绿，`session-integration.test.ts` 9 tests、`agent-session-compaction.test.ts` 当时 32 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 建立完整 provider-context 与协议合约

- Status: done
- Owner: coordinator
- Objective: 在 faux provider 边界一次性验证 live runtime 层与 compacted history 的组合顺序和完整性。
- Inputs and prerequisites: T-002。
- Scope or files: `packages/coding-agent/test/suite/agent-session-compaction.test.ts`；仅在测试暴露真实缺陷时扩展最小实现。
- Expected output: integrated contract 与 post-checkpoint tool pairing 断言。
- Dependencies: T-002.
- Execution steps:
  1. 构造动态 system prompt、精确 tool schema、thinking、provider transform、post-tool compaction 和 compaction 中 steering。
  2. 捕获立即恢复请求的 model/context/options。
  3. 断言 authority/order、旧历史排除、answered-user policy 和 tool pairing。
- Acceptance criteria:
  - 全局 acceptance criteria 的完整合约与协议项均有确定性覆盖。
- Verification method:
  - `packages/coding-agent/test/suite/agent-session-compaction.test.ts`。
- Validation evidence: 新增 integrated faux-provider contract，验证 live system prompt、精确 active tool schema、model、`reasoning: high`、summary、compaction 中 steering、provider-only marker、旧历史/已回答 prompt 排除、checkpoint roles 与 tail roles；`agent-session-compaction.test.ts` 33 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 对抗审查、全局检查与提交

- Status: done
- Owner: coordinator
- Objective: 检查 failure paths、动态 system/tools、role ordering 与 diff 边界，并完成仓库要求的验证和提交。
- Inputs and prerequisites: T-003。
- Scope or files: 本任务修改文件、coding-agent changelog（若当前分支规则允许则不添加）与本 task document。
- Expected output: 目标/邻域测试、`npm run check`、validator、diff check 通过；显式路径 commit。
- Dependencies: T-003.
- Execution steps:
  1. 审查 compaction rejected/no-host/aborted 路径仍调用 transform 一次并保持 canonical history。
  2. 运行目标批次、`npm run check`、task validator 与 `git diff --check`。
  3. 核对 status 后显式 stage/commit 本任务文件。
- Acceptance criteria:
  - 所有检查通过或明确记录阻塞；无无关文件进入 commit。
- Verification method:
  - 精确命令输出、git diff/status、task validator。
- Validation evidence: 对抗审查确认 no-host/rejected 路径在 compaction helper 正常返回后仍执行 previous transform，hard-limit throw 则正确阻止 provider request；activated projection 的 provider-only marker 不进入 durable checkpoint。目标/邻域批次 9 files / 71 tests passed；第二次完整 `npm run check` 通过且无自动修复；task validator 与 `git diff --check` 通过。首次 `npm run check` 仅因测试使用当前 TS lib 不支持的 `findLast` 失败，改用现有 `getLatestCompactionEntry()` 后消除。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 红阶段：分别运行 session-integration 与 agent-session compaction 目标测试，确认两个目标失败。
2. 绿阶段：重跑同文件，并运行 auto-compaction queue、active-tools-next-turn、repeated active-tool-loop、extension context 邻域测试。
3. 静态：仓库根运行完整 `npm run check`（不运行禁止的全套 `npm test`/`npm run build`）。
4. 收尾：task document validator、`git diff --check`、staged diff/status 审核。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 把所有 latest user 都删除会破坏 pre-response/manual checkpoint；用 answered/unanswered 对照测试约束。
- transform 前后交换可能改变扩展用于裁剪历史时的 trigger usage 来源；trigger 本身使用 canonical branch，设计目标正是把扩展限制为最终 provider projection，并用 no-compaction 邻域测试确认原行为。
- integrated contract 可能误把 compaction 生成请求当成 agent provider 请求；测试必须用注入的 `hfCompaction.complete` 隔离并只捕获 faux agent request。
- 真实模型对 handoff 的语义保真不在本次无 API 授权范围内；本次验证结构与顺序，不声称真实模型解释质量。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: 创建 execute task document；核对仓库状态、AGENTS.md、相关 learnings、session integration、agent loop、AgentSession、session manager 和现有测试。
- 2026-08-30: 确认两个因果链：answered latest user 被无条件 append；previous transform 结果在同次 checkpoint activation 时被 canonical projection 替换。T-001 开始。
- 2026-08-30: T-001 两个回归均按目标原因失败；answered-user 收到多余 user，provider-boundary activation 丢失 transform marker。T-001 完成，T-002 开始。
- 2026-08-30: 最小修改 latest-user selector 与 provider transform 顺序后两个目标文件转绿；T-002 完成，T-003 开始。
- 2026-08-30: integrated provider-context contract 覆盖 dynamic system/tools/model/thinking、summary、steering、provider transform、历史排除与 checkpoint/tail roles；目标测试 33 passed。T-003 完成，T-004 开始。
- 2026-08-30: 邻域批次 9 files / 71 tests passed，覆盖 compaction、prompt、extension context、queue、active tools 与 summarization retry。
- 2026-08-30: 首次 `npm run check` 暴露测试使用不受当前 TS lib 支持的 `Array.findLast`；改用仓库现有 `getLatestCompactionEntry()` 后，目标测试 33 passed，第二次完整 `npm run check` 通过且无自动修复。
- 2026-08-30: delegated reviewer 因隔离 snapshot 未包含 focus paths 而无法审查；coordinator 逐项检查 activated/rejected/no-host/hard-limit 路径、dynamic runtime 层、role order、durable/transient 边界和 diff，未发现需扩展实现的问题。
- 2026-08-30: 将已验证的 replacement checkpoint 语义规则写入 `LEARNS.md`；最终目标批次再次 9 files / 71 tests passed，task validator 与 diff check 通过。T-004 完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-004 均完成；两个回归在修复前按目标原因失败、修复后通过；integrated provider contract 与邻域批次共 9 files / 71 tests passed；完整 `npm run check`、task validator、`git diff --check` 通过；diff 仅包含本任务实现、测试、task document 与 verified learning。
- Limitations: 未运行真实 provider 语义评测，遵守项目规则不使用未明确授权的 API/token；因此验证的是 provider context 的结构、顺序和 runtime 一致性，不声称真实模型对 handoff 的主观解释质量。
