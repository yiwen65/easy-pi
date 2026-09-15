# Task Plan: 将 web-search 内置到 easy-pi 产品

- Created: 2026-09-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求「要把packages/pi-web-search 内置到pi/packages中」。

<!-- task-doc-section:background-goal -->
## Background and goal

将工作区外部包迁入 `pi/packages/pi-web-search`，通过产品默认扩展工厂加载，让源码启动及打包的 easy-pi 不依赖 `~/.epi/agent/extensions/web-search`。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 范围：包源码/测试/文档迁移、默认工厂、workspace 类型/依赖/产品打包接线、必要锁文件和回归验证。
- 迁移收尾：仅移除此前本任务安装且目标完全匹配的用户扩展符号链接；移走旧包，保留临时备份。不改全局 settings、密钥文件或 shell 配置。
- 不改变搜索/抓取策略，不把内置迁移宣称为浏览器导航故障修复；不访问付费 API、真实密钥或个人浏览器状态。
- 不重启/终止用户会话，不覆盖仓库已有其他修改，不发布 release。不运行全量测试或 `npm run build`。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 开工时外部包为 v0.2.0，搜索用 Tavily，读取用一次性匿名浏览器 | `../packages/pi-web-search/{package.json,index.ts,browser.ts,network.ts}` |
| F-002 | CLI 和默认 SDK 都使用同一个内置扩展工厂；自定义 ResourceLoader 由 host 自管 | `packages/coding-agent/src/extensions/index.ts`，`src/main.ts`、`src/core/sdk.ts` 引用 |
| F-003 | 私有产品包通过 development export、源码 path mapping、联合产品编译及 materialize 接入 | `packages/{permissions,subagent}/package.json`，`tsconfig.json`，`tsconfig.product-build.json`，`scripts/build-easy-pi-product.mjs` |
| F-004 | 开工时用户加载链接指向工作区外部包 | `ls -l ~/.epi/agent/extensions/web-search` |
| F-005 | 开工时有六个无关 tracked 修改和两个无关 untracked 文档；分支为 my-pi | 开工 `git status --short`、`git diff --stat`、`git branch --show-current` |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 「内置」要求默认可用且随产品分发，而非只挪目录；以空 agentDir/default SDK 和 CLI 工厂验证。
- Assumption: 保留独立 `@easy-pi/web-search` 私有模块、扩展注册形态和现有工具契约，版本对齐内部包 0.84.2。
- Open question: 先前会话的浏览器导航故障根因未明，本次只迁移集成，不放宽网络边界或承诺目标网站可读。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 唯一产品源码位于 `pi/packages/pi-web-search/src`，旧用户扩展链接不再注册工具。
- 默认 SDK/CLI 工厂在空 agentDir、禁用外部发现及 reload 时各注册一次 `web_search`/`web_fetch`，来源为内置命名工厂。
- 加载不访问 Tavily key、不启动浏览器、不发请求；原离线工具、浏览器、网络防护契约继续通过。
- 源码及编译/打包链能解析并包含新内部包，不依赖个人绝对路径或用户扩展安装。
- 针对性测试、产品类型编译和仓库规定检查通过；遇到无关既有问题时如实记录，不修改他人代码。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；同一迁移包、默认工厂与产品产物的串行集成。
- Serialization constraints: T-002 验证 T-001 的源码及产物，T-003 仅在验证通过后移除旧安装路径；协调者执行，不模拟委派。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 迁入内部包并接入默认与分发链

- Status: done
- Owner: coordinator
- Objective: 内部包参与默认加载、源码类型解析和产品分发。
- Inputs and prerequisites: F-001 至 F-005；已读仓库规则及扩展/包文档。
- Scope or files: `packages/pi-web-search`、默认工厂、相关 workspace/产品构建配置和依赖锁。
- Expected output: 可由 CLI/默认 SDK 加载的内置 web 工具。
- Dependencies: None.
- Execution steps:
  1. 保存当前包与无关改动基线；先复制迁移，验证后再收尾旧路径。
  2. 使用现有内部包约定接入工厂、类型映射和产品分发，更新必要元数据。
  3. 移除测试/文档的个人硬编码路径，保持工具行为。
- Acceptance criteria:
  - 工厂默认注册新包，源码/产品配置完整且无额外外部依赖。
- Verification method:
  - 定向离线测试、类型检查与依赖/产物审阅。
- Validation evidence: `node packages/pi-web-search/test/run.mjs` 56/56 通过（task-19）；`tsgo -p packages/coding-agent/tsconfig.product-build.json --outDir /tmp/pi-builtin-web-search.DV6kXS/compiled` exit 0（task-20），生成新包三个模块及声明/映射。离线 `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund` exit 0；两个分发锁生成成功。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 默认运行时及打包回归验证

- Status: done
- Owner: coordinator
- Objective: 证明不靠用户扩展也能加载并执行，且随产品分发。
- Inputs and prerequisites: T-001 产物。
- Scope or files: 包测试、`easy-pi-default-composition.test.ts`、产品打包回归及必要文档。
- Expected output: 离线真实加载及产品边界验证证据。
- Dependencies: T-001
- Execution steps:
  1. 扩展空配置默认组合、reload/禁用外部发现测试。
  2. 运行原工具离线套件、针对性默认组合和产品编译/分发检查。
  3. 运行 `npm run check`，核对无关工作区改动未被 formatter 触碰；协调者做对抗性 diff 审查。
- Acceptance criteria:
  - 两工具各一次、默认激活，原搜索/抓取契约保留，分发产物包含新包。
- Verification method:
  - `node packages/pi-web-search/test/run.mjs`；指定 Vitest 文件；临时目录产品编译/打包；`npm run check`。
- Validation evidence: 原离线套件最终 56/56（task-26）；空 HOME 下 `easy-pi-default-composition.test.ts` + `default-tools-setting.test.ts` 12/12（task-22）；`node --test scripts/pack-easy-pi.test.mjs` 3/3（task-28，真实 npm pack/归档清单、编译文件夹 fixture）；定向 Biome 5 文件通过、最终临时产品编译 exit 0（task-24 编译阶段）；编译产物默认 SDK、两次 reload、0 启动 key 读取/意外 I/O、工具执行失败路径，以及编译 CLI 和实际 `pi-test.sh` 的 `--help`/`--version` 均通过（task-27）。锁/相对 TS imports/pinned deps/全仓 tsgo/browser-smoke 均通过（task-25）。`npm run check` 最终仅有 6 个无关既有 warning，未全绿（task-29）；无关六文件 diff 与开工备份逐字一致，`git diff --check` 通过（task-28）。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 移除旧安装并报告运行时生效边界

- Status: done
- Owner: coordinator
- Objective: 只保留内置来源，不残留重复加载路径。
- Inputs and prerequisites: T-002 通过。
- Scope or files: `../packages/pi-web-search`、精确匹配的 `~/.epi/agent/extensions/web-search` 符号链接、任务记录。
- Expected output: 单一源码、单一默认注册路径及最终报告。
- Dependencies: T-002
- Execution steps:
  1. 重新核对旧包与链接无漂移，再将旧包移入临时备份、unlink 精确匹配链接。
  2. 再次验证无旧安装时的默认加载，记录检查及未验证的导航故障。
  3. 告知必须重启实际 easy-pi 进程；旧进程的新会话或 `/reload` 不会重新导入静态内置工厂。
- Acceptance criteria:
  - 外部包/旧链接不再被使用；迁移后默认加载仍通过。
- Verification method:
  - 路径检查、默认组合测试、diff 审阅及任务文档验证。
- Validation evidence: 先以 `diff -qr` 确认旧包等同开工备份，再将旧包移入 `/tmp/pi-builtin-web-search.DV6kXS/retired-external-package`，精确核对 readlink 后 unlink 用户加载链接。移除后默认组合/过滤测试再过 12/12（task-30），编译 SDK/reload/CLI 及实际源码启动器 smoke 再通过（task-31）；旧包/链接不存在、无旧路径残留、无关 tracked diff 与开工一致、`git diff --check` 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

离线默认拒绝网络、只用合成 key，真实 Jiti 加载仍保留；新增默认组合验证不能只直接 mock 工厂。产品临时编译/打包不替换用户运行中的 dist。运行 `npm run check` 前保存无关改动哈希，之后核对。所有测试只定向文件，不运行实际模型或 Tavily API。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 静态内置 import 的代码缓存意味着旧进程的 `/reload` 不等于产品升级；需由用户重启启动器中的 easy-pi 进程。
- 先前抓取已在浏览器导航阶段报错，内置接线本身不能证明该故障修复。
- workspace lock 更新、联合编译及产品分发必须一起接入，避免源码可用但安装包缺模块。
- 总体质量门 blocked：无关文件 6 个既有 lint warning 令 `npm run check` 无法全绿；实现任务均已完成。解除条件是这些无关问题由其负责人修正或用户另行授权处理后，全仓 check 通过。
- 仓库提交规则对锁文件提交有单独许可要求；未经确认不绕过 hook。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-15: 明确迁入 `pi/packages` 并默认加载的执行范围；读取现有内置工厂和私有包构建约定。T-001 开始。
- 2026-09-15: 备份位于 `/tmp/pi-builtin-web-search.DV6kXS`。T-001 完成：源码复制迁移、默认工厂/类型映射/产品构建和打包接线；原 56 个离线测试及临时产品类型编译通过。T-002 开始：扩展默认组合与分发边界回归。npm 锁刷新顺带剪除了已缺失的旧 pi-codex-accounts 条目，审阅后恢复了这些与本任务无关的条目。
- 2026-09-15: 修正迁入源码的两个 lint 问题（CDP 循环赋值表达式、字符串拼接）；原契约 56/56 再次通过。临时编译 smoke 起初误用 CommonJS `require.resolve` 检查 import-only export，改为产品目录内 ESM `import.meta.resolve` 后通过，未改生产 exports 来迎合测试。
- 2026-09-15: T-002 完成定向验收；全仓 check 仍受其他文件 6 个既有 warning 阻断，分别为 background-task-group.ts（2）、subagent-group.ts、pi-child-session-host.test.ts、subagent-model-defaults.test.ts、collaboration-contract.ts。其余检查分项全通过。T-003 开始，准备核对旧包漂移后移除外部安装。
- 2026-09-15: T-003 完成：移走旧包（备份保留）、移除精确匹配的用户链接；移除后的默认组合、编译 SDK 与源码启动器检查通过。无需也未重启用户进程。未新增 LEARNS：本次小范围 lint 适配及临时 ESM 检查误用属普通验证迭代，未产生需另立项目规则的可复用教训。
- 2026-09-15: 实现任务 T-001/T-002/T-003 均完成；未提交，因为全仓 check 尚被既有警告阻断，且未获锁文件提交的单独许可，不绕过 pre-commit。完整源码构建/发布未运行，现有工作区 dist 未替换；AgentPort 所用源码入口重启后可使用内置工厂。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 内置迁移与定向验收通过：56 个包离线测试 + 12 个默认组合/过滤测试 + 3 个 npm 打包测试，共 71/71；定向 Biome、全仓 tsgo、联合产品编译、依赖锁检查、browser-smoke、临时编译 SDK/CLI 和源码启动器 smoke 通过；旧用户安装移除后再验通过。所有执行任务已完成，无任务阻塞；全局质量门仅受其他文件 6 个既有 lint warning 阻断（task-29），因此不标记总体校验 passed。
- Limitations: 先前浏览器导航故障仍未定位/修复；未访问真实页面或付费 API，未重启用户会话，未替换工作区现有 dist 或发布安装包。定向打包测试使用编译文件夹 fixture；实际新源码另经联合编译和编译 SDK 启动验证。未修改无关文件以消除既有警告，未提交或推送。
