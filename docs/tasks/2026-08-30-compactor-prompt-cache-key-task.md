# Task Plan: 传播压缩器 promptCacheKey

- Created: 2026-08-30
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求先执行已确认的最小安全改造

<!-- task-doc-section:background-goal -->
## Background and goal

普通 Agent provider 请求会分别传播 `promptCacheKey` 与 `sessionId`，但默认 compactor adapter 只传播 `sessionId`。当 SDK 调用方配置与 session ID 不同的逻辑 cache key 时，压缩请求会失去该 cache affinity。

目标是在不改变 transport session、缓存保留期或 compaction 行为的前提下，让默认手动与自动压缩请求传播当前 Agent 的可选 `promptCacheKey`。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:
- `createPiAiCompleteFn()` 接受并向 provider options 传播可选 `promptCacheKey`，同时独立保留 `sessionId`。
- AgentSession 手动与自动默认 compactor 构造路径均传入 `this.agent.promptCacheKey`。
- 回归覆盖 `promptCacheKey !== sessionId` 以及两个 AgentSession 接线路径。

Non-goals:
- 不改变工具顺序、extension contract、cache retention、compaction threshold、Skill/resource 顺序或 subagent cache-key 继承策略。
- 不改变自定义 `hfCompaction.complete` 的调用契约。
- 不使用真实 provider/API，不触碰既有未跟踪 `docs/harness_tools/` 文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 普通 Agent 请求把 `promptCacheKey` 和 `sessionId` 作为独立字段传给 provider。 | `packages/agent/src/agent.ts:468-473`; `packages/agent/test/agent.test.ts:890-912` |
| F-002 | 当前 `createPiAiCompleteFn()` 只接受和传播 `sessionId`，并固定使用 `cacheRetention: "short"`。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts:429-452` |
| F-003 | AgentSession 手动与自动默认 compactor 构造路径都只传入 `this.sessionId`。 | `packages/coding-agent/src/core/agent-session.ts:2104-2113`; `packages/coding-agent/src/core/agent-session.ts:2398-2407` |
| F-004 | provider options 把 `promptCacheKey` 定义为逻辑缓存分组键，把 `sessionId` 定义为 routing/transport affinity，并在前者缺失时兼作旧缓存键。 | `packages/ai/src/types.ts:206-216` |
| F-005 | 当前 HEAD 为 `15d17d50b`；worktree 除本任务文档外仅有两个既有未跟踪 harness 文档。 | `git log -1 --oneline`; `git status --short` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: `promptCacheKey` 未设置时继续传播 `undefined`，由现有 provider 的 `promptCacheKey ?? sessionId` fallback 保持原行为。
- Open question: None. 用户已明确授权最小实现，范围与验收入口明确。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 默认 compactor provider request 在自定义 key 与 session ID 不同时收到两个独立、原值不变的字段。
- AgentSession 手动与自动默认 compaction 路径均传播 `this.agent.promptCacheKey`。
- 未设置 custom key 时不新增替代 key 或改变 `sessionId`、`cacheRetention: "short"`。
- 目标测试、根 `npm run check`、task validator 与 diff 检查通过，提交只包含任务自有文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；回归、实现和验证共用同一 adapter/AgentSession 接线，按红绿顺序串行执行。
- Serialization constraints: authority document 仅由 coordinator 更新；不编辑两个未跟踪 harness 文档。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立 cache-key 传播回归

- Status: done
- Owner: coordinator
- Objective: 在 adapter、手动 compaction 与自动 compaction seam 上证明自定义 cache key 当前丢失，同时 session ID 保持独立。
- Inputs and prerequisites: F-001 至 F-004。
- Scope or files: `packages/coding-agent/test/compaction-summary-reasoning.test.ts`, `packages/coding-agent/test/suite/agent-session-compaction.test.ts`。
- Expected output: 在当前实现上因缺失 `promptCacheKey` 而失败的定向断言。
- Dependencies: None.
- Execution steps:
  1. 给 adapter 测试设置不同的 cache key 与 session ID。
  2. 在现有手动和自动 compactor stream 测试中捕获 provider options。
  3. 运行两个目标测试并记录红阶段结果。
- Acceptance criteria:
  - 失败仅指向 `promptCacheKey` 缺失；`sessionId` 仍是预期原值。
- Verification method:
  - 两个定向 Vitest 文件。
- Validation evidence: 红阶段 adapter 测试收到 `sessionId: "compact-session"` 但缺少 `promptCacheKey: "shared-compaction-prefix"`，1 failed / 4 passed；AgentSession compaction 测试的 manual/auto provider options 均保留各自 session ID 但缺少 custom key，2 failed / 31 passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 最小传播实现

- Status: done
- Owner: coordinator
- Objective: 向 adapter 增加可选字段，并在 AgentSession 两个默认构造路径传入当前 Agent cache key。
- Inputs and prerequisites: T-001 红阶段证据。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts`, `packages/coding-agent/src/core/agent-session.ts`。
- Expected output: 四处局部接线变更，不改变其他 compaction 选项或行为。
- Dependencies: T-001.
- Execution steps:
  1. 扩展 `createPiAiCompleteFn()` options 与 provider request options。
  2. 修改手动和自动 AgentSession call site。
  3. 重跑目标测试确认转绿。
- Acceptance criteria:
  - T-001 全部转绿，undefined fallback 与现有 session routing 不变。
- Verification method:
  - 两个目标 Vitest 文件与静态检查。
- Validation evidence: adapter options 新增并传播可选 `promptCacheKey`；manual/auto call site 均传入 `this.agent.promptCacheKey`；两个目标文件转绿，共 2 files / 38 tests passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 审查、全局检查与提交

- Status: done
- Owner: coordinator
- Objective: 审查最小 diff、并发 HEAD 变更兼容性和任务边界，完成仓库规定验证与提交。
- Inputs and prerequisites: T-002。
- Scope or files: 本任务修改文件与本 task document。
- Expected output: 目标检查和根静态检查通过，显式路径提交且未包含无关文件。
- Dependencies: T-002.
- Execution steps:
  1. 对比 HEAD `15d17d50b`，确认不覆盖 `estimatedTokensAfter` 等并发改动。
  2. 运行 `npm run check` 后立即核对共享 worktree diff。
  3. 运行 validator、`git diff --check`，显式 stage/commit。
- Acceptance criteria:
  - 全部 acceptance criteria 有当前证据；提交范围只含任务文件。
- Verification method:
  - 精确命令输出、git diff/status、task validator。
- Validation evidence: 对比 `15d17d50b` 确认 `estimatedTokensAfter` 改动保持不变；全仓仅有两个 production call site 且均已接线；目标 2 files / 38 tests passed；根 `npm run check` 通过且 Biome 报告 no fixes；task validator 与 `git diff --check` 通过；status 仅含四个任务代码/测试文件、本任务文档及两个既有未跟踪 harness 文档。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 红阶段：分别运行 adapter 测试与 AgentSession compaction 测试，确认只因 custom `promptCacheKey` 缺失失败。
2. 绿阶段：重跑两个文件，覆盖 adapter、manual 与 automatic call sites。
3. 静态：仓库根运行完整 `npm run check`；随后核对自动改写范围。
4. 收尾：task validator、`git diff --check`、staged diff/status 审核。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 错把 cache key 替代 session ID 会破坏 WebSocket/transport affinity；测试同时断言两者不同且原值不变。
- 只修改 adapter 而漏掉 AgentSession call sites 不会让 production path 生效；手动和自动集成断言分别覆盖。
- `npm run check` 会自动写文件；运行后按项目 learning 立即核对 tracked/untracked 状态，避免纳入并发 session 文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-30: 创建 execute task document；核对 AGENTS.md、相关 learnings、HEAD/worktree、Agent 正常请求、provider option 定义、compactor adapter、AgentSession 两个 call site 与现有测试。
- 2026-08-30: 确认最小范围是一个可选 adapter 字段、一次 provider option 传播和两个 AgentSession 参数接线；T-001 开始。
- 2026-08-30: adapter、manual 与 auto 三个断言均只因 custom `promptCacheKey` 缺失而失败，同时 session ID 保持预期原值；T-001 完成，T-002 开始。
- 2026-08-30: 完成四处局部接线；adapter 5 tests 与 AgentSession compaction 33 tests 全部通过。T-002 完成，T-003 开始。
- 2026-08-30: 对抗审查确认 adapter 仍固定 `cacheRetention: "short"`、session ID 未被 cache key 替代、undefined key 继续交给 provider fallback；`rg` 确认两个 production call site 均已覆盖。
- 2026-08-30: 根 `npm run check` 通过且无自动修复；与 `15d17d50b` 对比、task validator、`git diff --check` 和 worktree 边界检查通过。T-003 完成。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-003 均完成；三个回归先因 custom key 缺失按预期失败，修复后目标 2 files / 38 tests passed；根 `npm run check`、task validator、`git diff --check` 和相对 `15d17d50b` 的 diff 审查通过。
- Limitations: 未调用真实 provider；验证覆盖 provider adapter 捕获到的最终 request options，不声称外部 provider 的实际缓存命中率。
