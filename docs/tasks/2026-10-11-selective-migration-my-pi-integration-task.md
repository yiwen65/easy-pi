# Task Plan: 将选择性架构迁移安全集成到 my-pi

- Created: 2026-10-11
- Workspace: /tmp/easy-pi-my-pi-integration-20261011
- Mode: execute
- Overall status: in_progress
- Source: 用户新请求「合并到 my-pi」，覆盖上一轮仅隔离交付的决定；不授权丢弃/代提交其他 session 的未提交改动。

<!-- task-doc-section:background-goal -->
## Background and goal

将已验收三阶段架构迁移集成到当前 my-pi，保留目标分支已提交的 MCP、恢复 certainty/branch ownership 和工作流改动；同时不影响正在写入原目录的 CodeMode 工作。本文件是此新集成执行的唯一 authority。上一轮 docs/tasks/2026-10-11-selective-architecture-migration-task.md 保持已完成历史记录，不改写其验收结果。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- Source: integrate/selective-migration-20261011 @ 59faf2409bd9c48c738e271582bb8ba298d4e2fb；三阶段 source commits 14164effe、bd7b5a681、817d3d782，Moonshot 已批准修复 6bb392b2a。
- Initial target: my-pi @ 83e46ae82c692c49112974e427656f89b19fbf70；first verified merge674320ff已保留source。
- Current delivery target: my-pi @ 40610c758f6604ba50556a0a00ac6cea15e55c27；当前clean，新增CodeMode a2fd4ac0d与subagent progress 6dff658b4及其验收docs。T-008/T-009先保留这些已提交内容并补集成/重测，不能用旧674320ff直接ff覆盖其新commits。
- Private integration branch/worktree: integrate/selective-migration-my-pi-20261011 / /tmp/easy-pi-my-pi-integration-20261011。
- Evidence: /tmp/pi-selective-migration-evidence-20261011/my-pi-integration/；不是任务状态源。
- 保留三阶段请求准备、TS7/Node、chat/image全部原合同与SDK/cache/pricing/defaults，以及target已提交MCP/恢复/CodeMode durable nested authority/subagent非终态progress及interrupt handoff、writer ownership/unknown-effect reconciliation、easy-pi/epi/.epi/jiti/locks/独立打包。CodeMode是保留target既有功能，不是重做本迁移原排除的上游新功能。
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
| F-007 | 用户继续时my-pi已clean且HEAD40610c758，四新增commits保留CodeMode/progress；先前dirty blocker已解除但candidate需纳入新base。 | readonly status空、log/diff 83e46..40610：132paths/13344新增行；private仍537aeae5clean。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumptions: 无；旧tests/check结果不等于合并后验证。
- Decision Q-001: 「合并到my-pi」授权保留当前已提交target内容集成，不授予处理其他owner未提交文件的权限。
- Q-002 resolved: 并发owner已提交并clean；按用户继续要求保留40610完整新baseline再集成。交付前仍需fresh HEAD/clean/data gates；新增dirty或未知差异重新阻断。

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

- Dependency graph: T-001 -> T-002 -> {T-006,T-007}；{T-002,T-006,T-007} -> T-003 -> T-004 -> {T-010,T-011}；{T-004,T-010,T-011} -> T-004 -> T-012；{T-008,T-012} -> T-013；{T-008,T-012,T-013} -> T-009；{T-004,T-009} -> T-005。
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

- Status: in_progress
- Owner: coordinator
- Objective: 真正安全更新my-pi并验证原运行环境。
- Inputs and prerequisites: T-004 verified candidate、原最新committed HEAD/clean/public-data门禁。
- Scope or files: 原目录ff-only与明确私有来源deps/data hydration，本authority。
- Expected output: my-pi实际包含candidate，或明确blocked而不覆盖现场。
- Dependencies: T-004, T-009.
- Execution steps: 原fresh状态核对；如有新commits先保留整合/补测；dirty时停；clean精确head/data gates后ff-only及必需runtime smoke/check。
- Acceptance criteria: 原未提交工作没有被stash/覆盖/代提交；数据refresh没有丢失；实际更新才done。
- Verification method: readonly fresh gate、ff输出、original runtime关键check及source/data/lock proofs。
- Validation evidence: 历史firstcandidate原83e46/71dirty gate未交付保留；最新latest-target/original-delivery-gate.json实际HEAD40610/my-pi、dirty0、40publicdata baselineSHA全部相同、originalWritten=false且fixedBaseCleanDeliveryGate=true。原仍未ff/hydration；等待T-009并在交付紧前fresh复核，不能用此较早clean替代最终门禁。
- Blocker: None.
- Unblock condition: None.

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

### [x] T-008 — 纳入已提交CodeMode与subagent progress新target

- Status: done
- Owner: coordinator
- Objective: 在private537aeae5候选上保留新40610target所有已提交功能，处理必要冲突/consumer差异。
- Inputs and prerequisites: T-004、F-007/user继续、精确40610clean观察。
- Scope or files: 实际三方merge冲突/新consumer，数据/locks/root脚本，原目录readonly到最终gate。
- Expected output: 同时含source59faf/target40610 ancestry的candidate及最小解法。
- Dependencies: T-004, T-010, T-011.
- Execution steps: no-commit merge40610；完整读实际冲突和consumer，保留CodeMode nested tool metadata/authority/cancel/progress、sourceprepare/TS7/image；normal ignore-scripts锁/私有deps；publicdata hash不刷新。
- Acceptance criteria: 不盲选旧版本、不移除CodeMode/progress、不扩大API/权限；根base和新增包TS7/source消费一致。
- Verification method: 合并diff/context、type/check、必要机制guard和locks/data proof。
- Validation evidence: 4冲突全部union且unmerged0；composition-proof.json actual exactroot target+source check/generator/TS7与compilerlock20+/9-/5变化，runtime locks/CodeMode/MCP manifests及progress/controller/store/host核心byte-identical target40610，modelRuntime/composer/baseTSconfig exactsource。完整sourceprepare等于candidate+仅2livefilter；targetnested/durablehooks exacttarget。rootcheck1521 No fixes/TS7/browser/shrinkwrap/install-lock全部实际通过；parentunfiltered8files126tests GREEN含源码killedtool恢复/childprodspawn。LEARNS完整两方lesson union，server type/nested exactfield门禁通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-009 — 新target跨合同验证、审查与提交

- Status: in_progress
- Owner: coordinator
- Objective: 40610+三阶段合并后实际验证nestedCodeMode/subagentprogress与请求/恢复/模型/工具链并提交。
- Inputs and prerequisites: T-008candidate、T-012精确protocol fixture修正。
- Scope or files: private受控tests/check/build/pkg artifacts、冻结只读review、mergecommit/本文。
- Expected output: 新base完整verified candidate，可ff-only交付。
- Dependencies: T-008, T-012, T-013.
- Execution steps: modified/new指定offline tests和相关回归；rootcheck范围；source/built/offlinebuild和installedSDK/CodeMode/MCP/image/progress必要subset；read-only工具独立review；保留parents commit。
- Acceptance criteria: 当下code实际gates通过，不复用83e46旧902tests作为新base证据；所有target/source核心合同保留。
- Verification method: V-001..V-004 affected subset、parentdiff/ancestry/stage/dataproofs、docvalidator。
- Validation evidence: latesttarget最终private coding49files718、CodeMode6files185、agent13files147、subagent7files182、AI21files375+3credential skip、MCP5files43、server1file10、scripts77全部实际GREEN；root1521 No fixes/deps/shrinkwrap/install-lock/TS7/browser、offlinebuild、data1523/45/39全部non-type/stamp/hash保真、519/238class inheritedfield audit无新shadow、13bundle2893filepack/外部normal2dayignore-scripts install122packages/CLI+SDK+images+MCP+CodeMode实际worker/portableWASM/store/licenses/jiti smoke通过。freshreadonlyrequestea96a158/toolchain671e5450/fixtured81a3d18 review无剩余actionable，ownedcomposition/snapshot/diffcheck通过；candidate Git commit/ancestry与sourcearchive待执行，不提前done。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — CodeMode live-tool过滤与请求准备边界冲突

- Status: done
- Owner: /root/merge-codemode-request-boundary
- Objective: 解决AgentSession真实冲突，保留source每请求prepare/cursor/length恢复和target live _isToolAllowed过滤，防止nested/权限变化泄漏到provider工具快照。
- Inputs and prerequisites: T-004verifiedfirstcandidate、target40610、actualCC冲突上下文。
- Scope or files: 仅privateagent-session.ts冲突及直接prepare/CodeMode相关必要guard；其他conflicts/locks/authority归coordinator。
- Expected output: 冻结union实现，current allowed tools在input监听和callback后每次实际request绑定前生效，targetnested execution/recovery authority不退化。
- Dependencies: T-004.
- Execution steps: 完整读current/parents相关模块，拆解冲突intent；最小union；指定guard/source-type验证，源码入口不偷用旧dist。
- Acceptance criteria: prepare每providercall保留；显式context owner/newtail/length omitted/canonical历史合同保留；nested/MCP/code toolscope current过滤不削弱；不改数据/default/价格。
- Verification method: actualdiff/type/定向faux prepare/CodeMode/nested/MCP tests，父最小有效复跑及独立review。
- Validation evidence: child3paths/causal3RED、initial-only1RED/final-only2RED已父完整报告/patch核对，parent exactcomposition passed（candidate整个prepare保留+两filter、targetnested group/durablehooks exact），父unfiltered8files126/126 GREEN包含child4cases和killedsource工具恢复；maxWorkers2不改timeout/断言，保留先前124pass/2startuptimeout证据。rootcheck1521实际GREEN No fixes；fresh read-only reviewer ea96a158无actionable，已父读路径/因果scope与gaps。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — committedCodeMode公开source入口补适配

- Status: done
- Owner: coordinator
- Objective: T-007同机制纳入新target codemode package公开exports，source模式不依赖旧dist，包括worker/portable入口。
- Inputs and prerequisites: T-004source resolver已manifest-only，target40610新codemode manifest与private quickjs-wasi341pkg CI完成。
- Scope or files: source-resolver.mjs/test两个路径；无actor/root权限/包runtime API扩展。
- Expected output: Root/declarations/source/portable/cloudflare/worker正确canonical源URL；private/traversal拒绝不变。
- Dependencies: T-004.
- Execution steps: add6explicit publicentryguard firstRED；只目录列表增加codemode；指定script/sourceURL与sourceCLI/CodeMode smoke验证。
- Acceptance criteria: 不先build dist掩盖源码缺失，不新增catchall路径或未知privateexports。
- Verification method: node:test/rootcheck与新base打包/源码CLI门禁。
- Validation evidence: 6个公开entry guard实际RED指向codemode/dist/index.js，生产只在manifest目录列表增codemode；父source-resolver全6tests实际GREEN，包括全部公开URL/旧private和traversal拒绝、external/relative不改写、encoded symlink真实CLI。latest-target/codemode-source-resolver-{red,green}.log；不先build掩盖源码问题，native recovery无过滤复跑留T-009。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — CodeMode child fixture保留结构化progress协议工具

- Status: done
- Owner: coordinator
- Objective: 修正target CodeMode fixture早于其progress提交的精确tool-list期待，不删除已提交协议功能或削弱普通delegated scope guard。
- Inputs and prerequisites: 冻结T-010 child报告2个tool-list失败、实际target host currentTools/liveToolAccessCheck及progress合同。
- Scope or files: 仅agent-session-codemode-child.test.ts三个exact expectations与解释comment；不改host/普通权限/资源/rootteam断言。
- Expected output: exact deliver_result/report_progress/codemode及具体script grant列表断言，真实child/prod spawn全文件通过。
- Dependencies: T-004.
- Execution steps: 读取完整fixture及host结构化protocol gating；最小expectation更新；保持denied catalog/binding/RPC/PID/config漂移断言；unfiltered复跑。
- Acceptance criteria: 普通工具没有新增授权，trustedprogress保留，全部4child tests实际通过，不能只skip失败case。
- Verification method: 原child unfilteredRED、父全文件/相关seam actualGREEN与独立只读review。
- Validation evidence: 原2case exacttool-list RED与targethost structuralprogress代码核对；最小3expectations加report_progress，普通denied catalog/bindings/RPC/PID/config漂移/revocation原断言全部保留。父unfiltered8files126GREEN覆盖全4childcase（真实in-memory/ownedstdio/prodspawn），independent ea96a158源码/diff确认普通权限未扩，rootcheck No fixes。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — MCP/progress与live-filter既有fixture合同漂移

- Status: done
- Owner: /root/fix-latest-child-fixtures
- Objective: 以新目标可信progress结构工具和请求前current-authority过滤为合同，修正真实矩阵暴露的旧fixture期待，不能弱化executiongate/资源/配置漂移断言。
- Inputs and prerequisites: T-008/T-012已完成，49file矩阵715pass/3fail证据；2个MCP exactlist遗漏report_progress，1个trustedhost重广告旧schema被正确request过滤导致faux callback内部断言失败。
- Scope or files: 仅private test/pi-collaboration-tools.test.ts与test/suite/agent-session-mcp-child.test.ts；若发现productdefect先报告，不改源码。
- Expected output: 证实因果链、最小fixtures修正、provider未广告与maliciouscall拒绝/零effect、真实child全部通过，冻结报告。
- Dependencies: T-008, T-012.
- Execution steps: 全读两fixtures/相关host/session gate；重现3旧期待RED；保留semantic security oracle并增加request过滤断言；定向GREEN，无skip/timeout放宽。
- Acceptance criteria: 新结构工具保留但普通grant不扩；恶意请求不能产生写入，断言检查actualnot_started/error而非测试失败assistant；MCP resource/RPC/config/PID拒绝合同不变。
- Verification method: exactRED/最小diff、faux/provider及ownedstdio包根两文件全tests、父矩阵有效复跑/独立review。
- Validation evidence: 父完整read报告/2patch及直接enclosingcases，beforeRED37pass3fail、finalchild54GREEN与父最终49codingfiles718/718 GREEN。root1521No fixes实际passed、cmp冻结两个after snapshots一致。restrictedinject确实不广告，仍主动恶意call要求exactTool bash not found/not_started/零handler/noeffect/completed；另已advertised合法工具在binding后撤权+host恢复schema要求exactancestrydeny/not_started/零nativebeforedispatch/noeffect/completed，安全oracle更强未弱化。fresh只readindependent d81a3d18报告无actionable、父已读causalpath/gaps。
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

- 先前CodeMode dirty现场已由owner提交为40610，当前保留完整committed baseline；新dirty仍不得代提交/覆盖，交付前重新门禁。
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

- 2026-10-11: 用户继续，readonlyoriginal now40610clean，CodeMode/progress已提交，解除dirty阻塞但新base不可跳过；更新F-007，T-005blocked->in_progress，新增T-008in_progress/T-009pending保留新target与补验证，beforeff原仍readonly。完整重新读authority/AGENTS、boundedLEARN及新delta。Node22仍paused/unknown未重试。

- 2026-10-11: private merge40610 exit1有4真实冲突：rootpackage build/check、LEARNS尾部、AgentSession tools-filter/prepareRequest、server遗漏字段comment。父完整读并union前三个非session冲突（保留13bundle新构建/TS7、两方lessons、chat discriminator+structured/nested certainty）；AgentSessionT-010限定writer串行处理，其他source冻结待gates。原仍readonlyclean40610，不能提前ff。

- 2026-10-11: private正常2-day/ignore-scripts npm ci341packages完成，包含已提交quickjs-wasi3.6.2，未改repo locks。新增T-011补新target CodeMode公开source paths，6entries guard先RED后单词目录增补；T-010writer仅session/guard且parentresolver路径不重叠，root formatter等冻结后运行。

- 2026-10-11: 恢复暂停记录后只读刷新private pendingmerge537aeae5/40610及child冻结报告；Node22目录仍缺失，不作为终态、不重试。历史read-only批次无终态回执，不推断原call成功；独立read完成当前必要context。T-011 actualRED->GREEN6cases。T-010三路径冻结报告/causalpatch已父读，both过滤保留，parent unfiltered8file124pass/2fail仅MCP discovery startup等待，不弱化timeout；降低worker数复跑区分并发load。新增T-012只修target早期CodeMode fixture三个exactprogress期待。原目录仍未写。

- 2026-10-11: T-010/011/012 accepteddone、T-008done，父真实unfiltered8files126pass（maxWorkers2，先前默认并发MCPstartup wait失败保留而非丢弃）；所有文本conflicts解决、exactunion/20+/9-/5compilerlock及targetruntime/progress核心proof通过。rootcheck1521 No fixes。fresh readonly requestea96a158/toolchain671e5450 review均无actionable、执行gaps由parent补，T-009in_progress开始offlinebuild/newtarget全受影响门禁与独立installedconsumer。git diff --check仅target原licensedquickjs-ng/wasi-sdk空白不动合法第三方文件，owned/集成diff无新增whitespace错误。

- 2026-10-11: latesttarget fullrootcheck/offlinebuild实际GREEN，CodeMode6files185/agent13files147/subagent7files182/AI21files375+3credential skip完成。coding49files715pass/3fail暴露另2MCP fixture progress期待及1旧trustedhost provider广告假设，新增T-013限定2fixture writer，不把test内部assertion误作产品执行权限错误。13bundle2893filepack完成；newoutside offlineinstall ENOTCACHED quickjs metadata（terminalfail已读），随后仅正常2day/ignore-scripts registry install，不声称完全offline安装。原fresh40610clean/40datahash gate满足仍未写，必须最后再查。

- 2026-10-11: T-013首childturn无最终report并failed；只读已读retainedresult、两个before/current cmp0证明未实现改动，不重复未知effect，同childcontinuousfollowup完成限定2files冻结report/causal37pass3fail->54GREEN。父完整patch/report核对：restrictedprebind只改正确preparedadvertisement，仍主动恶意调用精确notfound/not_started/零handler；独立alreadybound工具撤权case补rawschema回灌仍精确ancestrydeny/not_started/零native dispatch，无security oracle删除。rootformatter/49coding最终门禁与freshreadonlyreview进行中。installedsmoke initial硬编码quickjs路径错因npmhoist（实际externalnode_modules），仅证据脚本改publicimport.meta.resolve后完整烟测GREEN，产品源码未变；不将fixture错误包装为productfix。classaudit519/238derived无新shadow（唯一existingHarnessFault.cause）。

- 2026-10-11: T-013done，父final49files718GREEN/root1521No fixes、freeze cmp和exactunionproof通过，freshreadonlyfixtured81a3d18无actionable。T-009所有newtarget运行门禁/pack/outsideinstalledsyntheticchecks已完成，进入explicitownedstage与二parentmergecommit/源码归档；T-005仍最终fresh gate/ff/hydration前，original从未写。历史paused Node22仍无terminalrecord，read-only interruptedbatches亦不假定原call已完成，不使用缺失当reconciliation证据。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 历史T-001/002/003/004/006/007done与firstcandidate674320ff保持已完成；新T-008/010/011/012done。当前private537aeae5+MERGE_HEAD40610冲突全解决、exactunion/compilerlock/runtime/data proof通过，root1521No fixes/offlinebuild/codeMode185/agent147/subagent182/AI375+3credential skip/MCP43/server10/scripts77通过；13bundle2893filepack及新outside正常2-day/ignore-scripts install122packages、CLI/SDK/faux/image/static+dynamicheaders/MCPin-memory/CodeMode实际publicworker+portable WASM/store/licenses/jiti smoke通过。T-013已验收done（child54/parent49coding718/independentreview）且最终rootcheckNo fixes通过；T-009candidate commit/ancestry/源码归档待完成，T-005最终original gate/ff/hydration未执行。
- Limitations: original my-pi最后只读40610clean且public40data不变，仍未更新。新candidate不能复用firstcandidate旧902tests/源码归档证据；offlineinstall首次quickjsmetadata ENOTCACHED后normalage install通过，烟测本身无provider网络，不能宣称这次安装完全离线。Node22未知下载paused不重试，22/Windows/Bun/liveprovider/liveexternalMCP未实测；无真实provider凭证/API/paidmodel、push/release。历史完整迁移authority不改写，本文件唯一当前状态。
