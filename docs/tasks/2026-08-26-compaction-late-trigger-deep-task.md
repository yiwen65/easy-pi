# Task Plan: Late-trigger deep compaction

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求按最佳策略整改：95% 晚触发，达到后立即执行；触发后覆盖全部可压缩闭合历史，只保留不可安全压缩的 live frontier，使一次压缩获得大幅降幅。

<!-- task-doc-section:background-goal -->
## Background and goal

当前统一管线仍将 70% 同时作为触发阈值和完整请求目标，并按目标预算保留尽可能大的 recent tail。该设计会过早破坏 provider cache，且触发后可能只做满足比例的浅压缩。目标是拆除“压缩到某个百分比”的契约：完整下一请求达到 95% 时立即进入唯一 compaction 管线；管线覆盖所有可安全压缩的闭合原子组、外置所有符合条件的大型工具结果，仅保留最早开放原子组及其后的 live frontier，并依据真实完整请求收益和语义校验原子发布。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`trigger.ts`、`orchestrator.ts`、`atomic-groups.ts`、`validator.ts`、session host/AgentSession 接线、直接受影响测试与当前 compaction 文档。

非目标：不修改 system prompt、工具 schema 或未触发时的 provider context；不恢复增量/SOFT/HARD/offload-only 模式；不强制完整请求达到个位数比例，因为固定 system/tools 与开放原子组不可由 compaction 删除；不运行真实供应商评测、完整 build 或完整 `npm test`，除非用户另行要求。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前常量 `0.70` 同时生成触发点和 `targetRequestTokens`。 | `trigger.ts:11,34-36`。 |
| F-002 | orchestrator 根据 `targetRequestTokens` 计算“能装下的最大 recent tail”，而不是覆盖全部闭合历史。 | `orchestrator.ts:91-117,211-220`。 |
| F-003 | `planSafeCut(groups, 0)` 会覆盖所有位于最早开放原子组之前的闭合前缀；开放原子组保持完整，允许安全 cut 为 0。 | `atomic-groups.ts:327-365` 及项目 `LEARNS.md` 的 zero-cut 工具续接回归。 |
| F-004 | provider-boundary 已在请求发送前调用 compaction preflight；当前 user-turn cooldown 会压制同一用户轮次中新工具上下文的 70% 阈值触发。 | `agent-session.ts:638-665`；`session-integration.ts:428-450`。 |
| F-005 | token 校验默认要求固定 5% 总请求收益；该比例不是语义安全或深压缩覆盖的必要条件。 | `validator.ts:179-190`。 |
| F-006 | 工作区包含大量并行既有修改，本任务必须按精确路径检查，禁止 reset/stash/checkout。 | `git status --short` 与 `AGENTS.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 95% 指已包含 system、tools、当前输入和 output reserve 的预测完整下一请求；因此触发仍保留 overflow 无条件入口。若估算误差导致预测直接超过窗口，同一唯一管线处理。
- Assumption: “深压缩”定义为最大安全覆盖前缀，而不是固定压缩率：最早开放原子组及其后事件保留；其前所有闭合原子组被覆盖。大型 retained-tail 工具 payload 可在同一事务中 offload，不改变工具配对结构。
- Assumption: 防重复只抑制与最近成功压缩边界相比没有新增 provider-visible 内容的相同上下文；任意新 user/tool call/tool result 或当前输入变化立即重新评估 95% 阈值。
- Open question: None。用户已明确授权实施上述策略。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 默认自动触发阈值为完整请求的 95%，判断使用 `>=`；manual、预测越窗和上次 overflow 始终触发。
- TriggerDecision 不再暴露压缩后 `targetRequestTokens`；trigger 只决定是否执行。
- orchestrator 不再依据目标比例或 `keepRecentTokens` 最大化 tail；每次触发覆盖最大闭合前缀，只保留 live frontier。
- 大型工具结果在已触发事务内默认全部可 offload；工具调用/结果原子结构与 zero-cut 续接保持不变。
- validator 不再使用默认 5% 固定收益；候选至少不得使完整下一请求膨胀，语义、原子性、provenance 与发布边界校验保持不变。
- 相同 provider-visible 上下文不重复 compact；新增 provider-visible 内容达到 95% 时不受 user-turn cooldown 抑制。
- 定向 trigger/orchestrator/session/AgentSession 回归与 `npm run check` 通过，且无任务范围外新增修改。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无。trigger 决策、orchestrator 入口、host 接线和测试共享类型契约，必须串行迁移。
- Serialization constraints: coordinator 独占本任务文件；不使用 subagent，避免共享脏 worktree 中同文件冲突；任务文档由 coordinator 唯一维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 拆分晚触发与执行职责

- Status: done
- Owner: coordinator
- Objective: 将纯触发策略改为 95% `>=`，移除压缩后目标预算与 user-turn cooldown 语义。
- Inputs and prerequisites: F-001、F-004；95% 完整请求定义。
- Scope or files: `trigger.ts`, `trigger.test.ts`, `session-integration.ts` 的触发评估字段。
- Expected output: 只回答 `none|compact` 的晚触发契约；相同 provider context 去重但新工具上下文立即触发。
- Dependencies: None.
- Execution steps:
  1. 重写 TriggerInput/Decision，默认 95%，边界使用 `>=`。
  2. 将 host 的 user-turn cooldown 改为 provider-visible delta 去重。
  3. 更新纯策略与 runtime trigger 回归。
- Acceptance criteria:
  - 95% 精确边界触发；94.999% 不触发；相同 context 去重；overflow/manual 不受去重影响。
- Verification method:
  - 运行 `trigger.test.ts` 与相关 `auto-trigger-runtime.test.ts` 用例。
- Validation evidence: `trigger.test.ts` 7/7 通过；覆盖 94.999% 不触发、95% 精确触发、manual、overflow、same-context 去重和 changed-context 触发。runtime aggregate 同时验证 pending provider-visible input 解除去重。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施最大闭合前缀深压缩

- Status: done
- Owner: coordinator
- Objective: 删除比例目标和最大 recent-tail 规划，触发后覆盖所有可安全压缩的闭合历史。
- Inputs and prerequisites: T-001；F-002、F-003。
- Scope or files: `orchestrator.ts`, `atomic-groups.ts`, session host/AgentSession 参数接线及对应测试。
- Expected output: cut 仅由原子组闭合状态决定；开放前沿和 zero-cut 工具续接保持完整。
- Dependencies: T-001.
- Execution steps:
  1. 移除 `targetRequestTokens`、dynamic recent-tail budget 与 subsystem `keepRecentTokens` 参数。
  2. 使用 zero-budget safe cut 生成最大闭合前缀。
  3. 将默认大型工具结果 reverse budget 调为 0，并记录深压缩审计指标。
- Acceptance criteria:
  - 无开放组时覆盖 frozen boundary；有开放组时 cut 位于最早开放组之前；不存在为填充预算保留的闭合旧组。
- Verification method:
  - 运行 `atomic-groups.test.ts`、`orchestrator.test.ts`、工具续接集成回归。
- Validation evidence: orchestrator 使用 `planSafeCut(groups, 0)`；新增全部原子组闭合时 `baseEventSeq === frozenSeq`、`keptGroups=0` 回归；既有开放工具 loop、zero-cut/offload/tool continuation 回归通过。compaction aggregate 36 文件 296/296 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 收敛收益校验和运行时契约

- Status: done
- Owner: coordinator
- Objective: 删除默认固定 5% 与过时参数接线，保持完整请求不膨胀和 fail-closed 发布。
- Inputs and prerequisites: T-002；F-005。
- Scope or files: `validator.ts`, `session-integration.ts`, `agent-session.ts` 及直接受影响测试/当前文档。
- Expected output: 无固定压缩后比例；验证语义、原子性和完整请求非膨胀；当前文档解释 95% 晚触发/深压缩。
- Dependencies: T-002.
- Execution steps:
  1. 将默认 token gain gate 收敛为不允许总请求膨胀。
  2. 删除 runtime 的 target/keepRecent 规划参数，更新审计与展示。
  3. 更新当前 compaction 文档与测试夹具。
- Acceptance criteria:
  - 生产路径无 `targetRequestTokens` 或 recent-tail percentage planning；候选 `after > before` 时拒绝。
- Verification method:
  - 运行 validator、session integration、AgentSession/context 定向回归与 `rg` 契约检查。
- Validation evidence: 生产路径 `rg` 无 `targetRequestTokens`、user-turn cooldown 或 70% 常量；默认 token gain 改为严格正收益而非固定 5%；当前 compaction/ADR/integration 文档已同步 95% 晚触发与 `max_closed_prefix` 深压缩。`tsgo --noEmit` 与 36 文件 296/296 回归通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验收与差异审查

- Status: done
- Owner: coordinator
- Objective: 验证晚触发深压缩的核心回归、静态约束和工作区隔离。
- Inputs and prerequisites: T-003。
- Scope or files: 本任务修改的生产、测试、文档和任务文件。
- Expected output: 定向测试、`npm run check`、任务文档与 diff 检查通过。
- Dependencies: T-003.
- Execution steps:
  1. 运行 compaction/AgentSession 受影响测试集合。
  2. 运行 `npm run check` 并核对 Biome 写入范围。
  3. 反例审查 exact-95、same-context、open frontier、zero-cut 和 total bloat。
- Acceptance criteria:
  - 所有验收项有实际证据；无任务范围外新增修改。
- Verification method:
  - 定向 Vitest、`npm run check`、`git diff --check`、任务文档 validator。
- Validation evidence: 36 个相关测试文件 296/296 通过；其中直接验证 95% 晚触发、same-context 去重、新 provider-visible 输入立即重评、最大闭合前缀、zero-cut 工具续接、失败不发布，以及大型 `bash` payload 在 handoff 前被替换为 artifact 占位。`npm run check` 通过且 Biome 报告无写入；`git diff --check`、过时字段/70% 常量 `rg` 检查通过；任务文档 validator 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001: trigger 单元测试覆盖 95% 精确边界、manual、overflow、same-context 去重。
- V-002: atomic/orchestrator 测试覆盖全闭合历史深压缩、开放前沿、zero-cut 与默认 offload。
- V-003: runtime/AgentSession 测试覆盖 provider-boundary 立即触发、工具续接和失败不发布。
- V-004: `npm run check`、`git diff --check` 与任务文档 validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 95% 仅剩较小估算余量：完整预测已包含 output reserve，并保留预测越窗/实际 overflow 无条件入口；本任务不声称启发式 tokenizer 在所有供应商上精确。
- 深压缩可能因固定 system/tools 或开放巨型原子组而无法达到个位数完整请求：以最大安全覆盖和非膨胀为准，不牺牲原子性制造压缩率。
- 删除 subsystem keepRecent/target 接线会改变测试和内部配置契约：按用户授权不保留无效兼容层，精确迁移生产引用和直接测试。
- 工作区高度脏：运行自动格式化后必须精确核对本任务路径，不回滚任何他人修改。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 创建 execute 任务文档；确认 70% 同时耦合触发与目标、最大-tail 规划和 user-turn cooldown。T-001 开始。
- 2026-08-26: T-001 完成；默认阈值 95% 且边界使用 `>=`，same provider context 去重取代 user-turn cooldown。T-002 开始。
- 2026-08-26: T-002 完成；统一事务改为最大闭合前缀深压缩，默认大型工具结果 reverse budget 为 0。T-003 开始。
- 2026-08-26: T-003 完成；移除 runtime target/keepRecent 规划接线，默认验证只禁止零收益/膨胀，当前文档同步。当时 36 文件 295/295 与 `npm run check` 通过。T-004 开始。
- 2026-08-26: T-004 完成；补充大型 `bash` 输出在进入 handoff 前 offload 的反例回归。最终 36 文件 296/296、`npm run check`、`git diff --check` 与过时契约搜索均通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: `node ./node_modules/vitest/dist/cli.js --run packages/coding-agent/test/compaction-subsystem/*.test.ts packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts packages/coding-agent/test/interactive-mode-context-command.test.ts packages/coding-agent/test/suite/agent-session-compaction.test.ts packages/coding-agent/test/suite/regressions/5217-compaction-reason.test.ts`：36 files / 296 tests passed；`npm run check` passed；`git diff --check` passed；任务文档 validator passed。
- Limitations: 按任务范围未运行真实供应商评测、完整 build 或完整 `npm test`；未提交 Git。95% 依赖请求 token 预测，真实供应商 tokenizer 偏差仍由越窗/overflow 兜底路径承担。
