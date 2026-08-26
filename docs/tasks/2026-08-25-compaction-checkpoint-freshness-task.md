# Task Plan: Compaction checkpoint freshness boundary

- Created: 2026-08-25
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求执行“checkpoint 只在 compaction 时生成；后续 user/tool/state 只追加；下一次 compaction 再淘汰过期状态”的最佳职责边界整改。

<!-- task-doc-section:background-goal -->
## Background and goal

将 compaction 产物明确为带覆盖边界的历史 checkpoint，而不是持续代表当前状态的 mutable context。压缩后新增用户目标、任务进度、工具结果和重要 runtime 状态必须按事件顺序追加并覆盖 checkpoint 中的冲突陈述；只有下一次 compaction 才能生成新的 checkpoint。实现必须维持 provider prefix cache，不在普通 turn 重写 checkpoint。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：`packages/coding-agent/src/core/compaction/subsystem/` 中的 handoff、snapshot 文案、active projection、确定性 fallback，以及对应目标测试。
- 范围：验证真实 provider message 投影的顺序和不可变前缀。
- 非目标：不恢复 Task Ledger、contract、branch binding 或 snapshot CAS；不改变 compaction trigger；不调用真实付费供应商；不提交 Git。
- 非目标：不修改与 compaction freshness 无关的既有脏工作树内容。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 同一分支普通追加会保留 active snapshot，并将 `baseEventSeq` 之后的事件作为 tail。 | `session-integration.ts:252-305,689-764` |
| F-002 | 现有 provider 投影顺序为 handoff → snapshot → recall → tail；handoff/snapshot 使用 `Continuation`、`Current focus` 等当前时态文案。 | `prompt-builder.ts:131-154,343-369` |
| F-003 | 新 user/tool 消息会进入 tail，但 `state_change` 不会由 prompt builder 投影；`error_resolved` 已是 reducer 可识别的状态变化。 | `prompt-builder.ts:100-105`; `reducer.ts:104-116` |
| F-004 | 正常 handoff 生成要求新事件优先并删除过期内容，但确定性 fallback 直接保留旧 handoff 前四行。 | `narrative.ts:58-88,91-105` |
| F-005 | 工作树已有大量 compaction 相关未提交修改，必须只做窄增量编辑。 | `git status --short --branch` 于 2026-08-25 的输出。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: checkpoint 后真正影响模型决策的内部 delta 当前至少包括 reducer 已定义的 `error_resolved`；未知 control events 不应无差别暴露给 provider。影响：实现采用显式 allowlist，后续新增状态种类需同步扩展测试。
- Assumption: 最新 verified user message 是确定性 fallback 可用的最高优先级语义来源；没有新 user direction 时才允许沿用旧 Summary。
- Open question: None. 当前代码证据足以在不改变外部 API 的前提下实施。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 压缩生成的 handoff/snapshot 明确标注为历史 checkpoint，并声明 `baseEventSeq` 后的事件覆盖冲突目标、进度、Next、错误与工具状态。
- 普通 append 不重写 checkpoint；相同 active snapshot 下 leading compaction message 字节稳定。
- 新 user/tool 消息继续按原始顺序追加；已支持的重要内部状态变化以只追加的 delta 出现在正确事件位置。
- 下一次 compaction 的模型 handoff继续按现有优先级淘汰 stale 内容；确定性 fallback 不再盲目复制旧 Progress/Next。
- 新增/修改的目标测试通过，`npm run check` 通过，且运行后核对无无关自动改写。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-005 → T-002 → T-003 → T-006 → T-007 → T-004。
- Parallel batches: 无。四个任务共享 prompt/session/narrative 契约和测试夹具，属于串行图。
- Serialization constraints: authority document 只由 coordinator 更新；实现文件已有用户修改，逐文件检查 diff 后再编辑。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化 checkpoint 新鲜度语义

- Status: done
- Owner: coordinator
- Objective: 让 handoff/snapshot 在 compaction 时明确表达“历史覆盖点”和后续事件优先级，避免旧 Goal/Next 被当成当前状态。
- Inputs and prerequisites: F-001、F-002；保持现有 zone 顺序和 prefix cache。
- Scope or files: `prompt-builder.ts`、`prompt-builder.test.ts`。
- Expected output: 固定 checkpoint 文案及针对 baseEventSeq/覆盖规则的断言。
- Dependencies: None.
- Execution steps:
  1. 为 handoff 与 runtime snapshot 输出明确的 checkpoint/as-of 文案。
  2. 将 `Current focus` 改为 checkpoint 时态。
  3. 增加投影顺序与 supersession 语义测试。
- Acceptance criteria:
  - 文案不会暗示 checkpoint 永远代表当前状态。
  - 同一 snapshot 重建的 leading summary 保持稳定。
- Verification method:
  - 运行 `prompt-builder.test.ts`。
- Validation evidence: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/compaction-subsystem/prompt-builder.test.ts`（packages/coding-agent）通过，1 file / 15 tests。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 追加式 runtime checkpoint delta

- Status: done
- Owner: coordinator
- Objective: 将 checkpoint 后重要但不属于普通消息的 runtime 更新按事件顺序追加给 provider，不回写 checkpoint。
- Inputs and prerequisites: T-005；F-003。
- Scope or files: `session-integration.ts`、`session-integration.test.ts`，必要时 `prompt-builder.ts`。
- Expected output: `error_resolved` 等显式支持状态以 ephemeral、append-only delta 投影；未知 control event 不泄漏。
- Dependencies: T-005.
- Execution steps:
  1. 定义最小、显式的 delta 渲染规则。
  2. 在 active tail 重建时按事件位置追加 delta。
  3. 验证 checkpoint prefix 不因后续 append 被重写。
- Acceptance criteria:
  - delta 出现在对应事件之后/后续消息之前的时间顺序位置。
  - active snapshot 内容与版本保持不变。
  - 未识别 `state_change` 不进入 provider context。
- Verification method:
  - 运行 `session-integration.test.ts` 和相关 context inspection 测试。
- Validation evidence: `prompt-builder.test.ts` + `session-integration.test.ts` 共 20/20 通过；验证 recognized delta 可见、unknown control state 不可见、snapshot/leading summary 不变、新 user goal 在 provider context 中位于旧 checkpoint 之后。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 修正 handoff fallback 的 stale 继承

- Status: done
- Owner: coordinator
- Objective: 模型 handoff 失败时，确定性 fallback 以新 verified user direction 优先，不携带旧 Progress/Next/Unresolved。
- Inputs and prerequisites: T-002；F-004。
- Scope or files: `narrative.ts`、`narrative.test.ts`。
- Expected output: 保留稳定 Evidence/Decisions，重建 Summary/Unresolved/Next 的确定性 fallback。
- Dependencies: T-002.
- Execution steps:
  1. 从新覆盖事件选择最新 verified user direction。
  2. 仅允许旧 Evidence/Decisions 跨 checkpoint 继承。
  3. 添加目标改变和无新用户目标两类回归测试。
- Acceptance criteria:
  - 新目标出现时旧 Summary/Progress/Next 不再进入 fallback。
  - 没有新用户目标时仍保留旧 Summary，避免无证据丢失目标。
- Verification method:
  - 运行 `narrative.test.ts`。
- Validation evidence: `narrative.test.ts` 10/10 通过，覆盖新目标淘汰旧 Progress/Unresolved/Next，以及无新 user direction 时保留 prior Summary。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成和静态验证

- Status: done
- Owner: coordinator
- Objective: 验证 provider-visible active context 的整体顺序、原子 tail 行为和仓库静态质量。
- Inputs and prerequisites: T-001、T-002、T-003、T-006、T-007 完成。
- Scope or files: 本任务修改的源文件、测试和任务文档。
- Expected output: 目标测试、compaction 聚合测试及 `npm run check` 的实际结果。
- Dependencies: T-007.
- Execution steps:
  1. 运行直接相关测试。
  2. 运行 compaction subsystem 聚合测试或仓库规定的最小集成检查。
  3. 运行 `npm run check` 并核对工作树自动改写范围。
- Acceptance criteria:
  - 所有本任务目标测试通过。
  - `npm run check` 无 error/warning/info。
  - 无本任务范围外新增 diff。
- Verification method:
  - 记录命令、通过数量和任何既有失败。
- Validation evidence: 4 个直接相关文件 51/51 通过；`test/compaction-subsystem` 聚合 36 files / 290 tests passed，2 files / 8 tests skipped；`npm run check` 通过（Biome 1186 files、`tsgo --noEmit`、依赖/锁文件/browser smoke 均通过）；`git diff --check` 通过。额外运行 `./test.sh` 时 coding-agent 272 files / 2294 tests passed、10 files / 57 tests skipped；仓库总命令仅被范围外 `packages/ai/test/zai-coding-plan-models.test.ts` 的 `glm-5.3` 价格夹具漂移阻断。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 对齐 faux harness 与生产消息转换

- Status: done
- Owner: coordinator
- Objective: 让 AgentSession faux harness 使用生产 coding-agent 的 `convertToLlm`，使 provider-context 回归能观察 compactionSummary/custom 消息。
- Inputs and prerequisites: T-001；失败基线显示 `Agent.state.messages` 有 checkpoint，但 faux provider 只收到新 user；底层 Agent 默认转换器会过滤扩展角色，而生产 SDK 显式使用 coding-agent converter。
- Scope or files: `packages/coding-agent/test/test-harness.ts`、当前 provider-context 回归。
- Expected output: faux provider 与生产消息角色转换一致，原失败断言由 checkpoint 丢失转为通过。
- Dependencies: T-001.
- Execution steps:
  1. 给 harness Agent 注入 coding-agent `convertToLlm`。
  2. 重跑原始失败用例，验证因果变量。
  3. 运行邻近 harness 使用者，排除转换器副作用。
- Acceptance criteria:
  - 原失败 provider context 包含 compaction checkpoint 和新 user，顺序正确。
  - 既有 session integration 测试保持通过。
- Verification method:
  - 运行 `session-integration.test.ts`，随后在 T-004 运行邻近 suite。
- Validation evidence: 原失败命令 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/compaction-subsystem/session-integration.test.ts -t "manual compact"` 在注入生产 converter 后通过；完整 `session-integration.test.ts` 5/5 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 对抗性边界和已删除契约测试对齐

- Status: done
- Owner: coordinator
- Objective: 防止不可信 user/control 文本进入 checkpoint/delta，并将仍依赖已删除 Verified directives/structured facts 的测试改为当前 handoff-only 契约。
- Inputs and prerequisites: T-003；compaction subsystem 首次聚合结果 283 passed / 5 failed / 8 skipped。
- Scope or files: `narrative.ts`、`prompt-builder.ts` 及 failure-modes/shadow/orchestrator/auto-trigger 目标测试。
- Expected output: fallback 对 injection/authority claims fail-safe；unverified provider tail/delta 不投影；旧机制测试验证“不会进入 active checkpoint”而非要求不存在的 directive validator 拒绝。
- Dependencies: T-003.
- Execution steps:
  1. 给 deterministic fallback 和 provider projection 加最小 authority/injection gate。
  2. 更新本次语义变化与已删除层对应的旧断言。
  3. 重跑五个失败文件和 compaction aggregate。
- Acceptance criteria:
  - 不可信 injection/authority claims 不出现在 active checkpoint/provider tail。
  - compaction activation 被观测为合法的 prefix replacement。
  - compaction subsystem 聚合通过。
- Verification method:
  - 运行五个失败测试文件和 `test/compaction-subsystem`。
- Validation evidence: 7 个直接相关文件 78/78 通过；`test/compaction-subsystem` 聚合 36 files / 290 tests passed，2 files / 8 tests skipped（显式 real-provider gates）。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 普通 turn 的 delta 一次性投递

- Status: done
- Owner: coordinator
- Objective: 让 active checkpoint 后新增的 recognized runtime delta 在下一次真实 provider boundary 追加一次并保存在 Agent context，后续 turn 不重复、不移动。
- Inputs and prerequisites: T-002、T-006；最终对抗复核确认 `buildActiveMessages()` 只在 activation/rebuild/navigation 调用，普通 turn 不会自动重建。
- Scope or files: `session-integration.ts`、`agent-session.ts`、`session-integration.test.ts`。
- Expected output: host 根据 active baseEventSeq 和已投递 eventId 返回 pending deltas；Agent transform 将其同时追加到当前 provider context 与持久的 in-memory Agent messages。
- Dependencies: T-006.
- Execution steps:
  1. 复用单一 delta message 构造器并按 eventId 去重。
  2. 在 provider transform 的 preflight 前投递 pending delta。
  3. 用真实 faux provider 请求验证首次出现一次、后续状态持久且 unknown delta 不出现。
- Acceptance criteria:
  - post-activation delta 无需下一次 compaction 即对下一 provider 可见。
  - 同一 delta 在 Agent context 中只有一份，后续消息追加在其后。
  - compaction activation/rebuild 仍可原子替换 projection。
- Verification method:
  - 运行 session integration、auto-trigger runtime 和 compaction aggregate。
- Validation evidence: `session-integration.test.ts` 的真实 faux provider 路径验证 delta 首次位于当前 user input 之前、第二个 turn 仍只有一份、unknown runtime state 不可见且 active snapshot 不变；4 个直接相关文件合计 51/51 通过，compaction 聚合 290/290 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 单测：prompt builder 的 checkpoint 文案、handoff supersession、focus 时态。
2. 单测：active messages 在目标切换和 runtime delta 后的真实消息顺序及稳定 prefix。
3. 单测：deterministic handoff fallback 对 stale/current 字段的选择。
4. 集成：compaction subsystem 相关测试。
5. 静态：`npm run check`；随后用 `git status`/限定路径 diff 核对自动写入。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 风险：`state_change` 包含大量仅供内部使用的事件；用显式 allowlist 防止把配置/控制元数据伪装成用户指令。
- 风险：任务文件和目标源文件均处于脏工作树；只使用最小 patch，不还原或格式化无关修改。
- 风险：provider 对同角色历史消息的服从仍是概率行为；通过固定 checkpoint 优先级说明和真实消息顺序消除可避免歧义。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: Task document created; content not yet completed.
- 2026-08-25: 已确认 current code、AGENTS.md 和相关 LEARNS；采用不可变 checkpoint + append-only delta + next-compaction reconciliation，T-001 开始。
- 2026-08-25: T-001 完成；checkpoint/as-of/supersession 文案与 byte-stable prefix 测试通过。T-002 开始。
- 2026-08-25: T-002 provider 回归首次失败：active state 有 checkpoint，faux provider 仅有新 user。定位到底层 Agent 默认 converter 丢弃扩展角色；新增 T-005，先恢复 harness/production parity。
- 2026-08-25: T-005 完成；同一失败用例仅控制 converter 变量后转为通过，完整 session integration 5/5 通过。恢复 T-002。
- 2026-08-25: T-002 完成；provider-visible goal/tail/delta 顺序、unknown control filtering 和 immutable checkpoint 均通过。T-003 开始。
- 2026-08-25: T-003 完成；deterministic fallback 的 stale/current 选择测试 10/10 通过。T-004 开始。
- 2026-08-25: T-004 首次聚合为 283 passed / 5 failed / 8 skipped；新增 T-006 处理 fallback 对抗边界、真实 converter 下的 cache 观测断言，以及已删除 Verified directives 的旧测试。
- 2026-08-25: T-006 完成；fallback injection/authority gate、unverified provider filtering 和旧测试契约对齐后，compaction aggregate 290 passed / 8 skipped。T-004 恢复。
- 2026-08-25: `npm run check` 和 `./test.sh` 通过；最终对抗复核发现普通 turn 的 post-activation delta 尚无主动投递，新增 T-007 后再完成 T-004。
- 2026-08-25: T-007 完成；pending delta 仅在存在 verified allowlisted state change 时插入当前 user input 之前，并以 eventId 在 Agent context 中去重。无 delta 的普通 turn 不修改 context。
- 2026-08-25: T-004 完成；目标测试、compaction 聚合、`npm run check` 与 `git diff --check` 通过。最终 `./test.sh` 的 coding-agent 及其余工作区通过，仅有范围外 ZAI `glm-5.3` 零价格旧夹具失败，未混入本任务修复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-007 全部完成；目标测试 51/51、compaction subsystem 290/290、`npm run check`、`git diff --check` 均通过；provider-visible 顺序、一致性、去重、重启重建来源和 immutable checkpoint 边界均有回归覆盖。
- Limitations: 未运行真实付费供应商评测、完整 build 或 Git commit（不在本任务授权范围）。额外运行的 `./test.sh` 总体 exit 1，唯一失败是范围外 `packages/ai/test/zai-coding-plan-models.test.ts` 仍把已有 API 价格的 `glm-5.3` 期望为 zero cost；本任务未修改该模型目录或夹具。
