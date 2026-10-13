# easy-pi web_fetch 整改开发计划

> 执行对象：在本地 easy-pi 仓库工作的开发 Agent。
> 目标：完成代码整改、回归测试、性能对照与开发文档更新，而不是再次输出分析报告。
> 计划日期：2026-10-13。审阅参考提交：`e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2`。
> 执行依据：**本地 HEAD、适用的 AGENTS.md 与实际类型定义优先**。参考提交只用于定位，不得为了匹配本文回退本地代码。
> 本文中的新增接口、预算、测试名称与模块划分是设计要求或建议，不代表仓库已存在。

## 0. 开始执行前的约定

你正在整改 `packages/pi-web-search` 的 `web_fetch`。默认按 WF00–WF09 顺序完成全部任务，每个任务必须包含实施、验证和证据，不得只写 TODO、接口空壳或测试跳过项。

工作分两个里程碑：**A：WF00–WF07，正确性、隔离、稳定分页和低风险性能整改；B：WF08–WF09，结构化阅读与最终验收**。可以在 A 验收后报告阶段性交付，但 B 未完成时不得声称整份计划完成。

### 0.1 工作区和工具纪律

1. 先完整阅读根目录及受影响目录的 `AGENTS.md`、相关实现和测试。先记录本地分支、HEAD、已有 staged/unstaged/untracked 改动，再编辑。
2. 不覆盖用户或其他 Agent 的改动；不执行 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`、强推、跳过 hooks。只暂存自己修改的明确路径；不使用 `git add .` 或 `git add -A`。
3. 不擅自切换分支、checkout 审阅提交、发版、push、创建远程 PR。是否自动本地 commit，以当前适用的仓库规则为准；参考版本要求验证后提交。[S1]
4. 依赖不足时先检查锁文件与实际依赖。允许时使用 `npm install --ignore-scripts` 或 `npm ci --ignore-scripts`；不执行安装生命周期脚本，不静默升级依赖或修改锁文件。原则上本次不引入浏览器驱动库或新运行时依赖。
5. 修改代码后运行适用的静态检查和具体测试。参考规则要求 `npm run check` 输出完整内容；它可能自动改文件，运行前后都要检查工作区，不能把无关格式化变更一起提交。[S1]
6. 不默认执行 `npm run build`、`npm test`、全量裸 Vitest、真实模型请求。先核对本地规则；确需构建 loader 时使用获准的离线构建路径。缺少授权或环境时记录阻塞并继续不依赖它的任务，不能绕过规则。
7. 本次没有真实模型 API、Tavily、付费服务或公网浏览器验收授权。浏览器验收只访问隔离的本地 fixtures。不要读取、输出或复制真实凭据及个人浏览器资料。
8. 发生本地规则冲突、共享文件冲突或新增破坏性变更需求时，不自行扩大授权。记录具体阻塞，保留已验证改动，继续独立任务。

### 0.2 必须保留的安全边界

- Chromium sandbox 与 TLS 校验保持启用，不能添加 `--no-sandbox`、忽略证书错误等绕过配置。
- 每次新捕获使用临时 HOME/profile、最小环境和空登录态；不继承 Cookie、API keys、个人扩展、`NODE_OPTIONS`、用户代理环境。
- 保留临时公网出站代理、重定向及子资源的网络约束、DNS 校验与连接钉扎。fake-IP 的现有行为和标记不能在此次整改中被悄悄改变。[S2][S6]
- 保留禁止下载、隔离世界运行固定采样脚本、不暴露任意页面脚本/点击/登录能力的约束。
- 网页文本、标题、链接、属性和错误详情均为不可信数据；不能变成 Agent 指令、宿主代码、配置或授权来源。
- 用户取消始终返回取消，不返回伪成功，不提交新快照。清理失败不能被成功返回掩盖。
- `readOnly` 表示工具不提供用户意图之外的写入动作，不意味着网页 JavaScript 不会发请求。不能宣称所有浏览器网络请求都天然无副作用。

### 0.3 明确不做

不接入 Moli，不替换 Tavily，不引入 MCP 浏览器服务，不重写 Agent 核心，不复用个人浏览器，不使用跨用户缓存或常驻共享浏览器池，不增加截图/OCR/PDF解析/任意按钮操作，不以 LLM 摘要代替原文，不靠增加所有超时或把所有页面标为不完整来通过测试。

## 1. 已知线索、证据强度与代码地图

### 1.1 缺陷线索不是既成验收结论

随计划提供的 `evidence/probe-results.json` 是前次审查的局部采样结果：Chromium `144.0.7559.96`、隔离世界、本地无外网夹具；该 root 容器探针关闭过浏览器 sandbox。**它只能帮助构造复现，不能证明完整 web_fetch 的缺陷发生率、生产隔离有效性或本次改动已经通过测试。**本次正常验收必须保持 sandbox；不能因为旧探针这样运行，就复制这一运行参数。[E1]

| 线索 | 已有证据 | 本地必须重新证明的行为 |
| --- | --- | --- |
| 布局位移导致正文重复 | 局部探针显示 `ALPHA/BETA` 位移后重复 | 同一段移动后只保留一份，完整 readPage 不混入重复 |
| `display: contents` 文字漏读 | 局部探针有可见文字但采样缺失 | 文本及嵌套 inline 节点均完整保留 |
| 透明祖先文字混入 | 局部探针采集了 `opacity:0` 内文字 | 不把不可见文字当作可见正文；屏幕外正常正文仍可读取 |
| 删除后的旧段落残留 | 有稳定标识的块被删后仍保留 | 普通删除和虚拟化回收语义不同，分别正确处理 |
| 分页重新抓取 | index.ts 每次执行 readPage 后再切片 | 新快照续页不启动浏览器、不产生网络，版本和偏移一致 |
| 子 frame 耗尽预算影响全页 | frame-scan.ts 有共享 stopped 路径 | 局部上限只终止该 frame，全局上限仍终止全任务 |
| 完成/移除的 frame 内容过期 | 生命周期路径审计线索 | 区分同文档更新、真正移除、导航和进程交换 |
| 固定等待、全量重复采样开销 | 代码路径推导 | 用实际指标证明开销下降，不填写推测的加速倍数 |
| 主进程退出但后代仍存活 | 需要补强的异常验收 | 只清理本次拥有的进程，并确认退出/保留状态 |

`same_coordinate` 等只有单次输出、缺少完整输入和对照的探针，不得直接命名为“已确认丢失”；构造完整 fixture 后再判定。

### 1.2 首批阅读范围

| 文件或区域 | 职责与本次重点 |
| --- | --- |
| `packages/pi-web-search/src/index.ts` | 工具注册、参数、输出清理、分页、提示、结构化契约 |
| `src/page-scan.ts` | 文本采样、可见性、逻辑块身份、滚动容器与序列化 |
| `src/frame-scan.ts` | frame 调度、隔离世界、导航/完成状态和全局合并 |
| `src/browser.ts` | Chromium/CDP 生命周期、取消、超时与清理 |
| `src/network.ts` | 公网代理、DNS 策略、计量及错误码 |
| `test/run.mjs`、`test/offline.test.mjs`、`test/browser-mock.mjs` | 隔离 loader、工具契约与 mock 回归 |
| `test/full-page.mjs`、`test/full-page-child.mjs`、`test/full-page-fixtures.mjs` | 真实 Chromium、本地页面回归 |
| `test/network.test.mjs`、`test/connection.test.mjs` | 网络策略、钉扎、连接选择及取消 |
| 包 README、包/根 `package.json`、`test.sh` | 环境、受支持命令、测试约束和文档 |
| coding-agent 扩展类型、内置加载器、codemode 适配与资源调度 | 查明真实 session/branch/授权/生命周期接口，禁止猜测 |

参考版本中 `@easy-pi/web-search` 私有包没有独立 `build` script，不能直接编造 `npm run build --workspace=@easy-pi/web-search`。[S10]

## 2. 目标契约：先固定语义，再写实现

以下决策默认执行；如本地类型或实现迫使调整，在 WF00 的决策记录中写明差异及替代方案。

### 2.1 内容捕获不是同一时刻的整个网页

普通文档块采用最新可观察状态；识别出的虚拟化容器允许保留滚动过程中读到的逻辑项目。最终结果是一次**有界遍历捕获**，不是整个网站同一时刻的原子快照。

因此，`snapshot_id` 指向的是“遍历结束后冻结的提取结果”，只保证后续分页一致，**不证明所有 DOM/frame 在同一毫秒被读到**。保留 `capture_started_at` / `captured_at` 与覆盖说明。

虚拟化判断有歧义时，不能把“节点不在 DOM”一律视为删除，也不能一律无限保留。保留有证据的逻辑项目，标记对应容器的 `identity_ambiguous` 或 `content_changed_during_scan`；普通静态测试仍须能够得到完成状态，不能全局降级掩盖算法缺陷。

### 2.2 输入与分页

建议使用保持现有 URL 入口的扁平参数对象，并在运行时严格验证；不要未经 provider 适配测试就引入顶层复杂联合 schema。

```ts
// 建议契约；最终按本地 TypeBox/ExtensionAPI 定义实现。
type WebFetchInput = {
  url?: string;
  snapshot_id?: string;
  offset?: number;
  max_chars?: number;
  // WF08 才增加；默认 text。快照一旦创建，其格式固定。
  format?: "text" | "markdown";
};
```

| 输入组合 | 规定行为 |
| --- | --- |
| `url`，无 snapshot_id | 新捕获；可用时创建新快照，返回首个或指定输出切片 |
| `snapshot_id`，无 url | 只读取已授权快照，不做 DNS/网络/浏览器工作 |
| 两者同时提供或同时缺失 | 参数错误，发生任何外部动作前拒绝 |
| 旧式 `url + offset>0` | 仍是新捕获；明确 `pagination_consistent=false`，不冒充同一版本续页；提示使用 snapshot_id |
| 快照过期、淘汰或进程重启后丢失 | 明确不可用；绝不偷偷重新抓取 |
| 其他会话/分支/子代理拿到快照 ID | 先进行授权检查；拒绝且不泄漏快照是否存在 |
| 快照续页要求不同 format | 拒绝格式不匹配，不改变原偏移语义 |
| 用户取消、无效页码、无效参数 | 不创建快照，不排队启动浏览器 |

继续按**清理后、固定格式文本的 Unicode 码点**计算 offset，不是 UTF-16 下标或 UTF-8 字节。默认 `max_chars=8000`，正文单页上限 16000 UTF-8 字节；捕获上限 262144 码点，仍应检查最多 1 MiB 正文。`max_chars` 是展示预算，不是扫描预算。[S3][S4]

分页要保证只要还存在正文且预算允许，游标严格前进。`offset==total_chars` 返回空正文、`next_offset=null` 的明确 EOF；`offset>total_chars` 拒绝。新增 EOF 行为须同步测试和文档，不能把空白抓取误认为成功。

### 2.3 不可变快照与授权

快照只保存清理后的文本、受限结构信息和来源/覆盖状态；不保存 HTML 脚本、Cookie、profile、活 CDP 句柄、真实请求头或浏览器进程。

宿主负责提供稳定的 owner/branch/权限范围和清理生命周期，不能由模型填写 owner。随机 ID 不是访问控制。默认禁止跨独立 root、branch、native child 共享；codemode 在同一调用授权范围内可使用快照，但仍走正常工具分发与当前授权检查。

优先挂在实际会话/工具宿主对象上，不使用模块级按 URL 索引的全局缓存。会话结束、切换或权限范围变化后的行为必须明确；若当前宿主无法证明隔离，先禁用该路径而不是降级成跨会话 Map。

**建议初始参数，不是现有参数：**绝对 TTL 10 分钟，不因翻页延长；每 owner 最多 8 个/8 MiB，宿主进程合计最多 32 个/32 MiB；计量包括正文、结构及 metadata 的编码后大小。这个预算不是 JS 堆 RSS 的保证，性能测试另测实际内存。采用有界 LRU/到期清理，可注入假时钟测试。

任何按 URL 的复用策略都不是本次必需；尤其不能丢弃 hash，因为它可能表示 SPA 路由。已有 URL 查询和 hash 不写入普通诊断日志。

保留明确关闭快照的宿主设置入口；复用现有设置机制。需要新增时可以采用受信任启动环境 `PI_WEB_FETCH_SNAPSHOTS=0`，必须标明这是新增设置，并测试：关闭后不生成新快照，不回退执行失效快照请求。所有新增配置只能在宿主读取，不由网页或模型 URL 参数决定。

### 2.4 输出与错误

现有 `content` 和 `details` 的安全/分页信息保留；新增 `outputSchema` / `structuredContent` 时，必须从同一规范化结果生成，防止文本与机器字段矛盾。codemode 的既有转换规则先按本地实现核对。[S8]

最低结构化字段：

```ts
// 概念字段，不要求逐字照搬类型名；不猜测仓库导出类型。
type WebFetchData = {
  text: string;                         // 仅当前页，不是整份快照
  requestedUrl: string;
  url: string;                          // 最终 URL
  title: string;
  snapshot_id: string | null;
  captured_at: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  pagination_consistent: boolean;
  scan_complete: boolean;
  capture_truncated: boolean;
  incomplete_reasons: string[];
  content_status: "content" | "possible_login" | "possible_challenge" | "empty" | "unknown";
  warnings: string[];
};
```

这只是最低字段集，不能删除现有 `dns_mode`、frame/滚动数量等有用信息。`content_status` 的启发式不得变成访问控制判断；只有一个 Log In 按钮不构成登录墙。扫描完整性、正文可用性、输出分页三者分别表达。

`retrievedAt` 如保留，必须说明含义；快照续页不能用当前时间冒充重新抓取。嵌入 frame 的来源按 frame 记录，不能全部归于主站。

引入稳定内部错误码区分参数、策略拒绝、取消、整体超时、frame 局部预算、快照不可用、协议失败与清理失败。不要继续通过匹配英文错误文案控制导航/恢复流程。真实取消原因、请求头、网站任意错误正文不可原样拼入诊断。

## 3. 任务图与完成条件

```text
WF00 基线
  └─ WF01 回归复现
      ├─ WF02 采样正确性
      ├─ WF03 frame 调度/失效（与 WF02 的采样契约对齐）
      └─ WF04 运行时清理/资源
          └─ WF05 快照存储（也依赖 WF02/03）
              └─ WF06 工具与 codemode 契约
                  └─ WF07 扫描性能
                      └─ WF08 结构化阅读
                          └─ WF09 全链路验收
```

共享文件修改默认串行。并行 Agent 可分别研究/测试，但同一文件只能有一个明确写入负责人。不能为了并行复制两套 scanner 或让多个 Agent 同时修改 index.ts。

| ID | 优先级 | 主要产出 | 完成门槛 |
| --- | --- | --- | --- |
| WF00 | 必须先做 | 基线、源码差异、决策记录、命令清单 | 无未解释的测试前置缺失 |
| WF01 | P0 | 可稳定复现的新增 fixtures / tests | 缺陷测试在旧实现中失败或说明为何已修复 |
| WF02 | P0 | 可见性、块身份和更新语义修复 | 不漏正常正文，不误删合法重复或虚拟项 |
| WF03 | P1 | frame 局部预算和文档生命周期 | 单坏 frame 不拖累其他内容，无旧文档混入 |
| WF04 | P1 | 可靠清理、资源计量/限并发接入 | 取消和异常无伪成功、无越界杀进程 |
| WF05 | P1 | 有界且隔离的不可变快照 | 过期/越权/取消/淘汰行为可验证 |
| WF06 | P1 | 稳定分页及 structuredContent | 连续四页只捕获一次，codemode 直接获结构化结果 |
| WF07 | P1 | 去除重复工作及性能证据 | 质量不退化，重复采样/CDP 开销降低 |
| WF08 | P2 | 来源、链接、标题/代码/表格结构 | 格式一致、预算有界、无自动外部访问 |
| WF09 | 必须收尾 | 全部测试、文档、交付记录 | 每项要求与证据可追踪 |

### WF00：核对本地基线与接入点

**步骤**

读取 §1.2 全部相关文件及适用 AGENTS；记录 HEAD 与审阅提交差异；查明 loader 来源、Node 版本、浏览器路径、扩展生命周期、session/branch 授权、codemode 返回转换、宿主执行资源调度。

运行现有离线与可用的真实浏览器本地测试，记录未修改时的失败。不能用旧 dist 验证新 src；对每条命令注明加载的是哪个模块。记录实际测试数量、退出码、浏览器版本、sandbox 状态和网络隔离方式。

建立一个本次任务专用状态文件（建议与计划同目录 `TASK_STATUS.md`）和未入版本控制的原始测试日志目录。不要把不完整旧探针写成此次基线 PASS。

**验收**：所有后续要用的宿主 API 都能对应本地真实类型；没有把 task ID、toolCallId 或模型提供字段当作会话所有者；明确缺环境时哪些任务可继续、哪些真实 E2E 被阻塞。

### WF01：将审计线索变成回归测试

**修改重点**：现有 full-page fixtures/child、offline/browser-mock；必要时增加纯算法测试与独立采样器本地浏览器测试，但沿用隔离包装器。

先补 §5 的 C01–C09、F01–F05 和 R01–R04。对布局变化、删除和回收，使用两步采样/可观察事件进行同步：先证明第一次采样发生，再触发 DOM 变化，再取第二次结果。不要只依赖“setTimeout 500ms 应该差不多”。

每个声称修复的缺陷至少保留一种 red→green 证据：同一测试在旧实现失败、新实现通过；若本地 HEAD 已修复，保留测试通过及源码依据，不重新制造缺陷。

**验收**：旧版的基础静态/虚拟化、合法重复、details、iframe、Unicode、导航替换、取消和限额测试继续存在，不能删除或放宽断言换通过。[S7]

### WF02：修正文本采样语义

**修改重点**：`page-scan.ts`，必要的小型块模型/纯函数模块；不得第一步重写全包。

**实现要求**

- 为普通 DOM 内容建立不依赖坐标的稳定块关联。位置只参与顺序或辅助匹配；两段相同文字有不同身份，移动同一段不会新增副本。
- 逻辑 ID 必须包含文档/frame/容器范围。网页的 `data-*`、ARIA 标识都可能重复、变化或恶意碰撞，不能无条件视为唯一真值。
- 明确 DOM 节点与虚拟逻辑项目的映射：节点复用时不能把多个项目覆盖为一个；普通节点删除/替换不能让旧文案永远留在“当前正文”。
- 不要求通用算法完美推断任意虚拟化实现。不能确定时仅对受影响容器保守保留并说明歧义，同时给出有界容量和可诊断原因。
- 可见性分别处理 text Range 与元素布局盒子，覆盖 `display: contents`、透明祖先、`visibility`、details、屏幕外文字。不能简单“任一祖先 visibility:hidden 就全部隐藏”，因为后代可能恢复可见。
- 不实现完整遮挡计算；明确当前可见性范围。表格、inline、pre 换行不因修复损坏。
- 更新/删除/位置变化均影响适当 revision；内容版本与布局版本可分开计量，便于后续性能优化。
- 将 DOM 写操作与几何读操作分阶段；仅做与正确性有关的最小调整，复杂观察器留到 WF07。

**验收**：C01–C09 必须通过。全文级测试不能存在旧标记、重复块或非法全局去重；真实正文不被简单截掉来规避复杂页面。

### WF03：frame 局部失败隔离与生命周期

**修改重点**：`frame-scan.ts`、`browser.ts` 的事件分发、frame mock/fixtures。

区分 GlobalBudget（总时限、总捕获、总导航保护、调用者取消）与 FrameBudget（该 frame 的时间、节点、容器、滚动上限）。只有真正全局事件能设置全任务停止；单个 frame 超限保留其已确认内容并标记不完整，其余页面继续。

对 frame 采用可让出的短步推进或等效公平调度，避免读一个无限 iframe 直至全局 90 秒。主文档和后续兄弟必须获得预算；内层滚动区优先于外层移动的原正确性保持。测试注入短预算，不把生产总超时调大。[S4]

用 frame 身份＋文档代次/loader＋CDP session 管理状态。处理真正移除、完整导航、同文档路由变化、OOPIF 进程切换和执行上下文销毁。Runtime/Page 事件是校验依据，具体参数以实际浏览器协议为准。[S11]

不能将 `Target.detachedFromTarget` 无条件等同 DOM frame 删除，也不能因同一 URL/loader 未变化就永久跳过已完成 frame。结束前进行有界的变化检查；仍在变化则保留不完整状态，不无限追逐实时页面。

为每个 frame 保存来源、所属文档代次、捕获/跳过/失败状态和原因。删除/导航会使旧样本失效；status 也绑定到当前文档，避免把上一次 403 留给新一次 200。

**验收**：F01–F05 通过。捕获中不能混入替换前的主/子文档；frame 局部失败可以使总覆盖不完整，但不能阻止主页面后半段和可读兄弟内容出现。

### WF04：清理、取消、资源与可观测性

**修改重点**：`browser.ts`、`network.ts`、宿主已有资源调度的最小适配、异常测试。

在关闭顺序上先停止新增操作，发送正常关闭，必要时对**本次拥有的**进程组做有界 TERM/KILL，等待可验证退出，关闭代理和管道，最后删除已确认不再使用的临时目录。主 PID 的 exitCode 或 stdio close 不自动证明所有后代已退出。[S5][S12]

不能用 `pkill chrome`、名称模糊匹配或长期保存的 PID 清理其他用户进程。检测 PID/进程组重用风险；对脱离受控进程组的进程不宣称可完全控制。无法确认时返回清理失败并保留目录、记录有限的 owned-resource 诊断，不能误删状态或吞掉异常。

取消要覆盖排队、启动、导航、采样、快照提交前以及退出清理。CDP 消息解析失败、传输关闭、spawn 失败与超时都必须解除 pending calls，避免悬空 Promise、监听器和定时器。

先核对宿主已有调度再接入浏览器资源名额，防止嵌套 codemode 双重持锁死锁。若没有适用调度，用宿主拥有的共享限流器，而不是每次工具调用单独创建 semaphore。建议初始并发上限 2，必须可由宿主配置且有排队取消测试；约束范围是这个宿主进程，不是整台机器所有 epi 进程。

增加分阶段耗时、采样次数、全文序列化次数、CDP 收发字节、代理传输字节、最大活跃浏览器数。日志不含网页全文、URL query/hash、header 或密钥。HTTPS CONNECT 的代理字节是传输计量，不等于解压正文大小。

先保留原网络策略和限额，补计量及可注入的资源上限测试。需要新增传输硬上限时单独记录默认值依据；不能把“已有 90 秒超时”宣传成 OS 内存/CPU 沙箱。OS cgroup/Job Object/新平台支持不在本次最低交付范围。

**验收**：R01–R04 与现有网络/连接测试通过；排队不会创建无效浏览器；释放名额与实际清理状态一致；不能靠延长超时、关闭 sandbox 或关闭 TLS 校验通过。

### WF05：有界、不可变、会话隔离的快照存储

**修改重点**：建议新增 `src/snapshot-store.ts` 和测试；模块名可按仓库风格调整。

实现 §2.3 的 owner/branch 隔离、绝对 TTL、LRU 与字节限额。时间、ID 生成器、容量用于测试时可注入；随机句柄不可由 URL 或文件路径推导。get 返回不可变或防修改副本，调用方不能污染下一页结果。

只有捕获结果校验完成、未取消且清理成功后提交可见快照。允许明确标记不完整的有限结果，但不能在后台继续修改这份快照。请求在提交前取消则不发布 ID；容量不足可以返回当前页并说明未建立快照，不能返回无效 ID 或扩大缓存无限存储。

授权检查先于内容读取，所有者不得通过模型参数伪造。会话/分支切换、reload、结束、重启的行为须各有测试；重启不恢复快照是本阶段明确设计，不读取会话日志重建缓存。

内部只保留字符串和有界必要索引，避免永久存储每字符字符串数组及重复的全文 JSON。text/metadata/结构统一纳入容量，定时清理器不能阻止宿主退出。

**验收**：S01–S07 通过。独立子代理不能直接读取父快照；受权同 scope 的 codemode 可读取；未授权和不存在的响应不能成为快照存在性探针。

### WF06：工具入口、分页与 codemode 的结构化契约

**修改重点**：`index.ts`、扩展 schema、mock loader、coding-agent 相关 targeted contract tests；仅在真实需要时改宿主适配。

按 §2.2 验证参数组合并分流：snapshot 路径只能做授权和内存读取；url 路径使用现有网络策略后执行新捕获。保留 Unicode 码点与 UTF-8 双预算、现有不可信提示和扫描状态。

`content` 提供简洁但完整的可读来源/正文；`structuredContent` 提供当前页及 metadata，不包含整份缓存正文；`details` 用于界面/诊断。三者来自同一个规范化对象，并测试 schema 校验、大小上限与当前 loader 的实际效果。

不得只往 details 放 `snapshot_id` 就宣称模型能使用它。直接工具可读结果要明确展示续页参数；codemode 不需要从英文提示中正则提取 offset。嵌套调用继续走宿主授权、调度与生命周期，不直接越过 host 调用 execute。[S8]

原有“每次都会新建浏览器”“没有正文缓存”等描述需精确修改为“新捕获使用一次性浏览器；快照续页仅使用短期内存数据”。保留退出重启后快照失效说明及禁用设置。

**验收**：P01–P05 通过。四页读取中 readPage/spawn/DNS/代理启动均只有第一次发生；对中文、emoji、组合字符、控制字符清理后的全部切片，重组等于同一快照文本；存在更多内容时游标严格前进。

### WF07：去除重复扫描与安全的等待优化

**修改重点**：`page-scan.ts`、`frame-scan.ts`、`browser.ts` 与本地 benchmark harness。

严格分两步，分别保留证据：

**A. 不改变等待与覆盖语义的优化，必须先做。**隔离世界/固定采样器按文档代次创建与安装；无变化时只返回轻量状态，不传输全文；以计数检查总预算，避免每次 `result()` 都拼全文；减少相同 frame tree/context 查询；采样内缓存必要样式/几何结果。

context 缓存需要在导航、进程交换、Runtime 上下文销毁时失效，不能永久复用数值 contextId。CDP 能力差异使用有界保守回退，不能静默删除隔离措施。[S11]

**B. 变化驱动采样和等待优化，质量门通过后再做。**结合 DOM mutation、尺寸/样式变化、滚动与相关资源完成维护 dirty 状态，保留低频全量校验。MutationObserver 不是字体、CSS、图片布局变化的完整替代。

不要将“没有网络请求”当成唯一结束条件，也不要把 timer/counter 文本简单硬编码为可忽略。对持续变化内容使用有界策略和明确说明。新增低成本快速完成路径要通过晚出现正文、字体重排、同文档路由与迟到 iframe 的负面测试，否则保留原等待时长。

性能优化后每页的内容、合法重复和扫描状态必须一致或有明确可解释的正确性改进；不通过减少输出、漏 frame、缩短捕获上限制造更好成绩。

**验收**：M01–M04 和所有 C/F 测试通过；输出优化前后原始数据与脚本。静态无变更时全文序列化/全文 CDP 传输次数显著下降，次数必须有真实统计。若等待优化没达质量门，保留 A 的有效改动并记录 B 未启用，不伪报提速。

### WF08：结构化阅读与内容质量说明

**修改重点**：采样结果的受限块类型、统一格式化模块、index.ts 输出、fixtures。

不要为了 Markdown 功能把实际扫描器完全换成一次 DOM dump。优先在 WF02 稳定块上增加 `heading/paragraph/list/code/table/link/frame` 等最小结构，保留代码缩进、表格关系和链接目标。默认仍为 text，Markdown 显式选择；一份快照格式固定，偏移也固定。

为块或输出范围建立来源映射：frame 来源 URL、稳定局部 block ID、在该格式文本中的码点范围。返回结构信息仅覆盖当前输出页或明确的小预算，不能在 metadata 中附上完整未分页全文。

链接按实际 frame/base URL 解析并校验，禁止 javascript/data/file 和带凭据的目标作为可调用链接。保留合理 hash；对不符合公共读取策略的目标可保留受限提示，但绝不自动导航或绕过规则。链接文字、标题要清理控制字符；不能递归爬取。

区分覆盖状态和疑似登录/挑战状态；单个密码框只能作为弱证据，不必然意味着可见正文没读完。新增状态与旧 scan_complete 语义差异要记录迁移，不要凭“HTTP 200 + 非空文字”证明任务成功。

Open Shadow DOM、复杂正文筛选、搜索快照内关键词属于后续独立增强；本次不完整支持时继续准确标记覆盖缺口，不声称完成。人工图片遮挡分析与 closed shadow DOM 不纳入最低验收。

**验收**：O01–O04 通过。结构预算不放大输出数倍；全屏外文字不丢；无付费调用、无链接自动抓取；同快照续页结构与文本一致。

### WF09：最终验证、文档与交付

重新运行所有相关测试和静态检查，验证实际源模块、获准且最新的编译模块，以及真实 loader/codemode 路径。单独 mock PASS 不能代替 loader 或浏览器 PASS。

更新包 README：新参数/EOF、快照隐私和 TTL、失效/禁用、读页面与读取缓存的区别、局部不完整、格式、资源边界、实际受支持系统。按当前规则决定 changelog 位置与提交方式，不发版。

核对构建/打包会包含新增模块；不假设在源码目录通过就等于已安装 easy-pi 可用。获准构建后检查产物解析和依赖，必要时在临时安装位置用无模型的 loader/tool fixture 验证。若构建未获准或产物缺失，明确列为未完成验收，不运行真实模型补烟测。

最终输出 §7 的交付报告。若修改了实际内置模块，提示用户重启运行中的 easy-pi；不能声称 `/reload` 一定重载所有静态核心模块。[S2][S8]

## 4. 本地执行命令

以下命令依据审阅版本验证过入口存在，**不意味着这次已经在用户本机运行**。先读本地脚本和 AGENTS；路径/策略变化时按本地调整并记录。[S1][S9][S10]

### 4.1 只读预检

```bash
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short
node --version
npm --version
```

不要把整份环境变量、身份文件或 Git remote 中的凭据输出到日志。

### 4.2 包离线测试：从仓库根运行

```bash
node packages/pi-web-search/test/run.mjs
```

该入口默认引用 coding-agent 的 dist loader，必须查明产物存在且与待测接口匹配。不要用旧 loader 通过的结果证明新宿主接口可用。可按入口支持的名称过滤运行新增 targeted tests：

```bash
node packages/pi-web-search/test/run.mjs --test-name-pattern='你的测试名称模式'
```

### 4.3 真实 Chromium：仅本地隔离 fixtures

```bash
node packages/pi-web-search/test/full-page.mjs
node packages/pi-web-search/test/full-page.mjs --test-name-pattern='你的测试名称模式'
```

Chrome 不在已有查找路径时，从受信任本地配置指定实际绝对路径：

```bash
PI_WEB_FETCH_BROWSER='/实际已安装的浏览器可执行文件绝对路径' \
  node packages/pi-web-search/test/full-page.mjs
```

不要直接绕过包装器运行 full-page-child；不要给所有 fixtures 开公网；不要为了 root 环境通过加 `--no-sandbox`。无法运行 sandbox 时记录 `BLOCKED_ENV` 并使用正常的非 root 开发环境完成验收。

测试增长可能超过当前包装器的整套总时限；优先拆分独立组和复用测试内可注入预算，明确保留每用例上限，不得单纯把全部超时无限调大。

### 4.4 静态检查与非真实模型回归

```bash
npm run check
./test.sh
```

具体包测试从其包目录按本地 AGENTS 的 targeted 命令执行。`npm run check` 可能写文件：先记录共享工作区状态，结束后只处理自己的改动；其他人修改的冲突文件不得擅自回退。

### 4.5 仅在获准且必要时构建

```bash
npm run build:offline
```

先核对本地规则，不能把这条写在计划中视为已获得所有构建/依赖变更授权。不得执行会请求模型目录或付费服务的普通 build 路径。构建后使用**实际生成的路径**指定 `PI_EXTENSION_LOADER` / `PI_WEB_FETCH_BROWSER_MODULE` 运行相同测试；不假设一定生成 `packages/pi-web-search/dist/browser.js`。

本次默认不执行 `test/live.mjs`、真实模型交互、`npm publish`、release 脚本或远程推送。

## 5. 强制验收矩阵

下表测试 ID 应出现在测试标题或交付报告映射里；不要创建空测试占位。相同输入/序列优先用参数化测试，避免大量重复代码。

### 5.1 采样正确性

| ID | 夹具与动作 | 必须断言 |
| --- | --- | --- |
| C01 | 两个普通段落，首次采样后上方增加 137px 高度 | ALPHA/BETA 顺序正确且各一次；只移动不新增逻辑内容 |
| C02 | 两段内容相同但身份不同的正常段落 | 两段都保留，禁止全局文本去重 |
| C03 | 同一个稳定块更新文字 | 只保留新文字，旧版本不混入 |
| C04 | 普通稳定块删除、后方段落移位 | 删除段落消失，后方段落不重复 |
| C05 | 显式逻辑行号的虚拟列表回收 DOM | 所有已扫描逻辑项按序保留；合法重复次数精确 |
| C06 | 节点复用且逻辑键改变/缺失，伴随动态高度 | 不按 DOM identity 覆盖多个项目；歧义被限定并说明 |
| C07 | display:contents 直接文字、嵌套 inline、正常 pre | 可见字不漏，inline 拼接及换行正确 |
| C08 | opacity:0 祖先、display:none、visibility 覆写、视口外段落 | 真正隐藏文字排除，可见覆写和屏幕外正文不丢 |
| C09 | 重复 data ID、同位置不同块、details 展开、字体/图片布局变化 | 不发生身份覆盖；有歧义不伪造绝对完整；旧 details 测试仍通过 |

### 5.2 frame 与生命周期

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| F01 | 首个 iframe 无限滚动，后面有正常兄弟和主文档尾部 | 子 frame 超限，兄弟/主尾部仍捕获，总覆盖标不完整 |
| F02 | 已完成 iframe 不换 URL/loader，只更新 DOM | 有界最终复核能发现变化，不把首次样本永久当最终值 |
| F03 | iframe 真正删除后新增另一 iframe | 旧内容失效，新内容/来源正确 |
| F04 | OOPIF 交换、同 URL 重载、主文档导航 | 旧 context/loader 样本失效，无旧正文或旧 HTTP 状态混入 |
| F05 | 隐藏认证 iframe、可见被拒绝 iframe、迟到 iframe | 正确区分跳过/失败/覆盖缺口，不仅凭全局请求拒绝数判登录 |

### 5.3 取消、资源、安全与清理

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| R01 | 排队/启动/扫描/提交快照前取消 | 固定取消结果，无新快照，无额外浏览器工作 |
| R02 | 主进程退出但 owned 后代存活；拒绝退出；spawn失败 | 只处理 owned 资源；无法确认退出时不误删目录、不返回成功 |
| R03 | CDP 畸形/过大/分片/批量消息、断管、超时 | 正确按消息处理限制，所有 pending 有结果，清理有界 |
| R04 | 多并发及 nested codemode，网络拒绝/重定向/DNS变化/fake-IP | 名额不超配、取消不死锁、策略与标记不退化、凭据不继承 |

现有 network/connection 测试是必跑基线；HTTPS/TLS 相关新断言不能只用 HTTP fixtures 证明。通过 mock 或使用独立测试 CA 的专门本地环境验证，不能关闭证书校验。

### 5.4 快照与分页

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| S01 | 两个独立 root/branch/native child 互用句柄 | 拒绝跨范围读取；ID 无法替代授权 |
| S02 | 绝对 TTL 到期，连续读取未到期快照 | 读取不续 TTL；到期明确不可用，无自动抓取 |
| S03 | 个数/字节配额触发 LRU，metadata 特别大 | 所有保存数据受限，淘汰确定且可测，无虚假 snapshot_id |
| S04 | 修改 get 返回对象 | 不能污染存储或其他续页 |
| S05 | 会话结束、切换、reload、进程重启 | 失效/清理符合约定，不从历史缓存或日志重新取出 |
| S06 | 部分捕获、取消、失败、清理错误 | 仅允许经校验且清理完成的结果提交；部分状态跨页保持 |
| S07 | 关闭快照功能/缺少安全 owner 能力 | 不建立不安全缓存，不隐藏改为跨会话共享 |
| P01 | 同 URL 内容随后改变，读取已创建的四页快照 | 四页重组等于原快照；readPage/spawn/DNS/代理仅一次 |
| P02 | 中文、emoji、ZWJ/组合字符、控制字符、UTF-8 边界 | 码点偏移准确、无 surrogate 截断、每页字节有界 |
| P03 | offset 为 0/末尾/超过末尾/负数/非整数 | 符合 §2.2，剩余正文时游标前进；非法值无外部动作 |
| P04 | url/snapshot 参数冲突、格式冲突、未知字段 | 按本地 schema 和运行时规则严格拒绝 |
| P05 | 直接工具、真实 loader、codemode 嵌套调用 | 三者 metadata/text 一致，结构化结果无需正则解析 |

组合字形允许跨页分开，但不得拆坏 Unicode 码点；要改善字形分割必须另行说明，不可把 offset 单位从码点偷偷改成字素簇。

### 5.5 性能和结构

| ID | 场景 | 必须断言 |
| --- | --- | --- |
| M01 | 静态无变化页面多次轮询 | 未变化时不反复传输/序列化全文，采样器不重复安装 |
| M02 | CSS/字体重排、延迟正文、hash 路由、持续计数器 | 变化不会因观察器漏报被当作完成；不无限等待 |
| M03 | 同机同版本固定 fixtures 的前后对照 | 耗时分解、样本数、失败率和输出质量都有原始数据 |
| M04 | 多页面并发，包含一次取消和慢 frame | 总占用有界、正常任务可推进、无泄漏 |
| O01 | 标题、列表、嵌套代码、表格 | text 默认不退化；Markdown 结构可验证，不幻造语义 |
| O02 | 主/子 frame 同名链接、relative/base/hash、危险 scheme | 来源正确、链接可追踪，危险目标不可调用且无自动导航 |
| O03 | 密码框旁完整文章、无密码登录墙、挑战页、普通 200正文 | content_status 保守且有证据，不与 scan_complete 混淆 |
| O04 | 最大正文、很多链接/表格、分页跨结构边界 | metadata 和正文都受限；续页格式、来源范围与时间一致 |

## 6. 性能验收口径

先比较 WF02–WF06 已修复版本与 WF07 优化版本，保持输出契约、browser binary、viewport、fixture、网络隔离和日志配置一致；可以附原审阅版本比较，但不能把内容变少算优化。

优先做确定性计数门槛：四页只新捕获一次；无变更轮询不重复导出正文；浏览器名额不超上限；EOF 不触发读页面；context/导航变化后不重复使用无效 ID。这些不是耗时预测。

时间/资源对照使用固定样本并交错运行前后版本，保留冷启动和热运行标签。至少每组 10 次用于中位数；要报告 p95 则每组至少 30 次并说明小样本局限。失败和超时必须计入成功率，不可从样本中消失。基线工作区要隔离创建，不能在用户现有工作区切回旧版本破坏改动。

**建议验收目标，不是已有结果**：关键正文召回与合法重复保留不下降；错误“完成”零新增；正常静态组 p50 争取下降 20%；相同覆盖场景 p95 不出现持续超过 `max(15%, 200ms)` 的恶化。若波动大，增加样本并说明，不用不稳定单次成绩判 PASS。

计量峰值进程树内存时注明 RSS/PSS 的具体口径和平台，不能把主进程 RSS 当整浏览器；不支持的指标写 `unmeasured`，不能填 0。源码优化不能直接推导固定倍数的内存/耗时收益。

## 7. 状态跟踪、提交与最终交付

### 7.1 每个任务的状态模板

在 `TASK_STATUS.md` 中记录：

```text
Task: WF02
Status: pending | in_progress | verified | blocked | not_applicable
Base HEAD: <实际 SHA>
Changed files: <明确文件列表>
Reproduction: <测试 ID / 旧版结果>
Tests: <实际命令、退出码、数量、日志路径>
Evidence: <原始数据或差异>
Decisions/deviations: <原因>
Remaining risks: <不能证明的事项>
Commit: <实际 SHA 或未提交原因>
Next: <下一任务>
```

`not_applicable` 需要证明本地已修复或功能不存在，不能用于跳过难题。`verified` 必须对应运行过的测试，不等于“写了测试”。如中断，下一 Agent 从首个未完成任务续做，不重新执行破坏性初始化。

### 7.2 建议的逻辑提交边界

按本地 Git/commit 规则执行，小批提交且每批可回退；建议信息如下，实际类型/作用域以本地约定为准：

```text
fix(coding-agent): preserve visible web text across layout changes
fix(coding-agent): isolate frame budgets and invalidate stale captures
fix(coding-agent): account for browser cleanup and cancellation
feat(coding-agent): add scoped immutable web fetch snapshots
feat(coding-agent): expose structured web fetch pagination
fix(coding-agent): avoid repeated full-page serialization
feat(coding-agent): preserve web content structure and provenance
```

依赖任务按顺序合入。回滚在独立分支或明确授权下 revert 本次提交，不使用 reset/clean 丢弃用户工作。快照及后续结构契约有依赖时一起回滚，不留孤立 schema。

### 7.3 最终报告必须包括

| 项目 | 交付内容 |
| --- | --- |
| 版本 | 实际起始/结束 HEAD、分支、Node/Chromium 与加载模块路径 |
| 改动 | 每个 WF 任务、文件、行为变化与迁移说明 |
| 正确性 | 新测试及既有测试结果，关键 red→green 证据 |
| 隔离 | sandbox、空 HOME/凭据环境、本地网络、清理与授权测试证据 |
| 性能 | 样本数、原始数据路径、指标口径、失败率和质量一致性 |
| 契约 | snapshot 输入输出、EOF、TTL/配额/禁用、codemode 返回示例 |
| 文档 | README、适用 changelog、状态文件和操作提示 |
| Git | 本次 commits；未提交、未push和其他工作区改动说明 |
| 限制 | blocked / skipped / unmeasured，不能以文案代替未跑验收 |

**Definition of Done**：WF00–WF09 各自有证据；全部适用强制测试和静态检查通过；无缺陷靠删测试/降安全边界解决；新模块在实际加载路径可用；用户可重启本地 easy-pi 使用；未完成项明确列出。没有公网验收就不能声称某网站已可访问，没有生产 sandbox 验收就不能声称隔离等价。

## 8. 资料与参考

以下是审阅依据，不要求执行 Agent 为本次本地整改再次访问外网。优先读本地对应文件，API 差异按本地 Node/Chromium 类型和协议验证。

- [S1] `AGENTS.md`，命令、测试、依赖及 Git 规则。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/AGENTS.md`
- [S2] `packages/pi-web-search/README.md`，现有工具与隔离/限额约定。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/README.md`
- [S3] `src/index.ts`，分页和工具返回。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/src/index.ts`
- [S4] `src/page-scan.ts` / `src/frame-scan.ts`，内容和 frame 采样。`https://github.com/yiwen65/easy-pi/tree/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/src`
- [S5] `src/browser.ts`，进程及 CDP 生命周期。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/src/browser.ts`
- [S6] `src/network.ts`，公网网络策略。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/src/network.ts`
- [S7] `test/full-page-child.mjs` / `test/full-page-fixtures.mjs`，既有验收。`https://github.com/yiwen65/easy-pi/tree/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/test`
- [S8] `packages/coding-agent/docs/codemode.md`，结构化结果及授权调用。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/coding-agent/docs/codemode.md`
- [S9] `test/run.mjs` / `test/full-page.mjs`，实际隔离测试入口，见 [S7] 目录。
- [S10] `packages/pi-web-search/package.json`、根 `package.json`，运行环境及 scripts。`https://github.com/yiwen65/easy-pi/blob/e82fb98b5e150d91d8c4979b4ca0b7426ef4e3e2/packages/pi-web-search/package.json`
- [S11] Chrome DevTools Protocol 的 Runtime / Page 文档；当前线上协议可能比本地浏览器新，只作为事件与生命周期参考。`https://chromedevtools.github.io/devtools-protocol/tot/Runtime/`；`https://chromedevtools.github.io/devtools-protocol/tot/Page/`
- [S12] Node.js child_process 文档，detached、进程退出与信号边界；按本地 Node 版本核对。`https://nodejs.org/api/child_process.html`
- [E1] 本地附件 `evidence/probe-results.json`。前次局部探针结果，不是这份计划的执行记录；见其 `scope` 和配套 evidence README。
