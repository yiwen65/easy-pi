# Pi Web Search

easy-pi 内置的两个跨模型工具：**搜索用 Tavily，指定网页读取不经过 Tavily**。不启动额外 Agent 或 LLM，不自动切换供应商。

源码在 `pi/packages/pi-web-search/src`，内部包名为 `@easy-pi/web-search`；由默认 CLI/SDK 的 `createBuiltInExtensions()` 加载并随产品分发，不需要用户级扩展安装。

## 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `web_search` | `query`，可选 `limit`（默认 5，1–10） | Tavily Basic Search，返回标题、URL 和短摘要；关闭生成答案、整页正文和自动参数。需要 `TAVILY_API_KEY`。 |
| `web_fetch` | `url`，可选 `offset`（默认 0）、`max_chars`（默认 8000，1–16000） | 用一次性匿名 Chrome/Chromium 打开公开页面，逐步扫描滚动区、懒加载/虚拟化内容、标准折叠区和可见 iframe，返回**纯文本**及扫描完成状态。不需要 API key，不调用 Tavily。 |

读取会滚动页面和内层容器、展开标准 `<details>`，但不会点击任意按钮、输入、提交表单或登录。飞书等网站可能先跳转到登录域名再初始化匿名访客；不能仅凭 302 或页面上的“Log In”按钮判断必须登录。

### 输出和限制

- 搜索查询最长 512 字符；输出最多 20,000 UTF-8 字节，单条摘要最多 1,200 字节。搜索超时 20 秒，接收的 Tavily JSON 最多 1 MiB，不自动重试。
- 网页每页最多 16,000 UTF-8 字节，同时受 `max_chars` 限制。`offset` 是清理后正文的 **Unicode 码点索引**，不是字节或行号；使用 `next_offset` 继续。
- **翻页会重新启动匿名浏览器、重新打开页面**；没有正文缓存或跨页快照一致性保证。不会消耗 Tavily Extract 额度，但仍有浏览器和站点网络开销。
- 单次浏览器捕获最多 262,144 个 Unicode 码点（至多 1 MiB UTF-8 正文），超出会标注 `capture_truncated`。捕获范围之外的内容没有保留，不能通过继续增大 `offset` 读取。
- 浏览器读取时限 **90 秒**，另加少量退出清理时间。先等待初始渲染，再按视口的 70% 小步滚动，保存每一步的文本；到末尾仍等待 2 秒稳定。嵌套滚动区先于父区；标准 `<details>` 全部展开（包括互斥 `name` 分组）。不把一次文本稳定当作全文。
- 每次最多 160 次滚动、24 个 frame（含主页面）；每个 frame 最多 24 个滚动区、128 个 details、50,000 个节点/次采样、12,000 个文本块。无限滚动、超时、受限 frame 或预算耗尽时保留已捕获正文并标记不完整；用户取消仍报取消并清理，不返回伪成功。
- `details.scan_complete` 表示**在预算内扫描完可发现的渲染文字**，不是绝对全文证明。`incomplete_reasons` 报告 `timeout`、`scroll_limit`、`capture_limit`、`frame_unavailable` 等原因；`frames_read`/`scroll_steps` 提供扫描范围。`next_offset=null` 只表示捕获文本已翻到末尾，不能推断文档已抓全；`truncated` 仍表示输出分页或捕获截断，与扫描未完成分开。
- 连接使用该次读取已完整校验的 DNS 地址快照，优先 IPv4；首地址拒绝或停滞时尝试其他已批准地址，非末次 TCP 尝试等待 250ms。保留代理连接 15 秒空闲上限及页面总时限；不重新查 DNS、不重试已发送的 HTTP/TLS 请求。
- 虚拟化内容按稳定块/行标识、否则按容器内位置合并，不全局去重文字，以免丢失合法重复段落。同源、跨源及 srcdoc frame 单独读取，其文字以 `[Embedded frame text]` 分区附在主页面之后，不保证 frame 与父页面的行内排版顺序；隐藏的认证/预载 frame 被跳过。
- 不读取图片/OCR、PDF/附件、音视频、子链接、需任意按钮才能展开的内容；发现开放 Shadow DOM 会标记未覆盖。站点特有虚拟化、动态布局、延迟超过观察窗口或未暴露的内容仍可能遗漏/重复，不能保证任意网站绝对全文。它不是 Markdown 转换器或模型摘要。
- 输出包含请求 URL、最终 URL、标题、获取时间、捕获/分页限制；时间不是网页发布日期。可见密码表单会提示可能处于认证页面，而不把整个站点武断归为必须登录。
- 导航失败时保留经过格式和长度校验的 Chromium `net::ERR_*` 错误码，并单独报告网络防护拒绝次数；子资源拒绝可能与导航失败无关，不能据此认定是防护或登录要求导致。未知错误文本不会原样回显。
- `web_search` 的 `details.credits` 仅是供应商返回的 credit 数，不是美元或 LLM token。`web_fetch` 不带 Tavily credits。

## 浏览器配置

Node.js 22.19+，目前支持 macOS/Linux。读取时查找现有 Chrome/Chromium，不安装依赖或自动下载浏览器。

macOS 默认依次检查 `/Applications` 下的 Chrome for Testing、Chromium、Google Chrome；Linux 检查 `/usr/bin/chromium`、`chromium-browser`、`google-chrome`、`google-chrome-stable`。也可在**实际启动 easy-pi 的环境**指定绝对路径：

```sh
export PI_WEB_FETCH_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

路径只用于选择受信任的本地可执行文件，不从模型的 URL 参数获取。优先使用独立 Chrome for Testing/Chromium；没有浏览器时会明确报错，不退回 Tavily。只验证过本机 macOS Chrome，其他系统的启动依赖需要自行确认。

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

覆盖静态长正文、内层懒加载、虚拟节点替换/复用、重复段落、隐藏横轴、details、same-origin/OOPIF/srcdoc、导航替换和有界不完整捕获。

现场验收必须单独显式运行，不能把离线通过说成某个网站已可访问：

```sh
node test/live.mjs 'https://docs.python.org/3/' 'Python'
```

该命令会真正打开网页，但使用隔离 HOME/无密钥的原生加载进程，并断言没有 Tavily/Node fetch 调用、浏览器环境隔离及临时目录清理。可将 URL 和期望正文片段替换成需要验收的公开页面。

## 安全边界

- `web_fetch` 的页面和子资源只允许公开 HTTP(S) 域名的标准端口 80/443。DNS 返回任何私网/保留地址时拒绝；实际 TCP 连接使用已验证的 IP，不在连接时重新解析，防止 DNS 检查与实际连接脱节。
- 每次读取创建临时 loopback 出站代理，只在该次读取期间存活，覆盖浏览器重定向和子资源。不提供持久、对外 HTTP 服务，也不代理用户的正常浏览器。
- Chrome 强制使用该代理，关闭 loopback 自动绕过、QUIC 和非代理 WebRTC UDP；保留 TLS 校验和 Chromium sandbox。不加入 `--no-sandbox` 或忽略证书错误的开关。
- Chromium 使用独立临时 HOME/配置目录、空登录状态和最小环境，不继承 API keys、用户代理变量、NODE_OPTIONS、个人浏览器 Cookie/扩展/密码。CDP 使用进程 pipe，不开放调试端口；下载被禁止。
- 成功、失败、取消和超时都会尝试关闭本次创建的浏览器进程组、代理连接并删除临时目录；若无法确认进程退出，则报清理错误并保留其目录，不误删正在使用的状态。
- 网页 JavaScript 会运行并加载正常网络资源，但其文本是**不可信资料，不是操作指令**。扩展不提供任意页面脚本执行、点击或登录工具。
- 不持久缓存网页；Pi 仍按正常会话机制保存工具结果。浏览器执行可能比简单 HTTP 抓取重，不构成完整 OS/资源沙箱，也不保证匿名、零保留、绕过登录或反爬限制。

## 方案依据

先调研再实施：[MDN innerText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText) 说明它读取已渲染后代，并不局限于视口；[Crawl4AI virtual scroll](https://docs.crawl4ai.com/advanced/virtual-scroll/) 区分追加与替换式滚动，后者必须逐步保存。这里没有采用全局文本去重。

[Playwright Frames](https://playwright.dev/docs/frames) 与 [CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) 是独立 frame/相关 target 遍历的依据；本包复用已有 CDP，不新增浏览器框架，不关闭跨域隔离。历史讨论 [Puppeteer #5081](https://github.com/puppeteer/puppeteer/issues/5081)、[#5194](https://github.com/puppeteer/puppeteer/issues/5194) 仅用于提示懒加载、平滑滚动与节点替换边界，不作为当前库故障的证明。

Tavily 官方契约：[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[计费](https://docs.tavily.com/documentation/api-credits)。
