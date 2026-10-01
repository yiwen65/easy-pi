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
- Blocker: v23 修复只读缓存就绪时序并通过33项Chrome及8项AppKit回归；真实模型表单受遮挡后耗尽轮数，导航页面空白，尚未达到安装门槛。
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
- Validation evidence: v23 补充同快照隐藏直接文字缓存及有界只读就绪；cache所有权7项此前通过，最新segment31/31、就绪4/4、native加载TS55/55、ABI及根检查通过。Chrome33/33（含21次按钮正例）、AppKit8/8，负例零输入且全部正常退出、clean lease。真实模型表单/导航仍失败，历史失败保留；不得安装。完整路径与哈希见执行日志。
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

- 2026-09-29: v8 子节点候选独立 Chrome 八项中六项达到严格 oracle，按钮与覆盖仍失败；所有计数均无错误目标点击。diagnostic9 排除 first_hit 比较，diagnostic10 证明命中不在树、缓存无子节点，diagnostic11 证明命中为 AXStaticText，rect [157,355,46,16]。匹配 Chrome 153.0.8010.52 的 Chromium `BrowserAccessibility::IsLeaf` 明确隐藏唯一文本子节点（https://raw.githubusercontent.com/chromium/chromium/153.0.8010.52/ui/accessibility/platform/browser_accessibility.cc）。主干 `CachingAsyncHitTest` 使用缓存/近似同步结果并触发异步真实命中；这解释覆盖先移动后拒绝的可能机制，尚未以本地时序证明，不能声称根因已完全闭环。
- 2026-09-29: diagnostic9/10/11 只用于定位，未安装。诊断日志已从工作源撤回，target_click.rs 与 v8 冻结源 SHA256 同为 35c6434e41f8a4de8507b457b43cc0aaf20f44e3a7f79cfb26f84d846310cb28。根 npm run check exit 0；四个无关 formatter 差异已撤回。下一步只读验证观察阶段是否能取得隐藏文本的原始身份/直接父关系，不能直接放行未观察节点，也不能通过重复命中或固定等待宣称遮挡可靠。

- 2026-09-29: diagnostic12 实测 AXTitleUIElement 无值，AXChildren / AXChildrenInNavigationOrder / AXVisibleChildren 均为空。diagnostic13 仅连续读取32次命中、无鼠标移动/点击：button 在 sample3/2371us 从原按钮转为 AXStaticText，AXParent 与原按钮 CFEqual；cover 在 sample4/1227us 从原链接文本转为别的父节点。原始追踪分别保存为 `native-target-child-diagnostic13-{button,cover}/native-read-trace.txt`。这些只读强制拒绝构建不计产品测试通过。
- 2026-09-29: v14 将一次只读命中预查询放在现有树校验之前，结果立即释放、不作为放行证据；最终命中检查仍保留，无固定等待/输入重试，不声称异步结果具有确定新鲜度。原生31/31、桥接48/48；Chrome链接/单选及五负例通过，cover两次均在移动前拒绝；AppKit原有8/8通过。native ef424a8390425aef0f193daf05d0c0a960e360054eae8c8b0a045bc7823928ad，patch16a6fba599c908a89cd0f748297f1cb74268a3b2d675889072390a37f6a57e3a，补丁应用检查通过。按钮限制仍存在；用户新的隐藏节点观察补充提案尚待回复。真实模型 click-tab-2 正在独立诊断，不作为安装授权替代。

- 2026-09-29: v14 真实模型 click-tab-2 仍失败，64.38s/9轮、reported cost 0.0701396 USD，cleanup/clean lease0943。首次 target 点击被 target_occluded 拒绝，而非文字子节点错误；随后模型两次坐标回退耗尽恢复预算。保留 `/tmp/epi-pointer-boundary.PFHOUz/native-target-model14/summary.json`，不能算性能提升。
- 2026-09-29: diagnostic15 将最小链接放到相同上方坐标(171,311)，复现窗口级拒绝；可见遮挡窗口9503、PID72727、layer0、rect(22,39,800,727)，ps验证进程为LocalSend。未关闭或修改它。`native-target-upper-diagnostic15-link/native-occlusion-trace.txt` 留存。此例拒绝正确，窗口截图不显示外部遮挡，模型盲目坐标回退。
- 2026-09-29: 使用已有显式 window/activate 动作：刚select后立即激活报 foreground_focus_unproved，零点击并正常清理（`native-target-upper-diagnostic15-activate`）；等待真实网页AX目标出现后，在新进程/新租约中仅激活一次，再observe和点击，相同位置成功（`native-target-upper-diagnostic15-ready-activate`、lease0946）。没有重放未知动作。下一步补 target_occluded 的有条件恢复提示及工具回归，再跑真实模型；启动早期激活未知另保留为待排查，不靠固定等待/放宽焦点证明掩盖。diagnostic15日志已撤回，安装版未改。

- 2026-09-29: v16 模型仍失败（59.35s/12轮，cost0.0550632 USD），模型误用 Image ref 激活；修正恢复提示明确先 observe、使用 Observation ref。diagnostic17 中模型随后正确激活，两个页内标签点击均已派发并切换，但选取无名 AXGroup 行45而非 Tempor AXStaticText 行46，pointer_hit_changed 后两次坐标重试耗尽预算。该样本90.39s/18轮、cost0.1164084 USD，cleanup=true、clean0949，不计成功。
- 2026-09-29: 最小 span.onclick 夹具直接指定原有 AXStaticText 成功一次点击，零覆盖点击，clean094a，证据 `native-target-text17/result.json`。未放宽任意 AXGroup 或隐藏子节点规则。针对 pointer_hit_changed 新增有条件的新观察/精确目标选择提示；先见回归失败，再修复后28/28通过。target_occluded 的新观察激活提示一并提交 `1b54a8d8b`。根 npm run check exit0，无关四文件格式化已撤回。
- 2026-09-29: 撤除全部临时遮挡日志并重建，v18 native恢复为ef424a83、patch16a6fba5，与v14原生一致。v18真实模型在55.36s中断（不是180s超时证据），cost0.0611416 USD，cleanup=true、CfT正常退出、clean094b；结果保留为失败/中断，不重分类为成功。确认进程句柄已不存在且租约干净后，启动独立v18b复测；当前安装版仍未改变。

- 2026-09-29: v18b 真实模型通过 click-tab-2，独立oracle done=true/rawReward=1，76.35s/16轮，model74.50s/tool1.79s，cost0.0746276 USD，clean094c。真实轨迹包含旧image误用、坐标拒绝及旧intent效果未知，最后显式reconcile后使用AXStaticText46完成；此次未触发pointer_hit_changed新提示，因此不能将通过因果归于该提示。安装版三哈希再次验证未变。下一步针对已证实可点击的AXStaticText补充模型schema说明，以减少不必要坐标回退；不改原生保护或续期预算。
- 2026-09-29: v19仅修改目标点击schema说明，明确已观察可见文本可作为意图目标；没有新字段/自动选择/身份放宽。schema13/13、根npm run check通过，无关formatter差异撤回。独立v19模型复测已启动，结果未出；本变更仍待行为评估。

- 2026-09-29: v19标签任务通过（done=true/rawReward=1），38.14s/9轮，model34.97s/tool3.14s，cost0.0714264 USD；三次输入全为target.ref，无坐标回退/拒绝，正常关闭、clean094d。schema说明提交 `af7f489e7`，55项TS定点重跑全过，根检查通过。与v18b单次76.35s不同，不能据此宣称稳定快一倍；已启动同版本标签重复+scroll-text两例串行回归，独立输出 `native-target-model19-repeat-scroll`。按钮隐藏子节点仍待授权/修复，未安装。

- 2026-09-29: v19重复标签再次通过，仍9轮但85.66s（model84.40s/tool1.24s），不能宣称稳定耗时改善；scroll-text也通过，70.19s/15轮（model68.32s/tool1.83s），其中Submit原生点击仍pointer_hit_changed，模型使用已有focus+Space完成，不能算按钮点击缺陷修复。两例done=true/rawReward=1，cost合计0.1905528 USD，正常退出、clean094e/094f。下一轮继续Chrome表单/导航/弹窗场景；隐藏文本观察补充仍待明确授权，不安装，Goal保持active。

- 2026-09-29: 用户已明确批准受限观察补充：按钮中心命中的直接AXStaticText可在观察时缓存，即使AXChildren未列出；点击仍验证原始父子身份、几何、关系及遮挡，新增/替换/移动负例与真实模型通过前不安装。T-004继续实施，仅复用现有快照owner，不发布隐藏节点的新模型引用、不新增生命周期。扩展前v19 Chrome表单失败于Submit命中、导航靠键盘通过、dialog触及180s截止；三例全部正常关闭，保留原结果，随后停止该旧候选的同类付费重试。

- 2026-09-29: v20 候选 native SHA256 `bbe7e0dc2640dedc4a14f7a0f217ba64e15630c19dd95ea2f448aaabd96b74ff`，bridge `f925d375efa460669d8c31dfca692753e5216a6d6b697733ace5bdcf5de64799`，补丁 `e3b1d6af85adffb2f72a35a18e2b73d523b806da197ef85ff0b9a47508217421`。补丁应用检查、ABI check、TS55、cache7通过。Chrome 13项输出 `native-target-child20b-*`（clean0954–0960），另有按钮独立正例 clean0953；AppKit8项 `native-target-gui20-*`（clean0961–0968）全部通过，替换、移动、覆盖、新增文本均零输入。路径均在 `/tmp/epi-pointer-boundary.PFHOUz/`。
- 2026-09-29: SDK全组snapshot生命周期首次0/5：旧native夹具缺少built-in cache注册，随后共享锁中毒使其他项连带失败。历史独立未修改基线已复现同因（见 `native/computer/patches/target-region-candidate.md`），不改生产注册来迎合旧夹具。隔离重跑 `snapshot_lifecycle_tests::sdk_ -- --test-threads=1` 2/2通过；三项旧native夹具仍未通过。模型评估器metrics/lifecycle/tasks共16/16通过。已启动v20真实模型三项，结果待收集；未安装。

- 2026-09-29: v20真实模型三项结束（`native-target-model20-chrome/summary.json`）：form在180.00s/13轮截止，model178.07s、tool1.887s，尚未发出Submit点击，不能判定按钮修复失败或成功；navigation在24.83s/3轮因provider_error结束，尚未输入；dialog通过40.72s/8轮，model39.66s、tool1.030s，Open与Confirm均使用target.ref且无拒绝，独立回执comment精确为`approved 你好`。三项cleanup=true、clean0969–096b，reported cost合计0.1768024 USD；1/3通过，全部失败保留，不安装。根`npm run check`完整通过；已撤回四个无关文件的formatter副作用。

- 2026-09-29: 根格式化后的按钮单独正例再次失败：`native-target-child20-formatted-button/result.json`，同一native/bridge哈希，pointer_hit_changed、inputCommitted=false、clicks=0，正常关闭clean096c。此前13/13不能代表稳定修复；停止新增付费样本，v20仍禁止安装。下一步单独diagnostic21只记录观察命中是否已有/缓存、点击命中父节点或缓存子节点的布尔值，不记录UI正文、不放宽输入门槛；生产候选补丁不包含该诊断代码。

- 2026-09-29: diagnostic21在独立新窗口连续8例中7过1失败（`native-target-diagnostic21-button-0`至`-7`，clean096d–0974）。通过轨迹均为观察known=false/cached=true，点击两次检查hidden=true/cached_child_hit=true；第7号失败轨迹为观察known=true（命中已有树节点，未缓存隐藏子节点），随后点击hidden=false/parent_hit=false/cached_child_hit=false，零输入。首次分歧已定位到观察漏缓存，不能把之后的正确拒绝删掉；下一步针对异步只读命中就绪做可取消、限时、无输入重放的实验，先验证是否需要等待及成本，不增加无条件sleep。诊断版native `022dd623acca72b255d24f9012521e06e1a321c6e94190319b4734136b88c6e9`；其补丁单独在临时目录，不进入生产候选补丁。Chromium官方源码说明CachingAsyncHitTest会立即返回近似值并异步更新缓存：[接口说明](https://chromium.googlesource.com/chromium/src/+/464f9d90f102390b2af873421bf9a2ae879dd1da/content/browser/accessibility/browser_accessibility_manager.h)。该历史源码支持机制解释，不是本机153版本的精确时序保证。

- 2026-09-29: diagnostic22第1号新窗口复现漏缓存：首次known=true且initial_parent=true，只读等待后第1次读（1684µs）得到direct_child=true；诊断仍故意保留原缓存缺失，点击零输入拒绝，clean0976。v23据此只在leaf web按钮仍命中自身时做可取消只读就绪轮询，间隔至多1ms、between-read settling budget10ms，已经命中子节点零等待；超时仍不缓存，不重放输入，点击校验完全不变。已移除所有诊断输出。
- 2026-09-29: v23补丁应用检查、ABI check、Rust新增就绪4/4、原segment31/31、真实native加载TS55/55通过。Chrome 33/33（21个独立按钮正例+链接/单选+10负例，clean0977–0997），AppKit8/8（clean0998–099f）；均正常关闭。证据`/tmp/epi-pointer-boundary.PFHOUz/native-target-child23-*`与`native-target-gui23-*`。native SHA256 `fbf69abaee3b1c5ee75b0781c7d99b636cd5da8beef3dfebb3a380a646fce2b1`，patch `514a4f0c7abf15294b51b934b31560378f83b339a73bd3463699ca0d945207b7`。根检查与真实模型资格继续；旧候选失败不删除，仍未安装。

- 2026-09-29: v23根`npm run check`完整通过，四个无关formatter修改已撤回；真实模型`native-target-model23-chrome`两项0/2、cleanup全真、clean09a0/09a1。form114.04s/24轮，model110.84s/tool3.068s，已得到精确正确oracle但未在轮数内正常结束，故仍失败；Submit两次target_occluded，显式activate后仍遮挡，最后focus+Space提交。此前City读回一度为`Hangzhou..`，来源未证实，模型修正后oracle正确。navigation39.56s/9轮，model38.52s/tool1.016s，发出GET /records，最终截图仍白页，无业务oracle；不是pointer_hit_changed。两项reported cost合计0.3143588 USD，不归因于已修复的缓存漏读，不删除失败、不增加轮数换绿。下一步区分可见遮挡、Chrome绘制/页面状态和模型预算；不关闭个人应用、不放宽点击保护。安装版未动。

- 2026-10-01: 原临时目录 `/tmp/epi-pointer-boundary.PFHOUz` 已不存在，以上结果保留为历史记录，不声称原始运行文件仍可访问。v23冻结候选仍在，后续实验改存 `.artifacts/computer/navigation-paint.eCQmJA/`；安装版未替换。独立前台、后台不遮挡和关闭后只读诊断三项通过（foreground-1、background-1、diagnostic-close-1，clean09a7–09a9），实际截图及页面内容正常；后台状态本身未复现白页。
- 2026-10-01: 评估器补充失败后只读页面状态：仅native正常排空后读取精确loopback origin，文本最多4096字符，不交给模型、不改变oracle、不重放输入；耗时计入cleanup。修正本地轮数耗尽被误分类为provider_error，实际Agent预算回归先失败后通过，限额不变。chrome/metrics/lifecycle/tasks共19/19，完整根检查exit0，已撤回无关formatter差异。
- 2026-10-01: v23真实模型导航再次失败（model-navigation-1）：31.547s/9轮，model30.872s/tool0.648s，reported cost0.0719588 USD，cleanup=true、clean09aa。两次target点击均因遮挡零输入拒绝，中间显式activate确认焦点后仍拒绝；新增诊断证明页面仍在根路径、正文正常、未请求records，此次不是白页问题。
- 2026-10-01: owned AppKit覆盖窗口的确定性对照covered-activation-1复现：首次点击正确拒绝；显式activate返回confirmed，页面焦点立即及3秒后均为true，但新观察点击仍target_occluded且零输入。全部正常退出、clean09ab。源码取得keyboard focus后跳过AXRaise，支持“焦点不等于置顶”的原因；受限显式置顶候选已单独询问，未修改自动填入/按键策略或安装产物。
- 2026-10-01: 已安装版导航原生alert回归installed-alerts-1共7/7、cleanup全真：无弹窗及0/10/100ms延迟场景均在限时内结束，弹窗保持opened，未静默关闭。导航约25.5–49.4ms，普通观察55.3ms，弹窗后拒绝约0.27–0.41ms。这是安装版保护/排空回归，不是v23发布资格或主流benchmark全覆盖。

- 2026-10-01: 评估器修复与上述证据提交`5445ad7cd`。尝试同脚本验证v23原生alert时，在创建host之前被固定安装版SDK pins拒绝（Native input integrity mismatch）；未启动GUI、不计候选回归通过，也未改写安装版pins。候选后续需使用经过完整候选manifest验证的独立测试加载入口，不能绕过完整性检查。显式置顶及网页值确认两项受限行为变更仍待用户确认。

<!-- task-doc-section:final-validation -->
### 2026-10-01 continued qualification

- 新证据根目录为 `.artifacts/computer/navigation-paint.eCQmJA/`，下列路径均相对于它。v23 独立加载器校验冻结 manifest、SDK/runtime/NAPI/native/renderer pins；安装版 loader 和 pins 未修改。后补所有 SDK/CJS 文件逐文件验证，旧运行仍保留原加载器副本，不倒推验证范围。
- v23 确定性回归共 47/47：`candidate23-alerts-2` 7/7、`candidate23-select-1` 15/15、`candidate23-general-1` 14/14、`candidate23-dialog-1` 11/11。包含原生 alert 保持打开、select 精确 index/事件计数、通用输入及 stale/cancel、dialog 外部/替换/移动等负例；全部正常排空并 clean lease。不是完整主流 benchmark 总分。
- v23 真实模型共 10 次尝试、8 次业务通过、2 次失败，reported cost 合计 0.3729272 USD。browser form/navigation/dialog 3/3（70.411/25.417/19.934s），seed43 browser choose-list/click-tab-2 2/2；desktop seed43 和 seed42 click-test-2 均通过，seed42 enter-text/checkboxes/login 1/3。原始轨迹和全部失败分别保存在 `candidate23-model-browser-1`、`candidate23-miniwob43-browser-1`、`candidate23-miniwob43-desktop-1`、`candidate23-miniwob42-desktop-1`、`candidate23-miniwob42-desktop-fields-1`。
- seed43 desktop click-test-2 的两次 pointer_hit_changed 不是隐藏文字缓存修复失败：`miniwob43-layout-1/result.json` 只读对照证明 TWO 覆盖 ONE 中心，真实命中为 TWO，拒绝正确；最后已有 focus+Space 完成。seed42 desktop 16.421s/5轮、一次 AXButton ONE target.ref 真正派发、rawReward=1、无坐标或键盘回退，clean09ea，提供该按钮路径的真实模型正例；不同布局不能作为可比提速证据。
- enter-text 在输入前 provider_websocket_error，137.100s/4轮，保留失败；checkboxes 25.729s/7轮通过；login 43.218s/13轮失败，先触及独立 web fill 边界，随后密码字段 target_not_editable，模型再试旧像素输入。密码写入限制是有意保护，不删除它来使 benchmark 变绿。
- login 首次因果分歧：原生 Data 已读 AXSubrole 且跳过 secure AXValue，但 WindowElement ABI 和模型投影丢失 subrole，使模型只看到普通 AXTextField。新增只读 `native-subrole-observation-candidate.patch`（相对冻结 v23），不改变输入/权限/缓存授权。Rust secure metadata 回归先因缺失 subtype 失败，再 4/4；contract 新回归 1/1；TS 投影先失败，再 projection/filter/schema 20/20。新 ABI 必须真实再生成，不手改生成结果。
- 两次 release 生成在 zerofrom_derive E0463 失败，包括空 release 目录，故撤回旧缓存根因推断。本机 dlopen 对旧 dylib 明确报 mis-aligned LINKEDIT string pool；只设置 CARGO_PROFILE_RELEASE_STRIP=none 后同依赖 release 编译及 dlopen 通过。符合 [Rust 上游问题 157750](https://github.com/rust-lang/rust/issues/157750)。此构建绕行只在独立候选环境，未更改生产工具链、优化级别或权限。失败缓存保留。
- 新 canonical TS/Python 生成、重复 --check、SDK computer TS emit 和匹配 SDK 类型检查通过。新隔离候选 native SHA256 `143b64cb4d84f2c815f41a0cfca6066eb4e892defa05392b81d43a4988c881e7`，manifest `7dd31dd79871e5646491c8de55d64c61045b8d42fdd7787d65a0ea3860e72c5a`，bridge `2e629a60e98ba99733300c59f15ae1da91b0a2c355d1999f1aca5db6d37bb317`；不安装。
- `subrole-gui-1` 因等待不足未见网页树失败；`subrole-gui-2` 的过早 activate 产生 foreground_focus_unproved/inputCommitted=true，后续 fill 被 previous_intent_unresolved 阻断，不重放。移除夹具多余激活并按页面树就绪读回，`subrole-gui-3` 通过：模型观察包含 AXSecureTextField、无密码值，真实 fill 仍 target_not_editable/inputCommitted=false，独立页面值未变、input/change 零次，Chrome 正常退出、clean09f0。两次失败保留，不改 oracle；登录业务仍不支持。
- `subrole-model-fields-1` 真实模型两项 1/2，cost0.0931476 USD，全部正常关闭、clean09f1/09f2。enter-text 22.934s/6轮、model22.302s/tool0.617s、rawReward=1；login 14.913s/4轮、model14.629s/tool0.274s，读取 secure subtype 后准确报告不支持并结束，零输入/拒绝/坐标回退。login 仍按独立业务 oracle 计失败，不伪造成功；较旧43.218s/13轮样本减少徒劳尝试，但仅一次对照，不宣称稳定速度倍率。
- readonly subtype 补丁 SHA256 `6152027dc6875bf3669f504595c4bf0c1f3b4e914325ced19d67e0997d3773f6`，根检查完整通过；匹配 SDK 类型检查、TS20项再运行通过。安装版 bridge/native 哈希仍为 a28cd243/a1f1aea2，未安装新候选。全树 diff check 仅发现用户既有 LEARNS.md EOF 空行；本批次明确路径 diff check 通过，不动用户日志。
- readonly subtype 候选邻域回归：`subrole-select-1` 15/15；`subrole-alerts-1` 7/7，导航约28–42ms，alert后观察拒绝约0.48–0.63ms，弹窗未静默关闭。`subrole-dialog-1` 10/11：second 项在 navigate 后的窗口证明阶段 browser_window_unproved（inputCommitted=true），尚未进入多弹窗断言，页面 writes=0；正常排空，未知导航不重放。独立新会话 second 只读数值诊断 `subrole-dialog-second-diagnostic-1` 5/5，不能将无法重现解释为已修复；该间歇拒绝仍开放，不改变身份/几何门槛。所有 owner 正常关闭，最后 clean0a18。

### 2026-10-02 model wait budget

- `subrole-model-browser-general-1` 两次真实模型尝试 1/2，cost0.0431932 USD：dynamic 在 171.629s/6轮发生 provider_websocket_error，model168.466s/tool3.150s，尚未通过业务 oracle；scroll 16.835s/4轮通过，model14.182s/tool2.646s。无工具拒绝，全部正常排空、clean0a19/0a1a。远端或网络错误的根因未证实。
- 已证实评估器配置分歧：configureHttpDispatcher(30_000) 只配置 HTTP，createAgentSession 仍按 SettingsManager 默认300_000传入模型 timeoutMs；WebSocket 等待不采用先前 HTTP dispatcher 设置。仅在评测 meteredStream 明确传入 idle30_000/connect15_000，仍 maxRetries=0，不改生产默认、不自动重放。增加逐请求耗时 ledger 和固定 provider_idle_timeout 分类，禁止保留原始敏感错误载荷。参考 [官方 WebSocket 指南](https://developers.openai.com/api/docs/guides/websocket-mode)，其中连接生命周期不是本地空闲预算；不将文档当作171秒错误根因证据。
- 回归先3/6、后6/6；实际 Agent 调用断言请求确实收到两项预算，逐轮数组复制及失败分类通过；相关评估器19/19。完整根 npm run check exit0，四个无关 formatter 改动已撤回，明确路径 diff check 通过。
- 新协议实测 `subrole-model-browser-dynamic-bounded-1` 1/1：43.145s/11轮，model39.360s/tool3.761s，cost0.0758136 USD。独立 oracle 核对 R-101/R-204/R-305 顺序、各自不同的中文 note 和 Pro，正常退出、clean0a1b。逐轮请求2.918–5.214s，未触发新空闲期限；因此这次成功不能归因于超时修复，也不能宣称网络故障已解决。新旧超时协议不同，不能混合计算提速倍率；历史失败继续计入各自分母。
- 请求预算及逐轮 ledger 已提交 `7c2ed55d8`。现有 provider 的本地模拟连接超时、首事件前空闲、流开始后空闲三项定向测试 3/3；流开始后超时不回退重放。新的整组数值诊断 `subrole-dialog-diagnostic-2` 11/11、正常关闭，仍不能宣称先前间歇窗口拒绝已修复。
- `subrole-model-desktop-motion-1` 三项 1/3、cost0.1777 USD，全部正常关闭、clean0a27/0a28/0a29。drag-box 40.662s/9轮失败：三次拖拽均 stale_image_observation/inputCommitted=false，随后 recovery_exhausted；scroll-text 39.809s/10轮通过（focus+Cmd-End、填入末词、target.ref提交），rawReward=1，此样本不是滚轮通道资格；click-tab-2 44.766s/5轮因 provider_idle_timeout 失败，最后单轮30.848s，零工具拒绝。所有失败保留在分母。
- 只读 ImageIO 解码比较 drag-box 的 image5→6、image6→7：2048×1582、分别616和282个变化像素，变化包围盒分别[443,383,475,407]/[456,383,474,407]，仅在远处倒计时数字，拖动起终点未变。源码 segment 首动作仍调用整图 revalidate，说明原保护与该动态场景不兼容；尚未证明完整拖拽局部校验安全，已请求完整路径走廊候选授权，未放宽拖拽或坐标点击保护。比较器仅在证据目录读取既有截图，无截图编辑。
- 传输单变量探索：冻结 seed42/model/subtype candidate/任务/独立 oracle，只在隔离脚本选择 sse；`subrole-model-desktop-tab-sse-1` 1/1，154.638s/9轮，model153.627s/tool0.976s，cost0.0624452 USD、rawReward=1、clean0a2a。不能将通过解释为 WebSocket 根因或 SSE 提速，模型决策与网络噪声尚未控制。独立默认传输回测 `subrole-model-desktop-tab-auto-2` 49.477s/12轮业务失败、cost0.092848 USD、clean0a2b：两次AX观察无网页行，模型转为截图点击，四次整图过期拒绝，零点击派发、无provider错误。SSE脚本和所有源码已冻结到该运行 sources，工作树临时脚本已删除；生产传输不改。
- 只读就绪探针 `subrole-readiness-1`：静态自有页面DOM已加载后，第一原生观察45行/零web行；100ms间隔读回约2.019s后出现59行/8个web行，零输入、正常关闭、clean0a2c。nativeComplete只表示本次AXChildren读取完整，不表示渲染器网页树已就绪；不可改称不存在控件。此实验只证明延迟存在，尚不能区分启用属性、Chromium异步树或更早读取触发的因果；不加入无条件长等待或重试输入。
- 后续就绪对照：默认新进程 `subrole-readiness-2` 约2.085s出现网页；只在隔离启动添加 force-renderer-accessibility 的 `subrole-readiness-forced-1/2` 两次均首次观察59行/8个web行，正常关闭、clean0a2d/0a2e/0a2f。此 flag 是 [Chromium 原生支持的诊断开关](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/accessibility/accessibility_switches.cc)，改变了冷启动条件，不将其作为默认产品修复或可比模型提速。
- 非替代修复：`subrole-readiness-role-1` 在首次工具调用前只读同一新拥有PID的AXApplication角色，读取成功且权限未提示；仍约2.036s才出现网页，正常退出、clean0a30。仅补读AXRole不能消除网页树延迟。
- 捕获启用返回码与真实副作用的首次分歧：`ax-enablement-role-1` 仅只读应用角色/角色树，30次读取4.092s无AXWebArea、零读取错误；独立新进程 `ax-enablement-enhanced-1` 仅额外设置现有 prepare 已使用的 AXEnhancedUserInterface=true，返回 -25208（NotImplemented），却在约2.035s出现AXWebArea，零读取错误。两者均只操作新创建测试Chrome、未读字段内容/生成输入、正常关闭，native lease维持clean0a30。因此 Native.prepare 的“unsupported setter没有变化”不能推广到这条Chrome路径；Cocoa已验证的无副作用优化也不能因此一律移除。
- [Chromium 当前源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/chrome_browser_application_mac.mm) 的 Enhanced setter 先安排两秒 debounce，再调用 super返回；角色读取在新macOS仅请求NativeAPIs，不等于网页完整树。与本机对照吻合，但153.0.8010.52精确tag未能通过网页工具获取，不冒充逐行版本匹配证据。下一步只做可取消、有界、不会重设debounce的读取就绪候选及Cocoa不退化对照；尚未修改或安装Native.prepare。
- 最小夹具修复：只有受控桌面评测 launchChrome 的空CfT启动参数增加 force-renderer-accessibility；没有修改安装包、个人浏览器、Native.prepare或输入保护。contract新增launcherSha256和forceRendererAccessibility，明确与旧按需启用协议分开。相关模型夹具19/19、完整根check exit0，四个无关formatter改动已撤回；其他会话新TUI改动保持原样。
- 新夹具协议真实模型 `subrole-model-desktop-tab-preenabled-1` seed42 1/1：首次select已有47个网页行，三次target.ref点击真实派发，rawReward=1，26.254s/8轮，model25.341s/tool0.888s，cost0.0496556 USD，正常关闭、clean0a31。相邻 `subrole-model-desktop-preenabled-neighbors-1` seed43 2/2：choose-list 30.650s/9轮、rawReward=1（保留一次target_geometry_unknown拒绝，不记无拒绝资格）；click-tab-2 18.611s/6轮、rawReward=1、零拒绝。cost合计0.0866656 USD，正常关闭、clean0a32/0a33。共3/3不是长期稳定率，不跨种子/协议/传输计算倍率。
- 最新安装版bridge/native哈希仍a28cd243/a1f1aea2，未安装候选。通用既有Chrome冷启动AX就绪与拖拽整图校验仍开放；夹具预启用只解决可控评测启动条件，不冒充所有应用已修复。下一轮优先验证移动后窗口命中竞态和更精简观察是否保留通用能力；受限拖拽候选仍等授权，不默默放宽。

## Final validation result

- Result: partial
- Evidence: T-001 完成；v23 Rust segment31/31、就绪4/4、TS55/55、Chrome33/33及AppKit8/8、ABI与根检查通过。已定位并修复v20间歇漏缓存；新证据包括v23确定性47/47、真实模型8/10及只读subtype真实生成和独立验证。动态表单最新单次通过，旧失败全部保留；补丁可应用，未安装。
- Limitations: 安全密码输入仍不支持；显式激活取得焦点却未置顶已复现，受限修复待确认；browser_window_unproved间歇导航拒绝仍未定位，provider错误底层原因未证实；历史导航白页尚未复现。三项旧native生命周期夹具仍失败，不冒充通过。指针移动后竞态和可比速度仍未完成，持续 Goal 保持 active。安装门槛未满足。
