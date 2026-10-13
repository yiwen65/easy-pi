# web_fetch 整改任务状态（TASK_STATUS）

执行对象：`pi/docs/web_fetch/WEB_FETCH_REMEDIATION_PLAN.md`（WF00–WF09）。
本文件是唯一的任务状态来源；每个任务只更新自己的小节。原始测试日志放在
`docs/web_fetch/logs/`（该目录未入版本控制）。

## 0. 全局基线

| 项目 | 值 |
| --- | --- |
| 仓库 | `/Users/w/Projects/easy-pi/pi` |
| 分支 | `my-pi` |
| 起始 HEAD | `2ec7a0ee7e7ecae39211dc680e0c442b03fec987` |
| 审阅参考提交 | `e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2`（是 HEAD 的祖先；`git diff e82fb98b5 HEAD -- packages/pi-web-search` 为空，即本包自审阅提交以来未变） |
| 开工时工作区 | 仅 `?? docs/web_fetch/`（本计划文件），无其它未提交改动 |
| Node / npm | v24.15.0 / 11.12.1 |
| 浏览器 | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，Google Chrome 155.0.8059.40（未加 `--no-sandbox`、未关证书校验） |
| 包 | `packages/pi-web-search`（`@easy-pi/web-search`），源码 `src/*.ts`，dist 被 `.gitignore` 忽略 |
| loader | `packages/coding-agent/dist/core/extensions/loader.js`（实际 Jiti 加载器） |

### 0.1 基线命令与结果（未修改任何源码）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node packages/pi-web-search/test/run.mjs` | PASS：tests 88 / pass 88 / fail 0，exit 0，2.22s | `logs/wf00-offline.log` |
| `node packages/pi-web-search/test/full-page.mjs` | PASS：tests 13 / pass 13 / fail 0，exit 0，191.6s（真实 Chromium + 本地 fixtures） | `logs/wf00-fullpage.log` |
| `npm run check` | 见 §0.2（基线静态检查） | `logs/wf00-check.log` |

### 0.2 全局决策（WF00 决策记录，后续任务必须遵守）

1. **会话/分支归属以宿主对象为准**：快照所属者是 `ctx.sessionManager`
   （`ReadonlySessionManager`，由 host 注入，模型不能填写）。存储用
   `WeakMap<ReadonlySessionManager, Store>` 挂在会话宿主对象上，不使用按 URL 索引的
   模块级 Map。native child（`pi-child-session-host.ts` 每个子会话自建 `SessionManager`）
   因而天然隔离；`getSessionId()` / `getSessionFile()` 仅用于诊断，不作为授权键。
   若 `ctx.sessionManager` 缺失 → 不建立快照（不降级成全局缓存）。
2. **快照开关**：新增宿主环境设置 `PI_WEB_FETCH_SNAPSHOTS=0`（只由宿主进程环境读取，
   不接受工具参数），关闭后不生成新快照，也不把失效快照请求回退成重新抓取。
3. **快照预算**：绝对 TTL 600s（读取不续期）；每 owner ≤ 8 个 / 8 MiB；宿主进程合计
   ≤ 32 个 / 32 MiB；容量按正文 + metadata + 结构的编码后字节计。时钟、ID 生成器、
   容量在测试中可注入（不用全局假时钟）。
4. **错误码**：`WebError.code` 用于控制流，禁止再用英文文案匹配驱动导航/恢复。
   新增稳定码：`invalid-arguments`、`policy-rejected`、`cancelled`、`read-timeout`、
   `frame-changed`、`frame-budget`、`snapshot-unavailable`、`protocol-failed`、
   `cleanup-failed`。现有 `web-error`、`fake-ip-dns` 保留。
5. **分页单位**：清理后文本的 Unicode 码点；默认 `max_chars=8000`，单页 ≤ 16000 UTF-8
   字节，捕获上限 262144 码点。`offset==total_chars` → 空正文 + `next_offset=null`；
   `offset>total_chars` → 拒绝。`url` + `offset>0` 仍是新捕获，但
   `pagination_consistent=false` 且提示改用 `snapshot_id`。
6. **测试文件归属**：为避免共享文件冲突，各任务使用独立测试文件；
   `test/full-page-child.mjs` 的隔离 harness 抽到可复用模块供新 child 文件使用。
   `test/browser-mock.mjs` 由 WF03/WF04 负责扩展（只增不改语义）。
7. **性能证据**：只记录真实计数（采样次数、全文序列化次数、CDP 字节），不做耗时外推；
   fixtures 与浏览器版本固定，日志只写数字，不含 URL query/hash/正文。
8. **changelog**：当前分支为 `my-pi`（非 `main`），按 `AGENTS.md` 不新增 changelog
   条目，改由包 README 记录行为变化。
9. **契约增补（WF01 起的测试按此断言，WF02/WF03 负责实现）**：
   - `ScanResult` 增加 `frames: { url: string; status: "complete" | "incomplete" | "skipped" | "failed" | "removed"; reasons: string[] }[]`，
     按 frame 记录来源与状态；任一 frame 不完整时聚合 `incompleteReasons` 增加 `frame_incomplete`。
   - frame 局部上限使用带前缀的稳定原因码：`frame_scroll_limit`、`frame_time_limit`、
     `frame_node_limit`、`frame_container_limit`；全局上限仍用 `scroll_limit` / `capture_limit` / `node_limit`。
   - 采样歧义（容器无法判定是回收还是删除）使用稳定原因码 `identity_ambiguous`。
   - 测试文件归属：WF01 采样组 `test/sampling-fixtures.mjs`/`test/sampling-child.mjs`；
     WF01 frame 组 `test/frames-fixtures.mjs`/`test/frames-child.mjs`；WF05 `src/snapshot-store.ts`/`test/snapshot-store.test.mjs`。

### 0.3 阻塞与边界（初始）

- 无公网/真实模型/Tavily 授权：所有验收只用本地 fixtures 与真实 Chromium。
- 计划附件 `evidence/probe-results.json` 在本机不存在，无法复用其原始数据；相关缺陷由
  本地新增 fixtures 复现（WF01）。
- `packages/pi-web-search` 无独立 `build` script；dist 由
  `node scripts/build-easy-pi-product.mjs` 生成（WF09 核对，需按本地规则确认）。

---

## WF00：核对本地基线与接入点

Status: verified
Base HEAD: 2ec7a0ee7e7ecae39211dc680e0c442b03fec987
Changed files: `docs/web_fetch/TASK_STATUS.md`、`docs/web_fetch/logs/`（未跟踪日志）
Reproduction: 基线测试见 §0.1；未修改源码
Tests: `node packages/pi-web-search/test/run.mjs` → 88/88 pass, exit 0（日志 `logs/wf00-offline.log`）；
`node packages/pi-web-search/test/full-page.mjs` → 13/13 pass, exit 0（日志 `logs/wf00-fullpage.log`）；
`npm run check` → 见日志 `logs/wf00-check.log`
Evidence: §0.1 表格、§0.2 决策、§0.3 阻塞
Decisions/deviations: 见 §0.2（1–8）
Remaining risks: 未在非 macOS 平台验证；本机 Chrome 为稳定版 155，非计划的 Chrome for Testing 144
Commit: docs 提交（见 §9 交付记录）
Next: WF01

---

## WF01：把审计线索变成回归测试

Status: verified（C/F 两组回归测试已建立并录得真实 red；green 由 WF02/WF03 负责）
Base HEAD: bacb12cbd
Changed files: `test/sampling-fixtures.mjs`、`test/sampling-child.mjs`（C01–C09b，10 测试）；
`test/frames-fixtures.mjs`、`test/frames-child.mjs`（F01–F05，7 测试）；`test/browser-harness.mjs`（共享隔离 harness，已单独提交 bacb12cbd）
Reproduction: `node packages/pi-web-search/test/full-page.mjs --child=sampling-child.mjs` → tests 10 / pass 3 / fail 7，exit 1（`logs/wf01-sampling-red.log`，另一次独立运行 `wf01-sampling-red-run1.log` 结果一致）；
`node packages/pi-web-search/test/full-page.mjs --child=frames-child.mjs` → tests 7 / pass 0 / fail 7，exit 1（`logs/wf01-frames-red.log`）
Tests: 见上；两组均由真实 Chromium（Chrome 155.0.8059.40，sandbox 开，TLS 校验开，仅 loopback fixtures）运行，
页面可观察触发（details `toggle` / 滚动容器行内 style 变化）替代裸 sleep，每条失败均断言“触发已发生”。
Evidence: 独立抽查原始日志确认。Red 清单（带实际错误输出）：
采样组：C01 布局位移后 ALPHA/BETA 各出现两次；C04 删除块被移位段覆盖、`C04_TAIL` 重复两次；
C06 未键回收行全部保留但未披露歧义；C07 `display:contents` 直接文字丢失；C08 `opacity:0` 子树文字被采集；
C09 三个不同块共享 `data-row-key=dup-1` 后坍缩为一个且字体重排产生重复；C09b 重复 data id 使 `revision` 每次采样交替，
读取直到 90s 截止才返回部分结果（实测 90046ms）。Green 保留：C02、C03、C05。
frame 组：F01 失控子 frame 的 `container_limit` 置全局 `stopped`，兄弟 iframe 与主文尾部丢失；F02 已 `done` 的 frame 被永久跳过（
图内 DOM 晚更新后旧值仍被当作最终值且 `scanComplete=true`）；F03 已移除 frame 的文本与替换者同时序列化；F04b 被替换文档的 200 正文
仍被当作当前内容；F04a/F04c/F05 内容行为已正确，只是缺少冻结契约的 `frames[]`/`frame_incomplete` 来源记录。
Decisions/deviations: 新增设计决策——采样歧义披露走 `ambiguities` 频道（稳定码 `identity_ambiguous`），不进入 `incompleteReasons`，
以免把合法的位置式虚拟列表（旧 `/recycled` 用例、`scanComplete=true`）全局降级；C06 断言允许两个频道任一，但披露本身仍为必需。
Remaining risks: 旧版 harness 全组（13）与离线组（98）在本次未重跑（WF02/WF03 会跑）；C09/C09b 目前仅各一次运行，
其稳定性在转绿后需重测；Chrome 为稳定版 155，绝对耗时不与审阅环境可比。
Commit: 与 WF02/WF03 修复一同提交（见 §9）
Next: WF02 / WF03

---

## WF02：修正文本采样语义

Status: verified
Base HEAD: bacb12cbd
Changed files: `src/page-scan.ts`（重写采集器）；`test/sampling-child.mjs`（仅 C06 歧义断言频道）；`test/sampling-fixtures.mjs`（新增）
Reproduction: WF01 采样组 red（3/10）；C09b 旧实现在 90046ms 后才因截止返回部分结果
Tests: 子代理与根 agent 各自实测：`--child=sampling-child.mjs` → 10/10 pass，exit 0（`logs/wf02-sampling-green.log`，
根复核 `logs/wf02-03-root-verify.log`）；`full-page.mjs` → 13/13 pass；`run.mjs` → 98/98 pass；`tsc --noEmit` exit 0
Evidence: 身份改三档——显式逻辑键（含同串重复键的文档序 ordinal 消歧）、普通块的节点身份（WeakMap，坐标不参与）、
回收容器内的容器相对坐标（保留、有界 2000/region、披露 `identity_ambiguous`）；
删除/隐藏块在最新一次采样未被观察到时丢弃；可见性改用 text Range 测量（`display:contents` 可读、`opacity:0`/`display:none`/`content-visibility:hidden` 排除、
`visibility:visible` 覆写保留、屏幕外正文保留）；新增 `contentRevision`/`layoutRevision`（`revision` 保持内容修定）；
DOM 写在几何/文本读取之前。C01/C04/C07/C08/C09/C09b 由 red 转 green（C09b 90046ms → 7053ms）；C02/C03/C05 保持 green。
Decisions/deviations: 歧义披露走新字段 `PageSample.ambiguities`（稳定码 `identity_ambiguous`），不进入 `incompleteReasons`，
因此旧 `/recycled`（位置式回收）仍 `scanComplete=true`；C06 断言允许两个频道任一（披露仍必需，见附件 `logs/wf02-diffs.txt`）。
Remaining risks: 回收容器判定是启发式（滚动容器中 ≥ 2 个绝对定位/变换文字块且隐含项数远超 DOM 子节点）；
显式键/位置条目在容器存在期间保留，故页面合法删除已键控块时文字会保留；重复键 ordinal 依赖文档序，
重排重复键兄弟节点会产生 revision 波动（均未被现有 fixtures 覆盖）。
Commit: 84e698971
Next: WF07（性能）

---

## WF03：frame 局部失败隔离与生命周期

Status: verified
Base HEAD: bacb12cbd（与 84e698971 并行）
Changed files: `src/frame-scan.ts`（856 行，驱动器/状态机重写）；`src/browser.ts`（仅 WebError 码与 `Network.responseReceived` 的 loaderId 转发）；
`test/frames-fixtures.mjs`、`test/frames-child.mjs`（新增）
Reproduction: WF01 frame 组 red（0/7），含旧实现把子 frame 的 `container_limit` 当全局 stopped、子 frame 丢失、
已移除 frame 文本与替换者同时序列化、被替换文档的 200 正文仍当日前内容
Tests: 子代理与根 agent 各自实测：`--child=frames-child.mjs` → 7/7 pass，exit 0（`logs/wf03-frames-green.log`、重复运行 `wf03-frames-rerun.log`、根复核 `wf02-03-root-verify.log`）；
`full-page.mjs` → 13/13；`run.mjs` → 98/98；`tsc --noEmit` exit 0
Evidence: 全局预算（取消/90s/262144 码点/主导航上限/160 步）与 frame 局部预算（48 步、20s、采样上限 → `frame_scroll_limit`/`frame_time_limit`/`frame_container_limit`/`frame_node_limit`）分离；
轮转公平调度（每轮每个活跃 frame 一个短步）；按 frameId+loaderId+session+isolated world 管理代次，
真移除由父 frame tree 缺席或 `DOM.getFrameOwner` 失败证明；HTTP 状态绑定 loaderId 并按观察时间排除旧文档的 4xx/5xx；
结束前有界复核（≤ 2 轮、<75s）；`frames[]` + `frame_incomplete`；`ambiguities` 透传（不进 `incompleteReasons`、不改 `scanComplete`）。
Decisions/deviations: 1) `removed` 条目 url 为空串（不保留旧来源 URL）；2) `frames[]` 顺序为“嵌入 frame（发现顺序）+ 主文档最后”（合同未规定顺序，此处固定）；
3) 主文档不设 frame 局部时间/步数上限（只用全局上限，避免截断合法长正文）；4) 错误控制流改用 `WebError.code`。
Remaining risks: `/infinite` 现在走到 90s 截止路径（旧行为约 80s 撞 160 步上限），原因 `timeout`，
属轮次步进的节奏开销，已列入 WF07 优化项（不得靠减少正文或漏读 frame 换取）；F04a/F04b 这类时序路径只跑了两次 green，未做压力重复；
仅 macOS/Chrome 155 验证。
Commit: 6b766a76a
Next: WF04

---

## WF04：清理、取消、资源与可观测性

Status: verified
Base HEAD: 6b766a76a
Changed files: `src/browser.ts`、`src/network.ts`（仅计量，策略不变）、`src/frame-scan.ts`（仅采样计数）、
`test/browser-mock.mjs`（仅附加选项）、`test/resources.test.mjs`（新增 22 测试）
Reproduction: R01–R04 为新建验收；旧实现的单次组探测在真实浏览器上 13 个用例中 11 个误报 `cleanup-failed`
Tests: 子代理与根 agent 各自实测：`run.mjs` 128/128 exit 0；`full-page.mjs` 13/13；`--child=sampling-child.mjs` 10/10；
`--child=frames-child.mjs` 7/7；`tsc --noEmit` exit 0（日志 `logs/wf04-*.log`、根复核 `logs/wf04-06-root-verify*.log`）；
R01–R04 共 22 个新测试重复 5 次无 flake
Evidence: 关闭顺序为“停止新操作 → 有界 `Browser.close` → 对本次拥有的进程组有界 SIGTERM → SIGKILL → 验证组已消失 → 关闭管道 → 删目录”；
只在 `process.kill(-pid, …)` 上对本次 spawn 的子进程组发信号，观察过 exit 事件后不再发信号（PID 复用防护）；
`process.kill(-pid, 0)`（EPERM 视为存在）判定后代，不能确认时抛 `cleanup-failed` 并保留目录、绝不返回成功；
取消覆盖排队/启动/导航/采样/结束复核/清理，统一稳定码 `cancelled`；CDP 分片/批量/畸形/超大/断管/超时都解决全部 pending；
进程级槽位限流默认 2（宿主环境 `PI_WEB_FETCH_CONCURRENCY` 1..8，无效回退 2，FIFO 且可取消），不做 per-call semaphore；
`RenderedPage.metrics` 提供分阶段耗时（`hrtime`）、samples、CDP 收发字节、代理请求/传输字节、browsers、queued。
Decisions/deviations: 取消与清理失败同时发生时以 `cancelled` 为准（仍保留目录、不返回成功）；
`metrics.proxyBytes` 是钉扎出站 socket 的传输字节（含帧/TLS），不等于解压后正文大小；未改 `network.ts` 任何策略、限额或超时。
Remaining risks: 嵌套 codemode 并发与宿主 `executionResource` 未在此环节实测（WF06 已用真实 codemode 验证嵌套调用）；
Linux 的进程组 drain 时序未验证；仅 macOS/Chrome 155。
Commit: 5a63c72b5
Next: WF07

---

## WF05：有界、不可变、会话隔离的快照存储

Status: verified
Base HEAD: bacb12cbd
Changed files: `src/snapshot-store.ts`（新增）、`test/snapshot-store.test.mjs`（新增，10 测试）
Reproduction: 新建验收（S01–S07 另加 S08/S09）
Tests: `run.mjs` → 98/98 exit 0（当时基线 88）；`tsc --noEmit` exit 0；根 agent 独立重跑并核对 sha256
Evidence: owner 隔离用 `WeakMap<object, SnapshotStore>` + store 级 owner 绑定；绝对 TTL 600s、读取不续期、无持留定时器；
每 owner 8 个/8 MiB、进程 32 个/32 MiB、确定性 LRU 淘汰；`get` 返回深冻结副本；32 hex 随机 ID（可注入 idFactory）；
超出预算/非法内容 `put` 返回 undefined（不造假句柄）；`snapshotsEnabled()` 由宿主环境 `PI_WEB_FETCH_SNAPSHOTS=0` 控制，
无 owner 或关闭时返回 undefined（不降级成共享缓存）。
Decisions/deviations: 额外导出 `SnapshotPool` 与可注入 `pool`，用于真实进程级额度；metadata 采用“拒绝而非截断”。
Remaining risks: 未测 WeakMap/GC 回收与真实多会话并发额度交互。
Commit: 60daaeef5
Next: WF06

---

## WF06：工具入口、分页与 codemode 的结构化契约

Status: verified
Base HEAD: 6b766a76a
Changed files: `src/index.ts`（473+/71-）、`test/tool-contract.test.mjs`（新增，8 测试：P01–P05）、
`test/offline.test.mjs`（经授权仅改 2 处既有断言）
Reproduction: P01–P05 为新建验收；`offset == total_chars` 的 EOF 语义按计划 §2.2 变更（旧断言随之迁移）
Tests: `run.mjs` 128/128 exit 0；`full-page.mjs` 13/13；`--child=sampling-child.mjs` 10/10；`--child=frames-child.mjs` 7/7；
`tsc --noEmit` exit 0；根 agent 独立重跑一致（日志 `logs/wf06-*.log`、`logs/wf04-06-root-verify*.log`）
Evidence: 输入契约 `url?`/`snapshot_id?`/`offset?`/`max_chars?` 且 `additionalProperties:false`，运行时严格校验
（未知字段、两者同时提供或同时缺失、非法 id 形状都在任何外部动作前拒绝）；快照路径纯内存；
提交规则为“未取消 + 已校验 + 清理完成后”，取消不发布 ID，容量不足返回 `snapshot_id:null` + 警告；
未知/过期/淘汰/越权/关闭统一抛同一 `snapshot-unavailable`（不泄露存在性、不自动重抓）；
分页仍是清理后文本的码点切片（单页 ≤ 16000 UTF-8 字节、不切码点），`offset==total` 为空 EOF 页，
`url+offset>0` 标 `pagination_consistent=false`；`content`/`structuredContent`（新 `outputSchema`，22 字段，仅当前页）/`details`
来自同一规范化对象；描述与 promptGuidelines 已改写为“一次性浏览器捕获 vs 短期内存续页”、TTL/配额/关闭设置与 EOF 契约；
真实 codemode 嵌套调用（QuickJS）实测直接拿到 structuredContent（无需正则解析）。
Decisions/deviations: 1) 输入 schema 不声明单独 required 字段（`url`/`snapshot_id` 二者取一由运行时强制），
根 agent 已确认——若声明 `required:["url"]` 会使模型无法使用续页路径；2) 续页页面目前不保留捕获期运行计数
（`frames_read`/`scroll_steps`/`blocked_requests`/`dns_mode`/`stabilized`/`ambiguities`），并在正文中明确说明，
该缺口列入 WF08；3) `details.provider` 在续页为 `"snapshot"`，`dns_mode` 新增字面量 `"none"`。
Remaining risks: 配额拒绝路径（`put()` 返回 undefined）离线不可直接触发，由 WF05 S06 与关闭开关路径覆盖；
快照路径的真实浏览器行为仅通过 mock + codemode 实跑覆盖。
Commit: 60daaeef5
Next: WF07 / WF08

---

## WF07：去除重复扫描与安全的等待优化

Status: verified（Part A 全部落地并有真实计数；Part B 未启用并记录理由）
Base HEAD: 60daaeef5
Changed files: `src/page-scan.ts`、`src/frame-scan.ts`、`src/browser.ts`、`test/resources.test.mjs`（仅新增 M04 与
`serializations` 指标断言）、`test/perf-child.mjs`、`test/perf-fixtures.mjs`、`test/bench.mjs`（新增）
Reproduction: M01 静态页 70 samples / 2 serializations；隔离世界 49 次采样只解析 2 次（基线 23 次采样解析 45 次）
Tests: 根 agent 独立重跑：`run.mjs` 129/129 exit 0、`npm run check` exit 0、`--child=sampling-child.mjs` 10/10、
`--child=frames-child.mjs` 7/7、`--child=perf-child.mjs` 7/7、`full-page.mjs` 13/13（`logs/wf07-root-verify.log`）
Evidence: M03 交错 10×6 页（`logs/bench-wf07-10x.json`）：中位数 -3.8%…-12.6%，`cdpBytesOut` 下降 6.4–16 倍，
6 页正文 sha256 与基线版本完全一致，0 失败 0 残留临时目录；M02 负例全绿（迟到正文、字体重排、同文档 hash 路由、
持续计数器：捕获或标不完整，绝无假完成，均在既有 90s 政策内结束）；M04 并发+取消（槽位不超配、正常读取照常推进、
无可取消排队者不占用浏览器、无泄漏）。
Decisions/deviations: 初始化探针改用采集器 revision（不再读 `document.body.innerText`），
`metrics.samples` 语义扩为含初始化探针；Part B（MutationObserver 变化驱动采样）未启用——
它观察不到字体/CSS/图片重排，保留同等频率全量校验则无收益，反而有迟文本/重排/hash 路由/计数器静默回归风险；
`test/resources.test.mjs` 中既有的 metrics 键列表断言因新增 `serializations` 而追加（附加字段，非放宽）。
Remaining risks: 变化检测用 64 位指纹而非逐字节比较；p95 每组仅 10 样本（计划建议 ≥30 才做 p95 断言）；
仅 macOS/Chrome 155。
Commit: ac1ec3a16
Next: WF08

---

## WF08：结构化阅读与内容质量说明

Status: verified
Base HEAD: ac1ec3a16
Changed files: `src/content-format.ts`（新增：渲染器）、`src/page-scan.ts`（附加结构采集）、
`src/frame-scan.ts`（结构透传与 frame 来源）、`src/snapshot-store.ts`（附加捕获期元数据/结构，字节计含它们）、
`src/index.ts`（`format` 参数、渲染、来源输出、`content_status`）；新增测试
`test/structure-fixtures.mjs`、`test/structure-child.mjs`（真实浏览器 4 测试）、`test/structure-contract.test.mjs`（离线 O04）；
`test/snapshot-store.test.mjs`（附加 S10）；经授权的 3 处最小既有断言更新（见下）
Reproduction: O01–O04 为新建验收；实现过程中发现并修复 2 个真实缺陷（嵌套滚动区产生无类型结构条目、
markdown 边界映射错位容器块），均有 red→green 证据
Tests: 根 agent 独立重跑：`run.mjs` 140/140 exit 0、`npm run check` exit 0、`--child=sampling-child.mjs` 10/10、
`--child=frames-child.mjs` 7/7、`--child=perf-child.mjs` 7/7、`--child=structure-child.mjs` 4/4、
`full-page.mjs` 13/13（`logs/wf08-root-verify.log`；子代理原始日志 `logs/wf08-*.log`）
Evidence: 结构块类型集 `heading(level)/paragraph/list-item(ordered,depth,ordinal)/code/table/row/cell/link/frame/other`，
块 `start`/`end` 是本 frame 文本的码点偏移，块 ID `f<frame>b<n>`；每 frame ≤4000 块/≤2000 链接、
每捕获 ≤8000 块、每页上报 ≤128 块/≤128 链接，超额只停止采集并写 `ambiguities: structure_truncated`（不进 `incompleteReasons`、不改 `scan_complete`）；
text 模式与旧输出逐字节一致；markdown 保留标题层级/列表嵌套/代码缩进/表格行列，不臆造语义；
链接按各 frame 的真实 `document.baseURI` 解析并只对公开、无凭据的 http(s) 目标输出可调用链接，
`javascript:`/`data:`/`file:`/带凭据/非公开目标只给 `allowed:false` 与受限说明，绝不导航或递归抓取；
`details.frames`（frame 来源/状态/原因）与 `details.blocks`（仅当页、有界的块级来源映射）补齐 WF06 缺口；
续页改为报告捕获期计数（`frames_read`/`scroll_steps`/`blocked_requests`/`dns_mode`/`stabilized`/`ambiguities`）并显式标注“capture-time”；
`format` 捕获时固定、续页换格式报稳定码 `format-mismatch`；`content_status` 规则在代码中注释：密码框 + ≤400 码点 → `possible_login`，
固定挑战短语 + ≤1200 码点 → `possible_challenge`，密码框旁完整正文仍为 `content`，无密码框的登录墙不判 `possible_login`；与 `scan_complete` 互不影响。
Decisions/deviations: 1) 块列表与 frame 来源放在 `details` 而非 `structuredContent`（后者 22 键集是 WF06 冻结契约，
避免输出膨胀；代价是 codemode 脚本需从 details 取结构，记为可选后续项）；2) 经授权最小更新 3 处既有断言：
web_fetch 参数表加 `format`、未知字段用例改用 `foo`、续页断言改断捕获期值（均附迁移注释，未删除任何断言）。
Remaining risks: 聚合（多 frame）结构预算仅在离线验证；`possible_login` 需短正文（长登录页带密码框仍报 `content`）、
挑战检测仅文本启发式；markdown 仅转义会改变结构的标记符；`<pre>` 内 CRLF 的偏移映射只有推理未加 fixture；仅 macOS/Chrome 155。
Commit: 见 §9
Next: WF09

---

## WF09：最终验证、文档与交付

Status: verified
Base HEAD: 2ec7a0ee7（开工）→ afd7e299c（收尾文档提交）
Changed files: `packages/pi-web-search/README.md`（契约/限制/配置/验证入口）、
`test/offline.test.mjs`（目录发现用例改按实际入口文件名断言，使同一套件可验证编译产物）、
`docs/web_fetch/TASK_STATUS.md`
Tests: 最终全量（源码入口，真实 Jiti loader）：`node packages/pi-web-search/test/run.mjs` → 140/140 exit 0；
`npm run check` exit 0；真实 Chromium 分组：`--child=sampling-child.mjs` 10/10、`--child=frames-child.mjs` 7/7、
`--child=perf-child.mjs` 7/7、`--child=structure-child.mjs` 4/4、`full-page.mjs` 13/13（`logs/wf08-root-verify.log`）；
**编译产物验证**：`node scripts/build-easy-pi-product.mjs` exit 0（dist 含新增 `snapshot-store.js`/`content-format.js`），
之后 `PI_WEB_SEARCH_EXTENSION=dist/index.js node test/run.mjs` → 140/140 exit 0（真实 loader + 编译入口），
`PI_WEB_FETCH_BROWSER_MODULE=dist/browser.js` 跑 sampling-child 10/10 与 structure-child 4/4（`logs/wf09-dist-verify.log`）。
codemode 嵌套路径由 `test/tool-contract.test.mjs` 的 P05 用真实 QuickJS 执行器实跑（脚本直接拿到 `structuredContent`）。
Evidence: 见 §0.1/§9 与各 WF 小节；本节结论：所有适用强制测试与静态检查通过，未删除或放宽断言，
未关闭 sandbox/TLS、未继承登录态、未接入 Moli/Tavily 变更、未调用真实模型或付费 API。
Decisions/deviations: 当前分支 `my-pi` 非 `main`，按 `AGENTS.md` 不新增 changelog 条目，行为变化由 README 记录；
未执行任何 push/发版/远程 PR。
Remaining risks: 未做公网真实站点验收（无授权）；Linux/Windows 未验证；p95 每组仅 10 样本；
结构聚合预算、`possible_login` 长登录页、`<pre>` CRLF 偏移映射等边界见 WF08；
快照的真实浏览器续页路径由 mock + codemode 实跑覆盖；性能优化未启用 Part B（已记录理由）。
Restart note: 内置模块已重建到 `packages/*/dist`；正在运行的其他 easy-pi 进程需重启才能加载新实现。
Commit: afd7e299c
Next: 无（计划完成）

---

## 10. 交付摘要

| 项目 | 内容 |
| --- | --- |
| 版本 | 起始 `2ec7a0ee7` → 结束 `afd7e299c`（分支 `my-pi`）；Node v24.15.0；Chrome 155.0.8059.40；测试加载的是 `src/index.ts`（默认）或 `dist/index.js`（编译验证） |
| 改动 | WF01 回归组（C/F）；WF02 采样身份/可见性/双修订；WF03 frame 局部预算与文档代次；WF04 清理/取消/CDP/限流/metrics；WF05+WF06 会话隔离快照与结构化分页；WF07 去除重复序列化与上下文/帧树重复查询；WF08 结构与来源、format、链接策略、content_status |
| 正确性 | 新增回归：C01–C09b（10）、F01–F05（7）、M01–M04（7）、O01–O04（4 真实 + 离线契约）、S01–S10、R01–R04（22）、P01–P05（8）；关键 red→green 见各 WF 小节与 `logs/` 原始日志 |
| 隔离 | sandbox 与 TLS 校验全程开启；每次捕获临时 HOME/profile + 最小环境 + 空登录态；仅本地 fixtures；清理/取消/授权/跨会话隔离均有测试 |
| 性能 | 交错 10×6 页对照：中位数 -3.8%…-12.6%，`cdpBytesOut` 下降 6.4–16 倍，6 页正文 sha256 与基线一致，0 失败（`logs/bench-wf07-10x.json`） |
| 契约 | `web_fetch({url})` / `web_fetch({snapshot_id, offset, max_chars?, format?})`；`offset==total_chars` 空结尾页；TTL 10 分钟绝对、每会话 8/8 MiB、进程 32/32 MiB、`PI_WEB_FETCH_SNAPSHOTS=0`；`structuredContent` 22 字段 + `details.blocks`/`details.frames`；错误码见 §0.2.4 |
| 文档 | `packages/pi-web-search/README.md` 已更新；changelog 按分支规则未改；本文件为状态与证据入口 |
| Git | 9 个本地提交（见 §9），未 push、未发版；`docs/web_fetch/logs/` 为未跟踪原始日志 |
| 限制 | 未做公网真实站点/真实模型验收；Linux 未验证；WF07 Part B 未启用；WF08 结构列表在 `details` 而非 `structuredContent` |

---

## 9. 交付记录（提交清单）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `bacb12cbd` | test | 抽出可复用隔离浏览器 harness，`full-page.mjs` 支持 `--child=` |
| `84e698971` | fix | WF02 采样语义（可见性/身份/保留/双修订）|
| `6b766a76a` | fix | WF03 frame 局部预算、文档代次失效、`frames[]` 来源 |
| `5a63c72b5` | fix | WF04 清理顺序/所有权、取消覆盖、CDP 健壮性、槽位限流、metrics |
| `ac1ec3a16` | fix | WF07 去除重复全量序列化/上下文/帧树查询，metrics.serializations，bench 对照 |
| `37fff7fab` | feat | WF08 结构/来源/format/链接策略/content_status |
| `533b9fe05` | docs | TASK_STATUS 与计划文件 |
| `afd7e299c` | docs | README 契约更新、目录发现用例按实际入口文件名断言 |
| `60daaeef5` | feat | WF05+WF06 会话隔离快照存储、快照续页、`structuredContent`/`outputSchema`、EOF 契约 |
