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

仅 pi Computer 测试、源码优化和改造；2026-09-24 用户明确授权继续源码级优化，以速度、稳定及 agent 调用友好为目标。原始记录保留。默认不调用付费模型、不改变系统权限、不删除租约、不操作业务文档。冗余等待或重复工作可依据对照证据精简；不得用绕过目标/输入归属校验伪造成功。

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
- Open question: 真实模型额度与生产权限精简尚未单独授权，不阻塞本地工具/UI 对照。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 同一业务 oracle、全量失败样本、冷加载和关闭独立计时；禁止失败自动重跑。
- 合并/拆分选择观察使用同一二进制，按对交错执行；不声称固定脚本代表真实模型 E2E。
- 后续覆盖浏览器、纯视觉、焦点/取消干扰和连续会话后才判断全链路完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-004; T-001 -> T-002 -> T-003; T-001 -> T-005; T-001 -> T-006. 全部串行；覆盖采集不依赖焦点修复完成，失败原样保留。T-005/006 为局部交付。
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

模型延迟尚未计入；共享桌面的焦点与负载会影响结果；小样本不能证明低失败率或稳定 p95。

<!-- task-doc-section:execution-log -->
## Execution log

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
- Evidence: T-001、T-005、T-006 完成；原版失败均保留。局部优化 60 次二进制 A/B 和 60 次安装 GUI 通过；T-002 已扩展十场景并完成 50/50 实际工具/UI 检验。metrics 单测 3/3、npm run check 通过；格式器引入的四个无关文件改动已单独撤回。
- Limitations: T-004 焦点根因/修复、T-002 完整浏览器/外部干扰/中途取消/长时会话、T-003 全局精简资格验证未完成；模型层未执行。通用场景是新基线而非新的提速对照，无彻底修复或所有应用稳定性结论。
