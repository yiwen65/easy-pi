# Pi Web Search

easy-pi 内置的两个跨模型工具：**搜索用 Tavily，指定网页读取不经过 Tavily**。不启动额外 Agent 或 LLM，不自动切换供应商。

源码在 `pi/packages/pi-web-search/src`，内部包名为 `@easy-pi/web-search`；由默认 CLI/SDK 的 `createBuiltInExtensions()` 加载并随产品分发，不需要用户级扩展安装。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `web_search` | `query`，可选 `limit`（默认 5，1–10） | Tavily Basic Search，返回标题、URL 和短摘要；关闭生成答案、整页正文和自动参数。需要 `TAVILY_API_KEY`。 |
| `web_fetch` | `url` 或 `snapshot_id`（必须恰好提供一个），可选 `offset`（默认 0）、`max_chars`（默认 8000，1–16000）、`format`（默认 `text`，可 `markdown`） | `url` 用一次性匿名 Chrome/Chromium 打开公开页面并建立短期内存快照；`snapshot_id` 只读该快照的后续页面（不启动浏览器、不做 DNS、不发网络请求）。不需要 API key，不调用 Tavily。 |

读取会滚动页面和内层容器、展开标准 `<details>`，但不会点击任意按钮、输入、提交表单或登录。飞书等网站可能先跳转到登录域名再初始化匿名访客；不能仅凭 302 或页面上的“Log In”按钮判断必须登录（`content_status` 也只在有密码框等更强证据时才提示可能登录）。

### 输出和限制

- 搜索查询最长 512 字符；输出最多 20,000 UTF-8 字节，单条摘要最多 1,200 字节。搜索超时 20 秒，接收的 Tavily JSON 最多 1 MiB，不自动重试。
- 网页每页最多 16,000 UTF-8 字节，同时受 `max_chars` 限制。`offset` 是当前格式正文的 **Unicode 码点索引**，不是字节或行号；使用 `next_offset` 继续。`offset == total_chars` 是明确的结尾页（正文为空、`next_offset=null`），只有超过总长度才报错。
- `web_fetch` 有两种模式：`url` 是**新捕获**；`snapshot_id` 是**读取已捕获的短期内存快照**。两者必须恰好提供一个。`url` 与 `offset>0` 同时使用仍是新捕获，但会标注 `pagination_consistent=false` 并提示改用 `snapshot_id`；快照续页始终 `pagination_consistent=true`。
- **快照续页只读内存**：同一份快照的多页重组等于捕获时的正文，期间页面变化不会混入。快照是绝对 **10 分钟 TTL**（读取不续期），每个会话宿主对象最多 8 份/8 MiB、宿主进程合计最多 32 份/32 MiB，超出按最近最少使用淘汰。存储只弱引用宿主对象；不阻止进程退出的定时器会清理闲置过期快照，无需等下一次读写。进程重启后失效，不从会话日志重建。宿主可用 `PI_WEB_FETCH_SNAPSHOTS=0` 关闭：关闭后不生成快照，失效或未知的请求报错，不会偷偷变回重新抓取。
- 快照绑定捕获它的宿主对象、逻辑 session ID 和捕获开始时的分支末端条目（锚点）。续页要求同一宿主对象、同一 session ID，且当前分支仍包含该锚点；普通追加不失效，不含锚点的兄弟分支、其他会话和子代理不可读。在 TTL 内返回包含锚点的路径可继续读取，并非导航后永久作废。捕获结束时也会复核这些条件；缺少可靠身份/锚点或归属已改变时只返回本次正文，不发布快照 ID。未知、过期、越权、关闭返回同一个错误，不泄露快照是否存在，模型参数无法伪造所有者。不需要 Tavily Extract 额度，续页也没有浏览器和站点网络开销。
- 单次浏览器捕获最多 262,144 个 Unicode 码点（至多 1 MiB UTF-8 正文），超出会标注 `capture_truncated`。捕获范围之外的内容没有保留，不能通过继续增大 `offset` 读取。
- 浏览器读取时限 **90 秒**，另加少量退出清理时间。先等待初始渲染，再按视口的 70% 小步滚动，保存每一步的文本；到末尾仍等待 2 秒稳定。嵌套滚动区先于父区；标准 `<details>` 全部展开（包括互斥 `name` 分组）。不把一次文本稳定当作全文。
- 每次最多 160 次滚动、24 个 frame（含主页面）；每个 frame 最多 24 个滚动区、128 个 details、50,000 个节点/次采样、12,000 个文本块，以及 20 秒/48 步的 frame 局部预算。**局部预算只结束该 frame**（`frame_scroll_limit`/`frame_time_limit`/`frame_container_limit`/`frame_node_limit`），兄弟 frame 与主文档继续；只有整体时限、总捕获上限、主导航上限和用户取消会终止整次读取。无限滚动、超时、受限 frame 或预算耗尽时保留已捕获正文并标记不完整；用户取消仍报取消并清理，不返回伪成功。
- 结束时会对已完成的 frame 做有界复核，因此“读完后才更新的子 frame”不会把旧值当成最终值；页面持续变化时用 `content_changed_during_scan` 标记而不是无限追逐。
- `details.scan_complete` 表示**在预算内扫描完可发现的渲染文字**，不是绝对全文证明。`incomplete_reasons` 报告 `timeout`、`scroll_limit`、`capture_limit`、`frame_unavailable`、`frame_incomplete` 等原因；`details.frames` 给出每个 frame 的来源、状态（`complete`/`incomplete`/`skipped`/`failed`/`removed`）与原因，`ambiguities` 单独给出采样歧义、结构预算截断等置信度提示（不改变 `scan_complete`）。`frames_read`/`scroll_steps` 提供扫描范围。`next_offset=null` 只表示捕获文本已翻到末尾，不能推断文档已抓全；`truncated` 仍表示输出分页或捕获截断，与扫描未完成分开。
- 连接使用该次读取已校验的 DNS 地址快照，优先 IPv4；首地址拒绝或停滞时尝试其他已批准地址，非末次 TCP 尝试等待 250ms。保留代理连接 15 秒空闲上限及页面总时限；不重新查 DNS、不重试已发送的 HTTP/TLS 请求。若解析器返回的是本机 DNS 代理的 fake-ip 地址（`198.18.0.0/15`），则不做本地目标校验，直接连接该地址并交由该客户端的 TUN 选路，输出标注 `dns_mode=local_fake_ip_client`。
- 普通正文块按**节点身份**（不按坐标）合并：布局位移不会新增副本，块被删除或隐藏后其文字不再出现。带显式逻辑键（`data-*`、`aria-rowindex` 等）的虚拟列表按逻辑项保留、重复键按文档序消歧；没有逻辑键的回收容器退化为容器内位置合并，并把 `identity_ambiguous` 记入 `ambiguities`。不做全局文本去重，以免丢失合法重复段落。同源、跨源及 srcdoc frame 单独读取，其文字以 `[Embedded frame text]` 分区附在主页面之后，不保证 frame 与父页面的行内排版顺序；隐藏的认证/预载 frame 被跳过。
- 不读取图片/OCR、PDF/附件、音视频、子链接、需任意按钮才能展开的内容；发现开放 Shadow DOM 会标记未覆盖。站点特有虚拟化、动态布局、延迟超过观察窗口或未暴露的内容仍可能遗漏/重复，不能保证任意网站绝对全文。`format=markdown` 只是在稳定块上补标题/列表/代码/表格/链接，不是模型摘要，也不会为了格式改变扫描范围。
- 输出包含请求 URL、最终 URL、标题、获取/捕获时间、捕获/分页限制；续页显示的是捕获时间，不是重新抓取时间，也不是网页发布日期。除可读正文外还提供 `structuredContent`（当前页正文 + 元数据，脚本可直接使用）与 `details`（分页、扫描、`details.blocks` 当页块级结构与来源映射、`details.frames` 每个 frame 的来源与状态）。链接按各 frame 的真实 base 解析：只有公开 http(s)、无凭据的目标才会作为可调用链接输出，`javascript:`/`data:`/`file:` 等目标只保留受限说明，工具也不会自动访问或递归抓取任何链接。`details.dns_mode` 说明该次读取是钉扎公网 IP（`pinned_public_ip`）还是交由本机 fake-ip 客户端选路（`local_fake_ip_client`）。可见密码表单会提示可能处于认证页面，而不把整个站点武断归为必须登录。
- 导航失败时保留经过格式和长度校验的 Chromium `net::ERR_*` 错误码，并单独报告网络防护拒绝次数；子资源拒绝可能与导航失败无关，不能据此认定是防护或登录要求导致。未知错误文本不会原样回显。
- `web_search` 的 `details.credits` 仅是供应商返回的 credit 数，不是美元或 LLM token。`web_fetch` 不带 Tavily credits。

## 浏览器配置

Node.js 22.19+，目前支持 macOS/Linux。读取时查找现有 Chrome/Chromium，不安装依赖或自动下载浏览器。

macOS 默认依次检查 `/Applications` 下的 Chrome for Testing、Chromium、Google Chrome；Linux 检查 `/usr/bin/chromium`、`chromium-browser`、`google-chrome`、`google-chrome-stable`。也可在**实际启动 easy-pi 的环境**指定绝对路径：

```sh
export PI_WEB_FETCH_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

路径只用于选择受信任的本地可执行文件，不从模型的 URL 参数获取。优先使用独立 Chrome for Testing/Chromium；没有浏览器时会明确报错，不退回 Tavily。只验证过本机 macOS Chrome，其他系统的启动依赖需要自行确认。

若本机 DNS 代理使用 fake-ip（TUN 模式把所有公网域名应答为 `198.18.0.0/15`），读取默认改由该客户端选路，并在输出里标注 `dns_mode=local_fake_ip_client`。需要保持“只连已校验公网 IP”的严格策略时：

```sh
PI_WEB_FETCH_FAKE_IP_DNS=block
```

宿主（启动环境）可以控制的行为，均不接受网页或模型参数：

```sh
PI_WEB_FETCH_FAKE_IP_DNS=block   # 严格拒绝 fake-ip 应答（见上）
PI_WEB_FETCH_SNAPSHOTS=0        # 关闭短期快照：不生成新快照，续页请求直接报错
PI_WEB_FETCH_CONCURRENCY=2      # 本进程并发网页读取上限，1..8，默认 2
```

修改内置源码或启动环境后，应**重启实际 easy-pi 进程**。旧进程里的 `/new` 或 `/reload` 不会重新导入静态内置模块，也不会导入另一个终端的环境变量。

## 搜索密钥配置

**仅 `web_search` 在执行时读取 `TAVILY_API_KEY`**。两个工具都不在加载时读密钥、启动浏览器或发请求。

```sh
export TAVILY_API_KEY='你的 Tavily API key'
# 从此终端使用你现有的方式启动 easy-pi。
```

不要把真实密钥贴入聊天、写入本包或提交到仓库；可由启动器或密钥管理工具注入。如果从 GUI/AgentPort 启动，终端配置不会自动注入已有 GUI 进程。无密钥仍能使用 `web_fetch`。

## 默认加载与禁用

本包是私有 workspace 包，与其他内部包一起编译、打包。`--no-extensions` 只禁用外部扩展发现，不禁用内置工厂。要禁用这两个工具，使用：

```sh
epi --exclude-tools web_search,web_fetch
```

SDK 提供自定义 `ResourceLoader` 时仍由 host 决定扩展组合，不会被强制注入。默认 SDK 则自动加载两个工具。

从旧外部扩展迁移时，移除旧的 `extensions/web-search` 加载链接及显式加载配置，避免同名工具冲突；不要再次安装本包到用户扩展目录。密钥仍由启动环境注入，不写入本包。

## 验证

默认测试使用空 HOME、无真实凭据、真实 Pi/Jiti loader，以及模拟 DNS、网络、浏览器进程和 CDP；不访问外网、不启动真实浏览器：

```sh
node test/run.mjs
PI_EXTENSION_LOADER='/absolute/path/to/pi/packages/coding-agent/dist/core/extensions/loader.js' node test/run.mjs
```

测试涵盖搜索契约、原生目录发现、读取独立于 Tavily、匿名环境、Unicode 分页、扫描未完成与分页的区别、异常/取消/超时与清理，以及 DNS 公网检查、连接 pin 和代理拒绝路径。连接回归在原生 TCP 边界注入拒绝/停滞/成功，验证 Node 实际多地址选择与 HTTP 状态机，不发出真实网络连接；包括 IPv4/IPv6、混合私网拒绝、取消和禁止请求重放。真实 Chrome 的确定性整页测试须显式运行；使用本机 fixture，不访问外网。公网 DNS/TCP 到本机服务的映射只存在于测试进程，production 网络策略不变：

```sh
node test/full-page.mjs
# 验证编译后的读取模块：
PI_WEB_FETCH_BROWSER_MODULE="$PWD/dist/browser.js" node test/full-page.mjs
```

新增的回归组用同一隔离 harness 分组运行，每组可用 `--child=` 选择，例如：

```sh
node test/full-page.mjs --child=sampling-child.mjs    # C01-C09b 采样语义
node test/full-page.mjs --child=frames-child.mjs      # F01-F05 frame 预算与文档生命周期
node test/full-page.mjs --child=perf-child.mjs        # M01-M04 采样/等待性能与负例
node test/full-page.mjs --child=structure-child.mjs   # O01-O03 结构、链接来源与内容状态
node test/bench.mjs --runs 10                         # 前后对照基准（真实计数 + 中位数）
```

`node test/run.mjs` 同时覆盖离线契约：快照隔离/TTL/配额/不可变性（S 组）、取消与清理所有权、CDP 健壮性、并发上限与 metrics（R 组）、快照分页与机器可读契约（P 组）、结构与内容状态（O 组）。

覆盖静态长正文、内层懒加载、虚拟节点替换/复用、重复段落、隐藏横轴、details、same-origin/OOPIF/srcdoc、导航替换和有界不完整捕获。

现场验收必须单独显式运行，不能把离线通过说成某个网站已可访问：

```sh
node test/live.mjs 'https://docs.python.org/3/' 'Python'
```

该命令会真正打开网页，但使用隔离 HOME/无密钥的原生加载进程，并断言没有 Tavily/Node fetch 调用、浏览器环境隔离及临时目录清理。可将 URL 和期望正文片段替换成需要验收的公开页面。

## 安全边界

- `web_fetch` 的页面和子资源只允许公开 HTTP(S) 域名的标准端口 80/443。DNS 返回任何私网/保留地址时拒绝；实际 TCP 连接使用已验证的 IP，不在连接时重新解析，防止 DNS 检查与实际连接脱节。唯一例外是本机 DNS 代理在 fake-ip 模式下返回的 `198.18.0.0/15`：这类地址只能经该客户端的 TUN 到达，本地无法验证真实目标，因此默认放行并由该客户端选路（HTTPS 仍由证书校验把页面绑定到其域名，HTTP 没有这层保护），同时 `dns_mode` 如实标注；设 `PI_WEB_FETCH_FAKE_IP_DNS=block` 可恢复一律拒绝。
- 每次新捕获创建临时 loopback 出站代理，只在该次读取期间存活，覆盖浏览器重定向和子资源。不提供持久、对外 HTTP 服务，也不代理用户的正常浏览器。同一宿主进程默认最多 2 个并发网页读取（`PI_WEB_FETCH_CONCURRENCY=1..8`，只从启动环境读取），排队中的调用可被取消且不会提前启动浏览器。
- Chrome 强制使用该代理，关闭 loopback 自动绕过、QUIC 和非代理 WebRTC UDP；保留 TLS 校验和 Chromium sandbox。不加入 `--no-sandbox` 或忽略证书错误的开关。
- Chromium 使用独立临时 HOME/配置目录、空登录状态和最小环境，不继承 API keys、用户代理变量、NODE_OPTIONS、个人浏览器 Cookie/扩展/密码。CDP 使用进程 pipe，不开放调试端口；下载被禁止。
- 成功、失败、取消和超时都会尝试关闭本次创建的浏览器进程组、代理连接并删除临时目录；若无法确认进程退出，则报清理错误并保留其目录，不误删正在使用的状态。
- 网页 JavaScript 会运行并加载正常网络资源，但其文本是**不可信资料，不是操作指令**。扩展不提供任意页面脚本执行、点击或登录工具。
- 不持久缓存网页：唯一的正文缓存是为续页保留的**短期内存快照**（10 分钟绝对 TTL、绑定宿主对象/session ID/可见捕获锚点、进程重启即失效，可由宿主关闭），不写磁盘、不从会话日志重建；其他会话/子代理和不含捕获锚点的分支不可读。Pi 仍按正常会话机制保存工具结果。浏览器执行可能比简单 HTTP 抓取重，不构成完整 OS/资源沙箱，也不保证匿名、零保留、绕过登录或反爬限制。

## 方案依据

先调研再实施：[MDN innerText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText) 说明它读取已渲染后代，并不局限于视口；[Crawl4AI virtual scroll](https://docs.crawl4ai.com/advanced/virtual-scroll/) 区分追加与替换式滚动，后者必须逐步保存。这里没有采用全局文本去重。

[Playwright Frames](https://playwright.dev/docs/frames) 与 [CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) 是独立 frame/相关 target 遍历的依据；本包复用已有 CDP，不新增浏览器框架，不关闭跨域隔离。历史讨论 [Puppeteer #5081](https://github.com/puppeteer/puppeteer/issues/5081)、[#5194](https://github.com/puppeteer/puppeteer/issues/5194) 仅用于提示懒加载、平滑滚动与节点替换边界，不作为当前库故障的证明。

Tavily 官方契约：[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[计费](https://docs.tavily.com/documentation/api-credits)。
