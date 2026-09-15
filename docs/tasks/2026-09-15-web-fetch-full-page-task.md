# Task Plan: web_fetch 整页文字抓取

- Created: 2026-09-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求“支持抓取整页，先搜索类似问题和解决方案再实施”；结构化确认 full_page_scope=当前页全部文字、confirm_full_page_contract=确认并继续。

<!-- task-doc-section:background-goal -->
## Background and goal

把指定 URL 的一次 DOM 文本快照扩展为有界整页文字扫描。先检索并验证公开同类问题/方案，再结合原三个飞书页面与确定性测试实施。不能把“导航成功”或“当前文本稳定”当作全文已抓全。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 当前页文字，包括长正文、懒加载、虚拟滚动、标准折叠区和 iframe；不做图片 OCR、附件解析、子链接或整站爬取。
- 保持匿名浏览器、DNS 快照公网校验、TLS/sandbox、隔离环境和取消清理；不登录、不提交表单、不点击任意按钮。
- 保留 url/offset/max_chars 分页接口和输出预算；允许增加有界等待；遇无限滚动、超时、受限内容或捕获上限时明确标记不完整。
- 交付包代码/测试/README、本任务文档，并按用户确认重建 dist。主要路径为 `packages/pi-web-search/`；不修改其他 session 的 compaction 等代码，不改搜索供应商，不使用模型 API。
- 公开资料搜索已获本次用户明确授权；不得把私有代码、用户文档 URL/token 或凭据传入搜索查询。不新增付费抓取服务、个人登录态或下载浏览器。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 改造前只读取 body.innerText，DOM complete 且文本稳定 2s 后返回；没有滚动或 child frame 扫描 | `src/browser.ts` snapshotExpression/readPage |
| F-002 | innerText 是节点及后代的渲染文字，不是仅限视口的截屏文字；不能靠变更属性名解决未挂载内容 | 已读取 https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/innerText |
| F-003 | 追加式懒加载与替换式虚拟滚动不同，后者需要边滚动边捕获并合并，否则到末尾后早期节点已消失 | 已读取 https://docs.crawl4ai.com/advanced/virtual-scroll/ 的说明、配置和内部流程 |
| F-004 | 单纯滚到底不能通用于无限滚动；历史 issue 还报告 smooth scroll 与节点替换的问题 | 已读取 https://github.com/puppeteer/puppeteer/issues/5081 和 https://github.com/puppeteer/puppeteer/issues/5194；均是历史未确认 issue，不当成当前库缺陷的定论 |
| F-005 | 页面可能有多个 Frame，主页面交互不会自动覆盖 child frame；CDP setAutoAttach 支持直接相关目标及递归附着 | 已读取 https://playwright.dev/docs/frames 和 https://chromedevtools.github.io/devtools-protocol/tot/Target/（首 15000/15492 字，含 setAutoAttach/flatten/attachedToTarget） |
| F-006 | 无现存 Playwright/Puppeteer/devtools-protocol 目录；现有实现已使用自建 CDP pipe 与严格公网代理 | bounded find node_modules；`src/browser.ts`、`src/network.ts` |
| F-007 | 旧测试 80 项；当前包与已有 tracked 修改已备份，并行 compaction 工作仍在变化 | `/tmp/pi-full-page.MzmuH7/before/`、`preexisting.diff`；当前 git status |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已接受：只抓文字；当前分页接口保持；全文扫描可增加有界等待；无法完成时报告不完整。
- 基线实测已证实原三个飞书文档有遗漏；验收检查真实正文段落与末尾文字，不能以字数变大作为成功标准。
- 技术待验证：通用容器发现、虚拟节点稳定身份/顺序、OOPIF 附着与受限 frame 处理。选最小可靠方案，不为了采用框架而引入依赖。
- 不存在阻碍调研和有界实验的用户决策；若需要超出已确认权限或额外外部服务则暂停询问。
- 设计选择：复用现有 CDP/匿名代理，不新增浏览器框架；逐容器从顶到底小步扫描并在滚动前后保存文字块。优先稳定内容/行标识，辅以容器内逻辑位置，保留相同文字的独立段落；子滚动区先于父区，渲染中的子 frame 在父区移走前读取；隐藏的登录/跟踪 iframe 不当正文。
- 预算选择：总读取 90s、全局滚动步数与 frame/容器/文本都有上限，步间轮询文本/几何变化；只声明“可发现文字扫描完成”，保留未暴露/动态内容无法绝对证明完整的边界。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 搜索结果的重要论据由原网页验证并有 URL 引用；不得照搬全局文本去重等可能丢失真实重复段落的实现。
- 静态长正文、追加式懒加载、替换/复用 DOM 的虚拟列表、内层滚动容器、标准 details、同源和跨源 iframe 有可核对全文的测试；保留顺序、合法重复文字和 Unicode。
- 每次扫描有时间、步数、frame/容器/文本预算；取消立即清理，受限/未完成/截断状态不伪装成全文完成；绝不跟随任意子链接或执行表单/按钮操作。
- 输出仍分页，明确区分“本次输出截断”和“整页扫描未完成”；不把页尾等同于捕获完整性。
- 原三个飞书页面实测检查正文段落和末尾，而非只检查标题；源码与重建产物均验证，明确仍未覆盖的站点机制。
- 包测试、定向类型/lint、构建/启动验证通过；全仓门禁若被任务外修改阻碍则如实记录且不提交。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004。
- Parallel batches: 无；采集算法由实测设计确定，浏览器协议/输出/测试接口依次衔接，共享包及本机浏览器实验状态，按依赖串行。
- Serialization constraints: coordinator 负责包及本任务文档；不修改并行 session 文件；构建与 full check 前后核对工作树。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 公开调研与真实页面基线

- Status: done
- Owner: coordinator
- Objective: 区分已有 DOM、懒加载与虚拟化遗漏，验证可行的最小抓取方案。
- Inputs and prerequisites: 已确认需求、公开资料、包基线与原三个 URL。
- Scope or files: 只读源码；公开网页；`/tmp/pi-full-page.MzmuH7/` 诊断产物；本任务文档。
- Expected output: 有来源的方案比较、实际滚动/iframe 结构与基线、算法和边界选择。
- Dependencies: None.
- Execution steps:
  1. 搜索并核验官方指南、同类 issue，区分事实与建议。
  2. 使用隔离匿名 Chrome 检查原页面 DOM、滚动容器和段落，不修改用户状态。
  3. 依据证据选择采集/合并/frame/完整性方案并记录。
- Acceptance criteria:
  - 已完成调研且方案能解释失败模式，不以整页截图、network idle 或单次 innerText 代替全文验证。
- Verification method:
  - 引用上表来源和临时诊断的输入/结构/段落输出。
- Validation evidence: 已完成 4 次公开搜索、6 个来源页面核验。隔离 Chrome 152 实测三个原页面：主滚动区均为内层 bear-web-x-container，初始 viewport 高 405px，初始滚动高度 1861/1825/3101px，正文使用 data-record-id/data-block-id 与 data-line-num 标识。逐步滚动 9/8/22 次采样后，出现旧快照完全缺失的 Docker 第2–4步、驱动配置的 JSON 后半段和 GNSS 路径、ISS 后续脚本表及末尾测试循环；前文同时从 DOM 消失，证实替换式虚拟化。证据 `/tmp/pi-full-page.MzmuH7/page-{0,1,2}-captures.json`；工具执行日志 task-1-ab16db2c、task-2-7226ff43、task-3-bb5c9be3；清理通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 有界 DOM 扫描与文字合并

- Status: done
- Owner: coordinator
- Objective: 在滚动/替换过程中保留整页文字、顺序和合法重复项。
- Inputs and prerequisites: T-001 设计、确定性正文 oracle。
- Scope or files: 包内采集模块、`src/browser.ts` 原始 readPage 接线与对应测试/fixtures。
- Expected output: 可测试的逐步扫描/合并器及原始浏览器入口，含标准折叠、滚动容器、frame 和预算；工具输出格式留待 T-003。
- Dependencies: T-001.
- Execution steps:
  1. 为懒加载/虚拟化/重复文字等建立失败基线。
  2. 实现有限扫描和有身份/位置依据的合并，不用全局文本 Set 删除重复段落。
  3. 覆盖顺序、Unicode、变化/取消/资源上限。
- Acceptance criteria:
  - 确定性页面中所有预期段落按顺序返回，遗漏/歧义/超限显式可见。
- Verification method:
  - 定向测试、真实 Chromium fixture 对照及 diff 审查。
- Validation evidence: `node packages/pi-web-search/test/full-page.mjs` 9/9 真实 Chrome fixture 通过（157s，`full-page-green.log`）；覆盖顺序、36 个相同段落、节点复用、hidden 横轴、details、嵌套懒加载、same-origin/OOPIF/srcdoc、拒绝 frame、捕获预算和无限滚动。首轮5个旧实现测试全部红；新增 hidden-axis 8/36 项红后修复。`tsgo --noEmit` 通过。原三个正文/末尾 marker 已均读到（body-{0,1,2}.log），最终产物验收仍属于 T-004。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 浏览器/frame 接线与输出完整性

- Status: done
- Owner: coordinator
- Objective: 将原始扫描结果接入默认 web_fetch 的输出，明确 child frames 与扫描完整性并扩充契约回归。
- Inputs and prerequisites: T-002 的接口与通过的正文测试。
- Scope or files: `src/browser.ts`、`src/index.ts`、browser mock/离线测试、README。
- Expected output: 默认整页采集、受控 frame 扫描、诚实的完成/截断说明与原分页接口。
- Dependencies: T-002.
- Execution steps:
  1. 审核 T-002 的 CDP frame 生命周期和调度边界，接入默认工具并补充取消/受限 frame 回归。
  2. 区分扫描结束、扫描未完成、输出分页与捕获超限。
  3. 扩充协议、取消、重定向和受限 iframe 回归并更新文档。
- Acceptance criteria:
  - 确定性跨 frame、导航变化、取消、超限测试通过；旧搜索契约与安全回归保持。
- Verification method:
  - 包离线、真实浏览器 fixture、tsgo、定向 lint。
- Validation evidence: 源码离线 83/83（`offline-first.log`）；真实 Chrome 13/13（`full-page-final-source.log`），新增二维虚拟化、真实取消、主导航/读取 child 时主文档替换，隐藏403 frame不污染主HTTP状态。导航替换先红后绿，旧主文档和旧child文字不混入结果。root `tsgo --noEmit`、包 Biome、`git diff --check` 通过。README及输出加入 scan_complete/incomplete_reasons/frames_read/scroll_steps，分页末尾不等于全文。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 原页面、质量门禁与 dist 验收

- Status: done
- Owner: coordinator
- Objective: 验证真实正文与分发产物，保留验证边界。
- Inputs and prerequisites: T-003 完成。
- Scope or files: 包 live 测试、构建产物、本任务文档；不修改其他模块。
- Expected output: 飞书正文/末尾证据、源码和 dist 检查结果、最终报告。
- Dependencies: T-003.
- Execution steps:
  1. 对原三个页面检查正文和末尾，并验证分页、完整性标记、匿名和清理。
  2. 执行包测试、root tsgo、定向 Biome、完整 npm run check；核对其自动格式化范围。
  3. 按授权 npm run build:offline，检查 compiled CLI/内置工具和更新后的读取产物。
  4. 清理临时程序、审查 diff、验证任务文档并报告未覆盖项。
- Acceptance criteria:
  - 功能/正文 oracle 和产物验证通过；全仓门禁与任何全文不确定性如实报告。
- Verification method:
  - 测试/live/build/CLI 输出、工作树快照与任务文档 validator。
- Validation evidence: 功能与产物验收通过。`npm run build:offline` 成功（build.log）；CLI --version=0.84.2、--help、compiled-startup 双reload各唯一两个web工具且无key/网络/子进程启动、canonical与materialized五个JS模块相同；源码离线83/83、产物离线82/82（仅排除硬编码index.ts的源码目录发现fixture，未修改其期望）；源码/产物真实Chrome各13/13。编译后默认工具入口对原三页均匹配实际正文末尾，scan_complete=true、next_offset=null、1782/1204/6077字符、20045/23313/25186ms；无Tavily/Node-fetch/key读取且profile/socket清理通过（live-dist-{0,1,2}.log）。源码实测还逐行核对基线76/57/121条非空文字行，零缺失（baseline-line-comparison.json）。root tsgo、包Biome、diff检查、pinned-deps/ts-imports/shrinkwrap/install-lock/browser-smoke均通过；初次完整check在首步因包外6个unused警告失败，无自动改写；当时构建前后源码哈希/工作树相同，tracked diff与本任务起点完全相同，证据保留于 `/tmp/pi-full-page.MzmuH7/`。后续用户授权最小清理后，完整check通过且无formatter改写；web离线83/83再过，离线dist再次重建成功，5个canonical/materialized web模块一致，compiled preserve默认/排除/allowlist三场景通过且零key/网络/子进程调用（`/tmp/pi-commit-all.5UDjx6/final-{check,web-tests,build}.log`、`compiled-preserve.log`）。web源码未因本次提交准备而改变，不重复实网正文验收。
- Blocker: None. 后续用户明确授权全部提交与最小lint清理，6个unused警告已解除；当前完整check通过，收尾核对见执行日志。
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 对静态、追加、虚拟替换/节点复用、内层滚动、合法重复段落、details、same-origin/OOPIF、限额/无限滚动建立本地确定性浏览器 fixture。测试网络映射必须只在测试进程存在，不能改 production 公网规则。
- 沿用 `node packages/pi-web-search/test/run.mjs`，新增真实浏览器验收单独 opt-in；禁止全量 vitest/npm test/模型 API。
- `node_modules/.bin/tsgo --noEmit`、包 TS Biome、`npm run check`，check 自动写入前后备份和比较，不保留他人格式化改动。
- 原三个飞书 URL 仅在匿名隔离进程检查，不使用个人 Cookie；检查正文/末尾及 warnings，不能只匹配标题或字数。
- `npm run build:offline` 及 compiled CLI/内置加载；编译入口测试须区分原来硬编码 index.ts 的源码发现 fixture，不能误报产物失败或偷改测试期望。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 任意无限/动态页面无通用“绝对全文”证明，扫描完成只能指有界观察；发现未读取内容必须报告，不能杜撰遗漏正文。
- 虚拟化复用 DOM、相同文字的不同段落、sticky 内容和多个滚动区可能导致重复/顺序错误；需要明确身份和位置证据及反例测试。
- OOPIF 与导航更换 execution context 可能脱离主 CDP session；不可用关闭隔离/跨域安全替代 frame 接线。
- 滚动只读仍会触发页面 JavaScript；不添加任意点击、登录、请求重放或第三方付费抓取 fallback。
- 共享 worktree 含大量并行 compaction 等变更；初次完整check曾被6个unused警告阻断且当时未越权处理（`full-check.log`）。后续用户明确授权全部提交与最小lint清理，完整check已通过；新发现的preserve接线回归由 `2026-09-15-preserve-context-repair-task.md` 单独跟踪，不改写初次验收历史。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-15：用户结构化确认文字范围、只读/分页/完整性约定及调研后实施、验证、重建 dist。
- 2026-09-15：检索并核验 MDN、Crawl4AI、Playwright、Puppeteer issues、CDP Target 文档；创建本任务文档及 `/tmp/pi-full-page.MzmuH7/` 基线备份。
- 2026-09-15：T-001 in_progress；下一步检查原三个页面真实滚动/段落结构，再冻结采集设计。production 未修改。
- 2026-09-15：T-001 done：三个飞书页面均证实内层虚拟滚动，旧快照缺失后续正文；选取正文末尾命令/路径作为 live oracle（仅比较文字，绝不执行文档中的命令）。
- 2026-09-15：T-002 in_progress：为避免把未接线的采集器误标完成，将原始 readPage/frame 接线与采集器放同一验证边界，T-003 负责工具输出/文档/契约回归；串行依赖不变。
- 2026-09-15：T-002 done，9/9 真实浏览器测试通过。两项实测纠正：Chrome 父 frame tree 不含 OOPIF，须合并相关 target 自己的 frame tree；飞书横轴 overflow:hidden 且脚本会重置 scrollLeft，不能把 scrollWidth 超出当成可滚动横轴。分别用原生 CDP trace 和 hidden-axis 红绿回归验证。
- 2026-09-15：T-003 in_progress，下一步默认工具的扫描/分页状态、mock 契约、导航替换与取消/超时回归；新导航 fixture 已启动，未提前计为通过。
- 2026-09-15：T-003 done：83/83 离线、13/13真实浏览器、type/lint通过。读取child期间父导航的红测试定位到失败child分支直接返回旧父快照，现统一复核父上下文，并清除旧文档子树。
- 2026-09-15：T-004 in_progress；原三页正文/末尾marker全部匹配，76/57/121条基线非空文字行均在新正文中找到（仅忽略空白及零宽字符）；开始离线dist重建及编译入口验收。full check 包外6个unused警告、无自动写入；独立 pinned-deps、ts-imports、shrinkwrap、install-lock检查通过。
- 2026-09-15：dist重建及编译验证通过：82/82离线、13/13真实浏览器，原三页编译工具实测均到正文末尾；独立compiled内置资源加载双reload无重复工具或启动I/O。CLI及browser-smoke通过。T-004 blocked仅保留全仓6个任务外lint警告；整体partial，不提交，不重启用户进程。
- 2026-09-15：已删除证据目录顶层9个临时诊断/验证程序，保留基线、日志、正文对照、最终diff与哈希；未写额外LEARNS条目（本次迭代修正已由本任务和回归保留）。最终diff检查通过，tracked diff与起点完全一致。状态枚举改为Overall blocked，Final validation保留partial；最终文档使用validator复核。
- 2026-09-15：后续commit-all流程获用户明确授权清理6个unused警告并修复新发现的preserve接线回归。完整 `npm run check`通过且58文件前后哈希/diff相同（`/tmp/pi-commit-all.5UDjx6/final-check.log`、pre/post-final-check）。T-004由blocked恢复in_progress，核对最终集成与更新产物后完成。
- 2026-09-15：最终集成coding-agent 178/178、subagent 48/48、web离线83/83、pack 3/3通过，离线dist重建和compiled preserve三场景通过，canonical/materialized web模块一致，CLI 0.84.2。T-004 done，原lint阻碍已解除；本轮没有重跑已通过且源码未变的13个Chrome fixture/实网原文检查。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003/T-004 done；正文、隔离、清理、源码与重建产物验收通过。后续用户授权清理了原6个lint阻碍，完整check及最终集成门禁已通过。包变更为README、browser/index、新增page-scan/frame-scan、mock/offline/live runner及3个真实浏览器fixture/runner文件；详细diff和哈希在证据目录。研究已在README“方案依据”给出6个公开来源URL。
- Limitations: 90秒/160步/捕获预算内的可发现文字扫描，不是任意网站绝对全文保证；图片/OCR、附件、任意按钮、自定义隐藏内容和未覆盖Shadow DOM不在已完成范围。动态布局仍可能重复/遗漏；嵌入frame文字分区追加而非保留父页面行内排版。原三页比较的是匿名可见文字与已采样基线，未读取图片文字或附件。dist已更新，但实际easy-pi进程需要重启才导入新内置模块，/new和/reload不足；未重启用户会话、未改凭据/AgentPort/公网防护、未调用模型API。提交由后续用户授权的commit-all流程执行，不推送。
