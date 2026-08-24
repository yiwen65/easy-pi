# Task Plan: Implement context inspection command

- Created: 2026-08-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: User request to implement the proposed read-only `/context` inspection scheme.

<!-- task-doc-section:background-goal -->
## Background and goal

为高保真 compaction 增加只读 `/context` 命令，使用户能够查看当前激活快照的概要和按 zone 组织的 compacted projection；只有显式 `--full` 才显示 system prompt 与工具定义。命令不得触发压缩、改变 session、snapshot、event log 或 recall 状态。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- 增加 host/AgentSession 的只读 context inspection API。
- 增加 `/context`、`/context inspect`、`/context inspect --full` 的 autocomplete、路由和 TUI 输出。
- 为无活动 snapshot、普通 inspect、full inspect、非法参数和只读性增加回归测试。

Non-goals:

- 不修改 compaction trigger、压缩算法、snapshot schema 或 provider 请求。
- 不把完整 context 绑定到全局 tool expand。
- 不增加 RPC 命令、持久化副本、依赖、构建或 Git 提交。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前 `/compact <text>` 会把后缀作为 customInstructions 并再次触发压缩，因此不能复用 `/compact inspect`。 | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3061-3064` |
| F-002 | Prompt builder 已返回按 zone 划分的 sections、tokenStats 与 projectionStats。 | `packages/coding-agent/src/core/compaction/subsystem/prompt-builder.ts:585-683` |
| F-003 | HfCompactionHost 已拥有 active snapshot、branch-visible events、recall catalog 与同一 prompt builder。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts` |
| F-004 | Built-in slash commands 与 TUI 路由分别由 `slash-commands.ts` 和 `InteractiveMode` 管理。 | `packages/coding-agent/src/core/slash-commands.ts`; `packages/coding-agent/src/modes/interactive/interactive-mode.ts` |
| F-005 | 工作树存在大量其他会话的重叠未提交改动，必须仅修改和验证显式文件。 | `git status --short` observed 2026-08-24 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: `/context inspect` 展示当前高保真 prompt projection，不声称是包含下一条用户输入的逐字 provider request；影响是避免错误表达动态 context。
- Assumption: `--full` 使用 provider-neutral 活跃工具定义 JSON；不同 provider 的最终 schema 变换不在本任务范围内。
- Open question: None; 用户已明确授权实施 `/context` 方案。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- `/context` 显示 mode、active snapshot、projection kind、coverage、当前预计 tokens、recall/tail 数量和 zone token 分布。
- `/context inspect` 显示非敏感 projection sections，不显示 system prompt 和工具定义。
- `/context inspect --full` 在明确警告后额外显示 system prompt 与 provider-neutral 活跃工具定义。
- 无活动 snapshot 和非法参数给出明确、无副作用的消息。
- 命令执行前后 snapshot version、event count、recall count 不变。
- 目标测试、compaction 子系统测试和 `npm run check` 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: None; API、TUI 和验证修改存在直接依赖且共享文件，协调器串行执行。
- Serialization constraints: `session-integration.ts`、`agent-session.ts`、`interactive-mode.ts` 已有共享工作树改动；只做局部 patch，不进行批量格式化或宽范围 staging。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — Add read-only inspection API

- Status: done
- Owner: coordinator
- Objective: 从 active snapshot 和 branch-visible event projection 构造可测试、无副作用的结构化 inspection 结果。
- Inputs and prerequisites: F-002、F-003；active snapshot 与 prompt builder API。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts`; focused subsystem tests.
- Expected output: public typed inspection result，包含 metadata、tokenStats、projectionStats、sections，并由 AgentSession 安全暴露。
- Dependencies: None.
- Execution steps:
  1. 增加 inspection 类型和 HfCompactionHost 只读构造方法。
  2. 仅在 TUI 的显式 full 分支附加 system/tool definitions。
  3. 增加无活动 snapshot、zone 内容和 state immutability 测试。
- Acceptance criteria:
  - 普通 inspection 不含 system/tools；full inspection 显式包含。
  - 调用前后 snapshot/event/recall 状态不变。
- Verification method:
  - Targeted Vitest for context inspection API.
- Validation evidence: `context-inspection.test.ts` 2/2 passed; verifies no active snapshot, redacted/full projection, offloaded tail refs, and unchanged snapshot/event/recall counts.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Add `/context` command and TUI rendering

- Status: done
- Owner: coordinator
- Objective: 增加 autocomplete、解析和只读可读输出。
- Inputs and prerequisites: T-001 done.
- Scope or files: `packages/coding-agent/src/core/slash-commands.ts`; `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; new focused command test.
- Expected output: `/context`、`/context inspect`、`/context inspect --full` 可用，非法参数显示 usage。
- Dependencies: T-001.
- Execution steps:
  1. 注册 built-in command metadata 和参数提示。
  2. 在 `/compact` 之前路由 `/context`，确保不触发 compact。
  3. 复用 Text/Container 模式渲染概要、zones 与 full 警告。
- Acceptance criteria:
  - 三种命令行为与 usage 正确。
  - `/context inspect` 输出不含 system/tool 内容。
- Verification method:
  - Focused InteractiveMode Vitest.
- Validation evidence: `interactive-mode-context-command.test.ts` 5/5 passed; covers autocomplete, dispatch without compact, summary, redacted inspect, full inspect, missing snapshot, and invalid arguments.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Validate integration and shared-worktree scope

- Status: done
- Owner: coordinator
- Objective: 验证命令、compaction 邻接行为和静态检查，确认无范围外改写。
- Inputs and prerequisites: T-001、T-002 done.
- Scope or files: tests and task document only; no production expansion.
- Expected output: targeted tests、compaction subsystem、`npm run check` 和 focused diff checks 通过。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 运行目标 command/API tests。
  2. 运行 compaction subsystem 和相关 InteractiveMode tests。
  3. 运行 `npm run check` 并核对工作树差异。
- Acceptance criteria:
  - 所有计划验证通过且无非目标文件被 check 改写。
- Verification method:
  - Recorded commands and outputs in this document.
- Validation evidence: target/neighbor tests 20/20 passed; compaction subsystem 393 passed / 8 skipped; final `npm run check` passed; focused `git diff --check` passed.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Targeted API test: context inspection result、full redaction、无活动 snapshot、只读状态。
- Targeted TUI test: autocomplete、dispatch、summary、inspect、full、usage。
- Neighbor tests: compaction subsystem；existing interactive compaction/contract command tests。
- Static/system check: `npm run check`（结束后必须检查是否自动改写）。
- Diff checks: `git diff --check -- <target paths>` and focused status.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Risk: full 输出包含 system prompt/tool definitions；mitigation: 只有精确 `--full` 才显示，并输出敏感信息警告。
- Risk: event projection 与真实 provider request 概念混淆；mitigation: UI 明确标注 current compacted projection and no pending user input。
- Risk: 大 tail 导致输出过长；mitigation: 只在显式 inspect 时渲染，默认 `/context` 仅显示概要。
- Risk: 共享脏工作树发生冲突；mitigation: apply_patch 局部编辑、显式路径验证、不提交。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-24: Task document created and populated from current source evidence; T-001 started by coordinator.
- 2026-08-24: T-001 completed; focused API test passed 2/2. T-002 started by coordinator.
- 2026-08-24: T-002 completed; focused command test passed 5/5. T-003 started by coordinator.
- 2026-08-24: Compaction subsystem passed 393 tests with 8 skipped. Initial `npm run check` exposed a test-only mock return-type mismatch; narrowed the mock to `ContextInspection | undefined`.
- 2026-08-24: Final `npm run check` passed, target/neighbor tests reran 20/20 passed, and focused diff checks passed. T-003 completed.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001, T-002, and T-003 are done; task document validation, focused tests, compaction subsystem, static/type/browser checks, and focused diff checks passed.
- Limitations: No build, real-provider call, or manual tmux smoke was run; none is required to verify this read-only command path, and repository rules prohibit build unless requested.
