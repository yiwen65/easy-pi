# Task Plan: 移植 codemode 并保持工具授权与恢复确定性

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户“继续移植 codemode”；延续已交付 MCP 的 main 迁移。

<!-- task-doc-section:background-goal -->
## Background and goal

从固定 main e37cdc420669e48b4df4bbce0fb2617fc3c71328 移植 codemode，本地 QuickJS 执行模型生成的 JavaScript，编排已授权工具。嵌套执行不能绕过 easy-pi 的实时授权、调度、extension hooks 或 durable recovery。交付可独立安装的本地产物，不发布。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

包含独立 codemode 包、Node worker/wasm、工具与发现 globals、分支 store、描述预算、on/only 模式、SDK/产品/native child 接入、MCP codemode exposure、结构化工具结果及嵌套执行安全。独立包的 portable API 可保持上游实现，但不作云端部署。

不包含 classifier 或上游 ModelRegistry 迁移、models.* 凭据桥接、外部发布、云端部署、真实 provider/MCP 凭据及付费 API。不改其他会话的恢复目标，不削弱现有断言。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户明确授权实施；MCP 已交付 | d22113e47、2088b2962；本轮请求 |
| F-002 | main 固定源 e37cdc420669e48b4df4bbce0fb2617fc3c71328 | upstream 快照 /tmp/easy-pi-codemode-upstream.iXhU3H |
| F-003 | 本轮当前 HEAD 为 2507ea5d7，恢复代码由其他会话新提交 | git log/rev-parse；其恢复行为必须保留 |
| F-004 | 当前仅 collaboration 格式 diff 和另一任务文档未提交 | 本轮 git status；start-current-diff.patch |
| F-005 | 上游用 quickjs-wasi 3.6.2、独立 worker、JSON host RPC | packages/codemode/package.json、README、src/types.ts |
| F-006 | easy-pi 当前执行错误用 AgentToolError，result 无 isError/structuredContent | packages/agent/src/types.ts、agent-loop.ts |
| F-007 | durable dispatch/result 属于父 response occurrence，重试未知副作用受阻 | core/task-recovery.ts；agent-session.ts hooks |
| F-008 | 当前 ModelRuntime 不提供上游 classifier/model-type API | model runtime 接口与上游 execute.ts 对照 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: codemode 是 MCP 后续的本地工具编排交付，不连带移植另一套 AI runtime；文档明确 models.* 暂未提供。
- Assumption: Bun 未安装，Node worker 是可运行验证目标；Bun 打包路径保持正确配置但限制据实报告。
- Open question: 无阻塞产品决策。具体嵌套 journal 实现由 T-003 验证；不允许仅用 UI 元数据代替 durable intent。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 本地脚本可编排已授权 direct/codemode/deferred 工具，不能调用 hidden/model-only、自身、未授权或撤权工具。
- 嵌套调用通过 schema、hooks、宿主 admission 和调度，live ancestor/root 权限不被绕过。
- 派发前 durable intent 与原父任务绑定；嵌套 unknown、未等待调用及取消不会被脚本 catch 或成功结果掩盖；禁止恢复时自动重跑副作用。
- store 仅成功且结果确定后落盘，并按当前 branch 恢复。模式 only 只改变声明，不扩权或显式停用工具。
- MCP 结构化结果、发现描述、预算截断与安全默认保持正确。
- 定向单元/集成/MCP 回归、全仓 check、本地 offline build、包外 Node smoke 通过；只提交本任务内容。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002,T-003,T-004,T-005,T-008；T-003 -> T-009；T-002～T-005,T-008,T-009 -> T-006 -> T-007。
- Parallel batches: T-002 独立 sandbox 包；T-003 核心调用/恢复与 loadout；T-004 extension；T-005 coordinator 产品/配置/MCP/打包。
- Serialization constraints: coordinator 独占 task doc、settings、manifest/locks、MCP 和产品/native child 入口。T-003 独占 agent/ai types、session、extension API/runner/wrappers。T-004 仅 codemode extension 新目录和独立 tests。安装与格式化在相关写入稳定后由 coordinator 执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 核对源与安全接口

- Status: done
- Owner: coordinator
- Objective: 明确源、当前漂移与边界。
- Inputs and prerequisites: 用户请求、MCP 交付。
- Scope or files: upstream 快照、当前 agent/session/recovery、说明文档。
- Expected output: 本执行契约及所有权。
- Dependencies: None.
- Execution steps:
  1. 只读检查上游与当前接口，保存 dirty 基线。
- Acceptance criteria:
  - 固定来源并明确权限与未知结果约束。
- Verification method:
  - git rev-parse/status、源码接口检查。
- Validation evidence: 已观察 e37cdc420 main、2507ea5d7 HEAD、start-current-diff.patch；已读关键 execute/types/dispatch/result 实现。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 导入独立 QuickJS sandbox 包

- Status: done
- Owner: codemode-package
- Objective: 保持上游 sandbox 与 API，适配本仓规则。
- Inputs and prerequisites: 固定 upstream 快照、0.84.2 内部版本。
- Scope or files: packages/codemode/**。
- Expected output: worker/wasm package 与定向测试。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取包并适配 imports、版本、依赖与必要类型。
  2. 验证沙箱隔离、取消、输出/store 限额与 portable APIs。
- Acceptance criteria:
  - targeted tests 通过；无 Node/network globals 泄漏。
- Verification method:
  - 指定包 test 文件，禁用真实 API。
- Validation evidence: child 5 文件/181 tests、tsc build、pack dry-run、compiled Node worker smoke 均通过。coordinator 检查 package-port.diff（仅版本/docs/prototype-like store 键修复与新增回归），独立复跑 execution.test.ts/source.test.ts：2 文件/6 tests 通过。包外产品安装属于 T-007，不计作本任务既有证据。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 核心嵌套执行与恢复/loadout

- Status: done
- Owner: codemode-core（实施）；coordinator（最终接管与验收）
- Objective: 提供安全嵌套 dispatch seam、durable record 和 loadout。
- Inputs and prerequisites: 当前已提交 recovery、上游 nested runner。
- Scope or files: packages/agent/src 与相关 tests；packages/ai/src/types.ts；core/agent-session.ts、task-recovery.ts、extensions/**、tools/tool-definition-wrapper.ts；独立核心 tests。
- Expected output: ExtensionToolContext、AgentToolCallOutcome、结构化结果与 loadout；可验证 unknown/replay 防线。
- Dependencies: T-001.
- Execution steps:
  1. 复用现有 prepare/execute/finalize pipeline，加入 parent identity。
  2. durable nested intent/result 与父任务绑定，确保未知不可掩盖与不能重放。
  3. loadout 区分 active/callable/declared，严格 live grant。
- Acceptance criteria:
  - hooks/admission/scheduler/撤权生效，无自死锁；unknown catch、abort、restart 回归通过。
- Verification method:
  - core 定向测试与 faux provider suite。
- Validation evidence: coordinator 检查全部 AgentSession 源码与核心 diff，复跑 nested scope/pipeline、MCP API/result、历史 exposure 5 文件/59 tests 全通过。包括 scheduler/hook revalidation、in-place binding replacement、live metadata/only、unknown catch/result hooks、outer Bash exit 不掩盖 nested unknown、unawaited drain、slash ID collision、restart/no orphan receipts。另有真实 QuickJS+MCP/child tests 验证交叉路径；全仓 tsgo 和 offline build 已通过。实施 child 未形成最终报告，已停止其执行；验收只依 coordinator 实测与源码，不把 child receipt 当完成证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — codemode extension

- Status: done
- Owner: codemode-extension
- Objective: 提供脚本工具、发现、store、预算及 renderer。
- Inputs and prerequisites: 上游 extension；T-003 接口契约；T-002 runtime。
- Scope or files: src/extensions/codemode/**、独立 codemode extension tests。
- Expected output: 本地工具编排，无 models.* runtime 桥接。
- Dependencies: T-001.
- Execution steps:
  1. 适配上游 execute/tool/index/renderer，避免 lazy inline import。
  2. 确定性失败用 AgentToolError，store 仅完整确定后提交。
- Acceptance criteria:
  - 脚本、查找、返回值、输出与 store 回归通过；不直接调用 tool.execute 绕 pipeline。
- Verification method:
  - 独立 extension tests，使用本地假工具。
- Validation evidence: 两个 owned files 合计 27 tests 通过，coordinator 独立组合复跑均通过。检查 execute/tool/output/renderer 对 live catalog、host drain、unknown/store seam、UTF-8/临时文件及 only loadout 的实现。后续全仓/产物验证在 T-006/T-007。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 产品、MCP 与打包接入

- Status: done
- Owner: coordinator；codemode-docs（仅文档）；codemode-mcp-tests（仅新增集成 tests）
- Objective: 接入默认注册、设置、native children 与独立安装。
- Inputs and prerequisites: 上述接口契约与 MCP 交付。
- Scope or files: settings/defaults、config/index、extensions 入口与 pi-child-session-host、MCP adapters；root/package manifests、scripts、locks、docs。
- Expected output: SDK/CLI 可激活 codemode，精确依赖与 worker/wasm 可安装。
- Dependencies: T-001.
- Execution steps:
  1. 接入 on/only 与 inlineBudget、MCP codemode exposure、结构化结果。
  2. 固定 quickjs-wasi、刷新锁、更新 build/pack 并检查 worker/wasm 路径。
  3. 更新文档与 MCP/native child 定向回归。
- Acceptance criteria:
  - 严格名单保持不扩权；构建和 pack fixture 通过。
- Verification method:
  - 配置/MCP/child 定向 tests、pack fixture。
- Validation evidence: 新 codemode/settings/MCP/child 23 项均通过（20 项在初轮、child 4 项最终全部重跑）；extension 27 项通过。MCP config/CLI/result 71 项通过，pack fixture 3/3、bash -n、全仓 tsgo 和 npm run build:offline 均通过。检查并保存 standalone/LICENSES 与 binary notices；独立安装/最终源码再构建属于 T-007。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 对抗审查与集成验证

- Status: done
- Owner: coordinator
- Objective: 独立审查安全边界并验证交叉路径。
- Inputs and prerequisites: 四个实施输出。
- Scope or files: 本任务 diff 与 targeted tests。
- Expected output: 实证复查、必要修复。
- Dependencies: T-002, T-003, T-004, T-005, T-008, T-009.
- Execution steps:
  1. 只读独立 review 授权/unknown/worker/store。
  2. 检查 diff 并复跑 meaningful tests，执行 npm run check。
- Acceptance criteria:
  - 无已知阻塞缺陷，check 与集成 tests 通过。
- Verification method:
  - read-only review 与定向命令。
- Validation evidence: 独立只读 review 及连续复查关闭 4 findings（T-009）；最终纯本任务 check（formatter/pins/imports/shrinkwrap/install-lock/tsgo/browser）全通过。暂存树 sandbox 185 tests、集成 262 tests 通过；恢复邻接 4 文件/202 tests、subagent 72 tests、server protocol 9 tests 和 pack 4 项通过。源码/diff 包括混合文件 ownership-only blobs 已审查。共享 worktree 后来有另一 progress/handoff 任务在途改动，其类型错误未修改，也不作为本次源码/产物输入。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 独立安装产物与提交

- Status: done
- Owner: coordinator
- Objective: 验证产品产物并提交本人内容。
- Inputs and prerequisites: 集成验证通过。
- Scope or files: 本任务 owned paths/hunks、临时 build/pack/install。
- Expected output: 本地 tarball、独立 smoke、提交与最终说明。
- Dependencies: T-006.
- Execution steps:
  1. offline build、包外 ignore-scripts 安装与 Node worker smoke。
  2. 只 stage 本任务内容；记录验证限制与提交。
- Acceptance criteria:
  - 独立产品中真实 QuickJS+本地 MCP 编排正常；其他改动保留。
- Verification method:
  - package smoke、git diff/status、文档 validator。
- Validation evidence: 暂存树 offline build、pack 13 bundled deps、包外 npm --ignore-scripts 安装成功；实际 installed CLI help/version/MCP codemode add、SDK QuickJS worker + read/stdio/HTTP 编排、only 声明、structured metadata privacy、durable journal、分支 store 和 awaited transport cleanup 全通过（task-36）。tarball /tmp/easy-pi-codemode-delivery.BCTFgk/package/easy-pi-0.1.0-beta.1.tgz，npm shasum 5d3d7c60d83933136695a833b19a84430313bac2。功能提交 a2fd4ac0d892b0c5f5d42ffb9876628c7dacd844 已完成（119 个本任务 paths/hunks）；提交后检查确认 index 清空，仅另一 progress/handoff 任务的修改留在 working tree。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 类型与协议适配闭环

- Status: done
- Owner: coordinator；codemode-extension（限定 fixture/legacy 类型适配）
- Objective: 适配新增 tool context/result 字段的既有消费者，不改变其产品行为。
- Inputs and prerequisites: T-003 接口已落入工作树；tsgo 实际指出 context fixtures、server exhaustive fields、legacy ctx 参数类型。
- Scope or files: server/src/protocol.ts 与 test/protocol.test.ts；coding-agent background/edit/MCP 5 个直接调用 tests、root mcp-adapter-tools.test.ts；subagent/src/extension.ts 最小参数类型适配。
- Expected output: 原断言不变的 truthful fixtures；protocol 明确记录 host-only omitted fields；全仓类型通过。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取受影响消费者，限定类型假数据及已省略协议字段更新。
  2. 定向回归，不使用 any/未知强转掩盖错误，不新增 wire schema。
- Acceptance criteria:
  - 原功能/断言保持，相关 tests 和全仓类型通过。
- Verification method:
  - 明确 5 个 fixtures 文件、server protocol.test.ts、相关 legacy subagent tests、全仓 tsgo；npm run check 在 T-006。
- Validation evidence: 对比 6 文件最小 adapter diff，原断言保持。5 文件/54 tests、subagent extension 17 tests 均通过；coordinator 组合复跑这些 consumers 通过，server protocol 9 tests 通过。全仓 tsgo --noEmit 在 protocol 新增 nestedExecutionOutcome accounting 后通过；git diff --check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 关闭独立审查发现的桥接边界缺口

- Status: done
- Owner: coordinator
- Objective: 修复 4 个有实证的 correctness/security/output-budget 缺口。
- Inputs and prerequisites: 独立只读 review；4 个 terminal 红测、2 个 metadata/wildcard 红测、worker 文件 ENOENT。
- Scope or files: MCP tools/result tests；AgentSession.getToolAccess 与真实 MCP live wildcard test；codemode worker entry/build-path fixture；sandbox prelude/terminal-output-budget.test.ts 和对应 limits 文档。
- Expected output: 所有协议位置 _meta 被剥离但 business structuredContent 保持；wildcard ceiling 可连接、具体 catalog/RPC 仍 live-filter；嵌入入口存在；terminal return/error 进入 host 前有聚合硬预算。
- Dependencies: T-003.
- Execution steps:
  1. 写并运行失败回归；检查真正跨桥接/连接边界。
  2. 做最小修复并跑新回归、邻接 sandbox/MCP/child/core tests。
- Acceptance criteria:
  - 原失败转绿，原有授权/未知/store/资源边界不削弱，独立复查无阻塞项。
- Verification method:
  - terminal budget、MCP unit/QuickJS/live wildcard/child/nested tests、pack worker fixture、纯本任务全仓 check。
- Validation evidence: terminal 新 4 项先红后绿，与 sandbox 合计 160 tests 通过；MCP unit/真实 QuickJS/live wildcard/native child/nested 42 tests 通过；worker 静态一致性和 pack 4/4；reviewer 连续复查关闭 4 findings。纯暂存树补齐已存在的公开模型 JSON/.manifest.json 后 npm run check 全通过（task-32）；6 文件/185 sandbox、22 文件/262 集成 tests 全过（task-29/33），没有将共享工作树的其他在途功能混入。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

仅列名定向 Vitest/node:test 文件，faux provider、本地 stdio/HTTP fixtures；不运行完整 suite。包测试覆盖 QuickJS、memory/timeout、pending calls、portable；核心覆盖 nested hooks/admission/revocation/durable unknown/restart；extension 覆盖输出/store/loadout；沿用 MCP 12 文件回归。最终 npm run check（完整输出）、npm run build:offline、pack scripts fixture、包外 Node smoke。任何尚不能实测的 Bun/TUI/第三方 OAuth 单独记录，不用真实凭据替代测试。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- nested dispatcher 持有父 lease 会自死锁：父编排工具不占嵌套目标资源。
- QuickJS abort 不等于 host RPC 已确认取消：宿主 promises 必须 drain，未知结果影响父确定性和 store。
- 上游仅展示的 nestedCalls 不足恢复：必须记录实际 args/contract 与父 occurrence，重复脚本或 direct call 不能重放未知副作用。
- 现有并行改动仍可能变化：每次编辑/提交前检查 diff，coordinator 独占共享 lock/doc。
- wasm/worker 相对路径在 bundled 产品中可能失效：包外真实执行验证。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 创建 execute 契约，核对 main/current HEAD，T-001 完成；T-002～T-005 开始，文件所有权已限定。
- 2026-10-11: 并行启动 codemode-package/core/extension；随后委派互不重叠的文档和真实 sandbox+MCP/child tests。coordinator 完成 settings、产品入口、MCP exposure/structured result、worker/wasm build/pack 接入。
- 2026-10-11: T-004 报告 2 文件/27 tests 通过；新真实 MCP/settings tests 20/23 通过，3 个 native child 首次调用实际被 wrapper 重建后引用相等检查误拒绝。保留授权检查，由 T-003 修正稳定 binding；coordinator 已把 live per-name predicate 接入 child 创建，保护无 tool_call event 的脚本发现 helpers。
- 2026-10-11: 新增 T-008，严格限于实际类型消费者适配。QuickJS runtime 的有界 license 调查确认 loose wasm 需要引擎/Unicode notices；保留 8 项 wrapper/engine/toolchain/libc 通知及来源，不声称完整 linked-object inventory。外部 binary 发布仍不在授权范围。
- 2026-10-11: T-002 实施完成并经 coordinator 检查 diff 与定向复跑验收；文档子任务已检查 6 文件 diff，等待产品行为实证。初轮 MCP 3 文件/71 tests 通过。另一会话新增 83e46ae82 文档提交，不改变本任务源码所有权。
- 2026-10-11: T-004、T-008 经源码/diff 与独立复跑验收。真实 child 剩余 production regression 捕获 RangeError，证明 controller 自己的 live getter 反查有效权限形成闭环；新增单独 ancestryToolAllowed composition callback，保持原 toolAllowed 全检查，包含 persisted self ceiling 和全部 live ancestors/root。child 4/4、subagent controller/lifecycle/extension 72 tests 通过。没有“遇到递归返回 true”之类放宽授权。
- 2026-10-11: 提交 a2fd4ac0d 完成本轮功能；四个混合文件仅提交 ownership-only hunks，其他 progress/handoff 修改保留。T-007 done，final passed。LEARNS 合并 live authority 递归与隐藏 public manifest 预检经验，新增跨 VM terminal/metadata 全通道经验。
- 2026-10-11: 纯树 pack 生成 13 bundled deps 的 Node tarball；包外 npm install --ignore-scripts 成功。installed SDK 实际执行 QuickJS/read/stdio/HTTP，证明 only、full structured public result、journal/store、awaited cleanup；installed CLI help/version/codemode exposure add 通过。所有 tests 均本地 faux/fixtures，不使用付费 API。
- 2026-10-11: 四项 finding 已经原失败/邻接回归和 reviewer 连续复查闭环。共享 worktree 新出现 progress/handoff 的在途功能，影响最终 check；4 个 mixed files 从 HEAD 合成本任务 blobs，只暂存自身部分，未覆盖 working edits。checkout-index 快照首次漏复制隐藏 public data/.manifest.json，出现一个类型错误及 11 个导入失败；补齐该既有公开文件后纯树 check/build 全通过、185 sandbox 和 262 集成 tests 通过。T-009 done；T-006 从 blocked 解除并完成；T-007 开始纯树打包/包外 smoke。
- 2026-10-11: 独立只读 review 不接受交付：协议 nested _meta 泄漏、live predicate 丢 wildcard 首次连接资格、Bun worker 入口缺失、return 绕过输出硬预算。coordinator 接受 findings 并建立 T-009；T-006 blocked，未将 check 全绿当作不存在缺口。terminal payload 4 tests 修复前全部红，metadata/wildcard 2 tests 修复前红；同时覆盖巨大 terminal error 同类通道。
- 2026-10-11: T-003 最后两个原有行为回归已恢复（无 nested 调用的原 AgentToolError identity；deferred 显式撤声明仍可委派的既有 ceiling）。coordinator 接管核心验证，59 tests 全通过；停止未形成终报告的 core child，保留其全部 edits，并以实际源码/tests 验收 T-003。T-006 开始独立安全审查与全仓检查。
- 2026-10-11: T-005 经产品/MCP/child 源码检查、pack fixture 和完整 offline build 验收。产物 smoke 尚属 T-007，未声称包外安装通过。
- 2026-10-11: coordinator 全包 QuickJS 5 文件/181 tests 再次通过；MCP+codemode+adapters 首次组合 19 文件/221 tests 中 219 通过，旧 codemode-reject 用例已更新为 unsupported alias，未嵌套调用的 error identity 回归交 T-003 修复；现有断言未削弱。
- 2026-10-11: npm install --ignore-scripts 和 package-lock-only 均成功；新 quickjs-wasi 无 lifecycle script/生产依赖。审查并保留 npm 带来的无关 pi-codex-accounts lock 基线，最终只新增 codemode/quickjs 条目。shrinkwrap/install-lock --check、pack fixture 3/3、bash -n 通过；现有 npm audit 报告 11 项，未运行 audit fix。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001～T-009 全部经验收。纯本任务树 npm run check、offline build、185 sandbox/262 integration/72 subagent/9 server/4 pack tests 通过；另有 202 个恢复邻接 tests 通过。包外 npm --ignore-scripts 安装及实际 QuickJS/read/stdio/HTTP、only、metadata privacy、journal/store、awaited cleanup smoke 通过。功能已提交 a2fd4ac0d，文档 validator 通过；不把共享 worktree 的未完成并行功能纳入本次产物或全仓验证主张。
- Limitations: 不使用真实 provider credentials、不发布或部署；Bun 未安装，仅静态 worker 入口验证，未验证编译二进制/人工 TUI/第三方 OAuth。随 wasm 保留已确认的 notices，不声称完整 linked-object 许可审计；外部发布仍需要专项复核。另一任务的并行 progress/handoff 修改不在本次提交树与产物中。
