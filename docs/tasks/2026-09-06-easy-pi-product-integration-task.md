# Task Plan: easy-pi 首版整合整改

- Created: 2026-09-06
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户确认的首版契约与“执行整改方案”

<!-- task-doc-section:background-goal -->
## Background and goal

执行用户确认的 easy-pi 首版契约：官方工具兼容增强、Grok、自定义压缩、full-access 与内置 Subagent，兼容指定 Pi 公开插件契约。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

迁移权限和 Subagent 至 pi/packages；删除 V2 产品实现与接线；独立数据目录、默认加载、任务清理、兼容验证和发行准备。
不发布、不访问真实凭据、不删除旧用户数据。用户后续明确授权将默认目录改为 .epi 并复制迁移真实 session；此授权仅限会话及其目录内附属文件，原件保留，不迁移凭据或其他配置。不修改或执行冻结的历史评测。原生工具增强仅在明确收益且保持契约时实施，不引入强制先读后改。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 用户确认契约并授权执行整改 | 本会话最后两次确认及执行请求 |
| F-002 | Pi HEAD 2174f99e8，基线版本 0.84.2 | git rev-parse HEAD; coding-agent/package.json |
| F-003 | wj 源码大量未提交，须按当前工作区迁移 | wj-pi-harness git status; HEAD b23c993 |
| F-004 | Pi root lockfile 与 accounts 包有既有本地改动 | 开工 git status / diff |
| F-005 | 默认扩展有集中入口；身份支持 piConfig | coding-agent/src/extensions/index.ts; src/config.ts |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 用当前 0.84.2 公开参考契约作为初始兼容目标；远端来源及完整兼容尚未验证，不能声明发行完成。
- Confirmed: 用户指定独立目录 .epi；产品名 easy-pi、环境前缀 EASY_PI 不变，保留 Pi 插件 manifest 和模块解析协议。
- Open question: 发布 npm 命名空间与渠道未授权；仅本地实现，发行前再确认。
- Confirmed: 用户授权执行 session 迁移；检测到来源 ~/.pi/agent/sessions，目标 ~/.epi/agent/sessions，采用不覆盖的字节保真复制和 SHA-256 校验。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- V2 不在当前产品运行入口中，原生工具契约保留，共享 Bash 不退化。
- 权限/Subagent 在独立 packages 中，默认集成，不依赖外置 wjharness；源移除仅在迁移验证后进行。
- easy-pi 配置/凭据/会话默认独立，不自动读取 Pi 凭据。
- 插件安装/加载及公开 API、压缩钩子有兼容证据；不能以空实现冒充。
- 安全交付清理临时文件，中断保护未交付成果，不自动续跑；缓存日志有界。
- 定向回归和根 check 通过；未验证的发行/平台/插件覆盖明确记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001,T-002,T-003 -> T-004 -> T-005 -> T-006 -> T-007.
- Parallel batches: 第一批 V2 退休、模块迁入、身份与数据路径三项独立；后续串行集成。
- Serialization constraints: coordinator 独占任务文档、root 配置/锁文件、依赖装配；共享核心文件仅 V2 writer 第一批修改。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 退休 V2 产品路径

- Status: done
- Owner: coordinator (用户已授权串行)
- Objective: 退休 V2 产品路径，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: packages/agent/src/harness/tools; coding-agent/core/tools 与 V2 接线
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: None.
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: 串行删除 V2 实现/API/运行接线，保留共享 Bash/workspace policy；冻结 tool-profile-eval 无 diff，并从当前编译和 Vitest discovery 排除。Agent harness/bash 12/12；coding-agent args + tool-execution-component 117/117；root npm run check 通过（格式化 10 个本任务文件）。已清理 README/usage/sdk/settings/environment 活跃文档，移除 FFF 及 runtime TypeScript（root 开发依赖保留）；offline lock-only install 和两个官方 generator 完成。补充 tools/default-tools/sdk-session-manager/sdk-skills/sdk-stream-options/dynamic-tools 6 files / 98 tests 通过；最新 root check 无格式改动通过。安装包启动验证留 T-004/T-006。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 迁入权限与 Subagent 模块

- Status: done
- Owner: coordinator (用户已授权串行)
- Objective: 迁入权限与 Subagent 模块，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: 新增 packages/permissions、packages/subagent，保留原仓库至验证完成
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: None.
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: 已迁入 packages/permissions、packages/subagent 和 coding-agent 组合 factory；原 WJ 源保留。Subagent 首批 8 files / 176 tests，补充 DAG/ledger/merge/nongit/quality/cache 等 20 个指定离线文件 218 tests 通过（合计 28 files / 394 tests）；权限 journal 3 tests、组合/questionnaire 6 tests 通过；root check 通过。权限 node:test 在迁入包和原 WJ 均为 15 passed / 4 failed，均涉及凭据读取策略与测试不一致（原始日志 /tmp/easy-pi-original-permissions.log）。未运行真实 provider。
- Blocker: None.
- Unblock condition: None. 用户明确选择 full-access 允许读取凭据；保留灾难性删除拦截。已按新契约更新迁入测试（不改原 WJ），权限测试 19/19 通过。模块迁入范围已完成离线验证；默认装配/launcher/依赖发行接线留 T-004，尚未宣称生产 child 可启动。

### [x] T-003 — 独立产品身份与数据目录

- Status: done
- Owner: easy-pi-identity + coordinator
- Objective: 独立产品身份与数据目录，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: coding-agent/config.ts、定向配置测试及产品身份模块
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: None.
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: 从只读账本恢复候选 f2262676，审查并应用 3 个文件；coordinator 将测试改为静态 imports，独立运行 node ../../node_modules/vitest/dist/cli.js --run test/config.test.ts test/easy-pi-data-isolation.test.ts：2 files / 21 tests passed；root npm run check 全部通过，Biome No fixes applied。合成 HOME 验证默认身份、独立路径、legacy env 不生效及技能隔离；未读真实凭据。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 默认装配与工作区依赖集成

- Status: done
- Owner: coordinator
- Objective: 默认装配与工作区依赖集成，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: extensions 入口、模块桥接、package manifests、tsconfig、锁文件
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: T-001, T-002, T-003
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: CLI/SDK 默认 factory 绑定实例 agentDir，显式产品 child launcher 不再猜 argv/PATH；ledger 延迟初始化。默认装配/launcher/SDK/组合 15 tests，lazy-ledger/ledger/extension 53 tests 通过。product build、root build:offline 与 root check 通过；npm pack 含两个私有 bundle 共 158 文件。临时目录使用生成 install-lock（仅内部包 resolved 指向本地 tarball），npm ci --offline --ignore-scripts 安装 133 packages；隔离安装目录 help/version 和 RPC get_commands 通过，permissions/subagents 默认加载，未生成任务 ledger。无真实 provider 调用；临时安装目录已清理。
- Blocker: None.
- Unblock condition: None.

### [ ] T-005 — 任务清理和数据导入契约

- Status: in_progress
- Owner: coordinator
- Objective: 任务清理和数据导入契约，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: Subagent 交付/清理、显式导入与版本化数据保护
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: T-004
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: 工作区已实现 /subagent-cleanup <run-id> [delivered|discard|keep]，权限/仓库范围检查、持久化显式确认、候选释放与 GC；只裁剪已确认且完整释放的历史，默认 256 MiB / 7 天、每轮至多 100 runs。父进程启动只维护既有 ledger、不自动续跑。Writer 启动前写保留标记，中断/取消保留编辑，未确认的恢复 reconciliation 拒绝删除；确认后清理 owned child runtime 与工作树。显式 session 导入已完成，见迁移记录。root npm run check 通过；最新两次定向 6 files 均为 148 passed / 1 timeout，5 个非 orchestrator 文件均通过。新增中断 Writer 与低层保留测试均有通过记录；尚无全绿的最新 orchestrator 文件结果。
- Blocker: DAG 回归存在不同测试位置的 30 秒超时，原因未证实，不能宣称验证完成。预算目前仅核算 ledger live pages，尚未覆盖所有受保护工作树/日志/cache 的磁盘占用及超额告警。
- Unblock condition: 定位 DAG 超时并通过修改文件回归；补齐可回收文件/受保护数据占用核算，验证产品构建与接线，审查后提交。不得将未确认产物或主会话纳入自动删除。

### [ ] T-006 — 公开插件兼容与综合验证

- Status: blocked
- Owner: coordinator
- Objective: 公开插件兼容与综合验证，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: 公开 exports/events、compaction hooks、安装与定向回归
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: T-005
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: 用户选择先核实官方版本，而非接受本地 853a80d26/0.84.4。fetch_content 访问官方 raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json 被 fake-IP SSRF 检查阻断；未绕过或擅自改用本地基线。
- Blocker: 官方版本/提交未核实，T-005 尚未完成。
- Unblock condition: 官方来源可正常核实或用户提供可核实的固定提交/版本；完成 T-005 后执行该公开契约验收。

### [ ] T-007 — 移除旧源码并收尾

- Status: pending
- Owner: coordinator
- Objective: 移除旧源码并收尾，保持用户确认边界。
- Inputs and prerequisites: 本契约、当前源码、适用 AGENTS 与历史冻结限制。
- Scope or files: wjharness 已迁移源码、产品文档、发行限制与任务证据
- Expected output: 可审查实现、针对性回归与实际验证记录。
- Dependencies: T-006
- Execution steps:
  1. 全文检查相关模块及消费者，实施最小完整变化。
  2. 运行定向测试，审查差异并记录不足。
- Acceptance criteria:
  - 本任务范围满足首版契约，不改变无关文件与真实用户数据。
- Verification method:
  - 定向离线合成数据测试、引用检查；集成后根 npm run check。
- Validation evidence: Not run.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

使用特定测试文件（Vitest/node:test），禁用真实 provider。历史 tool-profile-eval 全部保持字节不变且不执行；退役后不作为当前产品编译输入。根 npm run check 会写文件，运行前后检查无关变更。构建和安装包验证如需执行，先确认命令风险及现有用户授权；不发布。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

跨仓库未提交源码必须先复制、核对再删除；不删旧数据。公开插件兼容包含深度 compaction 契约，现状未证明。现有私有 fork 包名不代表有官方命名空间发布权。缓存和工作树清理必须保护未交付产物。会话 replacementHistory 不能直接交给官方解析。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-07: 新替换计划 T-005 源码接线完成：CLI/SDK built-in factory 使用原生六工具，Grok `/agents` 可查看并控制独立子 session。最新 coding-agent 8 files / 68 tests 与 subagent 4 files / 55 tests、root check 通过；包含虚拟终端/共享写入/实时权限与关闭边界。本文 T-002/T-004 的旧 DAG 迁入/发行证据仍仅为历史记录，新包安装验收须由替换 T-007 重做；本文 T-005 的预算/保护由替换 T-006 继续，不标完成。未更新旧 dist、未停止真实会话或读取旧 ledger；需先 drain 旧运行再部署新构建。

- 2026-09-06: 建立唯一执行记录；第一批 T-001/T-002/T-003 开始准备并行委派。记录现有 lockfile/accounts 与 wj 工作区改动，禁止无关覆盖。

- 2026-09-06: 第一批委派因 ownership 冲突后出现不可恢复 DAG；T-001/T-002 未执行。T-003 候选已从账本恢复、审查、集成并独立验证。未尝试删除旧源码、迁移用户数据或发布。等待用户允许串行执行剩余任务。

- 2026-09-06: 用户授权串行继续。T-002 迁入当前工作区源码；日志共享契约归权限包，组合 factory 属 coding-agent；原 wj 源码保持不变，真实 provider evaluator 未复制/执行。

- 2026-09-06: T-001 串行开始退休 V2 产品 API/实现；保留共享 Bash cwd policy 并重命名通用错误类型。冻结评测不编辑，仅从当前 TypeScript 编译输入排除；共享 Bash 回归转换为原生 read/edit。

- 2026-09-06: V2 退休回归 129 tests 通过，root check 通过，冻结评测无 diff。权限矛盾提交用户选择；用户明确选择 full-access 允许凭据读取，迁入测试按确认契约更新后 19/19 通过；灾难性删除断言保留，原 WJ 不变。

- 2026-09-06: T-001 依赖/文档收尾，offline lock-only install 后 generators 和 check 通过；新增原生/SDK 回归 98 tests 通过。T-001/T-002 模块阶段完成。T-004 开始：确认 CLI 手工加入 builtInExtensions 而 SDK loader 不加入；组合 factory 的 agentDir 需绑定实例，child launcher 不应猜测任意 process.argv[1]；新私有包还需发行内嵌或其他明确打包接线，不能生成虚构 registry 依赖。

- 2026-09-06: T-004 默认 factory/实例目录/显式 child launcher 接线，新增 lazy ledger 防止默认加载写磁盘。默认装配相关 15 tests、ledger 53 tests、product --noEmit 和 root check 通过。打包采用私有 workspace 随 coding-agent bundle，joint compile 避免声明构建环；未执行构建或安装 smoke。T-004 等待本地构建授权，T-006 待锁定兼容参考。

- 2026-09-06: 用户授权本地构建/临时离线安装，要求先核实官方参考。官方 fetch 被 fake-IP 检查阻断。root offline build、tarball 离线安装与 RPC smoke 通过。npm pack 初始遗漏 hoisted workspace symlinks，build 物化私有 bundle 后包含 158 文件；npm install 离线解析缺 minipass metadata，改用精确 install-lock 的 npm ci 成功。root hydration 被既有 accounts node_modules 断链阻断，保留该路径，coding-agent scoped hydration 成功。临时 smoke 目录已清理。T-005 交付信号/预算待确认；T-006 网络阻塞；不删除旧源。

- 2026-09-06: T-004 实现与验证已提交 06d7cba32。用户确认 T-005 使用显式“已交付并清理”操作、未交付保留/丢弃选择，以及 256 MiB / 7 天可回收数据预算。未交付成果不受自动删除规则影响。T-005 恢复 in_progress，由 coordinator 串行实施；T-006 继续等待官方基线核实。

- 2026-09-06: 用户新增明确要求“.easy-pi目录改成 .epi 并执行session迁移”。已修改默认身份/文档/路径测试并重建 coding-agent；保留 EASY_PI 环境接口。新增 scripts/migrate-session-data.mjs（默认 dry-run，--apply 才写），校验主会话 v1-v3、复制嵌套附属文件、拒绝符号链接/覆盖冲突/读时变化，私有权限原子发布。3 项 migration node:test、24 项配置/默认装配 Vitest、root check 和 product build 通过。实际从 ~/.pi/agent/sessions 复制 1487 文件（477 主会话、1010 附属文件），33,758,581 bytes；跳过 1 个旧 lease；错误 0。1487 目标哈希与读取快照一致，1487 原文件复核一致；477 主会话在当前 buildSessionContext 内存重建全部成功。审计报告 ~/.epi/agent/migrations/session-migration-2026-09-06.json（0600）。不迁移凭据、不删除原件、不修改冻结评测；运行中旧进程须重启后使用新默认目录。T-005 的历史预算和交付清理仍未完成。

- 2026-09-06: 用户随后明确授权将 ~/.pi/agent/auth.json 凭据迁入 ~/.epi/agent/auth.json；锁定源/目标、仅合并缺失项，新增 3 项、冲突 0，目标 0600，源保留且验证未变；未输出密钥，未验证 token 有效性。该外部操作不属于后续自动迁移授权。

- 2026-09-06: T-005 独立 /tmp 合成复现完成 retain 两次、默认拒绝 reconciliation、显式丢弃清理，全程约 201 ms。原低层 Vitest 曾反复 30 秒超时，临时阶段日志加入/移除后均通过，未证实根因；诊断改动已撤回，未调整生产代码掩盖超时。两轮 6-file thread-pool 回归均 148/149，分别在 Writer repair 与 transitive Writer 测试超时；前者独立重跑通过。fork-pool orchestrator 55/56，另一 Reviewer closure 测试超时，故不能仅归因于线程池。root check 通过且只格式化本任务文件；无关 lockfile 35 行保留。下一步在失败进程内采集 await/Git/lease 边界，区分子进程停顿和编排等待；不再盲目全量重跑。当前实现保持未提交，T-005 继续 in_progress。

- 2026-09-06: 用户确认并授权以 Codex V2 交互语义、Pi 原生会话和共享工作区替换当前 DAG，独立替换执行权威为 `2026-09-06-codex-subagent-replacement-task.md`。本任务 T-002/T-004 历史通过证据仅覆盖旧实现；默认切换后须以新计划 T-005/T-007 重验装配，T-005 清理/数据保护由新计划 T-006 共同覆盖。原未提交安全改动已保存回退快照，不表示旧超时已修复。官方 Pi 兼容与发布阻塞保持不变。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002/T-003 已完成各自模块范围：V2 回归 129 tests + 补充原生/SDK 98 tests；迁入权限 19、journal 3、Subagent 394、组合 6 tests 通过；最新 root check 通过。冻结评测无 diff，root lock 既有 accounts 元数据保留。
- Limitations: T-004 的旧 DAG 版本已通过本地 Node 打包/离线安装/无 provider RPC 启动验证；新原生默认/Grok 接线已做源码定向验收，新版本尚未重做包安装或部署。Bun 二进制及真实 provider 未验证。T-005 导入已完成，清理实现待最终验证及全文件占用核算；T-006 官方基线受网络检查阻断，T-007 依赖前两者；未发布，旧源码和旧数据保留。
