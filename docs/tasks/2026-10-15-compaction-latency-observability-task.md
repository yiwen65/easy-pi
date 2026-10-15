# Task Plan: Compaction 延迟观测与低推理优化

- Created: 2026-10-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求“按建议顺序执行优化”。

<!-- task-doc-section:background-goal -->
## Background and goal

分钟级压缩的历史样本间隔为 104–287 秒，约 61 万 token；无网络历史回放的本地核心开销只有毫秒级。先补观测定位模型侧等待，再显式采用低推理和更短的软性摘要目标；不把离线结果冒充真实加速。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

修改 coding-agent 的压缩观测、摘要请求参数、提示词、针对性测试和 compaction 文档。保留完整历史、缓存前缀、取消/重试、质量门和发布语义。不改主 agent 档位、不切换模型、不硬截断摘要、不改触发阈值、不调用真实模型、不改用户配置。当前分支 my-pi，不修改 changelog。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 正常路径一次生成，显式溢出时最多一次 force-trim 重发 | subsystem/narrative.ts:generateCompactionItem |
| F-002 | 压缩未传 reasoning，且 usage 丢弃 cache/reasoning 字段 | subsystem/session-integration.ts:createPiAiCompleteFn |
| F-003 | 手动与自动压缩共用 host，发布时未持久化 modelUsage | core/agent-session.ts:compact/_tryHfAutoCompaction/_publishCompactionCheckpoint |
| F-004 | 默认允许十次重试，带指数退避 | core/settings-manager.ts:getRetrySettings；pi-ai/src/utils/retry.ts |
| F-005 | 工作树开工时干净；禁止默认付费模型验证 | git status --short；AGENTS.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: low reasoning 与软性摘要长度目标是用户授权建议的保守实现；仍保留必须信息优先和不限硬输出长度。
- Open question: 真实服务端缓存、排队、推理和生成占比分别多少，需新观测或另行批准真实 API A/B；本任务不声称已有加速倍率。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 压缩成功、拒绝、失败、取消均有不含内容/密钥的持久化诊断；记录总耗时、host 阶段、每次调用首事件/首文本、完整 usage、重试退避及模型参数。
- 重试和溢出重发的观测不互相覆盖；length/error 不发布 checkpoint。
- 压缩显式 low，主 agent 档位不受影响；软性长度目标不变成截断或硬限制。
- 离线针对性测试及 npm run check 通过；代码 diff 经审查；提交仅限本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004；T-001 -> T-005 -> T-006 -> T-004。
- Parallel batches: T-001 内部以既定 collector 契约分离 backend 采集与 session 接线；后续优化保持顺序。T-004 独立只读审查可与协调者测试并行。
- Serialization constraints: compaction-session-metrics 子任务独占 agent-session.ts 和新 session 诊断测试；协调者只编辑 backend/其它文件；审查者只读；任务文档只由协调者更新。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 压缩诊断采集与会话持久化

- Status: done
- Owner: coordinator + compaction-session-metrics
- Objective: 建立可定位分钟级等待的无内容诊断。
- Inputs and prerequisites: F-001–F-004；现有模型 stream、retry callbacks、session custom entries。
- Scope or files: core/compaction/compaction.ts；subsystem/observability.ts；subsystem/session-integration.ts；core/agent-session.ts；针对性测试。
- Expected output: 分阶段、逐请求诊断，成功失败均持久化且不进入 provider context。
- Dependencies: None.
- Execution steps:
  1. 对共享摘要调用添加可选逐请求观测，默认非压缩路径保持原行为。
  2. host 记录准备/生成/校验阶段，adapter 保留完整 usage 和重试记录。
  3. 会话生命周期持久化诊断，不把诊断错误升级成压缩失败。
- Acceptance criteria:
  - 首事件/文本可缺省，不能伪造为零；retry/fallback 各次 usage 可区分。
  - 成功、拒绝、取消、错误可回归验证，历史消息投影不变。
- Verification method:
  - 定向运行压缩诊断与现有压缩测试。
- Validation evidence: 协调者审查 session diff 与新测试后，定向 vitest 运行 compaction-diagnostics、compaction-diagnostics-session、subsystem/session-integration、6647 回归，4 文件 31 测试通过；其中新 session 测试 9 项。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 显式低推理与软性短摘要目标

- Status: done
- Owner: coordinator
- Objective: 直接减少潜在推理和摘要生成负担，不硬截断续接信息。
- Inputs and prerequisites: T-001 的观测与测试。
- Scope or files: subsystem/session-integration.ts；subsystem/narrative.ts；compaction-summary-reasoning.test.ts；subsystem/narrative.test.ts。
- Expected output: 明确 low 参数、更短软目标、提示词版本更新及回归。
- Dependencies: T-001.
- Execution steps:
  1. 在压缩 adapter 显式传 low，与主 agent 分离。
  2. 添加典型 1000–2000 token 的软性目标，必要信息可超过，不改校验门。
  3. 验证真实 provider 请求构建中低档位可见（模拟 transport，无真实 API）。
- Acceptance criteria:
  - 不设置硬 maxTokens；不改变主 agent 或独立 branch summary 参数。
- Verification method:
  - adapter 与提示词定向测试、模拟 Codex 请求断言。
- Validation evidence: 优化前 low 回归 2 项失败；显式 low 后 Codex 模拟 transport 断言请求体 reasoning.effort=low 与缓存 key 保留。adapter、Codex、narrative、diagnostics 共 4 文件 32 测试通过（无真实 API），包含超软目标摘要不裁剪。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 文档与回归验证

- Status: done
- Owner: coordinator
- Objective: 文档精确描述新行为和诊断，验证集成边界。
- Inputs and prerequisites: T-001、T-002。
- Scope or files: packages/coding-agent/docs/compaction.md；相关测试；任务文档。
- Expected output: 针对性回归及 npm run check 的真实结果。
- Dependencies: T-002.
- Execution steps:
  1. 更新诊断字段、边界及低推理行为文档。
  2. 跑压缩、取消、续接及重试的针对性测试和全量静态检查。
  3. 核对检查命令自动改写范围。
- Acceptance criteria:
  - 通过检查或如实记录阻塞；不声称未经真实 API 验证的加速和保真。
- Verification method:
  - 明确文件列表的 vitest --run；npm run check。
- Validation evidence: npm run check exit 0（完整输出已读，Biome 仅格式化本任务 4 文件）；明确列出的 24 个回归文件最终 22 passed / 2 skipped，196 测试 passed / 13 既有 skipped。git diff --check 通过，无范围外改动。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 独立审查与提交

- Status: done
- Owner: coordinator
- Objective: 检查事件流、失败、隐私和缓存行为，并提交最小修改。
- Inputs and prerequisites: T-003 通过。
- Scope or files: 本任务所有 diff；只读审查子任务。
- Expected output: 已审查、验证、提交的改动和限制说明。
- Dependencies: T-003, T-006.
- Execution steps:
  1. 委托独立只读审查，检查结论并修复具体问题。
  2. 重跑受影响测试和检查，验证任务文档。
  3. 显式路径 stage 和 commit，仅包含本任务文件。
- Acceptance criteria:
  - 无未处理高风险问题；真实加速/质量 A/B 作为明确剩余验证限制。
- Verification method:
  - diff 审查、任务文档 validator、git status。
- Validation evidence: 独立 compaction-review 审查及后续复核完成，具体 finding 经 T-006 先红后绿修复；最终 npm run check 通过，25 文件 216 passed / 13 skipped；实现和使用文档已提交为 061b9049c（13 个明确路径，无其它改动）。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 重入生命周期隔离

- Status: done
- Owner: compaction-session-metrics
- Objective: 防止 session_compact hook 启动嵌套压缩时诊断串线或丢失。
- Inputs and prerequisites: T-001；子任务审查发现手动压缩在 awaited hook 前清理 controller，可重入。
- Scope or files: core/agent-session.ts；compaction-diagnostics-session.test.ts。
- Expected output: 显式捕获每轮 collector，不依赖全局当前 collector 推断归属。
- Dependencies: T-001.
- Execution steps:
  1. 在原有生命周期调用边界传递诊断 collector，保持原控制行为。
  2. 加入嵌套 hook 回归并运行定向测试。
- Acceptance criteria:
  - 两轮压缩各有独立记录；terminal end 无 start 时不虚构记录。
- Verification method:
  - session 诊断测试及已有手动/自动压缩回归。
- Validation evidence: 子任务最终 13 个 session 诊断用例通过；协调者审查显式局部 collector/WeakSet 与嵌套 hook 测试，并重跑 session 诊断、retry history、active tool loop 共 3 文件 20 测试通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 开始事件异常的观测与清理保护

- Status: done
- Owner: coordinator
- Objective: 修复独立审查发现的开始事件 subscriber 抛错时诊断遗漏。
- Inputs and prerequisites: T-005；compaction-review 首轮审查的具体控制流发现。
- Scope or files: core/agent-session.ts；compaction-diagnostics-session.test.ts。
- Expected output: 手动/自动开始事件分发处于 try 内，自动生命周期先初始化取消/完成状态。
- Dependencies: T-005.
- Execution steps:
  1. 增加 manual/threshold 参数化测试，先观察原实现漏记失败。
  2. 将 start 分发移动至现有 try，保持 catch/finally 负责清理及诊断结束。
  3. 重跑定向检查与独立后续审查。
- Acceptance criteria:
  - 两条路径均有一个无内容失败记录、零 checkpoint、清理取消状态。
- Verification method:
  - 修改前/后回归；静态检查；审查者复核。
- Validation evidence: 修改前 2 个新用例均因诊断 0 条而失败，其余 14 项通过；修改后诊断/6647/自动 queue 共 3 文件 27 测试通过；最终 25 文件 216 passed / 13 skipped，npm run check 通过；审查者复核确认原 finding 已解决，无其它具体问题。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

从 packages/coding-agent 使用仓库 node_modules/vitest/dist/cli.js --run 定向文件。先验证诊断事件流、完整 usage、重试、无文本、取消及异常；再验证 host fallback 和 session 持久化，最后跑邻接压缩/续接回归。运行 npm run check（完整输出）并核对 diff。无需 build，不运行 npm test 或真实 API。

最终命令（第一条从仓库根目录，第二条从 packages/coding-agent）：

```bash
npm run check
node ../../node_modules/vitest/dist/cli.js --run \
  test/compaction.test.ts test/compaction-serialization.test.ts \
  test/compaction-summary-reasoning.test.ts test/compaction-diagnostics.test.ts \
  test/compaction-diagnostics-session.test.ts test/compaction-codex-options.test.ts \
  test/agent-session-compaction.test.ts test/agent-session-auto-compaction-queue.test.ts \
  test/interactive-mode-compaction.test.ts test/compaction-extensions.test.ts \
  test/compaction-subsystem/trigger.test.ts test/compaction-subsystem/context-identity.test.ts \
  test/compaction-subsystem/default-on.test.ts test/compaction-subsystem/session-integration.test.ts \
  test/compaction-subsystem/narrative.test.ts test/compaction-subsystem/auto-compaction-feasibility.test.ts \
  test/suite/agent-session-compaction.test.ts test/suite/agent-session-retry-compaction-history.test.ts \
  test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts \
  test/suite/regressions/repeated-auto-compaction-active-tool-loop.test.ts \
  test/suite/regressions/pre-prompt-compaction-no-continue.test.ts \
  test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts \
  test/suite/regressions/6768-copilot-compaction-base-url.test.ts \
  test/suite/regressions/5217-compaction-reason.test.ts \
  test/session-manager/durable-storage.test.ts
```

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

低推理/短摘要实际保真和真实耗时需另行 A/B；本次只保留现有质量约束与离线行为验证。首事件不是首 token，更不能单独区分服务端排队与预填充；SDK 内部重试仍包含于一次调用耗时，外层 retry 单独记录。诊断不得持久化 prompt、工具参数、errorMessage 或 credentials。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-15: 创建并填充任务；工作树干净，确认先观测后低推理/软长度优化，无真实 API 权限。T-001 开始。
- 2026-10-15: collector 契约确定后，委托 compaction-session-metrics 独占 session 接线与新 session 测试；协调者实现逐调用/host 采集。backend 新诊断测试及现有 adapter/host/6647 回归共 4 文件 29 测试通过。
- 2026-10-15: session 接线 diff 已审查，协调者重跑诊断/host/6647 共 4 文件 31 测试通过，T-001 done。T-002 开始；新增 low 参数回归在优化前按预期失败（2 项），其它 6 项通过。
- 2026-10-15: low 与软性 1000–2000 token 目标已实现。修正新长摘要测试尾空白预期后，4 文件 32 测试通过，T-002 done，T-003 开始。子任务发现既有 hook 重入边界，新建 T-005 独立隔离 collector；不改变原有重入功能。
- 2026-10-15: T-005 完成并经协调者审查/重跑。24 文件回归初次发现两项：历史测试需适配新 metadata 末尾条目；active-loop fixture 的 1k 窗口在原始 HEAD 临时快照同样失败（重复压缩）。临时触发观测确认压缩后预测约 956 tokens 超过 950 阈值，停写诊断仍失败；仅将该 fixture 窗口改为 2k，保留全部原 oracle，原始 HEAD 和当前实现均通过；未修改产品触发逻辑。更正 metadata 断言后，3 文件 20 测试通过。开始 npm run check。
- 2026-10-15: npm run check 全部通过，Biome 格式化范围核对无额外改动；24 文件定向回归最终 196 passed / 13 skipped（22 文件通过、2 文件既有 skip）。T-003 done，T-004 开始独立只读审查。
- 2026-10-15: T-004 增加真实磁盘 SessionManager.create/open 回归，确认诊断重载和 context 排除；与 durable-storage 测试通过。独立审查指出 start subscriber 抛错绕过 try（既有控制流，新观测契约缺口）；新建并完成 T-006，先红后绿后复核。
- 2026-10-15: 最终 npm run check exit 0，格式化只触及本任务文件；25 文件回归 23 passed / 2 skipped，216 测试 passed / 13 既有 skipped。独立审查复核无剩余可执行问题。准备显式路径提交实现，再记录提交证据完成任务文档。
- 2026-10-15: 实现提交 061b9049c，13 文件，包含诊断/低推理/软长度目标/回归和使用文档。全部 T-001–T-006 完成，无阻塞任务；任务文档独立记录最终证据。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 全部六项任务已完成；实现提交 061b9049c；最终 npm run check exit 0；明确列出的 25 文件回归 23 passed / 2 skipped，216 测试 passed / 13 既有 skipped；无真实 API，独立审查 finding 已解决；git diff --check 与任务文档 validator 通过。
- Limitations: 未运行真实模型延迟/保真 A/B，不能声称实际加速倍率；未更换模型或修改 retry/触发阈值。未构建/安装或重启当前运行进程，源码变更需后续正常构建部署生效。
