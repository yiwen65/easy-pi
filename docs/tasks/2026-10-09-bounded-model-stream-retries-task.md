# Task Plan: 限制模型断流重试并保留失败记录

- Created: 2026-10-09
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户确认：移除无限重试，默认最多重试 10 次（含首次共 11 次请求），保留失败记录并显示错误；不中断当前 bevFusion。

<!-- task-doc-section:background-goal -->
## Background and goal

bevFusion 的模型流在生成中被对端关闭，easy-pi 无限重发未完成的助手请求且不保存失败，看起来长期停在 Working。修复 agent-level 模型调用重试预算和错误可见性；同一连续失败序列默认最多重试 10 次，成功后重置，不限制正常工具步骤。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：共享 AI 重试 helper、AgentSession（含压缩/分支摘要调用）、默认设置、重试事件/UI 接线、失败持久化、回归、文档、changelog、提交。
- 所有可重试错误共享预算；支持显式 `retry.maxRetries`（含 0）、禁用重试、取消与现有非重试配额/计费分类。
- 保留指数退避并保留现有网络恢复的 30 秒封顶，避免默认 10 次导致最后一次退避长达 17 分钟；大于 30 秒的显式 baseDelayMs 不降低。
- 不增加兼容 shim；移除无意义的 unlimited 分类/API/事件字段，记录必要迁移说明。
- 非目标：代理/上游故障修复、UI 重绘性能优化、隐藏思考显示改造、子代理任务重启调度策略、依赖/锁文件变化。
- 不重启、取消或热修改现有 bevFusion；代码将在新进程生效。测试不调用真实模型 API。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 真实模型流发生 peer-close 后无限重试，错误不进入历史 | `/tmp/pi-bash-task-8-8a00fe9b.log`：13:28:07.890 error、attempt 2 / unlimited true / delay 4000；新响应随后开始 |
| F-002 | 修复前网络/5xx 绕过有限预算，AgentSession 过滤这类失败 | `packages/ai/src/utils/retry.ts`、`packages/coding-agent/src/core/agent-session.ts:1025,3312` |
| F-003 | 本地控制变量重放复现相同错误和预算绕过 | `/tmp/pi-bash-task-10-b775dc0a.log`：控制 1 请求；4 次断流造成 5 请求，retryBudget 1，历史只保留成功 |
| F-004 | 开工时默认预算为 3，需改为用户选择的 10 | `packages/coding-agent/src/core/settings-manager.ts:31,878`；用户结构化确认 |
| F-005 | 工作区干净，分支 main；check 可能自动格式化共享文件 | 开工 `git status --short` 空；`git branch --show-current` main；LEARNS 中 check 自动改写教训 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 继续使用现有 maxRetries 语义：不计首次调用，对每个连续失败序列计数，成功后重置；已在执行范围中明确。
- Open question: 无。上游为何关闭连接是已排除的独立问题，不影响本地预算和可见性修复。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 无配置时最多 11 次调用；自定义 N 时最多 N+1 次；网络、5xx、普通瞬态失败混合也共享预算。
- 耗尽后最后一次 error 可见且持久化，session/core 均完成，不再自动继续；会话 ID 保持，可由用户再次提交。
- 自动重试禁用与 maxRetries=0 不额外调用；abort、quota/billing 非重试行为保留。
- 常规恢复成功与退避取消正常；摘要/压缩使用同样的有限策略。
- 失败不发送给随后重试的模型上下文，但不再从持久历史/UI 隐去；去掉 unlimited 显示/API 残留。
- 修改的测试全部通过，针对性邻域验证和 npm run check 无错误/警告/info；只提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 与 T-002 独立；T-003 依赖 T-001、T-002；新增 T-005 依赖 T-003；T-004 依赖 T-001、T-002、T-003、T-005。
- Parallel batches: A = T-001（AI 子代理）+ T-002（协调者）；B = T-003；C = T-005；D = T-004。
- Serialization constraints: 协调者独占本任务文档/changelog。AI helper 的回调契约先完成，再修改其 AgentSession 消费者；同一文件不由多个执行者同时编辑。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 共享 AI 重试预算

- Status: done
- Owner: retry-helper-worker
- Objective: 所有瞬态失败遵守一个有限预算，删除 unlimited 契约并保留退避取消。
- Inputs and prerequisites: 用户已确认策略；F-001 至 F-003；默认上限由调用者设置。
- Scope or files: `packages/ai/src/utils/retry.ts`、`packages/ai/test/retry.test.ts`。
- Expected output: 单计数器 helper、4 参数 onRetryScheduled、完整单元回归。
- Dependencies: None.
- Execution steps:
  1. 先用新预算回归观察旧代码失败。
  2. 最小修改并运行该测试文件。
- Acceptance criteria:
  - 网络/5xx/混合错误尊重 maxRetries，0 和禁用不重试，30 秒退避封顶，取消/成功回调正确。
- Verification method:
  - 从 packages/ai 执行指定 `test/retry.test.ts` Vitest。
- Validation evidence: 新预算回归在旧 helper 下 8 failed / 36 passed（`/tmp/pi-bash-task-1-e965f172.log`）；子代理修改后 53/53 passed，协调者独立重跑同文件 53/53 passed（`/tmp/pi-bash-task-13-5d17050d.log`）；完整 diff 已审查，无兼容 shim。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 默认值和文档

- Status: done
- Owner: coordinator
- Objective: 默认 retry.maxRetries 为 10，说明有限预算、历史失败记录和 API 迁移。
- Inputs and prerequisites: 已确认合同；现有 settings/API 文档。
- Scope or files: `packages/coding-agent/src/core/settings-manager.ts`、settings 测试、`packages/coding-agent/docs/settings.md`、两包 CHANGELOG `[Unreleased]`。
- Expected output: 默认与文档一致，自定义配置保持覆盖，changelog 记录行为/API 改变。
- Dependencies: None.
- Execution steps:
  1. 完整阅读所改文件；添加默认和覆盖回归。
  2. 修改默认、文档及 Unreleased，运行 settings 测试。
- Acceptance criteria:
  - 未设置时返回 10；显式值/0 保持；文档不再宣称无限恢复或隐藏历史。
- Verification method:
  - 指定 settings-manager 测试；文档 diff 审查。
- Validation evidence: settings-manager.test.ts 新默认回归在旧代码得到 3 而期望 10（1 failed / 44 passed）；修改后同文件 45/45 passed。日志 `/tmp/pi-bash-task-11-ee5e552d.log`、`/tmp/pi-bash-task-12-9cb01782.log`；settings/docs/changelog diff 已审查。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — AgentSession 与 UI 有限恢复

- Status: done
- Owner: retry-session-worker
- Objective: 统一预算，保留所有失败，耗尽后正确完成并显示错误，删除 unlimited 事件/显示分支。
- Inputs and prerequisites: T-001 的回调契约、T-002 默认值；既有状态与 TUI 测试。
- Scope or files: `core/agent-session.ts`、interactive-mode、status-indicator、grok pi-session-events 及其直接相关测试，协调者补充 `test/grok-shell-components.test.ts` 的已移除参数接线。
- Expected output: 单重试计数、失败持久化、有限重试 UI、更新回归和摘要调用接线。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 完整阅读所改文件；新增预算/历史回归，结合 F-003 旧行为记录证明故障；缺失旧 helper 导出不算有效 red。
  2. 修改实现、事件消费者及相关旧测试；运行所有修改测试。
- Acceptance criteria:
  - 自定义预算/成功重置/耗尽后 isIdle、取消、willRetry 与 UI 完成状态正确；记录失败且不污染重试上下文。
- Verification method:
  - AgentSession retry、suite retry-events、interactive retry、status-indicator、grok port 与压缩回归目标测试。
- Validation evidence: 子代理拥有文件目标 66/66 passed；协调者补充迁移 grok-shell 两处消费者后独立运行 7 files / 106 tests passed（`/tmp/pi-bash-task-16-787e9b31.log`），源实现 diff 已审查。默认压缩会计风险另行跟踪 T-005，未将其伪报通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 断流集成验证与交付

- Status: done
- Owner: coordinator
- Objective: 真实本地 HTTP 断流 + faux harness 验证最终合同，审查 diff，完成 check 和提交。
- Inputs and prerequisites: T-001、T-002、T-003、T-005 完成。
- Scope or files: 必要的 `packages/coding-agent/test/suite/` 预算/断流回归、本任务文档和本任务文件的 git 提交。
- Expected output: 默认 10/显式预算/相同 UND_ERR_SOCKET 停止与持久化的集成证据；干净检查及提交。
- Dependencies: T-001, T-002, T-003, T-005.
- Execution steps:
  1. 运行新增集成回归及针对性 prompt/queue/compaction 邻域测试。
  2. 独立审查、npm run check（完整输出）并核对改动归属。
  3. 更新本文真实状态/证据，验证文档，仅暂存本任务路径并提交。
- Acceptance criteria:
  - 本地断流预算耗尽，最终错误保留，正常控制成功；没有真实 API 请求或现有会话干预；所有要求检查通过。
- Verification method:
  - 指定 Vitest 文件、npm run check、task document validator、git diff/status。
- Validation evidence: 协调者基于 HEAD `ebc23881c` 的修复工作区独立运行 19 files / 259 tests passed，含全部修改的 coding-agent 测试、6 个 loopback 断流案例及 T-005/compaction 邻域（`/tmp/pi-bash-task-21-4830e490.log`）；AI helper 53/53 passed（`/tmp/pi-bash-task-22-e68d3288.log`）。另运行 prompt/queue/response-checkpoint 邻域 3 files / 44 tests passed（`/tmp/pi-bash-task-24-3a1661d3.log`）。首轮 check 的 Response 类型错误已通过保留 live body stream 的原生 Response 适配修正；完整 `npm run check` 重跑 exit 0，无错误/警告/info且 No fixes applied（`/tmp/pi-bash-task-23-e74e778e.log`，完整输出已读取）。并发/摘要邻域 3 files / 9 tests passed（`/tmp/pi-bash-task-25-3e3dd979.log`），共独立通过 26 files / 365 tests，无 skips。只读复查未发现剩余问题，已核验 response checkpoint 的预算保护与 compaction 投影兼容。修复提交已创建并核对 21 个路径，提交后本任务源码/测试/文档无残留 diff；四个已记录的无关空白变更未纳入。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 失败历史与默认压缩预算隔离

- Status: done
- Owner: retry-session-worker
- Objective: 保留失败历史的同时，将 error/aborted 助手内容排除出 provider-visible compaction 会计与准备阶段，避免 ghost token 压缩失败阻断重试。
- Inputs and prerequisites: T-003 完成；独立审查 `bounded-retry-final-review` 的具体路径；默认 full_pipeline 回归缺口。
- Scope or files: `core/compaction/subsystem/session-integration.ts`、`test/suite/agent-session-retry-compaction-history.test.ts`；不需要额外 AgentSession 接线。
- Expected output: 有失败大段 partial 内容时仍能按预算恢复，失败历史仍在，正常 user/tool/successful assistant 不被过滤。
- Dependencies: T-003.
- Execution steps:
  1. 完整阅读受影响文件/compaction 文档，编写 full_pipeline（独立 compaction-item CompleteFn）回归并观察旧实现有效失败。
  2. 在预算检查前最小过滤失败助手投影，不删除持久 entries，不更改工具错误/成功消息；运行目标回归及压缩邻域。
- Acceptance criteria:
  - 原对话可行 + 大段失败 partial 不导致必需压缩拒绝或重试额外调用；恢复成功且失败持久化；正常压缩语义保持。
- Verification method:
  - 目标 full_pipeline 回归、socket budget 集成及 compaction 子系统关联测试。
- Validation evidence: 旧压缩投影的有效 red 为 4 failed / 1 small-partial control passed；100k failed partial 导致 ~26015 tokens 超过 ~13564 预算，checkpoint tail 也虚增预测（`/tmp/pi-bash-task-6-db578f11.log`，协调者已读取完整输出）。子代理最终 green 13 files / 142 tests passed，无 skips；协调者完整审查源 diff/新测试并独立重跑含该集合的 19 files / 259 tests passed（`/tmp/pi-bash-task-21-4830e490.log`）。仅过滤 error/aborted 助手投影，保存的 entries/checkpoint/IDs/parents/leaf 不变；有效 user/custom/assistant/tool 内容、失败 tool result、未回答用户和 restored checkpoint 均覆盖。当前 API 无 goalComplete，历史教训已以实际 CompleteFn 类型重新核验。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Vitest 从各包根执行：`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <指定文件>`。
- 所有新/修改 suite 测试用 harness + faux provider；内部模型调用不在范围时 hfCompaction off，不消费真实 token。
- 先 red 后 green；最终完整运行修改文件与 retry/compaction/prompt/queue 邻域，再 npm run check。禁止 npm test/build 或直接全 Vitest。
- 文档每次重大更新运行技能 task_document.py validate；check 前后核对 git status，避免接纳其他会话的格式化变更。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 已确认行为/API 改变：移除无限恢复，移除 unlimited helper/回调参数/事件字段；不添加兼容保留层。
- 有限次数不等于总墙钟时限；单次仍由现有 header/body idle 配置管理，上游断流未被本补丁消除。
- 现有进程保持旧已加载代码；不自动应用到 bevFusion。
- 子代理调度器的任务级重启策略独立于本次模型调用预算，不改动。
- 暂无 blocker。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-09: 用户选择默认重试上限 10，并明确确认执行范围及不干预现有会话。
- 2026-10-09: 工作区干净/main；读取相关 retry/settings/SDK 文档，建立唯一任务文档。
- 2026-10-09: T-001、T-002 开始；T-003、T-004 等待依赖。
- 2026-10-09 14:36: T-002 red/green 完成（默认 3→10；45 settings tests passed），文档及 Unreleased 更新，状态 done。T-001 继续执行。
- 2026-10-09 14:41: T-001 独立重跑 53/53 passed，已接受；T-003 依赖满足并开始。AbortSignal 额外探测得到 listenerLimit=0、无警告；旧 sleep 监听器生命周期问题不扩大到本次修复。
- 2026-10-09 15:17: T-003 直接目标 106/106 passed 并接受。T-004 新 loopback 断流测试已开始，6/6 passed；首轮 check 因测试 Response 类型适配未通过。
- 2026-10-09 15:47: 独立审查发现 default-on compaction 会计可能计入 durable failed partial；新增 T-005 并开始，T-004 blocked 等待修复和最终 check。check 自动格式化了四个无关文件，核验仅空白差异，不纳入本任务提交。
- 2026-10-09 16:46: 恢复工作时 HEAD 已由并行会话从 `306dd93b7` 变为 `ebc23881c`（response checkpoint recovery）；保留该提交及共享文件内容，暂存区为空。T-005 diff、完整新测试和有效 red 已核验；独立复跑包含 T-005 的 259 tests 和 AI 53 tests 全通过，接受 T-005，T-004 解除阻塞继续。
- 2026-10-09 16:47: 完整 check exit 0，完整输出已读，未产生新格式化改动；prompt/queue/response-checkpoint 44 tests 全通过。
- 2026-10-09 16:49: 并发/摘要邻域 9 tests 全通过；共 365 tests 无 skips。只读复查未发现剩余问题；确认成功的 response checkpoint 不被投影过滤且不重置预算。新增 compaction 测试未直接组合 itemComplete 流与 full_pipeline，兼容性另有静态调用链审查及各自 targeted 回归。更新 Unreleased 说明失败 partial 与压缩预算隔离，准备只暂存本任务 21 个路径；四个无关空白 diff 不纳入提交。已关闭所有本任务子代理。
- 2026-10-09 16:50: 修复提交创建成功（父提交 `ebc23881c`），核验包含且仅包含本任务 21 个路径，提交后本任务文件无残留改动，暂存区为空；T-004 done。更新本权威文档为 done/passed，并仅将该状态更新折入本会话刚创建、尚未推送的修复提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 均 done，无 blocked；26 files / 365 tests passed，无 skips；完整 npm run check exit 0，无错误/警告/info；源/测试/文档 diff 已审查，T-005 独立复查无剩余问题。任务文档 validator 通过；修复已提交，21 个路径归属核验通过。
- Limitations: 没有真实模型调用；不含代理/上游修复或现有进程应用。新增持久历史检查用 SessionManager 的内存 entries，未新增磁盘 round-trip；itemComplete 与 full_pipeline 组合未单独运行，已有各自回归及静态兼容性审查。
