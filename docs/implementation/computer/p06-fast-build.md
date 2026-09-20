# P06 原生快速构建与类型化通路证据

状态唯一来源：[任务记录](../../tasks/2026-09-18-computer-native-implementation-task.md)。本页索引实现、验证和限制，不是另一份任务清单。

## 固定候选

- 独立源码：`.artifacts/computer/p06-trim/upstream/libs/cua-driver`；原已资格 P06/C145 源和产物未改。
- 增量补丁：`native/computer/patches/p06-fast.patch`，**在 qualified P06 discovery 源之后应用**，不与早期 trim 候选叠加。
- SHA256：`a37c8c2998757b4841a07b4fbb460e416b41a01a8be0b8100ec0f3a12a9f740f`；34 源路径（31 Rust/manifest、3 TS 入口/配置），81 产物/运行时 pins。
- 当前 generated/staged SDK 属于 `transport-hostfixed`，必须使用同名前缀 loader/pins/inputs。initial、history 和首版 transport 候选是历史输入，不能混用。
- Rust 1.97.1，原锁定缓存、locked/offline；无主仓库依赖或锁文件变化。未手写生成 FFI。
- 独立 Git 根正向 apply、逐字节比较、反向恢复通过。实验补丁及说明两文件提交：`eb70233adecf14c563f759d56072c1cdeebcf7ca`；未 push。

## 真实编译保留/排除

| 边界 | fast 构建 | 验证 |
| --- | --- | --- |
| MCP dispatcher/skills/wire、daemon socket/pipe client | 不编译 | active Cargo feature/depfile；legacy 对照测试 |
| SDK embedded daemon launcher/private-worker/service/remote carriers | 不编译 | depfile；生成 API 与符号不存在相应 constructors |
| recording/replay/video/FFmpeg/installer/cursor sampler/PiP hooks | 不编译 | core/platform active depfile |
| 独立 encrypted history/key provider | 不编译 | core/platform depfile；legacy 私有内存 key 回环 |
| AppKit/shared cursor renderer、PiP、clipboard、browser TLS | 实现不编译/依赖不进入闭包 | 前序 slice 和最终闭包验证 |
| 共享结果、metadata、session/client 分类、ActionCompletion | 保留真实共享实现 | 数据/分类测试；没有 transport stub |
| 共享 cursor 配置/命令类型 | 保留 | 不是删除整个 cursor crate；无可见 overlay 假成功 |
| canonical policy/manifest/授权/撤权、owned browser CDP、输入守卫、焦点清理 | 保留 | active depfile、受控测试及 GUI 邻接 |
| ScreenCaptureKit still capture | 保留 | depfile、真实 PNG/geometry oracle |

Core legacy defaults 与 CLI 对照保留原设施；SDK fast defaults 为空。不要把 CLI 和 fast SDK 在同一 Cargo invocation 构建后宣称 feature 未合并。

真实 Computer TS 入口是 `dist/computer.js` / `./computer` 子入口；不执行旧根入口对已裁 transport constructors 的赋值。传统 TS/Electron/Fleet 打包不是此 profile 的回退。产品激活和可选安装包归 P07，未切换旧 P04 loader 或 desktop 的 untrimmed P06 pins。

## 离线、生成与宿主验证

证据根 `.artifacts/computer/p06-trim/`；每项有完整 `.log`、`.exit`、`-command.json`。

- fast SDK controlled **59**，core controlled **78**、authorization **45**、protocol **9**、daemon metadata **5**、shared observation **12**；platform controlled **85 + 1 显式 benchmark ignore**。
- 独立 completion enum **1**；legacy fake remote **20**、receiver **14**、worker **1**、daemon 相关 **9**；legacy CLI check 与 SDK test compile-only 通过。没有运行可能创建通用桌面 runtime 的全套 upstream tests。
- genuine generation / `--check`、N-API staging、C header、Computer TS 均通过。无 host 实际 load 验证 transport constructors 缺失、ArrayBuffer/bigint 工厂保持类型；不将合成 bytes 当真实 PNG 或 native buffer 回收证明。
- 首轮宿主 strict 类型发现 curated exports 漏了两个 escalation enum；原失败保留，补真实枚举导出后两层 native/root-graph 类型检查通过，genuine-value + fake desktop **19/19**。
- 主树隔离 `transport-trim-current-check`：完整 `npm run check` **0**，1410 files、无 formatter 修复；host **193 pass + 5 skips**、controller **38/38**，source/snapshot drift **0**。
- 原 untrimmed P06 的真实 buffer 实验仍证明：native close/destroy 后消费者持有的两个 ArrayBuffer 字节不变，释放 consumer 引用后两个 WeakRef 回收。trim 未改 carrier/生成 runtime 实现；不扩张为零拷贝、内存擦除或全进程无泄漏。

## 真实 GUI 邻接

所有行动进程重新验证 console、TCC 责任链、专用 fixture/Stop 控制面；输入轮次 fresh passive quiet，保留 runtime 输入冲突门禁。临时 caffeinate 随所属任务结束，不改持久电源设置。

- discovery 正向 + stale selection/画面变化/sibling/modal/preabort：**156 raw、32 terminal、12 自然退出**，C146–C151；Tab/Return 两真实配对，其他输入拒绝。
- click 两尺寸/旧图拒绝、实际 NSScrollView down 与 modal 拒绝：**79 raw、13 terminal、6 自然退出**，C152–C154；独立 PNG、像素中心、wheel/viewport oracle。
- 同 SDK 经实际 ComputerHost/controlled adapter 完成 AX 八步表单：**27 raw、3 terminal、2 自然退出**，C155；四字段精确值与 prefix/facts 通过。这不是 desktop tool + 真实模型 GUI 资格。
- **13 browser 场景、351 raw、26 自然退出**，终到 C169；完整页面 oracle、每 operation terminal、profile/image 清理、背景焦点均通过。没有重连、未知动作重放、helper-drain 降级或 marker 恢复。

### 保留的 deadline 测试失败

原四个 7 秒 handler 只保证 28 秒工作；本轮八步 28.621 秒内完成，没有超过 native 30 秒预算，因而未触发期待的 timeout。C167 的原记录仍是**失败资格**，并非产品超时守卫失败；四 terminal、两自然退出/目录清理另行验证。

刺激预算回归旧 fixture 失败后，只在新专用 fixture 将 handler 改为 11 秒（四个至少 44 秒、单个低于现有 20 秒 CDP 等待）。同 SDK 新 profile 在 33.360 秒返回 prefix4、已投递第5步 unknown/deadline_expired，无尾部动作，C168；cancel 新轮零页面输入到 C169。原 source/raw 不改，未知动作不重放。

复用旧 browser/AppKit 父脚本前，还分别用合成回归证实空 AssertionError/无结果会误报成功；只修新副本的错误记录与 exit 判定，各 **2 fail/1 pass → 3 pass** 后才运行 GUI。不是修改旧失败证据。

## 体积与测量边界

- 相对保存的 legacy graph，排除 **55 个 package/version pair**。
- dylib **27,257,440 → 22,976,672 bytes**，只是文件大小。
- 两个不同资格进程 wall time：initial load 1.508161s、最终 no-host load 0.075556s。不是配对/相同温度样本，**不计算启动加速比**。
- 本轮单次 AX plan 18.087s，仅原始资格时长；P05 五配对收益仍为独立历史组件数据。
- P08 的 ≥100 micro samples、≥30 完整配对以及正式 p95 样本尚未完成；没有用本轮大小/单样本替代性能门禁。

总校验：`final-verification.json`，连同 `transport-hostfixed-inputs.json`、各 `trim-*-verification.json` 与 `deadline-stimulus-failure-verification.json`。仍待 P07 激活/独立包装、实际模型图像闭环与 P08 正式验收；旧 owner56354、D65/D70/D83 的终态未知事实不受新成功影响。
