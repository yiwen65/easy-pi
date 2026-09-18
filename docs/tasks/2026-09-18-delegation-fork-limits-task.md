# Task Plan: Raise delegation objective and remove fork context cap

- Created: 2026-09-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求将 objective 上限提高到 40,000 字符，并取消 fork 上下文大小限制。

<!-- task-doc-section:background-goal -->
## Background and goal

`spawn_agent`/`followup_task` 的任务 objective 当前受 2,048 字符和整个 delegation 8 KiB 双重限制；fork/rebuild 与 preserve 捕获还受 256 KiB 限制。目标是允许最多 40,000 字符的 objective，并让 fork 上下文依赖 Pi 自身 compaction，而不再由 collaboration 层拒绝。curated evidence 和普通消息/结果的既有安全预算不在本次取消范围内。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：collaboration contract/store、fork/preserve 上下文准备、相关工具描述、文档与定向测试。非目标：改变 send_message/result 的 8 KiB 上限、curated evidence 的 256 KiB 限制、模型 context window 或 compaction 行为、执行槽/agent/mailbox 限制。保留共享工作树中其他会话已修改的 controller/session-host/computer 文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | objective schema 当前 maxLength=2048，完整 delegation 另受 8192-byte 检查。 | `packages/subagent/src/collaboration-contract.ts` |
| F-002 | task receipt 的 message text 当前复用普通消息 8 KiB 限制，因此只提高 schema 不足。 | `packages/subagent/src/collaboration-store.ts`, `collaboration-controller.ts` |
| F-003 | rebuilt fork 在 `prepareCollaborationFork` 拒绝超过 256 KiB；preserve 捕获超过同阈值时不保存。 | `packages/subagent/src/context-fork.ts`, `packages/coding-agent/src/extensions/pi-collaboration-context.ts` |
| F-004 | 用户选择 objective 明确上限 40,000 字符。 | 当前会话结构化确认 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “取消 fork 上下文限制”只针对 fork/rebuild/preserve；curated evidence 仍保持 256 KiB 防止显式文件摄入无界。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `spawn_agent` 和 `followup_task` 接受 40,000 字符 objective，拒绝 40,001 字符。
- delegation/task receipt 的持久化与运行路径接受该 objective，普通 mailbox message/result 仍保持 8 KiB。
- rebuilt fork 与 preserve 捕获不因 256 KiB collaboration 限制失败；仍过滤悬空 tool call/result。
- curated evidence 继续执行原 256 KiB 单文件/组合预算。
- 文档准确区分这些限制，相关定向测试和 `npm run check` 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无；核心 schema、store 和测试彼此耦合，串行处理。
- Serialization constraints: `packages/subagent/src/collaboration-controller.ts`、`session-host.ts` 有其他会话修改，本任务避免编辑；若必须触及则先重新核对 diff。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 更新 objective 与 task receipt 合约

- Status: done
- Owner: coordinator
- Objective: 将 objective 上限提升到 40,000 字符并解除 delegation 8 KiB 对任务合约的阻塞，同时保持普通消息/结果预算。
- Inputs and prerequisites: F-001、F-002、用户确认。
- Scope or files: `packages/subagent/src/collaboration-contract.ts`, `packages/subagent/src/collaboration-store.ts`。
- Expected output: 明确分离 task objective/task receipt 与普通 message/result 限制。
- Dependencies: None.
- Execution steps:
  1. 引入 task/objective 专用常量并更新 schema/validation。
  2. 调整持久化 MessageSchema 与 snapshot 校验按 kind 应用预算。
  3. 增加边界回归测试。
- Acceptance criteria:
  - 40,000/40,001 边界及持久化路径有自动化覆盖。
- Verification method:
  - 运行 collaboration contract/store/controller 定向 Vitest。
- Validation evidence: `packages/subagent` 定向测试 97/97 通过；40,000/40,001 字符、task receipt 与普通消息预算均有覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 取消 fork 上下文 256 KiB 限制

- Status: done
- Owner: coordinator
- Objective: rebuilt fork 与 preserve 捕获不再因 collaboration 固定字节阈值失败。
- Inputs and prerequisites: F-003。
- Scope or files: `packages/subagent/src/context-fork.ts`, `packages/coding-agent/src/extensions/pi-collaboration-context.ts`, 相应测试。
- Expected output: fork/preserve 可携带 Pi compaction 后的完整有效上下文；curated 限制不变。
- Dependencies: T-001.
- Execution steps:
  1. 删除 rebuilt fork 的字节拒绝。
  2. 删除 preserve capture 的字节丢弃。
  3. 将 oversized 回归改为成功断言，并覆盖 preserve 捕获。
- Acceptance criteria:
  - 大于 256 KiB 的有效 fork/preserve 上下文可准备和读取。
  - curated 预算测试/逻辑保持。
- Verification method:
  - 运行 context-fork 与 pi-collaboration-tools 定向 Vitest。
- Validation evidence: `context-fork.test.ts` 验证 300 KiB rebuilt fork；`pi-collaboration-tools.test.ts` 验证 300 KiB preserve capture；相关定向测试 140/140 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 文档、静态检查与最终审阅

- Status: done
- Owner: coordinator
- Objective: 同步用户可见契约并完成回归门禁。
- Inputs and prerequisites: T-001、T-002。
- Scope or files: `packages/coding-agent/docs/collaboration.md`, `packages/coding-agent/src/extensions/pi-collaboration-tools.ts` 及本任务改动。
- Expected output: 准确文档、通过定向测试和 `npm run check`，提交仅本任务文件。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 更新工具描述和 collaboration 文档。
  2. 运行定向测试、`npm run check` 并检查共享树差异。
  3. 审阅并提交本任务文件。
- Acceptance criteria:
  - 检查通过且无无关改动进入提交。
- Verification method:
  - 定向 Vitest、`npm run check`、`git diff --check`、任务文档 validator。
- Validation evidence: 文档已更新；scoped Biome 12 文件通过、`npx tsgo --noEmit` 通过、`git diff --check` 通过、任务文档 validator 通过。全仓 `npm run check` 及其 pinned-deps 阶段均被共享 `.artifacts/computer` 中嵌套配置/外部 fixture 阻塞，与本任务代码无关。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先运行 `packages/subagent` 的 contract/context-fork/controller 定向测试，再运行 `packages/coding-agent` collaboration tools/child host 相关定向测试；最后执行仓库要求的 `npm run check`，检查其是否改写共享工作树，仅提交本任务路径。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 超长 objective 会增加 SQLite snapshot 和子会话首轮 prompt 大小；以 40,000 字符显式封顶，仍由模型 context window/compaction 决定最终可执行性。
- 取消 fork 固定上限后，大上下文会增加内存与序列化成本；这是用户明确要求的行为，且只复制 Pi 当前 effective context，不读取原始全历史。
- 共享工作树已有大量无关修改；必须精确编辑和显式暂存。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-18: 用户确认 objective 上限为 40,000 字符；授权实现，并要求 fork 上下文不再受 collaboration 固定限制。
- 2026-09-18: 完成源码/测试/文档入口审计；T-001 开始，coordinator 独占修改。
- 2026-09-18: T-001/T-002 实现及定向验证通过：subagent 97/97、coding-agent 43/43、tsgo 通过。全仓 `npm run check` 因其他任务生成的 `.artifacts/computer/**/biome.json` 嵌套 root 配置在 1 秒内失败，未进入源码检查；改用本任务 12 文件 scoped Biome，检查通过且无修复。
- 2026-09-18: T-003 done。复跑定向测试 140/140、scoped Biome、tsgo、diff check 和任务 validator 均通过。`check:pinned-deps` 同样被共享 `.artifacts/computer` 外部 fixture 的非固定依赖阻塞；未修改或删除他人证据目录。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: objective 40,000/40,001 边界、40,000 字符 task receipt/followup、普通消息 8 KiB 保持、300 KiB rebuilt fork、300 KiB preserve capture均有自动化覆盖；定向测试 140/140，scoped Biome、tsgo、diff check、任务 validator通过。
- Limitations: 全仓 `npm run check` 未完成，因共享 `.artifacts/computer` 内嵌套 Biome root 配置及外部 package fixtures 的 pinned-deps 失败；这些不是本任务产物，未擅自修改。未运行完整测试套件（仓库规则要求仅按需运行定向测试）。
