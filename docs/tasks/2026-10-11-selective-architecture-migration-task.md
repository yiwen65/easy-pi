# Task Plan: easy-pi 三阶段选择性架构迁移

- Created: 2026-10-11
- Workspace: /tmp/easy-pi-selective-migration-20261011
- Mode: execute
- Overall status: in_progress
- Source: 用户要求按建议选择性迁移，并逐项确认三阶段全部实施、替换旧图片公开接口及本文件所列执行/构建权限。

<!-- task-doc-section:background-goal -->
## Background and goal

在保留 easy-pi 本地产品合同的前提下，依次迁移统一请求准备边界、TS7/Node 工具链、chat/image 统一模型基础设施。不是整体合并上游 main，不为小范围架构收益引入新的 durable、上下文历史或发布体系。本文是本轮唯一任务和状态记录，子代理报告不构成完成验收。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### 已确认执行范围

1. 借鉴 `466db0fec` 的请求准备边界，使选定输入持久化后、首次/续轮/重试/恢复请求前都能统一刷新完整请求状态；保留 existing context transform/step snapshot 的必要行为，不迁入 finishTurn/context_edit 扩展。
2. 借鉴 `ca7460d16` 的 TS7 和 Node 源码运行；审查公开发行版本及工具 API，适配 AST 检查、源码入口和 easy-pi 专用产品构建。仅允许必要的精确依赖/锁文件更新，不跳过 npm age gate，不安装生命周期脚本。
3. 借鉴 `a328aa89a`，统一 chat/image 元数据、Models/Provider、类型化查询、目录/鉴权/动态刷新；替换旧 ImagesModels/ImagesProvider 等公开接口，迁移仓库内消费者、生成器及目录工具，提供外部迁移说明。普通 getModels/getModel/getAvailable 和 /model 仍仅返回 chat；跨操作同 ID 不覆盖。

### 必须保留

- completed-item/checkpoint 恢复、先持久化再执行效果、有界重试、未知效果 reconciliation、物理工具退出前 writer ownership。
- 输入队列顺序和 one-at-a-time、分支可见检查点、当前权限/工具/模型/effort 权威、子代理 prefix-preserve 与拒绝不兼容继承。
- jiti 扩展加载、shrinkwrap、install-lock、easy-pi/.epi/epi 身份、独立产品打包和 Grok-TUI。
- 所有现有提供商默认模型和已选择性移植的定价/SDK行为；唯一新增价格例外是用户单独确认的T-012：核实并最小修复Moonshot AI/AI CN Kimi K3既有失配，其他价格不变。

### 排除与权限边界

不迁入 finishTurn/context_edit 扩展、TranscriptContext、classifier/TypeSafe、pi-durable/Chord、codemode/MCP、上游安装器或发布流程。不给工具声明历史授予执行权限。不清理无关代码/锁记录。不读真实模型凭证、不访问真实 provider API、不使用付费模型、不推送、不发布。

允许定向离线测试、根 npm run check、离线构建和临时目录打包/安装烟测；不运行 npm test 或完整 Vitest。依赖安装使用 --ignore-scripts，公开 npm 元数据/官方 tarball 可作为工具链审查输入。编译/打包烟测不得触发真实模型调用。

### 隔离与交付

原目录 `/Users/w/Projects/easy-pi/pi` 不切分支、不编辑他人文件。澄清期间四处 TUI 改动已被另一个 session 提交为 `6f935c952`，开始实施前核验仅这些四文件变化、原目录干净，因此保留该提交并将其固定为执行/交付基线。

- Fixed base: `6f935c952e21956d1e5de1c751ef5834c64d09aa`。
- Phase1 commit: `14164effe`；authorized baseline-price commit: `6bb392b2a6b6c20c36deaf3ac06db932f3dfd19b`。
- Phase2 commit: `bd7b5a681b7c4268338575fd94afd3d5cdbe617c`。
- 交付前还需对 original 忽略模型数据与初始baseline-provider-catalogs.json逐文件SHA核对；数据被其他session更新也应停止，不覆盖更新。
- Upstream reference: `e37cdc420669e48b4df4bbce0fb2617fc3c71328`（本轮不更新它）。
- Worktree: `/tmp/easy-pi-selective-migration-20261011`。
- Branch: `integrate/selective-migration-20261011`。
- Evidence: `/tmp/pi-selective-migration-evidence-20261011/`；不是第二份任务/状态源。
- 依赖、忽略模型数据和构建产物只在私有 worktree 准备；不得通过原目录 node_modules/生成数据链接污染其运行环境。交付前严格核验原 HEAD/分支/改动；再次漂移或目标冲突停止确认，不自动重基、覆盖或丢弃并发改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户确认三阶段、旧图片接口替换、必要依赖锁更新及离线构建/打包烟测权限。 | 本轮 structured scope / compatibility / final confirmation 三次答复。 |
| F-002 | 原目录由 a05295067 增加 6f935c952，仅四处 TUI 文件，无实施目标路径变化；执行前干净。 | git log a05295067..HEAD、git diff --stat、git status --porcelain；task-121 在 HEAD/clean 门禁后创建 worktree。 |
| F-003 | 本地已有每请求 transform/压缩预检、prepareNextTurnWithContext 刷新、投影 revision 和 completed-item 恢复，不是缺少压缩/恢复功能。 | packages/agent/src/agent-loop.ts 完整读取；agent-session.ts:_installAgentNextTurnRefresh/_installTaskRecoveryHooks；docs/compaction.md、stream-recovery.md。 |
| F-004 | 统一模型迁移必须携带运行时和目录消费者：当前 ImagesModels 分离、image refresh 没有 chat 的持久化 publication；Models 和 availability 按旧 ID 空间索引。 | packages/ai/src/images-models.ts 完整读取；models.ts:createProvider；coding-agent/model-runtime.ts:refreshProviderAvailability。 |
| F-005 | 当前工具链为 typescript5.9.3/native-preview、tsx；AST 检查使用旧 TS Compiler API，专用产品构建绑定 native-preview 路径。 | package.json、tsconfig.base.json、scripts/check-ts-relative-imports.mjs、build-easy-pi-product.mjs、pi-test.sh。 |
| F-006 | 官方 npm 实际提供 typescript7.0.2，engines Node>=16.20.0；官方 tarball 已通过正常 age gate 获取并解包，但尚未验证安装/运行/API兼容。 | task-123 npm view exit0；task-127 npm pack --ignore-scripts exit0；typescript7-metadata.json 与 typescript7/package；宿主 Node24.15.0/npm11.12.1。 |
| F-007 | 补充 AI 基线已有一项 Moonshot Kimi K3 cacheWrite 不匹配：忽略目录为3，已有 providers.test.ts 断言为0；发生于任何 AI/schema生产修改前。 | task-128：8文件101pass/1fail/3显式skip；完整读取 providers.test.ts；moonshotai及moonshotai-cn JSON目前cacheWrite3；不可把此既有失败归因迁移或自动改价。 |
| F-008 | 官方现价证明原0断言过时：国际K3默认5min cacheWrite USD3/1M，与input3相同；1h为6。国内5min写入与未命中输入同为CNY20，1h40。本轮保留既有USD归一数据3，不引入汇率转换/1h计费迁移。 | 官方Moonshot URL 301到platform.kimi.ai/.com；task-141/142匿名无认证Markdown GET均HTTP200，4630/4257bytes且全文读取，kimi-*-pricing-public.md。browser web_fetch遇Tunnel/guard失败，非完整DOM扫描；不用摘录冒充全文。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 无。
- Decision Q-001: 本轮包含三阶段，依次验证而非并行发布。
- Decision Q-002: 旧图片 API 替换，不增加用户未要求的长期兼容层；chat API 的默认行为保留。
- Decision Q-003: 保留 shrinkwrap/jiti/easy-pi 产品路线；允许必要工具链依赖锁改动与离线构建/临时包验收。
- Decision Q-004: 用户选择并确认核实后最小修复Moonshot两提供商Kimi K3价格失配；可信来源不足/冲突时停止，不猜价格；不得改其他价格或削弱校验。
- Open questions: 无未解决产品决定。工具发行可用性、实际迁移依赖和基线测试结果是待验证技术事实；若它们迫使更换已确认方向/扩大范围，则记录 blocker 后再询问用户。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 三阶段在最小适配范围内完成并独立提交，原有安全/恢复/队列/分支/协作合同的定向回归通过。
- 请求准备覆盖每个真实 conversational provider call，输入不重复、压缩不重复触发；step 的 schema/handler 绑定在最终刷新后固定。
- 工具链公开发行及 API 有实际证据，必要检查脚本、源码入口、产品编译和临时打包 smoke 通过；Node 最低支持版本不暗中抬高。
- chat/image 按操作隔离，普通模型选择仍仅 chat；认证、取消、目录刷新/持久化、自定义 provider、扩展/SDK/远程目录消费者与定价不退化；旧接口有明确迁移文档。
- 每阶段根 npm run check 通过；修改过的测试全部实际运行通过。所有未执行/环境受限检查明确列出。
- 只有 owned 路径和必要生成/锁文件进入提交；交付不覆盖他人改动。全部任务通过才标 passed。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> {T-002,T-004,T-007}; T-002 -> T-013 -> T-014 -> T-003; {T-003,T-004} -> T-005 -> T-006; {T-006,T-007} -> T-008 -> T-009；T-001 -> T-012；{T-009,T-012} -> T-010 -> T-011。
- Parallel batches: B0 协调者隔离/依赖/基线；B1 请求边界实现 T-002 与只读工具链审查 T-004、只读 schema 设计 T-007 可并行；B2 请求门禁 T-003；B3 工具链 T-005/T-006；B4 AI schema T-008；B5 runtime/消费者 T-009；B6 综合验收 T-010；B7 交付 T-011。
- Serialization constraints: authority 文档只由协调者编辑。实现阶段不重叠；依赖/锁/生成器/模型数据由明确 owner 串行管理。并行审查只给 read 工具。runtime 不提供 DAG 启动工具，使用可用 spawn_agent 的 parallel wrapper 启动独立、边界明确任务，不声称存在不存在的 DAG API。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 隔离、私有运行环境和基线

- Status: done
- Owner: coordinator
- Objective: 固定基线、创建隔离 worktree、准备私有依赖与离线目录、取得有效基线。
- Inputs and prerequisites: 用户已确认合同，原目录 HEAD/clean 门禁。
- Scope or files: worktree 私有 node_modules/忽略目录/必要 source facades、证据目录、本文。
- Expected output: 可运行定向测试和 root check 的私有环境及基线结果。
- Dependencies: None.
- Execution steps: 私有复制依赖；核验 workspace links 不指向原目录；复制忽略模型数据；识别必要 source resolver；离线基线。
- Acceptance criteria: 原目录无写入；测试实际加载本 worktree 源码/数据；基线差异明确。
- Verification method: git 状态、依赖/符号链接审查、定向基线、npm run check。
- Validation evidence: task-121 worktree创建成功；task-122复制私有root/包依赖与忽略模型数据，workspace links全为相对私有路径；task-124创建1324个忽略source facade（非发布产物）并root check exit0、1413 files No fixes；task-125 agent两文件57/57；task-126 coding六文件157/157；only本文untracked。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 统一请求准备边界适配

- Status: done
- Owner: /root/migrate-request-boundary
- Objective: 在保留现有恢复/调度合同下引入 prepareRequest 并收敛 session 接线。
- Inputs and prerequisites: T-001，466db0fec，当前完整 loop/agent/session/hooks/tests。
- Scope or files: packages/agent/src/{agent-loop,agent,types}.ts；coding-agent/src/core/agent-session.ts；对应定向测试和必要文档。
- Expected output: 最小可审查实现及首次/续轮/重试/恢复边界回归。
- Dependencies: T-001.
- Execution steps: 完整读文件及消费者；编码行为 guard；适配请求准备；保留错误硬退出、checkpoint continuation、队列和 snapshot 顺序。
- Acceptance criteria: 不引入 finishTurn/context_edit/TranscriptContext；没有双压缩、重复输入或恢复工具重放。
- Verification method: V-001/V-002，独立 diff 审查。
- Validation evidence: 子代理302db9c2已冻结9个owned文件；父代理读取实际diff、完整新tests/报告、RED与最终check日志。新增agent6/session4 guards先RED；child agent92/92、coding串行287/287及root check1415files No fixes通过。发现canonical/live diagnostics不同后经collaboration guard纠正，未迁出范围；仍须T-003独立验收/提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 请求边界阶段验收和提交

- Status: done
- Owner: coordinator
- Objective: 独立验证 T-002，完成第一阶段提交后才允许工具链实施。
- Inputs and prerequisites: T-002 输出及 red/green/邻域报告，T-013/T-014独立审查交互回归修复。
- Scope or files: T-002 owned diff、本文及证据。
- Expected output: 通过门禁的 phase1 commit。
- Dependencies: T-002, T-013, T-014.
- Execution steps: 看实际 diff；重跑关键回归；覆盖 compaction/queue/retry/recovery/collaboration；根检查；explicit stage/commit。
- Acceptance criteria: 根检查通过、无越权 hunk、阶段报告真实。
- Verification method: V-001/V-002/V-005，git diff --check。
- Validation evidence: 父代理request agent94/94、coding完整串行290/290，recurring修复后11邻域198/198，root当前check1416 No fixes；c46c5009独立continuity review确认三项发现均解决、无新增actionable issue；task-146 explicit10owned paths提交14164effe（986+/6-，其中693行新增guard），no staged余留；原目录未交付。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 工具链发行/API 和消费面审查

- Status: done
- Owner: /root/audit-typescript7
- Objective: 验证上游 TS7 发行与本地脚本/源码启动/产品构建的迁移落点。
- Inputs and prerequisites: T-001，ca7460d16，公开 npm 类型/发行说明。
- Scope or files: 只读 package manifests、tsconfigs、AST/build/launch 脚本、npm 官方元数据/tarball；报告放证据目录由协调者保管。
- Expected output: 可执行最小迁移契约、版本/Node/生命周期/锁文件影响证据或明确 blocker。
- Dependencies: T-001.
- Execution steps: 审查公开可用版本；读取实际 API 类型/发行说明；映射本地消费者；保留 jiti/产品路径。
- Acceptance criteria: 不把 git 版本说明当可安装证据，不绕 age gate、不扩大依赖。
- Verification method: 官方 npm 元数据/官方 tarball、当前源/类型静态对照。
- Validation evidence: 子代理结果88ebef09完成只读发行/API/消费面审查；父代理核对官方package.json、version.cjs和完整sync/api.d.ts：7.0.2根入口只有version，必须迁unstable/sync AST；官方host平台metadata匹配。当前没有TS7安装/运行证据，属于T-005/T-006门禁。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — TS7/Node 工具链实现

- Status: done
- Owner: /root/migrate-typescript7
- Objective: 升级经 T-004 核验的工具链并适配本地源码运行/编译/check。
- Inputs and prerequisites: T-003、T-004 门禁已通过。
- Scope or files: 必要 manifests/锁/tsconfigs、AST 检查、源码解析与启动脚本、easy 专用 build；对应测试。
- Expected output: 不改变产品入口/扩展/发布的工具链补丁。
- Dependencies: T-003, T-004.
- Execution steps: 精确依赖更新并 --ignore-scripts；先测试检查器/入口；适配 compiler API/build；审查 class fields 和 module syntax 的实际影响。
- Acceptance criteria: Node 最低支持不抬高；不删 jiti/shrinkwrap；无无关依赖/锁清理。
- Verification method: V-003/V-005/V-006，锁语义对照。
- Validation evidence: child0ac9b0c2完成25owned files，父代理读实际核心diff、完整resolver/checker/newtests及报告。官方TS7实际安装；child新node tests10/10、coding66/66、rootcheck1416 No fixes、source CLI与source/built jiti/faux、offline build通过。20native dev记录新增/9旧compiler记录移除/5声明变化，四处无关锁记录恢复；shrink/install-lock字节未改。479classes继承字段审查唯一cause显式赋值。仅Node24运行验证；仍须T-006独立gate/pack/install/提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 工具链阶段构建、打包门禁和提交

- Status: done
- Owner: coordinator
- Objective: 验证 source 与构建/打包隔离消费者，完成第二阶段提交。
- Inputs and prerequisites: T-005。
- Scope or files: 私有 worktree build/临时 package artifacts、本文与证据。
- Expected output: phase2 commit 与离线 smoke 结果。
- Dependencies: T-005.
- Execution steps: 根检查；源码 help/version/offline model list；offline build；临时包/install smoke；保留 shrinkwrap/identity；explicit stage。
- Acceptance criteria: 不依赖原 worktree/dist；打包后的 epi 正确，不请求真实模型。
- Verification method: V-003/V-005/V-006。
- Validation evidence: parent149新node tests10/10+TS7 version7.0.2；150 coding66/66；151锁语义20+/9-/5changes、runtime locks byte-identical、零facades、完整rootcheck1416 No fixes及offline build；e9134c31独立只读review无actionable。152 pack11bundles/2643files，初始153offline cache ETARGET经154官方version确认/155正常2-day公共npm缓存hydration后160全新目录offline --ignore-scripts安装成功；161仓库外CLIhelp/version/list及bare easy-pi SDK/faux/jiti/singleton烟测通过。临时helper首次误导入非公开AuthStorage后读真实exports改用AI InMemoryCredentialStore，不改产品。162 explicit25paths、PI_ALLOW_LOCKFILE_CHANGE=1提交bd7b5a681。Node22/Windows未实测且未重试旧操作。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — chat/image 统一接口与数据设计

- Status: done
- Owner: /root/design-chat-image
- Objective: 读全上游及本地消费面，确定无 classifier/TranscriptContext 的统一契约和离线数据方案。
- Inputs and prerequisites: T-001，a328aa89a，现有 catalog/provider/models/runtime/images tests。
- Scope or files: 只读 AI 统一/图片/目录生成和 coding-agent/runtime/扩展消费者。
- Expected output: 明确类型/API/操作键/生成和消费迁移范围及测试边界。
- Dependencies: T-001.
- Execution steps: 完整查消费者/生成链；审查同 ID 跨类型、dynamic publication/auth 及 chat-only 默认；设计离线生成不刷新未知价格。
- Acceptance criteria: 不把删除类型名当完整迁移，不制造目录数据或引入 classifier。
- Verification method: 有界全消费者检索、实际源码/fixture 对照。
- Validation evidence: 子代理结果c2a2b5e只读设计完毕；父代理核对本地types/images/models/runtime、给定上游diff及实际baseline快照。固定chat/image-only、三元组操作键、既有compat globals重接但旧image collection删除、离线normalized输入与保留chat公开投影；1523chat/45image基线已保存。实现与完整运行验证留给T-008/T-009/T-010。
- Blocker: None.
- Unblock condition: None.

### [ ] T-008 — AI chat/image 类型、Provider、Models 与目录迁移

- Status: in_progress
- Owner: /root/migrate-chat-image-ai
- Objective: 实现统一模型基础设施和必要生成/离线目录工具，替换旧 image collection。
- Inputs and prerequisites: T-006、T-007。
- Scope or files: packages/ai 相关类型/models/providers/compat/生成脚本/目录工具/tests；必要根生成命令。
- Expected output: 类型隔离的 chat/image model operations，受控刷新/持久化和回归。
- Dependencies: T-006, T-007.
- Execution steps: 编码类型/错误操作/同ID/auth/cancel/publication guard；最小 forward-port；通过脚本/fixture 生成数据，不手改 models.generated.ts；保持非迁移目录语义。固定chat/image-only BaseModel/AnyModel、旧collection/factory删除而既有compat globals重接；离线normalized snapshot统一写出；内部schema3->4按chat:/image:键防碰撞，manifest.generatedAt原值；原公开models.json为chat投影，additive models.all.json/per-provider.all.json表达mixed，public catalog version1不变。
- Acceptance criteria: 普通 getModels/getModel/getAvailable 只 chat；同 provider+type+id 索引；chat usage/cache/prices/defaults 保留；无旧 collection 适配层。
- Verification method: V-004，类型检查，离线 catalog 验证和语义对照。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-009 — runtime、扩展、SDK 消费者及迁移说明

- Status: pending
- Owner: unassigned
- Objective: 将仓库内消费者切到统一模型接口，保持选择/认证/子会话隔离行为。
- Inputs and prerequisites: T-008 的固定接口与 actual diff。
- Scope or files: coding-agent model-runtime/provider-composer/远程目录/扩展/SDK 等实际消费者、根 catalog 发布工具、必要文档/tests。
- Expected output: 所有本地消费者迁移及外部旧 image API 迁移指南。
- Dependencies: T-008.
- Execution steps: 根据新契约迁移；保持 chat 默认查询；新增 runtime image/custom-provider/隔离和 catalog guards；更新文档。
- Acceptance criteria: 模型 selector/scopes 默认不混入 images；无隐含兼容层；旧公开接口迁移说明明确。
- Verification method: V-004/V-005，消费者搜索、源码/外部包 smoke。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-010 — schema 阶段及跨阶段综合验收

- Status: pending
- Owner: coordinator
- Objective: 验证第三阶段和所有阶段依赖路径，独立审查并提交。
- Inputs and prerequisites: T-009、T-012。
- Scope or files: actual owned diff、离线数据/构建/pkg artifacts、本文和证据。
- Expected output: phase3 commit、完整门禁证据和已验证限制。
- Dependencies: T-009, T-012.
- Execution steps: 独立源码审查；重跑边界、runtime/catalog/recovery/collab；root check；offline build/包 smoke；复核 deps/data 语义。
- Acceptance criteria: 全部修改测试/指定回归通过；无 defaults/权限/恢复/identity 回退；无 API 或发布。
- Verification method: V-001..V-006 的必要交叉子集，git diff --check。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-011 — 漂移门禁、交付和任务闭环

- Status: pending
- Owner: coordinator
- Objective: 在保留并发改动前提下交付已验证提交，并记录最终状态。
- Inputs and prerequisites: T-010，固定原分支/base 门禁。
- Scope or files: 原目录 fast-forward、必要依赖/生成目录 hydration、本文。
- Expected output: 原 my-pi 安全交付或明确 blocked；任务文档 final evidence。
- Dependencies: T-010.
- Execution steps: 再核验 original HEAD/branch/status；非预期漂移立即停；ff-only；安全准备必要依赖/生成数据；关键 smoke/check；提交最终文档。
- Acceptance criteria: 所有任务 done、文档 validator 通过、原交付实际运行环境验证；不丢失他人提交/改动。
- Verification method: V-005/关键 runtime smoke、git log/status、task_document.py validate。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 既有 Moonshot 目录定价基线处置

- Status: done
- Owner: /root/fix-moonshot-k3-pricing；coordinator核对来源/验收
- Objective: 在 schema 综合验收前明确 F-007 既有定价失败的范围及验收处置，不暗中改价或弱化测试。
- Inputs and prerequisites: T-001；task-128 原始失败和实际忽略目录记录。
- Scope or files: providers.test.ts、Moonshot Kimi K3生成规则/两处目录及直接回归，本文；已获核实后最小修复授权，禁止其他价格变化/校验弱化。
- Expected output: 可信来源支持的最小生成/目录修复、保留原严格价格校验及回归证据；来源不足则明确blocked。
- Dependencies: T-001.
- Execution steps: 保留原始失败；核对生成器/数据来源；在进入受影响schema总门禁前请求范围决定；仅按决定执行验证。
- Acceptance criteria: 不把基线fail算迁移回归；不删除/skip严格价格断言；任何实际价格变化或门禁例外均显式批准。
- Verification method: task-128 replay、生成器与目录对照、用户决定与所选后续定向验证。
- Validation evidence: Q-004/F-008核实后child786e31f5实施限定fallback与严格断言，真实生成器fixture15cases先RED（两地区6fail+旧断言1fail）后GREEN；父代理读实际3文件/完整测试/来源/报告，task-143独立124pass/4既有credential skip，task-144根check1416 No fixes。40JSON/1523chat/45image保真日志已读，数据3未改、其他价格/默认/SDK/1h行为未改；task-147 explicit3owned paths提交6bb392b2a（146+/3-），含15case真实生成器offline guard；原目录未交付。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — 独立审查发现的请求准备交互回归

- Status: done
- Owner: /root/migrate-request-boundary
- Objective: 对两项高置信度静态发现先做可失败重现，再最小修复请求准备交互。
- Inputs and prerequisites: T-002；独立审查e353e155及父代理cache routing/owned next-turn源码核对。
- Scope or files: phase1 agent/session准备与直接回归测试/文档，禁止工具链/schema/锁/原目录修改。
- Expected output: cache lineage随model change刷新且native session identity保留；自定义next-turn context同时收到随后持久化的输入监听器新增内容，且不恢复刻意移除的旧消息。
- Dependencies: T-002.
- Execution steps: 新增精确RED guard；核实因果；以最小请求选项snapshot与持久entry边界融合修复；重跑既有prepare/compaction/retry/collaboration/recovery。
- Acceptance criteria: 两项行为RED->GREEN；当前授权/工具/模型边界和owned context不退化，不增加无关功能。
- Verification method: V-001/V-002/V-005与独立审查复核。
- Validation evidence: child48152c91将两项静态路径先RED（agent1fail/1pass、session2fail/4pass），另做路由额外字段覆盖native身份的对抗RED后限制显式三字段copy。最终agent94/94、coding串行290/290及rootcheck1415files No fixes；父代理读完整报告、actual getter/entry-boundary merge、新测试，新增回归与代码冻结，T-003进行独立复核/父验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — recurring next-turn callback 与未消费持久增量

- Status: done
- Owner: coordinator 负责RED guard；/root/migrate-request-boundary负责最小源码修复
- Objective: 重现并修复重复返回context的callback提前重设cursor，跳过晚到通知/检查点的问题。
- Inputs and prerequisites: T-013；独立continuity review418f61cb及父代理actual wrapper核对。
- Scope or files: 现有suite/agent-session-prepare-request.test.ts、agent-session.ts准备边界及必要文档；不改工具链/schema/锁/原目录。
- Expected output: 每次旧cursor下未消费增量先进入callback输入，再允许新cursor捕获；checkpoint先成为权威基线。
- Dependencies: T-013.
- Execution steps: 将两项已有guard的后续callback改为返回context，先RED；将增量/checkpoint处理收敛到callback前及最终request边界；保留主动旧消息省略、排序/去重/失败排除。
- Acceptance criteria: recurring callback下notice不消失、checkpoint不被旧marker覆盖；原one-shot/队列/恢复/前缀逻辑保留。
- Verification method: 精确RED/GREEN guard、V-002/V-005及独立review复核。
- Validation evidence: 父task-137精确2RED/5pass；child54cbf297仅提取/复用现有merge，在callback前与最终request两处调用，11文件198/198；父task-145重跑198/198、task-144根check1416 No fixes，实际源/报告已读；独立continuity review c46c5009确认原三项问题均解决，无新增actionable issue。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

所有 provider 测试使用合成凭据/faux/mock/localhost，PI_OFFLINE=1，显式移除真实 provider key 环境变量；不读取用户 auth 文件。

- V-001 / agent：包根运行指定 agent-loop/agent/retry/recovery/tool-plan/proxy tests，新增 prepareRequest guards；不得完整 Vitest。
- V-002 / coding-agent：包根指定 suite prompt/queue/concurrent/retry/compaction/runtime、native recovery、collaboration prefix-preserve 边界；实际文件集合通过 T-001 检索记录。
- V-003 / tools：指定 node:test AST/resolver/build-contract 脚本测试、PI_OFFLINE source --help/--version/--list-models；不执行真实 prompt。
- V-004 / model：AI models/images/auth/catalog/usage/cache tests 与 coding model-runtime/image/custom-provider/remote catalog 的必要定向子集；离线 fixture 生成及 type-aware目录校验。
- V-005 / root：npm run check 的完整输出；立即检查 formatter 是否改动非owned路径；git diff --check；doc validator。
- V-006 / artifacts：仅私有 worktree offline build，临时 pack/install --ignore-scripts；从仓库外执行 help/version/offline model list、faux SDK smoke，避免workspace解析掩盖缺失依赖。

每个验证记录命令/cwd/环境、exit code、通过/失败/skip 数、未运行范围。不存在 registered validationCommandIds；不向子代理虚构命令注册或 DAG 工具。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 上游 TS7公开发行/最低Node已有metadata证据，安装与compiler API仍待验证；若要求范围变更，T-004/T-005 blocked。
- F-007 AI既有Moonshot定价基线失败：用户Q-004已确认最小修复权限；可信来源仍须核实。不能隐含修改其他价格、削弱原断言或把通过数掩盖失败。
- 统一请求准备不能改变本地 compaction期间 steering收取、completed checkpoint continuation、恢复后未解决工具执行或 root-only协作。
- 上游模型提交还含 classifier/新字段/别的迁移，本轮只 forward-port chat/image 必要行为；生成链不可凭空补价格或整批网络刷新。
- npm lock regeneration可能清理无关旧记录；若发生，精确识别并恢复无关语义，不扩大清理范围。
- 独立worktree也有全队共享状态；owned路径/生成/lock/delivery必须串行，不将子代理报告自动视为通过。
- 原 my-pi 继续并发推进时，最终 gate 会阻断交付；届时记录完整已完成成果和明确决策。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 用户确认三阶段全做、旧图片接口替换、允许必要依赖/锁变更与离线构建/临时包验收。
- 2026-10-11: 开始前重新观测 original 从 a05295067 到 6f935c952；仅四处原先未提交的 TUI 改动已经提交，工作区干净。固定6f935基线，保留并发成果。
- 2026-10-11: task-121 HEAD/clean门禁后创建 integrate/selective-migration-20261011 与隔离 worktree；T-001 in_progress。填充唯一 authority 文档，其余实现任务尚未开始。
- 2026-10-11: T-001 done：private依赖/目录/source facades、214基线tests及root check通过，原目录未写入。官方TS7.0.2 metadata/tarball获取成功；已保存精确上游diff/源码作为只读输入。
- 2026-10-11: B1并行启动：T-002由migrate-request-boundary实现，T-004由audit-typescript7只读审查发行/API，T-007由design-chat-image只读设计接口/生成链；这些路径不重叠，authority只由coordinator编辑。
- 2026-10-11: task-128补充AI基线101pass/1既有Moonshot定价fail/3skip，新增F-007。当前无AI源码更改，先保留证据；不能删/弱化该断言或自动修其他chat定价。此问题不阻塞请求/工具链实施，进入schema总门禁前必须明确处置。新增T-012 blocked，T-010依赖它；不阻塞独立前两阶段。
- 2026-10-11: baseline快照保存1523chat、45image、39provider+manifest共40JSON，用于全记录保真验证。
- 2026-10-11: T-004/T-007只读报告返回；父代理检查实际metadata/类型声明及本地机制后接受设计任务done，尚未开始TS7/schema实施。readonlychildren已完成，T-002仍在验证。
- 2026-10-11: root恢复提示中有一条Node22下载bash未确认；当前检查目标node22目录不存在、任务列表无对应背景登记、无对应进程，不能据此宣称完整下载终态。保留paused，不重试其mkdir/curl/extract；该事项不影响请求阶段独立验收。
- 2026-10-11: T-002实现/定向验证已完成并冻结，父代理读证据后标done；T-003 in_progress，启动独立只读审查及父代理重跑。child中间并行concurrent用例有一次30s timeout（因果未明），随后单文件7/7与两次完整串行287/287；不得宣称已证明baseline flaky。
- 2026-10-11: 父代理task-130 agent92/92、task-132 coding串行287/287、task-131根check1415files No fixes通过；独立review e353e155指出cache routing与owned next-turn context/late receipt组合两项高置信度风险。父代理核对真实源路径后新增T-013 in_progress做先RED重现/最小修复；T-003提交门禁等待它。
- 2026-10-11: task-133审查官方20个TS7平台包metadata，全部version7.0.2且无安装生命周期脚本，记录typescript7-platform-metadata.json；未安装任何包。
- 2026-10-11: T-013完成并冻结，报告48152c91/完整request-boundary-review-fixes.md与源/回归已读；父代理启动最终复核。原node22未知下载没有重复，已检查常见/fnm本机安装也无Node22可用；最低版本实际烟测尚未取得。
- 2026-10-11: 用户对T-012选择「核实并最小修复」并确认修订约定；新增Q-004且T-012 blocked->in_progress。尚未执行任何价格变化，先核实可信来源。其余三阶段及排除项不变。
- 2026-10-11: 父代理task-134 agent94/94、task-135 coding290/290、task-136根check1415 No fixes通过；continuity review418f61cb识别recurring context callback提前重捕获cursor的晚通知/检查点遗漏。新增T-014先RED后修复，T-003门禁等待它；不得把此前已通过的one-shot guard当全部组合已覆盖。
- 2026-10-11: root task-137将两guard后续callback改为返回context，重现2expectedfail/5pass（晚通知缺失，检查点未替换），T-014交由原actor最小修复。
- 2026-10-11: T-012来源核实发现0断言过时，不应把现有目录3改0。普通browser和直连公共DNS guard读取不可用，随后经现有网络代理进行匿名官方文档GET（不带认证/cookie），显式301官方重定向后HTTP200并全文读取两份Markdown。保存F-008；只修限定默认5min生成/断言，无汇率/长TTL/其他费用迁移。T-012与T-014owned源码不重叠，可以并行；根formatter/check由任务owner/协调者错峰核对范围。
- 2026-10-11: T-014与T-012通过父代理当前验证/源审查，标done；请求最终review c46c5009无新增actionable issue。父task-143价格124pass/4既有skip、task-145核心交互198pass、task-144根check1416 No fixes。T-003准备分别提交请求阶段与已授权价格修复，未进行TS7/schema实施或原目录交付。
- 2026-10-11: task-146请求阶段提交14164effe，T-003done；task-147已授权Moonshot补丁单独提交6bb392b2a，只有authority untracked。T-005移交migrate-typescript7，严格保留jiti/shrinkwrap/epi与原cli入口。T-012先于schema完成，1523chat/45image原数据仍完全不变。
- 2026-10-11: T-005 child0ac9b0c2返回，父代理读实际25路径及新checker/resolver/guards；标实现done，T-006 in_progress。Node24上nativecompiler/source与实际offline构建已运行，未取得Node22/Windows实测；旧Node22操作未重试。开始独立代码/锁语义/包消费者验证，不把child报告自动当提交验收。
- 2026-10-11: T-006独立门禁完成；parent151 rootcheck1416 No fixes+offlinebuild、149 10tests、150 66tests、e9134c31 staticreview无actionable；仓库外安装初次缺公共npmcache，明确failure后官方metadata确认/正常2-day --ignore-scripts补cache，160新目录完全offline安装、161 CLI/public SDK/faux/jiti烟测通过，无任何repo runtime dep变化。节点22旧下载没有重复；记录Node22/Windows未测试。
- 2026-10-11: task-162 toolchain25ownedpaths提交bd7b5a681，T-006done；T-008交给migrate-chat-image-ai。固定内部最小schema4和原publicchat投影/additive混合数组；价格/SDK/default数据语义维持，classifier/Transcript字段排除，后续coding消费任务严格串行等AI接口冻结。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 隔离/基线、phase1请求准备实现/独立review修复与提交、Moonshot最小价格修复/提交、phase2 TS7/Node实现与独立check/build/外部包gate及提交均完成；schema AI实现开始，消费者/综合验收/最终交付尚未完成。
- Limitations: phase3仍在实施，原目录尚未交付；Node22旧获取操作未确认且未重试，Node22/Windows实际运行未验证；无 provider API/凭证、push/release行为。
