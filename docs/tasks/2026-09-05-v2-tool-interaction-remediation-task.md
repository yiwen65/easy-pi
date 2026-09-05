# Task Plan: Pi v2 工具模型交互整改

- Created: 2026-09-05
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户“制定整改计划并参考best-practice实施”；承接上一轮 Pi tools 第一性原理静态分析。

<!-- task-doc-section:background-goal -->
## Background and goal

以可验证任务完成率、端到端成本和准确性为目标，先消除已确认的模型交互浪费：Search 已生成的判别信息没有进入模型正文；Edit 已默认支持 apply，但生产提示词仍强制 prepare→commit。此次交付为有针对性回归证据的第一阶段整改，不把静态推论写成实测加速。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Search：在模型正文显示有界、转义的候选预览及必要的结构上下文，保留路径分组、locator、覆盖状态、预算和 continuation；修正与新输出直接相关的边界问题。
- Edit：普通 apply 和显式 commit 返回有界差异反馈，明确它来自编辑计划而非独立 postimage/测试验证；保留 prepare、审批钩子、版本/范围/唯一原文校验、创建不覆盖、部分提交和 overlay 语义。
- 生产接口：推荐单一 canonical 写法（mode、maxResultsGlobal、viewId），利用已有默认值减少重复字段和强制往返；普通变更推荐 apply，需要事先审阅时使用 prepare/commit。同步 SDK 文档与生产集成测试。
- 不删除既有别名、方言或有意实现的功能；真正缩减模型 schema 字段/废弃别名另行确认。本轮接口精简是使用合同和提示精简，不宣称 schema 字节缩减。
- 不修改 legacy 四工具及其默认选择；不改调度器、PTY、索引、hash/diff 算法或权限架构；不新增依赖、不执行安装/发布/push。
- 不调用付费模型/embedding API，不复用已冻结的旧 held-out 做调优，不改历史评测结果。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已授权计划与实施，权限不包含付费评测。 | 当前请求；AGENTS.md Commands。 |
| F-002 | 基线为 my-pi 分支 46bb3336b0191df80327dd262d5f1b0203ebcb06；tracked clean。 | 2026-09-05 git status --short / rev-parse HEAD；既有 untracked：docs/harness_tools 两文件、docs/permission/、08-30 Linux 权限任务、09-01 subagent 活动任务，全部保留。 |
| F-003 | Search 在 details 中保存 preview/enclosingSymbol/nodeKind，正文仅有路径、位置、matchKind 和 match。 | packages/agent/src/harness/tools/search-v2.ts：compactTextHit、formatGroupedLocators、execute；extensions.md 明确 content 才发送给模型。 |
| F-004 | Edit action 省略时已是 apply；prepare/commit 走同一 mutation backend。 | packages/agent/src/harness/tools/edit-v2.ts：editAction、createEditV2Tool；mutation-core.ts。 |
| F-005 | 生产提示词强制 prepare/commit/重读，要求多个可推导字段；也提示 move 后立即 update，需与新鲜 view 约束一致。 | packages/coding-agent/src/core/tools/tool-profile.ts：promptContributions；edit-v2.ts：validateViewBinding。 |
| F-006 | 默认 legacy 不变；v2 显式 opt-in 恰为 search/read/edit/run；能力 schema 已动态收窄。 | packages/coding-agent/README.md；docs/sdk.md v2 段；tool-profile-v2.test.ts。 |
| F-007 | 旧小样本与 partial held-out 无法证明普遍性能优势或 H-02 的原因。 | packages/coding-agent/test/tool-profile-eval/RESULTS.md；上一轮静态分析。 |
| F-008 | 配置给出的 /Users/w/Projects/pi 文档路径不存在；相关真实引用在此 checkout。 | 文件存在性检查；pi/packages/coding-agent/README.md 与 docs/sdk.md。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 有界预览可能减少无效 Read，默认 apply 提示可能减少往返；只能以合同/本地测试验证本轮实现，真实收益需新的、预先冻结且获授权的评测。
- Assumption: 普通受控修改无需强制独立 prepare；宿主审批仍在 backend commit 前触发，prepare 保留给显式审阅场景。
- Open question: 是否废弃/隐藏既有 schema 别名，以及何时启动新付费评测；两项均延后，不阻塞本轮非破坏性整改。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A-001：相同 query 命中的不同上下文能在 Search content 中辨别，短行可读，超长/Unicode/控制字符预览明确截断且受 maxOutputBytes 约束；结构信息不伪装成验证结论。
- A-002：部分/溢出/零结果不能冒充完整覆盖；locator 可由 Read 消费，省略结果不遗留可用的未输出 locator。
- A-003：apply、prepare、commit、pending_acceptance 正文状态真实且反馈不超过 32KiB，成功差异标明计划来源/非独立验证；失败不返回成功证据。
- A-004：默认 apply 提示使用 viewId 推导 hash/range，只有必要时显式提供更窄范围；prepare/commit 仍可用。提示不引导依赖不存在的新鲜 destination view。
- A-005：原有 stale/ambiguous/preimage/range/no-overwrite/approval/partial safeguards、能力选择、默认 legacy 与现有别名/方言语义不回退。
- A-006：所有修改的测试文件实际运行，依赖路径集成测试与根 npm run check 通过，任务文档通过校验；只提交本任务文件并保留其他 worktree 改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 + T-002 → T-003 → T-004。
- Parallel batches: Batch 1 为 T-001（Search 源码/单测）和 T-002（Edit 源码/单测），依赖已满足且所有权不相交，一次 bounded subagent DAG 启动。Batch 2 T-003 由 coordinator 串行集成；Batch 3 T-004 校验与提交。
- Serialization constraints: 只有 coordinator 修改本权威文档；tool-profile.ts、SDK 文档与生产集成测试仅属 T-003；root check 与 git staging/commit 只在 subagent 结束、集成后执行。若并行委派不能启动，T-001/T-002 记 blocked 并请求用户批准串行，不自行降级。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 模型可见的有界 Search 判别证据

- Status: done
- Owner: search-feedback
- Objective: 把已有候选判别信息送入 content，同时确保预算和覆盖诚实。
- Inputs and prerequisites: F-003；基线 search-v2.ts 与 search-v2.test.ts 全文；原有 locator ledger 和 caps。
- Scope or files: packages/agent/src/harness/tools/search-v2.ts；packages/agent/test/harness/search-v2.test.ts。
- Expected output: 小范围正文格式/边界修改及覆盖短行、长行、结构上下文、预算和 partial 的回归测试。
- Dependencies: None.
- Execution steps:
  1. 检查预览截断和正文预算，保留 schema/运行时功能，不增加开关。
  2. 实现判别预览，所有不可信 preview/结构字段使用安全转义和明确截断标识。
  3. 精确更新旧 locator-only 断言并新增边界断言；运行 V-001 后返回结构化报告。
- Acceptance criteria:
  - A-001、A-002、A-005；不要改 cursor/provider 语义或声称实测加速。
- Verification method:
  - V-001；coordinator 审查 diff 并重新运行后才批准 done。
- Validation evidence: 2026-09-05T14:00+08:00，coordinator 审阅四文件 candidate diff 后补回长路径预算测试、增加正命中无其他 notice 的 partial 回归及未输出 locator 清理断言；在 packages/agent 执行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/search-v2.test.ts test/harness/edit-v2.test.ts`，2 files / 42 tests passed；git diff --check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Edit 成功反馈与真实状态

- Status: done
- Owner: edit-feedback
- Objective: 普通 apply 和 commit 提供有界变更摘要/差异，不要求额外 prepare 才能观察差异。
- Inputs and prerequisites: F-004；基线 edit-v2.ts 与 edit-v2.test.ts 全文；现有 MAX_EDIT_FEEDBACK_BYTES 和 backend 路径。
- Scope or files: packages/agent/src/harness/tools/edit-v2.ts；packages/agent/test/harness/edit-v2.test.ts。
- Expected output: 复用反馈逻辑、清楚的来源/状态标签、边界与防回退测试。
- Dependencies: None.
- Execution steps:
  1. 在既有成功分支加入有界计划差异，prepare/apply/commit/overlay 标签各自真实。
  2. 不增 postimage hash、额外读取、独立验证或原子性保证；不改变执行校验和 backend 调用。
  3. 测试省略 action/viewId-only、显式 commit、Unicode 大反馈、overlay、拒绝/部分失败；运行 V-002 后报告。
- Acceptance criteria:
  - A-003、A-005；保留历史 PREIMAGE_MISMATCH recovery 文案和既有方言/别名。
- Verification method:
  - V-002；coordinator 审查 diff 并重新运行后才批准 done。
- Validation evidence: 2026-09-05T14:00+08:00，与 V-001 同一次真实 repo 定向命令，2 files / 42 tests passed；diff 确認只改变 description 与 success feedback，不改变 backend/approval/版本/范围/唯一原文控制链；默认 apply/viewId-only、prepare/commit、overlay、Unicode 32KiB、拒绝与 partial failure 断言通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 生产提示/SDK 合同及依赖路径集成

- Status: done
- Owner: coordinator
- Objective: 把低往返使用路径落到真实 session，而非仅 core 工具。
- Inputs and prerequisites: T-001/T-002 验证通过；tool-profile.ts、tool-profile-v2.test.ts 全文；修改前完整阅读 sdk.md。
- Scope or files: packages/coding-agent/src/core/tools/tool-profile.ts；packages/coding-agent/test/tool-profile-v2.test.ts；packages/coding-agent/docs/sdk.md。
- Expected output: canonical Search 参数建议、默认受控 apply/可选预审阅提示、新鲜 view 的移动更新恢复指导、生产链路回归与文档。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 使用 mode/maxResultsGlobal 和 viewId 作为推荐写法；不移除 schema 字段/别名。
  2. 默认 apply，显式 prepare 审阅后 commit；依据反馈/风险选择 Read，始终按变更风险做最小有效验证。
  3. 增加真实 runtime Search→Read→一次 apply 与审批拒绝/overlay 集成证据，保持默认 legacy/capability/三方言测试。
  4. 同步 SDK 中旧强制 prepare/commit 描述，运行 V-003。
- Acceptance criteria:
  - A-004、A-005；模型正文而非 details 中具有判别与反馈信息。
- Verification method:
  - V-003；逐项核对提示词不矛盾、不声称单次 apply 免审批。
- Validation evidence: 2026-09-05T14:08+08:00，packages/coding-agent 执行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tool-profile-v2.test.ts`，1 file / 24 tests passed。验证默认 legacy、动态能力与别名/方言、真实本地 Search→Read→一次 viewId-only apply、审批调用/拒绝、stale view、source update→move；配置的 fake backend 验证 apply/commit 的 pending acceptance 正文与基线不变，未将其当成真实 overlay 后端持久性证明。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 定向回归、静态检查与任务所有权提交

- Status: in_progress
- Owner: coordinator
- Objective: 用当前执行证据关闭整改并形成可回退提交。
- Inputs and prerequisites: T-003 完成；所有子任务报告与 diffs；初始 git 状态。
- Scope or files: 本任务全部修改；本权威文档；git 显式 staging/commit。
- Expected output: 本地回归/根检查结果、最终核验记录、仅任务自有文件的提交。
- Dependencies: T-003.
- Execution steps:
  1. 对异常边界和真实控制路径做反向审查，运行 V-004/V-005；不执行 real-model eval。
  2. 运行 V-006 后立即检查 git diff/status，确保自动格式化未扩大范围。
  3. 更新任务状态、运行 V-007，显式 stage task-owned paths 并按 AGENTS.md 提交；核验提交与剩余状态。
- Acceptance criteria:
  - A-001 至 A-006 有当前证据；不以旧评测结果作为本轮通过依据。
- Verification method:
  - V-001 至 V-007；提交前后 diff/status 与提交文件清单。
- Validation evidence: 2026-09-05T14:11+08:00，V-001/V-002/V-004 合并运行 7 files / 86 tests passed；V-003/V-005 合并运行 5 files / 41 tests passed，共 127 项不重复定向测试。14:12 V-006 npm run check exit 0（format/lint、固定依赖、TS imports、shrinkwrap/install-lock、tsgo、browser smoke）；Biome 只格式化本任务 tool-profile-v2.test.ts，随后 diff/status 无范围扩张且 git diff --check 通过。14:13 格式化后 V-003 重跑 24/24 passed。提交与最终 V-007 尚待执行。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

所有 Vitest 从指定 package root 运行；绝不跑整套 Vitest、npm test、npm run build 或真实付费请求。

- V-001（packages/agent）：`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness/search-v2.test.ts`。
- V-002（packages/agent）：同上 CLI，`--run test/harness/edit-v2.test.ts`。
- V-003（packages/coding-agent）：同上 CLI，`--run test/tool-profile-v2.test.ts`。
- V-004（packages/agent）：同上 CLI，`--run test/harness/read-v2.test.ts test/harness/run-v2.test.ts test/harness/tool-state.test.ts test/harness/v2-foundations.test.ts test/harness/agent-harness-tool-gateway.test.ts`。
- V-005（packages/coding-agent）：同上 CLI，`--run test/default-tools-setting.test.ts test/tool-system-prompt-contributions.test.ts test/experimental-tool-strict-mode.test.ts test/v2-host-adapters.test.ts`。
- V-006（repo root）：`npm run check`，保留完整输出，不截尾；随后 `git diff --stat`、`git status --short`。
- V-007：`python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-09-05-v2-tool-interaction-remediation-task.md`。
- 只有出现依赖链回归才扩展定向测试，新增命令/证据记入执行日志。历史冻结 evaluator/fixture 不改不调优。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 加入预览可能增加输出字节并减少同预算返回数：有界预览、预算回归与诚实 overflow 是硬门槛；不把字节增长视为自动退步或把判别信息视为已证实收益。
- backend success 不是独立 postimage 验证；反馈必须标注计划来源，overlay 不是基线 workspace 成功变更。
- 全局格式检查含 biome --write，可能碰到其他 session 的文件；前后检查所有权，禁止 reset/clean/stash。
- 当前 workspace 根 /Users/w/Projects/easy-pi 不是 Git repo，目标是嵌套 pi repo；subagent 必须正确解析目标。委派失败时按规则阻塞并询问，不伪造并行成功。
- 既有外部写入与跨文件部分失败边界未消除；本轮不承诺 OS sandbox、跨文件原子性或默认 profile 升级。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-05T13:28+08:00：创建并立即填充本次唯一 authority 文档；重检目标 revision、instructions、tracked clean 与无关 untracked。
- 2026-09-05T13:28+08:00：边界决策：先精简推荐输入/执行步骤，保留所有 intentional aliases/dialects；完整 schema 瘦身与付费评测延后。
- 2026-09-05T13:28+08:00：T-001/T-002 → in_progress，owner 分别为 search-feedback/edit-feedback，准备一次并行 DAG 委派；仅 coordinator 写任务文档。
- 2026-09-05T13:56+08:00：一次 DAG c391bc37-92fb-4ec5-a442-2251e73b4445 两任务成功返回，candidate 4812b0759e35854d7f4342bc91052f31bc63856f 位于隔离 mirror（并未直接改动 pi worktree）。报告推荐 coordinator 审查；工具显示 validation=not_run，不能视为测试通过。已审阅四文件 diff，仅提取任务所有权路径集成，并将在真实 repo 重跑 V-001/V-002。两任务保持 in_progress。
- 2026-09-05T14:00+08:00：coordinator 以 git apply --check 验证仅四条路径的 preimage 后集成，补充 Search 反向审查测试；V-001/V-002 共 42 tests passed，T-001/T-002 → done。T-003 → in_progress，owner coordinator；已完整阅读 SDK 文档，下一步同步生产提示与集成测试。
- 2026-09-05T14:07+08:00：V-003 首次 23 passed / 1 failed，新测试错误地期待审批原异常直接出现在 message。查证 HookedMutationBackend 将拒绝包装为 EDIT_ROLLED_BACK 并保留 cause；只修正测试为断言稳定 code/message/cause，不更改产品错误合同。
- 2026-09-05T14:08+08:00：V-003 重跑 24/24 passed，T-003 → done。T-004 → in_progress，owner coordinator；开始最终边界审查、依赖路径回归与 root check，提交前再核对文件所有权。
- 2026-09-05T14:11+08:00：反向审查加强 Search Unicode fixture：UTF-8 128-byte 预算、故意错开 surrogate pair 的 320/200 字符边界。V-001/V-002/V-004 实际合并命令为 Agent CLI `--run test/harness/search-v2.test.ts test/harness/edit-v2.test.ts test/harness/read-v2.test.ts test/harness/run-v2.test.ts test/harness/tool-state.test.ts test/harness/v2-foundations.test.ts test/harness/agent-harness-tool-gateway.test.ts`，86/86 passed。V-003/V-005 实际合并命令为 coding-agent CLI `--run test/tool-profile-v2.test.ts test/default-tools-setting.test.ts test/tool-system-prompt-contributions.test.ts test/experimental-tool-strict-mode.test.ts test/v2-host-adapters.test.ts`，41/41 passed。
- 2026-09-05T14:13+08:00：root npm run check 完整输出 exit 0，只格式化本任务集成测试；格式化后重跑 V-003 24/24 passed，diff --check 通过、tracked 仍仅七个任务文件，无关 untracked 保持。测试初次 message 预期修正属于常规迭代，不满足可复用教训门槛，LEARNS.md 不改。准备只显式 stage 本任务八文件并提交；此刻尚未声称提交成功。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002/T-003 已完成；127 项定向测试、格式化后集成重跑与 root npm run check 通过。T-004 等待所有权提交和最终文档核验。
- Limitations: 不运行真实模型/付费评测，不能从本地合同验证推断完成率或速度提升；schema 别名/字段未裁撤，legacy 默认未变；不新增跨文件原子性或 OS sandbox 保证。
