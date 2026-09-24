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
- Blocker: None. 生命周期阻塞已解除；coordinator 下一步先执行 T-009，再恢复相同 oracle 的任务对照。新增真实 browser 三项业务 0/3，但 prepare/close 全部通过，记录于 RESULTS.md。
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

### [ ] T-009 — 浏览器动作契约与错误恢复

- Status: pending
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
- Validation evidence: 尚未修复。表单第一步成功后旧 ref 第二步 stale；另两任务 press.expect 未在当前观察出现，controlled/tool.ts 的 selectors 检查统一返回 stale_observation，模型重复 observe 仍失败。
- Blocker: None.
- Unblock condition: None.

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
| 网页 | Unicode 表单提交值准确；随后导航、返回、标签页选择 | WebKit 本地表单已测；真实 Chrome/Safari、导航与标签页未测 |
| 引用恢复 | 旧语义/图片 ref 均拒绝且零写入；刷新后新输入成功 | 已测；目标消失/重建、窗口移动导致图片失效未测 |
| 取消与占用 | 取消不继续派发；释放后新 owner 能完成任务 | 预取消已测；中途按键/拖动取消、双 owner 竞争未测 |
| 权限/环境 | 缺权限、锁屏、owner 隔离能有界拒绝且零输入 | 不在真实桌面上自动修改权限或锁屏；使用定向模拟回归，真实故障资格待单独安排 |

每层记录所有尝试、正确业务成功/保护成功、错误输入、工具次数、冷加载、task P50/P95、失败耗时及排空。精简候选必须保持相同结果 oracle；不以去掉验证或失败样本改善统计。真实模型选目标/视觉理解不由确定性 fixture 代替。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

真实模型延迟已单独采集；共享桌面的焦点与负载会影响结果；小样本不能证明低失败率或稳定 p95。原生关闭隔离故障已按 T-008 恢复并复测，当前 C04ff。动作契约问题和 provider 异常仍使业务失败；不得把成功关闭当成任务成功。

<!-- task-doc-section:execution-log -->
## Execution log

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
- Evidence: T-001、T-005、T-006 完成；原版失败均保留。此前局部优化 60 次二进制 A/B 和 60 次安装 GUI 通过；通用确定性场景 50/50。新增真实模型十三场景单轮 3/13，额外 Chrome 五场景 1/5；不能用确定性结果代替模型表现。新 benchmark 11/11、directory/entry 3/3、打包 9/9、desktop 加载级 124 pass/1 skip 与 npm run check 通过。
- Limitations: 最新 lease C04ff；T-008 生命周期修复完成，真实模型复测已恢复，但新三项业务 0/3，T-009 动作契约待修复。T-004 焦点/输入投递、T-002 外部干扰/中途取消/长时会话、T-003 全局精简资格仍未完成。官方大型 benchmark 全量环境未部署；未证明普遍提速、彻底修复或所有应用稳定性。
