# Task Plan: OpenAI Codex Luna 深度真实缓存评测

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户明确批准更新 `UPDATE_PERMISSIONS` 并执行已确认的大预算真实 Provider 测试合同。

<!-- task-doc-section:background-goal -->
## Background and goal

用户已确认仅针对 `openai-codex/gpt-5.6-luna` 的深度真实缓存矩阵，并明确授权更新真实 Provider 权限。硬上限为 20 次模型请求或 US$10（任一先到即停止）。本轮使用约 14 次请求覆盖 SSE/auto、durable 默认 affinity、显式 override、不同 session/前缀、`cacheRetention:none` 和多轮 warm 重复性；仅在真实或离线证据支持时修复 bug/优化。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- 新增独立 `PI_REAL_CACHE_MATRIX_EVAL=1` 门控的 Luna 真实评测；默认测试必须 skip；
- 只发送合成长 system prompt 和短响应请求，无工具、仓库内容或用户数据；
- 最多 14 个计划调用，保留 6 个调用用于必要复现，绝不超过 20 次；
- 记录每个场景的 input/output/cacheRead/cacheWrite/cache-read ratio/latency 和 usage cost；
- 真实失败先分类并尽量用 mock/faux 回归复现，再做最小修复；
- 最终运行定向测试、必要静态检查、diff check 和 task validator。

Non-goals:

- 不调用 OpenAI Codex 之外的 Provider，不测试 Luna 之外的模型；
- 不发送真实项目内容，不输出响应正文、凭证、authorization header 或敏感完整 URL；
- 不开放式压测，不超过 20 次/US$10，不因单次延迟波动优化；
- 不部署、提交、stash、reset、clean 或清理共享工作树。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户选择 20 次/US$10、仅 OpenAI Codex、Luna 深度矩阵，并两次明确确认执行及权限更新。 | 本轮 structured confirmation 与用户消息“授权你更新运行时合同UPDATE_PERMISSIONS，并执行”。 |
| F-002 | 当前最小 Luna SSE 两请求真实评测已通过，warm cacheRead=5888、ratio=85.17%。 | `docs/tasks/2026-08-23-real-provider-cache-hardening-task.md`。 |
| F-003 | 现有 real eval 使用 production ModelRuntime/AuthStorage、dispatcher、脱敏 diagnostic fetch 和 synthetic prompt。 | `packages/coding-agent/test/real-cache-affinity-eval.test.ts`。 |
| F-004 | 当前工作树高度脏，多个相关 source/test/task 文件属于其他会话或前序任务。 | 2026-08-23 `git status --short`。 |
| F-005 | 共享 cache helper/affinity/strict-JSON 的扩展离线回归与 root check 已通过。 | `docs/tasks/2026-08-23-cache-affinity-hardening-task.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: “请求次数”按模型生成调用计数；HTTP retry/transport handshake 不另计模型请求，但会在错误诊断中记录。
- Assumption: usage cost 若 Provider/模型目录返回 0，US$10 为 best-effort 成本上限，20 次模型调用仍是强制上限。
- Assumption: `cacheRetention:none` 可能仍受到 Provider 自动 prefix cache 影响，因此该场景观测 usage，不仅凭真实 cacheRead 判定客户端 bug；客户端不发送 affinity 的语义由离线 adapter tests 保证。
- Open question: 无。合同与权限已明确确认。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新 eval 默认无 opt-in 时 1/1 skipped，不访问 Provider；opt-in 只允许 `openai-codex/gpt-5.6-luna`。
- 计划调用不超过 14；总调用（含必要复验）不超过 20，累计报告成本不超过 US$10。
- SSE 默认、多轮 repeat、显式 override、两个独立 session 和 auto 场景的 eligible warm 请求报告 `cacheRead > 0`；冷请求和 `none` 场景只报告，不作超出 Provider 合同的绝对断言。
- 所有输出仅包含脱敏指标；无 response text、credential 或敏感 URL。
- 每个代码修复有可复现失败和回归；无证据则不修改产品。
- 定向测试、代码有变化时的 `npm run check`、任务路径 diff check 和 task validator 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005`。
- Parallel batches: 无。所有真实调用和可能修复由 coordinator 串行执行，保证预算与归因。
- Serialization constraints: 新 eval 独占新文件；若必须修改共享 source/test，先检查精确 diff 并定点编辑。Root check 前后比较 status 路径集合。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现受预算保护的真实矩阵 eval

- Status: done
- Owner: coordinator
- Objective: 创建默认 skip、合成数据、硬请求/成本预算和脱敏指标输出的 14-call Luna matrix。
- Inputs and prerequisites: F-001 至 F-005；现有 real eval 模式。
- Scope or files: `packages/coding-agent/test/real-cache-affinity-matrix-eval.test.ts`；任务文档。
- Expected output: 五类串行场景：SSE repeat 4、explicit override 2、cross-session 4、none 2、auto 2，共 14 次。
- Dependencies: None.
- Execution steps:
  1. 复用 production runtime/auth/dispatcher 和脱敏错误模式。
  2. 在每次 `harness.prompt` 前检查 20-call/US$10 hard stop，并累计 usage cost。
  3. 每场景使用独特 synthetic stable prefix，避免跨场景污染；只输出指标。
- Acceptance criteria:
  - 默认不运行；模型/provider 固定；无响应正文。
  - 计划请求数静态等于 14，runtime hard cap 等于 20。
- Verification method:
  - 默认 skip test；静态审查；ts check。
- Validation evidence: 新增独立 `PI_REAL_CACHE_MATRIX_EVAL=1` 门控文件；静态场景调用数为 4+2+2+2+2+2=14，runtime hard cap=20、cost cap=US$10；输出仅含 metrics。文件级 Biome 通过并格式化 1 file，root `tsgo --noEmit` passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 默认门控与离线矩阵校验

- Status: done
- Owner: coordinator
- Objective: 在不调用 Provider 的情况下验证门控、预算、场景数量和代码质量。
- Inputs and prerequisites: T-001 完成。
- Scope or files: 新 eval 与已有相关离线 tests。
- Expected output: default skip、targeted adapter/harness tests 和静态检查结果。
- Dependencies: T-001.
- Execution steps:
  1. 无 opt-in 运行新文件，确认 skip。
  2. 运行 AgentHarness/cache adapter 定向 tests。
  3. 在真实执行前审查输出字段与预算逻辑。
- Acceptance criteria:
  - 无网络默认路径通过；预算不能被场景代码绕过。
- Verification method:
  - 指定 Vitest；代码审查；必要 typecheck。
- Validation evidence: 新 eval 无 opt-in 1/1 skipped；AgentHarness scaffold 9/9 passed；OpenAI completions/responses/Codex adapter 88/88 passed；`tsgo --noEmit` passed。预算检查位于每次 prompt 前，reported cost 每次返回后累积并阻止后续调用。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 执行 14-call Luna 深度真实矩阵

- Status: done
- Owner: coordinator
- Objective: 在确认预算内执行所有真实场景并收集脱敏指标。
- Inputs and prerequisites: T-002 完成；用户授权；本机 AuthStorage。
- Scope or files: 新 eval；只读 Provider/AuthStorage。
- Expected output: 每场景和总计 metrics、调用数、成本、pass/fail。
- Dependencies: T-002.
- Execution steps:
  1. 设置唯一 opt-in，固定 Luna。
  2. 串行执行，不并发；达到 cap 立即 fail closed。
  3. 分类 miss、network/auth、transport fallback、usage anomaly 或产品 failure。
- Acceptance criteria:
  - 不超过 14 个计划模型调用；不泄露敏感数据。
  - eligible warm assertions 满足，或留下可诊断失败。
- Verification method:
  - 指定 Vitest `--silent=false`。
- Validation evidence: opt-in matrix 1/1 passed，14/14 planned calls 完成，reported cost US$0.017082（远低于 US$10）。7 个 eligible warm calls 全部 cacheRead=8960，平均 cached-input ratio=89.22%；5 个 eligible cold calls 全部 cacheRead=0。`cacheRetention:none` 两轮均 cacheRead=0；auto warm cacheRead=8960。输出仅含脱敏 metrics。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 缺陷修复与必要复验

- Status: done
- Owner: coordinator
- Objective: 只修复矩阵稳定暴露且可归因的 bug，或记录无需修改的结论。
- Inputs and prerequisites: T-003 完成或失败证据。
- Scope or files: 由最早失败分歧决定；最多使用剩余 6 次真实调用。
- Expected output: regression + minimal fix +复验，或无代码修改。
- Dependencies: T-003.
- Execution steps:
  1. 先离线复现，区分 Provider 抖动与产品缺陷。
  2. 实施最小修复并跑离线回归。
  3. 必要时受预算复验；无证据不改代码。
- Acceptance criteria:
  - 总调用不超过 20/US$10；修改均有失败证据。
- Verification method:
  - 定向 tests；必要 real rerun。
- Validation evidence: 所有 session/transport/retention 场景符合预期，未暴露可复现产品 bug。eligible cold/warm 平均 latency 为 2386ms/2017ms（本次样本 -15.4%），平均 reported cost 为 US$0.002018/US$0.000411（-79.6%）；成本下降与 89.22% cache read 一致，但 latency 仅作小样本观测。不修改产品，不消耗保留的 6 次复验预算。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 静态检查、边界审查与收口

- Status: done
- Owner: coordinator
- Objective: 完成最终回归、工作树边界核对和任务文档验证。
- Inputs and prerequisites: T-004 完成。
- Scope or files: 本任务直接文件；任务文档。
- Expected output: 最终 passed/partial/failed 状态与限制。
- Dependencies: T-004.
- Execution steps:
  1. 默认 skip 和受影响离线 tests。
  2. 代码变化后运行 root check，前后核对 status；否则运行最小静态验证。
  3. diff check、task validator、预算/敏感输出复核。
- Acceptance criteria:
  - 指标、请求数、成本与限制准确；无无关文件归属声明。
- Verification method:
  - 指定 tests、`npm run check`（代码有变化）、diff check、task validator。
- Validation evidence: `npm run check` 全阶段通过、Biome no fixes；check 前后 `git status --porcelain` 完全一致。新 eval 默认 1/1 skipped；新 eval 与任务文档 whitespace check 通过；task validator 通过。最终真实调用 14/20、reported cost US$0.017082/US$10，无敏感输出。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 默认：`real-cache-affinity-matrix-eval.test.ts` 无 flag 时 skip。
- 离线：AgentHarness scaffold、OpenAI/Codex cache adapter tests。
- 真实：仅 `PI_REAL_CACHE_MATRIX_EVAL=1` 指定运行新文件；14-call matrix，串行。
- 修复：先 mock/faux regression，再使用剩余至多 6 calls 复验。
- 最终：受影响 tests、必要 root check、task-path diff/whitespace check、task validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Provider 限流、网络和 cache routing 非确定；矩阵保留场景级输出并避免并发。
- auto transport 可能 fallback SSE；记录 transport 场景但不把 fallback 本身视为 bug。
- `none` 可能仍命中 Provider 自动缓存；客户端禁用 affinity 用离线请求捕获验证。
- 共享工作树高度脏；新增文件优先，修改共享文件必须定点并逐 diff 核对。
- Cost metadata 可能为 0；因此 20-call cap 是不可绕过的最终上限。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: 用户确认 20 次/US$10、仅 OpenAI Codex、Luna 深度矩阵及自动修复权限。
- 2026-08-23: 用户明确授权更新 `UPDATE_PERMISSIONS` 并执行；新 execute task document 创建，T-001 -> in_progress。
- 2026-08-23: T-001 -> done；新增 14-call/20-hard-cap/US$10-cap 的独立 synthetic Luna matrix eval，文件级 Biome 与 root typecheck 通过。
- 2026-08-23: T-002 -> done；默认 1/1 skipped，Agent 9/9 与 AI adapter 88/88 passed；T-003 -> in_progress。
- 2026-08-23: T-003 -> done；14/14 calls、US$0.017082，matrix 1/1 passed；全部 7 个 eligible warm calls cacheRead=8960，平均 ratio 89.22%，none 场景两轮 cacheRead=0。
- 2026-08-23: T-004 -> done；未发现产品 bug，无需复验或产品代码修改；聚合 cold/warm latency 2386/2017ms、平均 cost US$0.002018/US$0.000411，仅把 latency 视为小样本；T-005 -> in_progress。
- 2026-08-23: `npm run check` 全阶段通过、Biome no fixes，status 路径集合前后不变；默认 matrix eval 1/1 skipped，whitespace check 与 task validator 通过；T-005 -> done，Overall status -> done。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 新增受 `PI_REAL_CACHE_MATRIX_EVAL=1` 门控的 14-call Luna matrix；默认 1/1 skipped，opt-in 1/1 passed。真实请求 14/20，reported cost US$0.017082/US$10；7/7 eligible warm calls cacheRead=8960、平均 ratio=89.22%，5/5 eligible cold calls cacheRead=0，none 场景 2/2 cacheRead=0，auto warm cacheRead=8960。Agent 9/9、AI adapter 88/88、root `tsgo --noEmit`、`npm run check`、whitespace check 和 task validator 通过。未发现需修复的产品 bug；新评测文件是本轮唯一 code/test 交付。
- Limitations: 单模型、单地区/账号、14-call 小样本；不能外推所有 Provider、长期命中率或统计显著 latency。auto transport 的内部选择可能受环境影响。所有文件仍未提交，工作树含大量其他会话改动。
