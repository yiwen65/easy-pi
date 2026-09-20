# Computer 实施进度导航

唯一任务状态与执行日志：[`docs/tasks/2026-09-18-computer-native-implementation-task.md`](../../tasks/2026-09-18-computer-native-implementation-task.md)。本页仅提供阶段产物/证据入口；不维护第二份任务状态清单。

## 最新证据入口 — P07/P08

- [最终交接](handoff.md)、[支持范围](platform-support.md)、[回滚与隔离处置](rollback.md)。
- [P08 实测汇总](benchmark-summary.md)：30配对表单降低41.57%，启动p95回退门槛通过；stress及实际安装browser验证到C237。

- [P07 打包与独立安装](p07-packaging.md)：可选资产、实际 npm 安装、Node/Bun 分别记录及许可证。
- [P07 产品资格](p07-qualification.md)：实际模式、TUI/RPC、AgentSession GUI、原生子会话、gpt-6-astra low图像点选与compaction边界。
- [P08 冻结测量契约](p08-benchmark-contract.md)：300启动配对、每arm100观察微样本、30完整原生表单配对；结果与最终状态仍以唯一任务记录及其原始证据为准。
- [安装与SDK所有权说明](../../../native/computer/PACKAGING.md)。普通coding默认零native；Bun未支持。下述P02–P06过程文字是历史记录，不覆盖最新任务状态。

## P06 / T-035–T-038 证据

- [P06 快速构建与类型化通路](p06-fast-build.md)：实际编译排除表、34源路径/81pins、生成/宿主边界检查、trimmed GUI到C169、原deadline刺激失败及修正证据、测量限制。
- `.artifacts/computer/p06-trim/final-verification.json`：最终源/产物/raw校验；实验补丁`p06-fast.patch`在qualified P06 discovery之后应用。
- 旧下述P02–P04文字是历史阶段记录，不覆盖最新任务状态；阶段导航不是独立的总体交付声明。

## P00 — 对应 T-001 / T-002 / T-003

- 基线：pi `89b56ee70f86c98e0a81b8b7b90c09410b3ff772` 加快照时用户已有变更；Cua `05f29785b508a4441ec3aa06c556a8e8b26c1d71`，只读。
- 实际新增：本页、[baseline.md](baseline.md)、[test-matrix.md](test-matrix.md)、[dependency-review.md](dependency-review.md)、[benchmark-spec.md](benchmark-spec.md) 及上述任务记录。
- 产品行为差异：无。未修改产品代码、测试、依赖或锁文件。隔离构建/check 副本产生的修改不回写。
- 实际命令：offline build exit **0**；原 test.sh exit **1**（27 个已有失败）；真实 session/runtime faux 定向测试 exit **0**（13/13）；check exit **2**（已有 TS2339）；Cargo metadata/tree offline 均 exit **101**（缺 jsonschema）。完整 cwd/命令见 test-matrix。
- 证据根：`.artifacts/computer/p00/`，含原始 stdout/stderr、`.exit`、tracked 文件哈希、现有 diff 及隔离副本。
- 门禁判据：ref 和已有失败已锁定，真实 easy-pi + faux 入口可用；这不代表全仓回归或原生门禁通过。
- 后续限制：P02 缺绑定依赖、产物及可验证原生取消；GUI=false。P01 可先做显式注入的 fake 契约闭环，保持默认 coding 行为不变。

## P01 — 对应 T-004 / T-005 / T-006

### 实际变更

- `packages/coding-agent/src/core/extensions/types.ts`：使用现有 AgentTool 类型添加可选 `contract` / `executionResource`。
- `core/tools/tool-definition-wrapper.ts`：两个转换方向均透传字段。以上既有产品文件合计只新增 10 行；不改 Agent loop、SDK、默认工具集合或宿主生命周期。
- `core/computer/{contracts,service,tool}.ts`：显式注入的最小宿主协议、懒 service 与临时工具构造器。
- `test/computer/{fake-backend,service.test,tool-definition.test,integration.test}.ts`：纯内存 fixture；32 个新增测试。其中 8 个使用真实 `createAgentSession` / Agent loop / faux provider，不复制循环。

### 已实现 API（不是 Cua 绑定）

内部路径 `core/computer/service.ts` 提供 `new ComputerService({ desktopId, backendFactory })`，`tool.ts` 提供 `createComputerTool(service)`；没有默认 native loader，也没有新增公共 package export。测试中的 `FakeComputerBackend` 仅在 `test/computer/fake-backend.ts`。

宿主将工具显式加入 `customTools` 或通过扩展 `pi.registerTool` 注册；宿主负责 `await service.close()`。多工具/会话若操作同一桌面，必须显式注入同一个现有 scheduler 并使用相同可信 desktopId。仅构造 service/tool 不调用 backend factory。

模型输入例：

```json
{"request":{"op":"observe"}}
```

```json
{"request":{"op":"execute","ref":"snapshot-1","steps":[{"op":"fill","target":"field-1","text":"Ada"},{"op":"assert_value","target":"field-1","value":"Ada"}]}}
```

- 仅 fake profile 的 `fill` / `assert_value`；严格拒绝未知字段、1–8 步、填写文本和断言值合计 ≤16 KiB UTF-8；观察文本 ≤4 KiB UTF-8。
- 懒初始化至多一次；失败缓存为 `native_unavailable`，不自动重试。`close()` 关闭新准入，等待已准入 promise，再关闭 backend 一次。
- 完成前缀与 `completed/partial/failed/cancelled/outcome_unknown` 如实返回；异常执行不映射为成功，不自动重放。没有 JS 超时竞速或内层 scheduler。
- 观察正文放在模型可见 content；details 仅状态/计数/错误码/观察引用等。不会把原始异常、填写文本、观察正文额外复制进 details；**不承诺原始工具调用历史被脱敏**。

### 验证证据与限制

- 真实 loop 中 custom/extension 两条 observe→execute→result 路径通过；普通 coding/noTools 不含 Computer schema、factory 调用为零。
- 在模型请求后修改注册表元数据，宿主仍依据冻结 snapshot contract 真正拒绝外部工具；同 key 独占 lease 的 barrier 实际阻止 backend 初始化，释放后才执行。
- 当前工作树定向回归：11 文件、176 测试通过。受控 `P00 + P01` 副本：offline build exit **0**；check exit **2**（仅已有 TS2339）；test.sh exit **1**（与 P00 完全相同的 27 个失败，新 32 个测试通过）。完整命令在 [test-matrix](test-matrix.md)。
- `.artifacts/computer/p01/` 保存日志、初次 check 的两处测试类型错误及修正后的结果、失败集合比较、源码 hash、副本边界及独立只读 review。最终检查未格式化任何文件；P00 副本保持原状。
- 这些测试只证明**宿主显式配置时**现有准入与调度机制生效，不证明普通 SDK 自动执行全部 ToolContract 策略或自动给 root/child 共享 scheduler。

## P02 构建准备证据 — 对应 T-014 / T-015 / T-016 与 T-007 的编译子集

2026-09-18 用户“授权处理”限定开启依赖/工具链/受控构建；GUI、真实模型仍 false。旧 `.artifacts/computer/p01/native-materials.log` 只是历史材料缺失记录，不再代表当前状态。

- `.artifacts/computer/p02/` 内已取得固定 Rust 1.97.1 + rustfmt，以及三个 0.31.0-3 npm 包；不改全局工具链。npm ignore-scripts、只装最小输入，不装 Electron/Fleet 或 stock optional native binary。
- 固定 Cua lock hydration、metadata/SDK feature tree、两个独立 generator/runtime Cargo locks 均已保留。首次绑定检查暴露只 fetch Mac target 不足以供无平台过滤的 metadata 使用；补齐原锁全平台缓存后，原离线检查通过，未换版本或改生成代码。
- SDK 和 copy-mode N-API 两个 arm64 产物编译成功；绑定一致性、C ABI header 检查、root/native-only TS emission 均通过。`file/otool/nm/hash` 静态证据和精确命令见 [dependency-review](dependency-review.md)、[test-matrix](test-matrix.md)。该准备轮未 import/dlopen 或运行 driver。
- 构建补丁只有受控副本的 CLI locked/offline 与 runtime scratch lock 透传；`build-guards.patch`、`verification.json`、`repro/` 保留审查/恢复材料。570 个原始输入中仅该 Cua staging 脚本有差异，Rust 和 generated sources 未改。
- 最新隔离基线 `current-baseline/`：offline build / 完整 check / test.sh 为 **0 / 0 / 1**；旧 TS2339 不再复现。全套 **10 个失败**（P01 同名 9、旧项消失 18、新观察 footer timeout 1），无 Computer 失败；footer 文件单独复跑 **8/8**，不据此推断全量超时原因。coordinator 复跑完整隔离 check exit 0。未修复无关测试或回写快照。

这些是**本地依赖/编译准备**，不是可发布 native Computer：pi 普通 manifest/lock/node_modules、产品源码和 P01 service 均未在该准备轮接入原生适配器，Cua 参考副本保持干净。

## P02 无 GUI 加载与适配器 — 对应 T-007 的本轮授权子集

用户确认允许真实加载/非桌面契约测试，仍禁止 driver 创建、TCC/桌面观察/输入和真实模型。新增 `native/computer/` 独立可选模块，详见其中 `README.md` / `UPSTREAM.md`；不改 root workspace、manifest/lock、P01 service 或默认注册。

- `loader.ts` 在可信宿主显式调用时验证 81 个输入文件的分组 SHA256，再加载生成 SDK；只接受已测试的 Node24.15.0/macOS arm64。不是运行时下载器或生产发布包，不硬编码本地 artifact 路径。
- `adapter.ts` 提供 lazy/single-attempt open、typed exact-window observe、单 click、per-call cancel 和 close。输入/输出来自实际生成声明；不手写 FFI。close 等待 SDK promises、无取消信号的 shutdown，成功后才 destroy；失败保留 owner。没有 P01 backend bridge。
- 新证据 `.artifacts/computer/p02-connect/`：上游原生 import 自然退出、标量 ABI1.1.0/UniFFI30/109 checksum 全通过；新 pinned loader 自然退出，生成 codec 保留 >2^53 bigint、click target 和未确认 effect。没有调用 driver/TCC 方法；不将日志标记当 OS 侧全部 initializer 的副作用监测。
- 新测试 **26 passed / 1 opt-in skipped**；单独授权 native load test **1/1 passed**；生成类型检查和 scoped Biome exit0。新主树快照完整 check exit0（1354文件、无格式化改动），P01 Computer回归32/32。检查期间源码与副本 drift为空。完整命令见 test-matrix；本轮未重跑全套test.sh，先前10失败仍保留为最近完整基线。

## P02 专用窗口实测 — 原生基线证据

用户确认此前勾选项不是实际调试宿主、更正授权后，`p02-correct-grant/`的新进程两项权限通过。随后真实行动进程raw PID51165、adapter PID52941分别完成自己的无提示TCC预检与同PID tccd归属，两项均Allowed；不是复用诊断进程的资格。

- 新增`native/computer/test/fixtures/P02GuiFixture.swift`、`scripts/probe-gui.ts`及opt-in guard测试；显式typecheck现包含TS scripts。没有改adapter/loader、Rust、生成绑定、锁或默认工具。
- `p02-live/fixture-build/`：Swift6严格并发/warnings-as-errors的typecheck与编译均0。`control-smoke-drained/`：可见/active-space/main-thread自检、状态确认、Stop锁存、拒绝重arm、EOF自然退出通过；物理Stop点击未测试。
- `p02-live/native-comparison/`：同一fixture PID51161/window4860，raw与adapter各一次AX后台单击，独立counter **0→1→2**。两者原始effect仍为**Unverifiable**、route Accessibility、delivery Background，无escalation；不把counter验证改写成SDK Confirmed，也不重放。
- 两臂各三次observe/click期间均有Node pending pong与fixture主线程ack；记录的同步SDK调用最大约1.353ms/0.826ms，只是这次probe，不是性能基准或完整TUI验收。
- adapter无效manifest产生正确Configuration边界、失败open缓存、无owner close后同进程新adapter创建成功。最终只读observe pending时，fixture Stop经父进程送达真实cancel，收到匹配ESM UBJS AbortError，再shutdown→destroy；两driver/fixture自然exit0，无强制终止。
- root复核`verification.json`：81pins、四锁/两产物未变；30非原生测试通过/1默认skip，Python父协议4/4，strict types/scopedBiome/新隔离完整check均0（1356文件无修复），Computer32/32。没有重跑完整test.sh，最近完整基线仍10失败。

SDK settlement仍不是OS终态；无owner失败不证明半成品owner/全部callback无泄漏。本段保留P02当时边界；之后的P03受控路线另见下节，P01生产bridge仍未实现。确切状态只见任务记录。

## P03 宿主、生命周期与受控原生证据

- `core/computer/{host,binding}.ts`：lazy single-flight、跨决策session owner、整棵子树先撤权、result/terminal分离及sticky quarantine；只复用外层scheduler，没有私有等待队列。显式SDK/services/runtime注入、root/child同scheduler，旧闭包不能取得续代authority。状态机/锁序见[lifecycle.md](lifecycle.md)。
- `test/computer/host.test.ts`33项；`lifecycle.test.ts`51项。独立review发现3个续代/捕获问题，新增25例先失败后修正，root四文件111/111、type-only兼容修正后host+lifecycle84/84。原始失败/回归和5源hash在`p03/lifecycle-fix-evidence/`，不以最终revoked状态掩盖短暂续代。
- `native/computer/patches/p03-controlled.patch`为19文件受控Rust增量；原锁/生成工具不变，P02输入与产物保留。精确窗口tree-only observe及一次background AXPress，不含截图、fallback、batch或默认工具。原生监督任务持有blocking worker/焦点callback，独立subtree ledger和snapshot精确代际清理；失败保留owner/实际FD。
- 实际账号home的持久协作lease没有heartbeat/TTL接管或dirty恢复。root定向原生core18/lease13/SDK11/platform5全部通过；包括paused-child Drop、lost producer、refcount、Stop前后primitive gate和私有子进程停住/crash/clean handoff。最终`native-review.md`无可执行发现，已核对最终补丁/491Rust输入及P02的485Rust文件。
- `controlled/` adapter/loader使用实际生成声明和独立81pins。未改generator及其--check、N-API stage、header、TS emit通过；严格类型检查初轮4项类型错误最小修正后0，scopedBiome0、33fake/static通过/1默认load skip，单独load-only1/1自然exit0。P02 tests30pass/1skip/types0，封存136条生成后再次通过。
- `p03/current-baseline/`新隔离build/check/test为0/0/1，9个既有失败、无新增，footer超时本轮未复现。最终type-only调整后`p03/final-check/`完整check0（1369文件无修复）、host选择191pass/5既有skip、controller38/38，检查期主树/副本source drift均空。共享HEAD外部前进至80809e7a，不归为Computer提交。
- `p03/control-smoke/`专用fixture44888/window5338可见/activeSpace/mainThread、Stop handler锁存、禁止重arm、EOF自然exit0；没有SDK调用。
- `p03/native-qualification/`实际live于2026-09-18T17:09:17Z退出1：owner56354自己的TCC两项true/Allowed后，首次observe超时，cleanup发送Stop/close仍无回执，harness强制终止owner。fixture56350/window5617最终counter0、无effect、自然exit0；没有click或contender/successor，不证明原生终态。`p03/qualification-failure/`保存原始hash、只读marker检查和失败报告；该失败后canonical lease保留dirty generation1，未自动修复/删除/重试。后续离线修复与明确授权后的恢复另见下节，不能用编译/fake/load结果覆盖此失败。

### P03 首次挂起后的离线修复证据 — T-021

- 用户另行确认仅离线定位/修复，不恢复lease、不创建替代桌面owner。新证据及独立source/npm/target在`.artifacts/computer/p03-offline-repair/`；原P03失败事件、491个Rust输入、81pins和P02的136条封存证据保持不变。
- 已复现局部锁循环：core通知时持有gate/state锁，固定N-API foreign wake同步等待JS回调，JS的cancel/re-poll又等待这些锁。加强的result/terminal双订阅barrier原代码exit101、native monitor隔离后0。新增丢弃订阅不取消producer/不跳过drain回归；无platform dispatch、TCC、AX或canonical lease调用。
- 最小产品变化为SDK的public terminal等待native proof monitor；API、core gate、取消/终态/lease规则不变。`repair-only.diff`只涉及2个Rust文件（含3个新测试），合并patch仍19文件。patch/pins已同步到`native/computer/`；新dylib `7b94a64a…`，N-API `3ff6b386…`，旧失败二进制未替换。
- core18/lease13/SDK14/platform5共50项通过；测试两处格式换行后SDK14项重跑通过。locked/offline build、未改generator及--check、header/TS emit、strict generated types、controlled33pass/1skip、P02 mock30pass/1skip、load-only1/1、scopedBiome22文件均通过。生成JS/声明及四锁未变。
- 新隔离`final-check`的完整check **exit2**：5个`packages/ai/test`模型ID类型错误，换回旧Computer patch/pins的同副本tsgo仍为相同5错误。Biome只格式化副本内`compaction/subsystem/narrative.ts`；检查期间主树source drift为空，未回写。另跑Computer/session **193pass/5既有skip**、controller **38/38**。未重跑全套test.sh，不宣称全仓绿灯。
- 以上证明局部缺陷及修复，不证明原GUI挂起已解决；该离线轮没有现场native stack或修复后live执行，dirty lease未获取/改写。后续用户重启并确认的恢复/复测见下节；P04不启动，具体状态只见唯一任务记录。

### P03 重启后一次性恢复与准入失败 — T-022 / T-020

证据：`.artifacts/computer/p03-recovery/report.md`、`qualification-review.json`及原始命令/事件。用户先重启macOS，随后明确确认一次性归档/原位恢复与限定fixture实测，任一步失败停止、不自动重试。

- `sysctl`确认boot为2026-09-18T18:34:37Z，晚于原失败与离线修复。新证据助手复用原样Rust存储验证器，private20/20、parent8/8、read-only snapshot4/4；原/修复各81pins/491Rust、旧20失败文件、P02 seal136/136、离线133证据及四锁核对通过。
- 18:52:43Z仅一次恢复exit0：实际UID/home、安全目录/文件、无ACL/链接、local filesystem及非阻塞独占flock检查后，先归档D1/fsync，再只改状态字节为C1/fsync。inode134700982、uid501、0600、nlink1、42bytes、generation1均不变。不是产品恢复API，也不证明旧工作terminal。
- 新控制smoke fixture9395/window121通过可见/主线程/Stop锁存/EOF自然exit0；物理点击Stop未测。
- 18:54:21Z—18:54:30Z新实测退出1，停在`Action-process responsible identity unqualified`。probe9498的两项getter均true；TCC日志的responsible为预期AgentPort bundle/path、PID1084，accessing/requesting为9498。继承脚本错误要求responsible PID等于Node PID，导致本次拒绝；此捕获也无两服务Allowed决策行，不能只取消PID限制就宣布完整准入。
- 未发送admit/observe/click，native owner构造0；fixture9494/window122 counter0。probe/fixture均自然exit0且drain EOF，无forced teardown；marker仍同inode C1，无新代际。按约定停止，不修改准入脚本或再次运行；需要另行确认最小脚本修正/离线回归及新单次fixture尝试，不需要再次恢复锁或据此要求重启/重授权。

本轮没有改产品源码/补丁/pins/依赖，Rust修复的真实观察/取消效果仍未测到。未重跑全仓check，最近实际完整结果仍为离线轮五个范围外模型ID错误。

### P03 TCC修正后的真实终态资格 — T-023 / T-020 / T-024

最新证据：`.artifacts/computer/p03-tcc/`，替代上节当时的停止状态；旧失败不覆盖。用户现已授权持续修复并推进P03–P08，后续真实模型仅限`qd/kmodel_latest` high有界opt-in；本轮无模型调用。

- 旧TCC条件在保存日志上先失败；修正后区分requesting行动PID与responsible宿主PID，并按tccd PID/activity关联完整请求，补回PID文本filter漏掉的Allowed行。26正反例及parent8/8通过；新PID22337无driver集成准入自然exit0。只持久化本请求必要记录，不收集其他活动。
- `native-qualification`（19:27:19Z—19:27:51Z）exit0；独立`verify-live`0复核原始事件。fixture24382/window240，owner24386及contender25381/successor27193分别完成自己的两服务完整TCC准入；owner首次observe正常返回，parent/sibling与第二进程均被拒绝争用。
- 唯一background AXPress，fixture counter0→1，原生仍Unverifiable/Accessibility/Background、无escalation。四条terminal回执覆盖观察/点击/取消；successor只在owner clean close/destroy后创建，pending只读观察经Stop取消，未投递输入。
- owner/contender/successor/fixture四个自然exit0且EOF，未强杀或采样。marker同历史inode依次C1→D2→D2→C2→D3→C3，cleanup仍C3；没有第二次恢复。
- 新`final-check`仍捕获5个模型ID类型错误。T-024仅修正三份AI测试的过时目录输入，保留Mistral、双zai、reasoning mapping与价格覆盖，不改generator/provider/生成数据。修正前3失败，之后49pass/35既有真实API skips；`repaired-check`完整check0（1369文件无修复）、Computer/session193pass/5skip、controller38/38，主树/副本source drift0。
- 证明的是driver-owned drain，不是外部应用效果完成/回滚；物理Stop点击、阻塞AX入口、原失败的native stack均未验证。修复build通过实际路径，不把跨重启复测当唯一历史根因证明。P04–P08仍按依赖继续，不宣称生产交付。

## P04 有界原生表单与可选桥接 — T-009 / T-025 证据

本节只索引证据；任务状态仍以唯一任务记录为准。下列为2026-09-18锁屏期间的历史记录；用户解锁后AppKit子集已通过，最新证据见本节末，P04整体仍未验收。

- 独立`.artifacts/computer/p04/`从已封存P03复制579源输入；新增`native/computer/patches/p04-controlled.patch`（27Rust文件，SHA256 `e6d8167a…`），独立genuine UniFFI生成/81pins。P03原输入与四锁未变，P04 dylib `459fd177…`。当前`controlled/pinned-inputs.json`已选P04，不可拿旧P03 SDK配新loader。
- 原生stage实现1–8步/≤30s的Fill/Press/AssertValue，ref不重绑、selector新鲜解析、Press必须后置条件；逐步权限/取消与driver-owned drain沿用P03。完整AXChildren观察含layout/read-only行与精确空白值，错误/cut/cycle/modal拒绝完整性和tokens；web/secure不授予原生mutation token。Fill保留canonical policy/manifest、per-PID lease及原handle成员验证，无键盘/坐标/前台fallback。
- `controlled/{contracts,tool,binding}.ts`经既有ComputerSession/binding/外层scheduler提供可选native profile，不改Agent loop、不冒充P01 fake协议；16KiB输入/4KiB模型view，只授予实际展示行，刷新/执行使旧grant失效。保留per-step facts/完成前缀/unknown，无重放或raw内容复制到details；fork/renew重建闭包。
- `check-plan-v2`、`qualify-generated`及独立types通过：core25/platform16/SDK31/私有lease13，locked offline build/generate/--check/header/TS emit；继承warning保留。adapter/static34pass/1skip、load-only1/1；tool8/8与真实AgentSession/faux4/4。相同八步fake表单9→3模型请求、4→1plan、8→2外层acquire，**不是实际桌面性能**。
- `bridge-check/`完整隔离npm check0（1376文件无修复、tsgo/browser smoke）、Computer/session193pass/5skip、controller38/38；主树/副本drift0。严格native边界与根编译契约的binding组合分开检查，未放宽adapter严格项；没有重跑完整test.sh。
- 新`test/fixtures/P04GuiFixture.swift`的四AppKit输入框编译/control smoke通过，但六次live均止于只读observe，未发form/click。每行动PID本次TCC两服务Allowed；每owner有一条terminal(false,false)→close→destroy、自然exit1/EOF；fixture自然0/四空值/counter0，历史inode C3→…→C9。第一轮harness误标forced，原始记录仍保留；private paired回归before1/after0修正非零自然退出标签，不把失败改成功。
- 有界诊断发现fixture AXWindows/AXChildren及旧helper返回application自身/无window映射；冻结P03 SDK/probe在同fixture也失败。随后`console-state.log`明确`CGSSessionScreenIsLocked=true`；尚无解锁对照，不宣称这是唯一AX根因。新console guard6/6，实际`locked-console-admission`预期exit1且零children/C9。不自动解锁、放宽AX gate或恢复clean marker。
- 临时Rust诊断已移除，原源cmp/locked rebuild通过、dylib恢复原hash；probe回用product loader。`verify-blocked.py`核对27Rust/81pins/579历史输入/四锁及155原始文件，输出`p04Accepted:false`。恢复后三项types0、选定静态tests32pass/7opt-in skips。汇总见`p04/report.md`。

### 解锁后真实表单与对抗场景 — T-025 / T-026

- 用户手动解锁后，原P04产物只读完整观察通过；新fixture八步Fill/AssertValue全部完成，独立四字段值一致，C9→C10→C11。`unlocked-verification.json`核对59raw/输入，单次26042ms不作为性能结论。
- layout、ambiguity、detached ref、stale snapshot、Press后置条件通过。modal第一轮安全停止但丢失专用错误码，原始失败保留；只读观察明确原生`degradedReason=unexpected_modal_surface`，而`plan::select`统一投影成condition_unknown。
- 最小白名单映射修复只有SDK plan及其tests；新增两回归先红（12pass/2fail）后SDK33/33绿。重新生成/--check/header/严格类型/load-only通过，27Rust仅两变化/579历史输入/四锁不变。当前patch `51fbcae0…`、dylib `0427ba07…`、重编N-API `6d65d72c…`；旧P04实际N-API pin是`0070e34c…`，历史文案误引P03 hash，不宣称byte reproducibility。
- 修复后modal、modal-prefix、partial、cancel、deadline均满足原断言。cancel在fixture独立effect callback后送Stop，无sleep竞态；deadline完成6步、未投递第7步、终态前drain，Name停在deadline-5。无重放、尾部输入或清锁；12场景/诊断共24自然exit0/EOF、324raw hash核验，最后C23同inode。每行动进程自己的console/TCC/Stop门禁齐全。
- `modal-check`全check0（1376files，仅本任务pin JSON格式变化已审查回写），host/session193pass/5skip、controller38/38；检查期间live drift0。tool8/8与真实AgentSession/faux4/4重跑通过。Swift6严格编译与control smoke0。

证据：`.artifacts/computer/p04/scenarios-report.md`、`scenarios-{initial,repaired}-verification.json`、`modal-repair/`。仍待browser session/ref和更广输入/像素、P05测量、P06裁剪/图像、P07打包/激活、P08门禁；尚无真实模型调用。

### 受控浏览器transport基础 — T-028

- 独立`.artifacts/computer/p04-browser/`保留已资格P04的586源输入、81pins与四锁；只改5个core Rust源/测试。socket绑定native session；typed固定input在writer-ready后、实际start_send前逐条gate；每step最多16个browser primitives，AX单input限制不变。
- async work须显式drain；遗失future隔离owner。关闭等待writer并abort+join接收task，断线pool保留tombstone，不能隐式重拨。普通generic CDP回归仍通过；这不是browser窗口/origin授权或外部效果完成证明。
- reader失败后的重复join与flush失败的关闭标记发布，各有先101后0回归；最终core40/40、CDP25/25（含11重叠）、SDK33/33、platform16/16。`transport-verification.json`验证incremental patch `9b6df0b6…`正反应用/hash；只保留在artifact，当前产品仍选择AppKit modal-fixed产物。
- `p04/browser-transport-check/`完整check0（1376files无修复）、193pass/5skip、controller38/38，检查期间source drift0。没有新生成接口、SDK库资格、Chrome/GUI/模型调用；bootstrap授权、profile/精确绑定、typed计划与异步session清理仍归T-027。详见`p04-browser/transport-report.md`。

### 浏览器原生资源清理接线 — T-027子集

- 在同一独立stage增加9Rust文件的有界原生resource ledger；先注册inert资源，RuntimeSession强持有，foreign facade Drop只撤权并保留异步记录。显式subtree/host close先等operation terminal，再按descendant→parent/逆注册顺序await资源清理，最后退休metadata/snapshot；不新增输入队列或detached清理。
- registered CDP pool创建时固定native session，拒绝unscoped/foreign/existing-profile路径；首失败握手关闭pool，不再依赖只有已建立socket才存在的tombstone。两项真实localhost peer回归before101/after0：首连借用foreign session、首失败握手再次拨号；原失败源/测试保留。
- core56/56、CDP33/33（重叠19）、SDK40/40、platform16/16、scopedfmt全0。`lifecycle-verification.json`核对增量patch `27a67104…` apply/hash/reverse、593当前源中的9项边界，以及586已资格P04源/81pins/四锁/产品输入和旧transport证据不变。
- `p04/browser-lifecycle-check/`完整check0/1376files无修复，193pass/5skip、38/38、source drift0。没有Chrome/profile创建、GUI/TCC/lease/model、公开ABI/生成或产品pins切换。准备授权、profile进程、精确绑定、typed观察/计划及GUI资格仍须另验；详见`p04-browser/lifecycle-report.md`。

## 权限排查历史 — 重启后仍缺屏幕录制（后已解决）

用户报告已重启后，新Node16473仍返回辅助功能true/屏幕录制false，Node78/logger0；同PID TCC仍归属AgentPort debug ID。只读自身祖先发现本会话仍由启动于本地16:25:57的`agentport-host` PID88054托管，磁盘app显示名为 **AgentPort Debug - AgentSessions**，strict签名校验通过。不能把这些信息当作运行中映像/TCC缓存或授权条目错误的因果证明。

证据`p02-post-restart/`；当时下一步是先核对用户勾选的是否确切的`/Users/w/Projects/AgentSessions/target/debug/bundle/macos/AgentPort.app`屏幕权限，不再重复要求普通前台重启。未经明确决定不终止可能托管其他会话的后台宿主，不改AgentPort/TCC，仍无driver/桌面动作。以下是此前授权与复查历史。

## 正常权限请求历史 — 用户手动开启

用户明确要求“请求权限，我来打开”，局部授权正常request API/设置入口。`p02-permission-request/`记录PID99320前后Accessibility=true、ScreenRecording=false，调用一次`requestMacOsPermissions()`及屏幕录制设置入口，进程自然exit0。仍待用户手动开启当前AgentPort屏幕录制、完全重启宿主后新进程复验；没有driver/fixture/观察/输入。open成功不是已显示弹窗或权限已授予的证明。以下准入历史证据未覆写。

用户报告已勾选后的只读复查另存`p02-permission-recheck/`：新Node PID5866仍true/false、Node78/logger0；同PID的TCC责任和ScreenCapture subject均为AgentPort debug ID。用户随后确认尚未完整退出/重启宿主，准备手动重启；继续停在driver前，不将“已勾选”或“准备重启”直接等同于当前进程获权。

## GUI 准入检查历史 — 继续 T-007

用户先确认当前桌面专用测试窗口GUI，随后在源码揭示exact-window manifest不隔离SDK内部metadata枚举/焦点恢复后，明确授权这些必要附带行为并确认执行约定。实际AX内容观察/输入仍仅限fixture；自动权限请求、真实模型、私有skip、daemon/宿主切换仍禁止。

`.artifacts/computer/p02-gui/` 保留两次不同结果，不能只引用较早通过：

- `permissions*`：无提示TCC getter曾返回true/true、exit0；祖先链和Node签名不等于TCC归属证明。
- `attribution/`：新Node PID77212返回Accessibility=false、ScreenRecording=false，自然exit78；仅该PID过滤的系统log stream exit0，实际tccd AttributionChain识别AgentPort责任链。日志的responsible identifier为`com.agentport.desktop.debug.c9d007c8147e`，另有cached identity `com.agentport.desktop`；这些差异和权限变化尚未确诊，不猜成已知根因。
- 因最新权限不成立，停止在driver/窗口创建前；未执行桌面观察、截图或输入。fixture/control仅保留未编译运行的草稿，不落入产品目录。现有native13文件不改；详见`admission.md`与`responsibility-audit.md`。

## 后续与恢复边界

本次权限条目问题已经用户更正并由两个实际行动进程复验；不要继续沿用历史权限阻塞或要求重复重启。未来每个新行动进程仍须自己的权限/归属与可见控制面准入，较早通过不能代替它。不能运行upstream全量loader tests代替限定fixture，其中含`CuaDriver.create`等不受控场景；本轮通过不扩大到其他应用内容或浏览器。

P02通路仍只abort task、存在escaped spawn_blocking风险，不能按SDK settlement释放lease。P03只对新增受控路线建立driver-owned terminal和协作lease，不能将其结论推广到原通用SDK或任意后续应用效果。真实资格见上方P03证据与任务记录。P04 Rust批段/可选bridge已通过离线/faux及AppKit表单/对抗子集，图像/浏览器、生产激活/打包、Bun/其他Node及桌面性能仍未验证。用户已手动解锁；最后C23无需恢复，known-locked guard继续生效，不能把TCC getter或fixture isVisible代替console/精确AX门禁。

普通 coding 仍不加载 native；P01 回退只需取消显式注册并关闭 service。新模块未被产品路径引用，二进制仍仅隔离目录。不要删除其他会话改动；不绕过共享树write-mode提交hook。后续状态与解除条件只在任务记录维护。
