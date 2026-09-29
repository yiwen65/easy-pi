# Task Plan: Computer 原生目标点击与动态页面可靠性

- Created: 2026-09-29
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户持续优化 Computer Use 的 Goal；候选先验证负例再安装；允许源码和架构改造。

<!-- task-doc-section:background-goal -->
## Background and goal

减少动态页面中的无效拒绝和模型重试，同时保留原生目标身份、窗口边界、取消排空及未知输入不重放。
此文只管理原生目标点击这一实施批次，不替代完整 Computer Use Goal 或宣称主流 benchmark 全覆盖。
原有 target-region-candidate.md 保留历史实验与失败证据，不再作为此批次状态清单。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

在现有 segment 生命周期内增加明确引用目标的点击表达，复用原生快照缓存、目标解析和事件派发。
坐标点击/滚动/拖拽的已安装契约不变；现有局部像素候选仍未安装。
不把普通 AXGroup 排除规则、标签/矩形相等或固定等待当作身份证明。
不操作个人浏览器，不删除租约，不添加新服务、第二套缓存或自动输入重放。
新动作必须先用观察引用明确用户/模型的目标意图；不能偷偷把旧 imageRef 重新绑定到另一个控件。
用户随后单独批准原生目标引用点击候选；负例和真实模型通过后才安装，坐标/拖拽不变。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | desktop 点击只接受 image point，没有原生 target 参数；focus/fill 已有 target 地址 | native/computer/desktop/segment-contracts.ts、segment-codec.ts；原生 computer_segment.rs |
| F-002 | Chrome 懒加载子树从 51 增至 57 行，后续 hit 可按 CFEqual 匹配 | target-region-candidate.md；诊断 EsT4uE |
| F-003 | 之后的拒绝来自非祖先 AXGroup 矩形重叠，而非像素比较 | 同一诊断 hit_index=30、overlap index=33 |
| F-004 | 删除重叠规则会丢失已复现的同外观控件重排保护 | region-final-reorder-cover 误点击；region-fixed-reorder-cover 拒绝 |
| F-005 | 当前原生枚举变更需要真正重新生成绑定，不能手改生成结果或只换 dylib | cua-driver/scripts/generate-uniffi-bindings.mjs；ComputerInput UniFFI enum |
| F-006 | 工作源的 typescript 目录只有 src，没有可直接运行的本地 UBRN generator | 2026-09-29 ls typescript；生成脚本要求 node_modules/.bin/ubrn |
| F-007 | 已找到可用的锁定 UBRN：必须用 P03 环境运行；直接运行缺少离线 clap 索引 | P03 env.sh + npm/node_modules/.bin/ubrn；--version 不受支持但成功进入 CLI 参数解析 |
| F-008 | 无行为变更重建成功，生成的 TS 与原有六文件逐字一致，再运行 --check 通过 | 工作副本 generate-uniffi-bindings.mjs；diff -rq target-click-bindings-before typescript/src/native exit 0；--check 输出 UniFFI bindings are up to date |
| F-009 | reference() 验证当前 observation 前缀及精确 PID/window 缓存；member() 检查窗口归属，但没有保存观察时几何，也没有证明目标仍在当前 AXChildren 树中 | segment/target.rs；ax/cache.rs；observation/native.rs::Scan::payload |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 显式原生目标引用能避免根据重叠矩形猜测原始点击意图；须通过真实 span、button、覆盖和替换测试，不把设计当结果。
- Assumption: 复用 segment 的资源/取消机制可避免新的执行状态机；须检查所有枚举消费者和 input ownership 测试。
- Decision: 如获批准，语义目标点击也必须校验观察时几何与当前几何；不能用 live center 静默追踪移动目标。
- Decision: 锁定生成器已可重建，无须新增依赖。N-API runtime 按模块动态装载 FFI，不手写枚举布局；新 ABI 仍须实际加载和调用验证。
- Decision: 用户已批准独立的原生目标引用点击候选，不以截图像素为依据；安装仍以负例与真实模型通过为门槛。

### Approved candidate contract, isolated implementation under validation

- 模型仍使用 `op: click`，但只能二选一：现有 `point`，或新 `target: {ref}`；不增加另一种工具。
- 初版目标引用分支只允许一个动作、左键单击，不接受 locator、按钮/次数参数、同时指定 point 或跨窗口地址。
- Rust 在 `ComputerInput` 末尾增加 `ClickTarget { reference }`；真实生成绑定，不复用 Focus、Fill、AXPress 等不同语义伪装。
- 复用已有 CachedSnapshot，保存该观察的窗口几何及可点击候选的角色、描述标识、几何；不增加独立缓存或服务。缺失该目标证据只拒绝目标点击，不令普通 observe 失败。
- 派发前必须证明原始原生 handle 仍是当前树成员、角色/描述/几何未变，中心坐标在选定窗口内且未被遮挡；实时命中必须是该目标或可证明的后代。移动指针后再次校验，再按键；失败后不自动重放。
- 原来的图像点击、滚动、拖拽不转译为新动作；本提案并不证明局部像素方案已经可发布。

### Consumer and validation boundary

| Boundary | Required work / check |
| --- | --- |
| Model shape and encoding | desktop/segment-contracts.ts、segment-codec.ts 及对应定点测试；其余顶层 click 仍是 startImageClick，不混用 |
| Native ABI | contract/computer_segment.rs；运行真实 TS/Python 生成与重复 --check；候选 SDK/bridge/native 一致装载 |
| Static admission | sdk/computer/segment.rs；拒绝复合动作、空/超长引用、未知参数；segment_native.rs 必须要求语义 observation，而非仅 image ref |
| Dispatch and ownership | platform segment.rs 的 budget、readiness、permission click 映射、输入提交/释放和已派发边界；未知结果不重放 |
| Target evidence | ax/cache.rs、observation/native.rs、segment/target.rs；复用同一快照退休机制，不用 label/rect 代替 CFEqual |
| Neighbors | readiness/tests.rs、order_tests.rs、SDK segments tests；cross_drag_native.rs 仍只接受单个 Drag |
| GUI oracle | 动态远处变化单击一次；移动、替换、可见/透明覆盖、同外观重排为零次；独立计数/页面 oracle，不把 dispatched 当成功 |

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 原生引用明确绑定目标；替换、移动、覆盖、跨窗口、旧引用、取消均拒绝或按已提交前缀正确报告。
- 动态无关内容不应导致该目标点击重试；同外观重排负例仍无输入。
- 真实模型 click-tab-2 与 scroll-text 使用独立 oracle，失败保留，所有 owner 正常关闭。
- 模型预算修复经实际入口验证；交错基线/候选样本后才讨论速度，不能用单次成功宣称提升。
- ABI、生成绑定、桥接、pins、产物哈希一致；安装前完成范围内回归并保留可恢复旧版本。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-004 -> T-003；T-003 的首次真实模型诊断已完成，新增 T-004 修复已复现的直接文本子节点误拒绝后继续资格验证。
- Parallel batches: 无；各任务共享动作枚举、生成绑定与同一桌面 owner，串行执行。
- Serialization constraints: 所有 GUI 串行；不启动子 agent；仅 coordinator 更新本文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 明确原生目标点击的契约与构建边界

- Status: done
- Owner: coordinator
- Objective: 定义无需矩形猜测的目标引用点击，证明可以复用现有目标/资源路径。
- Inputs and prerequisites: F-001 至 F-006；用户已有源码/候选授权。
- Scope or files: desktop/segment-contracts.ts、segment-codec.ts；原生 computer_segment.rs、segment/target.rs、生成脚本。
- Expected output: 最小契约、完整消费者范围、生成工具可用性及测试 oracle。
- Dependencies: None.
- Execution steps:
  1. 检查地址解析是否验证真实 live 成员与原始几何，明确首次单击且具体 ref 的最小范围。
  2. 追踪枚举验证、权限映射、动作分类、输入预算、失败报告与生成绑定消费者。
  3. 找到锁定生成工具；用无行为变更的再生成检查验证环境。
- Acceptance criteria:
  - 不复用 Focus/Fill 伪装点击，不通过私有未生成 ABI 绕过契约。
  - 清楚区分新语义动作与旧图像坐标动作；所需几何/身份数据有具体归属。
- Verification method:
  - 源码消费者检查、定点生成检查和可复现负例设计。
- Validation evidence: 已完整读取 TS schema/codec、原生输入枚举、目标解析、缓存、segment executor 和生成脚本。P03 隔离环境内重新生成成功；生成 TS 目录与备份 diff -rq exit 0；二次 --check exit 0。未修改产品动作契约，未运行新动作 GUI。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实现并验证候选执行路径

- Status: done
- Owner: coordinator
- Objective: 将明确 target ref 的点击贯通到原生派发，不新增缓存/生命周期。
- Inputs and prerequisites: T-001 的契约和锁定工具。
- Scope or files: T-001 确认的模型 schema/codec/native input executor/生成绑定/候选补丁及相关定点测试。
- Expected output: 隔离、可重建、未安装的完整候选与正负例。
- Dependencies: T-001
- Execution steps:
  1. 编写缺失动作和错误目标的定点回归。
  2. 修改原生、桥接与生成绑定；保留已提交输入和取消排空语义。
  3. 执行原生、TS 和 owned GUI 测试，复查 diff。
- Acceptance criteria:
  - API/ABI 一致；拒绝时零输入，派发成功不等于业务成功。
  - 动态内容正例与替换/移动/可见透明覆盖/重排负例全部通过。
- Verification method:
  - 定点 Rust/TS 测试、npm run check、所有新 GUI 回归。
- Validation evidence: 独立源已实现 ClickTarget 与 TS 严格单动作契约，真实生成 ABI 并重复检查通过。SDK segment 12/12；最新 platform segment 30/30；实际加载 TS contract/codec/projection 27/27；tool lifecycle 21/21（包括目标点击旧观察、图像引用、换窗口与取消）。候选 v6 的 8 个真实 GUI 正负例全通过且全部正常关闭、clean lease。此前 v1/v2/v3/v4 失败保留；最终 npm run check exit 0、无关 formatter 副作用已撤回、补丁应用检查通过。此状态只代表候选执行路径验证，不是发布资格。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 真实模型、速度与安装资格

- Status: blocked
- Owner: coordinator
- Objective: 用业务 oracle 和可比测量确认候选改善真实任务。
- Inputs and prerequisites: T-002 全部通过、现有模型授权与隔离 CfT。
- Scope or files: real-model runner、owned fixtures、候选打包/pins 与证据记录。
- Expected output: 保留失败的交错样本与明确安装/不安装结论。
- Dependencies: T-002, T-004
- Execution steps:
  1. 验证修复后的模型请求预算确实在实际调用入口生效。
  2. 运行标签、滚动、表单和相关通用回归，比较任务成功、轮数、工具/模型时间。
  3. 满足资格才按已有授权安装，并验证真实加载与回滚材料。
- Acceptance criteria:
  - 不丢弃失败样本，不使用失真计时；部署与测试产物完全一致。
  - 保护、准确性和速度证据足够；不足时明确保留未安装状态。
- Verification method:
  - 真实 AgentSession、独立页面 oracle、进程关闭/租约读回及哈希核对。
- Validation evidence: 请求预算通过真实 Agent 循环（本地 stream、无网络）验证 24 次后端调用，第 25 次拒绝；metrics 6/6，npm run check exit 0。v6 真实 gpt-6-sol 两例：click-tab-2 失败（57.98s/9轮），scroll-text 通过（116.29s/14轮），总 reported cost 0.1382168 USD，均正常关闭。数据 `/tmp/epi-pointer-boundary.PFHOUz/native-target-model6/summary.json`；不是可比性能提升证据。
- Blocker: Chrome 链接实际命中其原有 AXStaticText 直接子节点，精确同对象规则误拒绝；模型标签任务未达安装门槛。
- Unblock condition: T-004 受限子节点实现与负例通过，然后重跑真实模型与相关回归；不安装现有失败候选。

### [ ] T-004 — 修复已观察直接文本子节点的命中契约

- Status: in_progress
- Owner: coordinator
- Objective: 允许链接、按钮、单选控件命中同次观察已存在的直接 AXStaticText 子节点，不接受任意后代。
- Inputs and prerequisites: 用户已明确回复允许此受限子节点支持；T-002 候选与 Chrome 因果对照。
- Scope or files: 原生 target_click.rs 及候选补丁；owned Chrome fixture、定点测试。
- Expected output: 无诊断代码、单独打包的候选及父子正负例。
- Dependencies: T-002
- Execution steps:
  1. 复用原生缓存证明父子双方原生身份、原始几何及直接父子关系。
  2. 拒绝新增、替换、移动、覆盖和非文本后代；保留原有八例。
  3. 重建、定点测试与真实 GUI 验证后恢复 T-003。
- Acceptance criteria:
  - 原有文字子节点点击一次；错误目标负例零点击；无自动输入重放。
  - 不以标签/几何相同代替身份，不更改坐标/拖拽契约。
- Verification method:
  - Rust/TS 定点测试、真实 owned Chrome oracle、关闭与租约读回、根检查。
- Validation evidence: 已诊断未实施。`/tmp/epi-target-chrome-6otb2T/result.json` 链接零点击，native selected29 AXLink / hit30 AXStaticText，old_parent 与 live_parent 均29；`/tmp/epi-target-chrome-liFlcb/result.json` 直接指定同类文本目标点击一次。诊断源码已撤回，与 v6 冻结源 SHA 相同；诊断 dylib 不能安装。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

从实际报错与误点击负例开始，串行执行 schema/codec、Rust 验证、真实 GUI、真实模型。
只跑定点测试，不运行根全量 vitest。代码变更后执行完整 npm run check，撤回其无关格式化副作用。
构建必须在已恢复的候选源码重新运行，不能使用仍含诊断日志的 release 目录产物。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

新动作可能只是把复杂度转移到 schema；T-001 必须先证明现有引用/缓存可复用。
观察时几何与 ABI 已实现并经定点验证；Chrome 懒加载、AX hit 稳定性、指针移动后竞态与真实模型仍是待验证边界。
现有 target-region 候选不能当作稳定发布；模型页内标签失败仍在分母。
未知输入不重放、进程/窗口边界与关闭排空不得为了通过测试删除。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-29: 创建串行实施批次，T-001 开始；核对源码，确认当前缺少 target-click 契约，生成绑定不能只换 dylib。
- 2026-09-29: 安装版本未改变；保留所有既有失败与用户无关 worktree 改动。下一步读取 segment/target.rs 并定位锁定生成工具。
- 2026-09-29: 在临时工作源连接已有锁定 node_modules，先备份六个 TS native 文件，运行 canonical generate 与 --check；逐字比对无变化。构建仅有既有 shutdown dead_code 与 duplicate rpath 警告；未把这些警告视为新功能通过。
- 2026-09-29: 读完目标引用及执行链，确认缺失观察时几何与当前树成员证明；记录最小候选和消费者。T-001 转 blocked，等待新语义分支边界确认；未实现或安装。原持续 Goal 不因这个批次的提案而标记完成。
- 2026-09-29: 用户回复允许单独验证候选，测试通过后再安装。T-001 blocked -> in_progress -> done；T-002 coordinator 开始。先在隔离原生工作源实现，完整贯通/测试前不修改安装版本。
- 2026-09-29: 从安装版原始材料复制到 `/tmp/epi-pointer-boundary.PFHOUz/native-target-source`，不是从局部像素工作源继续叠加。材料 patch a01443cf、native a1f1aea2 与安装 manifest 一致；坐标 segment 和 legacy pointer 源码 SHA256 与基线一致。
- 2026-09-29: 首个基础补丁复用 CachedSnapshot：保存窗口几何及每行可选目标几何/角色/标识；缺失可选证据不破坏普通观察，取消仍传播。提取要求 PID、window、snapshot ID 和 runtime 四者匹配，克隆时保留原生句柄，退出释放。尚未增加 ClickTarget 枚举或派发代码。
- 2026-09-29: 在上述工作源 `rust/` 使用 P03 env.sh 执行 `cargo test --locked --offline -p platform-macos --lib ax::cache::tests`（6/6）、`-p cua-driver-core --lib element_cache::tests`（9/9）、`-p cua-driver-sdk --lib computer::segment::tests`（11/11）。首次构建约 53s/20s/50s，不是 Computer Use 延迟样本。原生存在基线 unused_unsafe、irrefutable_let_patterns、dead_code 警告，未扩大修改范围。
- 2026-09-29: 持久补丁 `native/computer/patches/native-target-click-candidate.patch`，SHA256 `c2381566a20e1f00faa7649781db04ad40d4021094f45e246a6a6f2519715929`；对原始材料 `git apply --check` 通过。根 `npm run check` 通过；其四处无关 formatter 改动已逐块撤回，用户 LEARNS.md 等改动保留。
- 2026-09-29: 核对安装版 bridge a28cd243、native a1f1aea2、NAPI 1f3296c1，全部未变。无 GUI owner 启动。T-002 下一步：在该隔离源实现单动作 ClickTarget 的 schema/native admission、实时身份/几何/遮挡命中 guard，先原生定点测试，再生成 ABI 与桥接；不要把当前基础补丁当成可安装候选。

- 2026-09-29: 完整候选贯通 ClickTarget（单动作、左键、具体 ref）、原生观察缓存与真实生成 ABI。坐标/拖拽不改。v1 GUI distant/move 通过，replace 零输入但错误为 native_fault，失败保留在 `/tmp/epi-pointer-boundary.PFHOUz/native-target-gui1-replace/result.json`。
- 2026-09-29: replacement guard 改为先在 live tree 证明成员，再查询 retained handle 的 AXWindow；移除旧 handle 优先查询。另发现桥接未允许 pointer_hit_changed 等固定安全分类，新增失败后通过的分类回归；含私有详情的字符串仍脱敏。
- 2026-09-29: v2/v3 distant 误拒绝 target_occluded。纯测试复现候选 z_index 比较方向写反，修正为 higher-is-front；v4 原有六例及 window-cover 通过，但 window-behind 仍失败。失败样本均未丢弃。
- 2026-09-29: 诊断5c 在同一时刻读取 CG 全部窗口与可见窗口：other 8852 / target 8842 在 all 中顺序 0/5，在 visible 中为 19/18；原生记录 other z238 > target z233。证实全部窗口目录不能作为该用例的可见遮挡顺序。新分支改用 on-screen 全层级枚举，保留 Space、身份和几何验证；原坐标/拖拽路径不变。诊断代码已从源码撤除，诊断产物不得安装。
- 2026-09-29: v6 native `5cd76a602dc7c48f8eef26055559d281a4451b2e35225204b863f01ac1d0b739`，bridge `9eaca8676322c237077fbe3c17f0e603f1fd8334a5c4eaf0219f9bfbcc0f07e2`，patch `223ff26143c9b56555579752ba425691b650baf80faa02ddc053c2ac18e70f15`。`native-target-gui6-{window-behind,window-cover,distant,move,replace,cover,transparent-cover,reorder-cover}/result.json` 八例全通过；clean lease 0915..091c。正例各一次点击，六负例均零点击。产物位于 `/tmp/epi-pointer-boundary.PFHOUz/native-target-package6`，单独验证、未安装。
- 2026-09-29: 最新 canonical generate 和 --check 通过，Rust segment 30/30、TS schema/codec/projection 27/27、tool integration 21/21。integration 新测试最初误用已经消耗的 image ref，按真实消费契约重新 capture 后通过；没有修改产品去适配错误测试。安装 bridge a28cd243/native a1f1aea2 再次核对未变。

- 2026-09-29: 最终 npm run check exit 0；复核并撤回四个无关 formatter 文件变动。48 项 TS 测试整体重跑通过。T-002 -> done；T-003 coordinator -> in_progress，下一步为实际模型入口预算验证和独立候选 Chrome 模型 smoke，不安装。

- 2026-09-29: 请求预算入口集成已通过；候选提交 538d9f4cd。v6 真实模型两例一过一败，失败保留。Chrome 最小对照确认 AXLink 的实时 hit 是原有直接 AXStaticText 子节点，指定文本则成功。用户已授权受限子节点支持；T-004 开始，T-003 因资格依赖转 blocked，持续 Goal 仍 active。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001 完成；v6 动作候选贯通原生 ABI，最新 Rust segment 30/30、TS 48/48、真实 GUI 8/8，补丁可应用；旧引用/跨窗口/取消有工具层集成验证。安装版未改动。
- Limitations: 真实模型标签任务失败，T-004 受限子节点实施中；T-003 待其验证后恢复。指针移动后竞态和可比速度仍未完成，持续 Goal 保持 active。安装门槛未满足。
