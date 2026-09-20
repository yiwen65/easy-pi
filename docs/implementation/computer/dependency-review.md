# Computer 原生依赖审查

固定来源：`trycua/cua@05f29785b508a4441ec3aa06c556a8e8b26c1d71`；只读目录 `/Users/w/Projects/easy-pi/cua`。目标 macOS arm64。任务状态仅见[任务记录](../../tasks/2026-09-18-computer-native-implementation-task.md)。

## P03 独立受控构建与加载

P03只修改pi-owned独立stage；`native/computer/patches/p03-controlled.patch`保留19文件Rust差异、上游MIT notice及源hash。没有新增依赖/改变版本或四个锁，原P02的485Rust输入与两个封存产物保持原hash。补丁SHA256为`c1be9e7b92722e1169695941bee70f853f1c0759aa1a4ae7d52bcad0f6f71752`；详细原始/修改hash在`p03/native-patch-provenance.json`。

| P03独立产物（arm64 Mach-O） | 字节 | SHA256 |
| --- | --- | --- |
| SDK dylib | 25,601,776 | `7add23a7f73d0c163657d8f791e820a3e43760d5ce7f1c85a56db45675aa2696` |
| copy-mode N-API runtime | 873,696 | `ba914d560aaada6b9f099b210ac7cb4bdd59fde6cb23ca6ba4d4984776f0a42d` |

root串行重跑47个限定原生测试、未改generator及--check、独立stage、C header check、严格TS emit，全部0。`controlled/pinned-inputs.json`由真实生成/编译材料捕获81文件分组hash，未手写bindings。生成strict typecheck修正本地4项类型声明问题后0；单独授权load-only child1/1自然exit0，无constructor/TCC/实际桌面lease调用。独立native source/provenance review无可执行发现；实际fixture门禁另见任务authority，不能由编译/加载推断。

新ComputerHost/Session/Operation导出与旧CuaDriver隔离。原生gate逐primitive重验、inert pre-start取消、独立supervisor/worker/callback收敛、native subtree cleanup ledger、snapshot精确代际回收、账号home持久flock与dirty拒绝只适用于受控tree-only/AXPress路线。原P02的abort/shutdown缺口并未被全库修复。没有默认激活、P01bridge、P04batch、冷安装、生产裁剪、Bun或性能结论；上游warnings仍如实保留。

## P02 编译准备轮实际结果（2026-09-18，加载授权前）

本节保留上一轮编译准备的历史边界；本轮真实加载结果见下方“无 GUI 接通”。当时用户已授权限定依赖、项目工具链和受控构建；GUI/真实模型仍关闭。以下均发生在 `pi/.artifacts/computer/p02/`，**没有修改 pi 产品源码、普通 node_modules、manifest/lock 或 Cua 参考副本，没有加载 SDK/适配器，没有创建 driver、探测 TCC 或操作桌面**。

- 项目隔离 Rust **1.97.1 + rustfmt** 已安装；不替换全局默认工具链。Node 24.15.0 / darwin-arm64 / N-API 10，Xcode MacOSX26.5 SDK，Swift 6.3.3。工具链原始输出见 `toolchain-verified.log`。
- 最小私有 npm package 只安装三个 exact pins：`@ubjs/core`、`@ubjs/node`、`uniffi-bindgen-react-native`，均 **0.31.0-3**。`npm ci --ignore-scripts --omit=optional --offline` exit 0。tarball SHA512 与 registry 和上游 lock 一致；MPL-2.0 来源/notice 保留。没有执行 prepare/yarn、安装 Electron/Fleet 或 stock optional native binaries。
- 从固定 ref 复制 570 个 scoped compile inputs；保留 Rust workspace 的 13 个 members 和相对资源。不是生产 vendor 选择或裁剪结果。`upstream-manifest.json` 保存原始 hash；最终仅一个上游 staging 构建脚本有下述锁定补丁，Rust/generated sources 均未改。
- Cua 固定 lock 的 target feature tree、macOS metadata 和补齐缓存后的 unfiltered metadata 均通过 locked/offline 检查。SDK 非 dev metadata 遍历为 332 个 package / 6 个本地 crate；metadata feature union 不是精确生产 feature 证明，实际 feature 见 `cargo-tree.log`。platform-macos 重新启用了 core defaults，regorus 实际被编译。
- **SDK release、copy-mode N-API adapter、Python/TypeScript 绑定一致性检查、C ABI header 检查、root/native-only TS emission 均 exit 0**。绑定检查从 Mach-O 字节提取 metadata，未 dlopen；完整生成结果与固定源码一致，无手写或更新 generated API。

### 额外 Rust 锁与离线缓存故障

SDK 的 Cargo.lock 不覆盖 npm generator 或临时 N-API workspace。UBRN tarball 无 Cargo.lock；原 CLI 会 unlocked cargo run；Cua adapter builder 则只复制 core/napi 并在临时目录 unlocked build。已分别审查并冻结两个附加锁，仅在受控副本修改：

1. UBRN `bin/cli.cjs`：cargo run 增加 `--locked --offline`。
2. Cua `scripts/build-node-runtime.mjs`：将保留的 runtime lock 复制进临时 napi workspace，并增加 `--locked --offline`。不修改原有 copy-mode 转换或 MPL notice。

补丁是 `build-guards.patch`；两个保留锁在 `upstream/libs/cua-driver/build-locks/`。嵌套 metadata 本身不传 `--locked`，但继承离线环境；前后 Cua/UBRN/runtime 锁 hash 均验证未变，不声称所有第三方子调用都显式 locked。

首次绑定检查 exit 1：之前只 `cargo fetch --locked --target aarch64-apple-darwin`，但 UniFFI 的 `MetadataCommand::new().exec()` 不过滤平台，缺 `aes 0.8.4`。只补做 **`cargo fetch --locked`**（临时显式允许网络，原锁未改），全平台 offline metadata 和原绑定命令随后通过。没有把生成切换为在线、改版本或将缓存缺失误报成 stale/ABI mismatch。前后证据：`bindings-check.log`、`cargo-fetch-all.log`、`cargo-metadata-all.json`、`bindings-check-retry.log`。

| 固定输入 | SHA256 |
| --- | --- |
| Cua Cargo.lock（与参考副本相同） | `fe2ece2843bd07ebdcdab67a44b34c89868a4c6e96fd326c80fd3b9aa0ba9a39` |
| 最小 npm package-lock.json | `b5d89b848ab2583ab950d7ad524887eae1e1e043ddf3327f34f8fad7711f48ef` |
| UBRN Cargo.lock | `0579226746e900ed10eec6478678a6fd067e531aeffe38a5338024559201e5b1` |
| copy-mode runtime Cargo.lock | `1cb3cbb2f84d1ea6f5f8e690c8aa56bec42dba4d0319eec4eecd01eef39fe9b6` |

### 产物与未通过的门禁

| 编译产物 | 字节 | SHA256 |
| --- | --- | --- |
| `libcua_driver_sdk.dylib` | 25,123,200 | `cbbc2bf82304282b559f4c1f495ff20f74fbe9bad2286d57a6627e7ecdb7d5f5` |
| `cua_driver_node_runtime.node` | 873,296 | `5f8dff5b6703d99282b498fe5a6c59bb3b3a7d31a3c55fd9ba1157854180fab6` |

两者都是 arm64 Mach-O；静态 load command 的 minOS 13.0 / SDK 26.5 不等于在所有 macOS 版本上测试通过。SDK 动态依赖记录为系统 framework/Swift dylib；adapter 的两个 load dependencies 为系统 libiconv/libSystem。adapter 首行临时路径是 **LC_ID_DYLIB（自身 ID）**，不是要求存在的外部临时库；未更改 ID，也未据此声称独立打包成功。

SDK 0.28.2、C ABI 1.1.0、UniFFI scaffolding version 30、contract schema 0.8.0 是不同命名空间。静态确认 109 个 checksum 符号存在；未执行这些函数。16-bit API checksum 不是安全 hash。`verification.json` 保存产物、锁和源码差异验证。

保留上游警告：SDK 的 unnecessary unsafe、unused shutdown、duplicate rpaths，以及原 copy-mode 转换后的 6 个 Rust warnings。未为绿灯删除代码或抑制警告。

**该轮加载 HOLD**：生成 TS import 会 require N-API、dlopen SDK、校验版本/checksum、注册 callback/TSFN，不是纯类型检查；完整传递 initializer 安全性未认证。该轮未运行 SDK import、ctypes、Rust SDK test executable 或 upstream test glob（含 `CuaDriver.create`）。后续加载须新授权；driver 生命周期、TCC 身份/UI loop、OS 侧取消收敛、专用 GUI fixture、Node/Bun 打包均未验收。编译产物未接入 P01 service。

构建/命令矩阵见 [test-matrix.md](test-matrix.md)；源码审计见 `.artifacts/computer/p02/safe-audit.md`；隔离 helper/复现材料在 `p02/repro/`。helper 清空继承环境、固定工具链和 offline，但不是 OS/network sandbox。所有产物只是本地构建证据，不可作为已支持的发布包。

## P02 无 GUI 接通（本轮明确授权）

用户随后要求执行T-007，并确认仅允许原生适配器和无driver加载/ABI/自然退出测试。新增 `native/computer/{adapter,loader,integrity}.ts`、输入pins、tests、独立类型检查和来源说明。不向普通manifest/lock/node_modules添加依赖；SDK仍是独立可信输入，由宿主提供绝对路径。实际生成declarations通过显式typecheck映射使用，不把生成TS或手写替代bindings放进源码。

- 经审查的独立进程真实SDK import自然exit0；仅标量ctypes诊断exit0，ABI1.1.0、两个UniFFI30常量、109个checksum值与生成源码匹配。测试用C签名来自生成header，不是产品FFI通路。
- 新loader验证81文件分组SHA256后通过真实import；pure生成codec/JS allocator往返保留u64窗口ID、window click union、Unverifiable effect。>2^53 ID只是精度fixture，不是macOS有效窗口证明。
- 同步生成creator须宿主提供明确options、authorization/activity callbacks，不自动确认unrestricted，不执行权限getter或daemon fallback。本轮所有真实测试都没有调用该creator。
- 非原生契约/生命周期测试26项及独立native-load测试1项通过；生成类型检查exit0。close仅证明SDK级等待/销毁顺序，不证明真实driver cleanup；shutdown失败不destroy。
- `abi.rs:488–540`取消work.abort后未等待OS工作；`platform-macos/src/tools/click.rs:611–681`与`get_window_state.rs:292–323`中的blocking AX工作说明终态缺口。此adapter不满足P01 terminal承诺，P03/P04仍需处理。

精确输出/失败重试均在 `.artifacts/computer/p02-connect/`。首次probe受限PATH缺Node为127（未加载），改用观察到的绝对Node24.15.0路径后通过。类型/单测曾捕获新pins的platform键冲突及两个fixture索引类型错误，修正后通过，不删断言。当前loader严格限Node24.15.0/darwin-arm64，Bun/其他Node未认证。输入hash只检测可信静态材料drift，不是OS sandbox，不防恶意宿主/loader hooks/并发文件修改；生产vendor/冷安装/许可证分发门禁仍未完成。

## P02 专用fixture真实原生基线

用户更正实际授权条目后，`p02-correct-grant`与随后两个真正行动进程均通过TCC预检/同PID归属。`p02-live/native-comparison/`保存raw SDK与NativeComputerAdapter的同一窗口串行比较：各一次Background AX click，counter0→1→2，原始Unverifiable/Accessibility/Background与空evidence/无escalation完全一致。没有截图、其他应用内容观察/直接输入或模型调用。

本轮新增Swift轻量控制fixture和受信TS probe及guard测试，不改SDK/Rust/generated/dependencies。Swift typecheck/link、生成TS strict、30非原生测试/1默认skip、父协议4/4、scoped Biome、新隔离全check、Computer32/32通过。81pins、四锁、两原生产物hash未变；没有重新编译native或运行完整test.sh。

每次observe/click期间都有Node pipe响应与fixture AppKit主线程ack；可见状态来自own窗口flags并由fixture AX按钮/计数读取交叉检查，不宣称无遮挡像素或physical Stop。Stop smoke的真实转发在pending只读观察上产生匹配ESM UBJS AbortError，随后uncancelled shutdown→destroy→自然退出；两臂owner与fixture均exit0，无强制终止。

创建失败实验是显式缺失bounded manifest，正确生成Configuration在`DriverRuntime::create`前失败；新adapter在同进程恢复成功。它不证明半创建owner/全部callback无泄漏。固定runtime事实上没有活跃的进程全局exclusive guard（历史AlreadyExists变体不足为证），本次由父进程序列化两臂；全局owner仍属P03。

上述只是P02窄平台基线。Rust abort不join、AX spawn_blocking逃逸的缺口未消除；**SDK settlement仍不能解锁P01 desktop lease或冒称OS terminal ack**。生产调度/撤权、截图/browser、独立打包、Bun/其他Node和性能门禁仍未完成。

## P02 GUI 准入历史（当时无 driver 执行）

重启后历史复查见`p02-post-restart/`：用户报告重启后，新Node16473仍true/false、Node78/logger0；当前会话祖先仍含启动于16:25:57的后台agentport-host PID88054，磁盘debug app签名有效。尚未核对用户实际勾选的app条目；不据后台存续/签名时间或日志Unknown推导根因，不自动终止持久宿主或重复要求前台重启。

权限请求历史：用户明确要求“请求权限，我来打开”，允许正常request API和设置入口，由用户手动授予。`p02-permission-request/`记录PID99320调用一次`requestMacOsPermissions()`，前后辅助功能true/屏幕录制false，随后屏幕录制设置open成功，自然exit0；仍未创建driver。下述false/false是请求前历史证据，未删除或覆写；当前仍缺屏幕录制，待手动开启/重启后新进程复验。

用户已确认当前桌面专用fixture，以及固定SDK不可避免的其他应用/窗口metadata读取（含标题）和原前台焦点恢复。它们来自core授权enrichment内部`list_apps`、macOS窗口owner解析及AX click的window detector/focus保护；exact-window manifest不是隔离。实际内容观察/直接输入仍只允许fixture，禁止弱化bounded授权、私有skip、daemon/宿主切换。详细源定位保留于`p02-gui/{host-audit,fixture-audit,admission}.md`。

只读getter仅调用`AXIsProcessTrusted()`与`CGPreflightScreenCaptureAccess()`。第一次进程两项true/exit0；后续新进程PID77212两项false/自然exit78，因此当前准入失败。coordinator使用`log stream`在日志源侧仅过滤该PID，exit0；tccd的AttributionChain记录AgentPort的responsible identifier/path和该Node binary path，强于祖先链猜测。另有cached identity `com.agentport.desktop`，与responsible label的debug后缀不同；未确定这是权限变化的原因，不从单条entitlement warning推导根因。证据在`p02-gui/attribution/`。

未创建driver、运行fixture、枚举桌面、观察内容、截图或输入；没有自动request/settings调用、提权或TCC DB读取。用户须手动核对实际AgentPort.app的两项权限并完全重启宿主，之后在新行动进程重新验权/归属；之前true/true不是可复用资格。

同进程direct SDK不提供上游AppKit cursor overlay，并不等于基础observe/click必须启用该overlay。方案允许轻量可见状态/Stop控制面，但必须实际验证其UI loop/响应性；fixture进程的AppKit loop不能冒充Node的native overlay。当前仅保留控制fixture草稿，未编译运行、未落产品目录。既有native13文件和依赖不变，SDK settlement仍不满足P01 OS terminal契约。

## P00 历史材料与阻塞（不是当前状态）

| 材料/检查 | 观察结果 |
| --- | --- |
| Cua TS SDK | `libs/cua-driver/typescript/package.json` 版本 `0.28.2` |
| TS runtime 依赖 | `@ubjs/core=0.31.0-3`、`@ubjs/node=0.31.0-3`，pi 当前 node_modules 中均不存在 |
| Cua TS node_modules | 不存在；不能执行 pinned UBRN generator |
| Cua Rust target | 不存在；没有该 checkout 的已编译 SDK |
| Rust workspace | 13 个 members，SDK 不是可直接脱离 core/platform 的单 crate |
| 固定 Rust toolchain | `rust/rust-toolchain.toml` 为 **1.97.1**；本机 Homebrew rustc/cargo 为 **1.95.0**，不匹配，未自动安装 |
| Rust Cargo.lock | 存在，SHA-256 `fe2ece2843bd07ebdcdab67a44b34c89868a4c6e96fd326c80fd3b9aa0ba9a39` |
| `cargo metadata --locked --offline --format-version 1` | exit **101**，crates.io 本地索引缺 `jsonschema` |
| `cargo tree --locked --offline -e features -p cua-driver-sdk --target aarch64-apple-darwin` | exit **101**，同上；不能据此报告完整依赖闭包 |
| Cua git status | 命令后仍干净 |

命令 cwd：`/Users/w/Projects/easy-pi/cua/libs/cua-driver/rust`。完整日志见 pi 的 `.artifacts/computer/p00/cargo-{metadata,tree}.log`，附 `.exit`。错误提示建议联网重试不是授权；没有去掉 offline 重跑。

P00 当时的 P02 解除条件：提供审查过的离线依赖/预编译产物，或单独授权精确白名单与受控副本构建。该依赖/编译准备已按上文完成；当时GUI=false独立阻塞桌面门禁；后续权限排查及已通过的窄fixture基线见上节。

## 已核对的实际 API 与生命周期

- TS README 的 `CuaDriver.create(undefined)` 是进程内路径；`connect(socketPath)` 是 daemon 路径，不能当作零 IPC。
- `startSession` / `endSession` 为真实生成方法；普通 SDK 调用可自动创建隐式会话，不等于 easy-pi 已有 per-session capability。需要显式收窄/撤权，不允许以隐式 session 替代宿主所有权设计。
- 窗口 ID 为 bigint，`click` 走确切目标和 delivery route；其他不少操作仍返回 text/images/structuredJson/rawJson 的 ToolResult，尚非统一窄类型热通路。
- `shutdown()` 关闭准入并等待已准入工作，再 `uniffiDestroy()` 释放 binding handle；destroy 本身不是正常关闭证明。
- `runtime.rs` 的 `RuntimeOptions::embedded` 设置 `host_owns_permission_ux=true`；宿主需要真实 TCC 责任身份，不通过测试进程请求权限或改成前台 fallback。
- `abi.rs:spawn_completion` 创建 OperationState，取消分支执行 `work.abort()` 并发送 Cancelled 回调。**这不足以证明已投递平台工作终止**：异步 task abort 不保证终止 OS 调用/平台线程中的动作。P03 需要逐副作用 gate、pre-handle 取消锁存及 terminal convergence 证据。
- 实际生成的 `typescript/src/native/cua_driver_sdk.ts` 异步方法接受 `{ signal: AbortSignal }`，传入 `uniffiRustCallAsync`，绑定 native future cancel/complete/free；它与手写 JS timeout 不同；当前已取得 ubjs，但mock pre-handle锁存和SDK加载仍不能验证原生terminal ack时序。`platform-macos/src/tools/type_text.rs:180` 的 `spawn_blocking` 直接调用 `type_text_global(&text, delay_ms)`，并未向该同步调用传取消 token。
- `libs/cua-driver/README.md:168` 明确 direct 路径没有经过认证 host adapter 就没有 AppKit cursor overlay；`platform-macos/src/lib.rs:79` 要求启用overlay时OS main thread跑相应loop。本次实际两个行动进程tccd归属和权限均通过，轻量AppKit控制面/Node异步响应已在限定fixture验证，但不提供Node内native cursor overlay；不能把create成功本身当平台可用，也不以关闭可见提示回避门禁。
- 静态成本地图：`platform-macos/src/window_change_detector.rs:152–155` 默认 timeout=1000ms、poll=50ms；Snapshot 持有 suppression lease，detect 消耗 snapshot 并释放 lease。它们是上限/策略，不是本机实测延迟；P05 必须拆分应答、后置条件和焦点保护后再测量，不能全部置零。

## 生成与打包边界

实际脚本：`libs/cua-driver/scripts/generate-uniffi-bindings.mjs`。

1. 即使 `--check`，仍先运行 `cargo build --locked --release -p cua-driver-sdk`。
2. 调 `cua-driver-bindgen` 从库生成 Python，再调 pinned `ubrn generate napi bindings --library ... --lib-node-triple` 生成 TypeScript。
3. generated inventory 决定文件检查/更新，不允许手工写 TS 生成文件。
4. 脚本没有自动加 `--offline`；P00 不执行。P02 受控副本通过 `CARGO_NET_OFFLINE=true` 约束嵌套调用并固定额外锁，不修改只读参考副本。
5. SDK 还有 `stage:uniffi` staging 路径，目标 native package 包含 Cua 的 copy-mode `@ubjs/node` N-API runtime。只看 npm runtime 依赖存在，不能证明正确目标 `.node`、SDK 库与 generated ABI 已匹配。

## 静态依赖成本（不是裁剪结果）

- SDK `default=[]`，core 设 `default-features=false`；仍直接依赖 core、contract、cursor-overlay，macOS 依赖 platform-macos/core-foundation。
- core 除可选 regex/regorus 外，还常驻 `serde_yaml_ng`、image、browser CDP 的 tokio-tungstenite/futures、jsonschema、授权/加密/锁相关设施。
- workspace 固定 UniFFI `=0.31.0` 和 zune-core `=0.5.1`。不能删除 core 授权类型或 browser profile 所有权来“减少成本”。
- P00 时缺离线依赖，尚未取得 workspace feature 闭包；P02 已保留 metadata/目标 feature graph。**是否建立生产独立 Cargo workspace、复制哪些完整 crate、最终 feature 名称仍未决定**，临时 compile-input copy 不等于 tree-shaking 或生产裁剪。

## P00 最小变更候选（历史审查输入）

此表在 P00 时尚未获准；P02 的具体授权、安装与验证范围以上文为准，不能据此扩大到其他依赖或发布行为。

| 类别 | 固定候选/用途 | 限制 |
| --- | --- | --- |
| JS runtime | `@ubjs/core@0.31.0-3`、`@ubjs/node@0.31.0-3` | 仅 Computer 可选原生产物；exact pin，review lock/shrinkwrap，默认不开启 |
| 生成工具 | `uniffi-bindgen-react-native@0.31.0-3` | 仅原生维护/构建；不引入 Electron/Fleet dev deps |
| Rust 工具链 | `1.97.1` + rustfmt（上游 toolchain 文件） | 单独准备/授权，不以本机 1.95.0 冒充固定工具链 |
| Rust 依赖 | 上述固定 Cargo.lock 的闭包 | 在受控副本 hydration；禁止对参考库或锁文件任意升级 |
| 平台产物 | macOS arm64 SDK cdylib + 对应 copy-mode N-API adapter | 记录 OS/arch/ABI/contract hash/校验和；无运行时下载；不加载不可信 cwd 中任意库 |
| 来源与许可 | Cua MIT、原作者及所有实际依赖 notices | 保留 UPSTREAM 固定 ref/补丁/生成步骤；发布前完整审查传递许可 |

撤销边界：禁用 Computer 后普通 coding 不应加载这些产物；删除可选依赖/产物变更须单独审查。运行中的回退先关闭准入、取消并等待原生收敛、使引用失效、重新观察；不能重放日志中的待执行动作。
