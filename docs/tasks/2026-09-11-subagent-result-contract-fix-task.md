# Task Plan: Subagent final JSON 输出契约修复

- Created: 2026-09-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求修复真实luna/max验收发现的F-REAL-001。

<!-- task-doc-section:background-goal -->
## Background and goal

弥补child最终输出提示与实际validator之间的契约信息缺口，防止模型将curated reference对象直接用作evidence元素。不放宽validator、不伪造结构化成功。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

原生child初始任务/followup结果提示、真实失败fixture、离线host/controller回归和文档。串行、不委派实现、不提交、不发布、不重启、不改真实历史或冻结tool-profile-eval。旧真实测试预算已结束，本轮不新增付费调用；未获新构建请求，不重建dist。不是Provider强制JSON输出功能，不引入修复重试/输出强制转换。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 真实curated final的evidence是对象数组而schema要求string[]；diagnostic只改该字段类型即valid | subagent-luna-real-validation-task.md及聚合summary |
| F-002 | host目前只给空数组样例，未给元素类型、string限制和额外字段禁令 | pi-child-session-host.ts run prompt |
| F-003 | DelegationResultSchema已定义所有必填字段、枚举、nonblank string/maxItems；validateDelegationResult额外检查8KiB | collaboration-contract.ts |
| F-004 | 严格prefix内容要求新任务追加在既有请求后，不能顺手修改共享system规则 | pi-collaboration-tools.test.ts preserve回归 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 优先修补已证实的提示信息缺失，保留严格validator；不能凭离线faux测试保证真实模型以后始终遵守。
- Open question: 无实施阻塞；真实重测与本地重建需后续明确授权。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- provider实际收到的child初始与followup任务包含与validator同源的完整结果schema，明确所有结果数组仅允许字符串、不能复用curated对象。
- 字节预算、只返回JSON、版本/哈希证据、无自动handoff和not_reviewed语义保留。
- 真实非法样本仍invalid、原文保留且无新增provider调用；合法字符串证据仍valid。
- targeted离线回归、根check、自动formatter范围核对、diff/任务校验通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002.
- Parallel batches: 无。
- Serialization constraints: 同一host/contract边界，串行实施。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 结果契约提示与回归

- Status: done
- Owner: coordinator
- Objective: 在真实provider请求边界暴露validator要求。
- Inputs and prerequisites: 已确认F-REAL-001与当前源码。
- Scope or files: pi-child-session-host.ts、host/contract相关测试。
- Expected output: schema同源提示、失败样本与初始/followup回归。
- Dependencies: None.
- Execution steps:
  1. 添加实际请求缺少schema的失败回归和真实非法fixture。
  2. 提供同源schema与必要说明，不修改validator或添加repair调用。
- Acceptance criteria:
  - 新请求schema断言先失败后通过，旧非法输出仍按原文invalid。
- Verification method:
  - 指定host/contract/controller工具回归。
- Validation evidence: 02:15新host回归在实际provider请求缺少完整schema处先失败；随后仅host提示加入同源DelegationResultSchema后通过。覆盖初始curated及shutdown/reopen后的显式followup；真实非法样本仍原文保存/返回并invalid，期间不自动请求（只有两次显式任务各一次），合法文本证据valid/not_reviewed。02:16 subagent指定3文件73项、coding-agent指定3文件55项通过，共128项，含严格preserve/nested/defaults/生命周期邻接。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 范围检查与文档

- Status: done
- Owner: coordinator
- Objective: 检验prefix/生命周期不回归，明确离线修复边界。
- Inputs and prerequisites: T-001完成。
- Scope or files: collaboration.md、本文件、根check产生的本任务格式化。
- Expected output: 检查证据与真实测试待复验说明。
- Dependencies: T-001.
- Execution steps:
  1. 运行必要离线邻接回归、根check，核对所有tracked/untracked文件哈希。
  2. 更新行为文档并校验authority，清理本任务脚本。
- Acceptance criteria:
  - 不改无关工作，不声称未重测的真实模型已通过。
- Verification method:
  - targeted vitest、npm run check、git diff --check、任务校验。
- Validation evidence: 根npm run check通过（Biome/依赖锁/imports/tsgo/browser smoke），即时1680文件哈希核对仅本任务3个代码/测试文件被格式化。02:18格式化后重跑coding-agent 3文件55项和subagent 3文件73项全部通过。对任务开始字节基线仅5个本任务文件变化（本authority、collaboration.md、host源码、host测试、delegation-contract测试）；真实验收旧authority、其他dirty/untracked工作保持不变。最终diff及任务结构校验通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

以faux捕获实际host provider context，检查初始/followup追加的完整schema与原validator一致；真实样本离线重放必须仍invalid，controller保存/返回原文，无自动推理repair。根check自动改写前后对比tracked/untracked哈希，冻结评测子树排除。真实模型输出遵循率不由该测试证明。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

完整schema增加每次任务提示大小，但避免手抄类型约束漂移；只放当前任务尾部，保留prefix。LLM仍可能违约，因此strict validation和not_reviewed不可移除。真实验收authority保留历史partial，不追溯改成passed。dist本轮不更新。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 用户授权修复，T-001开始。仅离线验证，无新真实预算或build授权。
- 2026-09-11 02:17: T-001完成，T-002开始。已更新collaboration.md的数组类型/边界/模型指导而非provider强制格式说明；下一步根check和范围核对。validator未修改，未把真实输出成功率列入离线通过结论。

- 2026-09-11 02:19: T-002完成，源码修复与离线验收结束。反例覆盖对象/null/数值/嵌套数组/blank、16项/2048字符/8192 UTF-8边界；源schema和validator逻辑未修改，prefix邻接通过。未增加新的LEARNS条目：本轮证明并修复提示缺少schema的程序性问题，不把尚未重测的真实遵循率写成已解决经验。初始/precheck哈希与baseline patch保留于/tmp，临时核对脚本清除。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 已证实的信息缺口回归先红后绿；最终6文件128项离线测试、根check、范围核对、diff/任务校验通过。该passed仅指源码提示契约修复和离线验收；此前真实验收仍为partial，未追溯改判。
- Limitations: 未真实重测；不保证模型100%格式遵循；未重建dist/重启用户会话，当前已安装产物尚不包含本修复。真实模型复验需新授权预算；不存在自动repair、schema放宽或输出强制转换。
