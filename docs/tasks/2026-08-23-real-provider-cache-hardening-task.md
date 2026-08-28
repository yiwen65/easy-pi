# Task Plan: 真实 Provider 缓存亲和验证与加固

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户明确授权调用真实 Provider 测试，并修复潜在 bug 和优化点。

<!-- task-doc-section:background-goal -->
## Background and goal

离线/faux 全方位加固已完成，本轮是新的执行目标：使用本机已配置凭证，通过显式门控的最小真实 Provider 请求验证当前工作树中的 durable cache affinity、真实 usage 归因和冷/热请求表现；若真实调用稳定暴露产品缺陷，完成根因定位、最小修复和回归。历史 handoff 显示 `openai-codex/gpt-5.6-luna` SSE 曾成功返回 warm cache read，因此本轮以该已知可用组合开始，不把旧结果当作当前验证。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- 显式设置 `PI_REAL_MODEL_EVAL=1`，仅运行 `packages/coding-agent/test/real-cache-affinity-eval.test.ts`；
- 明确指定 `openai-codex/gpt-5.6-luna` 和 SSE，执行一次冷请求、一次同 durable session 热请求；
- 仅记录 provider/model/transport、usage、cache-read ratio 和 latency；不输出响应正文、凭证或完整 URL；
- 对真实失败或异常指标进行因果定位，使用离线 regression 复现后再修复；
- 修复后运行受影响定向测试、静态检查与任务边界核对。

Non-goals:

- 不进行无界模型/provider 矩阵、并发压测、负载测试或成本开放式调用；
- 不打印、读取到聊天、写入任务文档或持久化任何凭证；
- 不因单次网络抖动、Provider 缓存非确定性或延迟噪声修改产品；
- 不重置、提交、stash、clean 或覆盖共享工作树其他会话改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户在当前消息中明确授权真实 Provider 测试。 | 用户消息“授权调用真实Provider测试，并修复潜在bug和优化点”。 |
| F-002 | 真实 eval 有 `PI_REAL_MODEL_EVAL=1` 门控，使用 production `ModelRuntime/AuthStorage`，只打印脱敏 usage/latency。 | `packages/coding-agent/test/real-cache-affinity-eval.test.ts`。 |
| F-003 | eval 每次只执行两次请求，system prompt 稳定且超过 1024 tokens，assert warm `cacheRead > 0`。 | 同文件 `stableSystemPrompt` 和测试主体。 |
| F-004 | 历史 `openai-codex/gpt-5.6-luna` SSE 曾 warm `cacheRead=5888`；当前必须重验。 | `docs/handoff/2026-08-23-183602-pi-cache-hit-rate-optimization.md`。 |
| F-005 | 当前共享工作树高度脏，真实 eval 文件及前轮 task document 均未跟踪。 | 2026-08-23 `git status --short`。 |
| F-006 | 前轮离线加固已修复 Azure disable、optional affinity 和 strict-JSON array undefined，并通过定向/静态验证。 | `docs/tasks/2026-08-23-cache-affinity-hardening-task.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 本机仍配置可用于 `openai-codex/gpt-5.6-luna` 的 AuthStorage 凭证；测试只判断是否可用，不展示凭证。
- Assumption: 用户授权覆盖本任务内受控的真实 Provider 调用；初始预算为 2 次请求。如需额外真实请求，将仅在定位所必需且保持小规模时执行，并在任务日志准确计数。
- Assumption: cache hit 是 Provider 端非完全确定行为；只有可重复的产品路径错误才修代码。
- Open question: 无阻塞问题；先运行已存在且受门控的最小 Luna eval。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 真实 `openai-codex/gpt-5.6-luna` SSE 冷/热请求均成功，prompt token 数足够触发缓存，warm `cacheRead > 0` 且 cached-input ratio > 0。
- 输出和文档不包含凭证、响应正文或敏感完整 URL；真实调用次数有界并记录。
- 如果暴露 bug：有真实失败证据、最早分歧与离线 regression，最小修复后真实/离线验证通过。
- 如果未暴露 bug：不制造无证据产品修改；仅记录真实指标与可证实优化结论。
- 最终受影响定向测试、`npm run check`（如代码有变化）、任务路径 `git diff --check` 和 task validator 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003`。
- Parallel batches: 无。真实调用、诊断和修复必须串行，避免重复花费与不可归因结果。
- Serialization constraints: 真实调用仅由 coordinator 执行；任何自动写检查前后比较共享工作树状态集合。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 执行受控 Luna 冷/热真实验证

- Status: done
- Owner: coordinator
- Objective: 用 production runtime 和本机凭证验证当前 durable affinity 的真实 cache read。
- Inputs and prerequisites: F-001 至 F-005；显式环境门控。
- Scope or files: `packages/coding-agent/test/real-cache-affinity-eval.test.ts`；只读 AuthStorage。
- Expected output: 脱敏 usage、ratio、latency、调用次数和 pass/fail。
- Dependencies: None.
- Execution steps:
  1. 记录目标 provider/model/transport，不显示凭证。
  2. 显式运行门控测试，仅两次请求。
  3. 分类结果为产品成功、认证/网络阻塞、Provider 抖动或产品失败。
- Acceptance criteria:
  - 不泄露响应正文或 credentials。
  - 成功时 warm cache read 和 ratio 均大于 0；失败时有脱敏 error chain。
- Verification method:
  - 指定 Vitest 文件，`--silent=false`。
- Validation evidence: opt-in Luna SSE 1/1 passed，共 2 次真实请求。cold input=6884/output=9/cacheRead=0/cacheWrite=0/1419ms；warm input=1025/output=9/cacheRead=5888/cacheWrite=0/1657ms；warm cached-input ratio=85.17%。只输出脱敏 usage/latency，无响应正文或凭证。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 真实结果根因分析、修复与优化判定

- Status: done
- Owner: coordinator
- Objective: 对 T-001 的结果做因果分析，只修复可稳定归因的产品 bug，只实施有指标/复杂度证据的优化。
- Inputs and prerequisites: T-001 完成。
- Scope or files: 由首个失败分歧决定，优先 cache affinity、Provider options、usage parsing 和 eval harness。
- Expected output: 最小修复及 regression，或“无需代码修改”的有证据结论。
- Dependencies: T-001.
- Execution steps:
  1. 对照 cold/warm prompt tokens、cacheRead/cacheWrite、sessionId 传递和 transport。
  2. 若失败，先用离线 mock/faux 复现并定位最早分歧。
  3. 修复后仅执行必要的额外真实请求；无根因证据则不改产品。
- Acceptance criteria:
  - 每个修改对应真实或离线失败证据。
  - 优化不以单次 latency 波动为依据。
- Verification method:
  - 定向 mock/faux/adapter tests；必要时一次两请求真实复验。
- Validation evidence: cold/warm prompt totals 分别为 6884 与 6913，增长符合第二轮新增消息；warm 5888 tokens 被 cache read，说明 durable metadata ID 已正确贯穿 production runtime/transport/Provider usage parsing。真实结果未暴露产品 bug；warm 单次 latency 比 cold 高 238ms，属于网络/生成噪声，不能作为优化依据，因此不实施无证据代码修改，也无需额外付费复验。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 回归、静态检查和收口

- Status: done
- Owner: coordinator
- Objective: 验证真实结果与任何修复，完成共享工作树边界和任务文档收口。
- Inputs and prerequisites: T-002 完成。
- Scope or files: 本任务直接路径、任务文档；如无代码变化则不重复无意义的全仓自动写检查。
- Expected output: 当前可复现的最终证据和限制。
- Dependencies: T-002.
- Execution steps:
  1. 运行受影响定向测试及 real eval 默认 skip。
  2. 如修改代码，运行 `npm run check` 并核对前后 status；无代码变化则复用前轮 current-worktree check 并运行最小静态验证。
  3. 运行任务路径 `git diff --check`、task validator，更新最终状态。
- Acceptance criteria:
  - 真实调用次数、指标、skip 门控和未覆盖范围明确。
  - 所有 task 状态和最终结论与证据一致。
- Verification method:
  - 指定 Vitest、必要静态检查、diff check、task validator。
- Validation evidence: real eval 无 opt-in 时 1/1 skipped；real eval 与本任务文档的 untracked-file whitespace check 通过；task validator 通过。T-002 未修改任何 source/test，因此没有重复运行自动写的 root check；同一当前工作树在前序加固任务中已通过 `npm run check` 和 599 个扩展离线回归，本轮只增加任务文档。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. `PI_REAL_MODEL_EVAL=1 PI_REAL_CACHE_PROVIDER=openai-codex PI_REAL_CACHE_MODEL=gpt-5.6-luna PI_REAL_CACHE_TRANSPORT=sse` 指定运行 real cache eval。
2. 成功：记录 cold/warm usage、cache-read ratio 与 latency；检查 warm prompt token accounting。
3. 失败：保留脱敏 host/error chain，先离线定位；认证或网络错误不伪装为产品 bug。
4. 修复后运行受影响 package 的指定 tests；real eval 无 opt-in 必须 skip。
5. 代码有变化时执行 root check；始终执行 task-path diff check 和 task validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 真实请求有成本：初始严格限定 2 次、小输出、无工具；额外调用只用于必要复验。
- Provider 缓存和网络有噪声：不凭一次延迟或偶发 miss 修改产品。
- 本机凭证或模型可失效：报告为外部阻塞，不打印凭证，不尝试绕过认证。
- 共享工作树脏：不清理或提交他人改动；所有完成声明限定到任务路径和命令证据。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 新 execute task document 创建；确认当前用户明确授权真实 Provider。
- 2026-08-23: 读取 real eval、handoff、当前 status 和相关 LEARNS；选择已知配置 `openai-codex/gpt-5.6-luna` SSE，T-001 -> in_progress。
- 2026-08-23: T-001 -> done；2 次真实请求成功，warm cacheRead=5888，cached-input ratio=85.17%。
- 2026-08-23: T-002 -> done；production affinity、token accounting 和 usage parsing 均符合预期；未发现可复现 bug，单次 warm latency 波动无优化因果证据，未改代码、未追加真实调用；T-003 -> in_progress。
- 2026-08-23: 默认门控验证 1/1 skipped，任务文件 whitespace check 和 task validator 通过；无 source/test 变化，未重复自动写 root check；T-003 -> done，Overall status -> done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 真实 `openai-codex/gpt-5.6-luna` SSE 1/1 passed，共 2 次调用；cold input=6884/cacheRead=0/output=9/1419ms，warm input=1025/cacheRead=5888/output=9/1657ms，warm cached-input ratio=85.17%。默认无 opt-in 1/1 skipped；任务路径 whitespace check 与 task validator 通过。真实结果未暴露产品 bug或有因果证据的优化点，因此本轮未修改代码，避免将 latency 噪声误修为产品问题。
- Limitations: 只验证已配置的 OpenAI Codex Luna SSE，不代表其他 Provider/model/transport；缓存和 latency 受 Provider/网络影响。本轮没有运行开放式矩阵或额外付费复验，所有改动仍未提交。
