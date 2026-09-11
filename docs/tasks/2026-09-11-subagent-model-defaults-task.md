# Task Plan: Subagent 全局模型与 effort 默认设置

- Created: 2026-09-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求增加 Subagent model/effort 设置，结构化确认统一默认值、全局保存与以下实施范围。

<!-- task-doc-section:background-goal -->
## Background and goal

通过 /settings 设置新建 Subagent 的模型与 effort，避免每次要求模型填写 spawn 参数；两个字段独立支持继承调用者。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

全局持久设置、/settings 入口、原生 root/嵌套 spawn 解析、离线回归、文档和本地重建。优先级逐字段为单次显式覆盖 > 全局默认 > 调用者。只影响后续新建孩子，不改现有孩子及其 followup。不做项目配置、逐孩子调参、其他运行中实例热同步、模型自动回退。
串行，不委派、不提交、不发布、不重启当前会话、不调用真实模型。不改冻结 tool-profile-eval 子树、真实历史、旧 DAG 恢复材料或无关 dirty/untracked 文件。保留约定 rollback tar；历史两个 /tmp 证据目录此前已发现不存在，本轮不恢复或删除。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | spawn 已有 model/reasoning_effort 显式参数，默认继承调用者 | pi-collaboration-tools.ts spawn 分支、CollaborationSchemas |
| F-002 | 默认 root 创建 host 时复制 Settings，但子工具闭包可读取 root 的实时 getter | pi-collaboration-root.ts registerTools / settings |
| F-003 | SettingsManager 有全局限定读取及字段级持久写入惯例 | settings-manager.ts getDefaultProjectTrust / save |
| F-004 | regular/Grok 共享 InteractiveMode 的 SettingsSelector | interactive-mode.ts showSettingsSelector；grok-agents-host.test.ts 原生 renderer 组合 |
| F-005 | 工作树包含上轮未提交优化与无关工作 | 初始git status；/tmp/epi-subagent-defaults-baseline.patch |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumption: 保存立即影响当前主会话后续的新建孩子，包括已创建孩子随后新建的后代。
- Open questions: 无。用户已确认本地重建；真实模型与当前会话重启仍未授权。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 全局持久化/重开、独立重置继承、不受项目覆盖影响；不改变 root 模型/effort。
- 每字段优先级正确，nested spawn 读取 live root defaults，已有孩子/followup 不变。
- 不支持的模型/effort 或 preserve 冲突明确拒绝，无静默回退、无意外 provider 调用。
- /settings 可键盘选择、返回、搜索模型及重置继承，regular/Grok 共用入口可用。
- 指定离线回归、根 check、diff、任务校验、本地 build 和 compiled native smoke 通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无，沿用串行授权。
- Serialization constraints: root/adapter/config/UI 共享边界依次实施。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 全局配置与实时 spawn 解析

- Status: done
- Owner: coordinator
- Objective: 实现全局 model/effort 默认值及安全、逐字段的解析优先级。
- Inputs and prerequisites: 已确认合同、SettingsManager 与原生工具/host 接线。
- Scope or files: settings-manager.ts、pi-collaboration-root/tools.ts、必要小型解析模块和相关 tests。
- Expected output: 全局设置接口、共享 live getter、兼容性拒绝及回归。
- Dependencies: None.
- Execution steps:
  1. 添加设置持久化、优先级与嵌套实时更新回归。
  2. 实现最小配置与接线，维持 preserve 校验和旧孩子不变。
- Acceptance criteria:
  - 全局配置独立重置；root/child override/default/inherit 与拒绝语义通过。
- Verification method:
  - 指定 settings/defaults/native integration tests。
- Validation evidence: 2026-09-11 01:00 `PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/subagent-model-defaults.test.ts test/pi-collaboration-tools.test.ts test/pi-child-session-host.test.ts`：3文件54项通过，含全局保存/独立reset、七种逐字段优先级、生产默认root接线下旧孩子保留与后代live更新、非法配置零调用/零预留、preserve冲突与匹配override。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — /settings 用户入口

- Status: done
- Owner: coordinator
- Objective: 可发现、可选择、可重置且不改变 root 模型的设置入口。
- Inputs and prerequisites: T-001 全局设置接口。
- Scope or files: settings-selector.ts、interactive-mode.ts 的 settings 接线及组件/host tests。
- Expected output: Subagent model/effort 项，独立继承选项，安全明确的兼容性提示。
- Dependencies: T-001.
- Execution steps:
  1. 复用现有设置和选择组件，使用当前本地模型目录，不在设置打开时刷新网络。
  2. 验证选择/返回/继承、长模型名称及宿主接线。
- Acceptance criteria:
  - 设置写全局、立即影响后续 spawn；关闭不改值，root 不切模型。
- Verification method:
  - settings-selector 与 targeted real-host faux tests。
- Validation evidence: 2026-09-11 01:07 `PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run test/settings-selector.test.ts test/subagent-settings-host.test.ts test/subagent-model-defaults.test.ts`：3文件25项通过；实际legacy/Grok × regular/fullscreen四组合键盘选择，临时全局文件重开和随后生产spawn model/effort捕获通过，root模型/草稿不变；设置打开不刷新catalog/调用provider。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 文档、集成验收与本地构建

- Status: done
- Owner: coordinator
- Objective: 完成行为文档与可运行本地产物。
- Inputs and prerequisites: T-002。
- Scope or files: settings.md/collaboration.md、本文件、构建产物；settings-manager.test.ts/settings-manager-bug.test.ts 仅纠正已证实的旧目录fixture。
- Expected output: 离线证据、默认行为说明、已更新 dist。
- Dependencies: T-002.
- Execution steps:
  1. 反例审查并跑指定回归、根check，核对自动格式化范围。
  2. 更新文档；串行本地build和compiled native smoke，验证全局pi路径。
- Acceptance criteria:
  - 源码/构建/离线验收通过，不声称运行中实例热更新或真实模型验收。
- Verification method:
  - targeted vitest、npm run check、git diff --check、task_document.py validate、coding-agent build、check-native-subagent-product.mjs。
- Validation evidence: 2026-09-11：coding-agent指定9文件112项通过；subagent contract/controller/delegation指定3文件69项通过，共181项。旧设置fixture纠正后HEAD SettingsManager对照46项通过；最终格式化后再跑46项通过。根`npm run check`全部通过，立即哈希对比仅本任务settings-manager.test.ts被格式化。离线coding-agent build、compiled native spawn/tool catalog/retired exports/CLI/两份pack inventory通过；编译后SettingsManager保存重开/独立reset/root不变smoke通过。`pi --version`为0.84.2，实际指向本仓库dist/cli.js。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

只运行明确指定测试文件，不运行全套或冻结评测。采用临时 SettingsStorage/目录与 faux provider；根 check 前后记录 tracked/untracked 哈希，排除冻结评测子树。以实际产物导入和offline pack smoke验收build，不调用真实模型。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

子会话拥有 Settings 快照，必须显式注入 root 的实时 defaults getter，不能误把冷启动复制当作嵌套即时更新。effort 与模型按字段独立继承可能产生不支持的组合，应明确拒绝，而不是降级。preserve 与默认模型冲突必须继续失败。当前电脑发热未诊断，本轮保持串行构建，不能把新设置当作发热修复。

<!-- task-doc-section:execution-log -->
## Execution log

- T-003扩展回归首次9文件104通过/8失败。临时Vitest load插件只将settings-manager.ts替换为HEAD（该文件任务开始无diff），其余代码不变，重现完全相同8失败/38通过，日志 `/tmp/epi-defaults-baseline-tests.log`。原因：旧fixture读写硬编码`.pi`，FileSettingsStorage实际读写CONFIG_DIR_NAME（`.epi`），所以项目设置从未加载或断言读错文件。仅两文件fixture改用CONFIG_DIR_NAME，不更改产品目录行为；纳入T-003必要验收修复。

- 2026-09-11: 已确认全局默认值合同，刷新源码和工作树，创建唯一authority；T-001开始。下一步配置与spawn边界测试。

- 2026-09-11 01:01: T-001完成，T-002开始。model/effort校验前移到预留之前，两个旧回归改为明确断言零失败记录与安全reason；host加载失败仍保留失败任务。新prefix成功fixture首次失败是macOS临时cwd别名不同，仅canonicalize测试cwd后通过，未放宽产品prefix校验。下一步 /settings 入口与宿主测试。

- 2026-09-11 01:08: T-002完成，T-003开始。复用SettingsList提供模型搜索/继承，effort独立选择；不复用会改root模型并刷新网络的ModelSelector。宿主回归初版错误假设legacy有Grok flushActions，改为按实际renderer有无队列flush后四组合通过。下一步根check/反例审查、文档和本地构建。

- 2026-09-11 01:19: T-003完成。两组离线回归12文件181通过，根check及本地build/compiled smoke通过。与初始tracked patch比较，本任务范围以外仅compaction-summary-message.ts变化；precheck最终对比还发现compaction-summary-click.test.ts变化，二者在check结束即时核对时未变化，本任务没有编辑这两文件，保留现场不归因或恢复。无新LEARNS条目：本次fixture调整及测试适配属于常规验收迭代，证据保留于本任务。临时诊断脚本完成后清除，baseline日志/patch/manifest保留。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002/T-003所列离线行为、181项相关回归、根check、本地build与compiled smoke通过；最终diff与任务结构校验通过。rollback tar SHA256仍为`2ed18755bd073b520183f2049a20d73d557ab6e24477d60915c33eb04cda87ab`。
- Limitations: 真实模型、跨实例热同步与当前会话重启不在授权内。当前运行实例需用户自行重启加载新产物；不代表发热问题已解决。最初未跟踪文件无任务开始时字节基线；最终发现两个非本任务compaction文件在根check即时核对后又发生变化，未改动或回滚，不能声称整个共享worktree稳定。
