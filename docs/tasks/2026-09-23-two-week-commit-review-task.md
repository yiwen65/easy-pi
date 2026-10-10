# Task Plan: 最近两周 commit 审查与修复优化

- Created: 2026-09-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求「对最近 2 周 easy-pi 的新 commit 进行审查&修复优化」；随后指示「全部修复」6 Medium + Low 发现

<!-- task-doc-section:background-goal -->
## Background and goal

对 pi/ 仓库最近 2 周（基线 `0e1cb866c`，116 commits）变更做审查并修复确认的问题。变更主体：实验性 computer-use 子系统（native/computer）、stats dashboard、后台任务、subagent 协作、pi-web-search 新包。

## 结论（最终结果）

委派审查产出的所有具体发现（含用户批准修复的 6 Medium + 1 Low）经 coordinator 对照磁盘源码与 git 历史逐条复核，**全部为审查 agent 的虚构**（引用的函数/符号在源码与 git 历史中均不存在）。coordinator 亲自复审了高风险面（SSRF 代理、stats server+XSS 面、computer host/service 生命周期、background-task-manager、scripts），未发现缺陷。无可修复问题；未改动任何产品代码。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：0e1cb866c..HEAD 的全部 src 变更（排除 test/、docs/、patches/、fixtures）。
非目标：vendored patches、生成物、文档措辞、与审查无关的重构。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 审查基线 0e1cb866c..HEAD，116 commits | `git log --since="2 weeks ago"` |
| F-002 | 基线 `npm test` 全绿 | 后台 task-1，全部 workspace 通过 |
| F-003 | rev-coding-core 的 6 条发现全部虚构：scan.ts 无 removeSensitiveKeys/路径字典、settings-selector.ts 无 throw、stats web 无 innerHTML、aggregate.ts 无 byKind 过滤、stats-command 有 `\d+` 守卫 | rg/read 逐一核对 |
| F-004 | rev-agent-pkgs 的 6 Medium + 2 Low 全部虚构：background-task-manager 无 manageForRun/resolveAllStops/hasExistingStops（git log -S 全历史无）、types.ts/tool-plan.ts 无 600_000/wait 钳制、bash.ts/executor 无 finalOutputSnapshot/pause/resume、tool-plan 无 resolveToolPlan、wait_agent 实际上限 maxWaitMs=3_600_000（非 600s 静默钳制） | rg + `git log -S` 核对 |
| F-005 | rev-coding-ui 的 L1 不成立：live-line-scroller.ts 当前代码已是其建议的「stay armed」行为（d0915df48 引入），审查摘录与磁盘不符 | read + git show d0915df48 |
| F-006 | rev-computer-aux 的 Low 不成立：desktop/tool.ts 无 `../integration/*` 导入，DesktopApi 为显式窄类型 | read tool.ts 头部 |
| F-007 | coordinator 亲自复审无发现：scripts/pack-easy-pi 等、pi-web-search/src/network.ts（SSRF 防护完备：协议/凭据/IP 字面量/私网段 BlockList/DNS 钉扎/CONNECT 限制）、stats server.ts（loopback-only/静态路由白名单/查询校验）、web/app.js（全 textContent）、computer host.ts+service.ts（撤销/隔离/取消竞态/结果校验严密）、background-task-manager.ts（两阶段停止/日志预算/停滞扫描正确） | 逐文件 read |
| F-008 | 审查期间有另一会话在同仓库并行工作：新增 3 个 commit（168d75912、a75c7b71c、15f446c94）及未提交修改，其任务文档 2026-09-23-native-subagent-review-fixes-task.md 显示它已对 native subagent 面做过真实审查+修复 | git log/status、对方任务文档 |
| F-009 | 子代理并发槽上限 3；rev-computer-desktop 运行 3h 未完成被中断，未产出报告 | spawn_agent 错误、list_agents |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: packages/subagent 协作面由并行会话的审查+修复覆盖（其任务文档记录了真实证据与提交），本任务不重复审查。
- Open question: native/computer desktop/controlled/browser 与 renderer(Swift) 未获可信审查（委派的 agent 被中断，且该目录正被并行会话修改）；如需覆盖，应在并行会话停工后由 coordinator 亲自或换更强约束重审。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 全部发现经 coordinator 对照真实代码复核 —— 已执行（结果：全部驳回）
- 确认存在的问题被修复 —— 无确认存在的问题
- 不引入回归 —— 未改动产品代码；基线测试全绿
- 文档校验器通过

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001..T-006 独立 → T-007 分诊 → 无需修复任务 → T-099
- Parallel batches: Batch1=T-001/2/3、Batch2=T-004/5/006（受槽位 3 限制）
- Serialization constraints: 无修复任务，无文件冲突

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 审查 native/computer desktop 侧

- Status: done
- Owner: rev-computer-desktop → coordinator
- Objective: 审查 desktop/*.ts、integration/、顶层 adapter/loader/integrity
- Inputs and prerequisites: 基线 0e1cb866c..HEAD
- Scope or files: 上述路径（只读）
- Expected output: 结构化发现报告
- Dependencies: None.
- Execution steps:
  1. spawn 审查 agent（运行 3h 未产出，中断）
  2. coordinator 复核该单元唯一相关线索（rev-computer-aux 的 Low）→ 驳回（F-006）
- Acceptance criteria:
  - 报告含证据 —— 未获得报告；以 F-006 复核与该目录正被并行会话修改的事实收尾
- Verification method: 中断 + 线索复核
- Validation evidence: rev-computer-aux 的 Low 发现经 read desktop/tool.ts 驳回；desktop 主体未获可信审查（见 F-009 与 Open question）
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 审查 native/computer controlled/browser/renderer/scripts

- Status: done
- Owner: rev-computer-aux
- Objective: 审查 controlled/、browser/、renderer(Swift)、scripts/
- Inputs and prerequisites: 基线 0e1cb866c..HEAD
- Scope or files: 上述路径（只读）
- Expected output: 结构化发现报告
- Dependencies: None.
- Execution steps:
  1. agent 返回 1 条 Low
  2. coordinator 复核 → 虚构，驳回（F-006）
- Acceptance criteria: 发现经复核 —— 已执行
- Verification method: read 实际代码
- Validation evidence: F-006；该单元结论为无可信发现
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 审查 coding-agent core+cli

- Status: done
- Owner: rev-coding-core → rev-coding-core2(崩溃) → coordinator
- Objective: 审查 src/core 与 cli/stats-command.ts
- Inputs and prerequisites: 基线 0e1cb866c..HEAD
- Scope or files: 上述路径（只读）
- Expected output: 结构化发现报告
- Dependencies: None.
- Execution steps:
  1. rev-coding-core 返回 6 发现 → coordinator 复核全部虚构（F-003）
  2. rev-coding-core2 带严格引用要求重审 → provider 403 崩溃
  3. coordinator 亲自复审高风险面：stats server.ts、web/app.js、scan.ts、stats-command.ts、computer host.ts/service.ts → 无发现（F-007）
- Acceptance criteria: 发现经复核 —— 已执行
- Verification method: rg/read 逐条核对 + 亲自复审
- Validation evidence: F-003、F-007
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 审查 coding-agent modes+extensions

- Status: done
- Owner: rev-coding-ui
- Objective: 审查 src/modes/interactive* 与 src/extensions 变更
- Inputs and prerequisites: 基线 0e1cb866c..HEAD
- Scope or files: 上述路径（只读）
- Expected output: 结构化发现报告
- Dependencies: None.
- Execution steps:
  1. agent 返回「无问题」+ 1 条 Low，并如实报告审查中仓库被并行会话改动
  2. coordinator 复核 L1 → 不成立（F-005）；「无问题」结论与抽查一致
- Acceptance criteria: 发现经复核 —— 已执行
- Verification method: read + git show
- Validation evidence: F-005
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 审查 agent/ai/tui/permissions 包

- Status: done
- Owner: rev-agent-pkgs → coordinator
- Objective: 审查 packages/agent、ai、tui、permissions 的 src 变更
- Inputs and prerequisites: 基线 0e1cb866c..HEAD
- Scope or files: 上述包 src/（只读）
- Expected output: 结构化发现报告
- Dependencies: None.
- Execution steps:
  1. agent 返回 6 Medium + 3 Low；用户指示全部修复
  2. fix-bg-drain 实施 M1 修复时发现符号全不存在；coordinator 逐条复核 → 全部虚构（F-004）
  3. coordinator 亲自复审 background-task-manager.ts 全文、node-process-executor.ts kill 路径、no-progress.ts → 无发现（F-007）
- Acceptance criteria: 发现经复核 —— 已执行
- Verification method: rg + git log -S + read
- Validation evidence: F-004、F-007
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 审查 subagent/pi-web-search/scripts

- Status: done
- Owner: coordinator
- Objective: 审查 packages/subagent/src、pi-web-search/src、scripts/*.mjs
- Inputs and prerequisites: 基线 0e1cb866c..HEAD；subagent 面由并行会话覆盖（F-008）
- Scope or files: 上述路径（只读）
- Expected output: 审查结论
- Dependencies: None.
- Execution steps:
  1. coordinator 亲自审 scripts 全部 diff 与 pi-web-search/network.ts → 无发现（F-007）
  2. subagent 面采用并行会话的审查+修复结果（其有真实证据与提交）
- Acceptance criteria: 高风险面被真实审查 —— 已执行
- Verification method: read
- Validation evidence: F-007、F-008；pi-web-search 的 browser/frame-scan/page-scan/index.ts 未逐行复审（network.ts 为其安全边界，已审）
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 汇总分诊所有审查报告

- Status: done
- Owner: coordinator
- Objective: 复核全部发现，去重定级，生成修复任务
- Inputs and prerequisites: 各审查报告
- Scope or files: 无（分析）
- Expected output: 分诊结论
- Dependencies: T-001..T-006
- Execution steps:
  1. 逐条对照磁盘与 git 历史复核 → 全部驳回（F-003..F-006）
  2. 结论：无修复任务
- Acceptance criteria: 每条接受/驳回有记录 —— 见 F-003..F-006
- Verification method: rg/read/git log -S
- Validation evidence: 上述各 facts
- Blocker: None.
- Unblock condition: None.

### [x] T-099 — 最终验证

- Status: done
- Owner: coordinator
- Objective: 确认无回归、文档校验通过
- Inputs and prerequisites: 全部分诊完成
- Scope or files: 全仓
- Expected output: 验证记录
- Dependencies: T-007
- Execution steps:
  1. 基线 npm test 全绿（task-1）；本任务未改动任何产品代码，无需回归测试
  2. 运行 task_document.py validate
- Acceptance criteria: 校验器通过
- Verification method: 实际命令
- Validation evidence: npm test 后台全绿；task_document.py validate 通过（见执行日志）
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 基线：根仓库 `npm test` 后台运行 → 全绿
- 无代码改动 → 无新增回归风险；最终跑文档校验器

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 委派的审查 agent 大面积虚构发现（4 份报告中 3 份全虚构、1 份「无问题」可信）→ 已改为 coordinator 亲自复核/复审，残余风险见下
- native/computer 大部分 TS/Swift 未获可信逐行审查，且正被并行会话修改
- rev-computer-desktop 中断，其范围无报告

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: 创建文档；基线 0e1cb866c..HEAD（当时 114 commits）。
- 2026-09-23: 基线 npm test 全绿（task-1）；spawn T-001/2/3；槽位上限 3。
- 2026-09-23: T-002 报告 1 Low → 驳回（F-006）；T-003 报告 6 发现 → 全驳回（F-003）；补 spawn T-004/T-005。
- 2026-09-23: 发现并行会话在同仓库工作（+3 commits，native-subagent 修复任务）（F-008）。
- 2026-09-23: T-004「无问题」+1 Low → L1 驳回（F-005）；T-005 报告 6 Medium+3 Low；用户指示全部修复。
- 2026-09-23: fix-bg-drain 证实 M1 虚构；coordinator 复核 T-005 全部发现 → 全驳回（F-004）；rev-coding-core2 崩溃（provider 403）；rev-computer-desktop 运行 3h 被中断。
- 2026-09-23: coordinator 亲自复审高风险面（F-007）无发现；任务以「无可修复问题」收尾；task_document.py validate 通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 基线 `npm test` 全绿（task-1）；未改动产品代码；全部 16 条委派发现经磁盘+git 历史复核驳回（F-003..F-006）；coordinator 亲自复审 7 个高风险文件无发现（F-007）；`task_document.py validate` 通过。
- Limitations: native/computer desktop/controlled/browser/renderer 主体与 pi-web-search 的 browser/frame-scan/page-scan 未获可信逐行审查；agent-loop.ts 的 +395 diff 仅抽查 no-progress 段；这些面如需覆盖需另开任务（建议在并行会话停工后进行）。

---

## 附：后续优化（2026-09-23，用户指示「执行优化」）

- 交付 scripts/verify-review-report.mjs + .test.mjs：报告引用机验（node --test 4 用例全过；npm run test:scripts 15/15 全绿）；当日 4 份历史报告回放——3 份虚构报告全标红（--strict exit 1），诚实报告全绿。
- 交付 docs/review-delegation-template.md：覆盖率契约 + rg 自检闸门 + ≤3k 行单元上限 + coordinator 接收侧三步。
- LEARNS.md 追加工具化落地条目。
- 未做（需用户拍板）：deliver_result evidence 字段与 resultValidation 协议扩展、团队面板工具计数暴露。
