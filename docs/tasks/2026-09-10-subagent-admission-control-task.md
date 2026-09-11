# Task Plan: Subagent 准入、调度与诊断优化

- Created: 2026-09-10
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户在四项架构审查后明确要求“执行优化”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复后续任务失败时的混合状态、冷加载阻塞全队控制，降低权限检查重复解析邮箱的成本，并提供安全可操作的拒绝原因。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

只改原生 controller/store/host/contract、相关工具与操作员入口、回归和协作文档。保留六工具、显式契约、共享 cwd、独立身份、祖先实时权限、完成通知及显式恢复。
串行实施，不委派、不自动提交、不发布、不重启当前会话、不调用真实模型。初始阶段未新增 build 授权；源代码检查和定向测试不代表已安装 dist 更新。2026-09-11 用户随后明确要求“重新构建”，追加本地产物构建和离线冒烟授权，仍不重启会话或调用真实模型。
不改旧 DAG/worktree 恢复材料、无关工作树、冻结的 packages/coding-agent/test/tool-profile-eval/**，不删除真实历史或受保护 /tmp 及 rollback tar。历史预算仍在旧任务范围。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | followup 先更新契约，再冷加载，失败留下新契约和旧回执/结果 | collaboration-controller.ts:288–305；审查临时假宿主复现 |
| F-002 | host.create/dispose 在全队序列队列内，阻止其他孩子中断 | collaboration-controller.ts:387–406；受控加载阻塞探针 |
| F-003 | toolAllowed 重复 decode/validate/clone 整份 SQLite snapshot | collaboration-controller.ts:182、collaboration-store.ts:287；1 MiB 邮箱下十次查询约90–102 ms |
| F-004 | 工具入口丢弃所有具体拒绝原因，仅暴露错误类别 | pi-collaboration-tools.ts:330–334 |
| F-005 | 上轮实施未提交，另有旧源和 lockfile 等无关变更 | 本轮 git status / diff；/tmp/epi-subagent-optimization-baseline.patch |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 失败准入可记录为完整失败的新回合，但不得把新任务标记为旧任务完成；保持失败 spawn 不自动重跑。
- Assumption: 取消合作式宿主可主动停止；不合作的可信 JS 初始化只能隔离控制队列、保留名额直至安全清理，不能声称强制终止。
- Open question: 无阻塞实现决策。后续本地构建已获授权并完成；真实供应商验收仍未授权。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 失败/取消 followup 后契约、回执、turn、状态和结果一致，恢复不重放。
- 加载/卸载等待不阻塞其他孩子的消息、中断和完成提交；并发预留不超额、不重复执行，不与卸载竞态。
- 取消或 shutdown 后不启动子推理，延迟宿主返回必须清理；保留失败权限绑定清理和卸载收窄。
- 权限热路径不解析邮箱正文；仍检测所有权丢失和实时撤权，外部返回值不能污染缓存。
- 已知拒绝给出固定白名单 reason/hint，未知错误不泄露敏感异常；模型和操作员诊断一致。
- 新回归先观察预期失败，再验证修正；定向离线测试、根 check、diff 和任务文档检查通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-005 -> T-004.
- Parallel batches: 无；共享 controller/contract/tests，沿用用户串行约定。
- Serialization constraints: 协调者依次改共享文件，唯一状态来源为本文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原子准入与可取消的队列外加载

- Status: done
- Owner: coordinator
- Objective: 同时修复混合回合状态和初始化阻塞控制队列，保留名额、权限和恢复不变量。
- Inputs and prerequisites: F-001/F-002 与完整现有 controller/host 测试。
- Scope or files: collaboration-controller.ts、collaboration-contract.ts、session-host.ts、pi-child-session-host.ts、model-runtime.ts 的取消参数及对应测试。
- Expected output: 原子回合预留、队列外加载/卸载、取消及 shutdown 清理。
- Dependencies: None.
- Execution steps:
  1. 持久化审查失败探针为回归并记录失败。
  2. 实现最小准入/加载状态转换，覆盖配额、竞争、恢复与撤权。
- Acceptance criteria:
  - 失败状态不混合；控制操作不等待不相关加载；无取消后推理或扩权。
- Verification method:
  - 定向 controller/host/native tools tests。
- Validation evidence: 2026-09-10 23:26 controller 三条新增回归在旧实现失败；23:34 native startup cancellation 回归旧宿主失败。修正后 subagent 五文件70项、coding-agent host/tools 两文件35项通过（23:35）；含准入名额、排队取消、卸载重入、shutdown late cleanup。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 小型授权视图

- Status: done
- Owner: coordinator
- Objective: 避免工具执行热路径重复解析完整邮箱，保持实时权限。
- Inputs and prerequisites: T-001 的准入与持久化边界。
- Scope or files: collaboration-controller/store 及定向回归、临时基准。
- Expected output: 按持久化版本维护的小型授权数据与活权限交集。
- Dependencies: T-001.
- Execution steps:
  1. 固定合成负载收集基线和机制计数。
  2. 优化读取，验证所有权、CAS、缓存隔离和实时撤权，重测。
- Acceptance criteria:
  - 权限检查不 decode 邮箱，更新立即可见；报告只限组件性能。
- Verification method:
  - controller/store tests 与临时同负载组件基准。
- Validation evidence: 2026-09-10 23:42 回归先失败（11次权限查询触发22次完整read），修正后controller29项通过。三个独立Node24.15.0/Apple M5进程交替A/B：16孩子/256条4KiB正文/每样本10检查，旧版90.610–100.666ms，新版0.097–0.145ms；CPU同向下降，5样本加1次撤权检查的full snapshot read由102降为0。保留所有权检查、外部data_version变化重验证、冻结投影和实时getter。原始样本/tmp/epi-auth-after-{1,2,3}.json；仅组件局部结果，不是端到端速度。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 安全诊断和入口一致性

- Status: done
- Owner: coordinator
- Objective: 具体已知拒绝可纠正，原始异常仍保密。
- Inputs and prerequisites: T-002 的最终控制契约。
- Scope or files: collaboration-contract、pi-collaboration-context/tools/monitor、Grok 错误消费及相关 tests。
- Expected output: 固定 reason/hint 及统一安全格式化。
- Dependencies: T-002.
- Execution steps:
  1. 为不同 context 拒绝、未知敏感异常、操作员错误补回归。
  2. 接入白名单诊断，不改变缺失契约拒绝和无自动回退行为。
- Acceptance criteria:
  - 模型/操作员能分辨关键拒绝，不透传 provider/fs 凭据错误。
- Verification method:
  - contract、native tools、Grok panel 定向测试。
- Validation evidence: 2026-09-10 23:48 四项诊断回归先失败（缺少tools/hash/followup原因与安全hint）。23:54 subagent五文件74项、coding-agent六文件58项通过，含未知敏感异常/非法reason过滤、prefix原因区分与操作员草稿保留；Grok最多四行安全提示，宽度约束回归通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证与文档

- Status: done
- Owner: coordinator
- Objective: 反例审查、最终验证并记录运行时限制。
- Inputs and prerequisites: T-003。
- Scope or files: collaboration.md、本任务文档及必要 LEARNS 已验证经验。
- Expected output: 离线验证证据和准确行为文档。
- Dependencies: T-003, T-005.
- Execution steps:
  1. 检查并发名额、mailbox 预留、取消、卸载撤权与 late startup failure。
  2. 执行定向测试、根 check、diff、任务文档校验，核对无关变更。
- Acceptance criteria:
  - 所有必需回归和检查通过；不以源测试声称 dist 或真实模型验收。
- Verification method:
  - 指定 vitest 文件、npm run check、git diff --check、task_document.py validate。
- Validation evidence: 2026-09-11 00:17 subagent五文件77项、coding-agent六文件58项，以及邻接model-runtime-session-view两项，共12文件137项通过。根check通过且1674个tracked/untracked文件前后哈希无变化（冻结评测子树不读取）；diff和task validator通过。对抗性复查补T-005，文档和单项已验证LEARNS更新。rollback tar SHA256仍为约定值；两个受保护/tmp目录当前ENOENT，本轮未删除，不能证明其原始完整性或判断何时消失。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 准入通知重入时的停止边界

- Status: done
- Owner: coordinator
- Objective: 确认并修正同步状态观察者触发 shutdown/cancel 时，预留注册和首次 run 之间的停止检查。
- Inputs and prerequisites: T-004 反例审查发现的未验证事件顺序；T-003。
- Scope or files: collaboration-controller.ts 与 collaboration-controller.test.ts。
- Expected output: 确定性回归和必要的最小停止检查，不扩大可信扩展隔离边界。
- Dependencies: T-003.
- Execution steps:
  1. 用同步 pending/running 观察者触发停止，检查 host.create/run 是否仍开始。
  2. 仅对复现的缺口修正，并重跑 controller 及集成套件。
- Acceptance criteria:
  - 已停止控制器不创建新宿主，首次推理边界遵守停止/启动取消；无重复执行或清理挂起。
- Verification method:
  - 定向 controller regressions，后续 T-004 全部指定测试。
- Validation evidence: 2026-09-11 00:12 三项 notification 回归旧实现先失败：pending shutdown 后额外一次 create，running shutdown/abort 后仍 run。注册时继承 stopping/failure、首次run前重新检查后 controller 全部32项通过；持久化 interrupted 状态与零意外推理均验证。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

packages/subagent: collaboration-contract、delegation-contract、collaboration-controller、collaboration-mailbox、context-fork；packages/coding-agent: pi-child-session-host、pi-collaboration-tools、grok-agents-panel/host、easy-pi-default-composition/harness。另运行邻接 model-runtime-session-view 两项，确认 provider 注册隔离与共享认证配置未回退。只运行所列离线测试。性能用临时合成 mailbox 测量实际 controller/store，报告时延与 CPU、重复独立进程，不外推模型或终端速度。check 后核对格式化差异。

最终实际命令（分别在指定 cwd 执行）：

```bash
# packages/subagent
PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/collaboration-contract.test.ts test/delegation-contract.test.ts test/collaboration-controller.test.ts test/collaboration-mailbox.test.ts test/context-fork.test.ts
# packages/coding-agent
PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/pi-collaboration-tools.test.ts test/pi-child-session-host.test.ts test/grok-agents-panel.test.ts test/grok-agents-host.test.ts test/easy-pi-default-composition.test.ts test/easy-pi-harness.test.ts
PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/model-runtime-session-view.test.ts
# repository root
npm run check
git diff --check
python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-09-10-subagent-admission-control-task.md
```

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

加载移出队列后必须明确区分执行预留、加载驻留和终结，否则会产生重复加载、超配额或误卸载。取消不是强制终止可信 JS；不合作的宿主不能释放其资源名额后同时启动更多资源。缓存只针对持久化授权投影，不缓存实时允许决定。历史磁盘/缓存命中/分发验收不在本轮。最终只读核查发现 `/tmp/pi-unified-real-eval-cT7D0V` 与 `/tmp/pi-v2-attribution-FhvQ0M` 当前不存在；本轮没有删除或恢复它们，缺失时间/原因未验证，不阻断本轮源码验收，但历史证据完整性不能标记通过。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-10 23:21: 用户授权四项优化；刷新工作树、读取已完成旧 authority 与规则；创建本轮唯一文档，T-001 开始，下一步补确定性失败回归。
- 2026-09-10 23:36: T-001 完成，T-002 开始。失败准入现在记录完整新回合 pending/failed；生命周期独立串行，取消不合作宿主保留名额并在返回后清理。回归曾暴露取消后丢失 sessionFile 指针，已保留验证过的文件引用而不放宽旧断言。任务校验初次误用 package cwd 下相对路径，改用绝对路径通过。下一步保存授权基线、实现小型不可变投影并验证所有权与实时撤权。
- 2026-09-10 23:45: T-002 完成，T-003 开始。根 check 在T-001后通过，仅格式化三个任务内文件。授权投影已通过冷/热读取、stale CAS、外部变更及所有权丢失测试；下一步白名单错误与模型/操作员入口验证。
- 2026-09-10 23:55: T-003 完成，T-004 开始。共享固定错误格式化接入模型/Grok，区分捕获/分支/规则/工具/模型/证据问题；不回显原始异常。下一步对抗性检查最终代码、文档与完整离线验收。

- 2026-09-11 00:06: 恢复后核对最新 check 的范围：相对本轮基线，所有 tracked 非任务差异保持原样；原有 untracked 未留字节基线，不能追溯证明其未被早前 formatter 改写。T-004 审查新增 T-005，先验证同步观察者触发停止的准入边界，再完成文档和最终验收。

- 2026-09-11 00:16: T-005 完成，T-004 继续最终验收。已确认同步通知是重入边界，不是此前视觉焦点事件的根因；补最小停止检查与三条回归。协作文档已补原子准入、独立生命周期、权限投影、安全诊断和未构建限制；LEARNS 仅追加这项已验证的重入经验。

- 2026-09-11 00:19: T-004完成，整体源码验收passed。最终12文件137项、根check（无格式修正）、diff及任务validator均通过；check前后1674文件无变化，随后仅本状态文档改变。只清理本轮临时基准runner/六模块基线副本/核查脚本，保留原始性能JSON和初始tracked diff基线。rollback tar哈希匹配；两处受保护/tmp路径ENOENT，缺失时间原因未知，本轮未删除/恢复，单独记录为历史证据限制。未构建/提交/发布/重启，也未调用真实模型。

- 2026-09-11 00:31: 用户要求“重新构建”后，串行执行 `PI_OFFLINE=1 npm --prefix packages/coding-agent run build`，联合重建 coding-agent/permissions/native subagent 并更新产品内私有包；`PI_OFFLINE=1 node scripts/check-native-subagent-product.mjs` 通过编译产物faux spawn、六工具、退休exports、CLI与两个offline npm pack库存检查。`PI_OFFLINE=1 pi --version` 输出0.84.2，realpath确认全局pi执行当前仓库dist/cli.js，产物含本轮readAuthority、白名单reason和停止重入检查。未重启当前会话；此构建不是电脑发热原因诊断或修复证明。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001至T-005全部done；137项离线定向测试、根check、diff及任务validator通过。源码涵盖四项审查优化和停止重入回归；文档/LEARNS与运行边界一致。授权热路径基准仅报告合成组件结果。
- Build follow-up: 用户追加授权后的本地build、编译产物离线冒烟与实际pi版本检查均通过，已安装dist已更新。
- Limitations: 无真实模型、发布、commit或会话重启；当前已运行进程仍持有旧模块，须由用户重启后加载新产物。发热原因未诊断，构建不代表已解决。未留原有untracked文件初始字节基线，不能追溯证明早前formatter未改写；最终check前后完整核对无变化。两个受保护/tmp路径缺失原因不明，未尝试恢复；rollback tar哈希验证通过。
