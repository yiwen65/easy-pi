# Task Plan: 统一 Bash 命令工具

- Created: 2026-09-05
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户确认“保留bash”、其余 v2 名称不变后授权“执行整改”。

<!-- task-doc-section:background-goal -->
## Background and goal

统一命令工具为 bash。不是仅重命名 Run：共享参数、执行编排、输出/错误合同和 coding-agent 渲染，保留必要宿主适配。当前已有一个 NodeProcessExecutor，却仍有 Agent Bash、v2 Run、coding-agent Bash 三份上层编排。此次消除该重复，不宣称名称更换或代码合并带来未经测量的 LLM 性能提升。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- v2 工具名改为 search/read/edit/bash，legacy 默认仍为 read/bash/edit/write；不同时暴露 run，不保留 Run 别名或独立执行实现。
- 将 Run 的 command/cwd/timeout、退出码/信号/超时/耗时和工作目录检查并入 Agent Bash；coding-agent 原生 Bash 委托同一核心工具，只保留宿主的 BashOperations、原始字节捕获、spawnHook、会话环境和渲染适配。
- 保留 Bash 对非零退出、超时、中断的错误语义，补充结构化 details。Agent loop 当前会丢弃抛出错误的 details；增加明确 opt-in 的结构化工具错误类型及最小传播回归，不泛化改变任意错误。
- 默认原生 Bash 并行策略不变，核心 replay=never；v2 使用同一 Bash 定义但保持 sequential。保留动态 commandPrefix、env、AbortSignal、cwd policy、remote ExecutionEnv 和现有扩展接口。
- 删除 run-v2 源码/导出/context.run 和独立 renderer，迁移有效回归；原有 Bash prepare API 继续可用。
- 不改 Search/Read/Edit 语义、默认 profile、进程执行后端/PTY/后台任务、依赖、锁文件、权限体系或沙箱保证。
- 不运行付费 API/真实模型评测，不修改历史任务文档、冻结的 eval manifests/results/held-out；历史 Run 工具合同保留历史意义，不伪装成新 Bash 评测。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户明确授权将 Run 合入 Bash，其他 v2 名称不变。 | 当前对话与“执行整改”。 |
| F-002 | 基线 my-pi / 79567ce293f1ff9fa53c285971a03207407abeee，tracked clean。 | 2026-09-05T16:02 git status/rev-parse；保留既有 docs/harness_tools 两文件、docs/permission/、08-30 Linux 任务、09-01 subagent 活动任务等 untracked。 |
| F-003 | Node 上 Bash 和 Run 已共用 NodeProcessExecutor；上层仍有三份编排和两份 coding-agent renderer。 | packages/agent/src/harness/tools/{bash,run-v2}.ts；packages/coding-agent/src/core/tools/{bash,tool-profile}.ts；SDK v2 hosts 文档。 |
| F-004 | Bash 抛出非零/超时错误；Run 返回正常结果附状态。BashOperations 返回原始 Buffer，现有测试要求 UTF-8 跨 chunk 完整、完整日志不丢字节。 | 两份 Bash 源码；coding-agent test/tools.test.ts；output-accumulator.ts。 |
| F-005 | 普通 Agent loop 执行 catch 只保留 error.message、details 变成空对象。 | packages/agent/src/agent-loop.ts executePreparedToolCall / createErrorToolResult。 |
| F-006 | SDK 默认名单、CLI 帮助、v2 runtime、生产集成/renderer 测试有 Run 引用；冻结 eval 也有 Run 合同。 | rg createRunV2Tool/RunV2/run-v2/V2_TOOL_NAMES；sdk.ts、args.ts、tool-profile-v2.test.ts、tool-execution-component.test.ts 与 tool-profile-eval。 |
| F-007 | 配置引用根 /Users/w/Projects/pi 不存在；相关 Pi 文档位于此 checkout。 | 前序文件检查；当前读取 packages/coding-agent/docs/sdk.md。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 保留 Bash 已有错误语义比静默迁移所有原生调用者到 Run 正常结果语义风险更小；v2 的改动作为合并合同显式说明并验证。
- Assumption: 原始字节 BashOperations 和字符串 ExecutionEnv 需要不同捕获适配，但不应重复 schema、节流/结果状态编排和 renderer。核心提供 capture seam，默认仍用 executeShellWithCapture；native 适配复用 OutputAccumulator。
- Open question: 无阻塞产品决策。若发现必须移除未获授权的扩展功能或修改冻结历史资产，记录 blocked 并询问，不自行扩展。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A-001：模型、SDK、CLI 及当前 v2 runtime 只暴露 search/read/edit/bash；无 Run 别名/独立源码/导出/renderer，原生四工具名单不变。
- A-002：两 profile 的 Bash 委托同一核心 schema/执行/状态逻辑和 coding-agent renderer；只保留必要的宿主捕获适配。
- A-003：成功有结构化 exitCode/cwd/duration；非零/超时/信号/中断不会冒充成功或 exit 0；直接调用与 Agent 消息均保留错误标记和结构化 details，普通 Error 行为不变。
- A-004：cwd、prefix、spawnHook、PI_* 环境、remote ExecutionEnv、流式初始更新/节流、UTF-8 跨块、输出上限和完整日志、取消/进程树清理无回退。
- A-005：原生并行/v2 sequential 策略明确，不引入自动 replay；现有扩展 overrides/allowlist/denylist 和 lifecycle 正确。
- A-006：所有改动测试实际运行；定向依赖回归、root npm run check、任务 validator 通过；只提交 task-owned 文件，保留无关变更。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → (T-003 + T-004)；T-004 → T-006；T-003 → T-007 → T-008 → T-009；(T-003 + T-004 + T-006 + T-009) → T-005。
- 最终审查新增纠正路径：先由 coordinator 修正其 owned 的 Bash capture 路径合同（T-007），核心再次通过后验证并补齐 durable Harness 消费者（T-008），最后恢复 T-005 提交门。
- Parallel batches: T-001/T-002 因共享 schema/capture API 必须串行，由 coordinator 执行；T-003 生产接线与 T-004 文档在核心和宿主接口稳定后独立，用一次 bounded subagent DAG 并行委派；T-005 由 coordinator 最终审查。
- Serialization constraints: 只有 coordinator 修改本权威文档；不在共享接口未就绪时让消费者猜测实现；root check/staging/commit 等待所有 writer 结束。委派不能启动时记 blocked 并询问是否改为串行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 统一 Agent Bash 与结构化错误传播

- Status: done
- Owner: coordinator
- Objective: 在现有 Agent Bash 上整合 Run 合同并移除独立实现。
- Inputs and prerequisites: F-003/F-005；相关 source/test 修改前全文阅读。
- Scope or files: packages/agent/src/harness/tools/{bash,run-v2,index,tool-context}.ts；packages/agent/src/{types,index,agent-loop}.ts；packages/agent/test/harness/run-v2.test.ts 迁移为 bash.test.ts；新增 test/agent-loop-tool-error.test.ts；必要时 test/harness/tools.test.ts。
- Expected output: 单一 createBashTool；cwd/状态和 capture seam；明确的 AgentToolError details 传播；Run 源码与导出消失；迁移后的回归。
- Dependencies: None.
- Execution steps:
  1. 合并现有 Bash prepare 和 Run cwd/status；保留原生错误文本、成功输出不无故加 exit 0 页脚。
  2. 引入明确 opt-in 的 AgentToolError，在执行 catch 中保留该类型的 details；其他错误不变。
  3. 默认核心通过 ExecutionEnv 验证 cwd；native capture seam 将工作目录检查交给宿主 transport，不能用本机 fs 验证远程 cwd。
  4. 删除 Run 文件/导出/context.run，迁移其边界测试，执行 V-001。
- Acceptance criteria:
  - A-002/A-003/A-004；不编造未知 signal/null exit 的成功状态。
- Verification method:
  - V-001；检查无 createRunV2Tool/RunV2 导出。
- Validation evidence: 2026-09-05T16:45，packages/agent 的 Vitest CLI `--run test/harness/bash.test.ts test/harness/tools.test.ts test/agent-loop-tool-error.test.ts`：3 files / 42 tests passed。原 Bash 行为、Run 迁移边界、顺序/并行 Agent 错误 details 传播与普通 Error 隔离通过；Run 源码/导出/context.run 已移除。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — coding-agent Bash 宿主适配与共享渲染

- Status: done
- Owner: coordinator
- Objective: 原生 Bash 委托核心；为 v2 提供同一个定义工厂和 renderer。
- Inputs and prerequisites: T-001 合同和单测通过；原生 Bash/OutputAccumulator 与现有回归。
- Scope or files: packages/coding-agent/src/core/tools/bash.ts；必要时工具 index 导出；新增 test/bash-tool-contract.test.ts；必要时 test/tools.test.ts、test/bash-execution-width.test.ts。
- Expected output: 共享核心编排；BashOperations/raw-byte capture 与 ExecutionEnv 两种必要 transport；单一渲染支持 cwd/状态/完整输出路径。
- Dependencies: T-001.
- Execution steps:
  1. 复用核心 Bash 参数/类型/execute，保留 createLocalBashOperations、spawnHook、commandPrefix、session env。
  2. BashOperations 增加可选真实 signal metadata；未知退出不得映射为 0；原始字节捕获继续用 OutputAccumulator。
  3. 支持 host-owned ExecutionEnv 注入，供 v2 复用；动态 prefix 通过已有 hook 接线。
  4. renderer 覆盖 cwd、最新折叠输出、silent elapsed、错误状态与日志提示去重；执行 V-002。
- Acceptance criteria:
  - A-002/A-003/A-004/A-005；不得丢失 UTF-8 字节、扩展执行能力或动态环境。
- Verification method:
  - V-002；检查 coding-agent execute 不再自有节流/退出分类分支。
- Validation evidence: 2026-09-05T16:53，coding-agent CLI `--run test/bash-tool-contract.test.ts test/tools.test.ts test/bash-execution-width.test.ts test/bash-close-hang-windows.test.ts`：87 passed / 2 Windows-only skipped。验证 shared schema、cwd、remote Operations/spawnHook、ExecutionEnv、signal/null exit、raw bytes 和既有 UTF-8/输出/扩展行为。V-001 同时重跑 42/42 passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — v2 注册、CLI/SDK 与生产集成迁移

- Status: done
- Owner: coordinator
- Objective: 所有当前生产入口使用统一 Bash，无 Run 影子实现。
- Inputs and prerequisites: T-001/T-002 done；稳定的共享 createBashToolDefinition。
- Scope or files: packages/coding-agent/src/core/{sdk.ts,tools/tool-profile.ts,tools/index.ts}；src/cli/args.ts；test/{tool-profile-v2,tool-execution-component,args,v2-host-adapters}.test.ts；不得编辑本权威文档或冻结 eval 资产。
- Expected output: v2 名单/提示/allowlist/SDK/CLI 全部 bash；独立 Run renderer/bind 分支删除；当前测试迁移。
- Dependencies: T-002.
- Execution steps:
  1. 完整阅读 owned files 后迁移命名、共享 Bash 工厂及 sequential 配置。
  2. 保留设置每次调用生效、ExecutionEnv ownership/workspacePolicy、PI_* 会话环境和其他 v2 三工具逻辑。
  3. 更新生产回归并执行 V-003，结构化回报 coordinator；禁止 self-approve done。
- Acceptance criteria:
  - A-001/A-002/A-005；无 run 别名或双 renderer。
- Verification method:
  - V-003；coordinator 审查 diff 并重跑。
- Validation evidence: coordinator 从源码独立接线，2026-09-05T17:40 主工作区 V-003：4 files / 152 tests passed。包括 shared schema、v2 sequential、两 profile 的真实失败经 SDK Agent tools 保留 details、动态 prefix/PI_*、host-owned remote cwd/policy、extension Bash override 和统一 renderer；未采纳失败子代理候选。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 当前用户文档与迁移边界

- Status: done
- Owner: bash-docs
- Objective: 文档如实解释统一 Bash 与错误合同变更。
- Inputs and prerequisites: T-001/T-002 done；本任务范围和用户命名决策。
- Scope or files: packages/coding-agent/README.md；packages/coding-agent/docs/sdk.md。如其他现行文档需要变更，先报告 coordinator，不改历史任务或 eval artifacts。
- Expected output: search/read/edit/bash 文档；cwd/退出/错误及并行策略；Run API 移除说明；说明历史冻结评测需原 revision，不能直接当成新工具评测。
- Dependencies: T-002.
- Execution steps:
  1. 完整阅读 owned docs，修改当前合同而非全局替换通用动词 run。
  2. 不保证 OS sandbox、后台 PTY、无损未知 metadata 或未经测量的提速。
  3. 回报实际 diff 检查及剩余引用。
- Acceptance criteria:
  - A-001/A-003/A-005；文档不将已移除 Run 正常返回失败的语义继续宣称为 Bash 行为。
- Verification method:
  - V-004；coordinator 内容核对。
- Validation evidence: 2026-09-05T17:37，coordinator 全文核对 README/SDK 与共享核心/host API；仅提取候选 82780a39f9ad4900c1071915497e22aeab4a6413 的两个 owned 路径，git apply --check 后应用，git diff --check 通过。迁移明确区别 Agent core/coding-agent 工厂与历史评测，不承诺沙箱/无损未知信号或提速。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 迁移当前 usage 文档的工具名单

- Status: done
- Owner: coordinator
- Objective: 修正文档委派发现的现行 usage.md Run 名单，避免用户按过期工具名配置。
- Inputs and prerequisites: T-004 文档合同核对完成；usage.md 修改前全文阅读。
- Scope or files: packages/coding-agent/docs/usage.md，仅当前 v2 工具合同。
- Expected output: 现行 usage 工具名单为 search/read/edit/bash；历史设计和 untracked 文档不变。
- Dependencies: T-004.
- Execution steps:
  1. 全文核对 usage.md，将当前 v2 名单迁移到 Bash。
  2. 与 SDK/README/CLI 比对，运行 diff --check。
- Acceptance criteria:
  - A-001；不修改历史评测或设计资料。
- Verification method:
  - V-004 内容核对与 diff --check。
- Validation evidence: 2026-09-05T17:40，仅迁移 usage.md 的当前 v2 名单；全文已读，与 SDK/README/CLI 一致；git diff --check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 保留 opaque BashOperations 路径语义

- Status: done
- Owner: coordinator
- Objective: 防止本机路径规则重写 opaque remote Operations 的 cwd。
- Inputs and prerequisites: T-003 done；reviewer 发现核心无条件 Node absolutePath，已核对 source。
- Scope or files: packages/agent/src/harness/tools/bash.ts；packages/coding-agent/src/core/tools/bash.ts；test/bash-tool-contract.test.ts；docs/sdk.md 必要合同说明。
- Expected output: capture adapter 拥有 cwd 解析/验证；默认本机 transport 仍解析相对 cwd；opaque Operations 不经本机 home/separator 转换。
- Dependencies: T-003.
- Execution steps:
  1. 增加无 spawnHook 的 opaque cwd 回归并证明失败。
  2. 去除核心 capture 分支的无条件路径解析，仅本机默认 transport 在 prepare 中解析。
  3. 执行 V-008 和相关 Bash/profile 回归。
- Acceptance criteria:
  - A-004；不添加新的模型参数或第二执行协议。
- Verification method:
  - V-008；V-001/V-002/V-003。
- Validation evidence: 17:59 新增 opaque cwd 三项先失败，证实 home/relative cwd 被本机展开；修正 capture 路径 ownership 并增加本机 absolute/relative 绑定对照。18:00 coding-agent 的 bash-tool-contract/tools/tool-profile-v2/v2-host-adapters/tool-execution-component 五文件 152 passed；Agent V-001 42 passed。Windows 尚未实机运行。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — durable Harness 的显式错误 details 传播

- Status: done
- Owner: coordinator
- Objective: 补齐 server/durable AgentHarness 对共享 Bash 错误 details 的消费，普通 Error 保持隔离。
- Inputs and prerequisites: T-007 done，核心 Bash 合同稳定；agent-harness.ts 与 gateway 测试全文阅读；server/create-harness.ts 确认生产使用 core Bash。
- Scope or files: packages/agent/src/harness/agent-harness.ts；packages/agent/test/harness/agent-harness-tool-gateway.test.ts；packages/coding-agent/docs/sdk.md。
- Expected output: 仅 AgentToolError.details 经现有 strict-JSON normalization 持久化；真实 Bash 非零退出和 ordinary Error isolation 回归。
- Dependencies: T-007.
- Execution steps:
  1. 先运行新增 explicit/ordinary/Bash durable-message 回归验证缺口。
  2. executeToolCall catch 仅对 AgentToolError 保留 details，不改变 retry/timeout/replay 协议。
  3. 执行 V-009 与 server create-harness consumer 回归，核对 docs。
- Acceptance criteria:
  - A-003/A-005；cause/internal fields 不传播；Bash replay never 不变。
- Verification method:
  - V-009。
- Validation evidence: 18:08 durable gateway 新回归先 2 failed/7 passed（explicit/Bash details 均为 {}）；仅修改 catch 的 AgentToolError 类型判断后 gateway/run/faults/agent-loop/node-process-executor 五文件 53 passed，server/create-harness 与六项 host 依赖文件共 39 passed；ordinary Error 不暴露任意 details/cause，strict-JSON 清除 undefined，Bash replay=never 保持。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 迁移现行 deterministic gate 的 Bash 消费者

- Status: done
- Owner: coordinator
- Objective: 迁移 root typecheck 发现的现行纯本地合成场景回归，不修改冻结真实评测。
- Inputs and prerequisites: T-008 done；test/tool-profile-eval/README.md:31 明确 full-requirement-evidence.test.ts 是 current deterministic gate，区别于 frozen real/held-out executors；该测试全文已读。
- Scope or files: packages/coding-agent/test/tool-profile-eval/full-requirement-evidence.test.ts：scenario-16 的 Bash 名称、抛错合同和 error count；用户另行确认迁移 scenario-1 的旧字节比较为正确 locator、完整 preview 与显式 maxOutputBytes 的验收，真实统计不改。
- Expected output: 同一 syntax-failure-recovery 合成 fixture 使用 Bash，仍验证失败→Read/Edit→通过；保留 16 场景 oracle/指标算法及所有冻结 manifest/results/real evaluator 源码。
- Dependencies: T-008.
- Execution steps:
  1. 迁移现行 scenario-16 到 Bash，明确验证 AgentToolError；错误输出仍计入指标，toolErrors 如实增加 1。
  2. 定向运行此 deterministic test；无 provider/embedding 调用，不写旧 RESULTS/JSON。
- Acceptance criteria:
  - A-001/A-003/A-006；不得用别名、类型扩大、ts-ignore 或排除测试掩盖不存在的 Run API。
- Verification method:
  - V-010 与 V-006。
- Validation evidence: 18:15/18:17 V-010 在旧字节断言失败（306 < 246）。用户确认迁移后，scenario-1 显式 maxOutputBytes=1024，断言 complete、正确 production locator/line、每个完整 preview 及其模型可见文本、返回字节不超预算；两变体真实字节继续计量。18:25 V-010 1/1 test passed，含 16/16 场景；18:28 root npm run check 再次全部通过且 No fixes applied。scenario-16 验证 Bash 确实抛 AgentToolError 并计入真实错误数；冻结资产不变。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 依赖路径回归、所有权核验与提交

- Status: done
- Owner: coordinator
- Objective: 验证整体合同、集成 subagent 结果并提交。
- Inputs and prerequisites: T-003/T-004/T-006/T-009 done；当前 diffs 与基线。
- Scope or files: 本任务所有修改；本权威文档；LEARNS.md 中仅记录已通过回归证明的 opaque cwd/dual gateway 教训；显式 git stage/commit。
- Expected output: 本地验证证据、无未解决任务、task-owned commits。
- Dependencies: T-003, T-004, T-006, T-009.
- Execution steps:
  1. 审查错误传播、未知 signal、abort 与 stdout 生命周期，补充必要依赖回归。
  2. 跑 V-001/V-002/V-003/V-005，确认当前生产无残余 Run；不改冻结 eval 的旧合同。
  3. 跑 V-006 后立即核对改动范围；更新权威文档、跑 V-007、只提交任务路径并核验。
- Acceptance criteria:
  - A-001 至 A-006，不能以子代理报告替代检查。
- Verification method:
  - V-001 至 V-007，git diff/status 与提交清单。
- Validation evidence: 最终相关测试累计 378 unique passed / 2 Windows-only skipped（Agent 8 files/95；coding-agent 15 passed files/283，其中 deterministic test 含 16 场景）。18:28 root npm run check 完整通过、No fixes applied；18:31 git diff --check、staged diff --check 和任务 validator 通过。源码无生产 Run 实现/导出/注册，仅保留冻结合同及迁移说明引用；两条 reviewer 发现已有先失败后通过证据。LEARNS 新增两条已验证教训，未改旧条目。18:32 显式提交 1ecb3ee8439e702cdd7812a7ed99520584753b4b，git show --name-status 核对仅包含任务实现/测试/当前文档/LEARNS；提交后 tracked/index 无残余修改，既有无关 untracked 保留。eval 目录仅现行 full-requirement-evidence.test.ts 改动，冻结资产不变。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

Vitest 从指定 package root 使用 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run ...`；不跑全套 Vitest/npm test/build、付费 API 或历史 held-out。

- V-001（agent）：test/harness/bash.test.ts、test/harness/tools.test.ts、test/agent-loop-tool-error.test.ts。
- V-002（coding-agent）：test/bash-tool-contract.test.ts、test/tools.test.ts、test/bash-execution-width.test.ts、test/bash-close-hang-windows.test.ts。
- V-003（coding-agent）：test/tool-profile-v2.test.ts、test/tool-execution-component.test.ts、test/args.test.ts、test/v2-host-adapters.test.ts。
- V-004：owned docs 与真实 API 逐项核对；git diff --check。
- V-005（agent）：test/agent-loop.test.ts、test/harness/node-process-executor.test.ts、test/harness/agent-harness-run.test.ts、test/harness/agent-harness-faults.test.ts；（coding-agent）：test/default-tools-setting.test.ts、test/tool-system-prompt-contributions.test.ts、test/experimental-tool-strict-mode.test.ts、test/suite/agent-session-bash-persistence.test.ts、test/suite/regressions/5208-late-bash-output.test.ts、test/suite/regressions/5303-bash-output-truncation.test.ts。
- V-008（coding-agent）：test/bash-tool-contract.test.ts，opaque cwd 与本机 relative cwd 对照。
- V-009（agent）：test/harness/agent-harness-tool-gateway.test.ts；（coding-agent）test/server/create-harness.test.ts。
- V-010（coding-agent）：test/tool-profile-eval/full-requirement-evidence.test.ts，现行纯本地 synthetic gate，不是 frozen real/held-out 执行器。
- V-006（repo root）：npm run check，完整输出；立即 git diff --stat / git status --short 检查 biome --write 范围。
- V-007：`python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-09-05-unified-bash-tool-task.md`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 原生 BashOperations 可代表远程宿主，不能强行用本机路径存在性代替远程检查。
- Agent loop 的结构化错误只接受明确类型，不盲目传播任意错误对象可能带有的内部信息。
- shared 捕获 seam 是保留原始字节/远程宿主所需，不是新增第二个工具协议；不能退化成只改 Run 的名字。
- 旧 v2 对失败返回正常 result 的行为改为统一 Bash 的 tool error；必须同时验证模型可见消息和 SDK details。
- 当前 workspace /Users/w/Projects/easy-pi 不是 git root。subagent 使用隔离 mirror 中的 pi 子仓库路径，candidate 需 coordinator 只提取 owned files，先 git apply --check。
- LEARNS 提醒 npm run check 可写其他文件；禁止 reset/clean/stash、全量 stage 或覆盖其他 session。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-05T16:02+08:00：确认授权、基线、instructions 和无关 untracked；开始 bounded references/consumer 检查。
- 2026-09-05T16:20+08:00：确认三份命令编排、两类捕获 transport 及 Agent loop 丢失错误 details。合同决策：保留 Bash tool-error 语义，以明确错误类型补结构化传播，不改变所有普通 Error。
- 2026-09-05T16:20+08:00：创建并立即填写本次唯一任务文档；T-001 → in_progress，owner coordinator；T-001/T-002 因共享 schema/capture API 串行，之后生产接线与 docs 才并行。
- 2026-09-05T16:45+08:00：T-001 首轮测试因误用不存在的 env.resolvePath 失败（17 failed，两个异步 fixture 等待入口导致超时）；查证 ExecutionEnv 方法为 absolutePath，只修正该调用并让 fixture 入口等待与 execution race，避免早期拒绝被掩盖。V-001 重跑 42/42 passed，T-001 → done。T-002 → in_progress，owner coordinator，下一步将 native Bash 委托核心并保留 byte capture。
- 2026-09-05T16:53+08:00：T-002 首跑发现一条旧测试期待 success details=undefined（按新结构化合同更新），一条 opaque Operations 的 timeout:5 未携带 input.timeout，修正 adapter 保留其实际 timeout 文案并避免 undefined 秒。V-002 重跑 87 passed / 2 Windows-only skipped，V-001 重跑 42 passed。T-002 → done；定向 Biome 只格式化十个指定任务文件。
- 2026-09-05T16:54+08:00：T-003/T-004 → in_progress，owner bash-integration/bash-docs；API 已可用：coding-agent createBashToolDefinition(cwd, {executionEnv, workspacePolicy, spawnHook}) 委托共享核心；动态 prefix 用 spawnHook，v2 用 definition.executionMode=sequential。准备一次并行 DAG，coordinator 独占权威文档。

- 2026-09-05T17:25+08:00：恢复核对 HEAD/status 无漂移。并行 run 7c54f4de-bf66-46ff-a10f-6379f40fe914 已结束：bash-integration 启动后因 snapshot 无 Vitest 依赖，inconclusive 候选被拒绝；bash-docs 候选被接受但未应用。不以报告标 done。限界核对 mirror refs/worktree：仅 docs ref，无 integration 候选或残留 worktree；停止恢复，T-003 owner 改 coordinator，在 live 有依赖环境独立完成同一授权任务。新增 T-006 处理文档委派发现的现行 usage.md 名单，保留历史/untracked 文档。

- 2026-09-05T17:37+08:00：T-004 文档候选独立核对并应用，V-004 diff --check 通过，T-004 → done；T-006 → in_progress，coordinator 已读全文，下一步仅改名单。T-003 已独立完成生产接线；V-003 首跑 137 passed / 10 failed：7 项旧 Run 名称/输出/初始更新合同待迁移，另 3 项 Read/Edit/Search renderer fixtures 与 HEAD 的现有 renderer 不符（已核对 HEAD 原文）。仅修正同一测试文件中的过期 fixtures 以恢复真实回归门，不修改三个工具语义。

- 2026-09-05T17:41+08:00：V-003 live 152/152 passed，T-003 → done；当前文档名单一致，T-006 → done。T-005 → in_progress，coordinator 下一步审查最终 diff、补跑 Agent/host 依赖路径与 root check，全部通过才显式 stage/commit。

- 2026-09-05T17:50+08:00：只读 reviewer run 252ff80f-09b2-42d6-a4d8-ac412be0f654 实际运行并拒绝批准，提出两项可行动发现：opaque Operations cwd 被本机路径规则改写；server 使用的 durable AgentHarness catch 仍丢失 AgentToolError.details。coordinator 已核对两条生产路径；新增 T-007/T-008，不将 review 拒绝误称工具未启动。T-007 → in_progress，T-005 保持最终审查中，提交门等待两项纠正和重验。

- 2026-09-05T18:01+08:00：T-007 的新回归先 3 failed/9 passed，修正 core capture cwd 与仅本机 prepare 路径解析后 Agent 42/42、coding-agent 五文件 152/152 passed，T-007 → done。T-008 → in_progress，已全文检查 durable Harness/source gateway tests，下一步补充并验证真实 Bash/显式错误的 durable-message 回归。

- 2026-09-05T18:09+08:00：T-008 新回归确认真实 durable details 缺口（2 failed/7 passed），最小 explicit 类型判断修正后 V-009/V-005：Agent 五文件 53 passed；coding-agent 七文件 39 passed。T-008 → done。reviewer 两项发现均有 coordinator 的先失败后通过证据；T-005 下一步 root npm run check、全 task-owned 定向回归及显式提交。

- 2026-09-05T18:10+08:00：首次 root check 的 Biome 仅格式化 owned gateway 测试；pinned deps/import/shrinkwrap/install-lock 通过，tsgo 报 7 diagnostics：nullable signal、测试 Result/参数推断、heterogeneous registry renderer 类型，以及现行 deterministic gate 的 .run 消费者。修复前四类边界类型，不改依赖/tsconfig。进一步全文查证 full-requirement-evidence.test.ts 是 README 明确维护的本地 deterministic gate，不是冻结 real/held-out 资产；新增 T-009 → in_progress，只迁移 Bash 场景与实际 error count，保留场景 oracle、指标算法、冻结 manifests/results/real sources。

- 2026-09-05T18:18+08:00：第二次 root npm run check 全部通过，Biome 只格式化 owned deterministic test，范围无新增无关变更。最终定向回归 377 unique passed / 1 failed / 2 Windows skipped。V-010 失败点为未修改的旧 Search 字节比较 306 < 246，16 场景断言已通过但该测试总体未通过；不为过门擅自放宽。T-009/T-005 → blocked，下一步向用户确认此验收合同迁移，不提交，不改冻结真实评测/历史结果。

- 2026-09-05T18:21+08:00：用户在 search_byte_gate 明确选择“迁移验收标准（推荐）”：定位正确、预览完整且输出有界；继续真实字节统计，历史评测不变且不宣称提速。T-009/T-005 blocked → in_progress；无需修改 Search 产品实现。最终检查同时记录本轮已验证的 opaque cwd 和两种 Agent gateway 传播教训。

- 2026-09-05T18:28+08:00：按用户确认迁移旧字节门后 V-010 1/1 passed（16/16 场景），T-009 → done。root npm run check 全部通过且不改写文件；最终唯一测试累计 378 passed/2 Windows-only skipped，未修改 Search 产品实现、冻结 manifests/results/真实执行器或既有 untracked 用户文档。两条已验证教训追加到 LEARNS 并读回核对。T-005 下一步仅显式 stage/commit 和提交清单核验。

- 2026-09-05T18:32+08:00：恢复核对 HEAD/status 无漂移，任务 validator、unstaged/staged diff --check 通过；显式 stage 后逐项核对所有权，以 1ecb3ee8439e702cdd7812a7ed99520584753b4b 提交实现、测试、当前文档和 LEARNS。提交清单与授权范围一致，提交后 tracked/index 无残余修改，既有无关 untracked 原样保留。T-005 → done；本权威文档单独收尾提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-009 全部 done，无 blocked；root npm run check、diff check、任务 validator 通过；378 unique tests passed / 2 Windows-only skipped。Bash 合并与两条 reviewer 发现已验证纠正，用户批准的旧 Search 验收迁移通过；实现提交 1ecb3ee8439e702cdd7812a7ed99520584753b4b 已核验范围及残余状态。
- Limitations: Windows 未实机运行。没有付费/真实模型/held-out 重跑，冻结 manifests/results/真实执行器不变；不宣称名称或合并的性能收益。既有无关 untracked 文件保留，不声称整个工作树为空。
