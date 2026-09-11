# Task Plan: easy-pi 独立 GitHub 与 npm 发布方案评估

- Created: 2026-09-12
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户要求评估：在个人GitHub新建仓库，以当前my-pi为main，通过Git更新并发布npm；随后确认实施：公开yiwen65/easy-pi、npm包/命令easy-pi、版本0.1.0-beta.1、保留历史，先实施本地发行链，外部写入分阶段确认。

<!-- task-doc-section:background-goal -->
## Background and goal

建立独立easy-pi源码与npm发行链，确保npm安装获得my-pi中实际修改的AI/Agent/native子会话代码，而非上游同版本包。Git作为开发/版本来源，tag触发可审计的npm发布；Git提交不等于自动发布。当前只评估和规划，不执行远程写入、提交、build、安装、发布或分支切换。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

建议保留monorepo源码结构，首版只公开一个CLI包（easy-pi，或用户拥有scope下的easy-pi），将运行时内部workspace传递闭包的本地编译产物bundle进发行目录。内部源码import包名可暂保留，但不得让安装回退到上游同名包。第一阶段不发布10个独立SDK包、不启用六平台单文件二进制发布、不把现有所有分支/tag镜像到新仓库。

保留旧origin、my-pi及当前会话；在隔离发布clone建立main指向确认的my-pi提交，不强制本地重命名正在使用的分支。现有未提交工作必须逐路径确认、提交后才属于Git可发布快照。源历史/私有材料公开须独立审计和授权；禁止读取/改动/运行冻结tool-profile-eval，公开历史中的此目录处置需用户决策。保留.git/easy-pi-migration-baseline/pre-codex-replacement.tar，不上传.git、凭证、.epi用户资料或/tmp证据。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前分支my-pi；origin=https://github.com/yiwen65/pi.git；检查时66条dirty/untracked status | git branch --show-current、git remote -v、git status --short |
| F-002 | 主CLI包仍@earendil-works/pi-coding-agent@0.84.2，bin为pi，workspace依赖上游scope | packages/coding-agent/package.json |
| F-003 | 仅@easy-pi/permissions和subagent作为bundleDependencies；构建脚本仅物化此两包 | scripts/build-easy-pi-product.mjs |
| F-004 | shrinkwrap生成器将未bundle内部依赖定向registry.npmjs.org的同名tarball；上游scope前缀硬编码 | scripts/generate-coding-agent-shrinkwrap.mjs |
| F-005 | public发布枚举10个workspace，仍全部@earendil-works scope；release脚本全workspace版本联动、扫描stage、push origin main及vtag | scripts/release-packages.mjs、release.mjs、publish.mjs，枚举输出 |
| F-006 | 当前tag workflow包含六平台binary、全workspace npm发布、上游pi.dev公告和R2环境 | .github/workflows/build-binaries.yml |
| F-007 | easy-pi产品identity默认.epi，但manifest仍piConfig.configDir=.pi，由identity兼容逻辑改写；bin仍pi | core/product-identity.ts、coding-agent/package.json |
| F-008 | 自动版本检查只有EASY_PI_UPDATE_URL配置时开启，未配置则不查；self-update从manifest包名解析 | src/utils/version-check.ts、src/config.ts |
| F-009 | MIT允许再分发/修改，须保留版权和许可 | LICENSE |
| F-010 | 公开registry easy-pi查询404；公开GitHub yiwen65/easy-pi查询404 | curl只读查询；/tmp/epi-npm-easy-pi-metadata.json、/tmp/epi-github-easy-pi-metadata.json |
| F-011 | 缓存亲和源码修复离线207pass且真实source-native10请求通过；尚未发布构建，不能当作安装验收 | docs/tasks/2026-09-11-codex-fork-cache-affinity-task.md、native-cache-affinity-real-retest.md |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: yiwen65是目标owner，仅由现有remote推断，未读认证或验证GitHub/npm权限。404不证明名称一定可注册，也可能是私有仓库不可见。
- Assumption: 用户优先发布可安装CLI，而非独立SDK生态；完整bundle闭包可行性需pack/隔离安装证明，不能凭build成功认定。
- Open question: 仓库owner/name/公开性；是否保留my-pi可达完整历史，还是仅发布审计后的初始快照（后者需明确同意不保留完整Git谱系）。
- Open question: npm包名和所有权；建议easy-pi，备选@<用户实际npm-scope>/easy-pi；GitHub用户名不等于npm scope。
- Open question: CLI建议easy-pi或epi；是否保留pi别名（与上游CLI冲突）。
- Open question: 首版版本建议0.1.0-beta.1独立版本线、beta dist-tag，通过后0.1.0/latest；上游0.84.2作为来源信息保留，而非混同easy-pi稳定性。
- Open question: 当前66项哪些进入首发、哪些仍在其他会话开发；不可add-all。
- Open question: Git更新指开发者git pull后重建，还是希望用户直接npm install git URL？推荐Git开发+registry安装两条渠道，不承诺npm git安装源码monorepo即可运行。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新repo main来自确认的my-pi提交或明确授权的审计快照；旧origin/branch不丢失、不force-push、不镜像其他refs。
- 所有实际修改过的内部runtime由发布artifact携带，隔离安装不能解析到工作区或意外拉取上游旧代码。
- 独立包名/bin/version/repository/license/更新源一致；不使用上游npm权限、pi.dev写入/R2或无关workflow。
- 发行输入必须是clean、审核过的Git SHA；pack文件清单、内部闭包、许可证和敏感信息门禁通过。
- CI验证同一tag SHA；发布前环境审批，OIDC可信发布按实际npm支持配置；一次版本不可覆盖，重试核验已存在artifact而非仅看版本号。
- beta隔离安装及核心功能验证通过后才提升稳定版；记录回滚策略，不自动删除用户history或npm版本。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006.
- Parallel batches: 无；采用串行、最小权限阶段门。
- Serialization constraints: manifest/lock/shrinkwrap/发布脚本同一负责人；共享worktree check之前快照，正式发版只用隔离clean clone。

<!-- task-doc-section:task-list -->
## Task list

### [ ] T-001 — 确认发行身份与源码基线

- Status: in_progress
- Owner: unassigned
- Objective: 决定repo/npm/bin/version和公开范围。
- Inputs and prerequisites: 用户确认方案与执行权限。
- Scope or files: my-pi dirty路径清单、Git refs、license/公开材料清单、身份manifest。
- Expected output: 已确认的发布SHA和路径清单；待审内容不自动公开。
- Dependencies: None.
- Execution steps:
  1. 确认owner、公开性、npm ownership、bin和独立版本线。
  2. 逐路径梳理未提交改动，授权后分批提交，保留无关dirty work。
  3. 审计允许范围的敏感信息/许可/历史；冻结历史目录公开处置单列决定，不擅自遍历或重写。
- Acceptance criteria:
  - 基线含已验收产品修复，无未授权材料；不能只push当前HEAD漏掉dirty修复。
- Verification method:
  - commit路径清单、SHA、无真实历史/凭证发布证明。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 独立单包产物与依赖闭包

- Status: pending
- Owner: unassigned
- Objective: npm安装获得本fork全部runtime改动。
- Inputs and prerequisites: T-001明确包名与基线。
- Scope or files: product manifest、build/pack脚本、内部runtime闭包、root lock/shrinkwrap/install-lock生成与校验。
- Expected output: 独立staging发行目录和可安装tgz，不影响当前linked dist。
- Dependencies: T-001.
- Execution steps:
  1. 动态解析主CLI runtime依赖闭包，包括ai/agent/tui/grok/client/protocol/server/telemetry及session-backend等实际需要项，不凭十包清单全量照搬。
  2. 将闭包当前版本dist/package manifests/必要assets/licenses物化为真实包目录并声明bundleDependencies，禁止symlink、workspace/file引用和上游同名registry回退。
  3. 扩展shrinkwrap生成器为inBundle闭包，校验深层依赖、optional平台包、peer依赖和动态模块加载；生成release专用manifest及锁。
  4. 统一name/bin/piConfig/repository/bugs/homepage，限制files白名单；内部npm名字可保留用于import，不代表独立发布或上游出品。
- Acceptance criteria:
  - 发一个拥有权限的CLI包，不向@earendil-works发布；新cacheAffinityId的ai/agent实际包含在tgz中。
- Verification method:
  - npm pack --dry-run --ignore-scripts --json、tgz文件清单及依赖来源审计、模块解析路径与源码hash/构建标识验证。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — Clean clone 构建及隔离安装验收

- Status: pending
- Owner: unassigned
- Objective: 排除monorepo symlink和旧dist掩盖缺包问题。
- Inputs and prerequisites: T-002产物。
- Scope or files: 临时独立clone、npm prefix/container、合成配置。
- Expected output: 精确tag候选tgz、hash、安装测试报告。
- Dependencies: T-002.
- Execution steps:
  1. 授权后clean clone npm ci --ignore-scripts，构建闭包、root check、限定离线tests，保留冻结test排除。
  2. 在仓库外独立prefix安装精确tgz，禁止解析原工作区；验证--version/help、普通/Grok TUI、.epi、SDK和六工具、native持久化与cold followup。
  3. 合成faux并发和cache接线测试；真实Provider smoke仅另有预算时运行，不因发布请求自动启用。
  4. Linux/macOS至少各一个npm安装环境；Windows若无实测明确首版支持范围。检查photon/WASM、optional native组件和Node最低版本。
- Acceptance criteria:
  - 安装产物而非源码test通过，无上游旧runtime混入，许可证完整。
- Verification method:
  - clean环境实际安装运行、modules resolution、hash报告。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 新仓库 main 与独立 CI

- Status: pending
- Owner: unassigned
- Objective: 安全创建新repo并建立main开发来源。
- Inputs and prerequisites: T-003候选与明确GitHub外部写入授权。
- Scope or files: 新repo、隔离clone main、新remote、.github/workflows与发布脚本。
- Expected output: main指向审计SHA，正常CI通过且未意外发布。
- Dependencies: T-003.
- Execution steps:
  1. 先在隔离发布准备分支禁用/替换上游release、模型catalog上传、自动issue机器人等无关工作流，避免首push触发意外活动。
  2. 创建无README/license自动初始化的新repo；只push指定main，不push --mirror/--all/--tags，不覆盖已有同名repo。
  3. 保留当前origin，新增易识别remote如easy-pi；新repo默认main。当前my-pi无需原地重命名，后续建议新clone开发main避免双主线。
  4. main push/PR只运行CI；单独epiv*或easy-pi-v*tag/manual workflow负责发布，防止继承旧vtag意外发版。
- Acceptance criteria:
  - 目标repo和branch正确，无上游R2写入，无当前会话/旧仓库丢失。
- Verification method:
  - 远端SHA、default_branch、workflow permissions和首次CI结果。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — npm bootstrap 与受控 beta 发布

- Status: pending
- Owner: unassigned
- Objective: 新包首发及后续无长期令牌的可信发布。
- Inputs and prerequisites: T-004，npm包名/账号权限与发布动作明确授权。
- Scope or files: npm包设置、GitHub npm-publish环境、独立publish workflow、pack artifact。
- Expected output: 精确beta版本公开且provenance/仓库关联正确。
- Dependencies: T-004.
- Execution steps:
  1. 核验当时npm trusted publishing/OIDC对新包首发的支持；如需bootstrap，由用户交互式最小权限首发或短期令牌完成，禁止写token到仓库/日志。
  2. 建立信任元组owner/repo/workflow/environment，发布job仅contents:read和id-token:write，环境需要审批。
  3. 锁定tag SHA与package version/manifest一致，构建一次并校验同一tgz后publish --ignore-scripts --access public --tag beta，provenance以当前CLI支持验证。
  4. 部分失败不改版本覆盖；已存在版本须核验tarball integrity/来源，否则停止，不能仅凭npm view版本存在就跳过。
- Acceptance criteria:
  - 只发布目标单包，不调用原release.mjs/publish.mjs全workspace链。
- Verification method:
  - npm view版本/dist/tag/integrity、provenance、registry拉取新装smoke；GitHub Release附SHA256及来源SHA。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

### [ ] T-006 — 更新渠道、稳定推广与回退

- Status: pending
- Owner: unassigned
- Objective: 明确Git开发更新与npm用户更新边界。
- Inputs and prerequisites: T-005实际beta发布和反馈。
- Scope or files: README安装/更新文档、version-check/product identity、release tags/dist-tags。
- Expected output: 可维护的日常发版流程和用户更新入口。
- Dependencies: T-005.
- Execution steps:
  1. 开发者从新repo main用git pull --ff-only，在clean环境安装依赖和build；用户npm install -g <pkg>@latest，beta显式@beta。Git pull本身不更新已发布包，也不保证linked dist重建。
  2. 首版保持自动更新检查关闭并文档化手动npm更新，或另行实现受限到本包的registry/GitHub latest源；不能把npm元数据未经适配直接当现有latest JSON。
  3. 单独验收CLI自更新不跳回上游、固定包名/来源、配置不串.epi/.pi。
  4. 稳定推广审批后发布独立稳定版本；回退优先将latest指向上个已验证版本，必要时deprecate坏版本，发布patch修复。Git revert走新commit，不force改公开历史/tag；npm版本不可覆盖。
- Acceptance criteria:
  - 普通Git提交不自动向latest发版，回退不删除用户history。
- Verification method:
  - 两版本升级/降级演练、更新命令目标包核验、dist-tag检查。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

本次只读源码/workflow/license/manifest和公开metadata查询，没有build、pack安装或发布。未来按阶段门验证：源码基线→pack闭包→隔离安装→新repo CI→beta registry安装→稳定推广。发布workflow必须显式禁止真实eval默认启动、保留冻结目录排除，不直接沿用npm test全workspace及带模型网络刷新/上游写入的旧workflow。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

最主要风险是CLI新包仍依赖上游同名runtime导致本地修复丢失。其次是dirty基线遗漏、公开history泄露、旧workflow误发布、版本锁/平台optional依赖缺失。现有history磁盘预算/退役分发T-006/T-007仍未完成，需首发说明或收敛，不能宣称历史包袱已清理。发布单包增加体积，首版需实测tarball体积/安装时间，不预估虚假数值。完整bundle不等于代码全打成一个JS文件；需保留动态加载和wasm/assets。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-12: 只读评估完成。branch=my-pi、origin yiwen65/pi、66项dirty/untracked；检查manifest、build/shrinkwrap/release/workflow、MIT与更新源。公开npm easy-pi及GitHub yiwen65/easy-pi均404，未检查凭证/所有权。形成建议方案。
- 2026-09-12: 用户授权实施。进入execute；本阶段仅本地发行链，GitHub创建/push/npm publish仍为后续外部阶段门。T-001开始。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: not_run
- Evidence: 本文为plan-only评估；源码证据和公开查询已记录，任务结构校验可验证文档而非实际发布。
- Limitations: repo/npm名字、权限、公开history/dirty范围、CLI别名/版本尚待确认。无创建repo、提交、push、build、pack、安装、npm publish或子代理执行。
