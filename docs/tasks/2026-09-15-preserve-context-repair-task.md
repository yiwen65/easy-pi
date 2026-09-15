# Task Plan: preserve 上下文回归修复

- Created: 2026-09-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求 commit all changes；确认包含其他会话及锁文件、最小修复6个lint警告；新发现preserve回归后选择“修复后再提交”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复提交前新发现的子代理preserve上下文回归，使匹配模型/effort的父子请求能保留前缀，不放宽前缀或权限校验。此文档只跟踪该新增修复及其验收，完成后回到用户授权的全部改动提交；不维护另一份同目标计划。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 根据实测首次差异修改原生child host/内置工具接线及最小回归；不改无关compaction功能，不降低测试期望。
- 只用隔离HOME、无凭据、faux模型的定向测试；不调用真实模型或付费服务、不改权限/公网防护、不推送、不绕过提交钩子。
- 用户已授权提交全部原有文件、锁文件、6个lint修复及本次必要的preserve修复；非必要新问题仍需另行确认。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 6个unused警告已按确认范围清理，完整npm run check通过，未自动改写其他文件 | `/tmp/pi-commit-all.5UDjx6/check.log`、pre-check/post-check哈希 |
| F-002 | coding-agent定向回归141/142通过，匹配模型的preserve子代理却变成failed | `coding-tests.log`、`model-defaults-isolated.log` |
| F-003 | 恢复5个lint文件到清理前版本的内存transform仍复现失败；faux只有父请求1次，子请求未到达模型 | `model-defaults-before-lint.log`（临时transform已清理，原始文件备份保留于before/） |
| F-004 | 修复前根默认内置工厂有web-search；原生child使用自定义ResourceLoader，工厂只有easy-pi-child与额外扩展 | `src/extensions/index.ts`、`src/extensions/pi-child-session-host.ts` |
| F-005 | guard处模型/messages相同，无payload hook；子请求缺web_search/web_fetch，system与tools均不同 | `prefix-first-difference.log` |
| F-006 | 只在测试进程给child补齐同一web工厂，原失败转绿；guard完全不变 | `prefix-intervention.log`，1/1通过 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已证明原因：子ResourceLoader遗漏内置web工厂，未知工具名被setActiveToolsByName忽略，连带丢失工具schema及promptSnippet/promptGuidelines；严格prefix guard正确拒绝。单变量补齐工厂恢复原测试，排除了lint清理、模型/effort及消息分叉作为此次原因。
- 已解决的授权：用户明确选择修复该测试失败后再提交，不接受记录失败直接提交。
- 无额外用户决策；如需要放宽前缀验证或权限则不实施，返回询问。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 找到首次差异，用单一变量干预让失败消失；不把guard绕过当修复。
- 原失败及新回归通过，工具继承/限制、prefix不兼容拒绝、无推理启动I/O保持。
- 定向测试及全仓check通过，记录验证边界，源码diff只有必要修复。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002。
- Parallel batches: 无；同一child接线与回归状态共享，串行处理。
- Serialization constraints: coordinator独占本次修复、测试和文档；保留其他已有改动，最终由已授权的父流程提交全部改动。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 首次差异定位与最小修复

- Status: done
- Owner: coordinator
- Objective: 定位preserve失败原因并修复，不放宽校验。
- Inputs and prerequisites: F-002/F-003复现、已授权修复。
- Scope or files: child host、必要内置工厂接线、对应回归；临时诊断在证据目录。
- Expected output: 因果证据、最小生产补丁及先红后绿回归。
- Dependencies: None.
- Execution steps:
  1. 在隔离测试进程记录父子请求的首个差异。
  2. 单变量干预验证原因，增加最小保护测试后修复。
- Acceptance criteria:
  - 原失败和因果回归通过，prefix及权限校验未削弱。
- Verification method:
  - faux定向测试、运行时schema对照和diff审查。
- Validation evidence: `prefix-first-difference.log`确认仅工具及其系统提示不同；单变量测试进程注入1/1通过。新增默认组合回归未修时1失败/2通过（`preserve-regression-red.log`），补丁只在child host增加同一个内置web工厂，无guard改动。原defaults、新组合及child host/collaboration tools/cache-affinity共5文件73/73通过（`preserve-green-neighbors.log`），包括自定义无web父加载器、权限限制、live撤销与prefix拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成门禁与提交准备

- Status: done
- Owner: coordinator
- Objective: 验证修复与全部待提交改动可一起通过门禁。
- Inputs and prerequisites: T-001完成。
- Scope or files: 相关测试、全仓check、本任务及既有web任务的门禁记录。
- Expected output: 可提交的已验证工作树；实际commit由用户的父流程执行并回报hash。
- Dependencies: T-001.
- Execution steps:
  1. 运行原14个coding-agent文件、邻近prefix/collaboration回归、subagent/web/pack定向测试。
  2. 检查完整check和工作树；更新真实门禁状态，清理临时诊断程序。
- Acceptance criteria:
  - 所选回归和全仓check均通过，没有未披露测试失败或无关改写。
- Verification method:
  - 测试日志、check完整输出、工作树/文档validator。
- Validation evidence: `/tmp/pi-commit-all.5UDjx6/`的final-coding-tests.log为16文件178/178；final-contract-tests.log为48/48，final-web-tests.log为83/83，final-pack-tests.log为3/3。final-check.log完整通过，1336文件无修复，pre/post-final-check哈希与diff相同。final-build.log离线重建成功；compiled-preserve.log默认/排除web/allowlist三场景均completed、模型前缀system/tools/messages相同，keyReads/fetches/spawns均0。canonical/materialized五个web模块相同，CLI 0.84.2。audit-ready.json确认58文件，除5个授权lint目标、2个修复文件及2份任务记录外，其余待提交文件与基线相同，未发现所扫描密钥模式。full-page任务门禁已解除，两个任务文档validator通过；临时诊断程序已清理。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- 所有模型测试用faux与无凭据子进程；禁止全量vitest/npm test和真实provider。
- 原失败文件、child host、collaboration tools/context/cache-affinity及工具限制回归；原compaction/打包/web定向测试保持。
- `npm run check`前后快照比较；提交时显式路径和已授权锁文件开关，不关闭钩子。
- 原失败与邻近重放命令（在coding-agent目录、隔离HOME/无凭据/PI_OFFLINE=1）：`node ../../node_modules/vitest/dist/cli.js --run test/subagent-model-defaults.test.ts test/easy-pi-default-composition.test.ts test/pi-child-session-host.test.ts test/pi-collaboration-tools.test.ts test/pi-collaboration-cache-affinity.test.ts`。
- 其余门禁：subagent目录定向 `test/collaboration-contract.test.ts`；根目录 `node packages/pi-web-search/test/run.mjs`、`node --test scripts/pack-easy-pi.test.mjs`、`npm run check`、`npm run build:offline`。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- preserve保护可能正确拒绝不同schema，不能只改expected或剥离新增工具来伪造匹配。
- child工具注册不等于授权；仍必须受原getTools/toolAllowed约束。
- 原工作树含多个会话的未提交变更，用户已确认全部提交，但不得在修复中顺便重构。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-15：用户确认跨会话/锁文件全部提交及6个lint修复；5个文件完成最小清理，check通过。
- 2026-09-15：定向回归发现preserve失败；单文件和清理前版本均复现，子模型调用数为0。
- 2026-09-15：用户选择修复后再提交；T-001 in_progress，下一步在prefix guard处记录首次差异。
- 2026-09-15：首次差异是child遗漏web工具及对应系统提示；单变量工厂注入使原失败1/1通过，不更改guard。新增默认/排除web/显式allowlist三组真实默认组合回归，先对未修生产代码运行。
- 2026-09-15：新默认组合回归先红，另外两组过滤场景绿；补齐child同一web工厂后5文件73/73通过，T-001 done。T-002 in_progress：继续原14文件、subagent/web/pack、完整check和已授权离线dist重建；不扩大最小修复文件范围另写LEARNS，因果证据留在本任务与回归。
- 2026-09-15：最终16文件178/178、subagent48/48、web83/83、pack3/3、全仓check与离线build通过。compiled smoke初次误把已过滤工具当作getAllTools仍应可见；核实sdk/_refreshToolRegistry语义后仅修正临时断言，三场景通过，零key/网络/子进程启动。生产补丁未因此变化。
- 2026-09-15：58文件基线审计无额外漂移，full-page原lint门禁更新完成；删除临时诊断程序，保留红绿/集成/构建日志及文件快照，文档validator通过。T-002 done；回到已授权父流程，以显式58路径、锁文件许可及启用的仓库hook提交，不推送。
- 2026-09-15：全量staged diff检查仅提示既有runtime-refactor计划中用于Markdown硬换行的双空格；保留该文档原样，不做无关清理。排除这一已核实文档后的staged diff检查通过；仓库完整check不受影响。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001/T-002 done；原回归先红后绿、最终178+48+83+3=312项定向测试、完整check、离线dist重建及compiled preserve验证通过。
- Limitations: 未运行全量测试/真实模型API；本轮未重跑源码未变的web实网正文/Chrome fixture（此前均通过）。未重启用户进程，内置模块仍需实际进程重启生效。本计划验收修复与提交准备；全部改动的实际commit由已授权父流程执行，hash以Git记录和最终回复为准，无push。
