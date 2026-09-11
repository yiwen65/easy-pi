# Task Plan: Subagent 委派语义与请求前缀整改

- Created: 2026-09-10
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户确认完整整改、新调用强制显式契约，并确认串行实施与本地 rebuild。

<!-- task-doc-section:background-goal -->
## Background and goal

让原生 Subagent 的任务、上下文、能力、结果边界可执行、可验证；兼容条件下保留请求前缀，而不是为了缓存混用传输身份。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含 Continue/Explore/Verify/Extract、显式 isolated/fork/curated、身份与当前任务边界、能力收窄、自动结构化结果及原文保留、回归测试、文档、本地 rebuild。
新调用缺失新契约报错，不保留旧调用兼容层；保留旧历史读取和显式恢复。六工具、共享 cwd、独立 session、运行时权限保留。
不改旧 DAG/worktree 恢复源、不增加强制编排/审核、不删历史、不发布、不自动提交、不重启当前会话、不再委派实现。历史磁盘预算及物理清理不属于此任务。
禁止修改/运行/恢复 packages/coding-agent/test/tool-profile-eval/**；保留既有 /tmp/pi-unified-real-eval-cT7D0V、/tmp/pi-v2-attribution-FhvQ0M 和 .git/easy-pi-migration-baseline/pre-codex-replacement.tar。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 六工具当前仅自由文本任务，fork_turns 省略默认 all | packages/subagent/src/collaboration-contract.ts |
| F-002 | 子会话以 checkpoint 继承 messages，system 在 before_agent_start 注入路径 | packages/coding-agent/src/extensions/pi-child-session-host.ts、pi-collaboration-tools.ts |
| F-003 | 控制器负责持久化、执行额度、邮箱，宿主负责 native lifecycle | packages/subagent/src/collaboration-controller.ts、session-host.ts |
| F-004 | 用户允许新调用破坏性升级，但要求历史保留、离线验证和本地 rebuild | 本轮确认的实施约定 |
| F-005 | 缓存实验不能建立 session-id 严格隔离规则，也未验证共享头并发安全 | /var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/epi-cache-header-matrix-uXfOys/conclusion.md |
| F-006 | 初始工作树含旧 subagent 源和 lockfile 等无关修改，必须保留 | 实施前 git status --short |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 具体 schema 与宿主适配结构由代码证据决定；优先复用现有边界，不新增模型总结器。
- Open question: 无阻塞用户决策。供应商缓存行为未知，不作为功能验收条件。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新委派必须显式提供任务与上下文策略，拒绝旧式缺失契约调用；后续任务同样明确。
- 明确历史背景、自身/创建父级/发送者和自动结果目的地；不把消息作为权限。
- 上下文遵守隔离、证据来源和完整工具配对；兼容条件下保持 system/tools/messages 前缀，不静默降级。
- 子权限不超过祖先实时权限和委派限制；受限工具在执行边界阻止，不能以隐藏工具代替限制。
- 自动返回结构化任务结果的验证状态，不丢弃不合格原文、不自动重跑；执行完成不等于验收。
- 旧历史可读、显式恢复路径可用；当前会话不受重启影响。
- 针对性回归、根 check、本地 coding-agent build 和编译产物 smoke 有真实证据。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-005 -> T-004.
- Parallel batches: 无；用户明确串行实施。
- Serialization constraints: schema、控制器、宿主及工具共享契约，依次集成；只有协调者编辑本文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 委派与结果契约

- Status: done
- Owner: coordinator
- Objective: 定义可校验的新任务、上下文、能力和结果 schema。
- Inputs and prerequisites: 已确认实施约定与现有原生契约。
- Scope or files: packages/subagent/src/collaboration-contract.ts、session-host.ts 及针对性测试。
- Expected output: 显式新调用 schema、共享校验器、结果解析和边界语义。
- Dependencies: None.
- Execution steps:
  1. 核对调用方和恢复数据结构，定义新契约与证据边界。
  2. 实现契约及测试，不混入旧实现清理。
- Acceptance criteria:
  - 拒绝缺失契约、非法关系/上下文组合、越界或超额数据；保留结果原文。
- Verification method:
  - 针对性 contract tests 和类型检查。
- Validation evidence: packages/subagent 下 node ../../node_modules/vitest/dist/cli.js --run test/delegation-contract.test.ts test/collaboration-contract.test.ts test/collaboration-controller.test.ts：3 文件 52 项通过；根 npm run check 通过（2026-09-10）。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 持久化委派与运行时能力边界

- Status: done
- Owner: coordinator
- Objective: 将任务、能力与结果接入控制器和恢复生命周期。
- Inputs and prerequisites: T-001 新契约。
- Scope or files: 原生 collaboration-controller/store/session-host 与对应测试。
- Expected output: 持久化委派、祖先权限交集、后续任务与结果验证状态。
- Dependencies: T-001.
- Execution steps:
  1. 接入新建/后续任务和持久化加载。
  2. 覆盖嵌套、权限收窄、冷加载、旧历史恢复及结果回传。
- Acceptance criteria:
  - 不扩大能力；自动回传目的地明确；旧历史可读且无自动执行。
- Verification method:
  - controller/store 单元和集成测试。
- Validation evidence: 2026-09-10 subagent contract/delegation/controller 3 文件 55 项通过，包含祖先实时工具撤回、不可扩权、持久化结果格式状态、创建父级与后续发送者分离及冷读取不重放；原有 dead-owner/旧 snapshot 恢复回归仍通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 原生工具、上下文与前缀接线

- Status: done
- Owner: coordinator
- Objective: 将显式上下文和身份中立前缀接入真正的 Pi 请求路径。
- Inputs and prerequisites: T-002 控制器契约。
- Scope or files: packages/coding-agent/src/extensions/pi-*-session-host.ts、pi-collaboration-tools.ts 及必要 SDK seam、测试。
- Expected output: isolated/fork/curated 实现、能力执行门、前缀兼容检查及上下文观测。
- Dependencies: T-002.
- Execution steps:
  1. 读取 SDK/extensions 文档与实际系统/工具/上下文构造路径。
  2. 实现证据装配、前缀保持和身份/任务接线。
  3. 用 faux 验证实际请求和工具执行边界。
- Acceptance criteria:
  - 兼容前缀不漂移，不兼容显式拒绝；任务与背景分开，独立 session。
- Verification method:
  - coding-agent 原生宿主/工具/权限/上下文针对性测试。
- Validation evidence: 2026-09-10 coding-agent 9 文件 68 项、subagent 5 文件 63 项通过（命令见执行日志）；实际父子 canonical request 前缀断言、规则/checkpoint 不兼容零子调用、curated 完整接线、宿主重新广告受限工具仍被阻止、cold followup 能力保留、结果截断原文保留及 Grok 入口均有覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验收、文档与本地构建

- Status: done
- Owner: coordinator
- Objective: 验证完整链路并重建本地产物。
- Inputs and prerequisites: T-003 集成代码。
- Scope or files: collaboration 文档、编译产物 smoke、相关测试和本任务文档。
- Expected output: 更新用法、迁移边界和通过的本地构建。
- Dependencies: T-003, T-005.
- Execution steps:
  1. 对抗性检查新旧恢复、权限、结果截断、前缀及错误路径。
  2. 跑针对性测试、npm run check、已授权 coding-agent build、产物 smoke。
  3. 核对工作树差异和保护文件，记录限制。
- Acceptance criteria:
  - 所有必需测试和产物验收通过，未改无关文件、不声称缓存保证。
- Verification method:
  - 针对性 vitest、npm run check、npm run build --workspace=packages/coding-agent、node scripts/check-native-subagent-product.mjs、任务文档校验。
- Validation evidence: 2026-09-10 最终根 npm run check、coding-agent workspace build（含 assets）、编译 native spawn/新 schema 旧调用拒绝/结果状态/六工具/retired exports/CLI/npm pack inventories smoke 全部通过；构建后重跑 14 文件 133 项通过；git diff --check 通过。installed pi realpath 为本仓库 packages/coding-agent/dist/cli.js。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 卸载与启动失败时的权限生命周期

- Status: done
- Owner: coordinator
- Objective: 防止 LRU 卸载丢失实时收窄，清理失败启动留下的 native authority binding。
- Inputs and prerequisites: T-003 接线后的对抗性检查与失败回归。
- Scope or files: collaboration-controller.ts、pi-child-session-host.ts 及两个现有针对性测试文件。
- Expected output: 卸载前持久化更窄的工具上限；启动失败发送 child shutdown 以释放绑定，不自动重跑。
- Dependencies: T-003.
- Execution steps:
  1. 用回归证明 detach 后后代错误恢复 bash 能力。
  2. 持久化权限交集并验证重开 store 后仍保留。
  3. 验证失败启动后可通过显式契约 followup 执行，且无遗留绑定。
- Acceptance criteria:
  - 卸载和恢复不扩权；失败启动不阻塞显式后续任务；不新增自动重试或历史删除。
- Verification method:
  - controller 的卸载回归、native tools 启动失败回归及完整针对性测试。
- Validation evidence: 2026-09-10 失败的卸载回归修正后通过；subagent 原定 5 文件 64 项、coding-agent 原定 9 文件 69 项全部通过，包含跨 store reopen 持久化收窄和 startup failure 后显式 followup。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

仅运行明确列出的原生 contract/controller/store/context-fork 和 coding-agent child-host/collaboration 测试；不得触发冻结的 tool-profile-eval。使用 faux，不调用真实供应商。修改测试必须运行。根 check 可能自动格式化，之后核对 diff，保留无关改动。构建只在集成后执行。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 前缀不是缓存保证；系统/工具/模型不兼容必须显式处理。
- 共享 cwd 不是沙箱，bash 可写入，必须在运行时禁用不被授权的能力；不承诺通用文件系统隔离。
- 旧历史可能没有新委派元数据，必须保留并在新执行前建立明确边界。
- 当前进程仍运行旧内存代码；rebuild 只影响新调用进程。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10: 用户确认完整范围、显式新契约及实施约定；开始串行 T-001，已读取核心契约/控制器/宿主/工具源并核对工作树。
- 2026-09-10: T-001 完成 schema、UTF-8/关系/证据范围/结果校验测试和根 check；T-002 in_progress，控制器/store/host 初步接线。为保持可编译已同步新工具参数与旧回归夹具，T-003 专项验收仍待 T-002 完成。
- 2026-09-10: 原生 coding-agent host/tools 2 文件 22 项通过；check 首次发现 AgentSession 无 cwd getter，改用公开 sessionManager.getCwd 后根 check 通过。下一步补持久化能力、prefix/curated 和 operator 契约回归。
- 2026-09-10: T-002 完成并通过 55 项控制面回归；T-003 in_progress。host/tools 新增真实请求前缀一致性、隔离 reviewer、运行中 root 撤权及 curated hash/读取门测试，2 文件 27 项通过；Grok panel/实际 host 2 文件 12 项通过。正在补 checkpoint 漂移、child-only 规则冲突和扩展重新启用受限工具的反例。

- 2026-09-10: T-003 完成，T-004 in_progress。subagent 命令：node ../../node_modules/vitest/dist/cli.js --run test/collaboration-contract.test.ts test/delegation-contract.test.ts test/collaboration-controller.test.ts test/collaboration-mailbox.test.ts test/context-fork.test.ts，5 文件 63 项通过。
- 2026-09-10: coding-agent 命令：node ../../node_modules/vitest/dist/cli.js --run test/pi-collaboration-tools.test.ts test/pi-child-session-host.test.ts test/grok-agents-panel.test.ts test/grok-agents-host.test.ts test/easy-pi-default-composition.test.ts test/easy-pi-data-isolation.test.ts test/easy-pi-harness.test.ts test/easy-pi-questionnaire.test.ts test/easy-pi-startup-header.test.ts，9 文件 68 项通过。
- 2026-09-10: 专项测试第一次错误假定 setActiveTools 可以突破 SDK 初始 allowlist；实际先被 SDK 挡住。改为公开宿主 state seam 明确重新广告工具，验证真正执行门仍阻止，未为测试放宽产品限制。check 另发现目标 lib 不支持 findLast，改用已支持的 reverse/find，未改编译目标。

- 2026-09-10: 首次 npm run check、npm run build --workspace=packages/coding-agent、node scripts/check-native-subagent-product.mjs 全部通过。随后卸载权限反例 test/collaboration-controller.test.ts -t 'unloading a narrowed ancestor' 实际失败：detach 前 bash=false，detach 后错误变为 true；新增 T-005 收窄持久化及失败启动绑定清理，T-004 等待其验证后重新构建。

- 2026-09-10: T-005 完成，卸载前持久化更窄 ceiling，失败 child bind 路径触发 shutdown 清理。14 文件 133 项全部通过；LEARNS.md 新增已证实的权限卸载经验，保留无关条目。原 rollback tar SHA256 仍为 2ed18755bd073b520183f2049a20d73d557ab6e24477d60915c33eb04cda87ab。

- 2026-09-10: T-004 完成；最终 check/build/编译 smoke 全部通过，构建后指定 subagent 5 文件 64 项、coding-agent 9 文件 69 项再次通过（21:22）；git diff --check 通过，installed pi 指向本仓库新 dist。所有变更保留为未提交工作树；文档为本轮唯一状态来源。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-005 全部完成；14 文件 133 项、根 check、授权本地 build、编译产物与 npm pack inventory smoke、diff 和任务文档校验通过。原始 rollback tar 哈希不变；未改冻结测试或旧实现恢复源，未删除真实历史，未自动提交。
- Limitations: 本轮仅 faux/离线验收，不证明真实模型任务遵循、供应商缓存收益、跨平台 OS 沙箱或独立分发安装。前缀保证限兼容 canonical 请求且不支持 payload-transforming hooks；curated 限本地 builtin-read 下的 hash-pinned 文本。当前会话未重启，已运行进程不热替换。历史预算 T-006 和最终物理退休/分发 T-007 仍不在本轮范围。
