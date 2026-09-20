# Task Plan: Computer 子系统分阶段实施

- Created: 2026-09-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: /Users/w/Projects/easy-pi/docs/EASY_PI_COMPUTER_IMPLEMENTATION_PLAN.md；用户已确认执行契约。

<!-- task-doc-section:background-goal -->
## Background and goal

按方案先执行 P00，再依赖顺序完成最小可验证阶段。保留唯一 Agent loop、Full Access、扩展、子代理、压缩与队列语义。不以 fake 或静态审计冒充原生集成、真取消或桌面性能。

本文件是唯一任务状态源；`docs/implementation/computer/progress.md` 是本文件的阶段导航与证据索引，不另行维护竞争任务列表。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- **最新授权更新（2026-09-20，优先于以下历史限制）**：用户明确取消所引“No real model calls, publishing/push or additional commits since0d696a1f3”约束，允许任务必要的真实provider测试使用`gpt-6-astra`、推理强度`low`，允许阶段性commit，取消所引publishing/push禁止条款。旧qd/kmodel_latest high批准保留，但后续必要真实验证优先采用本次指定模型；调用前核验实际provider/model配置，不猜endpoint或静默换模型。常规回归继续无真实API；真实测试必须显式opt-in、有界、定向，凭据不打印/持久化。历史“零调用/未push/HEAD”是当时事实，不再作为禁止推进条件。外部发布如实际需要仍按仓库发布流程、明确目标和验证结果执行，不自动推送无关并发修改。

- **D65恢复及持续交付批准（2026-09-19T18:13Z）**：用户在明确D65缺少完整资源close、需单独批准恢复的说明后回复“批准执行，后续默认批准所有权限，请完成目标并交付才停止”。本次执行一次同boot行政D65→C65：先私有测试、固定输入/boot/当前完整image空集及canonical身份/排他锁验证，归档fsync后同inode同代际仅改状态字节；保留旧profile/raw、不补造旧terminal。继续P05–P08的必要开发/构建/验证不重复权限询问；不是删除授权/焦点/终态门禁或未知动作自动重放。新dirty代际仍需独立证据与明确行政处置记录，不把本次helper变成产品自动清锁机制。

- **D25单次同boot恢复授权（2026-09-19）**：用户明确批准在重新核验证据后，归档并同inode执行一次D25→C25行政恢复并继续，无需再次重启、不补造旧关闭回执。前提为已记录socket/group收敛、owner自然退出、当前完整稳定native image空集及修复输入/marker身份；不授权新失败反复清锁。
- **D24一次性恢复授权（2026-09-19）**：在prepare-live-2持久资源close隔离后，用户明确选择“批准，届时通知我重启”：先离线诊断/修复准备；由用户手动重启macOS并确认后，核验新boot、固定输入、canonical身份/排他锁，再归档原D24并同inode/同代际一次性D24→C24恢复。不是旧资源terminal证明，不授权无限恢复/重复未知动作。该授权已在确认新boot后执行一次D24→C24（20私有case与全部前置通过）；现已消耗，不覆盖随后D25。
- **最新目标导向授权（2026-09-19T08:02Z）**：用户先选择批准官方固定归档CfT信任方式，随后明确“批准所有权限，任意版本，已完成computer use为目标导向，不要施加限制”。必要Computer Use依赖、浏览器版本和实施路线由coordinator自主审查选择，不再逐项请示或把自加的vendor-signature条件当无条件阻塞。本次CfT可按官方HTTPS固定归档及完整文件哈希准入，如实标记其ad-hoc/linker签名而非Google vendor签名；既有失败证据保留。仍以实际实现、真实验证和原计划交付为准，不伪造终态/性能，不以未验证当完成；保留并发工作、原始证据，不进行无关发布/push或没有任务必要性的个人内容访问。更早的具体版本/依赖白名单若与本条冲突，以本条自主选择授权为准。
- **当前持续执行授权（2026-09-18T19:13Z，优先于下述历史阶段/单次限制）**：用户要求除确实不可安全解决的硬阻碍外自动评估最佳方案、修复验证并继续，直至P03–P08交付；在完整持续执行约定后明确回复“完全放开权限给你操作，需要的系统授权请提前申请我审批”。不再逐阶段或每次可修复失败重新请示。允许必要Computer代码/测试/生成/打包及经审查的固定版本依赖变更，专用fixture观察/输入/截图/像素、独立空白browser profile和本地测试、必要SDK附带metadata/焦点行为；系统权限需要时尽早正常申请，由用户处理OS批准。仍不操作日常应用内容/个人登录资料、不发布/push、不覆盖并发工作；真实模型仅允许随后明确批准的qd/kmodel_latest（high）有界定向测试，其余真实模型/付费API不在范围。不得绕过门禁/删失败测试/重放未知动作；终态未知dirty lease不能自动清除，必要人工OS授权/重启属于硬阻碍。只在实际证据通过后逐阶段验收，未支持平台明确标注。
- 仅修改当前 pi 工作树，保留全部已有修改；Cua 只读。
- EASY_PI_BASE_REF=89b56ee70f86c98e0a81b8b7b90c09410b3ff772；实际基线包含当前未提交改动。
- CUA_BASE_REF=05f29785b508a4441ec3aa06c556a8e8b26c1d71。
- TARGET_PLATFORM=macOS arm64；宿主 macOS 26.5.1 (25F80)。
- ALLOW_DEPENDENCY_CHANGES=true（仅下述白名单）；ALLOW_GUI_TESTS=true（专用本地fixture及最新确认的必要SDK附带metadata/焦点行为，仍须权限准入）；ALLOW_REAL_APIS=false。此前各轮GUI均false，P00/P01历史执行时三个开关均false。
- 2026-09-18 用户“授权处理”：批准 @ubjs/core@0.31.0-3、@ubjs/node@0.31.0-3、uniffi-bindgen-react-native@0.31.0-3 及经审查的传递依赖，固定 Cargo.lock 的依赖准备，项目范围 Rust 1.97.1 + rustfmt，以及仅 Computer 必需的锁文件/受控构建。npm 默认 --ignore-scripts；必要生成/编译步骤先审查。不得顺带安装 Electron/Fleet 等未需内容，不改变全局默认工具链。
- 仍禁止真实模型调用、测试窗口外的内容观察/直接输入（仅允许下述已确认的SDK附带元数据读取与焦点恢复）、改Cua参考副本、手写生成绑定、权限绕过、JS超时伪取消、删除测试、重放未知动作；遇固定版本不可取得或扩大白名单要求时停止说明，不静默换版本。
- 2026-09-18 用户要求执行 T-007，并确认结构化执行边界：允许原生适配器接线及经审查的真实加载、ABI/版本、退出和非桌面契约测试；加载在独立进程进行但不是 OS sandbox。不创建桌面 driver、不观察/输入、不探测或申请 TCC、不使用真实模型；完整 T-007 仍受 GUI 验收门禁约束。
- 2026-09-18 用户再次要求执行T-007，选择“授权专用测试窗口”并确认完整执行契约：允许当前macOS桌面创建真实driver、检查TCC权限、运行专用本地测试窗口的观察/单次点击/取消/关闭与上游一致性验收，可能影响焦点。先核实宿主身份/UI loop/TCC；条件不成立就停止，权限缺失由用户手动处理，不自动申请/授予、不操作日常应用、不调用真实模型。只有实际满足平台门禁才标done。
- 2026-09-18 用户选择“授权当前桌面的附带行为”并确认更新后的执行约定：允许固定SDK内部读取其他应用/窗口元数据（含窗口标题）及恢复原前台应用焦点；实际AX内容观察、点击和取消测试仍只针对专用窗口。先核验行动进程宿主身份、权限与可见/响应的Stop控制面，不满足即停；无自动权限申请、真实模型API、私有skip或daemon切换。此授权不表示当前桌面已经隔离。
- 2026-09-18 用户进一步明确“请求权限，我来打开”：授权为当前宿主调用已审查的macOS辅助功能/屏幕录制request API，必要时打开对应系统设置；只触发正常授权流程，由用户手动开启。不自动点击同意、授予/重置TCC、改entitlement、切宿主或创建driver；旧轮“禁止申请”仅被本次明确请求局部替代。
- 2026-09-18 用户“执行 P03”：授权继续T-008宿主所有权、会话/祖先撤权、共享调度与原生取消/终态改造及相应验证。沿用固定依赖、pi内受控源码/生成构建、专用fixture GUI边界；不启动P04批执行或新增工具默认激活。未确认原生收敛时必须保留lease/隔离，不将P02 SDK settlement当终态。
- 2026-09-18 用户“解除阻碍并继续”后结构化确认：本次仅离线定位、最小修复和不访问桌面的回归验证；保留失败证据和dirty lease，不创建新桌面owner。具体lease恢复方案与再次fixture实测另行确认，不因P03授权直接清锁；P04/日常应用/真实模型仍不在范围。
- 2026-09-18 用户选择先重启，报告“已重启”，随后确认一次性恢复/fixture复测契约：先核验重启、修复输入、canonical存储身份/权限/排他锁；归档原D/1后，仅在独占非阻塞flock内同inode原位改C/1并fsync，不删除/重置代际。恢复显式放弃旧未知代际，不补发旧terminal证明。随后每个真实进程重新TCC/宿主/可见Stop准入，限定observe、session/process争用、一次后台click、cancel、clean close/successor。任何恢复或实测失败即停，只清理本实验子进程，保留dirty/失败证据，不自动再次恢复/重试。无P04、日常应用动作、截图、真实模型。
- 2026-09-18 后续用户明确批准真实模型测试：仅`qd/kmodel_latest`、推理强度`high`。常规回归/GUI native probe继续`ALLOW_REAL_APIS=false`及faux；仅实际需要的有界定向真实模型测试设置显式opt-in，凭据只经现有授权路径使用、不打印/持久化。不是对任意模型、全量e2e、费用无界测试或外部发布的许可。
- 会写文件的基线命令在 pi 内隔离快照运行，保持现有用户修改不变。不会 push 或发布。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | pi HEAD 与方案一致，分支 my-pi，有 22 个已修改/删除路径 | P00 开始前 git status --short / rev-parse HEAD |
| F-002 | Cua HEAD 与方案一致，分支 main，工作树干净 | git -C ../cua status --short / rev-parse HEAD |
| F-003 | check 自动写入文件，不能直接在脏工作树无保护运行 | package.json: biome check --write |
| F-004 | test.sh 使用空环境和独立 HOME，且不转发筛选参数 | 已完整读取 test.sh |
| F-005 | 本机有 Node v24.15.0、npm 11.12.1、rustc/cargo 1.95.0；node_modules 存在 | 版本命令及目录检查，均退出 0 |
| F-006 | 用户确认当前工作树、macOS arm64；初始三开关关闭，后续仅批准限定依赖/工具链与构建 | 结构化确认及“授权处理”回复 |
| F-007 | PATH 指向 Homebrew Rust 1.95.0；rustup 另有 stable/1.98.0，均报告 1.98.0 | rustup toolchain list -v / rustup run stable rustc --version / rustup run 1.98.0 rustc --version |
| F-008 | 当前共享树只读 TypeScript 检查通过，旧 TS2339 不能作为当前错误继续引用 | ./node_modules/.bin/tsgo --noEmit，exit 0；旧 27 失败仍只是固定 P00/P01 快照证据 |
| F-009 | T-016 新快照 build/check/test.sh 为 0/0/1，剩10失败；限定依赖和固定原生编译/生成已通过 | .artifacts/computer/p02/current-baseline/report.md、sdk-build/stage-native/bindings-check-retry/header-check/typescript-emit.log 与 .exit；该轮未 native load/GUI |
| F-010 | 本轮无 driver 的真实 SDK import 自然退出、标量 ABI 检查通过；ABI1.1.0、UniFFI30、109 checksum值一致 | .artifacts/computer/p02-connect/upstream-import-retry、abi-scalars 的日志/命令/exit；首次缩窄 PATH 缺 Node 为127，改用已观察绝对 Node24.15.0 路径后0；没有调用 driver/TCC 方法 |
| F-011 | native/computer可选adapter/loader及类型、非GUI测试通过；未接默认工具或P01 backend | p02-connect的native-contracts为26pass/1skip、native-load-test为1pass、adapter-types-retry为0；check/check为0及Computer回归32/32；独立review无可执行发现，coordinator已读源码/重跑检查/核对hash |
| F-012 | 本轮获准的无提示TCC preflight两项true，自然exit0；仍未创建driver/fixture或执行桌面观察/输入 | p02-gui/permissions.log、permissions-command.json；代码只调用currentMacOsPermissionStatus，约0.104秒；host-identity.json仅进程祖先/签名，不是kernel责任身份认证 |
| F-013 | 固定SDK的exact-window调用仍有全局元数据读取/焦点恢复路径，专用窗口不构成桌面隔离；用户随后明确授权这些附带行为 | p02-gui/fixture-audit.md与coordinator复读core/tool.rs:756–780,1828–1832,1932–1936；macOS windows.rs、click.rs、window_change_detector.rs、focus_steal.rs；结构化确认；未实际运行这些路径 |
| F-014 | 上轮无driver诊断Node进程TCC返回false/false并自然exit78；同PID的tccd日志识别AgentPort责任链。之前true/true不能作为后续进程准入 | p02-gui/attribution/{command.json,node.stdout,tcc.ndjson}，PID77212；log stream exit0，过滤仅自身诊断PID。responsible identifier为com.agentport.desktop.debug.c9d007c8147e，另有cached identity com.agentport.desktop；未诊断结果变化原因 |
| F-015 | 按用户明确要求调用一次requestMacOsPermissions；前后均Accessibility=true/ScreenRecording=false，随后屏幕录制设置open命令成功，进程自然exit0 | p02-permission-request/{command.json,events.jsonl,request.log,request.exit}，PID99320；未创建driver/观察/输入，不把API返回或open成功当已显示弹窗或已获屏幕权限 |
| F-016 | 用户报告已勾选后，新进程只读复查仍为true/false，Node78/logger0；TCC归属和ScreenCapture subject均为当前AgentPort debug ID | p02-permission-recheck/{command.json,node.stdout,tcc.ndjson}，PID5866；AX日志Allowed、ScreenCapture Unknown。该次复查时重启尚未确认，随后用户确认尚未重启；不据日志断言勾选错误或具体根因 |
| F-017 | 用户随后报告已重启，新Node16473仍true/false、Node78/logger0；当前会话祖先仍含16:25:57启动的agentport-host PID88054，磁盘app签名有效且display name为AgentPort Debug - AgentSessions | p02-post-restart/{command.json,node.stdout,tcc.ndjson,host-metadata.json}；tccd subject/responsible与磁盘bundle ID均为debug ID。磁盘签名不证明运行中映像，后台进程年龄不证明权限失败原因，也未证明用户勾选的是哪份app |
| F-018 | 用户明确确认之前条目不是这份调试版、已改为正确授权并要求重试继续；新Node30728两项true、Node/logger均0，tccd两项Allowed且归属同一debug ID | p02-correct-grant/{command.json,node.stdout,tcc.ndjson}；未重置TCC/改签名/杀宿主，该诊断无driver；解除历史权限条目阻塞，不代替未来行动进程资格 |
| F-019 | 限定P02真实平台基线通过：同fixture raw/adapter各一次后台AX click，counter0→1→2；真实Stop转发令pending只读观察以匹配UBJS AbortError拒绝，SDK shutdown→destroy及三进程自然exit0 | p02-live/report.md、native-comparison原始26文件、verification.json、live-review.md；两个行动PID各自TCC两项true/Allowed；30非原生pass/1skip、types/Biome/隔离全check0、Computer32/32。SDK层证据，不是OS终态或physical Stop证明 |
| F-020 | P04离线执行器/可选bridge通过，但六次live均在只读observe失败，无表单输入；每次terminal→close→destroy、owner自然1/fixture自然0/EOF，最后同inode C9 | p04/blocked-verification.json复核155原始文件、27Rust/81pins/579历史输入/四锁；bridge-check完整check0、193pass/5skip及38/38，source drift0 |
| F-021 | macOS明确报告console locked；新增前置guard在fixture/SDK/TCC/owner创建前拒绝。没有解锁对照，不能断言锁屏是所有AX拒绝的唯一原因 | p04/console-state.log、console-gate-tests（6/6）、locked-console-admission（预期exit1、零children、C9）；T-009/T-025等待人工解锁 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 实现前提：可选SDK输入由可信宿主提供、加载进程未预载/篡改模块、无loader hooks、文件加载期间稳定。hash是drift检查，不是恶意宿主或并发写入下的安全隔离；真实probe用独立最小环境进程，但不是OS sandbox。
- 已验证固定Rust1.97.1和三个白名单包可取得，SDK release编译及无driver加载通过。本轮专用窗口GUI及必要SDK附带metadata/焦点行为已获授权；用户已确认此前授权条目不是这份调试版，更正后同一debug身份新进程两项true；权限目标不匹配是本次已纠正的阻塞，不把此前entitlement warning、cache标签或后台进程年龄当作已证明根因。每个未来行动进程仍需自己的预检和归属；P02两行动进程与限定控制面/fixture已实测。后续模型授权见Scope；SDK settlement不等于OS终态。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- P00：ref 与脏基线可复查；记录 build:offline/check/test.sh 实际命令、退出码与失败；至少一个真实 AgentSession + faux provider 入口通过。
- P01：默认不开 Computer；有界协议与 fake observe→execute→result 通过真实 loop；注册、custom tool、双向转换、snapshot 及最终 contract/resource 消费得到测试证明。
- 后续各阶段只能在上游门禁满足后推进；原生/GUI 未验证必须显式标记。
- 既有用户变更及测试不受破坏；新增代码完成对应定向测试与 check。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001/T-002/T-003 → T-004/T-005 → T-006；T-006 → T-014/T-015/T-016；T-006/T-014/T-015 → T-007 → T-008 → T-009 → T-010 → T-011 → T-012 → T-013。T-016 独立复核共享树最新基线。
- P03 subgraph: T-007 → T-017/T-018；T-017 → T-019；T-017/T-018/T-019 → T-020；T-018 → T-021 → T-022 → T-023 → T-020（真实挂起后的离线修复、重启后一次性恢复、新发现的TCC验证阻塞）；T-008 的 done 门禁包含 T-017–T-023 全部验收。T-022与实际GUI由coordinator串行执行，不与任何canonical lease owner并行。T-017 与 T-018 文件不重叠，原生生成/构建由单一 owner 串行；T-019 只在 T-017 接口冻结后开始。
- Parallel batches: P00 的源码审计（T-001/T-002）只读，与 coordinator 的隔离基线（T-003）并行；P01 的 wrapper（T-004）与新增 Computer 模块（T-005）文件不重叠。P02 恢复时 coordinator 独占 T-014 依赖/构建准备，T-015 只读构建/加载安全审计和 T-016 独立快照回归可并行，证据目录不重叠。
- P04 browser subgraph: T-026 → T-028 → T-027 → T-009；独立p04-browser stage保留已资格AppKit输入，由coordinator串行拥有源/构建/生成。T-028仅transport基础，不使browser或P04整体提前验收。
- Serialization constraints: 本文件及所有实施记录只由 coordinator 修改；集成测试 T-006 在两项 P01 实现完成后；不并行改共享构建输出、锁文件或用户已改文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — P00 easy-pi 工具与生命周期路径审计
- Status: done
- Owner: coordinator / computer-pi-audit
- Objective: 查明工具转换、snapshot、contract、scheduler、宿主生命周期与 faux 测试入口。
- Inputs and prerequisites: 确认契约；实际脏工作树。
- Scope or files: packages/agent；coding-agent 的 extensions/tools/session/sdk 与相应测试，只读。
- Expected output: 真实调用链、差异、证据路径及最小 P01 建议。
- Dependencies: None.
- Execution steps: 完整读取相关文件，定位实际消费点，报告不可假定的接口。
- Acceptance criteria: 区分字段存在与实际生效；不改 loop。
- Verification method: coordinator 复读关键调用点及对应测试。
- Validation evidence: 已复读 AgentTool、双向 wrapper、registered wrapper、ToolPlan、StepSnapshot、ResourceScheduler、executePreparedToolCall、SDK 和 faux harness；baseline.md 记录字段丢失与 contract 在普通 loop 仅供宿主准入消费的边界。B03 两文件 13/13 exit 0。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — P00 Cua 原生与依赖审计
- Status: done
- Owner: coordinator / computer-cua-audit
- Objective: 核对固定 SDK、UniFFI、取消、UI loop、依赖与构建材料。
- Inputs and prerequisites: 只读 Cua 固定 ref；三开关关闭。
- Scope or files: ../cua/libs/cua-driver 中相关源码、manifest、锁文件、生成脚本。
- Expected output: dependency-review 的事实与 native 阻塞证据。
- Dependencies: None.
- Execution steps: 读取真实 API/实现/构建入口；仅离线 metadata/tree 检查，不初始化桌面。
- Acceptance criteria: 不手写绑定；明确取消真实能力与不可取消边界。
- Verification method: coordinator 复核原始文件和可复现命令。
- Validation evidence: 已复核 SDK README/package/Cargo manifests、runtime 权限构造、ABI spawn_completion 取消及生成脚本实际构建步骤；两条 cargo offline 命令重跑均 exit 101（jsonschema 缺失）；ubjs/target 缺失；Cua 工作树干净。dependency-review.md 区分静态审计通过和原生资格阻塞。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — P00 隔离 baseline 与实施记录
- Status: done
- Owner: coordinator
- Objective: 建立可恢复 baseline/progress/test-matrix/dependency-review 和 benchmark 规格。
- Inputs and prerequisites: 用户确认的当前工作树；现有依赖。
- Scope or files: docs/implementation/computer；pi 内隔离快照与证据目录。
- Expected output: 实际命令及退出码、源码/依赖基线、faux 入口结果、A/B 任务与阈值规则。
- Dependencies: None.
- Execution steps: 保存初始状态与文件哈希；隔离执行既有命令；运行真实 session faux 测试；整合审计。
- Acceptance criteria: 既有失败可区分；至少一个真实 session faux 入口通过；原生/GUI 未测不报通过。
- Verification method: build:offline、check、test.sh、定向 faux 测试、快照前后文件哈希。
- Validation evidence: .artifacts/computer/p00 保存 1789 路径哈希和脏 diff；build offline exit 0、check exit 2（已有 TS2339）、test.sh exit 1（已有 27 失败）、真实 session/runtime faux 13/13 exit 0。已新增 baseline/progress/test-matrix/dependency-review/benchmark-spec。check 的两处自动修复仅留副本，不回写。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — P01 扩展工具契约透传
- Status: done
- Owner: coordinator / computer-wrapper-small
- Objective: ToolDefinition 添加可选 contract/executionResource 并覆盖双向转换及包装。
- Inputs and prerequisites: P00 门禁及实际类型。
- Scope or files: core/extensions/types.ts；core/tools/tool-definition-wrapper.ts；必要 wrapper 测试。
- Expected output: 最小兼容改动及回归测试。
- Dependencies: T-001, T-002, T-003
- Execution steps: 沿用 AgentTool 类型；透传可选字段；验证包装和工具注册。
- Acceptance criteria: 旧签名兼容；字段不丢失。
- Verification method: 定向转换/包装/snapshot 单元测试及局部 lint；全局 check 和真实 loop 集成由 T-006 验收。
- Validation evidence: coordinator 检查实际 10 行产品 diff 及完整新测试；重跑 bash .artifacts/computer/run-isolated.sh node ../../node_modules/vitest/dist/cli.js --run test/computer/tool-definition.test.ts（cwd packages/coding-agent），exit 0，7/7；证据 .artifacts/computer/wrapper-verified.log / .exit。worker 的三文件 read-only biome check exit 0；真实 loop 消费尚归 T-006。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — P01 Computer 有界契约与 fake 能力
- Status: done
- Owner: coordinator / computer-fake-small
- Objective: 增加显式启用的最小宿主 service/tool 与可注入 fake 边界。
- Inputs and prerequisites: P00 真实接口及权限边界。
- Scope or files: packages/coding-agent/src/core/computer；test/computer。
- Expected output: 严格 schema、短结果及 fake observe/execute；不加载 native。
- Dependencies: T-001, T-002, T-003
- Execution steps: 根据实际类型实现最小契约；限制步骤/文本；测试错误与默认关闭。
- Acceptance criteria: 不冒称生成 native API，不增加默认工具，不额外规划循环。
- Verification method: 定向 contracts/service/tool 单元测试及 scoped TypeScript/lint；全局 check 由 T-006 验收。
- Validation evidence: coordinator 完整读新增源/测试并重跑 service.test.ts，exit 0、17/17，日志 .artifacts/computer/p01/service-verified.log；worker 的五文件 TypeScript strict 与 read-only biome 均 exit 0（fake-types/fake-biome 日志）。仅支持显式注入的 fake profile，不含任何 native binding。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — P01 真实 AgentSession 集成验收
- Status: done
- Owner: coordinator
- Objective: 真实 loop + faux provider 完成 Computer 垂直闭环并证明 contract/resource 实际生效。
- Inputs and prerequisites: wrapper 与 fake 模块。
- Scope or files: packages/coding-agent/test/computer；实施记录。
- Expected output: snapshot、注册/custom tool、错误投影、scheduler/contract 消费测试。
- Dependencies: T-004, T-005
- Execution steps: 复用现有 harness；运行定向扩展与 session 回归；审查 diff。
- Acceptance criteria: 无简化 Agent loop；默认零 native 初始化；测试实际通过。
- Verification method: 隔离定向集成、回归、check；P00 固定基线加仅本任务代码的受控副本跑 offline build/test.sh。
- Validation evidence: 真实 SDK/faux integration 8/8 exit 0；Computer + extension/child/session/queue/compaction 11 文件 176/176 exit 0；修正 wrapper fixture 两个类型错误后重跑 wrapper 7/7 exit 0。P00+仅本任务代码的受控副本 offline build exit 0；check exit 2 仅余已有 TS2339；test.sh exit 1，失败名称与 P00 的 27 项完全一致（added/removed 均空），新增 3 文件 32 测试全部通过。P01 功能/旧扩展/最终准入与调度门禁满足，不代表全仓 check/test 变绿。coordinator 复读全部实现与独立 review.md；独立审查无可执行发现，32/32 exit 0；verified-source-manifest 与副本匹配。日志 .artifacts/computer/p01/。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — P02 固定 SDK 原生接通
- Status: done
- Owner: coordinator
- Objective: 复用 UniFFI 接入真实原生单动作路径。
- Inputs and prerequisites: P01；已准备依赖及获授权的必要变更。
- Scope or files: native/computer；可选 native adapter。
- Expected output: 可验证的版本、加载、取消与关闭基线。
- Dependencies: T-006, T-014, T-015
- Execution steps: 先审查依赖白名单；由 Rust contract 生成绑定；按原生门禁验收。
- Acceptance criteria: 不猜 SDK，不绕过权限/UI loop，版本与生成一致。
- Verification method: 固定锁文件离线构建/契约测试；获准后才 GUI fixture。
- Validation evidence: 前轮固定SDK/guarded N-API编译、生成/header一致性和TS emission通过，四锁不变。本轮新增native/computer的lazy typed adapter、81输入hash loader、独立typecheck/tests/来源说明；未手写bindings/连接P01/默认注册。真实无driver import自然exit0、C ABI1.1.0/UniFFI30/109 checksum值一致、新loader及生成codec保留bigint/target/unconfirmed effect。非原生测试26pass/1native skip；独立native test1/1；生成strict typecheck与scoped Biome exit0。新隔离主树完整check exit0（1354文件无修复），Computer回归32/32；1815sourcepaths核对通过、检查期间drift为空。初次PATH127及类型/单测失败和修正重跑均保留于p02-connect；独立review无可执行发现，coordinator已完整审阅/核对13native文件hash并接受仅无GUI子集。未创建driver/TCC/桌面调用，未证明OS终态。精确日志见test-matrix和.artifacts/computer/p02-connect/。本次继续执行得到TCC status两项true/exit0及两份只读host/fixture审查；coordinator复读关键源码确认新的授权范围冲突，未创建driver/fixture、未执行observe/click，证据另存p02-gui/admission.md。用户确认附带行为后，coordinator用单个诊断PID过滤的系统log stream关联TCC getter：logger exit0、Node自然exit78，两项false，AttributionChain识别AgentPort。未创建driver或GUI窗口，立即停止；早先true/true保留为历史，不覆盖当时新失败。随后用户更正实际授权条目，权限诊断通过并在实际行动进程重新准入。最新p02-live新增Swift fixture/TS host/4个guard测试，root完整审阅并编译/实跑：own可见状态与Stop控制；raw51165/adapter52941各自TCC两项true、同PID两服务Allowed；同fixture51161/window4860 counter0→1→2，native Unverifiable/Accessibility/Background语义一致、无escalation。六次正常调用内Node pending pong与AppKit主线程ack；missing-manifest失败缓存/无owner close后同进程新adapter恢复；pending只读observe经fixture Stop转发收到匹配ESM UBJS AbortError，实际SDK settlement→uncancelled shutdown→destroy，各owner一次且三进程自然exit0，无forced teardown。root verifier核对81pins/四锁/两产物不变、1818源码边界；strict types/scopedBiome/新隔离完整check均0，30非原生pass/1skip、父协议4/4、Computer32/32。独立source/evidence review最终无发现，coordinator已读原始事件和报告后接受P02窄基线。未测physical Stop/无遮挡像素/截图/完整TUI/半owner泄漏/OS终态，不把本gate扩为生产支持。
- Blocker: None. P02限定原生基线已验证；P03的所有权/OS终态与P01 bridge仍未实施。
- Unblock condition: None. 未来行动进程仍须自己的权限/归属和可见控制面准入，SDK settlement不能用来释放desktop lease。

### [x] T-008 — P03 所有权与真取消
- Status: done
- Owner: coordinator
- Objective: 宿主 runtime、会话撤权、共享 scheduler 与 terminal acknowledgement。
- Inputs and prerequisites: 原生基线。
- Scope or files: computer service/native；必要 session/child 生命周期挂接。
- Expected output: 状态机、锁序、barrier 竞态测试。
- Dependencies: T-007
- Execution steps: 先并行只读核对固定SDK的原生取消/阻塞工作收敛点与当前宿主session/child/scheduler接线，再冻结最小接口和文件分工；在pi内实现原生gate/终态或显式隔离、宿主single-flight/会话撤权、锁序与barrier回归。不把JS超时当原生终止，不覆写P02基线产物。
- Acceptance criteria: 撤权后无新投递；未收敛不释放 lease。
- Verification method: barrier 取消/关闭/祖先撤权/owner 争用测试。
- Validation evidence: 最新T-020/T-024验收通过：p03-tcc/verify-live0、四terminal/四自然exit0、C3；repaired-check完整0、193pass/5skip及38/38。以下保留历史失败：T-017/T-018/T-019限定实现子集已验收；T-020的隔离check0、Computer/session191pass/5skip、controller38/38及控制面smoke通过。但2026-09-18T17:07:38Z的真实native-qualification退出1：首个observe未返回，Stop/close没有回执，owner56354被harness强制终止；无native terminal或自然owner退出证明。原始事件在p03/native-qualification/，静态复核与报告在p03/qualification-failure/。
- Blocker: None. 最新T-020真实资格及T-024完整check通过，历史失败不覆盖；见p03-tcc/live-verification.json和repaired-check/。
- Unblock condition: None. P03只证明受控路线driver-owned terminal；不推广到P02通用SDK或外部应用effects。

### [x] T-009 — P04 Rust 有界动作段
- Status: done
- Owner: coordinator
- Objective: 原生一次边界执行受守卫的有限步骤。
- Inputs and prerequisites: 原生生命周期与取消。
- Scope or files: native/computer 执行与观察；对应测试。
- Expected output: 完成前缀、两类目标、部分与未知结果。
- Dependencies: T-008, T-025, T-026, T-027
- Execution steps: 先读取完整SDK文档及实际controlled原生接口，在独立P04 stage保留P03成功产物，冻结类型化顺序协议；保守观察、逐步取消/权限/目标gate；Rust/生成/host与fixture按同一接口依赖串行实施，避免共享Cargo/输出并发。
- Acceptance criteria: 失败不自动重放；无隐藏 Agent 或脚本解释器。
- Verification method: P04 场景及 faux 模型请求数对照。
- Validation evidence: 最新unlocked真实八步表单及十AppKit预期场景通过，modal投影修复T-026 done；scenarios两个独立verifier核对324raw文件/12runs，最后C23、全部terminal/close/destroy/自然exit0/EOF。modal-check完整check0及193pass/5skip、38/38，tool8/8、loop4/4。仍待T-027 browser及更广能力/P04整体门禁；以下保留历史：独立p04核对263条P03-TCC封存记录，579历史源输入与四锁不变。core25/platform16/SDK31/private lease13通过；locked/offline release、genuine UniFFI generation/--check、独立N-API/header/strict TS通过。新增27文件p04-controlled.patch（e6d8167a）、dylib459fd177及81 genuine pins；完整AXChildren观察、Fill/Press/AssertValue有界执行、逐步gate/取消/driver-owned drain已stage实现。可选adapter/schema/tool/binding经现有ComputerSession/外层scheduler接线，tool8/8、真实AgentSession/faux4/4；同八步9→3模型请求、4→1plan、8→2外层acquire，仅合成请求数证据。bridge-check完整npm check0（1376文件无修复）、193pass/5skip及controller38/38，主树/副本drift0。六次live均observe失败，未发送form/click；blocked-verification复核155文件，每owner一条只读terminal及clean close/destroy、自然exit1，fixture自然0/空值/counter0，历史inode C3→…→C9。临时Rust诊断已撤回，源cmp/重建dylib恢复原hash；restored-types/integration-types/probe-types全0，选定静态tests32pass/7opt-in skips。P04尚未验收，见p04/report.md；浏览器/像素/完整场景及P05–P08仍待。
- Validation evidence (latest): T-027真实13browser场景、独立child/祖先revoke、实际TS bridge已验收；sequential-live-1的四个两步native plans与单八步plan独立10事件oracle完全一致（含focused=false），12terminal/两自然0至C49，不将首条receipt当整段证明。combined-appkit-live-1使用同一最终browser SDK完成真实AX八步、三terminal/两自然0至C50；旧AppKit十场景和新native45tests中的重复/冲突operation回归仍保留。两独立verifier与browser-qualification-final-check全0、193pass+5skip/controller38/drift0。真实loop/faux AppKit9→3、browser含固定bootstrap11→5仅请求数对照，无性能结论。
- Blocker: None. 按原计划P04有限顺序段门禁验收，不将尚未实现的像素通路/打包/正式性能纳入已完成声明。
- Unblock condition: None. 总体应用/窗口/像素范围不删减：后续P05保留正确性基线，P06类型化数据/图像通路，P07显式激活与打包，P08正式测量。

### [x] T-010 — P05 观测热路径
- Status: done
- Owner: coordinator
- Objective: 仅优化有证据的固定等待和重复观察。
- Inputs and prerequisites: 保守 Rust 批执行基线与平台测量。
- Scope or files: 受控原生副本及可信观察策略。
- Expected output: 可独立撤销的优化及差分证据。
- Dependencies: T-009, T-033, T-034
- Execution steps: 先封存P04并建立独立P05 stage；对实际controlled AppKit与browser入口分项计时，区分必要AX/guard与通用detect等待。只在测量及因果实验后实施可信策略，差分覆盖焦点/late-window/cancel，不用私有tool参数关闭保护。
- Acceptance criteria: 焦点和 late effect 不退化；不放开私有参数。
- Verification method: 配对差分、窗口与焦点 fixture、阶段计时。
- Validation evidence: P05独立stage封存P04的609输入/81pins/626证据。首批仅诊断两Rust文件及scope测试签名适配，platform59/SDK45/core69、生成/check/N-API/header/types/load-only通过；三独立真实AppKit八步均通过，9terminal/6自然0/EOF、clean C51–C53。分项独立verifier：每form16个focus scope，native+bridge中位26290.766ms、window detect占62.73%、Node+native CPU中位1157.814ms，8.6s尚未归因，非FFI结论/非优化或正式p95。下一步对canonical list_apps资源enrichment增加仅耗时/数量诊断，验证反复plist子进程假设后再决定低风险改动。详见p05/timing-report.md与timing-verification.json；P04及main产品不变，未缩短focus等待。
- Validation evidence (final): plist五组counterbalanced实际表单median26.512486s→17.929171s（−32.3746%），三个micro进程各100配对；只接受去重复元数据子进程收益，focus检测约16.5s保持原保守行为，不主张未经验证的焦点快路径。T-033/T-034两catalog缺陷及readiness修复先红后绿，最终platform70+1显式ignore/SDK45/core69/真实生成/check/NAPI/header/type/load均0。最终13browser+AppKit form及九邻接全部通过，两个独立verifier检查621raw/46自然0/EOF/全部终态和close、最后C106，无页面重放。d70-current-check完整0、193pass+5skip/controller38/drift0；先前并发类型错误本轮已不存在，不改其源码。九Rust增量p05-observation.patch=4225ac11，私有Git根中严格apply/byte-compare/reverse通过；初次nested Git跳过与缺new-file header错误均保留、修复后校验通过。主产品P04 pins不变，P06/P07再选择生产构建。
- Blocker: None for the measured P05 candidate. 固定focus等待仍保守保留；正式总体性能/p95、像素及打包归后续阶段，不纳入本完成声明。
- Unblock condition: None. 旧D65/D70/D83终态未知事实不被新成功覆盖。

### [ ] T-011 — P06 裁剪与类型化通路
- Status: blocked
- Owner: coordinator
- Objective: 裁剪实际生产依赖并优化结果/图像通路。
- Inputs and prerequisites: 原生正确性与热路径基线。
- Scope or files: 原生 feature/生成/结果及图像映射。
- Expected output: 真实依赖闭包、产物、绑定一致性与 buffer 回收证据。
- Dependencies: T-010, T-035, T-036
- Execution steps: 先封存P05并建立独立P06 stage；实际graph审计后，T-035先冻结必要图像/坐标及输入通路，T-036据此排除真正不需的发行依赖，再决定物理删除，避免把截图必需的ScreenCaptureKit按录制模块误删。保留授权/browser，实际生成/buffer回收/GUI邻接后验收；不在P05继续构建。
- Acceptance criteria: 不以未注册冒充未编入；不手改生成产物。
- Verification method: feature tree、产物检查、图像变换、browser 回归。
- Validation evidence: P06独立prepare通过：611 source/material inputs、81pins、897条P05证据封存，APFS复制target/npm后SDK node_modules绑定独立P06路径；P05源/产物不改。实际SDK feature/release依赖图与metadata、linked-libraries已采集（见p06/baseline-*）；类型化图像接口及三轮真实成功资格已完成限定验证（T-035），尚未实施裁剪。
- Blocker: T-035正向窗口选择→输入资格等待短暂安静输入时段；discovery-live-quiet实际exit78，30次passive样本heldNonToggleInputObserved=true/counterChangeObserved=true。当前C144 clean，无新输入owner；原保护不删。T-036仍待surface冻结。
- Unblock condition: 用户释放按键/按钮并提供约1分钟无键鼠活动窗口，fresh quiet/console/TCC/Stop/固定输入与canonical身份准入通过后继续，不需重启或恢复租约。

### [ ] T-012 — P07 懒激活与打包
- Status: pending
- Owner: unassigned
- Objective: 显式 GUI 阶段激活、上下文一致投影和可选原生产物。
- Inputs and prerequisites: 原生裁剪与契约稳定。
- Scope or files: 宿主激活、图像/上下文边界、现有 pack。
- Expected output: 独立目录可用产物与用户说明。
- Dependencies: T-011
- Execution steps: 复用现有模式和压缩；不迁移全仓工具。
- Acceptance criteria: 普通 coding 零 native；Node/Bun 不混称通过。
- Verification method: 模式/tool filters/视觉/compaction/独立安装测试。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-013 — P08 平台验收与交接
- Status: pending
- Owner: unassigned
- Objective: 完整回归、配对性能测量与可恢复交接。
- Inputs and prerequisites: 前序门禁及 GUI 授权和 fixture。
- Scope or files: 实施记录、benchmark 与必要局部修复。
- Expected output: 原始数据、支持表、rollback、最终矩阵。
- Dependencies: T-012
- Execution steps: 按冻结任务集测量，记录全部失败/未知/中断。
- Acceptance criteria: 未测平台不支持；性能结论有真实测量。
- Verification method: 无密钥回归、获准 GUI、cancel stress、Node/Bun 分别验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — P02 固定依赖与项目工具链准备
- Status: done
- Owner: coordinator
- Objective: 在批准白名单内取得固定依赖并验证完整依赖闭包，不改变全局工具链或参考库。
- Inputs and prerequisites: 用户限定依赖授权；P01；固定 Cua ref/锁文件。
- Scope or files: pi 内受控 native staging、.artifacts/computer/p02 的独立 HOME/cache/toolchain；必要 native/computer 材料与文档。
- Expected output: 精确包/来源/integrity/脚本审查、1.97.1 工具链、locked/offline metadata/tree 通过，明确可编译输入。
- Dependencies: T-006
- Execution steps: 先确认固定版本可取得；隔离配置与凭据，审查包和构建脚本；ignore-scripts 安装；保留锁文件与来源 hash；只用受控副本取得图谱。
- Acceptance criteria: 不引入未需 Electron/Fleet，不静默换版本；不能以部分 fetch 冒充原生产物。
- Verification method: 精确版本查询/安装、cargo locked metadata/tree、integrity 与源/锁文件差异检查。
- Validation evidence: 项目隔离 rustup 安装 1.97.1 + rustfmt exit 0，隔离 rustc/cargo 都是 1.97.1，全局 PATH/stable 未改变。三包 npm registry 查询/pack 和 sha512 校验通过；独立最小 manifest + lock，npm ci --ignore-scripts --omit=optional --offline exit 0，只装三包。Cua cargo fetch --locked --target mac、metadata --locked --offline --filter-platform mac、SDK tree exit 0，原锁 hash 未变。UBRN CLI 与 copy-mode runtime 分别生成/保留 Cargo.lock、locked fetch/tree 通过；只在受控副本为 CLI 和 scratch runtime 增加 locked/offline 约束，node --check exit 0。日志/来源/locks 在 .artifacts/computer/p02/；不是生产裁剪或原生加载证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-015 — P02 非 GUI 构建与加载入口审计
- Status: done
- Owner: computer-native-safe-audit
- Objective: 识别可以在 GUI=false 下执行的真实构建/生成/ABI 入口及副作用边界。
- Inputs and prerequisites: 固定 Cua 源码；P00 原生审计；P01。
- Scope or files: Cua libs/cua-driver 的 scripts/Rust/TS 只读；仅 .artifacts/computer/p02/safe-audit.md 报告。
- Expected output: 具体命令和输入闭包、无 GUI 测试候选、加载/初始化风险与必停点。
- Dependencies: T-006
- Execution steps: 追踪生成、build.rs、N-API 与 SDK 顶层初始化；区分纯编译/ABI 检查和 runtime/create/UI loop。
- Acceptance criteria: 不执行 native/GUI/安装；给源码证据，不猜生成 API。
- Verification method: coordinator 复读关键脚本/入口，只有验证安全的调用才可执行。
- Validation evidence: safe-audit.md 已审阅；coordinator 完整读生成/stage/N-API 脚本、SDK/platform build.rs、三种 Swift bridge build.rs/Package.swift，并核对 UniFFI library metadata 为读取 Mach-O 字节而非 dlopen。批准纯编译/生成，禁止全量 upstream loader tests（含 create）；TS import/所有 native 执行仍 HOLD，传递 dylib initializer 未认证。固定额外工具链锁问题已归 T-014 修正；不把 ABI 常量/16-bit checksum 当安全 contract hash。
- Blocker: None.
- Unblock condition: None.

### [x] T-016 — 共享树最新隔离基线复核
- Status: done
- Owner: computer-current-baseline
- Objective: 将旧快照失败和共享工作树最新状态区分，复核当前编译/测试门禁。
- Inputs and prerequisites: 当前脏 pi；T-006；现有依赖，不准安装。
- Scope or files: 只读主树；独占 .artifacts/computer/p02/current-baseline/ 快照与日志。
- Expected output: 含本任务文件的隔离快照、哈希与 build/check/test.sh 实际结果。
- Dependencies: T-006
- Execution steps: 复用已审查隔离方法，仅复制 tracked/本任务文件及现有材料；依次运行离线 build/check/test；不回写格式化。
- Acceptance criteria: 不读 HOME 凭据、不触发真实 API/GUI；完整日志/退出码；不把旧错误当最新事实。
- Verification method: 快照哈希、明确命令/cwd、失败清单和主树未被命令改写证明。
- Validation evidence: current-baseline/report.md 与完整 copy/evidence 脚本、check 日志已复读；当前 tracked + 13 新增文件快照核对通过。offline build/check/test.sh exit 0/0/1；check 包括 browser smoke，Biome 1343 文件无修复；test 10 失败（与 P01 共享9、旧18消失、新footer debounce timeout 1）。coordinator 重跑完整隔离 check exit 0；单独 footer-data-provider 8/8 exit 0，未诊断该全量超时原因。source/material/lock drift 为空；没有回写或修复无关源码。
- Blocker: None.
- Unblock condition: None.

### [x] T-017 — P03 宿主所有权状态机
- Status: done
- Owner: coordinator
- Objective: 实现显式注入、lazy single-flight runtime、不可复用会话代际、跨决策 owner 与终态/隔离管理。
- Inputs and prerequisites: P02；既有 ResourceScheduler；只读宿主审计。
- Scope or files: 新增 core/computer/host.ts、binding.ts 与 test/computer/host.test.ts；不改 native 或 Agent loop。
- Expected output: 泛型可信原生接口、同步撤权、终态等待、sticky quarantine；无第二队列和内层 scheduler acquire。
- Dependencies: T-007
- Execution steps: 分离 result 与 terminal；先登记再投递，撤权先关闭整棵子树再调用外部回调；失败保留 owner；只关闭自己的 session。
- Acceptance criteria: 初始化/投递/终态/关闭 barrier 覆盖；无 native 时零初始化；旧句柄失效。
- Verification method: 新增定向测试、scoped lint/types、独立审查。
- Validation evidence: 新增host.ts/binding.ts，root完整复读实现/测试。33个无sleep barrier用例root隔离重跑exit0（p03/host-tests-final.log），repo tsgo --noEmit exit0（host-types-final），scoped Biome三文件exit0。测试与独立review复现terminal先失败而result不结束时不能及时报告/隔离；root修正为独立等待terminal、立即处理result rejection并保留quarantined operation，永久pending result回归通过。独立host-review.md最终无发现，匹配host cff3599e/ binding 68f232e0；只接受宿主状态机，不代替native真实性/SDK接线/全局check门禁。
- Blocker: None.
- Unblock condition: None.

### [x] T-018 — P03 原生 gate 与受控构建
- Status: done
- Owner: coordinator
- Objective: 固定 SDK 上实现真实取消锁存、逐副作用准入和终态确认或原生隔离；协作桌面 lease。
- Inputs and prerequisites: P02 原始锁/生成工具；只读原生审计；P03 独立 stage。
- Scope or files: pi-owned native/computer 补丁与 P03 原生副本；原生 adapter/生成校验；不改 sealed P02/Cua reference。
- Expected output: 可审查 Rust 改动与重新生成的绑定，独立产物/pins，原生 barrier/锁测试。
- Dependencies: T-007
- Execution steps: 审计 blocking/cleanup 逃逸点后冻结最小路径；复用固定依赖/UniFFI；构建不共享可写 P02 输出；无法证明终态则保留真实 lease。
- Acceptance criteria: 原生 gate 撤权后没有未投递输入；不以 future abort/shutdown 代替终态；无新增依赖/手改生成代码。
- Verification method: offline locked 编译、定向 Rust barrier 与跨进程 lease 测试、生成一致性和显式 TS types。
- Validation evidence: root完整复读19文件补丁的主要路径及最终native-review.md，三项具体发现已修正并有Drop/失去producer/AX gate/快照refcount回归；最终review无发现、源hash匹配。root独立重跑core18/lease13/SDK11/platform5全部0（root-*.log）；private subprocess覆盖停住owner/争用/clean handoff/crash dirty拒绝，无canonical lease获取。root核对patch c1be9e7b、dylib7add23a7、491Rust输入、P02的485Rust不变；原锁/生成脚本不变。未改generator及--check、独立N-API stage、C header check、TS emit和81genuine pins全部0。实际strict types首轮4个TS类型错误已用probe命名类型及host显式undefined联合最小修正，fixed0；只格式化新增pin JSON后scopedBiome0；controlled33pass/1skip，单独load-only1/1自然退出，P02tests30pass/1skip/types0、136seal不变。真实driver/canonical lease/fixture门禁仍归T-020；driver-owned terminal不等于外部应用effect。
- Blocker: None.
- Unblock condition: None.

### [x] T-019 — P03 root/child 生命周期显式接线
- Status: done
- Owner: coordinator
- Objective: 注入同一宿主/scheduler，session replacement/reload/close 与祖先权限收紧同步撤权。
- Inputs and prerequisites: T-017 接口；当前 SDK/child/权限通知实际实现。
- Scope or files: 必要 sdk/agent-session/services/child/collaboration 挂接与定向 integration tests；保留共享 dirty edits。
- Expected output: 每 session 新绑定工具闭包，不把 root 旧句柄复用于 child；默认无 Computer。
- Dependencies: T-017
- Execution steps: 独占必要生命周期文件；在异步清理/外部 observer 前撤权；旧能力不可恢复；使用真实 faux Agent loop 验证。
- Acceptance criteria: switch/fork/resume/reload/close 与祖先收紧覆盖，root/child scheduler 同实例；不关闭整个 host runtime。
- Verification method: barrier/faux 集成与既有 session/child/extension/steer/compaction 定向回归。
- Validation evidence: 初稿53/53未覆盖独立lifecycle-review.md的三个代际/捕获问题。修正前新增25例全部失败（原26例通过），修正后lifecycle51/51、17文件238/238、当前controller38/38、tsgo两轮0、scopedBiome5文件0。coordinator完整复读最小diff/新测试/失败与回归日志，核对最终5源文件hash，独立重跑lifecycle/host/child/runtime四文件111/111 exit0（p03/lifecycle-fixed-root.log）。修正为callback前捕获续代guard、drain后检查、仅新child读取当前root binding；旧闭包不可复活。23份原始日志/基线逐字节归档至p03/lifecycle-fix-evidence并保留manifest；并发validateCollaborationTask修改未覆盖。接受限定生命周期子集，不代替实际native/全局check/GUI门禁。
- Blocker: None.
- Unblock condition: None.

### [x] T-020 — P03 集成资格与记录
- Status: done
- Owner: coordinator
- Objective: 核验所有权、真取消与隔离门禁，完成状态机/锁序/恢复文档和阶段验收。
- Inputs and prerequisites: T-017/T-018/T-019/T-021/T-022及T-023输出；最新持续授权允许修复验证后新尝试，实际行动进程仍需重新资格检查。
- Scope or files: P03 证据与独立审查；implementation records/native README；本 authority。
- Expected output: 新隔离全局 check、targeted regressions、实际 native/fixture 证据和明确未覆盖项。
- Dependencies: T-017, T-018, T-019, T-021, T-022, T-023, T-024
- Execution steps: 检查 diff/原始证据；不覆盖 P02；先无 GUI 验证后按资格门禁执行 fixture；最终独立审查并修复实际发现。
- Acceptance criteria: 未终止工作与下一owner不重叠；拒绝/未知效果不重放；验收后按当前持续授权进入P04。
- Verification method: 精确 barrier、跨进程锁、生成/strict typecheck、isolated npm run check、定向 Computer/session/child 回归、task validator。
- Validation evidence: 最新p03-tcc/native-qualification和verify-live均0，四terminal/四自然exit0、唯一effect及C3；repaired-check完整check0、193pass/5skip、38/38，支持文档同步。以下保留旧轮证据：final-check的完整check0（Biome1369文件无修复）、Computer/session191pass/5既有skip、controller38/38、source drift为空；boundary-review实际生成API/type-only复核无发现，root已读并退休reviewer。control-smoke无SDK、fixture44888/window5338的状态/Stop锁存/EOF自然退出通过。真实native-qualification（task-90）于17:07:38Z开始、17:09:17Z退出1：owner56354自己的TCC两项true/Allowed，fixture56350/window5617可见且主线程响应；首个observe dispatch/pending pong后60秒无observed，cleanup发送stop/close后30秒无自然退出/终态回执，harness记录forced teardown。fixture最终counter0、无effect事件、自然exit0；未发送click，未启动contender/successor。只读复核canonical marker为D/0000000000000001、inode134700982，未锁定/改写/修复；ps已无这两个PID不能证明OS终态。qualification-failure/verification.json保留20份原始文件hash、9项当前pin及精确命令；静态证据check0不等于qualification通过。新轮见p03-recovery/report.md及qualification-review.json：T-022恢复0/control-smoke0；18:54:21Z—18:54:30Z实测在TCC身份准入处exit1，未admit/dispatch，probe/fixture自然exit0、owner构造0、C1不变。只读原始事件复核0，不是修复后的原生资格通过。
- Blocker: None. 最新p03-tcc/native-qualification与独立verify-live均0：owner24386首次observe返回、parent/sibling及contender25381拒绝；唯一AXPress使fixture24382/window240 counter0→1；四terminal、clean后successor27193只读cancel、四自然exit0/EOF、无强杀/采样。三行动PID各自两服务完整TCC；历史inode C1→D2→C2→D3→C3，无再次恢复。T-024之后完整check0、193pass/5skip及controller38/38、drift0；支持文档已同步。
- Unblock condition: None. 不声称external effect drain/rollback、physical Stop或旧挂起唯一根因；P04–P08另验收。

### [x] T-021 — P03 首次观察挂起的离线因果修复
- Status: done
- Owner: coordinator
- Objective: 定位首次observe及Stop/close不收敛的最早错误边界，以无桌面回归证明并最小修复。
- Inputs and prerequisites: T-018固定输入；native-qualification及qualification-failure冻结证据；用户已确认离线修复范围。
- Scope or files: pi内受控Rust源码/测试、native/computer补丁与必要TS边界；隔离新证据；不改P02/Cua或失败原始证据，不访问桌面/canonical lease。
- Expected output: 可证伪的根因链、先失败后通过回归、最小补丁及离线构建/一致性验证；明确仍待真实复测。
- Dependencies: T-018
- Execution steps: 依次追踪dispatch→原生worker→result/terminal和同步Stop；先用最小无GUI实验区分原因，保存失败输入，再修复/回归；单一owner串行修改和构建，不跨边界并行。
- Acceptance criteria: 回归失败来自目标缺陷且修复后通过；不以超时放宽/强杀/伪terminal掩盖问题，不释放dirty lease；真实GUI未复测不得报P03完成。
- Verification method: 精确Rust/TS非桌面用例、必要locked/offline构建和生成校验、隔离全check、diff/来源hash与任务validator。
- Validation evidence: 独立p03-offline-repair复现foreign blocking wake持有core gate/state锁的局部循环等待；单订阅及加强的result/terminal双订阅均原代码exit101/修复后0。仅public terminal通过native proof monitor隔离foreign waker，核心终态/取消/lease/API不变；新增3个测试。最终core18/lease13/SDK14/platform5全0（SDK在test-only格式修正后重跑14/14）；locked/offline release、generator及--check、header/TS emit、strict types全0；controlled33pass/1skip、P02 mock30pass/1skip、load-only1/1、Biome22文件0。最终patch21d8ff66、dylib7b94a64a、N-API3ff6b386已同步pins；verification-final0核对2修复源/19patch文件、四锁与generated JS/声明不变、原失败20文件/P03的491Rust及81pins原样，P02 seal136条0。新隔离完整check实际exit2：5个packages/ai/test模型ID TS2345；旧Computer patch/pins的同副本tsgo同5错误，保留不修。Biome仅改副本1个narrative文件、检查期间主树source drift0；后续定向Computer/session193pass/5既有skip、controller38/38。根check不是绿灯；只接受本离线子集。完整因果链/命令/限制见p03-offline-repair/report.md，未取得原现场native stack或重跑GUI，dirty lease未获取/改写。
- Blocker: None for the authorized offline subset. 全仓check的范围外5个类型错误已用相同输入对照确认；未据此声称全仓通过或允许提交。T-008/T-020继续受单独恢复/GUI门禁阻塞。
- Unblock condition: None. 后续恢复/桌面实测归T-020，不能由本任务done推断获得授权。

### [x] T-022 — P03 重启后一次性租约恢复
- Status: done
- Owner: coordinator
- Objective: 在明确放弃旧未知代际的授权下，保留证据与inode，恢复唯一一次D/1→C/1。
- Inputs and prerequisites: T-021修复输入；用户已确认具体恢复/fixture契约；实际boot晚于失败及修复完成。
- Scope or files: .artifacts/computer/p03-recovery的一次性helper/私有测试/归档；canonical desktop.lock仅授权原位字节更新；不是产品恢复API。
- Expected output: private故障门禁、修复/旧证据hash核验、独占恢复前后记录与同inode/代际证明。
- Dependencies: T-021
- Execution steps: 复核完整协议；私有文件先验证成功/争用/身份/权限/marker/链接/重复/缺失拒绝；核验输入后仅一次canonical执行，归档fsync先于原位更新/验证。失败停止不重复恢复。
- Acceptance criteria: 当前marker必须精确历史D/1，uid501/inode134700982/private目录/local filesystem/无ACL或symlink/单链接，flock不可用即拒绝；C/1持久化且身份不变。没有旧terminal声明。
- Verification method: 私有定向回归、来源hash、sysctl/held-FD身份及flock、durable原marker归档、恢复记录、authority validator。
- Validation evidence: p03-recovery/restart.json记录boot1789756477（18:34:37Z），晚于失败/修复。助手只链接系统库并复用原样Rust验证器，private20/20（含争用、ACL/链接、身份/权限/代际、缺失/重复拒绝和写后失败D恢复）；parent8/8、snapshot4/4。pre-recovery-inputs0核对原/修复各81pins/491Rust、原20失败文件、P02 seal136/136和离线133证据、四锁及产品不变。18:52:43Z canonical-recovery exit0：无ACL/local/private安全检查、非阻塞独占flock内先归档D1并fsync，再仅更新state字节/同inode fsync验证C1；before/after inode134700982、uid501、0600、nlink1、42bytes、generation1不变。marker-before.bin保留原D1；after-admin只读复验0。没有SDK/GUI或旧terminal声明。
- Blocker: None.
- Unblock condition: None.

### [x] T-023 — P03 TCC责任链验证脚本修正门禁
- Status: done
- Owner: coordinator
- Objective: 修正把requesting Node PID与responsible宿主PID混同的验证逻辑，保留逐进程身份/权限证据门禁。
- Inputs and prerequisites: p03-recovery冻结失败日志/实际脚本；用户已确认完整P03–P08持续执行，允许修复后新fixture尝试。
- Scope or files: 新证据目录中的collector/validator及离线回归；不改sealed P02/P03原证据、产品native或TCC数据库，不再次恢复C1。
- Expected output: 正确关联action/requesting PID和responsible bundle/path，必要逐服务决策证据；先红后绿离线用例与明确未覆盖项。
- Dependencies: T-022
- Execution steps: 获确认后先从已捕获日志复现错误，区分身份关联和逐服务授权证据；最小修正并验证拒绝错PID/错宿主/缺失或混杂证据。新的真实尝试单独按用户确认执行，不放宽门禁。
- Acceptance criteria: 不要求不同角色PID相同、不仅凭getter或bundle字符串接受另一进程；历史同PID场景仍正确，缺证据fail closed。
- Verification method: 保存的TCC日志与合成反例离线回归、父协议测试/源码审查；新行动进程仍须新TCC证据。
- Validation evidence: 新p03-tcc：真实旧日志角色回归在原匹配条件下exit1/修正后0；26项闭合日志/反例（错PID/宿主/path/uid、混activity/tccd、缺grant/result/reply、denied、顺序等）全0，parent8/8。PID17521早期权限盘点true/true，无需request；PID19880无driver诊断按(tccd PID,activity ID)关联完整请求，实际找到此前被PID文本filter漏掉的两服务Allowed行。最终集成collector/validator新PID22337自然exit0：requesting22337→responsible1084/预期bundle/path，msgID22337.1/.2、activity544945/.946的context/subject/Allowed/authValue2/成功reply一致。捕获只在内存保留有界8秒TCC窗口，落盘仅本请求的必要记录族，不落无关活动或签名证书详情；无constructor/lease/fixture。原P02/P03/recovery证据不改写。此done仅验证取证/准入脚本，未来行动进程仍须自己的preflight。
- Blocker: None.
- Unblock condition: None. T-020恢复真实fixture资格验证。

### [x] T-024 — 当前全仓检查的模型目录测试漂移修正
- Status: done
- Owner: coordinator
- Objective: 消除P03最新全仓检查的5个模型ID类型错误，保留原测试行为覆盖。
- Inputs and prerequisites: p03-tcc/final-check/check.log；当前生成目录及生成器映射；持续修复交付授权。
- Scope or files: packages/ai/test/context-overflow.test.ts、openai-completions-tool-choice.test.ts、zai-coding-plan-models.test.ts；必要定向回归和隔离证据。不修改并发生成器/provider产品代码或手改生成目录。
- Expected output: 有来源的有效模型输入和明确能力断言；定向无密钥检查及完整隔离check通过。
- Dependencies: T-023
- Execution steps: 先复跑旧测试；对照当前生成器及目录区分测试漂移与产品错误；最小修正；定向回归后新快照全check。
- Acceptance criteria: 不cast绕类型、不删除测试或跳过断言；保留Mistral/OpenRouter、双zai provider、reasoning mapping及参考价格/零价覆盖；无真实API。
- Verification method: empty-HOME定向vitest、tsgo、isolated npm run check、diff及共享来源核对。
- Validation evidence: 已复读生成器及当前数据，确认过时ID不在目录；最小修正三测试共26增/20删，保留原测试与能力/价格覆盖，无cast/生成数据改写。p03-tcc/ai-before实际3fail/46pass/35既有API skips；ai-after为49pass/35skip，context-overflow只编译/发现未调用API。repaired-check完整npm check0（1369文件无修复，含tsgo/browser-smoke）、Computer/session193pass/5skip、controller38/38，所有source drift0。diff/whitespace已复核；单独提交8779ac9ff，仅三测试，暂存区无他人文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-025 — P04 首次完整观察的真实平台拒绝定位
- Status: done
- Owner: coordinator
- Objective: 定位专用AppKit表单的controlled_target_unproven拒绝，并纠正harness把已drain自然exit1误标forced的证据错误；不降低完整性/终态门禁。
- Inputs and prerequisites: T-008；p04/form-native-qualification及form-diagnostic原始事件；持续修复验证授权。
- Scope or files: P04 stage observation路径及定向测试；独立诊断/GUI harness；不覆写历史P03或P04失败输入。
- Expected output: 分支定位、因果回归和最小修复；更新生成/pins与专用fixture资格，不自动重放输入。
- Dependencies: T-008
- Execution steps: 先保留原源/产物与失败证据；只增加有界错误类别观测来区分unmapped/missing/unknown root；证明原因后修复和重验；每行动PID继续新TCC/Stop准入。
- Acceptance criteria: 未读取日常应用内容；ref/完整性/权限不放宽；拒绝与natural failure事实如实保留；未知terminal不清锁。
- Verification method: 已捕获native reason；parent paired regression；offline Rust/生成/类型；独立fixture值oracle与native terminal/close/EOF。
- Validation evidence: p04六次失败目录form-native-qualification、form-diagnostic、form-branch-diagnostic、form-roots-diagnostic、form-helper-diagnostic、form-p03-baseline：只读observe失败，每行动PID自己的完整TCC Allowed链通过，无form/click；每owner terminal(false,false)→native-close→destroy、自然exit1/EOF，fixture自然0/空值/counter0，历史inode C3→D4→C4→…→D9→C9。诊断只读取fixture根role/identity/window mapping：AXWindows/AXChildren及旧helper得到application自身AXApplication/无window映射；冻结P03 SDK/probe对同fixture也失败，不据此唯一归因。console-state随后明确locked=true；console-gate6/6，实际locked-console-admission预期exit1且零children/C9。harness自然exit1误标forced的paired before1/after0，只有仍存活进程才记录/发送强制终止，真实失败另存cleanup_errors；首轮历史错误标签保留。临时Rust诊断移除，原源cmp/locked rebuild0/dylib459fd177恢复，probe回用product loader；blocked-verification0核对155原始文件与全部固定输入，恢复后的三项类型检查0。未放宽ref/完整性或任何权限gate。2026-09-19用户解锁后unlocked-inputs0确认216seal/155raw/33product/27Rust/81pins不变；unlocked-readonly exit0：fixture24451/window282、owner24455本次TCC完整Allowed、原P04观察complete=true/degraded=false/truncated=false、21节点和四空白字段；一条terminal(false,false)→close→destroy、两自然exit0/EOF，无form/click/forced，C9→D10→C10同inode。只新增父脚本只读模式，无Rust/生成/权限gate行为改变；环境阻塞已解除，不扩大为所有AX拒绝的唯一根因。
- Blocker: None. 解锁后原产物真实观察已通过；不以private lock key缺失单独证明解锁。
- Unblock condition: None. 完整表单/其它平台场景归T-009，持续使用console和逐进程TCC/Stop门禁。

### [x] T-026 — P04 弹窗拒绝原因投影回归
- Status: done
- Owner: coordinator
- Objective: 保留原生已识别的modal原因，不把它合并成普通condition_unknown；维持无输入/完成前缀/未知语义。
- Inputs and prerequisites: scenario-modal原始失败、modal-readonly-diagnostic原始观察；持续实施授权。
- Scope or files: P04 SDK plan.rs及定向tests、受控补丁/pins、独立验证记录；不改AX/权限/终态gate。
- Expected output: 先红后绿的执行器回归、最小白名单错误映射、生成/构建一致性和真实modal复测。
- Dependencies: T-025
- Execution steps: 冻结旧源/产物；用只读原生观察区分平台检测与执行器投影；先跑故障回归，再最小修复并重验。
- Acceptance criteria: 不放宽scenario断言；未知自由文本不透传；中途modal保留已完成前缀且不执行尾部。
- Verification method: 定向Rust before/after、邻接tests、locked/offline构建/生成/pins、fresh fixture modal与modal-prefix、任务validator。
- Validation evidence: 初批前五场景通过，scenario-modal返回Paused/prefix0/NotDispatched/condition_unknown且无输入。只读modal-readonly-diagnostic exit0明确elementsComplete=false/degraded=true/degradedReason=unexpected_modal_surface；plan::select在完整性失败分支无条件返回condition_unknown。两轮均terminal→close→destroy/两个自然0/EOF、无强制清理；同inode C16→D17→C17→D18→C18。后续两新回归原实现12pass/2fail/101，最小allowlist修复后SDK33/33/0；不接受任意degraded_reason文本。27Rust中仅plan及tests两文件变化、四锁/579历史输入不变，genuine generation/--check/header/strict TS全0，生成JS/声明不变；patch51fbcae0/dylib0427ba07、新N-API6d65d72c已pin，no-host load1/1。首次verifier错误假设N-API字节不变，实际同pinned脚本每次重编；前次实际pin0070e34c而非旧文案误引P03 hash，失败/修正原样保留，不声称binary reproducibility。修复后modal及modal-prefix真实通过；剩余partial/cancel/deadline也过：prefix1、已投递取消unknown、deadline6步后停止，无尾部输入/重放，C23。scenarios-repaired-verification0核对135raw/5runs/10自然exit0/EOF。modal-check全check0（1376files，只格式化任务pin JSON已审查回写），193pass/5skip及38/38、live drift0；tool8/8、loop4/4、boundary types0。详见p04/scenarios-report.md；仅接受修复，不代表P04整体。
- Blocker: None.
- Unblock condition: None.

### [x] T-027 — P04 受控浏览器绑定与顺序操作资格
- Status: done
- Owner: coordinator
- Objective: 在原生owner/session/terminal边界内保留browser精确窗口/profile授权和类型化输入，验证session/ref失效及无重放。
- Inputs and prerequisites: T-008所有权基础、T-026当前P04构建；独立空白profile/本地任务授权；实际Chrome二进制可用。
- Scope or files: pi-owned P04 native browser/SDK/bridge与限定fixture；只读审计固定browser engine、grant、transport，必要受控补丁/生成/定向tests；不操作个人profile。
- Expected output: 有来源的最小类型化browser通路、逐副作用cancel/撤权和tracked async drain、独立profile场景证据。
- Dependencies: T-008, T-026, T-028, T-029, T-030, T-031, T-032
- Execution steps: 先追踪固定engine/store/grant/prepare/CDP异步producer与side-effect边界，冻结最小实现；在独立输出内串行实施/生成/回归，只有权限与生命周期可证才真实GUI。
- Acceptance criteria: 精确native窗口到browser session/tab/ref绑定；新快照/navigation/reconnect/撤权使旧ref失效；无任意脚本入口、个人资料、foreground fallback或settlement伪terminal。
- Verification method: scoped Rust/session/ref/cancel barrier、生成/strict types/真实loop faux、独立空白Chrome profile/localhost场景与fresh console/TCC/Stop/native terminal/自然退出。
- Validation evidence: controlled registry仍未注册generic browser，Chrome二进制存在但未启动。T-028 transport已验收；T-027新增原生资源ledger子集（独立stage9Rust文件）：先注册inert resource、native runtime强持有、Drop保留异步记录、await descendant→parent drain后才退休metadata；public waiter丢失不取消监督任务，native cleanup丢失/失败/panic则sticky quarantine。注册CDP池固定session；首次借用foreign session和首次失败握手重拨两回归均before101/after0。最终core56/CDP33（重叠19）/SDK40/platform16全0；八文件scopedfmt0，runtime继承紧凑格式不泛化改写。lifecycle-verification0验证9文件patch27a67104正反应用/hash、586历史源/81pins/四锁与产品输入不变；root browser-lifecycle-check完整0/1376files无修复、193pass/5skip、38/38、drift0。见p04-browser/lifecycle-report.md；仅artifact增量、无ABI/生成或新库资格、无GUI/TCC/lease/model。随后distinct scope子集已通过：10Rust文件分离immutable NativeWindow/IsolatedBrowser，native implementation attestation拒绝generic prepare、固定isolated_new和one-shot claim，SDK/platform早期拒绝browser→AX。core66/registry70/authorization40/manifest15/SDK41/platform17及九文件fmt全0；scope-verification0验证incremental patch41e97239和593→596源边界，历史586输入/81pins/四锁/产品不变。browser-scope-check完整0/1376files无修复、193pass/5skip、38/38、drift0。见p04-browser/scope-report.md；无public ABI/生成/Chrome/profile/GUI。随后owned process-group子集通过：3Rust文件注册inert resource后才gated spawn，unreaped Child + WNOWAIT锚定ID，group无live成员后才reap；自然exit多余signal导致EPERM的先红后绿回归已修正。process11/11（含1 inert fixture入口）、五轮10/10、platform28（重叠11）/SDK41/core66及fmt全0；process.patch bd351bd1 apply/hash/reverse/596→598源核对0；browser-process-check完整0/1376files、193pass/5skip、38/38、drift0。详见process-report.md。此receipt仅group不含escaped helper，不能据此删profile；无Chrome/profile/GUI/新ABI/产物切换。最新image事实子集4Rust文件：current-UID PID/start/live/image双完整catalog一致后按目录component过滤，不读argv/env/profile；私有setsid leaf在group收敛后仍可见、IPC释放后才empty。5/5及五轮5/5、platform33（含5image+11process）/SDK41/core66/fmt全0；image-observer.patch24584ae5 apply/hash/reverse及598→600源边界0，browser-image-observer-check完整0/1376files、193pass/5skip、38/38、drift0。stock Chrome153.0.8010.48只读inventory和私有复制通过674file hash/7内部links/签名；未执行或建profile。新源码hazard：Mac code-sign clone可能在初始image root外创建副本和cleanup helper，image事实本身不构成ownership/terminal。详见image-observer-report.md与helper-lifecycle-audit.md；实际profile/helper生命周期/精确绑定/typed计划仍待，coordinator继续源审支持的launcher装配，不能因copy或空catalog降低门禁。随后三文件native launcher装配已完成离线验证：私有image/profile、one-shot spawn、固定endpoint解析及自有PID/image/start证明；cleanup按group→image helpers→目录，真实私有test进程证明清理顺序。platform42（含9新case）/SDK41/core66/fmt及隔离check0，193pass/5skip/controller38/drift0；launcher.patch59cd9c41和600→602源边界/历史输入核对0。assembler尚未注册或公开ABI，CfT未执行，真实helper/GUI资格、pool/page/window接线仍待；见launcher-report.md。该句为launcher轮历史：最新browser SDK已提供真实生成prepare facade及受控registry/pool/初始绑定，platform45/SDK43/core66/生成/N-API/header/strictTS/nohost load均0，isolated check0/193pass+5skip/controller38/drift0。prepare-live-2实际启动CfT但绑定拒绝，随后资源关闭隔离；无page输入。详见browser-sdk-report.md，未推广产品pins。
- Validation evidence (latest): unlocked-scenario共13个真实case全部通过；独立verifier核对351raw/26自然exit0/EOF/全部terminal/目录清理/C34–C46。child-live-1 root/child独立PID/window/两个私有profile，已分配child operation在祖先revoke后terminal(cancelled=true,inputCommitted=false)，零页面输入/两自然0至C47。bridge-live-1实际可选TS adapter/host/tool完成8/8及Press postcondition，lazy绑定不建owner/C47，首次prepare才取得lease；六外层acquire/六native operation、精确10事件/六terminal/两自然0/目录清空至C48。child-bridge独立verifier通过；真实AgentSession/faux4/4另证普通loop集成（非真实AgentSession GUI），81pins不变，无真实模型。详见unlocked-scenarios-verification.json与child-bridge-verification.json。
- Blocker: None. 受控DOM路线与独立子profile资格已通过，不宣称trusted keyboard/subframe/个人登录profile支持。
- Unblock condition: None. P04阶段收尾及后续像素/数据通路/打包仍独立验收。

### [x] T-028 — P04 CDP 投递与连接收敛边界
- Status: done
- Owner: coordinator
- Objective: 为受控browser增加实际socket投递处的逐primitive gate，以及可等待的writer/reader收敛；不把创建future或收到reply当成全部终态。
- Inputs and prerequisites: T-026原样保留的AppKit stage；已审计controlled.rs和完整cdp_ws.rs；持续实施授权。
- Scope or files: 独立p04-browser stage的core controlled/CDP及其定向tests；记录/补丁；不切换当前产品pins，不启动browser/GUI。
- Expected output: 有界复合input准入、受控socket不能走通用无gate调用、取消/撤权/遗失producer和关闭的barrier回归。
- Dependencies: T-026
- Execution steps: 校验并复制已资格输入到独立stage；在writer实际start_send前检查gate，不持gate等待socket；已准入flush保留原生producer；reader只接收，关闭必须await；针对性测试后供T-027集成。
- Acceptance criteria: 取消/撤权后无新input；未完成flush不能发terminal；失败不重拨或重放；通用SDK行为保留；不得据此宣称browser绑定/授权/GUI已通过。
- Verification method: 无GUI的local mock WebSocket及确定barrier、core相邻回归、locked/offline编译、历史输入hash与diff。
- Validation evidence: 独立p04-browser stage的5Rust文件实现受控socket/session绑定、typed固定primitive、逐条writer-ready→start_send gate和16input/step上限（AX单input不变）、async proof guard、writer收敛/reader abort+join及closed tombstone。core controlled40/40、CDP邻接25/25（重叠11项）、SDK33/33、platform16/16，locked/offline全0；继承warning保留。新增reader失败重复shutdown回归before101/after0，避免重复poll已完成JoinHandle；flush失败标记回归before101/最终40项0，关闭标记先于writer释放且poison后禁止poll_ready。verify-transport0核对5文件patch apply/hash/reverse、586历史输入/81pins/四锁不变；incremental transport.patch=9b6df0b6，仅artifact未切换产品pins。隔离browser-transport-check完整check0/1376files无修复、193pass/5skip、38/38、drift0。详见p04-browser/transport-report.md；未新增SDK facade/生成接口/原生库资格，未启动Chrome/GUI/模型。
- Blocker: None.
- Unblock condition: None.

### [x] T-029 — 浏览器资格脚本兼容请求进程承载的TCC责任证据
- Status: done
- Owner: coordinator
- Objective: 修正把responsible binary无条件等同宿主binary的过强假设，保持精确requester、bundle/responsible_path及逐服务Allowed证据。
- Inputs and prerequisites: prepare-live-1冻结日志；T-023；持续修复授权。
- Scope or files: p04-browser独立TCC validator/回归与qualification runner；历史脚本和日志只读。
- Expected output: 两种实测责任形态的严格判定、先红后绿及新行动PID资格。
- Dependencies: T-023
- Execution steps: 回放当前raw错误，加入错pid/path/bundle反例；仅同requester PID允许已核实Node binary，再新鲜逐进程准入。
- Acceptance criteria: 不放松责任bundle/path、uid、请求ID/daemon/activity/grant关联；不以旧getter代替新请求。
- Verification method: 原始日志before/after、历史宿主PID案例与反例、fresh preflight。
- Validation evidence: prepare-live-1拒绝发生在admit前，owner91449两getter true，tccd明确responsible ID/path仍为AgentPort、responsible PID=91449/binary=Node；两服务Allowed；零native owner/Chrome，fixture及Node自然0/EOF，C23不变。原validator强制responsible binary=AgentPort而拒绝。raw回放原validator为1error/8pass/exit1，最小修正后9/9/exit0；仅responsible PID精确等于requester时允许已核实Node binary，host bundle/responsible_path及完整service链不变。fresh Node93502的两服务完整Allowed链通过并记录owner.preflight.json；后来browser绑定/cleanup失败不归因权限。
- Blocker: None.
- Unblock condition: None.

### [x] T-030 — 浏览器首次真实绑定拒绝与资源关闭隔离定位
- Status: done
- Owner: coordinator
- Objective: 区分精确窗口候选拒绝与资源cleanup失败，补足有界诊断并修复已证明原因，不伪造终态。
- Inputs and prerequisites: browser-sdk固定源/生成与prepare-live-2冻结raw；持续修复授权。
- Scope or files: p04-browser受控Rust/私有回归及诊断harness；旧SDK/raw/profile和D24保留，不新增GUI owner。
- Expected output: 有证据的最早失败边界、定向回归和最小修复；明确仍需实际资格。
- Dependencies: T-029, T-028
- Execution steps: 先保存源/产物/raw；补获仅自有PID窗口metadata和静态cleanup原因的诊断，运行无GUI回归；真实复现必须等专门恢复门禁，不推测代码修复已成立。
- Acceptance criteria: 原始失败不覆盖；不放宽target/ownership、不信任ps无匹配或Node自然退出作为资源终态；无自动清锁/动作重放。
- Verification method: 真实raw分支定位、私有资源和绑定反例、生成一致性、恢复后新鲜GUI资格。
- Validation evidence: prepare-live-2 owner93502成功TCC/admit，prepare的terminal(cancelled=false,inputCommitted=true)后返回browser_window_ambiguous；close仅Quarantined，Node自然1/fixture自然0/EOF，forced为空，D24/历史inode和私有profile保留。代码将绑定拒绝定位到exact_window候选count/zero-ID guard；底层cleanup原因及窗口候选未保留，当前不能唯一归因。之后两Rust文件仅显式opt-in输出资源index/static reason与≤16个自有窗口numeric metadata，不改变准入/清理规则。diagnostic1/1+2/2、platform45/SDK43/core66/生成及check/N-API/header/nohost均0；隔离check0/193pass+5skip/controller38/drift0。首次JSON宏括号编译101保留、修正重跑0。旧16产物已逐hash归档，diagnostic patchdd84611e/605源边界和原失败raw不变。D24恢复helper复用未改lease validators，仅私有20/20通过；新诊断runner准备但未执行。见drain-diagnostic-report.md及verification.json。该诊断轮无实际根因修复/GUI重试/旧terminal声明。随后D25实际数值证据证明总count误拒绝及catalog_changed过早隔离；四case原行为3fail/修复后4pass，platform49/SDK43/core66/生成/check/全仓检查通过。D25按新明确批准恢复C25后，fixed-1原生prepare/close成功C26但probe EOF访问destroyed句柄自然1；两项脚本回归before2fail/after2pass修正幂等性。fixed-2 fresh owner21507/Chrome21547/window150完整prepare、terminal(false,true)、native-close→destroy、两个自然0/EOF、私有目录清空、C27；独立prepare-qualified-verification核对raw/新TCC/产物。无page input，旧D24/D25不补造终态。
- Blocker: None. 两项native修复及真实prepare/close资格通过；随后发现的probe EOF对已destroy句柄再次revoke也经两项before1/after0回归修正。不是完整browser plans验收。
- Unblock condition: None. D24/D25两次特定行政恢复均已消耗，不推广为自动恢复；最后clean C27无需恢复。

### [x] T-031 — 浏览器首次导航未确认的因果定位
- Status: done
- Owner: coordinator
- Objective: 定位current-form-live-1导航约20秒未确认的最早边界，修复经证据证明的原因。
- Inputs and prerequisites: 当前children产物与C28 clean close；持续诊断修复授权。
- Scope or files: p04-browser独立诊断、受控native源及fixture；保留旧源/产物/raw，不修改个人profile或全局网络配置。
- Expected output: 有界错误/事件证据、最小回归修复及真实新profile验证，或明确外部硬阻碍。
- Dependencies: T-030
- Execution steps: 冻结失败输入；区分transport超时、浏览器错误和文档等待；先定位再修复，不能直接延长超时或重放不明输入。
- Acceptance criteria: 原因有因果证据；未知动作不重放，terminal/clean close门禁不放宽。
- Verification method: 原始trace、定向离线回归、生成一致性及fresh console/TCC/Stop下专用新profile。
- Validation evidence: 三次失败至C30；Page/Network起始事件及exact自有browser stack定位Keychain授权等待。matching153源码确认test flag选择内存FakeKeychainV2；command回归before101/afterpass，固定use-mock-keychain后导航HTTP200/返回且对照sample无原授权等待。临时diagnostic两源已恢复，最终core69/registry70/platform59/SDK45/生成及严格类型通过；form-fixed-live-1无诊断产物完整八步/Press、六terminal/两自然0/EOF/目录清理/C33。verify-browser-form-fixed独立复核六runs；complete-check全0/193pass+5skip/controller38/drift0。见p04-browser/form-fixed-report.md；不访问/批准个人keychain、不声明持久加密。
- Blocker: None.
- Unblock condition: None. 独立空白临时profile限定，不推出完整browser/P04通过。

### [x] T-032 — 浏览器输入内部action record接线修正
- Status: done
- Owner: coordinator
- Objective: 修正typed browser输入结果在canonical action投影处失去内部record而被拒绝的问题。
- Inputs and prerequisites: keychain-form-live-1已捕获一次Name输入及unknown结果，原生clean close至C32；T-031导航修复输入。
- Scope or files: controlled_browser/session/page.rs及tests；限定离线/真实新profile验证，旧raw不变。
- Expected output: 内部执行record由真实producer产生，保持DOM/background/确认与未知区分，canonical投影不绕过。
- Dependencies: T-030
- Execution steps: 从canonical publish_action_result回溯producer；最小回归复现legacy adapter无法识别typed dom payload；补齐record后重跑原路径。
- Acceptance criteria: 不凭oracle补造旧成功、不重放旧Name输入、不绕过canonical校验，不把Press未确认变成confirmed。
- Verification method: exact canonical record seam先红后绿、platform/core/SDK及生成检查、fresh fixture完整表单/Press独立oracle。
- Validation evidence: keychain-form-live-1仅Name一对真实input/change但prefix0/native_action_unconfirmed，cleanclose至C32。exact canonical record seam回归before101/afterpass；producer补内部BrowserCdpRuntimeFunction/background/readback记录，不绕过canonical。最终platform59/core69/registry70/SDK45/生成/check/types通过；form-fixed-live-1真实8/8与Press postcondition通过，Press action仍Unverifiable，独立oracle精确四对input/change＋一次Save，六terminal/两自然0/EOF/目录清空至C33。独立verifier及完整隔离check0/193pass+5skip/controller38/drift0；原unknown不补造成功。增量四Rust patch2f598c44，详见form-fixed-report.md。
- Blocker: None.
- Unblock condition: None. 完整browser对抗场景/children/bridge真实资格仍归T-027。

### [x] T-033 — 浏览器启动目录瞬变与D65隔离诊断
- Status: done
- Owner: coordinator
- Objective: 修正启动阶段对瞬变image catalog的过早失败，补证资源关闭未确认的边界；不得自动恢复D65。
- Inputs and prerequisites: P05 plist-browser-ref冻结raw、D65/原canonical inode、当前候选及P04封存输入；持续离线修复权限。
- Scope or files: P05受控launcher及私有readiness回归、被保留的专用D65 root只读事实、独立诊断/恢复材料；不改P04，仅经新批准和前置验证后一次原位恢复D65 marker。
- Expected output: 有界被动ready重读的先红后绿回归、生成一致性、明确的close证据边界及必要的单次行政恢复决定。
- Dependencies: T-027
- Execution steps: 保留原输入/raw；只读核验当下自有image空集；在原15秒启动预算内仅重读image_catalog_changed，不重拨/重启/重放输入；不能从deadline推断cleanup唯一原因。Canonical恢复仍需新明确批准。
- Acceptance criteria: 不把catalog变化当空、不放松PID/image/start或全catalog完整性，不增加未知helper信号；旧close失败不补造terminal。
- Verification method: 冻结raw/来源hash、私有readiness状态机回归、locked/offline编译及生成；三新鲜完整image facts；恢复与GUI另行准入。
- Validation evidence: plist-browser-ref owner17104本次TCC通过，prepare terminal(false,true)后image_catalog_changed；持久files资源index0关闭报browser_helpers_not_drained，process资源按逆序已先返回。Node自然1/fixture自然0/EOF，无forced/页面输入，D65。固定root inode136044957/0700/uid501的独立native只读helper三次完整稳定catalog为0live，oldTerminalProven=false；同bootUUID仍1124DF55-8742-457B-A793-BA8FAED3B8AC。原始close时是活helper还是持续catalog变化尚不能唯一判断。
- Validation evidence (offline repair): 原readiness两项回归before101/修复后5/5（含取消、预算后不再读、wrong image拒绝）；仅在原15s内被动重读catalog_changed，所有正证明/取消/cleanup5s规则不变，额外诊断只输出未来失败的最后静态类别/数量。platform68pass+1显式micro忽略、SDK45/core69/生成及check/N-API/header/严格boundary类型/load-only全部0；新两Rust增量b25146ff及81pins核验，旧raw/产物和P04产品未改。见p05/d65-report.md与d65-readiness-inputs.json；未复测GUI，也未声称cleanup唯一原因已修复。
- Validation evidence (final): D65新明确批准后20私有case及fresh boot/empty/catalog/storage门禁通过，同inode一次归档fsync恢复C65；后续目录缺陷单列T-034。最终相同readiness实现的13browser case全部cleanclose、26自然0，通过final-browser-verification（351raw），未放宽15s预算或完整性。
- Blocker: None. Readiness限定修复和最终浏览器邻接已验证，旧D65终态仍未知。
- Unblock condition: 用户确认单次D65行政恢复约定或选择重启；获准后先私有恢复测试/新鲜empty-image/boot/固定输入/canonical身份和排他锁复核，再仅一次归档同inodeD65→C65，随后fresh console/TCC/Stop。

### [x] T-034 — D70目录稳定性失败的因果定位
- Status: done
- Owner: coordinator
- Objective: 定位readiness修复后仍出现的完整image catalog变化，区分持续瞬变与读取实现错误；不削弱完整目录比较。
- Inputs and prerequisites: readiness-browser-readonly原始失败和D70保留目录；用户持续自主修复授权。
- Scope or files: P05受控image observer及独立只读诊断/回归；旧原始证据只读。
- Expected output: 静态类别与耗时/计数证据、可复现回归和最小修复，或明确外部阻碍。
- Dependencies: T-027
- Execution steps: 冻结失败输入；无SDK的有界passive observer对照，定位最早失败分支；证明后修复并验证，不自动重放GUI。
- Acceptance criteria: 完整双catalog和PID/start/image证明不放松；不把进程消失或新空集当旧terminal。
- Verification method: 原始raw、passive诊断、先红后绿回归及邻接测试；恢复另经事实核验。
- Validation evidence: D65恢复私有20/20及609输入/81pins、新三次empty facts通过，唯一canonical恢复0至C65；四browser场景ref/stale/navigation-stale/secure通过至C69。第五readonly在prepare报image_catalog_changed，files清理最后观测仍为image_catalog_changed且lastLiveCount=null，关闭隔离至D70；无页面输入/强制终止，批次已停止。
- Validation evidence (final): 10次私有zombie前/中/后对照及真实EOF/WNOWAIT退出竞态证明两个独立读取缺陷；两回归before101→after0，最终platform70+1ignore/SDK45/core69及生成/header/types/load全部0。held-zombie真实prepare/close在私有zombie仍存在时成功C81；最终13browser与十AppKit回归完成，621raw/46自然退出验证到C106。D70/D83按最新standing权限分别20私有case+fresh证据/排他锁/先归档fsync后一次恢复，旧profile/raw保持；未声称原失败唯一根因或旧terminal。见d70-report.md及d83-path-race-*、final-*证据。
- Blocker: None. 两已证局部修复和最终GUI邻接完成；历史现场errno缺失的归因限制保留。
- Unblock condition: 已证原因修复及必要行政恢复前置全部通过后再新鲜GUI准入。

### [ ] T-035 — P06受控图像字节、坐标与必要输入通路
- Status: blocked
- Owner: coordinator
- Objective: 在现有canonical授权/owned operation下补齐真实像素观察和有界类型化数据，保留失效/取消/资源回收语义。
- Inputs and prerequisites: 已封存P05；独立P06 stage，当前截图实现与生成API实际审计。
- Scope or files: P06 core内部结果/SDK Computer契约及platform截图和必要动作；genuine生成、optional TS边界与fixture。
- Expected output: 单次必要编码的有界图像字节、明确geometry/DPI/crop映射、原生buffer回收和真实专用窗口像素证据。
- Dependencies: T-010
- Execution steps: 先审计原capture worker/timeout/fallback生命周期；不得直接继承未await的线程或shell fallback。类型化producer保留canonical准入，再生成并按纯坐标/内存/取消→真实fixture顺序验证；必要新动作逐副作用检查。
- Acceptance criteria: 不把路径当视觉输入；图像不重复Base64/raw JSON，不返回个人桌面截图；未知几何/目标/ref拒绝，无私有字段后门或伪terminal。
- Verification method: 纯像素尺寸/变换边界、buffer生命周期和取消barrier、生成/类型检查、获准exact-window GUI与独立图像oracle。
- Validation evidence: P06已实现14Rust文件的类型化Image/Geometry、macOS serde-skipped字节carrier、canonical get_window_state capture-only分支和genuine startCapture。原生调用留在Operation::blocking内，取消不绕过SCK completion；未用原3s detached worker、shell fallback或warm-cache重绑。contract49/core71/platform72+1ignore/SDK49、生成/check/NAPI/header/types/load均0；新增geometry/header4、carrier2、capture2及SDK metadata/lifecycle4（有重叠）实际通过。第一轮编译遗漏三个legacy ToolResult字面量的None字段已修正并重验；floating fixture提示不能无根据要求layer0，改为同层身份前后相等并重新生成。qualified image patch ad1696d0/81pins，P05原样。专用opaque彩色fixture严格Swift6编译和control smoke通过，独立PNG oracle3tests覆盖五filter/CRC/翻转/越界；真实image-native-live-1已通过双尺寸四象限/几何oracle、五terminal、stale拒绝/取消无图像、close/destroy及两自然0/EOF到C107；尚待完整独立raw复核。人工图像审阅发现Stop/文本区域不可见，新contrast oracle在两个原PNG均拒绝；原因未证。仅将fixture外观固定Aqua、保持相同SDK/capture scope，实际双尺寸控件contrast及原oracle通过到C108；不需开启child-window capture，旧fixture/manifest/raw保留。首buffer实验在native close/destroy/hash检查成功到C109后，test-only GC断言失败；no-SDK对照证明async for-of检查范围保留最后buffer，移到已完成同步范围后真实buffer-scope-live通过：两实际FFI图像在native销毁后hash不变，释放consumer引用后两个WeakRef均回收，五terminal/两自然0到C110。独立image-buffer-runs-verification核对三成功轮81raw/15terminal/六自然0；C109失败不改写、不恢复lease。image-current-check完整0/1395files无修复、193pass+5skip/controller38/drift0。仍不声明零拷贝/全进程无泄漏、模型图像及新输入完成。
- Validation evidence (pointer): 新21Rust增量p06-image-pointer.patch=6cc17c2a，完整独立Git根apply/byte-compare/reverse通过；contract49/core73/platform75+1ignore/SDK53、genuine生成/check/NAPI/header/types/load全0。首次pointer被hardware guard拒绝零input至C111；CapsLock锁定状态误当held key的回归before101/afterpass，保持其他键/按钮和FlagsChanged并发检查，不改OS状态。修正SDK真实512/1024图像分别点击非AX canvas，精确两down/up、counter0→2、fractional坐标独立验证、无foreground转换，旧图ref重用拒绝，六terminal/两自然0至C112。下一stale case仅交换两个外观相同空字段，却期待像素改变；实际一个canvas click/counter1、三terminal/自然owner1+fixture0/clean C113，失败保留不改写/重放。独立no-input截图对照在console明确locked=true前置拒绝，零children；modal/bounds/cancel未启动。新显式canvas-hide及window-move fixture严格编译/16harness输入验证通过，但GUI未运行。pointer-runs-verification核对58raw，独立三pointer-oracle tests及既有六图像tests通过；pointer-current-check完整0/193pass+5skip/controller38/drift0。详情p06/pointer-report.md。
- Validation evidence (unlocked and scroll): 解锁后六pointer场景已157raw/21terminal/12自然0到C119独立验证，包含1×与历史2×落点。新增滚动26Rust/81pins、49/74/76+1ignore/55和genuine生成/types/load通过，scroll.patch aa17285f独立apply/hash/reverse通过。首wheel实际deltaY=-1/clipY160→150、三terminal/两自然0到C120，但oracle错当NSScrollView坐标未翻转，且空AssertionError消息导致父脚本错误exit0/result=null；两问题回归分别before1fail→3pass、before2fail→3pass修正。原记录保留为失败，P06报告审计仅发现该假成功。新fixture实际报告isFlipped=true/height160，未改native坐标/守卫。修正父脚本后的scroll-checked-down被user_input_conflict零输入拒绝，三terminal/owner自然1+fixture0/clean C121；批次停止。30次passive采样无held非toggle键/按钮但计数变化，不能推断事件来源。scroll-failures-verification复核50raw及旧oracle原始复现。最新scroll-current-check完整0/193pass+5skip/38/drift0。
- Validation evidence (quiet interval): 用户确认“现在可测试”后九scroll-ready-*全部通过C122–C130；四方向各一真实wheel并带实际NSScrollView位移，图像重用/画面变化/窗口移动/modal/bounds/preabort拒绝。独立verifier核对234raw/31terminal/18自然0，原两失败不改写；已通知用户可恢复键鼠，job-bound caffeinate自然结束。随后审查补足tracking move之后、最终down/wheel之前的目标/模态重查：精确纯seam回归before101/afterpass，platform77+1ignore及其余49/74/55、genuine生成/types/load通过；并统一本新增CGEventSetLocation声明与既有macOS两FP ABI，新增clashing warnings消失。最新target-recheck-*26Rust/81pins、patch69ef0c0b，独立新quiet采样true；click/scroll-down/scroll-modal三个真实邻接通过C131–C133；两个独立verifier合计核对79raw/13terminal/六自然0/EOF，job-bound assertion已结束。target-recheck-current-check完整check0（1395files无修复）/193pass+5skip/controller38/drift0。仅纯seam证明tracking后目标变化拒绝，未实测hover触发modal。
- Validation evidence (keyboard): 新32Rust/81pins候选keyboard-final.patch=41f020d2deff619c9b7adbeb598f874b2f7d52f1b7780c41f6f4158c566b95ca，加入genuine startImageKey及13种固定非文本键。沿用canonical press_key/destructive=true、单次image ref、GenericKey唯一同PID目标、fresh完整目标/modal/画面及硬件检查；单primary down配对up为release义务，无modifier/chord/text/foreground/双transport fallback。contract50/core74/platform80+1ignore/SDK56及genuine生成/check/NAPI/header/strictTS/load通过；旧composition测试仍禁止press_key的预期随新增受控注册调整，继续拒绝generic hotkey/type_text且新增destructive断言。首次typecheck遗漏必需SDK路径的失败保留，正确参数重跑0。专用键盘fixture严格Swift6编译/Stop smoke、独立key oracle3tests及实际parent reporting3tests通过。live真实Tab/Return两对送达原窗口/counter0→2、无pointer或激活变化；ref重用、画面变化、same-PID sibling、modal及preabort拒绝，五轮keyboard-runs-verification独立131raw/13terminal/十自然0/EOF至C138。仅Tab/Return有实际送达资格，其余11键是编译/映射覆盖；取消后release为纯seam证明，未声称真实mid-key取消。keyboard-current-check完整0/193pass+5skip/controller38/drift0；原P04产品pins及main scroll实验patch保持69ef0c0b，未推广键盘构建。
- Validation evidence (discovery candidate): 新37Rust/81pins候选23b1e498加入只读Discovery scope、genuine openDiscoverySession/startListWindows/startSelectWindow及一次性目录引用；选中会话仍继承父native授权/撤权，输入和内容观察不从metadata获得许可。目录最多256项，标题/名称/无损ID/进程启动身份有界校验，选择时tracked worker重验精确条目；未按相似标题自动替换。50/76/81+1ignore/59及genuine生成/type/load、独立patch正反字节验证、完整隔离check0/193+5skip/38/drift0通过。真实selection-stale首轮在discover返回discovery_metadata_unproved，尚未选中或输入；一terminal(false,false)、owner自然1/fixture0/EOF、clean C139。错误发生于platform row或SDK decode，原错误码未区分；已封存37源/SDK/raw至discovery-diagnostic-before，正在仅静态错误类别区分的诊断构建，不提前认定原因、不放宽准入。
- Validation evidence (discovery current): 当前37Rust/81pins候选discovery-eligible.patch=8314efe72f71e14b438776acbed0293fefd187f82d925c8b6a49f5dc4f489e51，50/76/84+1ignore/59及生成/check/NAPI/header/type/load/独立patch正反字节验证通过。目录把单条候选不合格误当全目录失败：geometry聚合回归先在同类错误码失败后通过；其首次回归的缺分号编译失败不作before证据。geometry-only修正后又因某行进程身份无法证明拒绝，第二回归before101→afterpass；现只为identity/geometry/metadata预算均合格的条目发ref，其余明确omittedWindows计数，不当完整/空目录，更不改变browser helper drain的完整catalog门禁。原C139/C140/C141只读失败保留。C142旧probe仅probe_failure，未补造具体类别；C143诊断明确AppKit move ack后native仍返回WindowSelected，零输入。新独立read-only observer在同一run先读旧x1000再读新x1040，确认AppKit ack不等于WindowServer可见；只在新native geometry成立后旧ref被正确拒绝，C144。六轮独立verifier核对145raw/11terminal/12自然退出（五失败owner1、成功owner0；fixture均0），全部零input；仅最后stale-selection资格通过。三readiness纯测试和新parent reporting三tests通过，ready harness37Rust/81pins/19文件已冻结。正向select→capture→key未执行：fresh quiet实际78/held非toggle输入及counter变化，保留guard并等待用户安静时段。
- Blocker: 正向GUI输入资格被硬件活动阻塞。首次discovery-live-quiet两项活动均true；离线准备结束后fresh discovery-ready-quiet仍exit78（held=false，但counterChangeObserved=true）。不是缺少模型或commit许可；新gpt-6-astra low/阶段commit授权已记录，目前不需真实provider调用。
- Unblock condition: 用户释放按键/按钮，提供约1分钟安静时段；从expected C144重新核验quiet/console/固定输入/TCC/Stop，再运行run-discovery-ready.py live的新证据名。不得删除冲突检查或恢复clean marker。

### [ ] T-036 — P06原生快速构建实际裁剪
- Status: pending
- Owner: coordinator
- Objective: 把不需的远程/展示/录制实现排出Computer发行构建，保持必要平台和授权核心。
- Inputs and prerequisites: P06真实release闭包、T-035冻结的必要能力及P05保守回退源。
- Scope or files: P06 Cargo features、SDK/platform/core模块边界及生成脚本，不修改P05或主仓库无关依赖。
- Expected output: 可复查前后依赖/符号/产物大小与完整生成ABI，明确保留/排除表。
- Dependencies: T-035
- Execution steps: 按实际消费者隔离生产profile，先从构建图排除再删不需源；不以不注册工具当未编入，不重复实现授权或FFI框架。
- Acceptance criteria: 实际fast图和产物排除非目标模块；授权/取消/browser/截图均通过邻接；未测平台明确不支持。
- Verification method: locked/offline Cargo graph/build/test、符号和载入检查、genuine生成、T-035及既有browser/AppKit邻接。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

P00 必跑 `npm run build:offline`、`npm run check`、`./test.sh`；先读脚本，在隔离快照执行并保存完整日志与退出码。定向测试使用复用 test.sh 隔离环境的明确入口，而非伪造 test.sh 参数。普通检查保持REAL_APIS=false；必要真实模型测试按最新批准使用gpt-6-astra low（此前qd/kmodel_latest high批准保留），有界定向显式opt-in；截至本次授权更新仍零调用。GUI范围遵循最新授权，并须先通过console/宿主/权限/fixture前提；锁屏期间不启动GUI。具体文件及后续命令随源码审计落入 test-matrix，不先猜测。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- **当前状态（2026-09-20 C144后）**：Discovery目录与过期选择拒绝已得到限定真实证据；新37Rust/81pins/8314efe7、原生50/76/84+1ignore/59与genuine生成/type/load通过。六轮145raw/11terminal/12自然退出已独立复核，五旧失败不改写。正向窗口选择→截图→键盘尚未执行：首次quiet检测held及counter活动，离线准备后的新quiet仍counterChangeObserved=true/held=false/exit78；T-011/T-035 blocked等约1分钟安静时段。不需重启/lease恢复；没有活跃GUI或持续power assertion。新provider/commit/publishing权限已更新，不是阻塞原因。

- **历史状态（2026-09-20 C138后）**：键盘候选32Rust/81pins/41f020d2已取得五轮专用GUI资格，131raw/13terminal/十自然0独立复核至C138。最新完整check0/193pass+5skip/controller38/drift0；无活跃GUI或临时power assertion。T-035下一步由coordinator审计并实现必要应用/窗口发现与精确选择，随后host图像和T-036/P07/P08；没有真实模型请求/恢复lease/产品pins切换。旧候选保留keyboard-before。

- **历史状态（2026-09-20 C133后）**：最终primary目标重查候选69ef0c0b的click/scroll-down/scroll-modal邻接已通过，79raw/13terminal/六自然0/EOF独立复核，最后clean C133。完整隔离check0/193pass+5skip/controller38/drift0；无活跃后台任务。用户此前安静时段已结束，未来GUI仍需fresh冲突检查。T-035继续键盘/窗口定位/host图像，T-036/P07/P08未交付；下述C130/C121/锁屏条目均为历史。

- **最新状态（2026-09-20滚动修正后）**：C121干净但GUI验收被user_input_conflict及后续HID计数持续变化阻塞；需约3分钟无键鼠操作窗口。已修正scroll测试的view-flip oracle和空错误假成功，原exit0/result=null不算通过。26Rust原生未因测试失败放松任何守卫。新父脚本/fixture/pins已冻结、原失败50raw独立验证、完整scroll-current-check0/193+5skip/38/drift0。Tasks19/24的有界caffeinate均自然结束，无持续电源修改。下述锁屏和C119条目为历史阶段。

- **当前状态（2026-09-20解锁后）**：新六pointer场景全部通过C114–C119，157raw/21terminal/12自然0独立验证；1×新live与2×历史live均验证精确像素落点。T-035继续coordinator补受控滚动：26Rust/81pins、contract49/core74/platform76+1ignore/SDK55和genuine生成/types/load已过，新NSScrollView fixture严格编译及独立wheel/offset oracle两tests通过。下一步expected C119 fresh GUI；T-036/P07/P08仍待，尚无真实滚动或整阶段完成声明。有界caffeinate task-19仍用于资格，不是正式性能条件。

- **历史状态（2026-09-20锁屏前）**：P05已验收；P06类型化图像及两实际non-AX像素click限定验证通过C112，stale测试刺激只换同外观空字段、实际一次click的失败完整保留，native clean至C113。独立纯截图诊断在明确locked=true前置拒绝、零children，T-035/T-011 blocked等待用户手动解锁。新21Rust patch/81pins、49/73/75+1ignore/53及生成类型load通过；58raw独立复核，pointer-current-check全0/193+5skip/38/drift0。修正后的可见变化/几何fixture仅编译通过，GUI未运行；T-036实际裁剪/P07/P08仍未交付。没有恢复lease、操作锁屏或真实模型请求；caffeinate仍停止。
- **历史硬阻碍（2026-09-19T17:16Z）**：P05五组counterbalanced原生表单A/B全部通过，median26.512→17.929s（−32.37%），metadata8.753→0.213s、guard检测时间不变，30terminal/20自然0至C64；这是组件诊断，不是P08总体/p95。随后browser回归在unchanged launcher准备阶段image_catalog_changed，files关闭期限内未证明helper收敛，D65。已停止GUI并保留现场；当前三次native只读image空集不补造旧terminal，不自动恢复。T-010 blocked，T-033离线修复已验证；最新用户批准后恢复准备in_progress，尚未修改D65。全仓类型检查另有并发narrative/verify-feasibility测试错误，未修改其代码。
- **历史状态（2026-09-19T15:20Z）**：T-027/P04有限顺序段门禁通过；13browser场景、真实child/bridge及逐动作对照/合并SDK AppKit表单验证到C50，全部自然退出/原生终态。完整隔离check0/193pass+5skip/controller38/drift0；无租约恢复/真实模型调用。T-010开始独立P05测量，未实施或声称性能优化；P06像素/裁剪、P07打包、P08正式性能仍待，下列锁屏条目为历史。
- **历史硬阻碍（2026-09-19T14:40Z）**：T-031/T-032已验证修复，browser真实八步表单/Press及独立oracle/六terminal/两自然exit0/清理通过，最后C33。新13case对抗harness语法/4私有测试通过，但首case scenario-ref明确console locked=true，零children，批次立即停止，其余未启动。T-009/T-027 blocked等待人工解锁；不需要重启或lease恢复。最新完整隔离check0/193pass+5skip/controller38/drift0；bridge7/7+真实faux loop4/4。没有实际browser bridge/children或完整P04–P08通过声明。
- **历史状态（2026-09-19T13:52Z）**：browser children与可选TS桥接离线通过；真实AgentSession/faux4/4（11→5仅合成请求）、AppKit桥接43/43及loop4/4。新完整隔离check0/193pass+5skip/controller38/drift0；首次快照遗漏并发live-line-scroller.ts和当时compaction类型漂移的失败保留，不修改并发产品。锁屏前置曾拒绝零children；最新console无已知lock、fresh TCC/Stop通过后，current-form-live-1实际prepare成功，navigate在约20s后browser_navigation_unconfirmed，无页面oracle记录、未发送Fill/Press。两个terminal、native close/destroy、owner自然1/fixture自然0/EOF，无forced，C28同inode；不需恢复。下一步定位navigation响应边界，不能将当前browser input称为GUI通过。
- **历史状态（2026-09-19T10:17Z）**：D25已按新的明确单次批准恢复C25；固定原生实际prepare/close到C26，harness EOF幂等缺陷也修复后完整fresh资格到C27，两个自然0/EOF/资源清理通过。T-030 done，T-009/T-027继续in_progress，无需租约恢复。下列D24/D25阻碍为历史；两次行政恢复不补造旧terminal或授予无限恢复。
- **最新状态（2026-09-19T10:03Z）**：已执行批准的一次D24→C24恢复；新诊断失败留下D25。其窗口总count和瞬变catalog两原因已回归修复，原生只读三次image空集补证已取得；新的D25行政恢复仍需决定，尚未执行。下列D24/重启阻碍均为历史，不能据旧批准重复恢复。
- **最新硬阻碍（2026-09-19T09:07Z）**：实际CfT准备有operation terminal但持久资源close隔离，canonical为D24/原inode。未获得clean host-close，不能从Node自然退出或ps无匹配推出资源终态。保留私有profile/镜像与原始日志；T-009/T-027/T-030 blocked，不自动恢复标记或启动下一桌面owner。下列C23/锁屏条目仅历史状态。
- 历史console lock=true门禁在用户2026-09-19报告手动解锁后已复核：onConsole=true/private lock key unavailable，加上原P04真实完整观察通过；不把key缺失当独立解锁证明。T-025 done，真实八步表单已通过；T-009继续对抗场景，T-026已修正modal原因投影并完成十AppKit场景；T-027继续browser，最后C23无需恢复。保持known-locked前置拒绝，不将此次环境解除扩大为任意AX拒绝的唯一根因。
- P00 开始已有 22 个用户变更路径，含 sdk.ts；之后共享工作树继续变化。只修改本任务路径，禁止 reset/clean/stash；最终来源哈希见 p01/verified-source-manifest.json。
- `npm run check` 会改写全仓；使用隔离副本，审查产生的差异，不回写无关修复。
- 原生工具链版本存在不代表依赖缓存、库产物、TCC 与 UI loop 可用。
- 原P03资格失败证据保留：owner56354首个observe超时，cleanup Stop/close无回执且强制终止，旧terminal未知。T-021局部锁循环修复已验证；用户重启并确认后，T-022仅一次归档/原位恢复D1→C1，不将进程消失、fixture counter0、重启或unit pass当旧terminal。新资格失败仍须停止，不自动再次恢复/替代owner。
- GUI仍只授权专用窗口内容/直接输入及必要SDK附带metadata/焦点行为。历史TCC失败保留；用户更正条目后，p02-live两个真正行动进程各自权限/归属通过，限定AppKit可见状态/Stop IPC与Node响应性已验证。未修改AgentPort/签名/权限数据库或终止持久后台；未来进程不能复用本次资格。
- 依赖/编译、load/ABI/codec、adapter契约和限定fixture的P02真实基线已通过；不等于生产Computer已交付。P02通用SDK的Rust abort/escaped AX终态缺口仍在。P03新增受控路线已通过driver-owned terminal资格；P04生产bridge必须仅使用此受守卫路线，不能把通用SDK settlement当terminal。
- P00/P01 固定快照的全仓失败是历史证据；T-016 最新完整 build/check 已通过、全套测试仍10失败（footer定向8/8，未诊断全量超时）。未提交/未暂存：任务未整体完成，pre-commit 会在共享树运行全仓 biome --write；不绕过 hook、不格式化用户文件。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-18: 用户通过结构化输入确认工作树、平台和最终执行契约；三开关 false。
- 2026-09-18: T-001/T-002/T-003 进入 in_progress；源码审计将只读并行，coordinator 独占记录和隔离验证。
- 2026-09-18: 准备期间共享工作树 22→26 处变更；以复制时哈希校准。之后其他工作继续变化，保留且不归为本任务产物。
- 2026-09-18: B01/B02/B03/B04 实际退出码 0/1/0/2，日志完整保存；既有失败不修复、不删测试。
- 2026-09-18: T-001/T-002/T-003 done：P00 门禁满足，native 构建/GUI 明确未验证。T-004/T-005 in_progress，限定 wrapper 与新增 Computer fake 文件并行；P02 的依赖阻塞条件已发现，待 P01 完成后记录正式停止点。
- 2026-09-18: 审计子代理结果未投递到 mailbox，coordinator 独立复核关键原始证据后验收，不依据 completed 标签。只读子代理不能扩工具权限，完整 fork 新建遭 limit_reached；退休审计会话后用小型 isolated 合约成功派发 computer-wrapper-small / computer-fake-small，并要求结果保存到本地 evidence。
- 2026-09-18: T-004 done：coordinator 实读 diff/测试并重跑 7/7 exit 0；只完成透传和包装/snapshot 单元门禁，真实最终准入/调度仍待 T-006。
- 2026-09-18: T-005 done：coordinator 完整复读三源文件及 fake/tests，重跑 17/17 exit 0；无 native/GUI/模型请求。T-006 in_progress：基于稳定 API 实现真实 createAgentSession + faux 集成及隔离回归。
- 2026-09-18: 恢复时重新核对工作树，其他会话仍在修改非本任务文件；不覆盖。integration 8/8、合并定向回归 176/176 exit 0。用 P00 隔离副本叠加仅 9 个本任务源码/测试文件，记录 overlay-manifest；不混入其他并发变更。
- 2026-09-18: 全局 check 捕获 wrapper 测试 fixture 的泛型赋值和不完整 runner 断言错误；仅本测试改用现有 defineTool 与明确的窄 mock 断言，未降低行为断言。重跑 7/7 exit 0；check 再跑只剩已有 TS2339（exit 2），没有 formatter 改动。退休已完成实现子代理，派发 computer-p01-review 做只读独立审查。
- 2026-09-18: T-006 done：受控副本 offline build exit 0；test.sh exit 1 与 P00 相同 27 失败、新增 32 测试全过；失败集合比较、源码哈希与副本变更边界通过。coordinator 审阅独立 review（无发现、32/32）及原始证据后验收 P01 功能门禁，未声称全仓检查通过。T-007 in_progress：仅复核原生材料和固定工具链是否足以进入 P02，不安装、不初始化、不触发 GUI。
- 2026-09-18: T-007 blocked：复核仍缺原生材料/依赖，工具链 1.95.0 ≠ 固定 1.97.1，三个许可开关不变。停止于 P02 入口；T-008—T-013 未开始。补齐 P01 实际 API、原生能力缺口、精确测试矩阵与安全恢复边界。没有绕过提交 hook，未提交。
- 2026-09-18: 最终 9 文件 read-only Biome exit 0、无修复；tracked 局部 git diff --check exit 0，两个既有源文件仍仅 10 行新增、暂存区为空；任务文档 validator exit 0。只读 reviewer 已退休。临时证据脚本归档至 .artifacts/computer/p00 与 p01；LEARNS.md 未修改（仅常规类型 fixture 迭代，无需新增经验条目）。

- 2026-09-18: 用户“授权处理”，限定开启白名单依赖/项目工具链/受控构建；GUI 和真实 API 仍关闭。补充 rustup 已安装 1.98.0、PATH 为 Homebrew 1.95.0 的区别；当前 tsgo --noEmit exit 0。T-014/T-015/T-016 in_progress，按依赖准备/只读安全审计/最新隔离回归分界并行；T-007 仍等待真实材料，不宣称已解除全部平台门禁。

- 2026-09-18: T-014 done：项目 Rust1.97.1、三包 exact pins/sha512、Cua 锁定离线 graph 均可用；另外识别并冻结 UBRN CLI/runtime 各自未锁定的 Rust 依赖，只修改受控 staging 脚本增加 --locked/--offline。全局工具链和 Cua 原锁不变。
- 2026-09-18: T-015 done：只读审查和 coordinator 关键源码复核接受纯编译/库字节生成，native loading/TS import HOLD；未运行任何 create/TCC/GUI。T-016 done：新快照 build/check/test 为 0/0/1，剩10失败；coordinator check重跑0，footer单测重跑8/8但未诊断全量超时。T-007 in_progress：下一步固定工具链、无 target-dir 覆盖的 SDK release 构建。
- 2026-09-18: SDK release 离线锁定构建 exit 0，静态 arm64/artifact/hash 证据保留。首次生成检查因只 fetch Mac target、嵌套 metadata 无过滤而缺 aes 0.8.4；复读实际 MetadataCommand 后仅以 cargo fetch --locked 补齐原锁全平台缓存（exit 0），不升级锁或联网生成。随后全平台 locked/offline metadata exit 0、原锁 hash 不变；原命令重跑中。
- 2026-09-18: 原 bindings --check 重跑 exit 0，Python/TS outputs 与固定源码一致；guarded copy-mode adapter stage、C ABI header --check、root/native-only TS emission 均 exit 0。静态验证两产物arm64、SDK三份hash相同、109 checksum符号存在；未执行这些函数或 import。输入与主树边界验证通过，产物/源码/locks保留于 verification.json；上游 warnings 如实保留。
- 2026-09-18: T-007 blocked：当前授权编译子集完成，停止于独立 native load 和 GUI 门禁，T-008—T-013 未开始。更新 dependency-review/progress/test-matrix；额外 locks/guard补丁/助手归档到 p02/repro。LEARNS.md 新增有前后验证的离线 metadata/cache 教训，不记录未证实的 footer 原因。
- 2026-09-18: 派发 computer-p02-evidence-review，仅独立只读复核编译证据/补丁/边界，禁止 native execution。coordinator 复跑静态 verifier exit 0：相对 T-016 主树只变更本轮4份文档与LEARNS，无产品源码/主锁差异；Cua仍干净。临时脚本与归档逐个cmp相同后从/tmp移除；全局仍Homebrew1.95.0/rustup stable default不变。
- 2026-09-18: coordinator 完整审阅最终 p02/review.md 并对照自身静态复核后接受：无可执行发现；独立核对1802主树路径、570上游输入、npm tarballs、四锁/两产物和22退出码。只接受编译准备结论，维持T-007 blocked及全部native load/GUI限制；既有10测试失败仍保留。reviewer已退休。
- 2026-09-18: 用户“执行T-007”并确认无GUI执行边界；T-007 in_progress。coordinator负责入口复核/真实加载/适配器与验证，允许委派仅只读的生成API映射。恢复核对pi/Cua refs及两产物hash未变；GUI/真实API仍false，不创建driver或调用TCC。

- 2026-09-18: 无driver生成SDK真实import约1.193秒自然exit0；标量C ABI/UniFFI/109 checksum检查约0.675秒exit0。首次PATH缺Node的127单独保留，不算native失败；只证明这些诊断进程，不证明全部initializer的OS侧无副作用。
- 2026-09-18: 确定最小可选边界在native/computer，不进入root workspaces/default imports、不安装主树依赖、不vendor生成TS；类型检查显式映射已验证生成声明。coordinator独占loader/integrity/pins/tests与记录；computer-p02-api-map完成只读映射后续接adapter.ts及test/adapter.test.ts。只暴露窗口观察、单click、SDK级cancel/drain，不实现P01 ComputerBackend；现有Rust取消/escaped spawn_blocking仍不满足OS终态门禁。

- 2026-09-18: native/computer实现完成并逐文件复读：adapter19个mock lifecycle用例，integrity/loader7个用例；root重跑26pass/1native skip。初次typecheck捕获pins.platform键冲突及两个fixture索引错误，修正后strict生成声明检查exit0；首轮loader7项中1失败也随键修正变为7/7，没有删除断言。scoped格式化只触本任务文件，最终Biome11文件无修复。
- 2026-09-18: root新loader真实probe与pure生成codec通过，bigint/typed click/unconfirmed effect保留；单独最小环境native-load test1/1且自然退出，未调用driver/TCC。probe的event-loop turn不代表native工作期间TUI响应；超时只是诊断失败，不是取消。
- 2026-09-18: fresh主树隔离快照1789tracked+26新增、28材料目录/20147entries/54内部symlinks。完整npmcheck exit0（含1354文件无格式化、browser smoke），P01Computer3文件32/32；复制及检查期间主树/副本drift为空。本轮不重跑完整test.sh、不改先前10失败结论。
- 2026-09-18: 完整审阅computer-p02-connect-review的独立只读report及13文件hash，root自身重跑与其26pass/1skip、types、Biome结果一致；无可执行发现，仅接受无GUI子集。T-007 blocked：本轮获准工作已完成，完整平台fixture/driver/TCC/UI loop仍缺GUI授权，T-008—T-013不启动。更新support docs，不把SDK settlement冒称OS terminal。

- 2026-09-18: 收尾静态verifier核对1815路径、81pins、四锁/两产物和固定refs；check后仅4份本任务文档变化，native13文件与review/快照一致。6个临时helper归档并cmp后从/tmp移除；两个child已退休。最终任务validator和局部whitespace检查通过（新文件no-index的exit1表示有diff，无whitespace诊断）；未新增LEARNS条目，常规实现迭代不记录为经验。暂存区仍为空，不绕过共享树提交hook。

- 2026-09-18T11:35Z: 用户再次要求执行T-007，经结构化选择和最终契约确认授权当前桌面的专用测试窗口GUI（允许driver/TCC检查/限定动作；缺权停下手动处理，日常应用/真实模型/权限绕过仍禁止）。T-007恢复in_progress。refs与脏树已刷新；coordinator独占文档/执行/集成，先只读并行核实host/UI loop与fixture入口，再决定是否具备运行条件。证据另置p02-gui，不覆写历史子集结果。

- 2026-09-18: 经入口复读后仅执行currentMacOsPermissionStatus：Accessibility/Screen Recording均true，exit0，自然退出，无driver/fixture/观察/输入。进程祖先链到AgentPort.app、Node签名已记录，但不将祖先关系当kernel TCC责任认证；launchctl procinfo返回需要root的exit1，未提权。
- 2026-09-18: 完整阅读host-audit/fixture-audit并独立复核主要源调用链。确认bounded资源enrichment内部list_apps、窗口owner读取全局窗口标题、AX click的wildcard focus恢复都可能超出fixture-only范围。T-007 blocked等待新的环境/附带行为授权决定；不以降权限/私有skip/daemon切换或删保护让测试继续。本次没有产品代码变更，也未运行桌面动作。

- 2026-09-18T11:59Z: 用户明确选择当前桌面的必要附带metadata/焦点行为并确认完整更新约定；T-007恢复in_progress，取消环境/范围阻塞但不豁免host/TCC/UI loop/Stop门禁。coordinator已完整复读任务/原计划/两份审查，刷新refs与共享脏树；下一步只读核实责任身份途径、构建限定fixture/control，再决定是否具备行动准入。

- 2026-09-18T12:03Z: 新鲜Node无driver预检PID77212返回Accessibility=false/ScreenRecording=false，自然exit78；仅该PID的log stream exit0，tccd AttributionChain明确记录AgentPort。未自动申请权限/提权/TCC DB读取，未枚举桌面或创建driver/fixture。T-007再次blocked，用户须手动核对当前AgentPort权限并完全重启。root已通知两个child停止GUI/产品落地，仅保留只读报告和未编译fixture草稿，后续任务不启动。

- 2026-09-18T12:10Z: coordinator复核新的attribution原始记录及独立responsibility报告，接受“本次tccd归属证据有效但权限未成立”，不把kernel attestation当额外必造子系统。fixture源仅保留于p02-gui/fixture-draft，未编译/运行/接受或落入产品。static verifier exit0：13native/81pins/四锁/两产物不变，refs与Cua干净/空暂存核对通过；归档JS语法与Python解析、四文档whitespace及任务validator通过。只更新本任务四份文档和诊断证据，不运行不能解除权限门禁的全仓检查，不新增未证实的LEARNS条目。

- 2026-09-18T12:15Z: 两个child均已完成并退休；coordinator完整阅读归属报告、fixture草稿及notes，草稿不作为验收代码，保留Stop抑制计数不能证明late-effect消失等限制。四个新临时诊断/校验helper逐一cmp后归档并移除/tmp原件；旧证据未覆写。最终状态仍T-007 blocked，待用户手动处理实际AgentPort权限/重启；不新增产品代码或启动后续阶段。

- 2026-09-18: 用户明确要求“请求权限，我来打开”。coordinator仅执行解除阻塞所需的正常权限请求/设置入口，继续不创建driver或操作fixture；T-007仍blocked等待实际授权/宿主重启及新进程复验。证据另置p02-permission-request，不改已封存p02-gui证据。

- 2026-09-18T12:19:30Z: 按明确授权在独立Node PID99320执行一次requestMacOsPermissions，前后Accessibility=true/ScreenRecording=false；调用openMacOsScreenRecordingSettings成功，进程自然exit0。只触发正常系统授权/设置入口，未自动操作同意、未重置权限或创建driver。T-007保持blocked等待用户开启屏幕录制并重启/复验；request日志另存p02-permission-request，旧封存证据未改。

- 2026-09-18T12:24:23Z: 用户报告“已经勾选开启了”；独立新Node PID5866只执行无提示getter并采集该PID的TCC日志，仍true/false，Node自然exit78/logger0/runner1。日志AX Allowed、ScreenCapture Unknown，责任/subject为AgentPort debug ID；没有再次request/settings调用或driver/桌面动作。T-007仍blocked，下一步确认是否完整重启宿主，而非继续尝试输入或猜权限根因；证据保留p02-permission-recheck。

- 2026-09-18: 用户结构化选择“尚未，先完整重启（推荐）”。停止工具侧操作，等待用户自行完整退出/重新打开AgentPort并恢复会话；不自动终止宿主，不把确认准备重启当作重启已完成或权限通过。

- 2026-09-18T12:29:37Z: 用户报告“已重启”，新Node16473只读preflight仍true/false、自然exit78/logger0。进一步只读自身祖先与已归属app的plist/codesign：本会话仍由PID88054的agentport-host托管，ps启动时间16:25:57；当前磁盘app显示AgentPort Debug - AgentSessions且strict签名校验通过。没有把进程存续或签名时间变化当已证根因，未终止宿主/修改AgentPort/再次request/操作桌面。T-007保持blocked，先核对用户实际授权的条目/路径；证据另存p02-post-restart。

- 2026-09-18T12:51:43Z: 用户确认“之前不是，刚刚已经授权了，请重试继续”；新Node30728两项true/自然exit0、own-PID logger0，两项服务均Allowed且debug归属一致。只改变正确应用的用户授权后通过，未杀宿主/改签名/重置TCC。T-007恢复in_progress；coordinator完整重读authority/刷新refs与脏树，先实现并验证轻量fixture/control，再序列化raw SDK和adapter的单动作比较。新的实现/运行证据置p02-live，历史失败保留。

- 2026-09-18: coordinator接受fixture编译子集并完整复读412行Swift：原Stop抑制计数已移除，效果counter持续可见。root实跑p02-live/control-smoke，显式opt-in guard为78；专用窗口own visible/onActiveSpace/mainThread均true，armed/busy与checkpoint确认、Stop smoke锁存、拒绝重新armed、EOF自然exit0；无SDK/TCC/内容观察/输入。控制面只证明本地窗口状态与IPC handler，不冒称物理Stop点击/无遮挡像素或OS终态。live host/串行orchestrator仍在实现/静态核对。

- 2026-09-18: root整合TS host与guard测试，独立review指出父脚本退出前未drain stdout、done后extra effect可能漏报两个问题；修正并跑无GUI合成回归4/4，再跑控制smoke自然exit0。完整源码/协议复核最终无发现；strict generated types0、native30pass/1skip、scopedBiome13文件无修复。fresh隔离完整check0（1356文件无修复）及Computer32/32，检查期drift为空。
- 2026-09-18: 实跑p02-live/native-comparison，root分别验证raw51165和adapter52941本进程权限/归属后准入。唯一fixture51161/window4860 counter0→1→2、原生语义一致；Stop IPC真实转发取消pending只读观察，匹配UBJS AbortError；SDK清理顺序/自然退出通过，无重放或强制终止。root离线verifier与独立26文件原始证据review一致、无发现，读报告并核对hash后将T-007置done，仅接受P02窄基线。T-008—T-013保持pending，本轮不启动P03。
- 2026-09-18: 补充源码README/三份实施记录与证据report；LEARNS新增已验证的TCC授权条目核对教训，不记录private-entitlement/cache/后台年龄的未证根因。无主依赖/Rust/生成绑定/adapter核心变更，无staging/commit；不绕过共享树write-mode hook。

- 2026-09-18: 用户明确“执行P03”；coordinator完整重读authority、刷新refs/共享脏树并确认P02前置已done，T-008进入in_progress。先以两个只读边界核对native终态改造点和宿主生命周期接线，证据置p03；原生/GUI执行仍由root序列化准入，P04以后不启动。

- 2026-09-18: authority validator已通过；启动p03-native-audit/p03-host-audit只读审计。prepare.py实际完成P03独立source/npm copy，记录1818共享源码路径/脏diff与573 stage输入；未修改P02输出。为必要实施增加T-017–T-020；T-017进入in_progress/coordinator，先实现与native格式无关的result/terminal分离宿主状态机，后续native/lifecycle边界分别冻结再派发。

- 2026-09-18: coordinator完整读取两份P03 audit并接受源码风险定位（不是实现验收）。冻结原生qualification为精确目标tree-only observe和一次已声明/启用的background AXPress，无pixel/selection/foreground fallback；保留原通用SDK，新增受控UniFFI门面，不实现fill/batch。T-018进入in_progress/p03-native-audit，独占P03 Rust stage、native补丁与原生barrier；root保留TS/GUI执行。宿主终态指driver-owned工作/cleanup不能再提交输入，不把drain当外部应用效果确认。

- 2026-09-18: T-017 root验收done，33/33、tsgo、scopedBiome均0，独立review问题已修正并重验；T-019进入in_progress/p03-host-audit，接口固定为ComputerSessionBinding（含普通cancel、撤权、fork/renew、共享scheduler和逐session工具工厂）。native P03仍并行实施，尚无native/GUI执行。新增lifecycle.md记录状态机与锁序，不作为另一任务状态源。

- 2026-09-18: T-018内部文件边界细分：p03-native-lease只写P03 core/src/computer_desktop_lease.rs及其内部测试，现有fs2/libc、canonical用户目录、dirty marker与无TTL接管；p03-native-audit保留core/lib.rs及其余Rust/合并patch/Cargo目标独占，避免并发编译/共享源覆盖。

- 2026-09-18: 读取native-contract.md，拟将T-018的TS adapter/test限定为native/computer/controlled/adapter.ts及controlled/test/；p03-native-ts创建先因objective长度校验、缩短后因limit_reached失败，未创建/未派发。list_agents确认当前三个native/lifecycle/lease子任务仍运行；等待空闲槽后再派发，不冒称执行。loader/pins/生成/GUI仍由root负责。Rust接口是待生成验证目标，不能以手写替身类型宣称生成API通过。

- 2026-09-18: 恢复后完整重读authority、刷新共享树并重跑validator通过。lease子任务源/内部测试已完整复核、handoff hash 79382a67匹配，rustfmt通过但Cargo结果尚未验收；将唯一模块编辑权交回native owner并退休lease child。空槽释放后实际创建p03-native-ts，仅负责controlled/adapter.ts及test，root保留loader/pins/probe；生成API仍待最终原生构建后核验。

- 2026-09-18: T-019初稿handoff已复读并核对hash，root重跑lifecycle/child/runtime三文件53/53；实现者更广212pass/10既有API门控skip与controller37/37。独立复审随后提出三个可追溯问题：replacement异步撤权被续代覆盖、reload捕获代际晚于同步reentry、tree导航后child factory仍捕获旧root binding；T-019保持in_progress并派发最小修正/回归，不以测试通过替代验收。复审末发现controller另有并发validateCollaborationTask改动，root已核对并保留，不归入本任务。TS原生adapter初稿27/27 fake/lint通过，root仍待实际生成类型及审查；无P03 GUI执行。

- 2026-09-18: T-018独立审查发现session.close的Weak快照不能替代subtree cleanup证据、AX writability请求遗漏gate、已关闭session snapshot仍占有AX handles；root已读因果路径并交native owner最小修正。生成/GUI继续HOLD直到新构建和复审。root新增独立controlled loader/probe/typecheck与P03 parent准备材料，parent合成8/8、adapter27/27通过；P02 seal全136条核对通过、两原生产物hash未变，未碰封存证据。

- 2026-09-18: T-019修正验收done：root重跑四文件111/111、5源hash匹配，复读25个先失败回归及238/238原始日志；23份临时证据逐字节归档到p03/lifecycle-fix-evidence。p03-lifecycle-fixes退休；原TS adapter实现者已退休，T-018的TS边界由coordinator接管。新p03-boundary-review只读审查controlled adapter/loader与专用fixture parent/probe，禁止native/GUI执行；native owner继续独占Rust/Cargo直到显式handoff。T-018/T-020仍未验收。

- 2026-09-18: 只读刷新发现共享HEAD由89b56ee7前进为80809e7aa5489a6f957d8ed3f9acb40f2fc8f58c（外部fix(agent): relax delegation context limits），本任务没有提交/暂存；保留该变更，原任务/Cua基线不改写。p03/current-baseline独立快照已核对1790tracked+45新增源/54内部symlink；offline build与完整check均0（Biome1368文件无修复），host回归191pass/5既有skip、controller38/38；完整test.sh仍运行中，不预报结果。检查期间截至controller的source drift为0；之后仅root开始补充lifecycle文档，最终drift另核。

- 2026-09-18: 新p03/current-baseline完整test.sh结束exit1：6文件9失败，全部属于T-016先前10失败集合，新增失败为空，footer debounce本轮未复现（未声称修复）。root读完整有意义输出/失败comparison与source delta：副本source无改写，结束时live drift仅root的lifecycle.md。build/check/test为0/0/1；report.md保留当前失败及未覆盖native pins的边界。

- 2026-09-18: native owner提交显式冻结handoff并退休，coordinator接管唯一Cargo/生成权。root静态核对19补丁文件/491Rust输入、P02的485Rust原样、原锁及生成脚本未变；patch c1be9e7b、dylib7add23a7。已读最终18core/13lease/11SDK/5platform全0日志和三项修正路径，独立review继续对最终hash复核。root开始qualify-generated.sh（定向原生重验→未改generator/--check→独立stage/header/TS emit→genuine pins）；仍未加载SDK/GUI，T-018不预先标done。

- 2026-09-18: T-018限定原生/adapter构建子集验收done，生成/strict types/scopedBiome/load-only及47个root原生测试通过；P02封存136条再次全过。TypeScript首轮4错误与pin JSON首轮格式诊断保留；host仅两处类型声明改为显式undefined联合，重跑host+lifecycle84/84。T-020进入in_progress/coordinator：独立boundary复审正在对实际生成API和两处type-only修正核对；先专用fixture控制smoke，再按每行动PID自身TCC门禁实测。不启动P04，不将load-only冒称driver或桌面通过。

- 2026-09-18T17:07:38Z—17:09:17Z: T-020真实native-qualification失败exit1（task-90）。owner56354自身TCC及fixture56350/window5617准入通过，但首个observe60秒不返回；cleanup发送Stop/close后仍无回执，30秒等待结束后harness强制终止owner。fixture自然exit0/counter0，无click或后续owner。停止所有native/GUI推进，不重试、不恢复lease。
- 2026-09-18T17:40Z: coordinator复读全部原始事件/命令/TCC/退出与父协议cleanup，静态证据verifier通过；直接只读检查canonical marker仍D/0000000000000001、inode134700982。T-020和T-008转blocked；保留T-017/T-018/T-019限定子集完成状态，P04不开始。补充qualification-failure/report.md及实施记录，退休settled boundary reviewer；未修改产品代码/marker或新启native/GUI进程。首轮静态verifier仅因摘要中review hash缺字符失败，直接hash纠正后0，原脚本/失败记录保留；不是库漂移或GUI重试。

- 2026-09-18: 失败收尾只读/文档检查完成：任务validator通过，7份Markdown的no-index whitespace检查无诊断；coordinator已读本次4文档diff，暂存区逐字节未变，marker最终hash与只读快照一致。两个临时helper归档cmp后移除；无活跃background任务，不重跑native/GUI或无助于解除门禁的全仓检查。LEARNS未追加未证根因。

- 2026-09-18: 用户确认先离线定位/修复/验证，lease恢复与再次桌面测试另行确认；新增T-021进入in_progress/coordinator，按同一因果路径串行推进。复核共享HEAD外部前进至a9289fb692130554351441959c5a38a674be4301（fix(coding-agent): finish child turns on result delivery），保留相关已提交/脏修改，不归为本任务产出。T-008/T-020保持blocked，失败证据不覆写。

- 2026-09-18T18:11Z: T-021局部因果回归先红后绿：fixed N-API回调在rx.recv等待JS时，原public terminal把foreign waker注册到持锁core通知；同步cancel/再次poll需要同一锁。最小native monitor隔离后加强双订阅回归通过，SDK14/14；原P03/P02源码/二进制/失败证据不动，dirty lease未获取/改写。新副本重建与一致性验证继续，真实原因关联仍须另行授权复测。

- 2026-09-18T18:25Z: T-021离线子集验收done：双订阅回归先红后绿，最终50项Rust/生成/strict types/33 controlled mocks及无host load通过；三新测试的两处rustfmt换行修正后SDK14/14重跑。补丁和pins同步，旧P03/P02二进制/失败证据不动。新隔离全check实际exit2、5个范围外模型ID TS2345；旧Computer输入同样失败，193pass/5skip与controller38/38另跑通过。保留初始格式失败与两个汇总helper的exit层级误判，最终直接核对command.json/.exit；验证manifest不再包含自身仍打开的日志。只写本任务补丁/pins/文档/已证局部LEARNS，不回写formatter、不staging/commit；共享check/hook不安全且未通过。T-008/T-020仍blocked，下一步只询问恢复/复测方案，不执行marker或GUI操作。

- 2026-09-18T18:43:39Z: 用户已确认重启后一次性恢复/fixture契约；sysctl boot1789756477与用户报告一致，晚于失败及离线修复。新增T-022进入in_progress/coordinator，先私有恢复回归/输入验证，T-008/T-020保持blocked等待恢复门禁。新p03-recovery目录创建成功，无SDK/GUI/canonical marker读写；旧证据保留。
- 2026-09-18T18:52:43Z: T-022验收done：private20/20、parent8/8、snapshot4/4、全部固定输入/旧证据核对0后，仅一次执行canonical恢复。独占锁内归档D1先sync，再同inode只改D→C并sync，外部只读验证C1；uid/mode/nlink/size/generation不变，无旧terminal声明。T-008/T-020恢复in_progress；下一步新控制smoke及每进程资格下的修复fixture实测，失败即停、不再次恢复/重试。

- 2026-09-18T18:54:21Z—18:54:30Z: 新p03-recovery/native-qualification退出1，错误Action-process responsible identity unqualified。此前control-smoke fixture9395/window121自然exit0/Stop锁存通过。实际probe9498两项getter true；原TCC日志responsible为AgentPort PID1084、requesting/accessing为9498，预期bundle/path匹配，但继承脚本要求responsible.pid==9498而拒绝。捕获无逐服务Allowed行，不能据此跳过准入。未发送admit/observe/click，native owner构造0；fixture9494/window122 counter0，两个孩子自然exit0/EOF，无forced teardown。C1/inode原样保留。T-008/T-020转blocked，按已确认契约停止，不自动修脚本/再试/恢复；仅封存证据和报告。
- 2026-09-18T18:58Z: 只读review-outcome0核对原始事件、6条TCC关联、错误PID条件、零owner/零effect/自然退出与C1；post-run-inputs0确认原/修复输入及旧证据继续不变。新增T-023 blocked记录必要脚本修正及待确认范围，不开始实现。产品/补丁/pins/依赖未变，未再访问SDK/TCC/GUI或恢复marker；本轮不重跑不能解除该准入阻塞的全仓check。

- 2026-09-18T19:13Z: 用户要求持续自主交付，阅读完整原计划并给出一次性持续执行约定后，用户确认“完全放开权限给你操作，需要的系统授权请提前申请我审批”，希望睡眠期间不中断。当前授权扩至P03–P08；保留安全/真实API/日常资料/未知终态边界，不承诺OS人工批准可绕过。T-023进入in_progress/coordinator，先系统权限盘点与取证修正；新p03-tcc准备核对上一轮120封存文件及4文档hash，HEAD不变，未访问canonical lease/SDK。旧失败保持原状。

- 2026-09-18T19:24Z: T-023验收done：旧角色条件在已捕获输入下先失败，role-aware修正后通过，26反例/父协议8项通过；新的无driver PID22337实际完整per-service TCC链通过并自然exit0。早期权限盘点两true无需用户操作。修正根因包括responsible/requesting PID混同与日志过滤丢失同activity的Allowed行；不降低门禁。T-008/T-020恢复in_progress，使用新p03-tcc产物/记录进行独立行动进程准入；若原生失败先Stop并只采样本实验已admit子进程栈，再受控cleanup，不以sample/超时当terminal。

- 2026-09-18: 用户追加批准`qd/kmodel_latest` high真实模型测试；已记录为后续有界定向opt-in，当前TCC/native资格仍无模型调用，不改变常规测试隔离。

- 2026-09-18T19:31Z: 新p03-tcc/native-qualification实际exit0，独立verify-live0核对三行动PID逐服务TCC、一次AXPress、四terminal、四自然退出/EOF及C1→D2→C2→D3→C3（历史inode未变），无forced teardown。P03实际driver-owned路径已通过；T-020仍等待当前全check处理和文档验收，不把external effects或physical Stop当已验证。
- 2026-09-18: 继续复核final-check：完整check实际exit2、同5个AI模型ID TS2345，targeted193pass/5skip及controller38/38、drift0。新增T-024进入in_progress，修正必要基线测试输入，不覆盖并发generator修改；T-008/T-020先保持in_progress直到验证及阶段记录完整。

- 2026-09-18T19:43Z: T-024 done：原3失败→49pass/35skip，三测试最小输入更新，完整isolated check0及193pass/5skip、controller38/38、drift0。当前实际core.hooksPath未配置且.git/hooks/pre-commit不存在（不是绕过hook），按仓库要求单独提交8779ac9ff；仅三测试，未staging其他文件。T-008/T-020 done：成功live/独立raw复核和支持文档已完成，历史失败/限制保留。T-009进入in_progress/coordinator，按串行native→generated→host→fixture依赖推进P04，不创建第二状态源。

- 2026-09-18: P03收尾seal0，45份raw live文件hash和263份已关闭证据封存；authority validator0。P04独立prepare成功，未改历史输入；core24/24与SDK24/24合成回归通过。保持T-009 in_progress，平台fill/完整观察及generated/host/fixture/browser未验收，无P04 GUI或新模型调用。设计/下一具体修改点记于p04/design.md，仅作为证据说明，不维护第二状态源。

- 2026-09-18T20:30Z: 恢复后完整重读authority并刷新共享HEAD/dirty tree，task23确认自然exit0。P04平台16/SDK31/私有lease13及生成/header/TS通过；core此前25/25。补充stage完整观察/fill/安全gate与后续修正证据，历史P03输入不改。T-009继续in_progress/coordinator，下一步独立P04补丁/pins及真实生成API到现有host/tool桥接；没有P04桌面或真实模型调用。

- 2026-09-18T20:51Z: P04生成接口/type-only adapter已接startPlan，新增可选native schema/tool/binding；genuine值+fake host的8项桥接测试与真实AgentSession/faux4项通过，同八步表单9→3模型请求（非桌面性能）。strict generated-boundary通过；SDK组合单独沿用根tsconfig检查整个主图通过，未为此放宽adapter严格项。独立P04 patch27文件apply/hash/reverse通过、579历史P03输入及四锁不变，新增patch e6d8167a、dylib459fd177、81pins；34mocks/1skip与load-only1/1通过。Swift form编译/无native控制smoke通过，但两次初始live在observe失败，新增T-025定位；每次有native终态/clean close，绝未发送form或清理dirty marker。

- 2026-09-18T21:18Z: T-009/T-025转blocked：六次live只读失败均有terminal/clean close/destroy、owner自然1/fixture自然0/EOF、无input，canonical同inode到C9。console-state明确locked=true；前置guard6/6及实际拒绝零children，不自动解锁。临时Rust诊断撤回、原源cmp与重建dylib459fd177一致；独立blocked-verification0核对155原始文件、27Rust/81pins/579历史输入/四锁。restored三项types0、静态32pass/7skip，未再GUI。最新bridge-check完整0及193pass/5skip、38/38、drift0。下一步仅在用户人工解锁并报告就绪后刷新准入、做只读对照；锁屏不是已证唯一AX根因。

- 2026-09-19T03:29Z: 用户报告“已解锁”；coordinator完整重读authority与原计划，刷新HEAD8779ac9ff/共享dirty tree。无GUI的unlocked-console-first exit0：onConsole=true、lock/login key unavailable；不把缺失key当解锁证明。unlocked-inputs0复核216封存记录、155raw文件、33产品/27Rust/81pins未变并保留resume前脚本/authority。T-025恢复in_progress/coordinator，先新增只读模式并逐进程重新TCC/Stop准入，不发送form/click；T-009暂待诊断，仍不恢复C9。

- 2026-09-19T03:29:14Z: unlocked-readonly exit0，原P04观察21节点/四空值且完整不降级；owner24455与fixture24451/window282各自自然exit0/EOF，terminal→close→destroy，无form/click/强杀，历史inode C9→D10→C10。root已复读raw事件/TCC/commands/marker；T-025 done（环境阻塞解除，不声称任意AX拒绝唯一根因），T-009恢复in_progress/coordinator，下一步新fixture八步表单实测。

- 2026-09-19T03:51Z: unlocked-form真实8/8及独立四字段oracle通过，三terminal/两个自然0/EOF、C10→D11→C11，elapsed26042ms仅单样本非性能结论；unlocked-verification0核对59输入/raw。扩展fixture严格Swift6编译、probe strict types和control-smoke均0。native-scenarios前五case layout/ambiguous/ref/stale/press通过，C11→…→C16；modal原生安全拒绝无input，但code=condition_unknown触发预定断言，批次停止，terminal/clean close/两自然0/EOF至C17，不重放。只读modal-readonly-diagnostic新进程确认平台degradedReason=unexpected_modal_surface，C18；新增T-026 in_progress修复select丢失已知原因，旧源/产物/断言归档modal-projection-before。T-009仍in_progress，P04整体不验收。

- 2026-09-19T03:58:12Z: T-026 done：先红后绿两回归、SDK33/33/生成/header/types/load-only全部通过，当前patch51fbcae0/dylib0427ba07/N-API6d65d72c。modal及modal-prefix真实保持专用码/前缀/unknown；partial/cancel/deadline通过且无尾部输入或重放，最后C23同inode。两独立scenario verifier检查324raw/12runs，24自然exit0/EOF。modal-check全check0，仅任务pin JSON格式化已审查回写；193pass/5skip、38/38、tool8/8、loop4/4，检查期live drift0。旧文案误引P03 N-API hash已在当前说明纠正，历史原始pins/失败不改。T-027 in_progress/coordinator，先只读审计受控browser接线、grant及异步drain，禁止直接转发generic API或访问个人profile。P04整体与后续阶段仍未验收。

- 2026-09-19T04:16:38Z: 恢复核对HEAD8779ac9ff及共享dirty tree，无活跃后台任务。T-027审计确认generic browser注册会引入detach的session cleanup和自动重拨，不能复用当前同步shutdown证明；固定目标session也不能拿fixture权限代替browser准备权限。新增T-028 in_progress/coordinator，先在独立p04-browser stage完成实际CDP投递/收敛基础，不动已资格AppKit输入或当前pins，不进行GUI。隔离profile的bootstrap授权/精确绑定仍由T-027后续显式实现，未作已有能力声明。

- 2026-09-19T04:40:25Z: T-028 done（限定native transport基础）：独立stage保留586源/81pins/四锁，core40/CDP25/SDK33/platform16全部0；两个开发中边界缺陷已先红后绿（reader重复join、flush错误关闭发布）。transport.patch严格apply/hash/reverse通过，仅artifact未切产品；global check0/1376files无修复、193pass/5skip、38/38，source drift0。没有Chrome/GUI/TCC/lease或模型调用，也无新staging/commit。T-027继续in_progress/coordinator，下一步先明确bootstrap授权、owned profile/窗口绑定和native异步session清理，不能直接注册generic engine。

- 2026-09-19T05:15:21Z: T-027异步生命周期子集验证通过，仍in_progress/coordinator：9Rust文件增加native resource ledger与可等待subtree/host清理，保持输入scheduler/公开ABI不变。真实localhost peer先红后绿复现并修正registered pool首连借用foreign session、首失败握手再次拨号；最终56/33/40/16全0（core/CDP重叠19）。lifecycle.patch27a67104 apply/hash/reverse及589→593源边界0，已资格586P04源/81pins/四锁/产品输入/transport证据不变。isolated root check0/1376files无修复、193pass/5skip、38/38、drift0；没有Chrome/profile/GUI/TCC/canonical lease/模型、生成或产品pins更新。下一步独立准备scope、profile进程资源和精确窗口接线；不把本子集称为T-027/P04完成。

- 2026-09-19T05:29:28Z: T-027继续串行实施：已完整读canonical registry/authorization/manifest，确认isolated prepare仅Routine adapter和manifest工具准入，不能声称已有exact profile/executable授权。冻结scope-design：独立IsolatedBrowser原生scope，无假PID/window，不能转换为AX权限；generic browser implementation默认拒绝，固定isolated_new参数及one-shot claim仍经canonical授权。先做该前置与原AppKit邻接回归，再接实际profile/process；不新增公开ABI、GUI或产品pins。scope-before保存sealed lifecycle基线，历史证据保持不变。

- 2026-09-19T05:43:11Z: T-027 distinct preparation scope子集验证通过，仍in_progress/coordinator：core66/registry70/authorization40（含18 session authorization）/manifest15/SDK41/platform17全0；十二新测试覆盖准备与窗口权限分离、generic实现拒绝、canonical manifest准入和一次性claim，取消barrier不启动资源。scope.patch41e97239严格apply/hash/reverse0，596源边界及历史输入/81pins/四锁/产品/生命周期封存证据不变；global check0/1376files无修复、193pass/5skip、38/38、全部drift0。无新GUI/profile/ABI/生成/lease/model，暂存为空；下一步具体profile/process所有权及drain，不将静态准备scope视作可运行browser。

- 2026-09-19T05:48Z: 用户要求continue，T-027继续。macOS SDK明确NOTE_TRACK/NOTE_CHILD已不支持，不能假造recursive kqueue追踪；process-design先限定可证的owned process-group substrate：注册inert resource先于spawn、保留unreaped Child锚、waitid(WNOWAIT)防PID重用、group内无live成员后才reap，error/timeout保持证据。仅私有test-binary子进程验证，不启动Chrome/删profile；group不等于逃逸descendant tree，完整browser helper/profile清理仍须另有证据。

- 2026-09-19T06:15:43Z: T-027 process-group子集验证通过：首轮8pass/1fail/101，exact diagnostic确认natural exited/no-live组SIGKILL返回EPERM1；最小修复先判完整group drain，原oracle及live-grandchild反例通过，未把EPERM泛化当成功。最终11/11（含1 inert fixture入口）、五轮10/10、platform28/SDK41/core66、fmt0；process.patch bd351bd1严格apply/hash/reverse和596→598源边界0，586历史输入/81pins/四锁/产品及scope封存不变。full isolated check0/1376files无修复、193pass/5skip、38/38、drift0，HEAD8779ac9ff/空暂存。只运行私有test-binary子进程，无Chrome/profile/GUI/TCC/canonical lease/model/生成。当前upstream Crashpad可setsid脱离group的公开来源及capture限制已记录，不能据group receipt删profile或宣称完整browser关闭；T-027继续coordinator负责profile/helper与binding，仍in_progress。

- 2026-09-19T06:21Z: 只读本机Chrome Info.plist为153.0.8010.48，对应tag源码确认Mac初始化无所见disable-crashpad开关gate；不能借用POSIX非Mac分支或旧disable-breakpad传闻。helper-lifecycle-audit记录URL/捕获边界，未执行Chrome或读personal profile。下一最小可证伪实验：私有APFS副本运行既有test-binary的leaf IPC fixture，仅对这个PID读proc_pidpath，比较不同inode/相同hash/私有image路径并自然退出；不枚举日常浏览器argv、不复制Chrome、不改profile/lease。私有browser bundle image scope仍只是候选，不能因clone成功声称全部helper终态。

- 2026-09-19T06:33:10Z: owned-image-probe exit0，私有test executable副本不同inode/同hash，PID93283的proc_pidpath精确指向副本；IPC释放后自然exit0，无forced cleanup，只验证image身份、不作benchmark或Chrome结论。已将本轮已证EPERM清理教训追加到LEARNS末尾，保留已有33行dirty增量；diff-check0/空暂存。继续只读、有限量核验installed Chrome bundle签名与文件/内部symlink/hash来源（≤4096entries/2GiB），不复制或执行Chrome、不读personal profile、不新建desktop owner。

- 2026-09-19T06:38:25Z: installed Chrome只读inventory exit0：153.0.8010.48、vendor requirement/deep签名前后均0，1298entries/674files/7个内部symlink、1484756146bytes，读取期间source drift0；未复制/执行browser或创建profile。允许本原生构建实验下一步仅在pi artifact私有目录请求APFS bundle复制，逐file hash/不同inode/内部link/签名验证，保持原app只读；仍不执行副本，不将复制/签名通过当browser helper终态或GUI资格。

- 2026-09-19T06:47:35Z: browser-image-copy exit0：私有app副本674文件同hash/不同inode、7 links仍在副本内、deep/vendor签名0，source drift0；未执行任何Chrome或创建profile，未测physical allocation。继续image-observer-design限定只读事实原语：有界current-UID PID/start/status/executable双catalog一致才返回owned-root下成员，不读argv/env/personal profile，变化/不可读不当空。新增私有test executable的setsid leaf反例验证group收敛≠image收敛；该原语本身不授予ownership/terminal，实际launcher与profile仍未接通。

- 2026-09-19T07:20:45Z: T-027 image-observer子集验证通过：5/5+五轮5/5、platform33/SDK41/core66/fmt0，私有setsid叶子在group关闭后仍被image观察检出，IPC释放后才空；仅事实原语、不单独授予terminal。image-observer.patch24584ae5严格apply/hash/reverse及600源边界0，586P04源/81pins/四锁/产品/前序证据不变；完整isolated check0/1376files无修复、193pass/5skip、38/38、drift0。已保留Chrome私有copy的674hash/7link/signature证据，但无Chrome执行/profile/GUI/TCC/canonical lease/model/新ABI。matching-tag code_sign_clone_manager.h另证临时外部clone/cleanup helper风险，尚未解决，不能宣称完整browser关闭；下一步继续launcher的来源/生命周期设计与owned资源装配。HEAD8779ac9ff、diff-check0、空暂存；T-027继续in_progress/coordinator。

- 2026-09-19T07:41:34Z: T-027 browser依赖审查选择CfT153.0.8010.52/mac-arm64，仅build-time准备。stock153.0.8010.48的CfT metadata实际HTTP404/exit1保留；官方Stable与matching-build metadata一致给出.52/revision1681091，已重新读.52源码，CHROME_FOR_TESTING编译分支不启动update-related code-sign clone，官方article说明无auto-update。cft-dependency-review记录来源/捕获限制/固定URL/≤512MiB archive/≤4096entries/2GiB expanded与静态签名门禁；沿用持续授权下必要reviewed pinned依赖范围，不改Cua/Rust/UBJS四锁、不安装Puppeteer/Electron/chromedriver。下一步仅取档检查ZIP/Info，不extract/execute/GUI/profile；现有签名/权限/terminal门禁不下降，Crashpad仍须image范围收敛证据。

- 2026-09-19T08:02:00Z: CfT归档实际取得191015853bytes，SHA2566f67faa4b34dd551b53abb6fee24edeae470ab695b0b100ddc4885ff0be6724a，675entries/375721528expanded，Info为com.google.chrome.for.testing/.52。初次静态提取在codesign deep门禁失败exit1；只读诊断为ad-hoc/linker-signed、TeamIdentifier未设置、无CodeResources，不是已证明的解压错误；未运行/重签/改权限。用户已明确批准固定归档CfT方式，并进一步授权所有必要权限/任意版本、以完成Computer Use为目标、不施加额外限制。coordinator不再逐项请示；下一步按官方来源+完整文件hash重验已提取副本，保留原signature失败事实，继续owned assets/profile/launcher接线与实测。T-027保持in_progress，无新GUI/lease/model或产品pins切换。

- 2026-09-19T08:09:42Z: 已按最新明确授权完成CfT来源重验：cft-content-qualification0，固定官方ZIP逐payload与现有提取文件比对，346files/5symlinks/675entries全部一致、无额外路径、arm64/.52/com.google.chrome.for.testing通过。content-manifest SHA25681c3f5a8de3998165d7fa0b8142bbb55a46420a01163bc03f48c9aac0084a872；vendorSignaturePassed=false如实保留，未改OS/TCC/签名/entitlement。未启动该程序或profile/GUI/lease/model；下一步直接实施native owned assets/profile/prepare/binding/typed计划，不再把必要版本/来源方式作为重复审批项。T-027仍in_progress/coordinator，产品pins不变；diff-check0/空暂存。

- 2026-09-19T08:29:33Z: 用户continue，coordinator刷新HEAD8779ac9ff/空暂存并完整复读authority；launcher-before冻结当前600源及CfT内容manifest。T-027继续串行装配：先登记私有image/profile资源，再登记one-shot进程owner，最后连接CDP；反序关闭socket→group→image helpers，只有image收敛后才清理私有目录，失败保留资源。使用已批准CfT输入，不再重新审签名/版本，不注册generic engine；本轮尚无browser执行或GUI资格。

- 2026-09-19T08:38Z: T-027新增三Rust文件native launcher装配：先登记私有image/profile资源再one-shot group，固定命令/独立环境/有界endpoint文件，返回前核对自有PID/image/start；反序group后image空才删目录，失败保留。最终platform42（含9新case及真实私有test进程顺序清理）/SDK41/core66/fmt全0；isolated全check0/1376files无修复、193pass/5skip/controller38、drift0。launcher.patch59cd9c41 apply/hash/reverse和600→602源边界0，586已资格源/81pins/四锁/产品不变。未执行CfT/Chrome、无GUI/lease/model/公开ABI；assembler未注册，不冒称浏览器启动或helper资格。下一步直接接controlled pool及exact page/window绑定；详见p04-browser/launcher-report.md。

- 2026-09-19T08:59Z: 持续执行浏览器SDK垂直接线：新增genuine openBrowserSession/startPrepare/BrowserPrepared，canonical受控prepare→原生资源→注册pool→单about:blank page与PID/CGWindow geometry绑定，不注册generic engine。platform45/SDK43/core66；生成及--check、N-API/header/严格TS、无host真实load/codec全0；隔离check0/1376files无修复、193pass/5skip/controller38/drift0。incremental browser-sdk.patch1d0ebe4c/七Rust文件及四生成输出、602→605源边界核对0，原产品81pins/586源/四锁不变。首轮console明确locked=true，未GUI；离线完成后新鲜console为onConsole=true/lock key unavailable（不独立宣称已解锁）。下一步新鲜console gate＋专用floating Stop fixture＋行动进程TCC准入下仅prepare/close资格；旧锁屏证据保留，任何known-locked仍前置拒绝，无page输入/模型/marker恢复。

- 2026-09-19T09:04Z: prepare-live-1新console无已知lock，floating fixture可见/响应；Node91449本次两getter true，但旧TCC validator拒绝responsible binary。raw显示bundle/responsible_path正确、responsible PID等于requester91449且binary=精确Node，两服务Allowed。未admit/创建owner/启动CfT，两个自然0/EOF，无forced，C23未改；新增T-029串行修正脚本过强假设，不绕过权限或恢复lease。

- 2026-09-19T09:07:55Z: T-029 done：旧raw回放before1/after0、9cases全部通过；fresh Node93502的两服务完整Allowed及责任形态准入通过。prepare-live-2实际C23→D24并启动CfT，prepare terminal(false,true)后browser_window_ambiguous；persistent资源close为Quarantined。Node自然1/fixture自然0/EOF，forced为空，无page输入；D24/原inode和私有profile保留，未自动恢复或启动下一owner。失败仅定位到窗口候选guard，底层cleanup原因未捕获，未冒称根因或修复。T-009/T-027 blocked，新增T-030 blocked记录必要诊断/恢复门禁；七Rust/生成SDK输入保持browser-sdk封存版本，详见browser-sdk-report.md及prepare-failure-verification.json。

- 2026-09-19: 用户结构化批准D24恢复约定：先离线诊断/修复，准备好后通知其手动重启，确认后仅归档并同inode/同代际D24→C24恢复一次，不补造旧terminal。T-030恢复in_progress/coordinator（仅离线诊断准备）；T-009/T-027仍blocked，当前不访问/恢复marker或新启GUI。下一步补获缺失的native资源错误类别和自有窗口候选metadata，不提前猜测根因。

- 2026-09-19T09:25:57Z: T-030离线准备完成后转blocked等待人工重启。新两文件opt-in诊断保留静态cleanup原因和有界自有窗口numeric metadata，未放宽任何gate；1/1+2/2诊断及45/43/66/生成/check/stage/header/nohost全0，root隔离check0/193pass+5skip/controller38/drift0。首次JSON宏语法101及修正日志保留，非原live根因修复。16旧产物先归档，diag patchdd84611e/605源边界及原raw核对0；私有恢复20/20、严格boot确认门禁、同inode一次性D24→C24 helper已备。未执行canonical模式、未创建confirmed-boot.txt、无D24之后GUI/新owner/profile删除；下一步仅请求用户手动重启并报告就绪。LEARNS既有责任角色原则保留，无未证cleanup根因条目。

- 2026-09-19T09:40:01Z: 用户报告“已重启”后，仅只读核验系统boot/uptime。kern.boottime sec=1789756477，仍早于恢复门禁1789809599；uptime显示15:05，不满足失败/诊断准备之后的新OS启动条件。保存d24-recovery/reboot-check-1.json；没有创建confirmed-boot.txt、执行canonical helper、访问/修改marker或启动GUI。T-009/T-027/T-030继续blocked，须用户确认重启的是整台macOS而非应用。

- 2026-09-19T09:42:48Z: 用户再次报告已重启，kern.boottime=1789810895/新bootUUID1124DF55-8742-457B-A793-BA8FAED3B8AC、uptime1min，晚于失败和诊断构建。T-030恢复in_progress，先验证固定输入。首次read-only admission在目录st_dev比较拒绝，未创建confirmed-boot/未读写marker：本次boot的device16777232不同于旧16777234，但目录inode134700981/文件inode134700982、UID501、0700/0600、nlink1/42bytes均保持。Data挂载点为本机APFS /System/Volumes/Data，当前VolumeUUID已记录（旧轮没有UUID，不能声称历史UUID比较）。按已批准同inode恢复语义制作独立boot-specific helper，仅更新本次挂载设备常量，原helper/20cases/失败保持；重新私有回归和当前volume/input/boot/marker验证后才可一次canonical执行。

- 2026-09-19T09:47Z: boot-specific helper与旧fragment仅base目录/st_dev两处差异，私有20/20/0；新boot/input/当前Data VolumeUUID及D24完整只读准入0。随后唯一d24-canonical-recovery退出0：独占nonblocking flock内先归档D24并fsync，再同inode只改state字节并fsync，dev16777232/目录inode134700981/文件inode134700982/UID501/generation24保持；oldTerminalProven=false。本次授权恢复已消耗，不准再次自动恢复。T-009/T-027恢复in_progress，T-030继续in_progress；新runner仅适配本boot设备号，原诊断和权限/终态规则不变，下一步独立新PID准入后的只prepare/close诊断。

- 2026-09-19T09:48:18Z: prepare-diagnostic-1 owner5376逐服务TCC通过、C24→D25；native诊断确认10个自有layer0窗口，唯一114与CDP几何[22,56,1200,878]匹配，旧函数却按总count拒绝。资源反序close在index0失败，静态reason=image_catalog_changed（socket2/process1已先await成功）；operation terminal(false,true)，Node自然1/fixture自然0/EOF，无forced/无page input，D25保留。T-030继续离线修复，未再次恢复或新GUI。
- 2026-09-19T10:03Z: T-030两处因果修复通过：捕获geometry及瞬变catalog回归原行为1pass/3fail/101，修复后4/4；唯一几何匹配仍拒绝真实duplicate，catalog_changed仅在原5s预算内重读，不当空/不重放input。platform49/SDK43/core66/生成及check/N-API/header/nohost/full isolated check全部0；193pass+5skip/controller38/drift0。四Rust增量patch655ba915/605源和旧raw/16产物核对0。只读、无SDK/lease/signal/delete的原生image helper对固定D25目录三次完整稳定catalog均为0live；不是旧terminal。D24恢复权限已消耗，T-009/T-027/T-030 blocked等待新的单次D25行政恢复决定；本次原因已明且socket/group先收敛，提出同boot补证恢复以免无依据要求再次重启。详见binding-drain-report.md。

- 2026-09-19T10:12:31Z: 用户已明确批准另一次仅D25同boot行政恢复。专用helper与D24boot版本仅证据目录/代际/说明变化，原validators不改，私有20/20；新admission逐hash核对固定修复产物/源/原raw、同bootUUID及三个新native image空集，通过后只读核对D25原inode/UID/mode。T-030恢复in_progress；confirmed-boot记录只确认同一次已证明boot，不宣称再次重启。下一步仅一次canonical归档/同inodeD25→C25，后续新失败不得自动恢复。

- 2026-09-19T10:17Z: D25授权恢复实际0，同inode同代际归档fsync后C25；此授权已消耗。fixed-1原生修复资格成功prepare+cleanclose/destroy到C26，probe EOF再次revoke已destroy句柄导致自然exit1；不是native终态失败，未恢复C26。两项关闭幂等回归旧脚本2fail/新脚本2pass，早返回同一closing promise后fixed-2全0：owner21507 fresh完整TCC，Chrome21547/window150唯一geometry绑定、terminal(false,true)、cleanclose/destroy/私有目录清空，fixture/Node两自然0/EOF，无forced、最后C27同inode。独立verify-prepare-qualified0；新isolated check0/193pass+5skip/controller38/drift0。T-030 done，T-009/T-027继续in_progress，下一步受控browser观察/typed input/有界计划，未当整个browser或P04完成。

- 2026-09-19: T-027浏览器观察/计划垂直接线离线完成：17Rust文件、609源，core69/registry70/platform57/SDK44及固定DOM函数4项JS测试通过；genuine startNavigate/observe/plan生成/check/N-API/header/strictTS通过。browser refs改为每快照UUID并映射内部cache token，frame/loader/URL、owned PID/window、origin manifest均重验；只固定DOM fill/press，无脚本参数/焦点/重拨/重放，subframe明确拒绝。原registry错误filter跑0条已保留并以tool::70条替代。一次全check快照缺并发grok-inline-text.ts/duration.ts（真实主树有未跟踪新文件）；仅补入新快照输入，未修改并发代码，current-check完整0/1377无修复、193pass+5skip/controller38/drift0。17文件patch936a1ec2/输入已冻结，localhost独立事件oracle2/2与新probe语法通过；下一步新鲜console/TCC/Stop下真实8步表单和Press，当前仍无页面输入资格或P04完成声明。

- 2026-09-19T13:52Z: T-027继续：native browser children四Rust增量763bc4db，core69/SDK45/platform57/生成一致性通过，子会话继承native祖先授权但使用独立空白profile。新增可选browser adapter/contracts/tool/binding/81pin experimental loader；共享adapter支持真实session factory而非dummy窗口，tool按native/web路线授予refs，默认AppKit pins不变。严格types与browser单测7/7，新增真实AgentSession/faux4/4证明含prepare+navigate的11→5请求/10→4外层acquire（非桌面性能）；旧AppKit43/43及loop4/4通过。browser-bridge-complete-snapshot-check全0/193pass+5skip/controller38/drift0；首次snapshot遗漏并发新增live-line-scroller且compaction测试当时类型漂移，失败保留，只补快照输入未改并发产品。新current-stage GUI runner验证当前children产物和81pins；fresh console/TCC/Stop准入后current-form-live-1 prepare成功，navigate约20s后拒绝browser_navigation_unconfirmed。原生terminal/cleanclose/destroy、owner1/fixture0自然退出/EOF，无forced/无Fill/Press，C27→C28；继续定位导航，无租约恢复或重复未知动作。

- 2026-09-19T14:20Z: T-031诊断在新profile取得Page.navigate timeout20s及Page/Network开始事件，exact owned-browser stack显示SecItemAdd→makeLoginAuthUI→AuthorizationCopyRights同步等待。matching153源码确认use-mock-keychain选择内存FakeKeychainV2；未访问钥匙串内容/批准弹窗/修改OS权限。固定launcher加入此单flag，真实keychain-fixed-live-1导航收到HTTP200/complete、原等待栈消失，后因初始AX空值省略触发过强harness断言，cleanclose至C31。初始oracle改为native唯一字段＋独立ready空值证明，2项反例回归通过。随后keychain-form-live-1真实首次Fill已将Name改为value-Name，但canonical结果投影拒绝为unknown/prefix0；按规则停止无尾部输入/重放，cleanclose至C32。新增T-032，定位typed dom结果缺内部ActionExecutionRecord；navigation临时诊断两源已原样恢复并归档，固定mock-keychain保留，后续构建需重新冻结pins。

- 2026-09-19T14:33Z: T-031/T-032 done：保留先红后绿及全部失败，最终四Rust增量2f598c44/81pins/core69/registry70/platform59/SDK45/生成/类型检查通过。form-fixed-live-1真实8/8＋Press postcondition、精确独立10event oracle、六terminal/两自然0/EOF/资源删除/C33，无强杀/恢复/重放；verify-browser-form-fixed核对六runs。browser7/7/loop4/4/root-graph types0；完整fresh snapshot check0/193pass+5skip/controller38/drift0，前次遗漏并发未跟踪compaction-control.ts失败保留、未改并发产品。T-027继续对抗场景与bridge/children GUI；无真实模型调用，P04整体仍未完成。

- 2026-09-19T14:40Z: 新固定13case browser对抗fixture/probe/oracle完成语法检查及4项私有tests（含各固定页面HTTP oracle）通过；actual batch首scenario-ref在console gate明确locked=true，child-exits=[]、无server/owner/GUI/lease操作，立即停止；其余12case未启动。T-009/T-027转blocked，下一步仅用户人工解锁后fresh资格、新证据名、expected C33继续；无需重启/恢复。新增两条已验证LEARNS（临时profile的OSCrypt keychain与canonical内部action record），保留已有444行/并发修改；未staging/commit/push，无活跃background。

- 2026-09-19T14:52Z: 用户报告已解锁；unlocked-resume-admission0核对14bridge/16artifact及463Rust、authority未漂移，console onConsole=true/private lock key unavailable，不将缺失key当独立解锁证明。T-009/T-027恢复in_progress/coordinator；采用新unlocked-scenario证据名，从expected clean C33逐进程重新TCC/Stop串行资格，无租约恢复。

- 2026-09-19T15:04Z: 解锁后13个browser对抗case全部通过，独立verifier核对351raw/26自然0/EOF/terminal/cleanup/C34–C46；deadline为prefix6/第6步已投递unknown、code deadline_expired，不谎报撤销或重放，cancel为prefix0/无input。child真实独立双profile/PID/window、祖先撤权阻止已分配child input至C47；实际TS bridge lazy绑定/原生八步/Press、六acquire/六operation/精确oracle至C48，child-bridge verifier通过。T-027 done。T-009继续收尾批执行与逐动作真实对照；原计划P04门禁是有限顺序执行与上述场景，完整像素/数据通路仍在P06、激活/打包P07，不以此缩小总体交付范围。

- 2026-09-19T15:20Z: 真实四个两步plan baseline与单八步plan具有完全相同10事件效果/焦点oracle，前者12terminal至C49；同一最终browser SDK的AppKit八步AX通过、三terminal至C50，全部两自然0/EOF，独立p04-baselines-verification通过。browser-qualification-final-check全0/193pass+5skip/controller38/drift0，SDK45含重复/冲突operation拒绝用例。T-009 done（原计划P04有限顺序段），T-010进入in_progress/coordinator，先独立P05 stage与分项计时。原计划总体应用/窗口/像素/打包范围仍保留，不把阶段交付等同全部Computer Use；无性能结论。

- 2026-09-19: T-010独立P05诊断阶段通过编译/生成/81pins/type/load及三真实表单；记录每form16次窗口检测约16.5s/总26.3s（62.73%），纯AX工作约0.18s，另8.6s不在当前platform计时内。九terminal/六自然0/EOF到C53，无优化/恢复/真实模型。初始test参数、Python dylib输入分类和µs截断verifier失败均保留并修正验证，不删测试。当前继续测量canonical应用元数据枚举/重复plutil成本，避免未证明就改focus生命周期；timing-before-metadata归档前一诊断产物。

- 2026-09-19T17:16Z: P05新增metadata计时确认原缺口是16次应用枚举8.818s；候选用现有CoreFoundation一次解析≤1MiB的XML/binary plist，异常类型/大文件/不支持路径保留原plutil，未缓存身份/改变权限或focus。两机制回归before101→4/4；APFS不允许非法UTF8文件名的fixture错误单独保留并改为测试路径参数。三个独立私有文件micro进程各100对通过（非桌面性能），apps16/platform63+1显式benchmark ignore、SDK45/core69/生成/type-boundary通过。五组counterbalanced实际表单A/B都有mapped dylib校验、相同131appCount/八步oracle、30terminal/20自然0/EOF/C55–C64；median form下降32.37%，独立plist-ab-verification通过。整体root types先有并发stats/Luna错误，复查剩narrative和verify-feasibility错误，未修改并发产品。随后candidate浏览器首case在prepare报image_catalog_changed，关闭index0报browser_helpers_not_drained，D65/Node1+fixture0自然退出，零页面input。T-010 blocked，新增T-033；三次当前owned image空集补证只读通过，同boot，无SDK/信号/删除/清锁。

- 2026-09-19: T-033离线readiness修复完成后转blocked：原2fail/2pass→5pass，platform68pass+1ignore/SDK45/core69及完整生成/type-boundary/load-only均0；原15s内只重读瞬变目录，保持完整稳定PID/image/start证明与5s清理规则，增加未来失败最后类别/数量诊断。增量patch b25146ff/81pins和原raw/产品未漂移；D65未改、无新GUI/信号/目录删除。当前三次image空集只作行政恢复补证，旧terminal仍未证明；需要用户新的单次恢复决定，旧授权不复用。

- 2026-09-19T18:13Z: 用户明确批准执行D65恢复并持续交付；T-033恢复in_progress/coordinator，先复用已审查验证器准备独立D65 helper及私有回归。只读sysctl确认仍为boot1789810895/1124DF55-8742-457B-A793-BA8FAED3B8AC；尚未canonical写入或新GUI，T-010仍blocked。焦点/授权保护未删除。

- 2026-09-19T18:18Z: D65唯一恢复执行0，保留旧root/raw，20私有case及新三次empty facts/boot/609inputs/81pins/排他锁通过，同inodeC65且oldTerminalProven=false。新readiness native四case通过至C69；readonly准备再次catalog_changed，新增诊断明确整个files-drain最后仍catalog_changed而非已读到live helper。D70保留，无新GUI；T-034进入in_progress因果定位，不能声称延长被动重读已解决全部问题。

- 2026-09-19T18:23Z: D70独立只读分支诊断100次完成，当前可取得稳定空目录（也捕获一次pidinfo不完整瞬变）；该新事实不是旧terminal，尚未唯一证明现场原因。按用户本轮“后续默认批准所有权限”持续处置授权，coordinator准备一次D70行政恢复以运行仅prepare/close的有界诊断：仍须20私有case、固定输入/旧raw、新三次empty facts/同boot/同inode/排他锁，归档fsync先于状态更新；保留D70旧profile，无旧terminal声明。此次仅诊断无页面输入，不在runtime新增自动恢复，任何新失败停止批次并先定位，不能形成盲目清锁重试循环。

- 2026-09-19T18:35Z: T-034已证一个读取缺陷：10次私有unreaped zombie实验前/后回收均stable、中间全部pidinfo incomplete；XNU proc_info源码说明PROC_PIDTBSDINFO非零arg才查zombie。精确回归原0arg失败/1arg通过，仅此参数及测试变化；platform69+1ignore/SDK45/core69/生成/check/NAPI/header/types/load全部0。readiness阶段10次prepare-only全部clean至C80（28自然退出含前四scenario），新完整隔离check0、193pass+5skip/controller38/drift0。新修复SDK在故意保持私有zombie期间真实prepare/close通过C81，随后ref通过C82；stale场景按预期拒绝输入，但close出现不同image_path_unavailable，D83保留、两自然退出且无forced。旧D65/D70缺少分支证据，未声称唯一归因；继续离线定位PID信息与路径读取间退出竞态，不恢复/重放该stale动作。

- 2026-09-19T18:39Z: D83邻接退出竞态已在真实私有cat/EOF/WNOWAIT barrier复现：先读到live BSD身份，退出后path读取原代码Err(image_path_unavailable)，新回归before101。修复仅把proc_pidpath的实际ESRCH分类为catalog_changed，仍需完整重读、双catalog一致；其他路径错误继续拒绝，不增加预算/信号。after1/1、platform70+1ignore/SDK45/core69/生成/check/NAPI/header/types/load均0，patch e31a94fa。D83现场未捕获errno，故不称唯一原因已证。按本轮持续授权准备一次单独D83行政恢复：20私有case/固定输入/三新empty facts/boot/inode/排他锁全部通过后才归档原位D83→C83，保留旧profile/raw与未知旧terminal；新GUI按fresh准入，非产品自动清锁。

- 2026-09-19T18:45Z: D83单次恢复0（20私有case/新三empty facts/boot/609inputs+9改动/81pins及排他锁验证），同inode归档fsync后C83，不补造旧terminal。最终path-race SDK全部13browser case通过至C96，独立final-browser-verification核对351raw/26自然0/EOF/终态和目录清理。AppKit同SDK form+九邻接case正在串行验证。为避免GUI验证期间自动空闲睡眠，新建有界3600s caffeinate -di assertion（task-16，结束需停止），不修改持久电源配置、不解除用户手动锁屏；后续正式性能须记录并固定该条件，不把本轮资格时长当性能。

- 2026-09-19T18:50Z: 最终AppKit十case通过，独立verifier核对270raw/20自然0及所有receipt/末值/无late input，最后C106。九Rust累计P05 patch先遇nested git apply静默跳过、独立Git根再暴露新增文件缺mode header；两失败保留，补header后完整apply/hash/reverse0，未改变已资格native源码/产物。T-033/T-034/T-010 done，仅接纳已测plist优化和目录读取修复，focus保守等待不删。T-011进入in_progress/coordinator，下一步封存并建立独立P06 stage/实际依赖图审计；P06–P08和总体仍未交付。

- 2026-09-19T18:55Z: P05 final-current-check全0、193pass+5skip/controller38/drift0；P06独立stage准备完成（611inputs/81pins/897sealed），当前审计确认SDK只关default-features仍被platform-macos默认core features和显式cursor/pip依赖合并，不能声称现有构建已裁剪。原P05与产品pins保持不变。LEARNS仅追加两条已证教训（zombie/读取间退出；nested git apply静默跳过），原有并发内容保留。

- 2026-09-19: T-035继续in_progress：14Rust新增typed image/capture分支已49/71/72+1ignore/49及genuine生成/类型/load通过；ArrayBuffer与bigint工厂经真实SDK加载验证（非截图或FFI buffer释放证明）。独立PNG解码/翻转与界外probe测试通过，P06ImageFixture严格编译/control smoke0；新image-native-live-1按fresh console/逐进程TCC/exact窗口/Stop准入执行，原P05不动。临时caffeinate task-16已停止；没有真实模型请求，图像原生资格/实际输入和构建裁剪尚待。

- 2026-09-19T21:26Z: 继续T-035：先完整复读authority并validator0。新控件contrast oracle在原双PNG失败；唯一fixture Aqua外观变更后同SDK真实双尺寸控件可见到C108，拒绝无依据开启child-window capture。buffer实验先在native close/destroy后验证两hash到C109，但GC检查失败；no-SDK async for-of保留最后对象的反例与同步作用域对照完成，修正harness后实际两buffer销毁native后可读、consumer引用释放后均GC到C110。原失败/前后脚本/manifest保留。独立三成功轮verifier81raw/15terminal/六自然0，最新隔离全check0/1395files无修复/193+5skip/38/drift0。没有新native补丁/主pins切换、GUI输入或真实模型请求；coordinator继续补必要输入/宿主集成，T-035/P06不提前验收。详见p06/image-qualification-report.md。

- 2026-09-19T21:32Z: 将已资格P06ImageFixture及独立PNG/控件contrast oracle落到native/computer/test；六个纯Python测试通过（含五种PNG filter、翻转/CRC/越界及每个控件空白拒绝）。image-durable-check再次完整0/193pass+5skip/controller38/drift0。仅这五个新文件已审查暂存并提交0d696a1f3af9798e492ee87e5740b25e39fa6986；未提交其他Computer未完成代码或并发变更，暂存区随后为空，无push。该提交只交付fixture/回归基础，不代表T-035/P06或总体完成。

- 2026-09-20: 用户continue后T-035继续in_progress/coordinator。实现genuine startImageClick：会话私有单次图像ref只保存geometry/SHA256，不缓存PNG；canonical click准入后在tracked worker重新截图比较，独立gate准入tracking move与down，已投递down的配对up由同步release obligation负责，取消不再启动新click。只用固定window-stamped public PID transport，无双投递/global HID/foreground fallback；HID硬件计数及按住键/按钮冲突拒绝，保留focus cleanup。纯回归含取消/祖先撤权/单次ref/close清除，contract49/core73/platform74+1ignore/SDK53和genuine生成/check/NAPI/header/types/load均0，21Rust增量pointer-final.patch=94a95de0，原四锁/P05和main pins不变。独立non-AX canvas fixture严格Swift6编译通过；下一步新console/TCC/Stop从expected C110准入，验证真实像素落点/配对事件/后台焦点/旧图ref拒绝及stale/modal/cancel；尚未实际pointer GUI，不提前验收。

- 2026-09-20: pointer真实首轮user_input_conflict零input至C111；十次passive聚合状态只见CapsLock置位，纯predicate回归before101/修复后pass，其余硬件冲突门禁不降。新SDK两尺寸真实non-AX canvas点击与ref拒绝通过C112。随后stale测试仅交换同外观空字段，实际投递一次click导致预期拒绝断言失败，counter1/三terminal/owner自然1+fixture0/clean C113保留，无重放。只读两图对照准备后console明确locked=true、零children，立即停GUI。T-035/T-011转blocked；离线新增显式canvas-hide/window-move刺激并严格编译，输入21Rust/81pins/16harness验证0，尚未新GUI。独立58raw verifier和patch严格apply/hash/reverse0；精确pointer坐标oracle三tests＋既有图像六tests通过，native候选patch和README已保存main但不切换产品pins、不宣称完整P06。下一步仅用户手动解锁后的fresh资格。

- 2026-09-20T01:33Z: 离线收尾pointer-blocked-check完整0（1395files无修复）/193pass+5skip/controller38/drift0；新visible刺激fixture严格Swift6编译0，21Rust/81pins/16harness admission0，九Python oracle tests0。没有锁屏后的新GUI/owner或marker访问/恢复；暂不提交尚缺邻接资格的native候选，既有0d696a1f3不变。T-035/T-011仍blocked等待人工解锁；本轮LEARNS未改，已证Caps谓词行为保留于源注释/回归和pointer-report。

- 2026-09-20T01:37Z: 用户报告“已解锁”；新pointer-visible-unlocked-smoke通过（owned可见/active-space/main-thread/Stop锁存与自然退出），21Rust/81pins/16harness admission0，无SDK owner。T-035/T-011恢复in_progress/coordinator；从expected C113逐行动PID重新TCC/Stop，串行实际邻接资格，旧锁屏/失败不改写，不恢复marker。

- 2026-09-20T01:39Z: 为这轮连续GUI资格启用有界1800s caffeinate -di（task-19），仅临时防空闲睡眠/显示休眠，不解锁用户手动锁屏、不修改持久电源策略；资格结束必须停止。本轮不是正式性能样本。

- 2026-09-20: 解锁后stale/move/modal/bounds/cancel五场景零输入拒绝和新live两图点击全部通过C114–C119；独立pointer-visible-runs-verification核对157raw/21terminal/12自然0。当前display backing scale=1，实际512×504与未放大560×552落点精确，补充已有2×资格。原错误layout失败不改写。完整pointer源/SDK归档scroll-before后，新增genuine startImageScroll（当前图像ref＋四方向、单离散line-wheel，无键盘/AX/foreground fallback），复用同一guard/tracked worker与两primitive限制；canonical scroll注册/NativeWindow allowlist单点扩展，browser scope仍拒绝。contract49/core74/platform76+1ignore/SDK55、生成/check/NAPI/header/type/load通过，26Rust patchaa17285f/81pins固定。真实NSScrollView fixture编译0，独立wheel＋实际clip-offset oracle两tests过；下一步从expected C119 fresh资格，不把载入或事件构造当真实滚动。

- 2026-09-20: 首scroll-native-down真实wheel/viewport移动到C120，但发现oracle遗漏NSScrollView翻转坐标，以及empty AssertionError在旧父脚本中被if error吞成exit0；未计为通过。原source/binary/report归档，分别1个/2个先失败回归修正后各三tests过；新fixture仅增加isFlipped/height元数据，实际smoke为true/160，native源/guard未变。修正后的scroll-checked-down user_input_conflict零输入拒绝到C121；30sample passive检测仍有HID计数变化，无held非toggle输入。批次停止，T-035/T-011 blocked等待短暂安静输入时段。26Rust patch严格apply/hash/reverse0、50raw失败/清理复核0、报告审计保留唯一exit0假成功；scroll-current-check全0/193+5skip/38/drift0。新ready-batch从C121准备但未执行，无恢复/真实模型调用。两个有界caffeinate19/24均自然结束。

- 2026-09-20: 离线收尾scroll-patch-verification对26Rust严格apply/bytes/reverse通过，root保留同hash实验patch p06-image-scroll.patch（不切换产品pins）。scroll-current-check完整0/193pass+5skip/controller38/drift0；修正父脚本三测试、翻转oracle三测试通过。最新console无明确lock值但不能独立当解锁证明；需要用户提供约3分钟无输入活动时段再fresh资格。无活跃caffeinate/GUI任务，不再盲重试；HEAD仍0d696a1f3，未新增commit/push。

- 2026-09-20: 用户结构化确认“现在可测试”，同意约3分钟暂不操作键鼠。T-035/T-011恢复in_progress/coordinator，立即fresh quiet/console/TCC/Stop后执行scroll-ready-*批次（expected C121）；任何新失败停止，不放松守卫或恢复marker。

- 2026-09-20: 用户安静时段后scroll-ready九case全部通过，独立234raw/31terminal/18自然0到C130，第一时间通知用户恢复键鼠，job-bound caffeinate退出。之后审查发现move后只重比parent图像不足以覆盖不改变parent像素的模态/可见性变化；复用原完整target检查到每个primary边界，纯seam before101/修复后pass，matching up仍仅已投递down的release义务。26Rust新patch69ef0c0b/81pins、49/74/77+1ignore/55及生成类型load通过；两新CGEventSetLocation签名冲突warning也以匹配既有macOS ABI声明解决。一次父脚本测试误传scroll-only的down mode到click runner，未进入被测异常路径；新增显式mode测试入口后两个parent各3tests通过，失败保留。fresh passive quiet30sample true后从C130执行三邻接；尚未把其结果当已完成，原已资格scroll产物完整保留。

- 2026-09-20: 接续时完整复读authority，核对HEAD仍0d696a1f3、dirty并发修改保留、无活跃后台任务。复核target-recheck两个独立verifier：click至C131、scroll-down至C132、scroll-modal至C133，合计79raw/13terminal/六自然0；完整check及193pass+5skip/controller38通过，main实验patch SHA256=69ef0c0b匹配。同步旧pending邻接描述，不把限定输入资格冒称P06完成；下一步仍由coordinator串行实现必要键盘与窗口定位。

- 2026-09-20: T-035继续完成受控键盘限定子集，先保存target-recheck源/SDK至keyboard-before。32Rust新候选41f020d2：50/74/80+1ignore/56、genuine生成/type/load及独立patch apply/byte/reverse通过，未降低canonical destructive授权。新fixture/独立oracle/parent测试后，fresh quiet=true，再运行真实live及四邻接：Tab/Return各一down/up，四零输入拒绝、单次ref重用拒绝，131raw/13terminal/十自然0独立核验至C138；job-bound caffeinate已退出。完整隔离check0/193pass+5skip/38/drift0。首次新增Reader unused warning已移除并重新完整生成；旧composition断言/缺typecheck参数失败保留。下一步窗口发现/选择只读审计：既有list_windows只列layer0且无controlled分支，不能直接把通用枚举接口作为当前受控实现；当前未新增Discovery scope/API。

- 2026-09-20: keyboard-durable-check完整0（1395files无修复）/193pass+5skip/controller38/drift0；main新增键盘fixture及独立oracle/三反例tests与已资格artifact逐字节一致，三tests再跑通过。review fixture相对pointer的增量及空暂存后，只提交这三个新文件17f8ff50a，未提交其它未完成Computer或并发修改。实验p06-image-keyboard.patch已按41f020d2保存、README记录资格限制。全树git diff --check发现范围外LEARNS.md末尾空行，未改该文件；局部验证单列。discovery-before已保存32Rust/SDK作为后续回退基线，当前没有Discovery实现或其资格声明。

- 2026-09-20: 用户更新真实provider/阶段commit/publishing/push授权并要求continue；coordinator已记录当前优先gpt-6-astra low有界opt-in，历史零调用保留为事实而非禁令。HEAD17f8ff50a及键盘候选未变；继续T-035窗口发现/精确选择，先保留Discovery与native/browser不同权限域，不把metadata枚举直接当作输入许可。

- 2026-09-20: Discovery限定实现37Rust/81pins、50/76/81+1ignore/59及真实生成/header/types/load/patch正反验证均通过，discovery-current-check完整0/193pass+5skip/controller38/drift0。专用normal layer0 fixture/control smoke通过；首真实只读目录在metadata_unproved拒绝，未发select或input，一terminal及两自然退出到C139。旧SDK/源/raw已封存；正在新discovery-diagnostic两源细分静态错误码，区分platform几何/身份/长度与SDK record/stamp解析。不从失败先猜根因，不需要lease恢复；尚无真实Discovery成功声明。

- 2026-09-20: Discovery因单条不合格candidate整表失败已通过两项先红后绿聚合回归修正，typed omittedWindows明确返回不发ref的数量；未借此放松任何选中目标/输入或helper终态证明。原C139–C141失败保留。C143补证旧stale刺激在WindowServer尚未更新时被选中（零输入）；新同SDK双catalog观察先旧x1000再新x1040后，旧ref按原guard拒绝到C144，因而只修harness readiness、不改native guard。独立六轮145raw/11terminal/12自然退出验证通过；verifier首版错误要求失败owner的cleanup-errors为空，修正为精确记录owner自然exit1后通过，原验证失败保留。正向GUI前的30sample quiet实际78、heldNonToggleInputObserved/counterChangeObserved均true，未启动正向owner；T-011/T-035转blocked，下一步请求约1分钟安静时段。新readiness3tests与parent3tests通过，37Rust/81pins/19harness ready固定；无lease恢复/真实模型调用/新commit/push。

- 2026-09-20: discovery-eligible-current-check完整0（1395files无修复）/193pass+5skip/controller38/drift0；readiness/reporting各3tests、输入37Rust/81pins/19harness再次核对通过。离线收尾后再做一次fresh passive检查discovery-ready-quiet，held已false但counterChangeObserved仍true、exit78，仍未启动正向GUI owner。保持T-011/T-035 blocked，等待约1分钟不操作键鼠的时段；准备仅提交本授权/状态文档，未将实验native代码或他人变更混入阶段commit。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: blocked
- Evidence: T-001—T-010、T-014—T-034 done；T-011/T-035 blocked/coordinator，T-036/T-012/T-013 pending。最新discovery-runs-verification.json核对145raw/11terminal/12自然退出至C144；discovery-eligible-patch-verification.json与原生50/76/84+1ignore/59、生成/type/load通过。最终discovery-eligible-current-check完整0（1395files无修复）/193pass+5skip/controller38/drift0。旧失败/unknown保留，不代表总体交付。
- Current continuation: 当前stage为discovery-eligible-*37Rust/81pins/8314efe7；新run-discovery-ready.py/probe-discovery-settled.mjs及discovery_ready_inputs.py使用19项固定harness，readiness与reporting各3tests通过。latest clean C144；用户安静时段确认后先fresh quiet/console/TCC/Stop，再从C144运行正向live，独立复核后继续host图像/T-036/P07/P08。原候选及失败分别封存于discovery-before、discovery-diagnostic-before、discovery-filtered-before、discovery-eligible-before；main新增同hash p06-discovery.patch及资格限制，产品P04 pins未切换。当前无GUI/assertion；上一功能fixture提交为17f8ff50a，授权及本状态文档准备单独阶段提交，不纳入未完成native候选或并发修改。真实模型调用/push仍零，这只是事实而非禁令。
- Historical evidence: T-030 done：native两修复before101/after4pass、49/43/66及生成/全部离线check通过，probe幂等回归before2fail/after2pass；fixed-2 fresh owner21507/Chrome21547/window150完成真实prepare→terminal→close→destroy、两自然0/EOF、私有files清理、C27。独立prepare-qualified-verification核对通过。完整browser观察/输入/计划仍待，P04–P08未交付。以下历史：D25诊断给出10窗口/唯一几何114及resource0:image_catalog_changed，两个原因已被先红后绿4case修复；platform49/SDK43/core66/生成/check/stage/header/nohost/full isolated check均0，193pass+5skip/controller38/drift0，四Rust patch655ba915。三个新的native只读image目录快照均0live，无lease/signal/delete；D25行政恢复尚未批准/执行，真实修复GUI尚待。D24已按一次授权在新boot同inode恢复C24，历史D24不补造terminal。以下历史：T-030已完成诊断/恢复准备：opt-in两文件diag patchdd84611e，diagnostic1+2/platform45/SDK43/core66、生成/check/N-API/header/nohost/隔离全check均0，193pass+5skip/controller38/drift0；旧16原生产物归档，605源边界/原失败raw核对0。私有D24恢复20/20，不代表canonical执行；等待用户手动重启，尚无confirmed-boot.txt/恢复archive或新GUI。真实失败原因仍未唯一证明，未声称行为修复。此前browser SDK prepare facade/registry/pool/初始绑定的platform45/SDK43/core66/生成及--check/N-API/header/strictTS/nohost load全部通过，七Rust增量patch1d0ebe4c/605源；新isolated check0及193pass/5skip/controller38/drift0。但prepare-live-2实际CfT启动后browser_window_ambiguous，资源close Quarantined，无clean host receipt；Node自然1/fixture自然0/EOF，无forced、无page输入，同inodeD24未清除，私有profile保留。T-029已修正严格TCC形态判断，9/9及fresh93502两服务完整Allowed通过。根因诊断/恢复门禁归T-030。以下历史：最新launcher内部装配platform42/SDK41/core66/fmt和isolated check全0（193pass/5skip、controller38、drift0），三文件incremental patch59cd9c41/602源边界核对；未注册/未公开ABI/未执行真实浏览器，详见launcher-report.md。最新授权允许必要权限/任意版本自主选择；官方CfT153.0.8010.52的供应商签名失败事实保留，经明确授权后完整官方归档/346文件/5links内容校验0，content-manifest81c3f5a8、未执行浏览器。此前T-027 image事实子集5/五轮5/platform33/SDK41/core66及fmt全0，incremental patch24584ae5/600源与历史输入核对0；browser-image-observer-check完整0/1376files无修复、193pass/5skip、38/38、drift0。Chrome153只私有复制验证，未执行或创建profile；外部code-sign clone/helper生命周期尚未覆盖，观察事实不作terminal/ownership。此前T-027 process-group子集process11/五轮10/platform28（含11 process）/SDK41/core66及fmt全0，natural-exit EPERM回归before101/after0，incremental process.patch bd351bd1及历史输入核对0；browser-process-check完整0/1376files无修复、193pass/5skip、38/38、drift0。仅group proof，不含escaped Chrome helpers；无Chrome/profile/GUI/public ABI/产品切换。此前T-027 distinct scope子集core66/registry70/authorization40/manifest15/SDK41/platform17及fmt通过，incremental scope.patch41e97239/历史输入核对0；browser-scope-check完整0/1376files无修复、193pass/5skip、38/38、drift0，无profile/GUI/public ABI/产品切换，T-027仍未验收。此前T-027异步生命周期子集core56/CDP33（19重叠）/SDK40/platform16通过，foreign pool/首失败握手两回归before101/after0，incremental patch27a67104及历史输入核对0；browser-lifecycle-check完整0/1376files无修复、193pass/5skip、38/38、drift0。T-027整体仍未验收，无profile/GUI/ABI/产物切换。此前T-028独立transport40/CDP25/SDK33/platform16通过、两回归before101/after0、patch9b6df0b6 apply/hash/reverse及历史输入核对0；browser-transport-check完整0（1376files无修复）、193pass/5skip、38/38、drift0，未切换产品pins或运行browser GUI。此前真实八步表单/十AppKit场景通过；T-026两回归before101/after0、SDK33/33，生成/header/strict types/load-only通过；tool8/8、真实AgentSession/faux4/4。modal-check完整npm check0（1376files，只格式化任务pin JSON已审查回写）、193pass/5skip、controller38/38，检查期live drift0。最后C23同inode，native terminal/close/destroy/自然exit0/EOF，未强制清理。T-024提交8779ac9ff仅三AI测试，无新提交；完整suite未重跑，历史9失败不是当前全绿声明。
- Limitations: 已验收AppKit/browser有限段不代表更广输入/像素/生产打包资格；9→3与11→5仅faux请求数，P05五配对32.37%仅组件性能；P06–P08仍未验收。P03仅driver-owned drain、非外部effect完成，旧owner56354终态仍未知。可选P04 bridge未默认激活，普通coding零native加载；不清未知marker、不重放未知动作。真实模型现获准gpt-6-astra low有界opt-in（保留此前qd/kmodel_latest high批准），目前零调用；允许阶段commit，所引publishing/push禁止条款已取消。共享树无关变更保留，Computer整体实现未完成；P06图像fixture/oracle五文件已提交0d696a1f3，键盘fixture/oracle三文件已提交17f8ff50a；其余本任务与并发修改仍保留。
