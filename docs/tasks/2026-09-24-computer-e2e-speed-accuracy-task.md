# Task Plan: Computer E2E 速度与准确性精简

- Created: 2026-09-24
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求执行速度、准确性优先的 E2E 和逐项精简对照。

<!-- task-doc-section:background-goal -->
## Background and goal

建立从首次工具加载到业务结果与关闭的真实 UI 测量，依据同任务对照决定精简，不用减少断言伪造提速。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

仅 pi Computer 测试、源码优化和改造；2026-09-24 用户明确授权继续源码级优化，并追加真实模型、完整 Chrome 及主流 benchmark 测试。真实 API 必须显式 PI_REAL_MODEL_EVAL=1，仅使用现有配置，不输出凭据；首批每任务最多 24 模型回合/180 秒、累计已报告费用达到 10 USD 后不开始新任务，不自动重试失败。原始记录保留。不改变系统权限、不删除租约、不操作业务文档。不得用绕过目标/输入归属校验伪造成功。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 已有真实保存、正常替换和失效全选 fixture | native/computer/desktop/fixtures/save-panel |
| F-002 | 已有基准排除了 discovery/readiness | docs/implementation/computer/general-benchmark-results.md |
| F-003 | 本轮 120 次真实 UI 尝试中，保存重开 34/40，正常替换 40/40，失效全选正确拒绝 40/40；全部完成关闭 | /tmp/epi-e2e.mHUqs8/paired-20/{contract.json,samples.jsonl,summary.json} |
| F-004 | 一次独立计时中 ax_readiness 的窗口检测消耗 1024.481ms，实际 call 0.480ms | /tmp/epi-e2e.mHUqs8/phase-trace.log |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 当前 macOS/Node 安装作为首个基线平台；运行时记录版本和二进制指纹。
- 真实模型已授权；官方大型 benchmark 全量依赖 VM/专属网站与账号，先核对并区分官方任务子集和本地映射用例，不能宣称官方完整分数。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 同一业务 oracle、全量失败样本、冷加载和关闭独立计时；禁止失败自动重跑。
- 合并/拆分选择观察使用同一二进制，按对交错执行；不声称固定脚本代表真实模型 E2E。
- 后续覆盖浏览器、纯视觉、焦点/取消干扰和连续会话后才判断全链路完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-004; T-001 -> T-002 -> T-003; T-001 -> T-005; T-001 -> T-006; T-001 -> T-007. 全部串行；覆盖采集不依赖焦点修复完成，失败原样保留。T-005/006 为局部交付。
- Recovery dependency: T-001 -> T-008 -> T-007 的后续 GUI；恢复与原生生命周期串行诊断。
- Follow-up dependency: T-008 -> T-009；浏览器动作契约与诊断继续串行修复。
- Parallel batches: 无；同一 fixture、记录格式及桌面串行。
- Serialization constraints: 同一桌面禁止并发；文档由 coordinator 维护。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 测量与首批真实 UI 对照

- Status: done
- Owner: coordinator
- Objective: 可重复的三种 fixture 基线与选择观察 A/B。
- Inputs and prerequisites: 已安装原生包及保存 fixture。
- Scope or files: native/computer/desktop/fixtures/save-panel。
- Expected output: 有界 runner、原始 JSONL、分段计时、汇总与定向单测。
- Dependencies: None.
- Execution steps:
  1. 复用真实工具路径，加入计时、独立结果和关闭判定。
  2. 交错运行 split/combined，先小样本确认，再扩大。
- Acceptance criteria:
  - 三种模式真实执行；失败不丢弃；未证明排空则停止整批。
- Verification method:
  - 定向 node:test、真实 GUI、npm run check、文档校验。
- Validation evidence: node --test native/computer/desktop/fixtures/save-panel/metrics.test.mjs：3/3；npm run check 通过；120 次真实 UI 对照完整记录并正确以非零退出报告 6 次业务失败。测量任务完成不等于产品基线通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 扩展业务与干扰覆盖

- Status: in_progress
- Owner: coordinator
- Objective: 浏览器、纯视觉、连续会话、焦点变化和取消。
- Inputs and prerequisites: T-001 的测量与 oracle。
- Scope or files: native/computer/desktop/fixtures。
- Expected output: 可重复任务与扰动结果。
- Dependencies: T-001.
- Execution steps:
  1. 增加每种独立执行机制的最小任务，不复制相同流程。
- Acceptance criteria:
  - 正常成功与正确拒绝分开统计，无错误输入和遗留占用。
- Verification method:
  - 实际 UI 与独立结果读回。
- Validation evidence: 通用 owned AppKit/WebKit 10 场景各 5 次，50/50，通过实际工具调用、独立状态读回和干净关闭；/tmp/epi-general.dpLJ12/final。中间九场景版本另有 45/45，不混入最终分布。完整浏览器和输入中途取消尚未覆盖，任务保持 in_progress；coordinator 下一步接入独立浏览器 profile 的本地页面导航/表单与受控中途取消。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 成本归因与精简决策

- Status: pending
- Owner: coordinator
- Objective: 逐项决定合并、缓存、保留或删除。
- Inputs and prerequisites: 完整本地基线与干扰覆盖。
- Scope or files: native/computer 与测量报告。
- Expected output: 有证据的 A/B 决策，待授权项明确列出。
- Dependencies: T-002.
- Execution steps:
  1. 优先实测多余往返，再追踪校验和权限检查成本。
- Acceptance criteria:
  - 业务结果等价，收益大于噪声，尾延迟和错误率不劣化；无证据不删除。
- Verification method:
  - 单变量交错对照及必要的真实模型 E2E（须另行授权）。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 保存焦点失败定位及回归

- Status: in_progress
- Owner: coordinator
- Objective: 解释并修复保存流程中 foreground_focus_unproved 的首次分歧，不绕过焦点校验。
- Inputs and prerequisites: T-001 的 6 次失败原始日志；现有 owned fixture。
- Scope or files: native/computer/desktop/fixtures/save-panel 与相关原生焦点路径。
- Expected output: 焦点前后状态证据、单变量复现、最小修复及相同业务 oracle 回归。
- Dependencies: T-001.
- Execution steps:
  1. 在失败的 Return 前后记录 fixture 的前台应用、key window 和 native 目标状态，区分 fixture 未就绪、真实焦点变化与保护误拒绝。
  2. 先形成可证伪复现，再实施授权范围内修复；不得重放 inputCommitted 的动作。
- Acceptance criteria:
  - 失败原因有直接证据；保存、正常替换和失效全选保护回归均通过，无遗留占用。
- Verification method:
  - 原始失败 trace 对照、独立文件与重新打开读回、串行重复 GUI 回归。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 不支持 AX 启用时的无效等待精简

- Status: done
- Owner: coordinator
- Objective: 对明确未改变应用状态的 AX 启用结果跳过窗口变化等待，保留已接受/未知结果和回调排空。
- Inputs and prerequisites: T-001 分段计时及现有 readiness_settle 返回分类。
- Scope or files: 原生 tools/computer、observation/native、segment；增量补丁与安装包。
- Expected output: 同业务 oracle 的原生二进制 A/B、源码补丁、已资格验证的安装资产。
- Dependencies: T-001.
- Execution steps:
  1. prepare 返回是否已接受启用，保留拒绝/错误分类；只在明确 unsupported/not implemented 且成功返回时释放 lease 并跳过等待。
  2. 交错二进制对照、原生与桥接测试、重新生成绑定检查、安装路径回归。
- Acceptance criteria:
  - 没有放松目标、权限或输入校验；成功率及关闭无回归，端到端收益明显。
- Verification method:
  - 三场景 10 对交错 A/B；native tools::computer；源码/材料/包一致性与安装后 UI。
- Validation evidence: /tmp/epi-optimize.vOX6Su/fast-ab 60/60；最终安装 installed-screening 60/60；完整保存探针（含旧 ref 拒绝/parent 隔离）通过。最终 native tools::computer 67/67、focus_steal 11/11、配置 headless fixture 后 SDK controlled_ 94/94；desktop 124/124、package 8/8、typecheck、npm run check、UniFFI --check 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 单次选择并取得视觉证据

- Status: done
- Owner: coordinator
- Objective: 让 agent 以 select observe:image 获取新图及可用 ref，省去独立 capture 轮次。
- Inputs and prerequisites: T-001 现有选择/读取合并路径和证据授予机制。
- Scope or files: native/computer/desktop/contracts.ts、tool.ts、test 与 README。
- Expected output: 不隐式读取 AX 的选择+截图接口，保留旧语义接口及选择-only。
- Dependencies: T-001.
- Execution steps:
  1. 复用现有 child/session/terminal 调度路径，选择后按指定种类读取。
  2. 验证图片可见性、引用消费及取消；真实 UI 输入读回。
- Acceptance criteria:
  - 少一轮调用；未展示或过期图不授权输入；不增加第二执行循环。
- Verification method:
  - 定向契约/工具测试、类型检查、安装后的 owned UI。
- Validation evidence: 19/19 定向及 124/124 desktop 测试通过。安装后 image-synthetic 探针真实 Tab 输入、完整正文 fixture/AX 双读回通过，taskMs=526.976，关闭成功，lease C045c。该值为单次冒烟，不是视觉性能统计。
- Blocker: None.
- Unblock condition: None.

### [ ] T-007 — 真实模型与 Chrome benchmark

- Status: in_progress
- Owner: coordinator
- Objective: 真实 AgentSession、隔离完整 Chrome、主流 benchmark 原始任务和机制映射测试，依据测量继续优化。
- Inputs and prerequisites: 现有模型配置、已资格验证的 CfT 与 native 安装；真实 API 用户授权。
- Scope or files: native/computer/desktop/fixtures/real-model 与相关最小生产改动。
- Expected output: 显式 opt-in runner、来源/种子/版本/费用/逐轮耗时与独立 oracle；官方任务与自建任务分开统计。
- Dependencies: T-001.
- Execution steps:
  1. 核对官方 MiniWoB++、BrowserGym、WebArena、WorkArena、OSWorld 的运行边界。
  2. 先单个真实调用验证，再执行有界 Chrome 任务；只有 Computer 可操作任务，禁止模型读 evaluator 或直接调用网站 API。
  3. 按失败及延迟归因做最小修复/优化，再运行相同 oracle。
- Acceptance criteria:
  - 真实 provider 请求、Chrome 输入和独立结果三者闭环；成本和回合上限生效；关闭可证明；无假报官方全量分数。
- Verification method:
  - 定向离线测试、真实模型轨迹、Chrome UI 状态、原始结果与 npm run check。
- Validation evidence: 真实模型十三场景完整单轮 3/13；额外 image-first Chrome 1/5。原始失败、provider 异常、费用与关闭状态全部保留。benchmark 单测 11/11、directory/entry 3/3、打包 9/9、desktop 加载级 124 pass/1 skip；npm run check 通过。详见 native/computer/desktop/fixtures/real-model/RESULTS.md。
- Blocker: None. 生命周期阻塞已解除、T-009 已完成；当前执行 T-010，先验证受限 HTML dialog，再实现 select。后续用相同 oracle 复测，全部尝试记录于 RESULTS.md。
- Unblock condition: None. 全图校验改为目标区域校验仍是另一独立待确认取舍。

### [x] T-008 — 授权恢复与浏览器生命周期修复

- Status: done
- Owner: coordinator
- Objective: 在保留隔离语义的前提下恢复已死亡测试 owner，取得 prepare/close 的确切错误并修复。
- Inputs and prerequisites: 用户本轮明确同意受控租约恢复并修复；D04f7 原始证据、候选源码与已安装 SDK。
- Scope or files: 一次性审计恢复工具、native/computer/browser、desktop/entry、原生 browser lifecycle 与最小回归。
- Expected output: 不删除/替换锁 inode 的人工授权恢复记录；故障前后原生与模型验证。
- Dependencies: T-001.
- Execution steps:
  1. 验证 account-home、私有权限、精确 inode/generation、无存活 owner/测试浏览器/renderer，在 exclusive flock 内原位恢复已授权 generation，记录审计。
  2. 使用最小只准备/关闭探针保留原生错误分类，先确定首次分歧，再修复及资格回归。
  3. 恢复真实模型 benchmark；输入/截图问题分别定位，不未经确认放宽全图校验。
- Acceptance criteria:
  - 恢复不抢活 owner、不删除锁、不自动清除任意 dirty generation；prepare/close 可重复通过，失败不隐藏。
- Verification method:
  - inode/marker/read-only process checks、原生有界诊断、定向测试、相同模型任务、npm run check。
- Validation evidence: D04f7/04f8 均经精确 generation、无 owner/测试进程、私有权限与 exclusive flock 审计原位恢复；inode 未变。原版最小探针查明 image_path_unavailable，close Quarantined；PID 564 企业微信 IPCHelper 的 proc_pidpath 返回 ENOENT。已安装 browser-preflight 补丁及 canonical parent 修复，候选/安装 SDK/安装工具三次均 no-input 拒绝并 clean close，最终 C04fb。2 native、4 browser-tool、9 package 测试通过；desktop 124 pass/1 skip；UniFFI check、npm run check 通过。材料/原包备份 /tmp/epi-repair.BJD4uG。
- Continuation evidence: 用户授权后 launchctl stop/start 精确 helper 标签，PID 564→64621，catalog 失败数 1→0。原生 prepare/close 成功 C04fc；真实 gpt-6-sol 表单、对话框、导航三个独立 owner 均 prepare/close 成功，最终 C04ff。表单首字段 DOM value_readback confirmed；业务任务 0/3，失败归 T-009/provider，不冒充完整 E2E 通过。未强杀、删数据或再清锁。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 浏览器动作契约与错误恢复

- Status: done
- Owner: coordinator
- Objective: 区分无效后条件与真实旧引用，减少 agent 无效 observe 循环，并验证批量输入的引用选择。
- Inputs and prerequisites: T-008 完成；/tmp/epi-repair.BJD4uG/model-after-helper 与 model-browser-neighbors。
- Scope or files: native/computer/controlled/tool.ts、browser/tool.ts、相关契约/回归及真实模型 fixture。
- Expected output: 明确不重放输入的错误分类与可执行动作契约；同一业务 oracle 的复测。
- Dependencies: T-008.
- Execution steps:
  1. 将现有 trace 转为离线回归，定位未观察到的 press.expect 被统一报 stale_observation 的分支。
  2. 保留已观察目标授权，区分不支持的后条件；明确 mutation 后 ref 与 selector 的行为，不擅自取消检查。
  3. 串行复测相同模型任务，保留 provider 失败和全部业务失败。
- Acceptance criteria:
  - 错误分类可指导有效恢复；不能隐藏真实旧引用、重复投递或未观察目标；业务结果和关闭分别验证。
- Verification method:
  - 定向回归、模型 trace、独立 oracle、npm run check。
- Validation evidence: 已安装桥接修复：现有 native startClick 通过当前 observation/token 和实际 provider context 授权；仅报 action_submitted、不冒充业务成功；拒绝/部分效果分类与消费引用均有回归。错误后条件报 postcondition_not_observed，mutation 后 ref 报 batch_ref_after_mutation，均在整个 batch 派发前拒绝。三个候选模型任务 1/3，导航 PASS 41.796s；最终包导航再次 PASS 40.844s/13回合，独立回执准确，关闭成功。表单双字段批量 confirmed 后遇到下拉菜单 action_unavailable；弹窗点击后遇到 unexpected_modal_surface，属 T-010。browser 9/9、context/desktop schema 8/8、desktop+context 129 pass/1 skip、package 9/9、独立 desktop typecheck、npm run check 通过。证据 /tmp/epi-contract.fIKCCx，原包保留 installed-before；native SDK 未变。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 浏览器弹窗与下拉菜单能力

- Status: done
- Owner: coordinator
- Objective: 定义并实现受当前页面授权约束的 HTML dialog 与 select 操作，不能简单删除 modal 检查。
- Inputs and prerequisites: T-009 真实失败轨迹；原生受控页面/输入能力。
- Scope or files: 原生 browser controlled page 与动作契约、相关 fixture。
- Expected output: 明确支持边界、负向回归及同一表单/弹窗 oracle 通过。
- Dependencies: T-009.
- Execution steps:
  1. 区分 HTML dialog、浏览器原生提示、跨 frame/跨页弹窗，明确允许的目标范围。
  2. 增加基于当前观察的选项选择操作与类型提示，不把 fill 冒充 select。
  3. 真实模型与越界/遮挡负向回归，保留失败证据。
- Acceptance criteria:
  - 指定选项和弹窗提交独立回执准确；未知/跨页模态目标仍拒绝；正常关闭。
- Verification method:
  - 原生与桥接定向测试、同三任务真实模型、源码材料和安装包资格。
- Validation evidence: 受限 HTML dialog 已实现并安装；11 原生 page、21 CDP、129 desktop/context（原 skip 的 renderer-value 另行 1/1）、9 package、UniFFI、独立 native TS 与 npm run check 通过。真实 Chrome 最终 11/11：Unicode 填充/提交准确；弹窗外、ARIA、多弹窗、跨 frame、观察后出现/移出/关闭/替换/第二弹窗及已打开原生 alert 拒绝且零误输入；全部正常关闭。真实模型 dialog PASS 37.640s/11 回合、navigation PASS 37.580s/13 回合，独立回执/可见回执均准确；费用 0.0702204 USD，均关闭，C0531。证据 /tmp/epi-dialog.UEensN/{qualified-stable-guards,model}。不以两个样本宣称速度统计提升。
- Additional validation evidence: select_option 已实现并安装，SDK fd2ecf68deac2277f1213adeaa637935561f61a550868a473934da89bbec7aba。15 select guard、11 dialog 邻域均通过且正常关闭；12 page、21 CDP、10 browser、131 desktop/context（1 skip）、9 package、UniFFI、native TS、npm check 通过。同三任务真实模型 3/3，form 37.851s/10 回合、dialog 35.092s/10 回合、navigation 38.503s/12 回合，零失败工具调用，独立/可见回执准确，费用 0.105892 USD，最终 C054e。证据 /tmp/epi-select.l1vU6w，旧包保留 installed-before；不是速度 A/B。
- Remaining work: 加载期自动 alert 的导航等待残留单独交由 T-011；select 不支持 multiple 或自定义 ARIA widget，不宣称全场景支持。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 导航期间原生提示的有界结束

- Status: done
- Owner: coordinator
- Objective: 定位页面加载时 alert 使导航等待到 watchdog 的首个阻塞点，修复有界结束而不自动接受提示或重放导航。
- Inputs and prerequisites: T-010 保留的 qualified-guards/native-alert 失败；同一 CfT、原生 CDP 与关闭证明。
- Scope or files: 原生 browser page/CDP 调用及专用导航 fixture。
- Expected output: 可重复触发、明确错误与原生 terminal/close 证明，以及正常导航邻域回归。
- Dependencies: T-010.
- Execution steps:
  1. 将加载时 alert 与稳定页面 alert 分开，测量 Page.navigate 和后续 attestation 的首次阻塞。
  2. 使用固定 CDP 事件与已提交输入事实设计安全的有界结束，不伪造 drain、不自动 dismiss。
  3. 相同输入复测、取消与正常导航回归，保留所有失败。
- Acceptance criteria:
  - 已出现原生提示时不会无意义等待完整导航时限；无输入重放和静默接受提示；关闭可证明。
- Verification method:
  - 原生定向回归、实际 Chrome 多次延迟触发对照、npm check 与安装包资格。
- Validation evidence: 方法级诊断证实 Page.navigate 6–10ms 返回，随后 Page.getFrameTree 在提示已出现时阻塞至 20s；0/10ms 触发复现 20.198/20.351s，候选同输入 344/357ms 明确拒绝，全部关闭。最终无诊断构建 7/7 加载期 guard、38 CDP、12 page、131 desktop/context + renderer-value 1/1、8 package、UniFFI/native TS/npm check 通过。select 邻域两批 27/30，三次 prepare endpoint 失败归 T-012，保留原始失败。环境恢复后 dialog 邻域 11/11；安装后同三任务真实模型 3/3（35.490/34.477/40.986s，10/10/13 回合），导航一次 stale_observation 正确拒绝后刷新完成。费用 0.1221164 USD，均关闭。安装后加载期 guard 再次 7/7，导航 35–56ms，未取消或自动接受提示，均正常关闭。证据 /tmp/epi-nav-alert.zrMLcZ 与 /tmp/epi-nav-final.VvOeIZ/{model-unlocked,guards-installed}。未承诺普遍速度提升，T-012 独立残留不隐藏。
- Blocker: None.
- Unblock condition: None.

### [ ] T-012 — Chrome 启动端点偶发拒绝

- Status: in_progress
- Owner: coordinator
- Objective: 定位受控冷启动时 browser_endpoint_unproved 的首次分歧，避免把尚未完成的端点发布误判为永久损坏。
- Inputs and prerequisites: T-011 select 邻域首批 disabled-select 的 prepare 失败，未进入导航或输入，native close 成功。
- Scope or files: 原生 controlled_browser read_endpoint、启动等待与定向 fixture。
- Expected output: 端点元数据/读取阶段的最小诊断、可复现原因、必要修复及冷启动回归。
- Dependencies: T-010.
- Execution steps:
  1. 保留原始失败；记录文件类型、长度、读取阶段等非敏感事实，区分不完整发布和不安全文件。
  2. 证明因果后修复读取/就绪机制，保留路径、所有权、链接和完整格式校验。
  3. 多次冷启动、取消与正常关闭回归，不自动重启失败 owner。
- Acceptance criteria:
  - 已证明的发布竞态不导致无效冷启动失败；不安全/完整但无效文件仍拒绝，关闭可证明。
- Verification method:
  - 定向原生测试、真实 Chrome 冷启动、原始失败与修复后相同条件对照。
- Validation evidence: 两批 30 场景中三次准备阶段 browser_endpoint_unproved（首批 disabled-select，第二批 label-changed/removed），全部关闭证明；其余 27 次场景断言通过。当前不能断言是文件半写竞态。证据 /tmp/epi-nav-final.VvOeIZ/{select-guards,select-guards-repeat}/trace.jsonl。coordinator 下一步在 /tmp/epi-endpoint.kJSkkp 独立诊断构建记录端点长度/格式阶段；T-011 最终构建材料保留且未安装，避免混入诊断改动。
- Blocker: None.
- Unblock condition: None.

### [ ] T-013 — 动作与新观察合并的端到端提速实验

- Status: in_progress
- Owner: coordinator
- Objective: 减少不必要的模型往返，保留动作 terminal、输入效果分类和实际 provider view 的新引用授权。
- Inputs and prerequisites: select 安装版同三任务原始 trace；form/dialog/navigation 各 4/4/5 个动作后独立 observe 往返，模型阶段约占 task 80%–92%。
- Scope or files: native/computer/browser 与 controlled 桥接、真实模型测量 fixture；不同时修改原生权限或焦点策略。
- Expected output: 可选择的动作后新观察、取消/读取失败回归，以及同任务交错模型 A/B。
- Dependencies: T-011.
- Execution steps:
  1. 记录同模型、同任务、同原生包的动作/观察次数、模型/工具/准备耗时和费用基线。
  2. 在原生动作已 terminal 后取得新观察；读取失败必须保留已提交事实，不能诱导重放。
  3. 独立进程交错 A/B，比较正确回执、往返数、总延迟、成本、取消与关闭；收益未超过噪声则不发布性能结论。
- Acceptance criteria:
  - 不降低动作/回执正确性及取消关闭证明；同任务往返减少，并有端到端收益证据。
- Verification method:
  - 桥接假 native 时序/上下文测试，确定性实际 Chrome fixture，真实模型交错对照。
- Validation evidence: 可选 browser-only observeAfter 已实现并试装。17 browser 契约/工具、9 context（包含在 133 desktop/context pass + 1 skip）、native TS/npm check；真实 Chrome 候选和安装 5-call Unicode/select/save 通过并关闭。A1/B1/A2/B2 同指纹交错筛查 12/12，通过独立 oracle；A/B 总模型回合 65→38，费用 0.2303368→0.1668468 USD，总时间 241.087→210.493s。B1 dialog 62.830s 慢样本保留，模型阶段 59.790s；样本不足以证明稳定耗时收益，任务保持 in_progress。证据 /tmp/epi-observe-after.MCxmC4，原包 installed-before；coordinator 下一步扩展独立样本并分析模型阶段波动。启动故障仍属 T-012，未删除校验/忽略失败。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — 当前宿主进程路径失效后的 GUI 恢复

- Status: done
- Owner: coordinator
- Objective: 恢复可读取的本机进程目录，再继续 Chrome 安装资格；不终止当前宿主或删除租约。
- Inputs and prerequisites: dialog-neighbors 的 11 次 prepare 拒绝，均 inputCommitted=false 且 close 成功。
- Scope or files: 只读进程检查与恢复后的真实 GUI 验证；宿主重启需用户操作。
- Expected output: 进程路径恢复证据与同一候选包邻域测试。
- Dependencies: T-010.
- Execution steps:
  1. 检查 proc_pidpath、PID/父进程与可执行路径，区分当前环境问题和导航修复。
  2. 用户正常退出并重新启动对应 Codex 会话后，先重新检查进程目录与租约，再运行 GUI。
- Acceptance criteria:
  - 进程目录可读，未强杀无关应用或绕过检查，真实动作和关闭均有证据。
- Verification method:
  - /tmp/epi-repair.BJD4uG/catalog、ps、dialog-guards 和真实模型 oracle。
- Validation evidence: 本轮 PID 82295/82296/82303 的 proc_pidpath 均 ENOENT；ps 指向 ChatGPT.app 内 cua_node 的 node/node_repl，前两者 PPID 62746（/opt/homebrew/bin/codex），后者 PPID 82295。磁盘同名文件存在，不证明运行中 image 仍可解析。11 次拒绝在约 86–100ms 返回，全部关闭，最终 C05d3，lsof 无租约持有者。/tmp/epi-nav-final.VvOeIZ/dialog-neighbors 保留全部失败。未认定原因一定为应用升级。
- Additional validation evidence: 后续只读检查 PID 2204/2162 已退出、目录 failed=0/515；本任务未关闭个人 Chrome。冻结 T-011 SDK 的 dialog-neighbors-recovered 11/11 通过，真实 Unicode 提交及保护拒绝均准确，全部关闭，C05f7；8/8 package 验证通过。原失败批次保留，不混入成功分布。
- Blocker: None.
- Unblock condition: None.

### [ ] T-015 — 浏览器观察截断后的可恢复读取

- Status: in_progress
- Owner: coordinator
- Objective: 页面正文不被空结构节点挤出，并使超预算页面可通过有界读取获得剩余相关内容，不授予未展示目标引用。
- Inputs and prerequisites: MiniWoB click-tab-2 的原始失败和当前投影重跑记录。
- Scope or files: native/computer/controlled/tool.ts、browser 协议、回归测试与真实 Chrome fixture；不修改密码保护或原生点击权限。
- Expected output: 有界且可恢复的页面观察，原任务复测和独立能力限制记录。
- Dependencies: T-013.
- Execution steps:
  1. 复现空结构节点挤占 4 KiB 正文的失败，优先保留动作和非空信息。
  2. 分开验证投影截断与非语义 span 缺少点击能力；设计截断后的有界检索，不重复相同观察空转。
  3. 验证未展示引用、唯一性计数、实际 provider context、取消及真实模型邻域。
- Acceptance criteria:
  - 超预算页面存在可恢复读取路径，未展示目标不能授权输入；原任务的剩余能力缺口有精确证据，不将局部文本改善记为任务通过。
- Verification method:
  - 合成观察回归、上下文契约、真实 MiniWoB 和 Chrome 独立 oracle。
- Validation evidence: 第一阶段回归原版 14 pass/1 fail（正文丢失），候选 browser/contracts 18/18；context/projection 12/12，native TS、npm check、package 8/8。真实五调用 Unicode/select/save 成功并关闭 C0628。试装后 click-tab-2 仍失败：40.999s、7 回合、0.0326516 USD、cleanup=true；正文片段恢复但目标未展示，仍需可恢复读取。证据 /tmp/epi-observe-after.MCxmC4/{projection-qualification,model-projection,package-projection}；旧安装包 installed-before-projection。历史 controlled 测试两次均 SDK 指纹拒绝，未计为通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-016 — 受限普通 HTML 点击处理器支持

- Status: in_progress
- Owner: coordinator
- Objective: 支持当前受控页面有直接 click 处理器的普通 HTML 元素，保持目标身份、弹窗范围、取消与未知效果不重放。
- Inputs and prerequisites: 用户明确批准；model-search 已找到 Tempor 但原生 browser_input_unavailable；独立 CfT AX/CDP 采样表明处理器属于 generic SPAN/DIV，非其 StaticText。
- Scope or files: browser-listener-click.patch、listener-guards.mjs、原生构建及匹配材料；不操作个人浏览器，不开放任意脚本或跨 frame。
- Expected output: 正向业务点击、负向零点击、可复现补丁/二进制和真实模型资格。
- Dependencies: T-015.
- Execution steps:
  1. 证明 AX generic 父元素与可见直系文本及直接 click 处理器的关系；不在输入时重定向文字引用。
  2. 原生观察/输入前读取深度零的事件处理器，固定输入函数重验文档、弹窗、可见性、禁用和精确 DOM 对象。
  3. 原始失败、负例、select/dialog/navigation 邻域、模型 click-tab-2 和构建材料一致性验收后再安装。
- Acceptance criteria:
  - 独立计数正向恰好一次点击、负向零点击；原模型任务独立奖励通过；所有原生关闭及权限边界保持。
- Verification method:
  - Rust 定向单测、真实 listener-guards、原有邻域及真实模型 raw reward。
- Validation evidence: 父元素标注回归先失败（空标签 != Tempor）；候选 13 page、24 controlled CDP 通过。原 SDK span guard 按能力缺失失败并关闭；初版候选 11/11，随后新增 visibility:hidden 负例发现默认 checkVisibility 未检查 CSS visibility/opacity，保留 visibility-before 失败。显式开启两项后最终 13/13，包括 span/div/dialog、无处理器、其他事件、移除处理器/节点、display/visibility/opacity 隐藏、inert/aria-disabled/dialog 外；正向恰好一次、负向零点击、全部关闭。当前只支持具可见 AX 名称或直系文本的 SPAN/DIV 直接 click 监听，不支持事件委托或任意祖先回退。
- Qualification evidence: 最终 SDK 08b4fdbdb39b0322ffb7529c8a06ed8b87d88962b8c652bea1c79b8d081f3575；独立补丁 apply/四源文件完全一致/reverse 通过。139 desktop/context pass、一个 renderer skip 单独启用后 1/1、8 package、native TS、npm run check 通过；恢复四个无关格式变化。最终 dialog 11/11、加载期 alert 7/7、select 15/15，全关闭。证据 /tmp/epi-click-handler.mz5oXh/{listeners-final,dialog-final,navigation-final,select-final,sdk-final2,materials2,patch-verification-v2}。确认 clean C0677 后可回退安装，原包保留 installed-before；真实模型验收 model-installed 进行中，不把候选通过等同模型或普遍性能提升。
- Installed model evidence: 2026-09-25，gpt-6-sol 四任务独立 oracle 4/4、正常关闭 4/4；click-tab-2 rawReward=1，42.856s/11 回合；form 23.483s/6 回合、dialog 22.114s/6 回合、navigation 28.033s/7 回合；费用合计 0.1353116 USD，最终 C067b。保留 click-tab-2 的 stale_observation 拒绝及最终 press condition_unknown：业务点击已成功，但模型错用值后置条件，最终只报告未能确认。不能将 oracle 通过称为零工具错误或完整可见验证。下一轮改进点击/press 契约提示，保持 unknown 不重放及错误后不自动读取边界；不以此单轮声称普遍提速。证据 /tmp/epi-click-handler.mz5oXh/model-installed。
- Installed smoke evidence: installed-smoke 六次实际工具调用，Unicode 填充/select/save/筛选回执独立与可见结果均通过，正常关闭 C067c。点击能力与原始任务 oracle 已通过；任务仍 in_progress，继续处理模型动作选择及可见验证，依赖 T-015/T-013 尚未整体关闭。
- Action guidance evidence: 工具描述明确 generic 元素激活使用 click，press.value 是目标控件结果值而非标签。原生、权限、unknown 与错误后读取规则未变。model-action-guidance 同四任务 4/4，零工具错误且全部关闭 C0680；click-tab-2 28.683s/7 回合并读回奖励，form 24.756s/6、dialog 23.217s/6、navigation 25.863s/7；总费用 0.1226096 USD。这是顺序单样本对照，不宣称稳定速度优势。21 browser 契约/工具、15 context、8 package、native TS、根 check 通过；初次两套测试 SDK 路径误配分别在缺 index.js/computer.js 时加载失败，改用各自匹配输入后通过，未计为产品输入故障。package-action-guidance 已可回退安装，旧包 installed-before-action-guidance。接续换 seed 7/99 检查固定种子以外表现。
- Seed variation evidence: model-seed7 与 model-seed99 的 click-tab-2 均 rawReward=1、零工具错误并正常关闭；14.341s/4 回合/0.0158916 USD 与 18.324s/4 回合/0.0146784 USD，最后 C0682。加 seed 42 共三个固定种子通过，不推断任意页面覆盖率。继续 model-general-neighbors 六个不同机制任务，不将已知未实现的 drag/password/tab 排除后称全量 benchmark。
- Blocker: None.
- Unblock condition: None.

### [ ] T-017 — 滚动场景真实能力与验收

- Status: in_progress
- Owner: coordinator
- Objective: 长页面任务确实发生滚动且点击时目标位于视口内，不把 DOM 远程激活冒充滚动能力。
- Inputs and prerequisites: model-general-neighbors 的旧 oracle 通过与 model-scroll-qualified 的明确反证；受控独立页面，保留全部失败。
- Scope or files: real-model/tasks.mjs、tasks.test.mjs；后续固定受控页面滚动协议及原生实现，不开放任意脚本、个人浏览器、跨 frame 或未知输入重放。
- Expected output: 无假阳性的独立 oracle，以及真实滚动/可见目标操作和取消邻域证明。
- Dependencies: T-016.
- Execution steps:
  1. 用无滚动但 button clicked 的反例证明旧 oracle 误报，并记录实际点击时的视口状态。
  2. 设计有界滚动操作，维持新观察、目标/文档身份及 terminal/取消约束。
  3. 验证真实模型滚动、正反几何案例、弹窗/失效目标及关闭，不靠忽略失败获得分数。
- Acceptance criteria:
  - 原测试要求滚动和按钮入视口均获独立证据；未滚动/视口外点击必须失败，模型可见结果与 oracle 一致。
- Verification method:
  - 原 oracle 反例 red/green、实际 handler 几何测试、真实模型及 native close。
- Validation evidence: 旧反例 true != false 失败；新增 scrollY>0 与完整垂直视口包含记录，13 benchmark/lifecycle/metrics 测试及根 check 通过。model-scroll-qualified 使用已安装 3f07a721f 行为，20.557s/4 回合/0.0117948 USD，返回 bottom=true/scrolled=false/targetVisible=false，正确 FAIL；模型如实报告不足，正常关闭 C0689。仅评估误报已修复，滚动能力尚未实现/验证。
- Candidate checkpoint: /tmp/epi-browser-scroll.1dusJS 保存原文件与 primitive probe；authoring rust 仍在 /tmp/epi-optimize.vOX6Su/candidate/rust。已增加固定 DomScrollIntoViewChecked 原语、页面 token/DOM/dialog 路由及独立 SDK start_scroll_into_view 入口；非原生窗口 fallback。24 CDP、14 page、3 SDK scroll 定向测试通过；原有 unsafe/dead_code/linker 警告保留。独立 CfT literal probe 9/9，页面/弹窗真实滚动，其他文档、移除、隐藏、透明、inert、secure、弹窗外均拒绝且零滚动/点击/输入；正常关闭。初次 probe dialog 已被 showModal 自动聚焦滚动而断言失败；后续记录 initialDialogScroll=1521.5 并显式重置后测得实际原语滚动，不掩盖测试前置条件。该 probe 不是 SDK 端到端；原生 scope 新路由先红，修复后复测中。
- Historical remaining implementation: 此检查点的 schema/context/grants、benchmark manifest、原生 guard、补丁与安装待办已在下方 installed evidence 中完成；保留原始失败与分层验证边界，不将 prototype 或传输单测称作产品可用。
- Additional candidate evidence: scope attestation 回归 red→green；新增 browser_scroll_into_view 仅允许原生受控浏览器路由与 opaque target/tab/element_token，原生窗口、未 attested 或 script/endpoint/pid 注入仍拒绝。已补 canonical R2/active browser_bound_input 分类，44 authorization/session-authorization 定向测试通过。九个 authoring Rust 文件已格式化，恢复 scope 中一处无关格式差异。剩余核心接线是能力 token、runtime registry、生成绑定及 TS；新代码未打包/安装，旧包可继续使用。
- Native wiring checkpoint: 2026-09-25 补齐 runtime 注册、独立 browser.input.scroll_into_view 能力及共享闭合 ActionResult 输出契约，合计 12 个 authoring Rust 文件。注册遗漏与输出 schema 遗漏均先获得失败测试，修复后 registry 1、capability 25、contract validator 1 通过。未改 legacy 动作推断，真实页面仍附原生 execution record，并将滚动提交标为 unverifiable，不声称业务完成。release/UniFFI Python+TS 生成、N-API staging、严格 computer TS 编译及仅加载不创建 host 的 binding-smoke 均通过；首次使用候选缺失的本地 tsc 路径失败，改用工作区现有编译器及显式 typeRoots 后通过，没有安装依赖。候选 SDK dylib SHA256 8f5fd2b42d02f7ab8f3ecf987216561dddfa684a54615293f01f6aedc4370a83，N-API 20ffed5caccef6c44eff6ef9d39c127d49d9783b16e4aa9f0be0dfa3ba887056；生成器 scratch 为 general/environment/tmp/cua-driver-uniffi-6wKmC9。/tmp/epi-browser-scroll.1dusJS/browser-scroll-candidate.patch 仅为未发布草稿。原 UBRN unused/linker 等警告保留，不算新增故障。根 check 通过并恢复四处无关格式变化；尚未运行新版本 GUI/agent，当前 installed 指纹未变。
- Bridge and guard evidence: 新 schema/adapter/context/grants 支持 scroll_into_view，与 click/select 一样消费唯一可见观察，另外要求原生 scroll capability；observeAfter 仅在原生 terminal 后读取，拒绝/未知/取消不自动读取或重放。新增 scroll-only 空容器挤占 4 KiB 文本视图的回归先红后绿，恢复可激活控件和有效文本优先级。native-guards2 九项加 native-dialog-after 一项真实 SDK 测试全部通过（页面、嵌套滚动、单弹窗、hidden/transparent/inert/移除节点、新弹窗、旧观察、preabort），正向几何改变，负向无实际滚动/点击/输入/焦点改变，全部关闭；部分 DOM 拒绝发生在 input admission 之后，不能写成零提交。此轮 24 browser、73 context/desktop/segment、3 AgentSession faux loop、8 qualified package 全通过，native TS 与根 check 通过，四个无关格式变化已恢复。桌面测试 helper 的旧精确二进制哈希导致首次加载失败，更新到新构建精确哈希后通过，没有放宽校验。
- Packaging and installed evidence: 十二文件补丁独立 apply/字节一致/reverse 通过，补丁 SHA256 387af39ff3de1bf539efdc04757597137092c0b560aa6460b86a4af3ed2f175e；匹配 sdk/materials/package 位于 /tmp/epi-browser-scroll.1dusJS。真实 bridge-scroll 七次调用验证 Unicode fill/select/scroll/click/visible receipt，独立 oracle scrolled=true 且 targetVisible=true；bridge-form 六次邻域通过，分别正常关闭 C069d/C069e。确认干净租约后可回退安装，原安装保留 installed-before。installed dylib 为 8f5fd2b，N-API 为 20ffed5，renderer 未变。
- Installed model evidence: model-scroll-installed 中 gpt-6-sol 四任务 4/4，零工具错误，全部正常关闭到 C06a2。chrome-scroll 20.648s/5 回合、form 23.118s/6、dialog 28.014s/6、navigation 27.855s/7；总费用 0.0880912 USD。滚动调用含新观察 79.521ms，独立 oracle bottom/scrolled/targetVisible 均 true，模型也读到可见回执。原 model-scroll-qualified 无滚动失败保留；修复不等同普遍速度提升。继续 model-general-installed 九项通用场景，包括尚未资格化的 drag/password/new-tab，不隐藏失败或称已完成官方全量 benchmark。
- General coverage evidence: model-general-installed 九项实际任务 6/9，全部正常关闭 C06ab，总费用 0.237352 USD。click-test-2 23.330s/4、enter-text 17.877s/5、checkboxes 19.922s/5、choose-list 17.151s/5、click-tab-2 28.517s/7、scroll-text 21.142s/5 均 rawReward=1 且零工具错误。drag-box 12.879s/3 因无拖拽能力失败；login-user 55.469s/14 因密码输入不支持失败，并有一次 action_unavailable；chrome-tabs 无独立 retained-tab oracle，保持未资格化 FAIL。官方 scroll-text 原任务只验最后单词，允许语义读取 textarea 全值，因此该 rawReward 不证明实际滚动，真实滚动仍由 chrome-scroll 与 SDK 几何 guard 单独证明。这是已定义的 13 项适配套件 10/13，不是官方全量总分。
- Diagnostic and capability guidance: 原生 stale_browser_observation 被桥接错误折叠为 native_fault，新增回归先红后绿；仅保留白名单原因，已提交失败仍 outcome_unknown，增加禁止重放说明，不自动读取/重试。25 browser、8 legacy controlled、40 adapter/terminal、54 context/desktop/segment、8 qualified package、native TS 和根 check 通过，恢复四处无关格式。另明确 password/file、drag、tab switching 不受当前 browser profile 支持，避免已知不支持动作的反复观察。package-guidance 可回退安装，上一包保留 installed-before-guidance。真实 model-capability-guidance 登录失败耗时 13.951s/3 回合、拖拽失败 10.866s/3、新标签页仍未资格化 3 回合，均诚实报告限制；普通滚动 19.114s/5 通过。四项全部关闭。仅单次顺序对照，失败仍计失败，不将更快退出冒充功能成功或稳定提速。
- Blocker: None.
- Unblock condition: None.

### [ ] T-018 — 浏览器观察展示冗余精简

- Status: in_progress
- Owner: coordinator
- Objective: 减少模型接收的重复观察文本，不牺牲唯一内容、动作、状态值和新引用边界。
- Inputs and prerequisites: T-017 已安装桥接及 model-scroll-installed/model-general-installed 原始观察；Chrome 样本展示层重复与空结构约占行文本 22%–37%，只作潜力估算。
- Scope or files: controlled/tool.ts 浏览器展示投影、browser/tool.ts 合并元数据、browser/test/tool.test.ts；不改原生观察、授权、SDK、个人应用或原始会话记录。
- Expected output: 展示冗余精简、反例测试、同任务真实输出字节对照及真实模型邻域。
- Dependencies: T-013.
- Execution steps:
  1. 用真实 trace 区分纯展示副本与有意义信息，固定可省略条件。
  2. 仅省略 enabled=false 且无文本/值/动作的 none 行，或当前输出已完整包含对应 StaticText 的无值无动作 InlineTextBox。过滤或预算丢弃的文字不能充当已展示依据。
  3. 保留过滤前 selector 歧义计数；省略引用无输入授权；测试后独立打包与确定性 fixture，再模型复测。
- Acceptance criteria:
  - 同 fixture 完成相同业务结果和关闭，观察文本减少；模型成功率不下降，实测延迟与费用单独报告，不从字节减少推导稳定提速。
- Verification method:
  - 反例单测、provider context 与 legacy native 邻域、实际 Chrome 回执与原始输出、真实模型固定任务。
- Validation evidence: 精简预期先红后绿；28 browser 测试通过，覆盖唯一文本/值/动作保留、预算未展示副本保留、重复 selector 不变唯一、丢弃引用拒绝、合并新观察计数与操作。54 context/desktop/segment、native TS、8 qualified package、根 check 通过。bridge-form 与 bridge-form-compact 相同六调用及独立回执，文本 15752→12010 字节（-23.8%）；scroll 七调用 20110→15026（-25.3%），实际滚动/可见目标回执相同；关闭 C06b0/C06b1。证据 /tmp/epi-browser-scroll.1dusJS；package-compact 可回退安装，旧包 installed-before-compact。model-compact-installed 五任务验证进行中；尚未将文本缩减声称模型延迟收益。
- Installed model evidence: model-compact-installed 五项 5/5、零工具错误、正常关闭到 C06b6；scroll 18.733s/5、form 22.602s/6、dialog 24.131s/6、navigation 24.424s/7、click-tab-2 33.335s/11，总费用 0.128878 USD。click-tab-2 相较早先 7 回合出现额外搜索，初始可见动作/任务文字对照未丢失；早先样本还缺少能力限制提示，不能直接归因精简。随后冻结同一提示词/原生/seed，model-compact-control-tab 未精简 33.677s/9/0.0545032 USD，model-compact-repeat-tab 精简 33.586s/9/0.0454156 USD；均 rawReward=1、零工具错误、关闭。仅小样本顺序对照，不声称显著延迟改善。最终恢复精简安装，bridge SHA256 a8208f8e0164eded0a4bc5c5f7fc8b555b1a58e1433b4d861490ab3de2c811cc；保留原包和全部样本，后续继续模型往返与状态信息优化。
- Blocker: None.
- Unblock condition: None.

### [ ] T-019 — 页内选中状态观察链路

- Status: in_progress
- Owner: coordinator
- Objective: 保留 Chrome AX 已报告的 selected 布尔状态，区分 false 与未知，供模型验证页内标签和选项切换。
- Inputs and prerequisites: T-018 同提示词 click-tab-2 对照与现有 WindowElement.selected 契约；额外搜索回合的原因尚未证明。
- Scope or files: 原生 page.rs/test 与增量补丁、controlled/tool.ts 浏览器展示、browser 测试和独立 fixture；不改变输入权限、值后条件或浏览器标签页能力。
- Expected output: 原始 AX/SDK/桥接首个丢失边界证据、最小修复及新观察读回；独立报告模型收益。
- Dependencies: T-013.
- Execution steps:
  1. 在自有页面对照原始 AX 与现有安装观察，确认状态丢失，先建立失败回归。
  2. 仅传播合法布尔值，secure/ignored 不泄漏，展示精简不得删除状态行。
  3. 原生与桥接回归、独立包资格、真实页内标签/选项切换及同模型任务复测。
- Acceptance criteria:
  - 已知 true/false 正确保留、未知不伪造；点击后新引用与独立业务回执一致，负例边界不变。
- Verification method:
  - AX/SDK/bridge 分层反例、定向单测、真实 GUI 与关闭、固定 seed 模型对照。
- Validation evidence: /tmp/epi-selection.avjmjg/baseline 原始 AX true/false，旧安装 undefined!=true 失败且正常关闭 C06b9。原生和桥接分别 red→green，15 page、29 browser、8 legacy、54 context/desktop/segment、8 qualified package、严格 SDK/native TS 和根 check 通过。新增二文件增量补丁独立 apply/字节一致/reverse 通过，生成绑定/构建材料/精确 pins 已更新。candidate 四调用实际标签与 option 切换，true/false/未知及独立 clicks=1/Plan=Pro 回执一致，关闭 C06ba；scroll-neighbor 七调用 Unicode/select/真实滚动/save 通过，关闭 C06bb。此为状态丢失因果证明，不证明多余模型回合的原因。旧包保留 installed-before，已可回退试装；model-installed 三项 2/3，详细失败进入 T-020。48d3091c8 提交状态投影修复；T-019 保持 in_progress，T-013 依赖和整体模型迭代未结束。
- Blocker: None.
- Unblock condition: None.

### [ ] T-020 — 阻止无值后条件的 press 派发

- Status: in_progress
- Owner: coordinator
- Objective: 模型误把 selected 当 value 时，整个无效 batch 在输入前拒绝，不产生已派发后的 condition_unknown。
- Inputs and prerequisites: T-019 model-installed 捕获实际 press expect=tab/value=true，而观察仅有 selected、没有 value；当前桥接只校验 selector 可见。
- Scope or files: controlled/tool.ts 可见值后条件集合与 browser/tool 测试；不把 selected 映射为 value，不改变原生动作、未知输入不重放或允许动态未观察控件。
- Expected output: 无效后条件零派发回归、保持空字符串等合法值后条件及修复后模型实测。
- Dependencies: T-019.
- Execution steps:
  1. 重放缺失 value 的可见 tab 后条件，获得预检缺失的失败测试。
  2. 在实际展示视图记录具有 value 的唯一 selector，press 仅引用该集合，继续整体预检。
  3. 定向回归、包资格、真实模型重测；另跟踪 role=tab 容器点击未触发内层链接的问题，不混淆两个原因。
- Acceptance criteria:
  - 无 value、仅 selected 或未展示后条件均零派发；有 value（包括空串）的合法计划及引用消费不变。
- Verification method:
  - 失败 trace 对应 red/green、定向 tool/context 测试、同 seed 模型与独立任务回执。
- Validation evidence: T-019 三项模型 2/3，form 23.246s/6、dialog 21.314s/6 通过；click-tab-2 27.081s/7 失败，press 条件 unknown 后模型停止，未获任务回执。全部关闭到 C06be，总费用 0.0674452 USD；不声称提速。状态投影本身经实际业务 fixture 证明修复；此新动作契约缺陷待修复。
- Repair evidence: 缺值后条件包含在第二步的整批预检先红后绿，前置 fill 也不派发；true/false selected 与合法空串值分别覆盖。改为从实际展示且唯一的 selector 中单独记录 valueSelectors，不将 selected 映射为 value。31 browser、8 legacy、54 context/desktop/segment、8 qualified package、native TS 与根 check 通过，四个无关格式变化精确恢复。postcondition 实际六调用场景拒绝无效 press 后独立 clicks=0，刷新后点击/选择完成且 clicks=1，关闭 C06bf。package-postcondition 试装，旧选择状态版保留 installed-before-postcondition，原生二进制未再变化。
- Model follow-up: model-postcondition 同 seed click-tab-2 PASS，24.652s/7 回合/0.028676 USD、rawReward=1、零工具错误、关闭 C06c0。模型本次未调用 press，不能把成功归因于预检修复；仍先点击 role=tab 容器无变化，继而点击其独立 link 成功。下一轮隔离该无效果点击的原生能力声明与 DOM 事件目标，保留真实失败，不自动重放未知输入。任务状态校验发现 T-019 依赖未结束而误标 done，已纠正为 in_progress，文档校验通过。
- Blocker: None.
- Unblock condition: None.

### [ ] T-021 — 标签容器与实际激活目标

- Status: in_progress
- Owner: coordinator
- Objective: 消除模型选择页内标签容器造成的无效果点击，同时保持直接处理器和委托处理器的正常控件能力与精确目标身份。
- Inputs and prerequisites: model-postcondition 先点击 tab:29 无变化，再点击 link:44 切换成功的原始轨迹；当前原生 role=tab 直接对该 DOM 对象调用 click。
- Scope or files: browser 观察/动作契约、原生 page 与受控 fixture；不自动将已授权引用重定向到未观察子节点，不删除正常控件能力。
- Expected output: 容器/链接/直接控件/委托控件差异证据，因果修复和真实模型回归。
- Dependencies: T-019.
- Execution steps:
  1. 用同版 jQuery UI 复现，记录 AX 层级、具体 DOM 对象、处理器与实际选中结果。
  2. 比较能力声明修正、明确观察关系等方案，避免以普遍拒绝代替通用性。
  3. 原生/桥接反例、实际控件与模型固定任务验证，独立报告速度与失败。
- Acceptance criteria:
  - 模型能直接选择实际激活目标；已有直接和委托标签控件不退化；引用、权限、unknown 不重放保持。
- Verification method:
  - 最小确定性页面、原始事件/状态、独立业务回执、定向回归和真实模型。
- Validation evidence: /tmp/epi-tab-target.TnC456/probe.mjs 使用同版 jQuery UI：LI 容器仅 keydown/mouseover 等监听，A 链接有 click；精确点击 LI 事件 target=second 但选中不变，点击 A 切换，直接 BUTTON 和父级委托 DIV 也可切换。不能按无直接 handler 禁用所有 tab。桥接仅将原生 parentIndex 对应的直接 tab 父节点 label/selected 附于 link.tab，无父 ref、无额外输入授权，不改原生库。单测关系缺失先红后绿；32 browser、8 legacy、54 context/desktop/segment、8 package、native TS、根 check 通过，四个无关格式修改恢复。
- GUI and model evidence: 无样式页面两次观察拒绝独立归 T-022，不从记录删除。加与原 benchmark 一致样式后，bridge-styled-before 因缺 tab 元数据失败且关闭 C06c3；bridge-styled-after 五调用，独立回执 clicks=[link,direct,delegated]，三类状态全 true，关闭 C06c4。候选可回退安装，旧包 installed-before，bridge 3561ba0935a93578fc3679280de37db3ad7f0e20524b4b07c614cfe76e3f0977，SDK 不变。model-installed 三项 3/3，click-tab-2 29.588s/8、form 23.400s/6、dialog 21.466s/6，全部零工具错误且关闭；费用共 0.0940736 USD。模型直接点击 Tab #2/#3 的 link，没有容器空点击，但多了两次搜索/刷新，较上一 24.652s/7 单样本更慢，不能宣称提速。下一步优先 T-022 的可复现整页拒绝，不以部分改进宣布全局完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-022 — Chrome AX 完全相同重复记录

- Status: done
- Owner: coordinator
- Objective: 正常列表页面不因 Chrome 返回完全相同的重复 AX 记录而整体拒绝，同时继续拒绝同 ID 冲突、多父节点、跨 frame 和超预算图。
- Inputs and prerequisites: /tmp/epi-tab-target.TnC456/raw-ax2.json 包含两个重复 InlineTextBox ID，逐字段完全一致；旧包和 T-021 候选均 browser_observation_unproved 并正常关闭。
- Scope or files: 原生 ax_snapshot、定向回归、增量补丁及真实普通列表页面；不合并内容不同的同 ID 节点，不放松原始输入大小和目标身份校验。
- Expected output: 原始快照回放的 red/green、相同记录规范化、冲突/边界负例、真实 SDK 和工具观察资格。
- Dependencies: T-011.
- Execution steps:
  1. 将真实原始重复图转成稳定原生回归，确认首个拒绝分支。
  2. 只对完整记录相等的重复 ID 做表示规范化，再执行原有图与目标校验。
  3. 反例、实际无样式列表页面、模型与安装材料资格，保留最初两个失败。
- Acceptance criteria:
  - 相同重复不丢内容或改目标；冲突重复仍拒绝，原始总量限制不变，真实输入/读回/关闭一致。
- Verification method:
  - captured AX 回放、native graph 单测、确定性 GUI 与包验证。
- Validation evidence: raw probe2 单根且无重复父关系，但 -1000000003/-1000000006 各出现两次且 JSON 完全相同；对应列表圆点 InlineTextBox。原生回放先失败后通过，新增重复文本预算负例再次先失败后通过；18 项 page 测试通过。仅在入口合并完整 JSON 相同记录，原始条数及重复文本仍计入预算，冲突/图/目标校验保留，无新增重试或状态机。增量补丁双文件正向应用、逐字节比对、反向恢复通过。证据 /tmp/epi-ax-duplicates.hu0bQg：同一个 ax-list-duplicates.mjs，gui-before 原包仍 observation_unproved、关闭 C06c8；gui-after 候选 5 调用，独立回执 clicks=[link,direct,delegated] 且三状态 true、关闭 C06c9。严格 native TS、32 browser、54 context/desktop、8 qualified package 和根 check 通过。候选已构建暂存，尚未安装或运行候选真实模型，不能宣称端到端提速。
- Blocker: None.
- Unblock condition: None.

- Installed qualification: selection-after 六调用通过，拒绝错误值后置条件且未误点，最终 Second=true、Plan=Pro、clicks=1，关闭 C06ca。候选可回退安装，旧包位于 /tmp/epi-ax-duplicates.hu0bQg/installed-before。安装后 gpt-6-sol 三项真实模型 3/3、零工具错误、全部正常关闭：click-tab-2 23.914s/6 回合，form 21.775s/6，dialog 20.851s/6，总费用 0.0765388 USD，最终 C06cd。该模型组是邻近回归，未直接覆盖无样式列表；新增缺陷的实际操作覆盖来自 gui-before/after 对照。根 check 再次通过并恢复其四处无关格式变化。较前轮少回合不能单样本归因为原生提速；全局 Goal 继续。

### [x] T-023 — 合并浏览器启动的模型往返

- Status: done
- Owner: coordinator
- Objective: 通过已有 prepare 的可选 URL 和 observeAfter，省去已知目标 URL 时单独 navigate 的模型往返，不添加动作类型或常驻状态。
- Inputs and prerequisites: T-022 安装后模型三项全通过；模型时间占 86.0%–87.1%，prepare 2.31–2.95s，五工具调用/六回合。归因记录 /tmp/epi-browser-start.60bOO0/attribution.json。
- Scope or files: browser/contracts.ts、tool.ts、对应单测和受控真实 E2E；原生动作、权限、隔离浏览器、取消排空不变。
- Expected output: 复用既有 prepare→navigate→observe 顺序，失败不继续、不重放；同任务交错模型对照检验往返和耗时。
- Dependencies: T-022.
- Execution steps:
  1. 增加可选 URL 的契约与失败/取消/terminal 回归。
  2. 复用现有顺序动作和观察路径，不新增调度器、重试或生命周期状态。
  3. 类型、单元、真实受控页面及模型 A/B，全部原始失败保留，未证明收益则不宣称提速。
- Acceptance criteria:
  - 一次调用能拿到目标页新观察；准备拒绝、取消、导航未知均不启动下一阶段；所有 URL 限制和上下文引用边界不变。
  - 实际模型使用合并路径减少往返且准确率不退化；独立关闭与回执通过。
- Verification method:
  - targeted browser/context/package tests、native TS、真实 GUI、固定任务/模型/种子的交错 A/B。
- Validation evidence: prepare 增加可选 URL，共用既有 URL 校验、原生 prepare/navigate 与 observeAfter，无新动作类型、调度器或生命周期状态。36 browser、21 context（含组合结果被过滤时禁止后续输入）、其余 desktop 邻域、8 qualified package、13 benchmark、严格 native TS 和根 check 通过。真实列表 fixture combined 四调用、三种点击独立回执全对，关闭 C06d5；原 split 五调用记录保留。证据 /tmp/epi-browser-start.60bOO0。固定 gpt-6-sol/form/seed42、同中性任务提示，A/B、B/A、A/B 六次全部通过且关闭：A=23.647/23.465/28.762s、6/6/8回合；B=21.538/21.002/21.018s、5/5/5回合。三对节省 2.109/2.463/7.744s；第三 A 有两次输入前契约错误，未剔除，不把全部差值解释为固定提速。B 三次实际调用 prepare(url)+observeAfter，零工具错误。总报告费用 0.1510204 USD，B 单次费用未显著低于 A，不宣称成本下降或尾延迟保证。candidate bridge f1143ecc7421e552787ca13430d0b3250bf440f9e6e362c54dfcde6b7454ea1d 已可回退安装，原包 installed-before；安装后 seed7 标签/弹窗/导航邻域运行中。
- Blocker: None.
- Unblock condition: None.

- Installed qualification: seed7 真实模型标签、弹窗、导航 3/3，通过且零工具错误、全部正常关闭至 C06d8；分别 12.532s/3、18.401s/5、26.514s/6 回合，费用 0.063602 USD。seed7 标签任务不同于 seed42，不作同任务速度比较。根 check 最终通过，恢复四处无关格式变化，21 项上下文测试格式化后再过。下一轮继续动态内容/长会话及剩余通用能力，不把 T-023 完成等同 Goal 完成。

### [x] T-024 — 动态表单连续记录

- Status: done
- Owner: coordinator
- Objective: 覆盖异步替换表单和同名控件连续记录，验证真实模型不会沿用旧引用误写下一条。
- Inputs and prerequisites: T-023 已安装，现有通用 Chrome 表单仅覆盖单条静态页面；复用真实模型 runner 与独立 oracle。
- Scope or files: real-model/tasks.mjs、tasks.test.mjs 和现有 runner；隔离 Chrome、本地三条测试记录，不操作用户数据。
- Expected output: 三条依次加载/保存且 DOM 被替换的真实模型任务，oracle 校验完整顺序、Unicode 正文和选项，保留全部失败及关闭证据。
- Dependencies: T-023.
- Execution steps:
  1. 在既有任务表增加动态记录，不创建另一套 runner。
  2. 验证 oracle 拒绝少条、错序、错值和只完成最后一条。
  3. 运行真实模型并按首个错误定位修复；需要时增加定向原生回归。
- Acceptance criteria:
  - 全部记录按顺序正确完成，模型基于新观察继续，超时和错误不隐藏，清洁关闭。
- Verification method:
  - targeted task tests、root check、真实模型独立回执和逐调用 trace。
- Validation evidence: 复用既有 tasks/runner 新增 chrome-dynamic，三个保存均销毁旧表单，120ms 后创建同名新控件。首轮同正文版本通过 56.905s/14 回合/0.0697244 USD，证据 model 保留但辨别串写能力较弱。加强为 reviewed R-101/R-204/R-305 你好 后，model-distinct 通过 47.497s/14 回合/0.0716772 USD，三条完整独立回执准确，零工具错误，所有输入 request.ref 均等于最近工具结果的 observationRef，关闭 C06da。两版各出现 3 次 loading 观察和 3 次额外 observe，后者模型 43.268s、工具 4.200s。不是同任务速度对照，不称本轮提速。14 benchmark 单测及根 check 通过，恢复根 check 的四处无关格式变化。证据 /tmp/epi-dynamic.4IqPMC/{model,model-distinct,inspect.mjs}；未改产品原生或权限，不代表长时稳定性已证明。
- Blocker: None.
- Unblock condition: None.

### [x] T-025 — 瞬态观察的额外模型往返

- Status: done
- Owner: coordinator
- Objective: 减少真实异步页面短暂 loading 状态导致的额外模型往返，同时不全局增加固定延时、不重放输入。
- Inputs and prerequisites: T-024 两轮均 3 个 120ms loading 状态导致各 3 次模型 observe；不同正文版本 43.268s 模型时间对 4.200s 工具时间。
- Scope or files: 现有 browser 观察路径与 dynamic fixture；先比较有界只读等待方案的成本和拒绝/取消语义，不增加后台常驻状态或输入重试。
- Expected output: 可证伪的最小候选及静态/动态页面交错对照；若不优于现状保留证据而不推广。
- Dependencies: T-024.
- Execution steps:
  1. 检查已有原生读取、页面就绪与取消排空路径，选择无需额外常驻实体的最小实验。
  2. 动态页面观察往返与普通页面开销对照，包含永不就绪、取消和页面边界改变。
  3. 真实模型验证准确率、调用数和端到端时间，所有失败保留。
- Acceptance criteria:
  - 不按任意 loading 文案猜测业务成功，不自动重复输入，不发布未完成或被取消的观察引用。
  - 动态场景实测少往返且静态常见场景无不可接受延迟；否则不声称优化完成。
- Verification method:
  - native/bridge 定向测试、真实静态和动态 UI、模型交错 A/B、独立回执与关闭证明。
- Validation evidence: T-024 trace 已证实瞬态读取和额外 observe 序列。现有 native get_browser_state 每次校验受控页面并重建 snapshot，bridge session.run 等待 terminal，context-binding 仅发布最终 canonical 结果。选择在既有 observeAfter 上提供可选 waitForText 条件，匹配实际显示的 label/value；不改 native、默认路径、调度器或常驻状态，不按 loading 文案自动猜测。读取失败不重试；一秒预算只限制追加读取，已经开始的原生读取仍必须排空，不能称硬一秒墙钟超时。实现及验证进行中。
- Candidate checkpoint: 41 browser、23 context（含中间视图不发布和最终 canonical 匹配）、35 desktop/segment、8 package、native TS 和根 check 通过。四个实际 Chrome guard：ready 190.6ms、timeout 1054.2ms、cancel 251.8ms、foreign 205.3ms；每例独立点击回执恰好 1，未发布失败引用，关闭 C06db–de。原始 guard 在 /tmp/epi-observe-wait.lr55CY/guards.mjs，已整理 durable wait-guards.mjs，最终 durable 文件尚待串行执行。model-candidate 的动态 45.307s/11 回合、静态 23.765s/5 回合均通过；动态额外 observe 从 3 次降为 0，仍需交错对照，尚未替换安装版。当前 A/B、B/A、A/B 动静态共十二样本串行实验执行中，进程 handle 78380；保留所有结果于同目录 ab-* 和 ab.json，不可重启正在运行的实验。
- Blocker: None.
- Unblock condition: None.

- Final qualification: /tmp/epi-observe-wait.lr55CY/ab.json、report.json 冻结 A/B、B/A、A/B 十二个模型样本，全通过、零工具错误、全关闭。动态 A=44.094/47.197/47.860s（14 回合），B=40.165/43.370/42.073s（11 回合）；逐对节省 3.929/3.827/5.787s。B 三次均使用明确文本条件并省掉三次独立 observe，工具阶段增加 317–380ms，但减少模型往返后端到端更快。静态两边均五回合、均不使用 waitForText；逐对节省 3.133/2.045/-1.537s，保留反向波动，不称静态提速或尾延迟已证明。AB 报告总费用 0.5923368 USD。durable guards-alert-final 五例全通过：ready 196.7ms、timeout 1027.1ms、cancel 261.4ms、foreign 170.6ms、native alert 173.0ms，各只点击一次、失败不发布引用，全部关闭至 C06f5；未自动接受 alert。已可回退安装 bridge 4938b97cdf9e145e65351baf83ee73491bda550ef7ed9bd469571786a4e5beaf，旧包 installed-before。model-installed 再次动态通过 38.684s/11 回合/0.0584356 USD，正文、顺序与所有最新 ref 校验通过，零工具错误，关闭 C06f6。根 check 最终通过并恢复四处无关格式变化；native/ABI 未改。上述 handle 78380 已正常退出，不再运行。

### [x] T-026 — 失败耗时与当前全场景基线

- Status: done
- Owner: coordinator
- Objective: 提前失败的任务也保留执行耗时，再获得当前安装版全部本地十四场景的真实模型基线，保留不支持项而不伪称官方全量测试。
- Inputs and prerequisites: T-025 已安装；run.mjs 在中断和 chrome-tabs oracle 断言之后才赋值 taskMs，提前失败缺少该指标。
- Scope or files: 既有 real-model/run.mjs 计时边界和现有全场景 runner；不增加另一套评估器或放宽成功条件。
- Expected output: 实际失败回放的缺失/修复计时证据，以及本地全部场景结果和首个未解决失败的诊断入口。
- Dependencies: T-025.
- Execution steps:
  1. 在实际 chrome-tabs 失败路径确认 taskMs 缺失。
  2. 将任务计时收口到 cleanup 前的 finally，setup 失败不伪造任务时间。
  3. 定向回归和当前全场景真实模型执行，所有失败与费用保留。
- Acceptance criteria:
  - 已开始执行的失败任务也有真实非负 taskMs；成功计时仍不含 setup/cleanup。
  - 本地所有 caseIds 获得结果或明确可验证的停止原因；不删未支持项或放宽 oracle。
- Verification method:
  - 失败实际路径前后对照、现有 benchmark 单测、root check、全场景模型原始 trace/summary。
- Validation evidence: /tmp/epi-full-suite.4mQT7j/timing-before 实际 chrome-tabs 失败缺少 taskMs；verify-timing.mjs 对旧 summary 失败、对 current-all 通过，后者同样保留 oracle 失败但记录 9815.8ms。仅将原计时移动至 cleanup 前 finally，无新模块；未开始的 setup 失败仍不伪造 taskMs。当前安装版 gpt-6-sol/browser/semantic/seed42 本地十四场景 11/14，通过全部已支持项；拖拽 9.504s、密码登录 19.955s、多标签页 9.816s 仍失败，不删分母、不放宽判定。所有 14 项 cleanup=true、零工具错误，关闭 C0705；总费用 0.289330 USD。成功样本 p50=18.503s、p95=41.498s（单轮异质场景，非稳定尾延迟估计）。check-all.mjs 验证结果数量、计时、工具错误和关闭；14 项 benchmark 单测和 npm run check 通过，恢复四处无关格式变化。计时原始 runner 路径靠上述真实模型前后回放保护，未新增默认 CI runner 注入框架；不能将指标修复称为多标签功能修复。
- Blocker: None.
- Unblock condition: None.

### [x] T-027 — 换行文本副本的观察成本

- Status: done
- Owner: coordinator
- Objective: 省去已经完整展示的 StaticText 的纯展示换行副本；只在实测有价值且行为不退化后安装。
- Inputs and prerequisites: T-026 本地全场景模型阶段占 83.1%；login-user trace 的多个 InlineTextBox 为已展示正文片段，当前仅压缩完全相同副本。
- Scope or files: controlled/tool.ts 原有投影、browser/test/tool.test.ts 原有 fixture；不加新 API、常驻状态或权限。
- Expected output: 保留正文与动作/值/选择状态的最小投影改动、定向边界测试、同模型任务的交错对照。
- Dependencies: T-026.
- Execution steps:
  1. 先扩展现有 fixture，证明换行片段重复展示；父文本缺失/预算丢弃仍须保留子文本。
  2. 复用现有 byIndex 和 displayedStaticText，只有父角色 StaticText、父完整文本已展示并包含片段时才省略无状态无动作副本。
  3. 同 native、模型、任务、seed 下交错 A/B，并检查准确性、调用轮数、观察字节与耗时；未获收益不得称为提速。
- Acceptance criteria:
  - 不删除独有正文或动作/值/选择状态；隐藏副本不获得可操作引用。
  - 单测和类型检查通过，真实模型结果不放宽 oracle；原安装版保留至资格确认。
- Verification method: 既有 browser/context/desktop 测试、严格 TS、根 check，/tmp/epi-wrapped-text.7avBaa 交错 A/B 原始 trace。
- Validation evidence: 旧代码两个相关测试预期失败，修复后 41 browser 全过；严格 native TS、根 check 通过且恢复无关四文件格式变化。候选包独立 staging，未安装；A/B 顺序 A,B,B,A,A,B，各跑 enter-text/click-tab-2，真实 gpt-6-sol seed42，最多 24 回合/180s，每次关闭证明后才启动下一例，报告费用上限 2 USD。handle 78168 已启动，后续必须 poll 同一 handle，不能因观察超时重开。
- Blocker: None.
- Unblock condition: None.

T-027 最终结论：候选不安装，源码和候选专用测试已精确撤回至原版；完整 patch、包和原始结果保存在 /tmp/epi-wrapped-text.7avBaa/{rejected.patch,package,staged-candidate,ab.json}。十二例全通过、全关闭 C0711，handle 78168 正常退出。页内标签 A=29.844/26.940/16.488s、9/9/5 轮；B=16.417/16.974/17.755s、5/5/5 轮；第三组反向慢 1.267s。输入 A=13.964/14.608/15.202s、4/4/4 轮；B=16.865/16.357/22.130s、4/4/5 轮，三组均慢，最后一次多一轮。不能凭这些小样本证明因果退化，也不能证明通用提速。观察空间被其他正文填满，输入观察字节 13231→13254，未减少上下文；标签前两组省下过滤/恢复观察、第三组原版本就无需补读。按最小复杂度原则拒绝默认加入父文本片段规则。候选 41 browser、58 context/desktop、严格 native TS、根 check 均通过，但正确性绿灯不替代性能资格。安装 bridge 仍为 4938b97cdf9e145e65351baf83ee73491bda550ef7ed9bd469571786a4e5beaf。下一步回到通用能力缺口及动作契约，不继续无依据地堆积投影启发式；Goal active。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

逐层执行纯汇总单测、三种真实 fixture 冒烟、交错 A/B。记录来源版本、原生指纹、耗时边界；不使用同步日志时间冒充原生执行时间。

通用场景按机制分层，避免重复类似步骤。第一批可执行套件见 `native/computer/desktop/fixtures/general/README.md`。后续资格场景定义如下，未跑项不视为通过：

| 层 | 场景与独立验收 | 当前覆盖边界 |
| --- | --- | --- |
| 原生编辑 | 中英文、组合字符、emoji、多行、Tab；完整值相等 | 已测 direct/synthetic 编辑；真实 IME 组合态未测 |
| 连续工作 | 同会话十次替换，每次读回；跨会话取消后恢复 | 已测；小时级 soak、内存趋势未测 |
| 视觉输入 | 点击目标事件一次、非零滚动、拖动到目标区 | 已测；长文档滚动位置、多屏缩放、跨窗拖放未测 |
| 窗口与弹窗 | A→B→A 无串写；保存→关闭面板→重开字节相同 | 双窗口已测；保存由原套件覆盖；外部抢焦点根因仍属 T-004 |
| 网页 | Unicode 表单提交值准确；随后导航、返回、标签页选择 | WebKit 与真实 Chrome 表单、弹窗、导航已测通过；Chrome 新标签失败保留，Safari 未测 |
| 引用恢复 | 旧语义/图片 ref 均拒绝且零写入；刷新后新输入成功 | 已测；目标消失/重建、窗口移动导致图片失效未测 |
| 取消与占用 | 取消不继续派发；释放后新 owner 能完成任务 | 预取消已测；中途按键/拖动取消、双 owner 竞争未测 |
| 权限/环境 | 缺权限、锁屏、owner 隔离能有界拒绝且零输入 | 不在真实桌面上自动修改权限或锁屏；使用定向模拟回归，真实故障资格待单独安排 |

每层记录所有尝试、正确业务成功/保护成功、错误输入、工具次数、冷加载、task P50/P95、失败耗时及排空。精简候选必须保持相同结果 oracle；不以去掉验证或失败样本改善统计。真实模型选目标/视觉理解不由确定性 fixture 代替。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

真实模型延迟已单独采集；共享桌面的焦点与负载会影响结果；小样本不能证明低失败率或稳定 p95。原生关闭隔离故障已按 T-008 恢复并复测，当前 C04ff。动作契约问题和 provider 异常仍使业务失败；不得把成功关闭当成任务成功。

<!-- task-doc-section:execution-log -->

本轮接续诊断：当前安装 fde462103 的八项 MiniWoB 原始 HTML 子集 5/8，通过 click-test-2、enter-text、click-checkboxes、choose-list、scroll-text；click-tab-2、drag-box、login-user 失败，8/8 cleanup=true。证据 /tmp/epi-observe-after.MCxmC4/miniwob-current，全部失败保留，不是全量官方分数。login-user 的 password 输入被原生 secure 判定有意禁止（page.rs describe_input 和输入入口均拒绝），不放宽该边界；drag-box 当前 browser 接口无拖拽能力。click-tab-2 已切换三个页内标签，但 4 KiB 投影包含大量空 generic/LabelText 节点，后续正文被截断；其点击目标本身为带事件的 span，并非语义 link，仍须独立验证可操作性。下一步先编码空结构挤占正文的投影回归，再验证文本优先策略；不能将投影改善等同原生 span 点击已支持。未改生产代码或已安装包。
## Execution log

- 2026-09-25: T-026 done，真实全本地基线 11/14；总 task=259.216s、model=215.389s（83.1%）、tool=43.729s。下一步优先减少观察噪声与无效模型往返，保持现有目标身份/权限/排空边界；不因用户允许架构调整就新增框架。拖拽、密码、多标签能力缺口与正式完整 benchmark/长稳测试仍未解决，Goal 保持 active。

- 2026-09-25: T-026 开始；上一轮已完成可选等待，不据局部绿灯宣称整体完成。本轮先用 code-debug 实际失败回放修正评估计时，再跑全部本地通用场景。

- 2026-09-25: T-025 done：显式 waitForText 复用有界只读观察，无新动作类型/调度器/常驻状态，不改变默认立即观察。十二模型交错样本、五个真实边界、安装模型与定向测试均通过；只认领动态场景少三轮的局部收益，Goal 继续。
- 2026-09-25: T-025 开始，coordinator 串行实验显式文本条件的有界只读等待，避免全局固定等待；优先检验取消、超时与未发布引用边界，再实测动态/静态模型。

- 2026-09-25: T-024 done，新增动态记录 benchmark 已经实际模型验证，强化不同记录正文后依然准确，未放松观察边界。T-025 pending 记录新测得的等待成本；不是产品已修复或性能收益承诺。

- 2026-09-25: T-024 开始，coordinator 串行复用现有任务表，增加动态连续表单；本轮不新增 runner、调度器或产品状态。目标为发现通用执行缺口，不追求只选易通过任务。

- 2026-09-25: T-023 done：36 browser、21 context、8 package、13 benchmark、native TS/root check，真实 combined 四调用回执及交错模型 6/6、安装后邻域 3/3 均通过。保留原版两次契约错误和全部计时，不声称普遍加速或成本降低。变更仅复用顺序阶段并暴露可选 URL；native 指纹未改。

- 2026-09-25: T-023 开始。code-performance 实测归因确定模型往返为主导时间；由 coordinator 串行修改共用工具契约，native 不变。保留 prepare 无 URL 的现有语义，仅合并用户已给定 URL 的顺序操作。

- 2026-09-25: 用户明确简化优先、允许架构重构；后续仅保留能以证据支撑速度、准确性、通用性或必要安全边界的机制，优先删除重复工作，不为重构而重构。T-022 以入口规范化修复已复现误拒绝，不增加缓存、重试或新状态实体。

- 2026-09-25: T-022 开始；coordinator 已比对 authoring page.rs 与当前安装材料完全一致。先用真实圆点重复节点的最小回放和冲突/原始大小负例建立失败回归，再实现完整记录相等的规范化；当前 installed 仍为 T-021，租约 C06c7。

- 2026-09-25: T-021 开始，coordinator 串行隔离 role=tab 容器与内部 link 的事件目标。上一轮状态投影和 press 预检已提交并试装；先保留现有能力，防止以拒绝自定义控件换取更低空点击数。当前安装 bridge ffc0c9dc，租约 C06c0，无运行中的上轮 fixture。

- 2026-09-24: 用户已明确允许当前页面具有点击处理器的普通 HTML 元素受限点击，仍禁止任意脚本、跨 frame 和个人浏览器。文本筛选已提交 fb817cb9a，21 tool/contracts、15 context、8 package、native TS/npm check 与真实六调用资格通过。下一步原生扩展需要独立证明：AX 文字节点到实际 HTMLElement 的身份映射、处理器存在且点击前重验、dialog containment、禁用/脱离文档/导航变化/无处理器负例，以及输入 receipt/terminal 不变；不能只把 pressable 角色白名单全部放开。当前原生源码尚未修改。

- 2026-09-24: T-015 第二阶段实现 browser observe.text（256 UTF-8 字节、有界字面包含搜索，4 KiB 输出保持），每次新原生读取且替换旧授权。过滤前全量计数确保重复 selector 不因过滤变唯一；未展示目标无授权。21 browser 契约/工具、15 context（含过滤后 provider omission）、native TS/npm check 通过。真实六调用 Unicode/select/save/筛选回执及关闭通过 C062c；试装包 package-search，旧包 installed-before-search。真实模型 model-search 找到 Tab #3 的 Tempor 并请求点击，此次首个阻断为 browser_input_unavailable，44.388s、12 回合、0.087366 USD、cleanup=true；不能把找到文字当作任务通过。已异步询问用户是否允许支持受控页面带点击处理器的普通 HTML 元素，尚未放宽原生角色白名单。第一阶段空结构排序与本阶段搜索分开留证；原始三轮失败均保留。

- 2026-09-24: T-015 第一阶段优先非空文本已试装；实际 Chrome form/dialog 邻域 2/2，26.362/40.057s，各 6 回合、费用 0.030862/0.0259988 USD，均关闭。click-tab-2 的剩余失败没有隐藏；下一步提供有界的截断后读取再判断 span 能力。root check 自动格式化的四个无关文件已恢复。误用 chrome:form 的一次 harness 命令在任务名校验阶段失败，未调用模型或 native；随后使用实际 chrome-form 命名。历史 controlled SDK 指纹检查未绕过，现代 browser/context 和包验证均通过。

- 2026-09-24: T-012 本轮仅失败日志诊断版 15/15，全部关闭 C061f，仍未复现端点错误。诊断 SDK/源码保留在 /tmp/epi-endpoint-stage.F4XCQO，工作源码已移除临时日志并 cmp 与诊断前一致；安装版本未变。不继续低信息重复跑，不放宽格式校验，T-012 根因仍未证明。接续 T-007：在当前 browser/observeAfter 安装版运行八项现有官方 MiniWoB HTML 子集，保留不支持能力的真实失败，不冒称全量官方分数。
- 2026-09-24: T-012 继续：成功路径不再写诊断日志，仅 endpoint 错误分支输出阶段、元数据长度和读取长度，拒绝码不变，无新增等待或重试。独立诊断 SDK 4fb7242f3eadca0d55e4488a8b091ad87e7b6d2202dff35fdd866796b0e258a4，2/2 endpoint 原生测试通过；旧 Rust warnings 保留。当前安装仍为 fde462103 合并观察版，未安装诊断库。/tmp/epi-endpoint-stage.F4XCQO/flow 正在执行同 15 场景并遇首个失败即停止；coordinator 下一步核对 flow.log 的失败阶段与关闭证明，随后移除临时源码诊断。
- 2026-09-24: T-013 接口能力完成并安装实验版，新增 observeAfter 的动作/观察双 terminal、取消与实际 provider context 回归。A1/B1/A2/B2 全部 12/12，B 回合稳定 6/6/7，A 10/10/12–13；保留 B1 dialog 模型慢样本，不声称普遍提速。安装后 fixture 5 次调用、完整 Unicode/Pro 保存及关闭通过，C0610。npm check 的四个无关自动格式化文件已精确恢复。任务仍在进行中，下一步扩大样本及继续 T-012，不以接口交付替代全局目标。
- 2026-09-24: T-013 in_progress；coordinator 串行实施 browser-only 可选动作后观察，不修改原生库。只在动作 terminal 后读取；动作失败/取消/未知终态不续读，读取失败保留先前动作事实、不授新引用、不重放。新的引用仍需出现在实际 provider context。先做契约/时序/上下文回归，再真实 Chrome 和交错模型 A/B；T-012 独立诊断保持未完成。
- 2026-09-24: T-011 done。桌面恢复后只读目录 failed=0、单次窗口绑定成功；model-unlocked 3/3，安装后 guards-installed 7/7，业务回执和关闭独立验证。没有使用保持唤醒措施；没有删除旧失败样本。T-012 仍由 coordinator 持有，下一步需要端点拒绝的精确阶段证据，不把 75 次未复现判为修复。T-013 保持 pending。
- 2026-09-24: T-011 安装后模型三项 0/3（form 11.049s、dialog 7.604s、navigation 7.867s），各两回合，prepare browser_window_unproved 后均未重放，close 全部成功 C05fa，费用 0.012692 USD。结束复核 locked=true、目录 failed=0；当前再次等待手动解锁，不能把 prior 11/11 guard 冒充模型资格。记录于 RESULTS.md；T-011 继续 in_progress，coordinator 下一步在持续解锁条件下完成模型及安装后加载期 guard。
- 2026-09-24: 外部环境恢复后 T-014 done，dialog 邻域 11/11、package 8/8，确认 clean lease 与无持锁者后安装 T-011 package-with-cause。旧包移至 /tmp/epi-nav-final.VvOeIZ/installed-before，可恢复；新 SDK e25bdbd56d3017d4928e669e2ade42667fc3b7c0e088f6c425b5cff41cffa62e。开始 model-installed 的 form/dialog/navigation 三个 gpt-6-sol 任务；结果尚待验证，未把安装等同通过。
- 2026-09-24: 用户确认解锁；目录 initially failed=0，系统锁屏键不再返回 true（探针显示 unknown，不把缺失键伪报明确 false）。同一 window-probe 成功 prepare/terminal/close，CG/CDP 均 [22,56,1200,878]，证明本次解锁后窗口绑定恢复。紧接 dialog-neighbors-unlocked 0/11，全部输入前 image_path_unavailable 且关闭，C05ec；新故障为 PID 2204 ChatGPT for Chrome，PPID 2162 个人 Google Chrome，运行自前一日，同名磁盘文件时间为今日。不能仅据时间认定替换因果；需正常恢复个人浏览器的用户授权。原 PID 82295/82296/82303 已不在 ps 中，未由本任务终止。
- 2026-09-24: dialog-neighbors-restored 0/11，全部 browser_window_unproved，输入提交标志来自 Chrome 启动，全部关闭 C05de。单次诊断定位为当前 PID 的 CG 窗口 [93,98,1081,791] 与 CDP [22,56,1200,878] 不一致；第二次诊断在 20 次/20ms 窗口采样内不变且正常关闭，不支持短暂小于 400ms 动画假设。随后系统锁屏状态明确 true、录屏权限 true、截图黑屏，原进程目录 failed=0。保留 /tmp/epi-nav-final.VvOeIZ/window-animation.log 和诊断脚本；未改产品绑定规则，尚须解锁后的同探针对照证明因果。T-014 blocked，等待手动解锁。
- 2026-09-24: 再次续跑时宿主目录检查 failed=0/540，lease C05d3；T-014 恢复 in_progress，开始同一冻结 SDK 的 dialog-neighbors-restored。未自动重启或强杀宿主，不推断路径恢复原因。原失败批次保留。
- 2026-09-24: 下一 goal turn 复核：同三宿主 PID 路径仍 ENOENT，未再次启动 GUI。浏览器错误原因桥接单独提交 e8679b3e1；11/11 browser 定向、131/132 desktop/context（1 按配置 skip）、native TypeScript 通过，root npm check 已在该相同代码上通过。提交仅含三个桥接/测试文件，未纳入其他用户改动或未安装 native 候选。T-014 阻塞未解除；真实模型/安装资格仍不能执行。
- 2026-09-24: 恢复执行后确认诊断版 select 15/15 完成且关闭；两种启动诊断各 30/30，总计 75 次未复现端点错误。只能报告未复现，不能证明 T-012 修复；已移除临时端点日志/延迟并 cmp 确认与诊断前源码一致。保留诊断 SDK 和原始样本。随后最终 T-011 候选 dialog 邻域 0/11，全部因输入前 image_path_unavailable 拒绝；新增 T-014，停止重复 GUI。浏览器桥接已提交导航保留白名单 cause，同时维持 outcome_unknown/禁止重放，离线 11/11 再次通过。最终候选 package-with-cause 尚未安装；coordinator 下一步在宿主恢复后完成邻域与安装资格。
- 2026-09-24: T-012 转 in_progress；两批端点准备拒绝 3/30，均在新 CDP 等待路径之前。先定位冷启动原因，不继续低信息重复重跑。依赖改为已完成 T-010，与 T-011 共享原生构建串行；T-011 候选保持未安装、待完成邻域/安装资格。
- 2026-09-24: T-011 候选加载期提示 7/7，首个阻塞定位为 Page.getFrameTree；候选只读等待可唤醒并关闭连接，已提交输入保留原契约。首批 select 邻域 14/15，一次 prepare endpoint 拒绝；新增 T-012，保留该失败并继续独立邻域复测，不从分母删除。
- 2026-09-24: T-010 select 完成并安装，26/26 真实 Chrome guard、同三任务模型 3/3，关闭全部证明，最终 C054e。继续 T-011：隔离加载期 alert 并测量首个阻塞 CDP 阶段，不因本阶段完成而停止。
- 2026-09-24: 用户要求持续自动测试修复、不在阶段性目标停止。T-010 继续实现 select_option；同时解决可操作选项被 4 KiB 输出预算挤出的已证实问题。新增 T-011 单独跟踪加载期原生 alert。共享原生库/桌面串行，保留真实模型显式开关与单任务限额，不自动重放未知输入。
- 2026-09-24: T-010 受限 dialog 资格完成并安装，SDK 222302e7c9fb6cdca8faa5775346e1deed504deece18c05c5d5a46d83a87f914，原包 /tmp/epi-dialog.UEensN/installed-before。11 场景全部准确且关闭；真实模型弹窗/导航 2/2，通过独立回执与可见读回，最终 C0531。四批 44 个 guard owner 的原始失败均保留。T-010 保持 in_progress，coordinator 下一步实现 select，再隔离分析导航期间原生提示竞态；未声称全部任务修复。
- 2026-09-24: T-010 开始。用户明确允许单个当前页面 HTML dialog 内输入，保留原生提示、多弹窗、跨页/跨 frame 与弹窗外输入拒绝。先修复 dialog 观察/动作闭环，再单独扩展 select；不把 text fill 冒充选项选择。
- 2026-09-24: T-009 完成并安装。候选三项导航通过、弹窗/表单仍失败但均推进到独立原生能力限制；最终安装版导航再次通过，最终 lease C0503。未修改 native ABI/权限/全图校验。新增 T-010 跟踪 HTML dialog/select，未假报三项全部通过。
- 2026-09-24: 用户要求修复动作契约；T-009 开始。复用 SDK 现有 startClick，仅当前观察/实际 provider context 中的 token 可点击；保留 press 的已观察值后条件。将错误后条件、mutation 后旧 ref 从统一 stale 分类中分开，前置拒绝不派发整个无效 batch。原生 ABI/权限与未知输入不重放不变；coordinator 下一步安装桥接候选并复测同三个任务。
- 2026-09-24: 用户授权正常重启独立 helper；launchctl stop/start 后路径可读，原生探针及三个真实模型 owner prepare/close 均通过，T-008 done、T-007 恢复 in_progress。新增 T-009 pending：无效后条件统一报旧引用及 mutation 后批量 ref 失效。新三项 0/3，耗时 43.955/23.035/46.709 秒，报告费用共 0.0528276 USD，均清洁关闭；未新增源码改动或放宽保护。
- 2026-09-24: 用户授权受控恢复与修复；T-008 开始。按 code-debug 的因果验证与现有任务计划串行推进，保留所有失败；未授权把全图校验直接弱化为局部校验。
- 2026-09-24: T-007 首轮完成：image-first Chrome 1/5；semantic-first Chrome 1/5、官方 MiniWoB 子集 2/8。前述 18 次全部正常关闭；实际模型往返占首轮 Chrome 耗时约 97%–98%，未宣称提示策略提速。全 PNG hash 对变化倒计时产生 stale_image_observation；未放宽保护。
- 2026-09-24: native browser 默认临时目录 prepare native_fault/关闭正常；发现 entry 的 /var alias 不满足 native canonical parent 契约，已写候选修复与回归。保持旧安装包、仅 TMPDIR=/private/tmp 对照后确实创建 Chrome profile，但 prepare outcome_unknown、shutdown/close unproved，lease D00000000000004f7。停止所有 GUI，不删除锁、不强杀或自动重试；lsof 无持有者、测试 PID 33473 与对应 browser/renderer 已退出，仍不等价于 native drain 证明。候选包未安装；T-007 阻塞于受控恢复授权和原生关闭诊断。
- 2026-09-24: T-007 开始；已查官方 benchmark 文档与本地可用模型；使用专用 CfT/profile，不接触个人 Chrome 数据，授权真实 API 仍设回合/费用边界。
- 2026-09-24: 用户追加通用场景实测；T-002 开始，解除对 T-004 的非必要依赖。新增 owned AppKit/WebKit 表单、鼠标点击/滚动/拖动、双窗口切换、连续编辑、过期引用、取消与重新创建会话。WebKit 测试只代表网页引擎，不冒充完整浏览器/外网任务；保持原有保存场景。
- 2026-09-24: T-001 开始；先实现确定性工具/UI 基线，不更改生产安全策略。
- 2026-09-24: T-001 完成。6 次冒烟通过后执行 120 次正式对照；不同 probe 版本的冒烟未混入正式统计。补充汇总器拒绝缺失关闭证明或非法耗时的单测。
- 2026-09-24: 发现保存焦点失败，新增 T-004，并置于覆盖扩展和生产精简之前。当前未删除生产校验、权限或焦点保护，未调用付费模型。
- 2026-09-24: 用户授权源码级优化改造；T-004 开始，先收集 fixture 前台/key-window 状态与失败动作关联，再做单变量候选。
- 2026-09-24: 焦点状态基线新增 36 次，保存 8/12；4 次失败均观测到 app inactive/keyWindow=-1，但 NSWorkspace frontPid 仍为 fixture。此为相关性而非根因证明。隔离 trace 8/8 成功。人为 deactivate 导致另一种“已投递但未保存”故障，不等同原拒绝，未据此改生产焦点策略，故障注入代码已移除。
- 2026-09-24: T-005/006 开始；60 次同 source bridge 二进制 AB 全部通过，原生无效等待明显消除。广义 native controlled_ 测试 169 通过、15 失败、1 忽略，失败包含缺失 headless fixture 环境和历史 browser fixture 问题；不宣称全套通过。随后与改动相关 tools::computer 67/67 通过。
- 2026-09-24: SDK 首次缺 headless fixture 导致 71 pass/23 fail（后续共享锁 poison），原始失败保留；补齐仓库既有 renderer-liveness-worker/fake-helper 和短 TMPDIR 后 94/94 通过。未修改产品来绕过测试环境错误。
- 2026-09-24: T-005/006 完成；1434 文件新包已安装，原包保留 /tmp/epi-optimize.vOX6Su/installed-before。最终 SDK 8b01d174bff81dc49101b3a85e692fbc8b4ceb7fbdf13c237e5411ad3d98d75a。安装后 60/60、额外图像输入/完整保存探针通过，最终 lease C045d。长驻进程需正常结束并新建进程使用新库，未强行终止既有进程。
- 2026-09-24: T-004 仍由 coordinator 持有；恢复时优先对比失败时 WindowServer 实时 PID 与 cleanup 使用的 NSWorkspace PID，再做有针对性的激活实验。最新通过不能证明历史焦点故障根因已修复。T-002/003 仍待后续覆盖，不把局部交付冒充全部完成。
- 2026-09-24: T-002 首批十场景正式 50/50；格式化后同套件冒烟 10/10，原保存套件 split/combined 6/6。metrics 3/3、npm run check、task document validate 与本次文件 diff --check 通过。既有 LEARNS.md 的 EOF 空行告警为用户原改动，未修改。完整浏览器及中途取消仍待覆盖，T-002 保持 coordinator 可恢复状态，下一步见任务字段。

### 首批实测与决策

环境：macOS Darwin 25.5.0 arm64，Node 24.15.0；原生 SDK SHA256 `b3ac211594001c05c5020f87e753a64f44fd5786b3701f6117eb9422b377e7d0`。每个任务每组 20 次，按 pair 交替 AB/BA，均为新进程冷加载与新 owner。计时起点包括 bridge 加载；fixture 已预先打开，启动时间另列；结束含独立业务读回，关闭另列。不包含模型与应用启动性能。

| 场景 | split 成功/尝试 | combined 成功/尝试 | 成功 P50 split/combined (ms) | 成功 P95 split/combined (ms) | 调用数 split/combined |
| --- | --- | --- | --- | --- | --- |
| 保存重开 | 18/20 | 16/20 | 2184.6 / 2176.5 | 2443.6 / 2432.8 | 11 / 9 |
| 正常替换 | 20/20 | 20/20 | 1446.9 / 1443.9 | 1525.9 / 1482.0 | 5 / 4 |
| 失效全选正确拒绝 | 20/20 | 20/20 | 1612.5 / 1616.8 | 1632.4 / 1658.7 | 4 / 3 |

失败不计入成功耗时，但保留在全部尝试分母。不能据此宣称 combined 更快或准确性非劣；本地耗时差小，真实模型往返收益尚未测量。

6 次保存失败对应 pair 7 combined/split、10 combined、12 combined、13 combined、16 split。名称填充已确认，Return 的结果为 `foreground_focus_unproved`，`inputCommitted: true`、`recoveryAttempts: 1`，随后独立 saved 事件等待到期。不能把 inputCommitted 当作 Return 已完成，也不能从拒绝码直接认定用户抢焦点或校验错误。120 次均完成 native close、fixture 正常退出与 clean lease；未自动重跑失败动作。

分段诊断另行运行，不混入对照：`ax_readiness` 总计 1028.106ms，`detectUs=1024481`、`callUs=480`、`callbackDrainOk=true`。`tools/computer.rs` 的 `with_focus_cleanup` 丢弃 `snapshot.detect()` 返回值；`window_change_detector.rs` 默认检测 1000ms，但 snapshot 同时持有 wildcard 焦点抑制 lease。因此这是高价值待实验项，不是已证实可直接删除的空等待。下一步需要保留回调排空与焦点约束的独立候选对照；目前未替换安装包。

### 已交付的局部优化（后续证据更新）

上段为初始决策记录。随后仅对明确 unsupported/not implemented 的可选 AX 启用结果移除等待；保留 lease 安装/释放、回调排空及所有已接受/未知结果的原行为。无需全量删除焦点保护。源码见 `native/computer/patches/readiness-fast.patch`；增量顺序和材料哈希见同目录 `readiness-fast.md`。

同一 source bridge 的二进制交错 A/B，各场景 10 对，60/60 全部通过（预期拒绝另算场景）。候选 A/B 二进制含关闭默认诊断开关的 trace 分支，最终发布移除了该诊断；最终包另做安装回归，未混入 A/B 分布。

| 场景 | 原版/候选成功数 | P50 原版 → 候选 (ms) | P95 原版 → 候选 (ms) | 逐对节省中位数 (ms) |
| --- | --- | --- | --- | --- |
| 保存重开 | 10/10、10/10 | 2238.9 → 1273.7 | 2590.6 → 1917.3 | 854.4 |
| 正常替换 | 10/10、10/10 | 1514.8 → 450.7 | 1934.6 → 898.2 | 1036.4 |
| 失效全选正确拒绝 | 10/10、10/10 | 1666.6 → 597.5 | 1778.0 → 622.0 | 1073.8 |

每一对均更快，非只比较均值；没有失败剔除。诊断中 detect 从约 1024ms 降到 0.041ms，callbackDrainOk=true。最终包安装回归 split/combined 每场景各 10 次，60/60 全部通过且关闭；保留首个冷启动保存 2720ms，不静默移除尾部样本。该结果不证明所有应用或极低失败率，不宣称模型端到端加速相同比例。

Agent 新接口：`{"request":{"op":"select","ref":"当前窗口 ref","observe":"image"}}` 一次获得窗口选择与新 Image ref，不触发 AX 启用。`observe:true` 保持语义读取；省略保持只选择。后续 input 仍需模型实际看到该图片，过期或被过滤图片不能授权输入。

### 通用场景首批资格结果

来源 `/tmp/epi-general.dpLJ12/final/{contract.json,samples.jsonl,summary.json}`；同一已安装 SDK `8b01d174bff81dc49101b3a85e692fbc8b4ceb7fbdf13c237e5411ad3d98d75a`，十场景各五次独立冷进程，无重试。业务场景 35/35；保护/恢复场景 15/15；全部 native close、fixture exit、clean lease 通过。

| 场景 | 通过/尝试 | task P50 / P95 (ms) | 工具调用中位数 |
| --- | --- | --- | --- |
| Unicode 多行替换 | 5/5 | 485.5 / 506.4 | 5 |
| 同会话连续十次替换 | 5/5 | 1630.0 / 1639.6 | 41 |
| 双窗口 A→B→A | 5/5 | 836.0 / 903.9 | 15 |
| 图像点击 | 5/5 | 660.3 / 733.8 | 3 |
| 图像滚动事件 | 5/5 | 664.3 / 682.7 | 3 |
| 图像拖动 | 5/5 | 1057.9 / 1115.3 | 3 |
| WebKit Unicode 表单 | 5/5 | 621.6 / 629.2 | 3 |
| 过期语义引用拒绝及恢复 | 5/5 | 532.7 / 558.3 | 8 |
| 过期截图引用拒绝及恢复 | 5/5 | 585.1 / 634.3 | 8 |
| 预取消及新建会话恢复 | 5/5 | 611.0 / 643.8 | 8 |

计时包括冷 bridge 加载、首次 native 初始化、工具执行与独立读回，不含模型、预先启动 fixture 或网络。关闭单列；本版 general closeMs 包含缓冲日志输出开销，不与早期 save closeMs 做细微差值比较。五次 P95 实际为最大值，只做筛查，不证明可靠尾延迟或极低故障率。连续编辑的 41 次包括每步 fresh observe/reconcile 的验证成本，尚不是最省调用的 agent 策略；可用 segment 自带新证据做后续等价对照，不应先删结果验证。

原始失败保留：`smoke` 九次中 4 pass/5 fail；一个为真实 `foreground_target_changed` 且正文未变，其余四个为 harness 错把 `needs_observation` 一律要求成 `confirmed`。修正后必须校验 fresh AX 和独立正文，再 reconcile，不重放输入。单独 `stale-image.log` 初次断言错误码失败：segment 的统一失效证据错误是 `stale_observation`，不是旧 click 接口的 `stale_image`；产品已正确拒绝，测试按实际契约修正。后续 45/45、最终 50/50 分版本保留，不能消除首轮焦点失败事实，也不构成 T-004 根因修复。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 原版失败及不同版本的全部样本保留；此前二进制 A/B、安装 GUI 和确定性通用场景不能替代模型证据。HTML dialog/select/加载期 alert 修复已安装，具体分版本资格见 T-010/T-011。最近完成 T-022 AX 规范化、T-023 合并启动、T-024 动态记录 benchmark、T-025 显式文本等待；T-025 十二个动态/静态模型交错样本全部通过，动态各少三轮，五个真实边界 guard 与安装后模型通过；41 browser、23 context、35 desktop/segment、8 package、严格 native TS 和最终根 check 通过。不同任务/版本不混算成功率或提速。
- Limitations: 最新已验证 clean lease C06f6。T-012 启动端点偶发故障原因仍未证实；锁屏或不可读进程环境仍可阻塞新会话，不自动解锁/重启用户应用。静态耗时有反向波动，不称普遍加速。T-004 焦点/输入投递、T-002 外部干扰/中途取消/长时会话、T-003 全局精简资格仍未完成；浏览器拖动、密码和多标签等通用能力未全覆盖。官方大型 benchmark 全量环境未部署；未证明彻底修复或所有应用稳定性，Goal 保持 active。
