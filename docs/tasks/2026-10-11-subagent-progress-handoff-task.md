# Task Plan: 子代理非终止进度回报与中断交接

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户确认“子代理编排与交付机制”，选择新增非终止进度回报，并确认执行契约。

<!-- task-doc-section:background-goal -->
## Background and goal

session 5d920d4c 的 codemode-core 在 52m18s 后被 root 主动中断。最后回归已通过，但没有 deliver_result，保留结果为空。提供独立非终止进度与中断交接，保持执行状态、进度、最终结果和验收的区别。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅 pi/ 的协作协议、持久化、子工具绑定、查询/等待/中断反馈、显示及文档。report_progress 是 child 当前 turn 的结构性协议工具，不授权普通 team 工具，不结束 turn、不唤起额外推理。保存每 turn 最近进度，中断原因与交接分开呈现。

不恢复/重跑原 session，不接管 codemode，不引入自动超时杀任务或 effort 降级，不将 Interrupted 标记为成功。不修改其他 session 的 dirty baseline；不使用真实 API、凭据、完整测试 suite 或产品 build。保留无新增字段的历史数据读取。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户已确认目标、非终止回报行为及验收边界 | 本轮三个 request_user_input 回答 |
| F-002 | 旧 child 83 工具轮次、无 deliver_result，root 180s wait 后主动 interrupt | 原 session JSONL 4935–4953；child 1297–1309；registry turn 579ddcaf |
| F-003 | 最后 38 tests 在中断前通过 | pi-bash-task-16-fc235f9c.log，2.54s |
| F-004 | child 不能使用 root team tools；deliver_result 结束 turn | pi-collaboration-tools.ts:272；collaboration.md |
| F-005 | turn ledger 与 snapshot 同一事务，单 turn 元数据 8192 bytes | collaboration-store.ts；collaboration-contract.ts |
| F-006 | 当前 worktree 有独立 codemode 大量 dirty changes | 本轮 git status；共享 baseline 将按文件/hunk 保留 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 无。回报仅是子代理自述，不保证模型在单次长请求中即时响应。
- Open question: 无阻塞产品决策。技术接口固定如下：report_progress 输入 summary；保存 progress {summary,reported_at,revision}。中断保存 interruption {reason,requested_at,requested_by}。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 当前 child 可回报进度后继续运行并最终 deliver_result；root/其他 turn/终态回报拒绝。
- 每 turn 最近进度与中断原因持久保留，cold 查询/历史页面可见；followup 不继承上一 turn 进度。
- 有界回报只向 creation parent 投递非终止、明确 untrusted 的进度通知；连续回报合并未消费通知，不占无限 mailbox 或 completion reservation。
- targeted wait 捕获初始进度 revision，只在新的进度或终态返回；user_input 优先，timeout 不取消 child，timeout/interrupt 返回可检查的最近快照。
- UI 将进度与最终结果分开；Interrupted/not_completed 仍保持真实。无进度旧 records 可读。
- 定向离线 regression/integration tests、全仓 check 和 diff review 通过；仅提交本次文件/hunks。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001,T-002,T-003,T-005,T-006,T-007 -> T-004；T-002 -> T-005。
- Parallel batches: T-001 核心、T-002 宿主、T-003 显示按下述固定接口独立编辑，无共享文件；集成验收在全部 source 落定后执行。
- Serialization constraints: coordinator 独占 authority doc、显示/monitor 与最终 staging。T-001 独占 subagent contract/store/controller/session-host 及新 core regression test；T-002 独占 child host、root/tool adapter 与新 SDK integration test。两者禁止修改对方或既有 dirty 外围代码。
- Fixed interfaces: request.reportProgress?(turnId:string,summary:string):Promise<CollaborationProgress>；controller.reportProgress(identity,turnId,summary)；controller.interruptWithHandoff(identity,target,reason?) 返回 {previous_status,turn_id,progress?,interruption?}，既有 interrupt 保持 previous-status 返回；interrupt_agent 增加 optional reason。进度完整 JSON <=2048 UTF-8 bytes，原因 <=1024 UTF-8 bytes，使用 bounded schemas/validators。targeted wait 增加 reason:'progress' + pinned result，timeout 可含 pinned result。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 核心进度账本与中断交接

- Status: done
- Owner: progress-core
- Objective: 有界、当前 turn、原子进度与中断元数据及 wait/query 链路。
- Inputs and prerequisites: 已确认契约及固定接口；当前协作源码。
- Scope or files: packages/subagent/src/collaboration-{contract,store,controller}.ts；session-host.ts；新 test/collaboration-progress.test.ts。
- Expected output: 可独立验证的核心协议/数据层。
- Dependencies: None.
- Execution steps:
  1. 完整读取 owned sources 与相关 tests，保留历史无字段读取。
  2. 实现原子回报、coalesced parent 通知、turn 隔离、wait snapshot 与中断交接。
  3. 新 regression 文件覆盖内存/SQLite/recovery/预算/并发边界。
- Acceptance criteria:
  - 实现所有 core invariants，现有 controller/history/targeted-wait 回归保持。
- Verification method:
  - scoped Vitest progress/controller/history-store/targeted-wait/lifecycle/contract/mailbox。
- Validation evidence: coordinator 检查核心 schema/store/controller patch 与全部新 tests，复跑7files/182tests通过（task-12-a821cc74.log）；包括legacy字段缺省、原子 rollback、coalescing/reservation、current turn/owner权限、wait新revision/user-input/timeout、interrupt pinned receipt与recovery。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 子协议工具与 root 编排接线

- Status: done
- Owner: progress-host
- Objective: 子代理可 report_progress 后继续执行；root 工具与提示显示安全语义。
- Inputs and prerequisites: 固定接口；当前 native host/adapter。
- Scope or files: coding-agent/src/extensions/pi-child-session-host.ts、pi-collaboration-tools.ts、pi-collaboration-root.ts；新 test/pi-collaboration-progress.test.ts。
- Expected output: 当前 task 身份绑定、非终止回报、可观察 interruption receipt。
- Dependencies: None.
- Execution steps:
  1. 完整读取相关 source/test/docs。
  2. 结构性 child report_progress 注册及 live gates，root reason/receipt 接线。
  3. faux-provider integration 验证 report/continue/deliver/authority。
- Acceptance criteria:
  - 不触发额外推理，不扩普通 team 权限，不把 progress 当 result。
- Verification method:
  - 新 SDK integration；既有 catalog 预期接线独立归 T-005，cold ceiling bug 归 T-006。
- Validation evidence: coordinator 检查完整新 test 与宿主补丁；独立复跑新 faux-provider integration 8/8 通过，exit0（task-5-6f6a3eb5.log，13.49s）；包括回报后read+deliver、native持久化/parentingestion、waitprogress/timeout、interruptreceipt与preserve，无额外 inference。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 查询显示与文档闭环

- Status: done
- Owner: coordinator
- Objective: 中断后最近进度与原因可见，编排建议一致。
- Inputs and prerequisites: 已固定 progress/interruption/query 接口；当前显示源码。
- Scope or files: subagent-group.ts；pi-collaboration-monitor.ts；必要 Grok panel；相关 tests；docs/collaboration.md。
- Expected output: 独立 progress/interruption 显示、操作交接和文档。
- Dependencies: None.
- Execution steps:
  1. 完整阅读目标文件并更新 display validation/rendering。
  2. 明确进度/最终报告/执行状态区分及等待限制。
  3. 定向 rendering/monitor 回归。
- Acceptance criteria:
  - 无进度旧记录照常显示，新 progress 不覆盖 deliver_result 或终态。
- Verification method:
  - scoped display/group/monitor/routing/turn-group，加Grok明确选择18个相关可用回归。
- Validation evidence: 最终coding-agent8files/220tests全部通过（task-15-06b0be44.log），包括canonical terminal interruption在同毫秒时不被延迟control receipt覆盖、新turn不带旧progress、无伪completion、窄宽度与operator view。Grok18pass/2明确skip（task-17-ecffa817.log）；两项已在完整组合run观察失败且证明预期与baseline冲突，未修改/弱化，仍作为范围外限制。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证与限定提交

- Status: done
- Owner: coordinator
- Objective: 复查因果路径、回归和共享 diff 后提交。
- Inputs and prerequisites: T-001/T-002/T-003/T-005/T-006/T-007 全部已验收。
- Scope or files: 本次 changes/hunks；authority doc；LEARNS.md既有原生权限lesson仅追加verified shutdown补充。
- Expected output: check、定向集成、独立只读审查与限定 commit。
- Dependencies: T-001, T-002, T-003, T-005, T-006, T-007.
- Execution steps:
  1. 复跑 core/SDK/UI 回归，独立审查关键风险。
  2. npm run check 前后保存 dirty hash/diff，隔离其自动格式化。
  3. 只 stage 本次 hunks，检查 staged diff 并提交。
- Acceptance criteria:
  - 无已知阻塞缺陷，其他会话的 staged/dirty changes 未混入。
- Verification method:
  - targeted tests、npm run check、git diff --check 与 task document validator。
- Validation evidence: 420 tests，npm run check exit0、无自动改写/index变化（task-16-9e5b4914.log + snapshot compare）；git diff --check、task validator通过。明确stage本任务18个文件，逐项核对无其他会话hunks；源码与测试提交6dff658b4成功。最终本段状态记录仅文档收尾。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 结构性协议 catalog/prefix 接线

- Status: done
- Owner: progress-host
- Objective: 将 report_progress 与 deliver_result 一致排除普通 delegation/prefix catalogs，并保持原 prefix equality 断言。
- Inputs and prerequisites: T-002 已实施接口；SDK regressions 实际识别 catalog expectation mismatch。
- Scope or files: pi-collaboration-context.ts；pi-collaboration-tools.test.ts；child host 删除重复 inline prefix filter。
- Expected output: 中央 schema 投影过滤与真实新结构工具断言。
- Dependencies: T-002.
- Execution steps:
  1. 完整读取相关 source/test，增加必要协议过滤。
  2. 不删除 cold followup read 的原有断言；单独定位其失败。
- Acceptance criteria:
  - preserve/rebuild 路径保持正确，结构性工具不进入普通 capability 记录。
- Verification method:
  - 指定 progress/tools/child-host 文件，保留实际结果。
- Validation evidence: coordinator 检查中央schema投影与既有test patch，保持原 prefix equality/read断言；最终tools33、host21、progress9及显示邻居合计220 tests在统一run全通过（task-15-06b0be44.log）。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — clean shutdown 后的权限 ceiling 保留

- Status: done
- Owner: progress-core
- Objective: 定位 cold explicit followup 的原 read ceiling 丢失；仅因果证明后最小修复 future clean shutdown，不恢复猜测的旧权限。
- Inputs and prerequisites: 实际 SDK regression :988（protocol tools 可见但 read 缺失）；worker 查明 stopping/unbind 可能首个坏写。
- Scope or files: collaboration-controller.ts；本任务新 collaboration-progress.test.ts。
- Expected output: 可复现实证与必要最小修复，或明确阻塞报告。
- Dependencies: None.
- Execution steps:
  1. 使用 deterministic fake host 捕获非空 grant -> 空 grant 的首个写入。
  2. 保留 live revocation/fail-closed；不得 reopening 时凭猜测扩权。
  3. 复跑 core 和 coding-agent 指定 cold case。
- Acceptance criteria:
  - 原 read 断言保持；撤权仍持久保留；progress retained metadata 不回退。
- Verification method:
  - scope core files 与 cold explicit followup case。
- Validation evidence: 读取before/after first-divergence与source，root最终core182 + coding-agent220均通过；不移除cold read断言，root/local撤权和真实getter不确定仍fail-closed。进入stopping后的新权限变化不作重新捕获，执行门已关闭；未猜测恢复旧权限。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 进度拒绝的 admission 确定性

- Status: done
- Owner: progress-core（controller）；coordinator（host 与 SDK regression）
- Objective: 进度写入前预算/身份/容量拒绝不能使原任务误进 needs_reconciliation；写入失败仍 unknown。
- Inputs and prerequisites: root 实测 summary2000 输入 JSON 小于2048，但加 host 元数据后超限；原任务被 suspend。
- Scope or files: collaboration-controller.ts；新 collaboration-progress.test.ts；pi-child-session-host.ts；新 pi-collaboration-progress.test.ts。
- Expected output: 复用 CollaborationAdmissionError 明确 precommit 拒绝，无泛化成功/confirmed。
- Dependencies: None.
- Execution steps:
  1. 捕获原始 task id 和宿主 outcome，先观察 regression 失败。
  2. 仅 persist 前已证实拒绝返回 not_started；host 保留未知 postcommit/generic error。
  3. 验证原任务继续 read/deliver，forced SQL commit failure 不冒充 admission。
- Acceptance criteria:
  - 原 task 没有悬挂副本且正常完成，progress 未写入；真实未知仍保守。
- Verification method:
  - root metadata-budget integration + core admission/disk-failure cases。
- Validation evidence: root原task-suspension regression先失败；修复后相同task id保持completed、无suspended副本且继续read/deliver，宿主outcome实测not_started；SQL/postcommit仍unknown。最终182core与220SDK/UI回归通过。曾在provider响应中安装onToolResult造成instrumentation undefined，改到run admission前的真实observeSession，断言保留。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

仅目标 Vitest files，faux providers、本地内存/SQLite，禁止真实 API与完整 suite/build。root 全仓 check 按 AGENTS 要求运行，记录输出与自动格式化边界。验证 progress 不终止、不重跑、user_input 优先、wait timeout 不取消、旧 ledger 与历史 turn、权限和预算、UI 将自述进度明确标记非最终结果。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 模型一次长请求仍不能响应进度工具；本修复改善可报告/可观察交接，不承诺强制及时回报。
- progress 若无合并会填满 mailbox；只保留每 turn latest 并合并未消费同 turn progress。
- progress 和 result 共用展示可能误判完成；各字段/消息 kind 与标记必须分离。
- 共享 dirty 文件需按 hunk 提交；基线另存 /tmp，仅 owner 编辑指定文件。
- 改 source 不会热更新已运行的旧 session；不回写旧 team 数据。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 用户确认契约；读取最新共享 status 和协议接口，固定核心/宿主边界，T-001/T-002 开始。
- 2026-10-11: coordinator 完整读取显示/monitor 源码；固定 notification payload，T-003 可按既定输入并行实现，T-004 统一接线验收。
- 2026-10-11: 新 display regression 修改前 10/10 失败（progress 被计为最终结果且无 cold handoff）；实现后 display/group/monitor/routing/turn-group 5 files /155 tests 通过（task-4-b1bfed65.log）。一次 fixture 无 delegation 导致 format unknown，改成真实 admitted delegation，未弱化断言。
- 2026-10-11: Grok 组合中 18/20 通过；两项旧预期与开工前 dirty baseline 冲突：root 无 terminal-toast subscription，dead-owner 自动恢复已开启。baseline root 对比仅本次 command description 改动；不擅改 toast/recovery 产品行为或测试。
- 2026-10-11: T-002 child 报告新 integration 8/8，但 tools/child-host 合计58pass/4fail，旧 exact catalog 预期需添加新协议工具/过滤。新增 T-005 接线（不移除原 prefix/read 断言）；单独 cold followup read 丢失仍需区分基线问题。
- 2026-10-11: coordinator 独立新 SDK8/8 复跑并检查 source/test，T-002 验收。T-005 更新预期后组合61/62，唯一 cold explicit followup read 缺失，新增 T-006 有界因果诊断/必要修复。独立 read-only reviewer 检查 progress/storage/UI 快照，不扩展到 codemode。
- 2026-10-11: core T-006 首个坏写实证为 shutdown stopping 造成 live getter interrupted -> cleanup fallback[] 持久化空 ceiling；只在 shutdown 前捕获已验证 live ceiling、失败仍[]。root 五个核心文件105tests独立通过（task-7-6a778b31）；原 cold native case child 复跑1/1通过，待统一验收。
- 2026-10-11: independent reviewer 找出 UI first-write-wins 中断原因；root 新 same-turn newest-reason regression 先失败（task-8-5b3b67b7），改用 requested_at 排序，不允许较老回执覆盖。
- 2026-10-11: root 新 metadata-budget integration 先失败（task-9-7affb700）：写入前超限造成原 task needs_reconciliation。新增 T-007，host 只识别已有 AdmissionError 为 not_started，core 严格区分 precommit 与 SQL commit failure。宿主 worker 已交接并关闭，root 负责剩余 SDK type/边界验证。
- 2026-10-11: 同毫秒回执另复现旧reason覆盖canonical终态（task-10-b0912c7a）；增加私有canonical-terminal标记，未增加wire ordinal。独立review报告已覆盖原distinct-timestamp问题，最终tie fix由root红绿tests验证。
- 2026-10-11: 其他会话完成并提交codemode，HEAD更新到05d65c259，当前只剩本任务改动；未stage或重写其文件。最终验证420pass，npm check完整输出通过且snapshot/index零变化。同步既有LEARNS权限lesson的shutdown因果补充，无泛化权限恢复。T-001/T-003/T-005/T-006/T-007验收，T-004进入限定提交。
- 2026-10-11: 限定18文件提交6dff658b4成功；全部源码/新tests/必要既有断言、docs与verified lesson已保留。T-004完成；仅本authority doc更新最终状态，无新增代码或范围扩展。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 所有T-001～T-007完成；core7files182 + coding-agent8files220 + Grok18 =420pass；最终npm run check通过且无自动文件/index变化。源码与测试已提交6dff658b4；document validator与限定diff review通过。
- Limitations: Grok两个完整run已失败的既有toast/manual-recovery预期仍留存，18-case追加run明确skip，不声称完整Grok suite绿色；source-only，未重建安装包、未跑真实模型/API或物理terminal。原session不恢复或热更新，single long provider request仍可能没有即时回报。
