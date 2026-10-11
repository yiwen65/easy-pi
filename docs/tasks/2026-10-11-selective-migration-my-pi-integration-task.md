# Task Plan: 将选择性架构迁移安全集成到 my-pi

- Created: 2026-10-11
- Workspace: /tmp/easy-pi-my-pi-integration-20261011
- Mode: execute
- Overall status: blocked
- Source: 用户新请求「合并到 my-pi」，覆盖上一轮仅隔离交付的决定；不授权丢弃/代提交其他 session 的未提交改动。

<!-- task-doc-section:background-goal -->
## Background and goal

将已验收三阶段架构迁移集成到当前 my-pi，保留目标分支已提交的 MCP、恢复 certainty/branch ownership 和工作流改动；同时不影响正在写入原目录的 CodeMode 工作。本文件是此新集成执行的唯一 authority。上一轮 docs/tasks/2026-10-11-selective-architecture-migration-task.md 保持已完成历史记录，不改写其验收结果。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Source: integrate/selective-migration-20261011 @ 59faf2409bd9c48c738e271582bb8ba298d4e2fb；三阶段 source commits 14164effe、bd7b5a681、817d3d782，Moonshot 已批准修复 6bb392b2a。
- Initial target: my-pi @ 83e46ae82c692c49112974e427656f89b19fbf70；不自动覆盖新提交，交付前重新固定最新已提交基线并补集成/重测。
- Private integration branch/worktree: integrate/selective-migration-my-pi-20261011 / /tmp/easy-pi-my-pi-integration-20261011。
- Evidence: /tmp/pi-selective-migration-evidence-20261011/my-pi-integration/；不是任务状态源。
- 保留三阶段请求准备、TS7/Node、chat/image 全部原合同及选定 SDK/cache/定价/defaults；保留 target 已提交的 MCP/恢复/工具权限、writer ownership、unknown-effect reconciliation、easy-pi/epi/.epi、jiti、shrinkwrap/install-lock 和独立打包。
- 只在私有树合并已提交内容和处理必要交互/锁/构建消费差异；不重做上游整分支迁移、不删除 target 的 MCP，不把未提交 CodeMode 当可合并提交或本任务自有代码。
- 原目录未满足 clean/HEAD/data gate 时严格不写入，不 stash/reset/覆盖、不代提交其他 session 文件、不切其分支。只在 gate 满足时做 ff-only 交付，必要运行环境 hydration 保留公开目录数据/依赖边界。
- 沿用已批准定向离线 tests、全根 check、offline build、临时 pack/install/源码归档权限；依赖/锁变化只允许必要集成，ignore-scripts、正常2-day age gate，不运行完整 Vitest/npm test、真实 provider API/凭证/付费模型、push/release。
- 旧 Node22 下载操作仍 paused/unknown：已只读确认当前目标不存在/无匹配进程，但不据此推断历史终态，不重试或 reconcile 未证实结果；Node24 独立验证继续。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户明确要求现在合并到 my-pi。 | 本轮用户新请求。 |
| F-002 | source 隔离分支为59faf2409且干净；已通过上一轮阶段/跨阶段 tests/check/build/pkg/data gate。 | 本轮 git rev-parse/status 与上一轮完整 authority、保留证据。 |
| F-003 | my-pi 已到83e46ae82，包含新MCP d22113e47及恢复2507ea5d7等7个新增提交。 | readonly git log/stat 6f935..83e46；138paths/20374新增行，未写原目录。 |
| F-004 | 原目录存在且继续变化的未提交CodeMode/agent/types/deps/build/SDK等改动，与迁移重叠。 | 两次readonly status；第二次已有runner/wrapper/task-recovery新变化，不能视为quiescent。 |
| F-005 | 私有integration worktree已从精确83e46创建，尚未合并source。 | worktree add成功；只有本新authority文件。 |
| F-006 | Node22当前目录缺失/匹配下载解压进程未见，不证明旧下载终态。 | 当前readonly test/ps；未重复mkdir/curl/tar或调用reconcile。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 无；旧tests/check结果不等于合并后验证。
- Decision Q-001: 「合并到my-pi」授权保留当前已提交target内容集成，不授予处理其他owner未提交文件的权限。
- Open question Q-002: 交付依赖原目录的并发owner提交并稳定；若仍dirty，不进行原目录merge或runtime hydration，报告blocked。需要改动此安全条件时先请求明确决定。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新merge candidate包含source59faf及固定target所有已提交功能，无撤销MCP/恢复/权限或默认/pricing/SDK行为。
- 每个实际冲突有源/目标完整上下文和最小解法；不存在盲选ours/theirs、无关清理或测试弱化。
- 全根check及必要受影响的请求/恢复/MCP/model/extension/toolchain定向回归实际通过；数据1523chat/45image、baseline非type字段/timestamp保真。
- private source/built/temporary installed CLI/SDK/相关MCP/图片消费在不依赖原树的环境验证，实际限制如实记录。
- 只有本session集成路径/必要locks/docs进入commit；原目录交付时HEAD/clean/public-data gate再验证，ff-only，不覆盖并发工作。
- 文档validator通过；未满足原交付条件时不能宣称已合并到my-pi。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> {T-006,T-007}；{T-002,T-006,T-007} -> T-003 -> T-004 -> T-005。
- Parallel batches: 当前T-002串行冲突处理；source冻结后只读review可与父受控tests并行，但T-004最终接受仍依赖T-003。
- Serialization constraints: coordinator独占authority、Git index/merge/locks/data；其他owner只明确不重叠路径。read-only child只用read工具，bash本身不是只读边界。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 刷新基线与隔离

- Status: done
- Owner: coordinator
- Objective: 确认新请求/当前状态，建立不影响dirty原树的集成树。
- Inputs and prerequisites: 用户明确merge请求，原/source Git readonly观察。
- Scope or files: 私有worktree、新authority与evidence，原目录readonly。
- Expected output: 精确target/source pins、并发dirty blocker和私有树。
- Dependencies: None.
- Execution steps: 完整读原AGENTS/历史authority，bounded LEARNS，status/log/worktree，创建精确base树。
- Acceptance criteria: 原无写入，source干净，基线不是旧110675或6f935。
- Verification method: Git只读状态与worktree create输出。
- Validation evidence: current target83e46/source59faf，private worktree create成功，F-001..F-006；旧Node22仅readonly未重试。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 合并已提交source与target

- Status: done
- Owner: coordinator
- Objective: 私有树三方合并，保留两个已提交分支合同，解决必要冲突。
- Inputs and prerequisites: T-001，source59faf/target83e46完整实际差异。
- Scope or files: merge实际变更/冲突路径、必要目录data准备，不能编辑原dirty工作。
- Expected output: 可编译/可测试的candidate与冲突处理证据。
- Dependencies: T-001.
- Execution steps: no-commit三方merge；逐个完整读冲突/consumer，最小整合；必要locks保留MCP和TS7记录，禁止清无关条目。
- Acceptance criteria: 没有unmerged paths；source/target功能同时保留，不盲选版本；公开model-data来源明确。
- Verification method: actual diff、冲突清单、文件scope/data语义对照。
- Validation evidence: 三方merge exit1仅LEARNS/rootpackage两冲突，完整context与父source/target已读；保留target MCP build顺序+source tsc，LEARNS两方append全部保留。verify-merge-composition实证RootManifest精确union、lock20+/9-/5changes均source原compiler记录、MCP/runtime locks与target byte-identical，recovery/MCP/child核心和model/toolchain核心各自parent内容保留，unmerged0。公开schema4数据只从verifiedsource复制、真实validator通过；初完整rootcheck1479files通过（1formatter-only targetcollab缩进）。独立staticreview发现length-recovery/preparation逻辑交互，另T-006先RED修复，不把自动merge视为完整验收。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成运行环境与定向门禁

- Status: done
- Owner: coordinator
- Objective: 私有deps/data环境下验证合并后的安全/模型/工具链及构建消费。
- Inputs and prerequisites: T-002 candidate、T-006/T-007交互修复；已先建立环境/initialcheck，后续最终gates等待两项。
- Scope or files: private node_modules/ignoreddata/dist/temp artifacts与实际回归/最小修复。
- Expected output: currentcandidate实际tests/check/build/pkg证据。
- Dependencies: T-002, T-006, T-007.
- Execution steps: ignore-scripts/正常age gate私有环境；定向tests；rootcheck后核对formatter范围；offlinebuild/tempconsumer及数据proof。
- Acceptance criteria: 新/修改tests实际运行，不能用旧source259passes作为合并后证据；不读取真实凭证/API。
- Verification method: V-001..V-004，完整命令/log与exit结果。
- Validation evidence: 父新candidate AI25files444pass/3credential skip、MCP library5files43、scripts74、post-real-build normal pkg config coding57files902、agent13files175全部通过；root1479 No fixes/TS7/browser/deps/两runtime locks checks通过。offlinebuild包括MCP tsc/private bundle/LICENSES实际通过。公开data真实validator+全部39provider非type字段1523chat45image保真、原stamp/hash不变；509classes/232derived inheritedfield审查无新shadow。pack12bundles2785files、全新outside2-day/ignore-scripts完全offlineinstall121packages、CLI/help/version/list与bareSDKfaux/images/static+dynamicheaders/helper/compat/jiti及MCP publicroot/oauth/testing/in-memory RPC/licenses烟测通过，无workspace resolver/NODE_PATH/真实provider。只有原targetcollab2块缩进由rootformatter触及，semantic unchanged已父diff核对，记录并合入scope。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 独立审查与candidate提交

- Status: done
- Owner: coordinator
- Objective: 接受独立审查并提交明确merge candidate。
- Inputs and prerequisites: T-003 gates、source冻结完整冲突解法。
- Scope or files: parent提供只读diff/snapshots、read-only child review、本authority/Git merge commit。
- Expected output: verified integration commit，base/source ancestry可核验。
- Dependencies: T-003.
- Execution steps: read-only allowlist独立审查，检查actual findings/补guard，父重跑有效最小gate，commit有两parent且无额外stage。
- Acceptance criteria: 两branch ancestry保留；无未解决review defect、无混入其他owner未提交路径。
- Verification method: 源码/diff/review/gates、git show parents/status、doc validator。
- Validation evidence: 只read工具independent seam3e4fe671+continuity71f7896b和toolingdf351cf4+continuitya384c3c9完成，唯一length交互已T-006因果修复、无剩余actionable。父全tests/check/build/pack/outsideSDK+MCP+images门禁T-003真实GREEN，最终两个parentdiff和resolverfix patch更新不再用旧snapshot。explicit仅5owned integration修复/formatter路径+新authority补入Git自动merge index，PI_ALLOW_LOCKFILE_CHANGE=1提交144paths merge674320ff78d0284bbb92c3f6d726368c084d9d8c；两个parents为精确83e46/59faf，ancestor gates通过，privateclean。源码归档两次actualarchived-validator+cmp通过，SHA171bd4d653c9d9882b6b0440fe1ca0d8a2a8e45f792c4a19cd3adc0b52801060；从未stage原未提交CodeMode。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 原my-pi漂移门禁与交付

- Status: blocked
- Owner: coordinator
- Objective: 真正安全更新my-pi并验证原运行环境。
- Inputs and prerequisites: T-004 verified candidate、原最新committed HEAD/clean/public-data门禁。
- Scope or files: 原目录ff-only与明确私有来源deps/data hydration，本authority。
- Expected output: my-pi实际包含candidate，或明确blocked而不覆盖现场。
- Dependencies: T-004.
- Execution steps: 原fresh状态核对；如有新commits先保留整合/补测；dirty时停；clean精确head/data gates后ff-only及必需runtime smoke/check。
- Acceptance criteria: 原未提交工作没有被stash/覆盖/代提交；数据refresh没有丢失；实际更新才done。
- Verification method: readonly fresh gate、ff输出、original runtime关键check及source/data/lock proofs。
- Validation evidence: finalreadonly original-delivery-gate.json：HEAD仍83e46/my-pi、71dirty paths（继续变化），40公开ignored模型JSON逐文件SHA与初始baseline完全相同，无读取错误，originalWritten=false。candidate674320ff及两parents已verified，code/全部gates完成；但clean gate不满足，未执行原merge/ff/hydration。
- Blocker: 并发CodeMode owner未完成/提交，原71dirty路径与agent/session/types/deps/build/SDK等重叠，不能覆盖或代提交。
- Unblock condition: 并发owner提交并稳定原树，固定最新已提交base并纳入candidate/重测，然后clean/HEAD/public-data gate全部通过。

### [x] T-006 — 自动合并的text-only length恢复投影回归

- Status: done
- Owner: /root/fix-my-pi-length-integration
- Objective: 保留target故意从live恢复投影移除的零tool length assistant，不被source request preparation canonical重建复活。
- Inputs and prerequisites: T-002、independent read-only review3e4fe671静态因果路径与父helper/targetresume代码核对。
- Scope or files: 私有agent-session.ts两个reconcile predicate与直接b824062c recovery driver回归；不得改原目录/其他source/locks/authority。
- Expected output: provider outgoing截断正文缺失、canonical entry仍在、exact1fresh request/no tool dispatch；仍live的length/tool exchange保留。
- Dependencies: T-002.
- Execution steps: existingzero-call length guard补provider-context断言先RED；最小两个predicate修复；原prepare+recovery/MCP邻域与type实际验证。
- Acceptance criteria: 因果RED->GREEN，不blanket删除length历史或仍需要续接的tool exchange，不引入新的上下文迁移。
- Verification method: 指定faux guard/包根tests、父gate/continuityreview。
- Validation evidence: child2paths冻结，父完整报告/patch/新guard与actual1RED/2pass、late predicate ablation RED日志已读；两predicate新增absent-live length排除，canonical/live-tool长度exchange保持。child35modified+119neighbors；父实际offlinebuild后normal package config 57files902/902（含全35driver guard）及agent13files175/175通过，最新rootcheck1479 No fixes全部通过。read-only continuity71f7896b确认原finding解决，无新actionable；未把childmissingdist/importfixture失误当productRED。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 新MCP消费的Node源码resolver集成

- Status: done
- Owner: coordinator
- Objective: 将target已提交MCP公开exports纳入source的Node源码解析路径，避免CLI要求旧dist。
- Inputs and prerequisites: T-002；actual脚本测试73pass/1fail，CLI preloader错误指向不存在mcp/dist/index.js。
- Scope or files: scripts/source-resolver.mjs及test直接MCP root/oauth/testing guards；不改其他source/CoreCodeMode/原目录。
- Expected output: MCP public entry源路径正确、source launcher在spaces/#/?/%路径真实通过，negative/private aliases仍拒绝。
- Dependencies: T-002.
- Execution steps: 补公开MCP mapping guard先RED；仅扩已提交workspaceMCP目录；重跑全指定script tests与sourceCLI。
- Acceptance criteria: 不是先build MCP dist掩盖source能力；只public manifest导出，未知/private/path traversal仍交给Node。
- Verification method: node:test、源码help/version/list、rootcheck。
- Validation evidence: 父完整读resolver/test/两launcher/MCPmanifest；公开MCP root/oauth/testing mapping guard先RED（错误dist路径），仅manifest目录列表增mcp一词。指定74script cases全GREEN，包括sourceCLI version经spaces/#/?/%preloader、public/private/traversal/singleton、MCP打包licenses/无src、catalog/archive guards。最终sourceCLI与rootcheck留T-003综合gate，未提前构建MCPdist掩盖问题。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001：指定agent prepare/loop/recovery/authority和coding session prepare/queue/compaction/checkpoint/recovery/collaboration，mock/faux、包根运行，不完整Vitest。
- V-002：AI与coding model runtime/image/store/catalog/default/auth/extensions；新增MCP/recovery交互的实际受影响指定tests，只in-memory/owned localhost fixtures。
- V-003：完整npm run check；核formatter范围、locks/diff/doc validator；实际TS7/source CLI/native recovery loader。
- V-004：offlinebuild、临时pack/install --ignore-scripts/正常2-day、仓库外CLI/public SDK/image/MCP消费和自包含sourcearchive的必要子集。
- 所有Node测试用上一轮read-before-use离线runner或新的审查等价runner，private HOME，移除真实provider credentials/real-optins/NODE_OPTIONS/NODE_PATH，明确PI_OFFLINE/local-LLM/AWS元数据禁用。旧Node22未知操作不重试；只Node24证据，不声明平台22/Windows已测。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 原CodeMode未提交内容不是已提交baseline；不能在它上面伪装已完成merge或代其他ownercommit。
- target新增MCP/recovery与请求/session/build/locks等重叠；自然merge成功不证明行为正确，必须跨合同回归和独立审查。
- source schema4基于ignored model-data，Git checkout/merge不会携带它；只用保存的公开基线/validatedsnapshot，不网络刷新或覆盖原并发数据。
- 原新提交/dirty持续漂移时交付必须停；用户要求merge不等于批准stash/reset/force或丢弃别人工作。
- Node22仍paused/unknown，platform未验证限制继续保留，不能从当前路径缺失或无进程推断终态。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 用户新请求merge到my-pi；完整读取历史authority和原AGENTS。readonly原HEAD已83e46、source59faf干净，原dirty CodeMode且观察间继续新增文件变化；新T-005blocked。
- 2026-10-11: 旧Node22仅只读检查当前目录/进程，证据不足不reconcile、不重复操作。新的private integration worktree从83e46创建；T-001done、T-002in_progress。原目录无写入/branch切换/stash/代提交。

- 2026-10-11: T-002 done：仅2实际冲突按union解决，compilerlock与各方核心byte proofs通过；source公开data复制validator通过。私有npm ci首次offline因undici-types7.16cache缺失ENOTCACHED，随后正常2-day/ignore-scripts ci339packages成功，无repo lock变化；T-003环境/initialrootcheck1479通过，formatter仅targetcollab缩进待记录。readonly child仅read工具审查autoMerge发现长度恢复投影复活，新增T-006先RED最小修复；root最终gates/交付等待它，原CodeMode现场仍不写。

- 2026-10-11: read-only reviewer tools ceiling不可扩为writer，followup被tools_unavailable明确拒绝、未启动实现；保留其独立review，T-006由新的限定writer fix-my-pi-length-integration承担，仅2路径。无原目录操作。

- 2026-10-11: 父AI指定25files444pass/3credential skip、MCP library5files43pass；指定scripts74cases73pass/1fail定位sourceResolver固定package列表遗漏新target mcp，source launcher误落旧dist缺失。新增T-007明确source publicMCP guard先RED最小适配；不以build旧dist掩盖问题。T-006writer仅session/test，两任务无写入重叠。

- 2026-10-11: T-007done，actualMCP URL mapping RED->GREEN、全部74node scripts通过；parent公开modeldata proof1523/45/39provider及原stamp/hash/非type字段保真，TS7 inheritedfield审查509classes/232derived唯一cause重叠为既有HarnessFault显式赋值，无新MCP shadow发现。tooling独立review仅read工具进行中；T-006writer在做明确语义修复，其他source冻结。

- 2026-10-11: T-006done：父已读2file真实修复/guard/RED；normal包配置post-real-build 57codingfiles902tests与13agentfiles175tests均通过、rootcheck1479 No fixes。请求独立continuity71f7896b与toolingread-only5ebbf142均无actionable，旧proofpatch路径更新留T-004最终capture。T-003 actual build包含MCP tsc及licenses materialization通过；进入12bundles私有pack/install/仓库外SDK+MCP/image smoke。原交付仍blocked，尚未动original。

- 2026-10-11: T-003done：新candidate各包定向tests/check/build/data/class audit/12bundlepack/全新offlineinstall/outsideSDK+MCP/image smoke全部通过。T-004in_progress，独立seam/continuity和tooling review均无未解决finding，finalpatch已重捕获（旧patch源resolver遗漏的证据gap已更正）。readonlyoriginal仍83e46且未提交CodeMode路径继续增多/重叠，T-005保持blocked；不能把privatecandidate成功说成my-pi已更新。

- 2026-10-11: T-004done，merge候选674320ff双parents83e46+59faf已提交并privateclean；包含目标MCP/recovery和源三阶段全部内容，仅2逻辑/入口交互最小修复。actual源码归档2次validator+cmp通过。最终originalreadonly仍83e46/my-pi/71dirty且继续变化，公开40data baseline hashes相同；原写入/ff/hydration均未执行，T-005仍blocked。候选可交付但不虚称my-pi已合并，overall blocked / final partial，等并发owner提交并稳定后重新固定target和补测。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/002/003/004/006/007全部done；verified merge candidate674320ff78d0284bbb92c3f6d726368c084d9d8c在branch integrate/selective-migration-my-pi-20261011 / worktree /tmp/easy-pi-my-pi-integration-20261011。AI444pass/3credential skip、coding902、agent175、MCP43、scripts74、root1479No fixes、offlinebuild、data1523/45全保真、outside2-day/ignore-scripts完全offlineinstall及CLI/SDK/faux/image/dynamicheaders/helper/compat/jiti/MCPin-memory/license smoke均通过；actual源码归档deterministic。仅T-005因original71dirty CodeMode未交付。
- Limitations: my-pi仍83e46且未更新，不stash/reset/覆盖/代提交并发工作；后续owner提交后须固定新base纳入candidate/重测，再clean/HEAD/data gate ff-only。Node22未知下载paused未重试，22/Windows/Bun/liveprovider/liveMCPserver未实测；无真实provider凭证/API/paidmodel或push/release。旧完整迁移authority是已完成历史，新状态仅本文。
