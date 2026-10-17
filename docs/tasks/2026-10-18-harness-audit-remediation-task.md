# Task Plan: Agent harness 全面审查与整改验证

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户授权全面审查、计划、直接实施及验证；不修改 pi/ 之外参考目录。

<!-- task-doc-section:background-goal -->
## Background and goal

基于实际调用链审查 harness 的设计和实现。本轮所有验证成立、收益合理的整改均进入本文件，实施和验证后才算完成。审查证据与覆盖表存于 `docs/reports/2026-10-18-harness-audit.md`；本文件是唯一任务状态源。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 目标为 pi/ 内实际存在的全部运行时模块、工具、扩展、UI、服务协议、存储及测试/交付边界。
- 不修改外部参考仓库，不推送/发布，不使用真实 provider API 或读取凭据；本地 faux/mock 与隔离测试可自主运行。
- 不承诺逐行审计每份生成物/第三方 vendor/示例；采用模块边界和关键生命周期覆盖，明确抽样与未运行环境。
- 不以风格偏好、未证明的性能推测或大规模拆分替代整改；不移除有意的能力。
- 初始工作树干净；若其他 session 后续产生改动，保留并隔离。本轮负责文件显式暂存提交。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前分支 my-pi，基线 f7606c3df，初始 git status 无输出 | 初始 git branch/log/status |
| F-002 | monorepo 具有 agent/ai/coding-agent/subagent 以及独立工具、协议、后端与 UI 包 | 根 package.json、源码清单 /tmp/pi-harness-audit-inventory.txt（1958 路径） |
| F-003 | Full Access 不是 OS sandbox；工具白名单只能收窄显式工具能力 | README.md 与当前执行契约 |
| F-004 | npm run check 包含自动格式写入；全套安全测试入口为 ./test.sh | package.json、test.sh、AGENTS.md、相关 LEARNS 条目 |
| F-005 | Node v24.15.0，node_modules 可用 | node --version 与目录检查 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 本地 mock/faux 回归与隔离非真实 provider 测试足以验证纯逻辑修复；真实网络/跨平台行为需单列限制。
- Open question: 当前没有阻碍开工的产品决策；若根因修复涉及权限扩大或不可推断的语义变化才暂停。
- 发现分为已证实缺陷、具体改进机会与待验证假设；后两者须有明确纳入/排除依据。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每个实际模块边界与用户指定审查轴都有证据、调用链、审查结论或明确限制。
- 每项发现记录位置、触发、影响、根因、修复方向及可信度；所有纳入项有独立任务与验收证据。
- 所有整改任务 done，修改的测试实际运行通过；统一静态检查与必要的集成验证通过或真实阻碍明确记录。
- 对性能收益不作未经测量的承诺；若实施性能优化，提供可复现前后数据。
- 报告、计划、diff 经过复查，未覆盖/未验证事项不冒充完成。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- 第一批：T-001 至 T-007 并行边界审查（初始只读 child 的工具仅 read）。
- 第二批：确认发现后追加整改任务；互不重叠文件可并行，依赖契约修改先行。
- 第三批：T-008 依赖全部审查和后续整改；由 coordinator 独占计划/报告、统一 check、提交。
- 当前工具提供单 child spawn，不提供 DAG start；使用有界独立 spawn，不模拟不存在的工具。
- 子任务不得修改权威文档、共享配置/lockfile、其他模块或提交；只读 child 不扩大工具权限；实现另建具备必要工具的有界 worker。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 架构、模块清单与调用链

- Status: done
- Owner: coordinator
- Objective: 建立无遗漏的边界覆盖表；审查包依赖、装配与测试隔离。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: 全部 workspace package manifest、CLI/SDK 入口、测试入口与发布脚本
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: root 完整读取 main.ts/sdk.ts、入口/extension 装配、package manifest、构建/打包与 CI；主报告覆盖 17 个包边界与双执行内核，未把历史 DAG 当作当前能力。离线重建成功，5 个旧 dist CLI 失败经重跑消除。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 执行循环、调度、取消与进程资源

- Status: done
- Owner: audit-runtime
- Objective: 追踪 run/turn/tool/abort 生命周期与后台进程，报告可证明的问题。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: packages/agent（除 session 持久化）、相关 coding-agent 工具适配
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 runtime.md；root 审阅 19 条因果链和明确排除项，转为 T-130–T-148 的重现/整改；不把静态发现计作验证通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 模型接入与流式传输

- Status: done
- Owner: audit-model
- Objective: 审查 provider 选择、流终止、重试、资源释放与凭据边界。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: packages/ai；coding-agent model-runtime/provider-composer/auth-storage
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 model.md；root 审阅 17 条发现及非共享 provider 审查深度限制，转为 T-060–T-076。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 工具权限、MCP、codemode 与公共网页

- Status: done
- Owner: audit-tools
- Objective: 审查授权与执行分离、输入输出边界、取消与资源上限。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: packages/permissions、mcp、codemode、pi-web-search；coding-agent tool discovery
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 tools.md；11 条候选转为 T-020–T-030，说明 Full Access/fake-IP 契约、未测资源量和具体反证条件。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 会话、上下文与多 agent 协作

- Status: done
- Owner: audit-session
- Objective: 追踪持久化、branch/fork、消息投递、并发取消及恢复。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: packages/subagent；coding-agent agent-session/session-manager/compaction
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 session.md；10 条候选转为 T-080–T-089，原生/历史 DAG 边界、恢复与 branch 调用链及验证限制均记录。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 扩展与用户交互

- Status: done
- Owner: audit-ui
- Objective: 审查扩展生命周期、模式桥接、用户取消/错误展示与终端边界。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: coding-agent extensions/resource-loader/modes；tui/grok-tui/grok-tui-compat
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 ui.md；15 条候选转为 T-040–T-054；loader/RPC/print/interactive/TUI/Grok/compat 均有覆盖或深度限制。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 服务协议、存储后端与可观测性

- Status: done
- Owner: audit-infra
- Objective: 审查连接与订阅释放、帧/存储错误、指标与测试可验证性。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；初始基线已确认。
- Scope or files: packages/client、server、protocol、telemetry、session-backends、agent/harness/session；evals
- Expected output: 覆盖路径/关键链、证据充分的发现、排除项与验证建议；由 coordinator 整合报告。
- Dependencies: None.
- Execution steps:
  1. 阅读模块与消费者，追踪正常/取消/错误/释放路径，挑战怀疑问题。
  2. 返回具体证据；根因修复另建任务，不直接扩散编辑。
- Acceptance criteria:
  - 覆盖该边界的核心状态转换；发现与假设分开，提供源码位置及可重复验收方法。
- Verification method:
  - coordinator 检查源文件、调用关系与证据；可执行怀疑进入根因重现。
- Validation evidence: 完整初审证据 infra.md；16 条发现包括独立确认的服务 cwd/watch 问题，其余转为 T-100/103–115；协议/存储/telemetry/evals 边界均记录。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 统一验证、对抗复查与交付

- Status: done
- Owner: coordinator
- Objective: 复核发现及排除理由；执行针对性与跨边界验证，记录残余风险并提交本轮文件。
- Inputs and prerequisites: AGENTS.md、源码清单、相关完整模块与文档；所有前置任务完成。
- Scope or files: 所有本轮 diff、审查报告与本计划
- Expected output: 验证记录、最终报告、可审查提交。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-009, T-010, T-011, T-020, T-021, T-022, T-023, T-024, T-025, T-026, T-027, T-028, T-029, T-030, T-040, T-041, T-042, T-043, T-044, T-045, T-046, T-047, T-048, T-049, T-050, T-051, T-052, T-053, T-054, T-060, T-061, T-062, T-063, T-064, T-065, T-066, T-067, T-068, T-069, T-070, T-071, T-072, T-073, T-074, T-075, T-076, T-080, T-081, T-082, T-083, T-084, T-085, T-086, T-087, T-088, T-089, T-100, T-103, T-104, T-105, T-106, T-107, T-108, T-109, T-110, T-111, T-112, T-113, T-114, T-115, T-130, T-131, T-132, T-133, T-134, T-135, T-136, T-137, T-138, T-139, T-140, T-141, T-142, T-143, T-144, T-145, T-146, T-147, T-148, T-150, T-151, T-152, T-160, T-153, T-154, T-155, T-156, T-161, T-162, T-163, T-164
- Execution steps:
  1. 检查 diff、重跑关键测试及 npm run check，必要时隔离全套测试。
  2. 核对覆盖/整改状态与限制，校验文档，显式暂存本轮文件提交。
- Acceptance criteria:
  - 所有纳入整改均验收；无未说明覆盖空白。
- Verification method:
  - 针对性测试、npm run check、隔离 ./test.sh（按风险）、diff 与文档校验。
- Validation evidence: root全仓check/tsc/browser-smoke、offline build、完整隔离./test.sh均已通过；严格空环境编译native/CLI/npm-pack验收通过，补充native233/权限18/desktop10通过。CI YAML/步骤/shell语法、206个本地链接、34个报告证据引用与31个计划报告引用、任务validator、git diff --check通过。203个明确拥有的代码/测试/包文档/CI路径已提交为bf3ab709bbc759f7134c5655997b11a154c448b1；提交后内容hash核对无漂移。当前clone未安装Git hook入口，未绕过检查，另显式运行sh .husky/pre-commit通过（/tmp/pi-harness-manual-hook.log，1608文件无改写）。审查/计划/学习记录随本文件独立归档；未推送/发布，远端CI未运行。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — CLI 非交互跨项目会话与产品能力文档

- Status: done
- Owner: coordinator
- Objective: 验证并修正非交互 --session 命中其他项目时进入确认提示的问题；纠正 README 对原生协作能力的矛盾说明。
- Inputs and prerequisites: main.ts 完整读取；README 与原生 extension 注册路径；T-001 审查证据。
- Scope or files: packages/coding-agent/src/main.ts、test/session-global-confirm.test.ts、README.md。
- Expected output: P2 取消不适用的交互提示，自动化失败可判定；P3 文档不再宣称没有原生子 agent。
- Dependencies: None.
- Execution steps:
  1. 使用隔离 CLI 子进程与伪造历史重现非交互误入确认。
  2. 最小模式门控；保留交互确认及显式 --fork/--session 路径语义；修正文档。
- Acceptance criteria:
  - print/json/rpc 或无 TTY 时不会读取确认输入、污染协议或无声成功；返回明确失败与继续方式。
  - 正常明确路径/显式 fork 行为不变；文档符合 createBuiltInExtensions。
- Verification method:
  - 新回归、已有 session-id-readonly/session-cwd 相关测试与 npm run check。
- Validation evidence: 新 CLI 回归原实现 6 fail/3 pass，修复后9/9；root 随 session-cwd/invalid/id/startup/stdout 共6文件19/19通过（task-5）。README 与 createBuiltInExtensions/原生协作契约核对。全仓集成门在T-008。
- Priority: P2（CLI），P3（文档）。
- Expected benefit: 防止自动化错耗 stdin/无任务成功退出；避免用户重复搭建已内置的协作能力。
- Compatibility risk: 仅非交互跨项目 ID 场景由不可用提示改为明确拒绝；需要显式 --fork 或路径。
- Blocker: None.
- Unblock condition: None.


### [x] T-010 — 释放服务快照临时 watch

- Status: done
- Owner: fix-service
- Objective: snapshot 为读取队列创建 watch 却不 unsubscribe，HarnessEventBus 保留闭包并累积后续事件。
- Inputs and prerequisites: root 已读完整 harness-service.ts、events.ts 与服务测试；T-007 审查提供交叉边界线索。
- Scope or files: packages/coding-agent/src/server/harness-service.ts:snapshot；test/harness-service.test.ts
- Expected output: 根因修复与离线回归测试。
- Dependencies: None.
- Execution steps:
  1. 先加入最小回归并观察原实现失败。
  2. 最小修复并验证正常、失败与重开边界。
- Acceptance criteria:
  - 每次快照后 watch 注册数回到基线；异常路径同样释放；100 次快照可重复验证资源数量。
- Verification method:
  - 指定 harness-service.test.ts 与 server/create-harness.test.ts；check/build 属于后续 T-008 集成门。
- Validation evidence: root 已检查完整 diff 并独立重跑两个文件，27/27 通过（task-6）；red 3 fail/24 pass，green 27 pass；100 次快照未释放 handle 从 100 降为 0；重开两工作目录相对读取均正确。/tmp/fix-service-red.log 与 /tmp/fix-service-green-final.log。
- Priority: P2.
- Expected benefit: 消除按快照数增长的监听器/事件缓存。
- Compatibility risk: 极低；只释放原本不使用的订阅。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 远程会话重开恢复持久化 cwd

- Status: done
- Owner: fix-service
- Objective: 创建会话保存 cwd，但 openSession 无条件采用 defaultCwd，导致恢复工具在另一目录执行。
- Inputs and prerequisites: root 已读完整 harness-service.ts、events.ts 与服务测试；T-007 审查提供交叉边界线索。
- Scope or files: packages/coding-agent/src/server/harness-service.ts:openSession；test/harness-service.test.ts
- Expected output: 根因修复与离线回归测试。
- Dependencies: None.
- Execution steps:
  1. 先加入最小回归并观察原实现失败。
  2. 最小修复并验证正常、失败与重开边界。
- Acceptance criteria:
  - 关闭后重开仍报告并用原 cwd 创建 ExecutionEnv；无 cwd 的历史记录继续走默认值。
- Verification method:
  - 指定 harness-service.test.ts 与 server/create-harness.test.ts；check/build 属于后续 T-008 集成门。
- Validation evidence: root 已检查完整 diff 并独立重跑两个文件，27/27 通过（task-6）；red 3 fail/24 pass，green 27 pass；100 次快照未释放 handle 从 100 降为 0；重开两工作目录相对读取均正确。/tmp/fix-service-red.log 与 /tmp/fix-service-green-final.log。
- Priority: P1.
- Expected benefit: 防止重启后读写错误工作目录。
- Compatibility risk: 低；恢复已保存契约，保留无元数据兼容回退。
- Blocker: None.
- Unblock condition: None.


### [x] T-020 — Bash cwd 与删除保护边界一致

- Status: done
- Owner: fix-review-boundaries
- Objective: 重现并修复 R-TOOLS-F01；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F01；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: permissions.ts、easy-pi.ts 与 permissions 回归。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F01 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-tool-boundaries.md、validation-review-boundaries.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 保护根不变，只修正执行 cwd 解析，避免误放行/误阻断。
- Blocker: None.
- Unblock condition: None.

### [x] T-021 — HTTP MCP 请求级取消

- Status: done
- Owner: fix-mcp
- Objective: 重现并修复 R-TOOLS-F02；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F02；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: mcp client、transport、streamable-http 与 HTTP tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F02 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-mcp.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 保留共享 transport；请求取消不得波及别的请求，已发出效果仍 unknown。
- Blocker: None.
- Unblock condition: None.

### [x] T-022 — OAuth token endpoint 禁止重定向

- Status: done
- Owner: fix-mcp
- Objective: 重现并修复 R-TOOLS-F03；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F03；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: mcp oauth/flow.ts 与 oauth tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F03 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-mcp.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 拒绝依赖 token 重定向的配置，避免验证边界外凭据转发。
- Blocker: None.
- Unblock condition: None.

### [x] T-023 — 桌面排队操作取消

- Status: done
- Owner: fix-tool-boundaries
- Objective: 重现并修复 R-TOOLS-F04；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F04；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: tools/agent-desktop-mcp/server.mjs 与 tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F04 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-tool-boundaries.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 未启动操作抑制，已启动中断不冒充无效果。
- Blocker: None.
- Unblock condition: None.

### [x] T-024 — MCP 桌面未知效果传播

- Status: done
- Owner: fix-tool-boundaries
- Objective: 重现并修复 R-TOOLS-F05；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F05；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: desktop server、coding-agent extensions/mcp/tools.ts 与回归。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F05 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-tool-boundaries.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 不降低普通确定错误语义，标记只能降低 certainty。
- Blocker: None.
- Unblock condition: None.

### [x] T-025 — MCP stdio 子进程组完整清理

- Status: done
- Owner: fix-mcp-review
- Objective: 重现并修复 R-TOOLS-F06；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F06；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: mcp transports/stdio.ts 与 fixtures/tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F06 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-mcp.md、validation-mcp-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 必须验证组归属，避免误杀重用 PID；Windows 限制单列。
- Blocker: None.
- Unblock condition: None.

### [x] T-026 — HTTP MCP 消费阶段字节上限

- Status: done
- Owner: fix-mcp-review
- Objective: 重现并修复 R-TOOLS-F07；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F07；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: mcp streamable-http.ts 与 tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F07 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-mcp.md、validation-mcp-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 过大 JSON/错误体明确失败；正常合法响应保持兼容。
- Blocker: None.
- Unblock condition: None.

### [x] T-027 — 网页快照逻辑会话/分支绑定

- Status: done
- Owner: fix-sandbox-web
- Objective: 重现并修复 R-TOOLS-F08；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F08；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: pi-web-search index/snapshot-store 与 contract tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F08 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-sandbox-web.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 不得按每次 leaf 变更误伤同一分支续读；先验证实际契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-028 — 网页快照空闲过期释放

- Status: done
- Owner: fix-sandbox-web
- Objective: 重现并修复 R-TOOLS-F09；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F09；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: pi-web-search snapshot-store 与 tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F09 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-sandbox-web.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: unref/lifecycle 计时器不得维持进程；保留 TTL 与池计量。
- Blocker: None.
- Unblock condition: None.

### [x] T-029 — codemode 删除写集有界

- Status: done
- Owner: fix-sandbox-web
- Objective: 重现并修复 R-TOOLS-F10；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F10；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: codemode runtime prelude/execution 与 tests。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F10 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-sandbox-web.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 正常小状态兼容；超限失败不提交写集。
- Blocker: None.
- Unblock condition: None.

### [x] T-030 — codemode 宿主调用记录有界

- Status: done
- Owner: fix-sandbox-web
- Objective: 重现并修复 R-TOOLS-F11；原始触发、根因与影响见 tools 初审证据。
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/tools.md 的 F11；当前源码与现有契约，不能仅凭子报告改动。
- Scope or files: codemode execution/types 与 coding-agent codemode execute/test。
- Expected output: 最小根因修复、相关文档与 red/green 回归；若证伪须记录反证而非强行修复。
- Dependencies: None.
- Execution steps:
  1. 完整读相关模块，运行可判定的故障重现。
  2. 修复、正常/异常/取消邻域测试并复查 diff；性能/资源项给出可复现计数或字节前后对比。
- Acceptance criteria:
  - 原始触发不再失败且正常行为保持；所有本任务修改测试通过，root 复查无未说明回归。
- Verification method:
  - 初审报告 F11 对应指定 tests；统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-sandbox-web.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 消除该条已证实触发后的错误/泄漏/无界资源行为；未能重现的条目只记录验证结论。
- Compatibility risk: 配额必须有代码与资源证据，文档明确限制；不得丢失 effect accounting。
- Blocker: None.
- Unblock condition: None.


### [x] T-040 — Escape terminal titles

- Status: done
- Owner: fix-ui-render
- Objective: 重现并修复 R-UI-F1：setTitle interpolates text into OSC 0; its caller passes cwd basename unchanged. A POSIX directory name containing BEL followed by another OSC terminates the title and injects a terminal command, without project extensions.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `T/src/terminal.ts::ProcessTerminal.setTitle`; `IM::updateTerminalTitle`
- Expected output: Strip title controls/delimiters. Extend `T/test/terminal.test.ts`: BEL, ESC-ST, OSC 52 and CR/LF cannot emit another command; Unicode survives.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F1 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-render.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Opening that directory can alter clipboard/title/terminal state on supporting terminals; no shell-execution claim.
- Compatibility risk: 仅标题去除控制字符，保留 Unicode；不改变宿主发出的合法 OSC title 框架。
- Blocker: None.
- Unblock condition: None.

### [x] T-041 — Sanitize untrusted transcript text

- Status: done
- Owner: fix-review-boundaries
- Objective: 重现并修复 R-UI-F2：Assistant text/thinking/errors and bash argument previews enter Markdown/Text unsanitized. Wrapping preserves escapes; final normalization removes only DEC private modes, retaining OSC 52 and cursor/erase controls. Grok delegates to this renderer.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `CA/src/modes/interactive/components/assistant-message.ts::updateContent`; `CA/src/core/tools/bash.ts::formatBashCall`; `T/src/utils.ts::normalizeTerminalOutput`
- Expected output: Sanitize untrusted inputs before host styling. Extend `test/assistant-message.test.ts`, `test/tool-execution-component.test.ts`, `T/test/terminal-output-safety.test.ts`: malicious controls absent from terminal writes; host styles/images/links preserved.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F2 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-render.md、validation-review-boundaries.md、validation-tool-name.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Model/provider text or arguments can overwrite clipboard or spoof the display. Ordinary tool-result text is already sanitized and is not this gap.
- Compatibility risk: 仅净化不可信内容；宿主 ANSI 样式、图像与合法链接不能被全局粗暴删除。
- Blocker: None.
- Unblock condition: None.

### [x] T-042 — Roll back failed factory registrations

- Status: done
- Owner: fix-review-boundaries
- Objective: 重现并修复 R-UI-F3：Failure rollback restores only MCP registrations. Provider queues, flag defaults and event-bus subscriptions survive a factory throwing. bindCore flushes that failed extension's provider; bus listeners remain; its flag default can win over a later valid factory.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `CA/src/core/extensions/loader.ts::runExtensionFactory/createExtensionRuntime/createExtensionAPI`
- Expected output: Undo factory-owned shared mutations/subscriptions. Extend `test/extensions-runner.test.ts`: failed provider/default/listener absent, previous successful state preserved, subsequent factory works. Keep MCP rollback coverage.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F3 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-render.md、validation-review-boundaries.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: An extension reported as unloaded still influences the session without normal lifecycle handlers.
- Compatibility risk: 只回滚失败工厂自己的注册，不能覆盖此前成功工厂状态。
- Blocker: None.
- Unblock condition: None.

### [x] T-043 — Catch synchronous shortcut exceptions

- Status: done
- Owner: fix-ui-interactive
- Objective: 重现并修复 R-UI-F4：`Promise.resolve(shortcut.handler(createContext())).catch(...)` invokes before Promise.resolve; synchronous throws escape through CustomEditor/TuiBase input dispatch.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `IM::setupExtensionShortcuts`
- Expected output: Guard invocation or invoke in `.then(...)`. New `test/interactive-extension-ui.test.ts`: sync throw and async rejection each display one error; further input works.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F4 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-interactive.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: uncaughtCrash exits the application and kills tracked children rather than reporting the intended shortcut error. Terminal restoration exists.
- Compatibility risk: 同步/异步错误统一报告，不改变正常 shortcut 返回时序。
- Blocker: None.
- Unblock condition: None.

### [x] T-044 — Settle displaced extension dialogs

- Status: done
- Owner: fix-modes-review
- Objective: 重现并修复 R-UI-F5：A second dialog overwrites shared fields/editor content without settling the first promise. disposeActiveSelector owns a separate built-in-selector token. Old timeout/abort callbacks hide the newer dialog; reset also hides without settling.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `IM::showExtensionSelector/showExtensionInput/showExtensionEditor/resetExtensionUI`
- Expected output: Serialize or explicitly cancel displaced dialogs; instance-bound cleanup and exactly-once settlement. `test/interactive-extension-ui.test.ts`: open A/B, abort/timeout A, reset; B is not accidentally hidden and no promise hangs.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F5 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-interactive.md、validation-modes-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Concurrent extension tools hang on invisible questions or dismiss unrelated questions.
- Compatibility risk: 重叠对话框必须明确取消/排队，旧取消不能关闭新窗口。
- Blocker: None.
- Unblock condition: None.

### [x] T-045 — Retain custom-overlay ownership

- Status: done
- Owner: fix-ui-interactive
- Objective: 重现并修复 R-UI-F6：custom() discards its specific handle; done() pops the global stack. Closing A after B opens removes B and disposes still-mounted A. Reset removes only one overlay. done-before-async-factory-resolution also abandons the returned component without disposal.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `IM::showExtensionCustom/resetExtensionUI`; `T/src/tui.ts::showOverlay/hideOverlay`
- Expected output: Keep each invocation's handle/settlement/disposal state; dispose late factory results and all owned UI on reset. `test/interactive-extension-ui.test.ts`: non-LIFO closure, two-overlay reset, early done, exactly-once disposal.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F6 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-interactive.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Wrong focus/dialog removal, mounted stale components and leaked component resources.
- Compatibility risk: 使用实例 overlay handle；关闭/重置幂等，late component 恰好 dispose 一次。
- Blocker: None.
- Unblock condition: None.

### [x] T-046 — Ignore stale clipboard completion

- Status: done
- Owner: fix-ui-interactive
- Objective: 重现并修复 R-UI-F7：After asynchronous clipboard retrieval, insertion targets the current this.editor without captured editor/draft/session generation. /new, submission or editor replacement during retrieval redirects the old paste. CustomEditor's file-image paste already has a generation guard.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `IM::handleClipboardPaste`
- Expected output: Guard completion by editor and draft/session generation. New `test/interactive-mode-clipboard.test.ts`: deferred retrieval followed by replacement/clear/submission must not insert; unchanged draft succeeds.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F7 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-interactive.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Unexpected images/text enter another prompt/session and may be transmitted unintentionally.
- Compatibility risk: 只有旧 draft/session 的异步完成被拒绝，正常剪贴板粘贴保留。
- Blocker: None.
- Unblock condition: None.

### [x] T-047 — Cache converted images by identity

- Status: done
- Owner: fix-ui-render
- Objective: 重现并修复 R-UI-F8：convertedImages is keyed only by index across updates. Partial JPEG A starts conversion; final PNG B replaces index 0; A's late completion caches A and updateDisplay renders it over B. Existing cache also prevents changed JPEG conversion.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `CA/src/modes/interactive/components/tool-execution.ts::updateResult/maybeConvertImagesForKitty/updateDisplay`
- Expected output: Bind cache/conversion to content identity/generation; ignore stale completion. Extend `test/tool-execution-component.test.ts`: deferred A conversion followed by PNG B and JPEG B, latest image wins.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F8 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-render.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Kitty displays obsolete rather than authoritative final imagery.
- Compatibility risk: 缓存以当前内容身份区分；必须保留正常 Kitty 转换与渲染。
- Blocker: None.
- Unblock condition: None.

### [x] T-048 — Install RPC plumbing before startup hooks

- Status: done
- Owner: fix-rpc
- Objective: 重现并修复 R-UI-F9：RPC awaits bindExtensions before installing JSONL reader/signals. bindExtensions awaits startup/discovery hooks: a startup UI dialog emits a request whose response cannot be read. RPC/print event/backpressure subscriptions also start after binding, although binding can execute task recovery.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `RPC::runRpcMode/rebindSession`; `CA/src/modes/print-mode.ts::rebindSession`; `CA/src/core/agent-session.ts::bindExtensions`
- Expected output: Install transport/signals/subscriptions first; allow UI responses/abort while gating ordinary commands until ready. New `test/rpc-mode-lifecycle.test.ts`: startup-confirm round trip and faux recovery event capture. Extend `test/print-mode.test.ts` for events emitted during binding.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F9 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-rpc.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Startup-dialog deadlock, lost startup/recovery events, unavailable RPC abort during startup recovery.
- Compatibility risk: startup UI response/abort 可及时处理，普通命令在 ready 前不得越过初始化。
- Blocker: None.
- Unblock condition: None.

### [x] T-049 — Remove duplicate RPC replacement binding

- Status: done
- Owner: fix-rpc
- Objective: 重现并修复 R-UI-F10：Replacement internally invokes the registered rebind callback, then RPC's command handler calls rebind again. Each bindExtensions emits session_start/resources_discover.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `RPC::handleCommand(new_session/switch_session/fork/clone)`; `CA/src/core/agent-session-runtime.ts::finishSessionReplacement`
- Expected output: Runtime callback is sole rebind owner. `test/rpc-mode-lifecycle.test.ts`: host invokes its registered callback; exactly one start/discover per successful replacement, none on cancellation.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F10 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-rpc.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Duplicate initialization side effects: watchers/processes/messages/dialogs. Replacing subscriptions cannot undo these.
- Compatibility risk: 仅移除重复 rebind，仍保留一次完整 session_start/discovery。
- Blocker: None.
- Unblock condition: None.

### [x] T-050 — Validate RPC envelopes

- Status: done
- Owner: fix-rpc
- Objective: 重现并修复 R-UI-F11：JSON null is cast to RpcCommand. handleCommand throws reading id; catch reads command.id/type again and throws outside error-response handling. JSONL callback ignores the rejected promise.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `RPC::handleInputLine`
- Expected output: Validate object/type metadata before dispatch and use validated metadata in catch. New `test/rpc-input-validation.test.ts`: null/scalars/arrays/malformed objects yield errors; next get_state succeeds; unknown-command ID preserved.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F11 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-rpc.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Malformed input causes unhandled rejection/process termination instead of a protocol error.
- Compatibility risk: 无效 JSON envelope 返回协议错误，未知 command 的合法 id 保留。
- Blocker: None.
- Unblock condition: None.

### [x] T-051 — Respect deferred RPC shutdown

- Status: done
- Owner: fix-modes-review
- Objective: 重现并修复 R-UI-F12：Shutdown checks only the flag after every command. A tool requests shutdown while active; get_state polling immediately disposes it. Fire-and-forget prompt dispatch can also reach the check before an extension command's acceptance response.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `RPC::checkShutdownRequested/handleInputLine/handleCommand(prompt)`
- Expected output: Require settlement and completed/flushed initiating response; external signals stay immediate. `test/rpc-mode-lifecycle.test.ts`: shutdown from blocked faux tool plus polling does not dispose until settled; shutdown command receives success before exit.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F12 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-rpc.md、validation-modes-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: ctx.shutdown interrupts active/queued work or exits before its response, contrary to documented deferral.
- Compatibility risk: 正常 shutdown 等待已接收工作和响应完成；外部 signal 仍即时取消。
- Blocker: None.
- Unblock condition: None.

### [x] T-052 — Reject errors in void RpcClient methods

- Status: done
- Owner: fix-rpc
- Objective: 重现并修复 R-UI-F13：send resolves every response; only getData checks success. Void methods discard success:false, including realistic missing-auth or streaming prompt rejection.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `CA/src/modes/rpc/rpc-client.ts::send/prompt/steer/followUp/setThinkingLevel/setSessionName`
- Expected output: Enforce success centrally/all public methods; cancel collector on prompt rejection. New `test/rpc-client-errors.test.ts`: fake-child failed prompt/steer/set_session_name/promptAndWait immediately reject with original error, no dangling timer.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F13 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-rpc.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: False success; promptAndWait can await nonexistent settlement and mask the server error.
- Compatibility risk: void RPC 调用失败现在正确 reject；兼容调用者需处理此前被吞的错误。
- Blocker: None.
- Unblock condition: None.

### [x] T-053 — Route shortcut shutdown through the bound handler

- Status: done
- Owner: fix-ui-interactive
- Objective: 重现并修复 R-UI-F14：Its manual ctx.shutdown only sets a flag, unlike the normal binding which immediately shuts down when idle. Next check is agent_settled.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `IM::setupExtensionShortcuts`
- Expected output: Reuse runner context/bound shutdown. `test/interactive-extension-ui.test.ts`: idle request initiates shutdown; active request defers until settled.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F14 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-interactive.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: Idle shutdown shortcut does nothing until a later run finishes.
- Compatibility risk: 使用当前绑定 shutdown 语义；运行中的请求仍延迟到 settle。
- Blocker: None.
- Unblock condition: None.

### [x] T-054 — Fix stale bash-renderer assertions

- Status: done
- Owner: fix-ui-render
- Objective: 重现并修复 R-UI-F15：Two baseline tests require Full output:, but renderer emits Output log: or Truncated output log: after removing provider footer. Persisted logs can be capped; old universal wording is misleading.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/ui.md；独立核对当前源码与契约。
- Scope or files: `CA/test/tool-execution-component.test.ts:239,309-312`; `CA/src/core/tools/bash.ts::rebuildBashResultRenderComponent`
- Expected output: Assert current label/path once, retain spacing/truncation checks, add capped-log wording case. Run this targeted test file.
- Dependencies: None.
- Execution steps:
  1. 先证明故障，再最小修复，检验正常/取消/失败邻域。
- Acceptance criteria:
  - 报告指定触发回归通过；所有修改测试通过且 root 复查 diff 与跨模块调用链。
- Verification method:
  - 原始报告 F15 指定的离线回归，统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ui-render.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: Two failing tests despite the current annotation being present.
- Compatibility risk: 保留路径、次数与间距断言，不能通过放松结构断言掩盖渲染缺陷。
- Blocker: None.
- Unblock condition: None.


### [x] T-060 — Scope socket reuse by endpoint/auth

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-1。Cache identity is sessionId/accountId only. Changing URL/token/tenant headers reuses the prior authenticated socket; handshake configuration is unchecked.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 1 项，当前源码/消费者与真实产品契约。
- Scope or files: Codex `acquireWebSocket`.
- Expected output: Include endpoint/handshake/proxy identity; reset continuation on changes. Test same-session/account endpoint/header changes create new connections.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: New conversation data can reach the previous endpoint; new auth settings are ignored.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-061 — Remove token bodies from errors

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-2。Missing Codex fields serialize token JSON; malformed Anthropic JSON includes raw response. These messages propagate into lazy assistant errors.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 2 项，当前源码/消费者与真实产品契约。
- Scope or files: OAuthC `readTokenResponse`; OAuthA token parsing; A`auth/resolve.ts#withCauseDetail`.
- Expected output: Allowlist status/field diagnostics, never token bodies. Test synthetic secrets in incomplete/truncated responses remain absent from errors and Models results.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Partial responses containing tokens expose secrets through ordinary error reporting.
- Compatibility risk: 认证失败必须显式，不泄露凭据，不误覆盖可用 token；正常认证/取消遵守已有契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-062 — Fail closed on unresolved stored key expressions

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-3。Missing env references/failed commands become key:undefined, then standard providers use ambient keys. Explicit resolution failure resembles absent configuration.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 3 项，当前源码/消费者与真实产品契约。
- Scope or files: C`auth-storage.ts#read`, `resolve-config-value.ts`; A`auth/helpers.ts#envApiKeyAuth`.
- Expected output: Reject unresolved defined expressions; preserve intentionally key-absent ambient credentials. Test broken stored expression plus ambient key cannot dispatch.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Silent account/billing identity change.
- Compatibility risk: 认证失败必须显式，不泄露凭据，不误覆盖可用 token；正常认证/取消遵守已有契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-063 — Honor explicit tokens for OAuth-only providers

- Status: done
- Owner: fix-model-review
- Objective: 验证并修复 R-MODEL-4。Explicit apiKey works only when provider.auth.apiKey exists. OAuth-only Codex still requires/refreshes stored OAuth.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 4 项，当前源码/消费者与真实产品契约。
- Scope or files: A`auth/resolve.ts#resolveProviderAuthWithSignal`, `providers/openai-codex.ts`.
- Expected output: Decouple request override from login methods. Test explicit token with absent/expired stored OAuth dispatches without refreshing it.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md、validation-provider-headers.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Documented request override fails through Models/ModelRuntime.
- Compatibility risk: 认证失败必须显式，不泄露凭据，不误覆盖可用 token；正常认证/取消遵守已有契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-064 — Make lazy setup cancellation-aware

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-5。Setup aborts are encoded as error. Async transformHeaders is not raced with cancellation; abort is checked only afterward.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 5 项，当前源码/消费者与真实产品契约。
- Scope or files: A`api/lazy.ts#lazyStream`, `models.ts#applyAuth`; C`model-runtime.ts#prepareRequest`.
- Expected output: Signal-aware setup racing/classification with no late dispatch. Test pre-abort, auth-wait abort and pending-transform abort: exactly one aborted terminal result.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Misclassified cancellation or stalled request.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-065 — Do not resurrect transformed-away headers

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-6。Chat passes transformed options.headers plus original model.headers, which adapters remerge. Filtered transform results/{} cannot remove defaults.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 6 项，当前源码/消费者与真实产品契约。
- Scope or files: A`models.ts#applyAuth`; C`model-runtime.ts#prepareRequest`; A`api/openai-responses.ts#createClient`.
- Expected output: Strip raw defaults after assembly, as image dispatch does. Fetch-level test must prove removed headers stay absent and transform runs once.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Host-excluded sensitive headers still reach endpoints.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-066 — Honor case-insensitive Google header deletion

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-7。Model X-Tenant plus request x-tenant:null creates two keys; null filtering retains X-Tenant because deletion is case-sensitive.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 7 项，当前源码/消费者与真实产品契约。
- Scope or files: A`api/google-generative-ai.ts#createClient`, `utils/headers.ts#providerHeadersToRecord`.
- Expected output: Merge/delete case-insensitively before SDK conversion. Mock Google client; assert no tenant header after case-variant null override.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Explicit suppression fails, including direct adapter calls.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-067 — Keep direct streamSimple failures in the protocol

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-8。Auth/preparation throws before returning a stream; only the inner producer is protected, contrary to StreamFunction's contract.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 8 项，当前源码/消费者与真实产品契约。
- Scope or files: `streamSimple` in Anthropic, Codex, Mistral and A`api/{openai-completions,openai-responses,google-generative-ai}.ts`.
- Expected output: Protect preflight/conversion. Test missing auth/invalid preparation returns a stream, one terminal error, no network.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Direct consumers fail before obtaining events/result().
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-068 — Detach Codex's header-only deadline

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-9。timeoutMs without caller signal returns the timeout signal directly; cleanup is a no-op, leaving body consumption deadline-bound.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 9 项，当前源码/消费者与真实产品契约。
- Scope or files: Codex SSE fetch; A`utils/abort-signals.ts#combineAbortSignals`.
- Expected output: Separate request/deadline lifetimes. Test signal-bound fetch with active body beyond timeoutMs and no caller signal succeeds.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Healthy long responses terminate at the header deadline.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-069 — Keep error-body reads cancellable

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-10。Composite signal listeners detach after headers. Success parsers replace cancellation, non-2xx response.text does not. Codex manifestation requires timeoutMs plus caller signal; Mistral always composites.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 10 项，当前源码/消费者与真实产品契约。
- Scope or files: Mistral `requestMistralStream`; Codex SSE response.text.
- Expected output: Retain caller cancellation through diagnostic reads; cancel/bound bodies. Test unfinished 401/503 bodies settle and cancel on abort.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Stalled error bodies block cancellation/completion.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-070 — Do not retry terminal HTTP/hook errors

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-11。Non-retryable HTTP errors enter a broad catch that retries almost every Error. With maxRetries>0, 400/401/403 retry; onResponse exceptions can repeat accepted POSTs.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 11 项，当前源码/消费者与真实产品契约。
- Scope or files: Codex SSE retry catch.
- Expected output: Separate transport retries from HTTP/callback failures. Test terminal status and throwing onResponse call counts; preserve 429/503 retries.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Needless backoff and potentially duplicated model work.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-071 — Parse SSE newline state across chunks

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-12。Codex supports LF/LF only, so CRLF frames stall/combine at EOF. Anthropic immediately consumes trailing CR; next-chunk LF becomes a false blank line.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 12 项，当前源码/消费者与真实产品契约。
- Scope or files: Codex `parseSSE`; Anthropic `consumeLine/iterateSseMessages`.
- Expected output: Stateful LF/CRLF/CR handling. Add CRLF/bytewise regressions, preserving EOF behavior; Mistral has a useful fixture.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Valid SSE fails depending on chunking/line endings.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-072 — Cancel bodies on early logical exits

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-13。PiMsg terminal return/Anthropic parser errors release locks without cancelling. Throwing onResponse before iteration leaves bodies unconsumed. Ownership misses early exits.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 13 项，当前源码/消费者与真实产品契约。
- Scope or files: PiMsg `readPiMessagesEvents`; Anthropic `iterateSseMessages`; inspected HTTP onResponse boundaries.
- Expected output: Cleanup hooks/early return using reader cancel or SDK abort. Test cancel spies for open terminal body, Anthropic error frame and throwing onResponse.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Resources outlive requests; repeated failures retain outstanding work.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-073 — Retain pi-messages partial output on local failure

- Status: done
- Owner: fix-ai-transports
- Objective: 验证并修复 R-MODEL-14。Converter accumulates output, but catch creates an empty message on EOF, parse failure or abort; success/error state is separate.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 14 项，当前源码/消费者与真实产品契约。
- Scope or files: PiMsg `createEventConverter/createErrorEvent/stream`.
- Expected output: Finalize accumulated state. Test EOF retains 'partial', plus abort-after-delta and malformed-later-frame cases.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-ai-transports.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: result() loses already emitted content.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-074 — Apply modelOverrides headers last

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-15。Definition/extension headers overwrite modelOverrides, reversing documented precedence and other metadata behavior.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 15 项，当前源码/消费者与真实产品契约。
- Scope or files: C`provider-composer.ts#rawModelHeaders`.
- Expected output: Apply overrides last case-insensitively. Test conflicting definition/extension/override values through getAuth(model) and dispatch.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Final user tenant/auth header corrections are ignored.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-075 — Validate Anthropic token shape before persistence

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-16。JSON is only cast. A 200 object missing fields yields undefined tokens/NaN expiry and overwrites the old credential.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 16 项，当前源码/消费者与真实产品契约。
- Scope or files: OAuthA token parsing; A`auth/resolve.ts#refreshStoredOAuthCredential`.
- Expected output: Validate token strings/finite expiry without dumping data. Mock incomplete/wrong-type 200 responses and assert Models preserves previous credentials.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Malformed upstream success destroys usable auth, forcing re-login.
- Compatibility risk: 认证失败必须显式，不泄露凭据，不误覆盖可用 token；正常认证/取消遵守已有契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-076 — Link OAuth operation/manual-prompt cancellation

- Status: done
- Owner: fix-model-auth
- Objective: 验证并修复 R-MODEL-17。Operation abort cancels server.waitForCode, then awaits manualPromise. Its separate signal is aborted only in finally after that await.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/model.md 第 17 项，当前源码/消费者与真实产品契约。
- Scope or files: OAuthA `loginAnthropic`; OAuthC `loginOpenAICodex`.
- Expected output: Link signals/check abort before waiting again. Mock server/prompt; assert cancellation, close, settlement and no exchange.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-model-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Signal-respecting prompts remain pending; callback server can survive outward login cancellation.
- Compatibility risk: 认证失败必须显式，不泄露凭据，不误覆盖可用 token；正常认证/取消遵守已有契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-080 — Cold child loading can execute an old task

- Status: done
- Owner: fix-session-execution
- Objective: 验证并修复 R-SESSION-1。Host creation calls bindExtensions before installing its stream guard or returning to the controller. Binding automatically resumes a running TaskRecoveryJournal. After a crash, team recovery updates SQLite status but leaves the child's JSONL running intent intact. An explicit cold followup can therefore resume the old task during host.create(), before controller.start() runs the new assignment. Root cause: generic recovery ignores host admission ownership.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 1 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/extensions/pi-child-session-host.ts:create()`; `src/core/agent-session.ts:bindExtensions()`.
- Expected output: Explicitly suppress automatic recovery in controller-owned child loading, preserving historical facts. Gate all execution on an admitted child turn. Extend `test/pi-child-session-host.test.ts`: reopen a child with a running journal and undispatched tool; require zero calls until run; recovered-controller followup must execute only the new task. Test cancellation during binding.
- Dependencies: T-156
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-host-admission.md、validation-session-edge-review.md、validation-journal-admission.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Old inference/tools run outside the new assignment and its result/usage capture. Startup cancellation is only checked around binding. Violates session-host.ts's creation/loading-never-starts-a-turn contract.
- Compatibility risk: 恢复权限更严格；保留历史，普通 root 明确恢复语义不变。
- Blocker: None.
- Unblock condition: None.

### [x] T-081 — Fork-before-user resumes the prompt intended for editing

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-2。Intent is persisted before its user message. Fork cuts at that user's parent and copies recovery entries verbatim, including the running intent containing the selected prompt. Binding the new runtime automatically resumes it. Root cause: copied recovery metadata is treated as executable authority for a new identity.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 2 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session-runtime.ts:fork()`; `session-manager.ts:createBranchedSession()`; `task-recovery.ts:start()`; `agent-session.ts:bindExtensions()`.
- Expected output: Make inherited recovery state/queues historical, not automatically executable, including after reopen; retain audit history. In `test/suite/agent-session-runtime.test.ts`, cover fork-before-first/middle user, persistent/in-memory, bind and reopen: zero new calls, selected input absent, work waits for explicit submission. Share finding 1's policy seam but fix durable identity too.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Merely forking can send the old request and execute tools before submission of the edited prompt.
- Compatibility risk: 恢复权限更严格；保留历史，普通 root 明确恢复语义不变。
- Blocker: None.
- Unblock condition: None.

### [x] T-082 — Import overwrites colliding history before validation

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-3。copyFileSync targets currentSessionDir/basename(input) without collision protection, then validates the session/cwd. A malformed external import can overwrite an unrelated retained session before being rejected. Root cause: destructive publication precedes validation and exclusive destination selection.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 3 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session-runtime.ts:importFromJsonl()`.
- Expected output: Validate first, then exclusively publish to a unique destination or reject collision unchanged. Extend `test/suite/agent-session-runtime.test.ts` with valid/malformed collisions, including the active session; assert original bytes/runtime are preserved.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: History loss; an active-file collision also leaves its manager stale.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-083 — Native task locks break budgeted parallel admission

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-4。Running tasks create <session>.jsonl.task.lock and a temporary .task.lock.claim. Scanner accepts only exact child JSONL and .logs directories, so legitimate locks become Unknown child entry/incomplete inventory. Positive maxTeamBytes/maxTotalBytes then reject another spawn/followup regardless of free bytes. Root cause: storage vocabulary omits recovery-owned files.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 4 项，当前源码/消费者与真实产品契约。
- Scope or files: `packages/subagent/src/collaboration-storage.ts:scan()/checkCollaborationStorageAdmission()`; `src/core/task-recovery.ts:acquire()`.
- Expected output: Validate/count known lock formats, distinguish ownership protection from incomplete measurement, retain fail-closed handling of uncertain claims. Extend `test/pi-collaboration-storage.test.ts` with actual native host, generous budget, blocked running child and successful second admission; add live/dead/invalid lock cases in `packages/subagent/test/collaboration-storage.test.ts`.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Supported byte budgets block normal parallel work; crash-left locks also obstruct inspection/manual deletion.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-084 — abort() leaves automatic compaction running

- Status: done
- Owner: fix-session-execution
- Objective: 验证并修复 R-SESSION-5。Compaction uses an independent AbortController. session.abort cancels retry and Agent, then awaits idle without aborting compaction. Child disposal awaits that abort before reaching shutdown's compaction cancellation. Root cause: cancellation ownership does not cover the awaited summary request.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 5 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session.ts:abort()/_runAutoCompaction()/_tryHfAutoCompaction()`; `src/extensions/pi-child-session-host.ts:abort()/dispose()`.
- Expected output: Propagate run cancellation into automatic compaction before awaiting idle. In `test/suite/agent-session-compaction.test.ts`, block the summary on its AbortSignal, abort, and assert cancellation, settlement, no checkpoint/continuation. Add child coverage in `test/pi-child-session-lifecycle.test.ts`.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-execution.md、validation-session-edge-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Interrupt/shutdown waits for summarization/provider timeout even when the summary provider cooperates with cancellation.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-085 — Compaction skips cancellation hooks for short/checkpoint history

- Status: done
- Owner: fix-session-execution + fix-compaction-contract
- Objective: 验证并修复 R-SESSION-6。session_before_compact only fires when legacy preparation exists. Short nonempty history below keepRecentTokens or a checkpoint with little raw tail returns undefined; modern HfCompactionHost nevertheless calls the model and may publish. Root cause: modern cancellation is conditional on obsolete cut eligibility.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 6 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session.ts:compact()/_runAutoCompaction()`; `src/core/compaction/compaction.ts:prepareCompaction()`.
- Expected output: Emit the hook for every eligible modern attempt, using effective-history preparation or an optional legacy field. Add short-history/default-keepRecentTokens and checkpoint-only cancellation tests to `test/suite/agent-session-compaction.test.ts`; assert no model call/publication. Existing extension tests set keepRecentTokens=1.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-execution.md、validation-compaction-contract.md、validation-compaction-tests.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Extensions cannot observe/cancel those compactions despite the documented boundary.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-086 — Modern compaction usage disappears from session totals

- Status: done
- Owner: fix-session-execution
- Objective: 验证并修复 R-SESSION-7。Full Usage is reduced to input/output; candidate carries reduced modelUsage; checkpoint publication omits its supported usage argument. Stats counts entry.usage, not diagnostic custom entries. Root cause: producer-to-accounting integration lost full usage.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 7 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session.ts:_publishCompactionCheckpoint()/getSessionStats()`; `src/core/compaction/subsystem/session-integration.ts:createPiAiCompleteFn()/CheckpointCandidate`.
- Expected output: Preserve/account full Usage exactly once across summary/retry/overflow attempts. Extend `test/agent-session-stats.test.ts` with actual faux-stream manual/automatic compaction, known nonzero cache/cost, live/reopen totals and retries. Current test injects a legacy compaction directly.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: root 检查完整 usage 聚合/调用 diff；独立 task-11 四个文件测试通过。实际流单次/重试/overflow/组合八例持久化一次并可 reopen；失败/取消无 checkpoint 消费另列 T-154，未计入本项完成。
- Priority: P2.
- Expected benefit: Modern summary token/cache/cost usage is absent from totals; no price/cache-benefit claim.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-087 — forkFrom stamps v3 onto unmigrated entries

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-8。forkFrom reads raw entries, replaces the header with CURRENT_SESSION_VERSION, writes, then opens. Constructor skips migration under the new header. V1 IDs/parent links remain missing; V2 hookMessage conversion is skipped. Root cause: version changed before migration.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 8 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/session-manager.ts:forkFrom()/loadEntriesFromFile()/migrateToCurrentVersion()`.
- Expected output: Migrate detached entries using their original header before replacement; preserve source bytes. Extend `test/session-manager/migration.test.ts` with v1/v2 forkFrom fixtures, context and reopen assertions.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Forking supported legacy history loses active context or retains incompatible roles.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-088 — Cyclic parent links hang context construction

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-9。Loaded graph receives no cycle validation; walkers lack a visited guard. Valid JSONL with parentId=self (or a two-node cycle) is accepted by open and loops synchronously during SDK context construction.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 9 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/session-manager.ts:_buildIndex()/buildSessionPath()/getBranch()`.
- Expected output: Validate graph identity/cycles before publishing loaded state, or guard both walkers. Preserve source bytes. Add subprocess-timeout cases to `test/session-file-invalid.test.ts` and traversal tests; avoid running the known loop inline in Vitest.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Malformed imported/hand-edited history hangs instead of failing safely. No claim that ordinary writers generate cycles or remote exploitation exists.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-089 — Resume bypasses model-bound cache validation

- Status: done
- Owner: fix-session-history
- Objective: 验证并修复 R-SESSION-10。switchSession resolves a hint without a model, accepting any boundModel. CLI prefers that ID over model-filtered fallback; SDK applies it after model selection without checking binding. A clone switched to a new model drops live affinity, but reopening restores the old hint and may force Codex SSE. Root cause: binding metadata is discarded before final model resolution.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/session.md 第 10 项，当前源码/消费者与真实产品契约。
- Scope or files: `src/core/agent-session-runtime.ts:switchSession()`; `session-cache-affinity.ts:recordedCacheAffinityId()/forModel()`; `sdk.ts` affinity application; `src/main.ts` factory excerpt 600–999.
- Expected output: Validate hints against the final selected model at one authoritative boundary. Extend `test/session-cache-affinity.test.ts` with runtime switchSession after model change; its similarly named existing test only checks the helper.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-history.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: Wrong routing metadata and transport policy; cache rate/cost/latency unmeasured.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-100 — Retain ownership after failed disposal

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-1。finally releases the writer/unregisters the runtime even when harness.close rejects because a physical timed-out tool remains unsettled. AgentHarness.close explicitly intends to retain ownership on this failure; maybeDispose also deletes failed runtimes.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 1 项，当前源码/消费者与真实产品契约。
- Scope or files: coding-agent/src/server/harness-service.ts, HarnessSessionRuntime.dispose; server/src/sessions.ts, maybeDispose.
- Expected output: retain ownership and retryable failed-disposal state until successful close. Test blocked replay-never tool → timeout → failed dispose → second owner rejected → tool settles → retry close → reopen succeeds.
- Dependencies: T-010, T-011
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: root 已复查 service/manager 完整 diff 并独立执行 harness-service/create-harness 28/28、server 七文件69/69（task-10）；真实受控未停工具拒绝第二 writer，settle 后 dispose/reopen 恢复。首次 red 见 validation-service 回执；顶层关闭缓存另列 T-151。
- Priority: P1.
- Expected benefit: a replacement runtime can acquire the session while the old effect still runs, without the old unsettled-tools guard.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-103 — Recheck connection generation per decoded frame

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-4。ID is checked before decoding, not between messages. A listener reconnecting on the first coalesced frame lets the second old frame reach the new lifecycle.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 4 项，当前源码/消费者与真实产品契约。
- Scope or files: client/src/connection.ts, #handleData.
- Expected output: check #isCurrent(id) before each message. Regression in connection.test.ts: two frames together, reconnect from first callback; new handshake succeeds, old second frame ignored.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-service.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: old data can fail the new handshake or affect new connection state.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-104 — Validate response session identity

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-5。matching request ID/command is accepted even if returned session.id/detach.sessionId differs from requested sessionId.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 5 项，当前源码/消费者与真实产品契约。
- Scope or files: client/src/client.ts, #handleMessage.
- Expected output: reject mismatches before applyResult. requests.test.ts: attach A returns B; detach A returns B; B state must not change and connection fails.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-service.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: malformed peer responses mutate the wrong attachment or resolve an unattached handle.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-105 — Drain admitted Unix writes on graceful close

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-6。close sets closing before awaiting writeTail, while write rejects when closing. Queued, already-admitted sends are discarded.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 6 项，当前源码/消费者与真实产品契约。
- Scope or files: server/src/transports/unix/listener.ts, UnixByteConnection.close/write.
- Expected output: reject new sends but drain accepted jobs until closed/timeout. unix-connection.test.ts: block first write, enqueue second, close(finalFrame), release; both sends resolve and precede finalFrame.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-service.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: preceding responses/events can be lost before finalChunk.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-106 — Preserve reserved JSON keys in adapters

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-7。assigning an own JSON '__proto__' key into {} invokes the inherited setter instead of creating a property.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 7 项，当前源码/消费者与真实产品契约。
- Scope or files: server/src/protocol.ts, toProtocolJsonValue/sanitizeProtocolDetails.
- Expected output: define own properties, as CBOR decoder already does. protocol.test.ts: scalar/null/object '__proto__' values survive adapter plus wire roundtrip without changing Object.prototype.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-service.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: arguments/details lose data; object values change the prototype and fail wire validation, closing snapshot connections.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-107 — Capture durable inputs before asynchronous queues

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-8。Session validates a reference, then JSONL clones/SQLite reads it in a later queued microtask. Caller mutation bypasses validation.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 8 项，当前源码/消费者与真实产品契约。
- Scope or files: agent/src/harness/session/session.ts, commitEntry/commitRecord; JSONL and SQLite append methods.
- Expected output: synchronously validate/detach before queue admission. Shared conformance: mutate nested entry/record input before awaiting; accepted original and reopened data must match, including undefined/NaN attempts.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: appendCustomEntry with {value:1}, immediately changed to undefined, acknowledges in-memory data whose property disappears on serialization/reopen; effective tool arguments share this boundary.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-108 — Evict released JSONL storages

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-9。release never removes registered storage; only delete/same-path replacement does.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 9 项，当前源码/消费者与真实产品契约。
- Scope or files: agent/src/harness/session/jsonl/repo.ts, activeStorages; storage.ts, release.
- Expected output: release callback conditionally removes that exact instance. Test distinct create/open/release cycles leave no released registrations while active-source fork/reopen still work.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: long-lived repositories retain entire logs of every previously opened session after writer release/server detach.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-109 — Reject newline-terminated corruption

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-10。syntax-invalid last lines are repaired even when newline-terminated.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 10 项，当前源码/消费者与真实产品契约。
- Scope or files: agent/src/harness/session/jsonl/storage.ts, loadOwned/isTornTail.
- Expected output: repair only unterminated final lines. jsonl.test.ts: valid prefix + 'not-json\n' fails unchanged; existing unterminated-fragment repair still succeeds.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: damaged completed records are silently erased on open.
- Compatibility risk: 损坏记录将明确失败而不再静默接受/擦除；有效历史不迁移不改写。
- Blocker: None.
- Unblock condition: None.

### [x] T-110 — Validate durable decoded payloads

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-11。envelope checks precede unchecked casts. JSONL compaction retainedTail:null is accepted. SQLite record payload 'null' spreads into only seq/timestamp despite indexed record identity.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 11 项，当前源码/消费者与真实产品契约。
- Scope or files: agent/src/harness/session/jsonl/codec.ts, mutation parsers; session-backends/sqlite-node/src/sqlite/repo.ts, decoders.
- Expected output: validate required discriminated fields and SQL indexed/payload identity; keep custom data opaque. Tests: malformed built-ins at all line positions; SQL null/array and mismatched id/type/lane; original data unchanged.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: syntactically valid corruption reaches recovery/context or becomes silently unrecognizable.
- Compatibility risk: 损坏记录将明确失败而不再静默接受/擦除；有效历史不迁移不改写。
- Blocker: None.
- Unblock condition: None.

### [x] T-111 — Snapshot SQLite fork source transactionally

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-12。source entries/lanes/tips/facts are read before db.transaction; another owning connection can commit between SELECTs.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 12 项，当前源码/消费者与真实产品契约。
- Scope or files: session-backends/sqlite-node/src/sqlite/repo.ts, fork.
- Expected output: one BEGIN IMMEDIATE encompassing source reads/publication, or equivalent snapshot. Test two connections interleaving append/move/label at read boundaries; all fork references resolve to one source snapshot.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: new tips may be absent from copied entries, failing fork; tree labels may reference uncopied entries or an incoherent snapshot.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-112 — Recheck migrations under the write transaction

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-13。applied IDs are read before transaction acquisition. Concurrent initializers both see absence; second later fails unique migrations.id insertion.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 13 项，当前源码/消费者与真实产品契约。
- Scope or files: session-backends/sqlite-node/src/sqlite/migrations.ts, applyMigrations.
- Expected output: recheck inside transaction before DDL/INSERT. migrations.test.ts: two connections synchronized after old-set reads; both calls succeed with one application.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: concurrent repository/search startup fails; rejected databasePromise remains cached until close.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-113 — Seal SQLite repository admission on close

- Status: done
- Owner: fix-durable-storage-review
- Objective: 验证并修复 R-INFRA-14。close drains a captured tail without a closing flag/shared close promise. Immediately subsequent create can open after close resolves or race existing disposal.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 14 项，当前源码/消费者与真实产品契约。
- Scope or files: session-backends/sqlite-node/src/sqlite/repo.ts, close/getDatabase/public operations.
- Expected output: seal synchronously, memoize close, drain admitted work. Test delayed sqlite.open, close/create orderings, concurrent closes; no resources survive resolved close.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md、validation-durable-storage-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: connections/leases/heartbeats can survive resolved disposal, or operations encounter closed handles.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.

### [x] T-114 — Roll back lease on metadata decode failure

- Status: done
- Owner: fix-storage
- Objective: 验证并修复 R-INFRA-15。lease transaction commits before decodeSessionMetadata; malformed metadata/name throws before storage registration/release callback exists.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 15 项，当前源码/消费者与真实产品契约。
- Scope or files: session-backends/sqlite-node/src/sqlite/repo.ts, claimStorage.
- Expected output: decode inside acquisition transaction or release on post-commit failure. Test corrupt metadata/name after releasing original owner; failed open leaves no lease, immediate repaired reopen succeeds.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-storage.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: failed open leaves an untracked writer claim, locking even repaired data until expiry; repository.close cannot release it.
- Compatibility risk: 损坏记录将明确失败而不再静默接受/擦除；有效历史不迁移不改写。
- Blocker: None.
- Unblock condition: None.

### [x] T-115 — Preserve reserved telemetry attribute names

- Status: done
- Owner: fix-service
- Objective: 验证并修复 R-INFRA-16。{} assignment drops own '__proto__' scalars or changes prototype for arrays; later copies lose them.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/infra.md 第 16 项，当前源码/消费者与真实产品契约。
- Scope or files: telemetry/src/memory.ts, copyAttributes/mergeAttributes.
- Expected output: safe own-property copying. Conformance tests for start/set/event '__proto__' attributes and detached snapshots.
- Dependencies: None.
- Execution steps:
  1. 最小离线回归证明因果；无法成立则记录反证，不进行无收益修改。
  2. 根因修复，运行新/修改测试与邻域集成检查，保留前后证据。
- Acceptance criteria:
  - 初审指定触发、正常与取消/失败边界均有可复核验收；root 对 diff 和测试独立复查。
- Verification method:
  - 初审报告本条指定回归；性能资源项记录前后资源数/字节；最终统一 check/offline build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-service.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: reference adapter loses valid open-bag diagnostics.
- Compatibility risk: 修正此触发条件的行为；不改变未触发路径、公共能力或未测量的性能契约。
- Blocker: None.
- Unblock condition: None.


### [x] T-130 — Background launch ignores cancellation

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-1：Abort during prepare/cwd/stat/shell awaits does not prevent spawn; background start receives no signal.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F01；完整当前源码与消费者。
- Scope or files: H/tools/bash.ts:execute; H/env/background-task-manager.ts:start; background-task-types.ts:start.
- Expected output: Thread an admission signal and recheck immediately before spawn; retain independence after adoption. Test G1.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Cancelled calls launch persistent side-effecting processes.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-131 — Concurrent durable admission

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-2：Busy checks precede awaited getEntry/reduceCurrent with no reservation/recheck. Navigation/prompt or two resumes can both pass.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F02；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:navigateTree,resume.
- Expected output: Reserve ownership synchronously through preparation. Test H1.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Duplicate execution/multiple operations; reducer rejects the resulting log.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-132 — Pause loses operation ownership

- Status: done
- Owner: fix-durable-storage-review
- Objective: 验证并修复 R-RUNTIME-3：Pause clears activeOperation although the durable operation remains open.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F03；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:drive(op.pausing),prompt,abort.
- Expected output: Retain operation ownership separately from driver activity. Test H2.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md、validation-durable-storage-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: New prompt creates a second operation; abort incorrectly reports NoActiveOperation.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-133 — Queue admission after abort/finish

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-4：enqueue checks only activeOperation.kind before awaiting. With a pending provider, await abort(); await steer() still appends after cancellation.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F04；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:enqueue,abort,finishRun.
- Expected output: Serialize enqueue with abort/finish and recheck state at admission. Test H3.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Accepted input creates queue_after_abort; a finish race creates record_after_finish corruption.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-134 — Cancelled queue items are still consumed

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-5：Cancellation can win after item capture; consumption checks entry existence but not cancellation. nextRun application bypasses the queue lock.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F05；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:drainQueued,prompt initialMessages,drive missingInitialMessages.
- Expected output: Revalidate pending state under serialized consumption/acceptance. Test H4.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Cancelled input is delivered, then reducer rejects invalid_queue_cancellation.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-135 — Execution target changes after validation

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-6：After activation/approval/schema checks and awaited intent persistence, executeToolCall re-resolves by name only. setTools/setActiveTools can intervene.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F06；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:advanceToolBatch→executeToolCall.
- Expected output: Carry validated binding; recheck current activation/approval before dispatch. Test H5.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Revoked or approval-required replacement executes with differently validated arguments.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-136 — Idempotent live timeout treated as settled

- Status: done
- Owner: fix-durable-storage-review
- Objective: 验证并修复 R-RUNTIME-7：A non-cooperative idempotent mutation stays pending after timeout, but idempotence classifies it confirmed and continuation proceeds.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F07；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:executeWithTimeout,executeToolCall; A/tool-outcome.ts:getToolErrorOutcome.
- Expected output: Keep live timed-out mutations uncertain/owned regardless of replay safety. Test H6.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md、validation-durable-storage-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: Later different writes race with the original; safe repetition of A does not imply safe concurrent A/B.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-137 — Provider dispatched after cancellation

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-8：Async branch/conversion/systemPrompt work follows the control check; streamFn is unconditional afterward.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F08；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:runAssistantStep.
- Expected output: Capture controller/operation and recheck immediately before streamFn. Test H7.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Abort/close during preparation still reaches provider dispatch.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-138 — Idle waiter ignores preparation

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-9：driverPromise is installed after intent persistence; idle waiting observes only driverPromise.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F09；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:prompt,waitForIdle,runWhenIdle.
- Expected output: Install settlement promise at reservation. Test H8.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Idle callbacks run during accepted preparation.
- Compatibility risk: 收紧错误时序下的接纳/取消；不得把未停副作用判为安全重试，不能丢失已接收任务。
- Blocker: None.
- Unblock condition: None.

### [x] T-139 — Progress counters cross user boundaries

- Status: done
- Owner: fix-durable-runtime + fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-10：Harness counters never reset per drive and fingerprint text-only assistants. Agent counters survive new queued inputs/non-tool turns.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F10；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:detectNoProgress,drive; A/agent-loop.ts:runLoop.
- Expected output: Reset at run/explicit-input boundaries; count uninterrupted tool continuations. Tests H9/A1.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md、validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Legitimate repeated requests stop; four identical independent text prompts trigger the harness guard.
- Compatibility risk: 无进展检测只对实际重复续执行触发，不移除保护。
- Blocker: None.
- Unblock condition: None.

### [x] T-140 — Image progress discarded

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-11：Fingerprint includes image MIME/type but not data; changing screenshots at one path compare equal.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F11；完整当前源码与消费者。
- Scope or files: A/no-progress.ts:fingerprintToolResult.
- Expected output: Include deterministic image digest/identity. Test A2.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Visual workflows stop after three different observations.
- Compatibility risk: 无进展检测只对实际重复续执行触发，不移除保护。
- Blocker: None.
- Unblock condition: None.

### [x] T-141 — Retry/checkpoint usage lost

- Status: done
- Owner: fix-durable-runtime
- Objective: 验证并修复 R-RUNTIME-12：Retry continues/checkpoint returns precede the sole usage append.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F12；完整当前源码与消费者。
- Scope or files: H/agent-harness.ts:runAssistantStep,checkBudgets.
- Expected output: Persist each settled attempt's usage once before branching. Test H10.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-durable-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Ledger/maxTokens undercount consumed provider work.
- Compatibility risk: 修正边界而不改变正常工具输出/额度/路径语义。
- Blocker: None.
- Unblock condition: None.

### [x] T-142 — Late search spawn after abort

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-13：grep does not recheck after ensureTool/isDirectory; find does not recheck after ancestor traversal/fd probe. Cancellation may already have fired/detached.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F13；完整当前源码与消费者。
- Scope or files: C/grep.ts:execute; C/find.ts:execute.
- Expected output: Check current signal/settled state immediately before spawn. Test C1.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Cancelled searches spawn; find can leave an unowned child.
- Compatibility risk: 修正边界而不改变正常工具输出/额度/路径语义。
- Blocker: None.
- Unblock condition: None.

### [x] T-143 — Missing-target aliases bypass mutation queue

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-14：realpath failure falls back to lexical path; real/symlink-parent aliases of a new file get different queues.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F14；完整当前源码与消费者。
- Scope or files: H/tools/file-mutation-queue.ts:getMutationQueueKey; C/file-mutation-queue.ts:getMutationQueueKey.
- Expected output: Canonicalize nearest existing ancestor plus missing suffix. Tests G2/C2.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Mutations of one physical file overlap; key also changes after creation.
- Compatibility risk: 修正边界而不改变正常工具输出/额度/路径语义。
- Blocker: None.
- Unblock condition: None.

### [x] T-144 — Shutdown claims completion before log close

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-15：Task becomes terminal before writer close. Deadline reporting uses terminal status, not settledPromise.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F15；完整当前源码与消费者。
- Scope or files: H/env/background-task-manager.ts:finalize,shutdown,cleanup.
- Expected output: Track process-plus-writer settlement in report. Test G3.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: complete:true allows cleanup to drop ownership while writer/lease remains live.
- Compatibility risk: 清理必须等待真实资源结算；独立 background task 接纳后不能被原调用的后续取消误杀。
- Blocker: None.
- Unblock condition: None.

### [x] T-145 — Incomplete shutdown report stays cached

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-16：Deadline's incomplete report is cached even after tasks settle; only complete:true clears it.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F16；完整当前源码与消费者。
- Scope or files: H/env/background-task-manager.ts:shutdownPromise,shutdown,cleanup.
- Expected output: Cache in-flight join only, or refresh/rejoin on retry. Test G4.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Retry cleanup cannot complete/reuse the manager.
- Compatibility risk: 清理必须等待真实资源结算；独立 background task 接纳后不能被原调用的后续取消误杀。
- Blocker: None.
- Unblock condition: None.

### [x] T-146 — Background UTF-8 chunk corruption

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-17：Per-buffer toString corrupts multibyte characters split between chunks.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F17；完整当前源码与消费者。
- Scope or files: H/env/background-task-manager.ts:attach drain.
- Expected output: Independent streaming stdout/stderr decoders; flush on settlement. Test G5.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: task_output/wait_for preview and byte accounting diverge from correct raw log.
- Compatibility risk: 清理必须等待真实资源结算；独立 background task 接纳后不能被原调用的后续取消误杀。
- Blocker: None.
- Unblock condition: None.

### [x] T-147 — Promotion wins after abort/callback failure

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-18：Kill is requested but promotion stays enabled until asynchronous exit. Timer adoption can win; promotedTaskId overrides failure/abort handling.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F18；完整当前源码与消费者。
- Scope or files: H/env/node-process-executor.ts:execute timeout callback.
- Expected output: Disable adoption after abort/callbackError; retain ownership until exit. Test G6.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Failed/cancelled execution reports successful background promotion.
- Compatibility risk: 清理必须等待真实资源结算；独立 background task 接纳后不能被原调用的后续取消误杀。
- Blocker: None.
- Unblock condition: None.

### [x] T-148 — Raw streams hang on producer rejection

- Status: done
- Owner: fix-process-runtime
- Objective: 验证并修复 R-RUNTIME-19：Wrappers attach only success handling; allowed prepareRequest/persistence rejection leaves the stream open.
- Inputs and prerequisites: docs/reports/2026-10-18-harness-audit/runtime.md 的 F19；完整当前源码与消费者。
- Scope or files: A/agent-loop.ts:agentLoop,agentLoopContinue; packages/ai/src/utils/event-stream.ts:EventStream.
- Expected output: Define failure termination for iterator/result; wire rejection handlers. Test A3.
- Dependencies: None.
- Execution steps:
  1. 门控/状态屏障重现错误时序，再最小修复；记录反证而非强行修复。
  2. 回放日志/reopen、取消/失败/并发邻域验证，检查所有修改测试。
- Acceptance criteria:
  - 原始触发可判定地消除；正常语义保持；root 检查 diff 和独立复跑。
- Verification method:
  - 初审对应 G/H/A/C 回归文件；统一 check/build/隔离全套测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-process-runtime.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: Iterator/result hangs and detached promise rejects unhandled.
- Compatibility risk: 原先悬挂的低层 stream 将明确 reject；正常结果与迭代时序保持。
- Blocker: None.
- Unblock condition: None.


### [x] T-150 — 清理 Codex 重试等待的 abort listener

- Status: done
- Owner: fix-ai-transports
- Objective: 正常定时器完成后没有 removeEventListener，成功重试仍把闭包挂在 caller signal。
- Inputs and prerequisites: 相关根因与 root 独立源码核对；不越过指定文件。
- Scope or files: packages/ai/src/api/openai-codex-responses.ts:sleep 与定向测试。
- Expected output: 最小修复/文档、回归与可复核证据。
- Dependencies: None.
- Execution steps:
  1. 核对契约、证明触发；修复后针对性验证并复查。
- Acceptance criteria:
  - 等待结束/取消后 listener 数量回到基线；不改变退避时间或重试次数。
- Verification method:
  - 源码/文档 diff 与定向测试；T-008 统一 check/build/隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-codex-sleep.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 正常定时器完成后没有 removeEventListener，成功重试仍把闭包挂在 caller signal。
- Compatibility risk: 保留正常路径与失败可观测性；不重放未知外部操作，不添加未经证实承诺。
- Blocker: None.
- Unblock condition: None.

### [x] T-151 — 允许顶层服务失败关闭后重新清理

- Status: done
- Owner: fix-service
- Objective: closePromise 永久缓存 rejected promise，修复下层保留 ownership 后，顶层仍无法再次完成关闭。
- Inputs and prerequisites: 相关根因与 root 独立源码核对；不越过指定文件。
- Scope or files: packages/server/src/server.ts:close 与服务 shutdown 测试。
- Expected output: 最小修复/文档、回归与可复核证据。
- Dependencies: T-100
- Execution steps:
  1. 核对契约、证明触发；修复后针对性验证并复查。
- Acceptance criteria:
  - 失败关闭不丢引用，资源结算后再次 close 成功；并发 close 共享在途操作。
- Verification method:
  - 源码/文档 diff 与定向测试；T-008 统一 check/build/隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-server-close.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: closePromise 永久缓存 rejected promise，修复下层保留 ownership 后，顶层仍无法再次完成关闭。
- Compatibility risk: 保留正常路径与失败可观测性；不重放未知外部操作，不添加未经证实承诺。
- Blocker: None.
- Unblock condition: None.

### [x] T-152 — 原生 child delivery 后禁止内部恢复续执行

- Status: done
- Owner: fix-session-execution
- Objective: deliver_result 停止 Agent 内层循环，但外层 AgentSession 未知效果调查仍能开启新的 inference。
- Inputs and prerequisites: 相关根因与 root 独立源码核对；不越过指定文件。
- Scope or files: coding-agent agent-session.ts、pi-child-session-host.ts 与生命周期回归。
- Expected output: 最小修复/文档、回归与可复核证据。
- Dependencies: None.
- Execution steps:
  1. 核对契约、证明触发；修复后针对性验证并复查。
- Acceptance criteria:
  - 有效 delivery 后无内部调查/队列继续；未知结果仍保留，下一次显式 admitted followup 可开始并重置停止状态。
- Verification method:
  - 源码/文档 diff 与定向测试；T-008 统一 check/build/隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-session-execution.md、validation-host-admission.md、validation-session-edge-review.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: deliver_result 停止 Agent 内层循环，但外层 AgentSession 未知效果调查仍能开启新的 inference。
- Compatibility risk: 保留正常路径与失败可观测性；不重放未知外部操作，不添加未经证实承诺。
- Blocker: None.
- Unblock condition: None.

### [x] T-160 — 同步实际已修复的公开契约文档

- Status: done
- Owner: sync-harness-docs
- Objective: 修复改变边界契约与资源预算，文档/工具描述必须同步。
- Inputs and prerequisites: 相关根因与 root 独立源码核对；不越过指定文件。
- Scope or files: permissions/desktop/MCP/codemode/web/extension/TUI/compaction 相关 README/docs；codemode tool description 仅预算说明。
- Expected output: 最小修复/文档、回归与可复核证据。
- Dependencies: None.
- Execution steps:
  1. 核对契约、证明触发；修复后针对性验证并复查。
- Acceptance criteria:
  - 文档与源码/验证回执一致，说明兼容性及未证明的物理效果；无无关改写。
- Verification method:
  - 源码/文档 diff 与定向测试；T-008 统一 check/build/隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-docs-complete.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: 修复改变边界契约与资源预算，文档/工具描述必须同步。
- Compatibility risk: 保留正常路径与失败可观测性；不重放未知外部操作，不添加未经证实承诺。
- Blocker: None.
- Unblock condition: None.


### [x] T-153 — 清理 Codex device-code 诊断中的认证材料

- Status: done
- Owner: fix-model-auth
- Objective: device startup/poll 的错误体与无效 JSON 诊断仍直接插值 response body，可能带 user_code/device_auth_id/authorization_code/code_verifier。
- Inputs and prerequisites: 实施中发现，root 已核对代码路径；继续前做最小重现。
- Scope or files: packages/ai/src/auth/oauth/openai-codex.ts 的 start/poll device flow 与 synthetic OAuth tests。
- Expected output: 最小完整修复及回归证据。
- Dependencies: None.
- Execution steps:
  1. 复现、根因修复、边界及现有回归验证。
- Acceptance criteria:
  - 合成标记在公开错误中完全缺席；保留 status/缺失字段提示和 pending/slow_down/成功逻辑。
- Verification method:
  - 定向离线测试与最终统一 check/build/隔离套件。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-device-auth.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P1.
- Expected benefit: 诊断不暴露认证材料。
- Compatibility risk: 错误文本更简洁，不更改认证握手。
- Blocker: None.
- Unblock condition: None.

### [x] T-154 — 统计未激活 compaction 的已知 Usage

- Status: done
- Owner: fix-session-execution
- Objective: 成功 checkpoint 可计入 Usage，但失败/取消的已知模型消费没有 checkpoint，消费者仍可能漏算。
- Inputs and prerequisites: 实施中发现，root 已核对代码路径；继续前做最小重现。
- Scope or files: coding-agent usage-totals.ts、AgentSession stats、footer、stats/scan 与 usage tests。
- Expected output: 最小完整修复及回归证据。
- Dependencies: T-086
- Execution steps:
  1. 复现、根因修复、边界及现有回归验证。
- Acceptance criteria:
  - 复用已有 diagnostics 中 full Usage（如成立），只补 failed/aborted，activated 不双算；live/reopen/footer/scan 一致；无 Usage 不捏造。
- Verification method:
  - 定向离线测试与最终统一 check/build/隔离套件。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-compaction-accounting.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 完整而不重复地统计已知模型消费。
- Compatibility risk: 统计值纠正；优先复用已有日志，不引入无收益存储格式。
- Blocker: None.
- Unblock condition: None.


### [x] T-155 — 将废弃 custom-summary 断言迁移为离线当前契约回归

- Status: done
- Owner: fix-compaction-contract
- Objective: 两项真实 provider 门控测试仍断言已废弃的 extension summary 会被采用，必须与当前忽略语义一致，不能靠默认 skip 隐藏。
- Inputs and prerequisites: T-085 contract 回执，现代 compaction 源码与 faux harness。
- Scope or files: coding-agent/test/compaction-extensions.test.ts、必要的离线 suite 回归；不改产品源代码或其他 worker 测试。
- Expected output: 证明旧断言不符合当前契约；用真实 AgentSession + faux 流覆盖 deprecated summary 被忽略，保留有意义的其他 provider 集成覆盖和显式 opt-in。
- Dependencies: None.
- Execution steps:
  1. 确认当前契约，重现旧断言冲突，迁移两项断言。
  2. 运行修改测试及离线邻域，不调用真实 provider。
- Acceptance criteria:
  - 两项当前行为实际被离线测试执行；其他真实测试未执行时明确 skipped，不计通过。
- Verification method:
  - 指定 compaction test files，PI_REAL_MODEL_EVAL=0；最终统一 check/隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-compaction-tests.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P3.
- Expected benefit: 消除已知过期验收标准，增加默认可运行回归。
- Compatibility risk: 不移除产品功能，不弱化自定义取消钩子或其他真实 provider 覆盖。
- Blocker: None.
- Unblock condition: None.


### [x] T-156 — 隔离控制器新任务与旧恢复队列

- Status: done
- Owner: fix-session-history
- Objective: 已证实冷 child 新 assignment 会继承旧 queued followUp/steer/nextTurn，超出本次任务意图；为 T-080 提供明确 journal 接纳策略。
- Inputs and prerequisites: red-cold-queue.log（实际2次 provider 调用，期望1次）；TaskRecoveryJournal 当前实现。
- Scope or files: coding-agent/src/core/task-recovery.ts 及专门 journal tests；AgentSession 调用方属于 T-080。
- Expected output: start 的可选 inheritQueuedInputs:false 策略，默认 root 行为保持；旧 pending prompt/queues 和未知效果仅保留历史，不自动迁入新任务。
- Dependencies: None.
- Execution steps:
  1. 三种队列与未知效果的红/绿单元回归，保留默认接纳回归。
- Acceptance criteria:
  - false 不继承可执行队列且不删除旧事实；default 保持原行为；调用方 T-080 再用真实 faux child 验证。
- Verification method:
  - 指定 journal/suite-task-recovery 测试；T-080 集成；最终统一验证。
- Validation evidence: root 已读完整 start 修改与历史保留路径，独立重跑 task-recovery-admission.test.ts 9/9通过（task-13）；worker 79/79邻域通过。调用方冷 child 三类队列集成留在 T-080，未冒充本项覆盖。
- Priority: P1.
- Expected benefit: 冷恢复后的显式新任务不执行未被重新授权的旧队列。
- Compatibility risk: 仅 host-controlled 调用选择 false；不更改普通 root 自动恢复默认值。
- Blocker: None.
- Unblock condition: None.


### [x] T-161 — 修复跨模块类型验收错误

- Status: done
- Owner: fix-integration-types + 当前文件 owners
- Objective: interim tsc 已暴露17条类型错误；修正真实类型/边界契约，不用 any、放宽业务判断或跳过检查掩盖。
- Inputs and prerequisites: /tmp/pi-harness-interim-tsc.log；具体文件按所有权分配。
- Scope or files: Node TextDecoder 注解、OAuth unknown JSON 边界、MCP AgentToolError 默认未知语义、测试 fixture/Signal listener 类型；活跃 owner 处理各自文件。
- Expected output: 最小类型修复和必要的现有行为回归。
- Dependencies: None.
- Execution steps:
  1. 读取真实 API types 与源码，按所有权修复；根级 tsc/check 再次验证。
- Acceptance criteria:
  - 全仓 tsc/check 无错误，不删除或弱化取消/未知结果/安全判断。
- Verification method:
  - 受影响定向测试及 root npm run check。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-integration-types.md、validation-modes-review.md、validation-host-admission.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 所有运行回归以外再通过静态契约验收。
- Compatibility risk: 不扩大权限、不改变未触发语义、不为类型错误降级已有依赖或功能。
- Blocker: None.
- Unblock condition: None.


### [x] T-162 — 保留 auth check 对未解析配置的 not_ready 契约

- Status: done
- Owner: fix-model-review
- Objective: F03 fail-closed 修复后，已有 auth-check 回归从 not_ready 变为 invalid；在不恢复 ambient fallback 的前提下保留 CLI 已定义语义。
- Inputs and prerequisites: auth-check.test.ts:117 实际失败；root 已读 checkProviderAuth/readCredential 及对应测试。
- Scope or files: coding-agent/core/auth-storage.ts、cli/auth-check.ts 与 auth-check/auth-storage 定向回归。
- Expected output: 可区分“配置值暂不可解析”和“损坏状态”的错误/诊断；不改原本期望为 invalid 来遮盖回归。
- Dependencies: None.
- Execution steps:
  1. 复现已有失败及 ambient key 场景；最小类型化诊断修复并保留 fail-closed 请求路径。
- Acceptance criteria:
  - 未解析显式 key 为 not_ready 且不回退 ambient、不调用 provider；损坏 auth JSON 仍 invalid；已配置与有意缺省环境凭据仍按既有契约工作。
- Verification method:
  - 指定 auth-check/storage/runtime-auth tests；全仓 check 与隔离测试。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-auth-check.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。
- Priority: P2.
- Expected benefit: 机器可判定的 CLI 退出/状态语义不因请求安全修复而退化。
- Compatibility risk: 只分类已知不可用凭据，不将任意异常误标为缺少配置。
- Blocker: None.
- Unblock condition: None.


### [x] T-163 — 更新编译产物验收脚本的原生协作契约

- Status: done
- Owner: coordinator
- Objective: 离线编译 smoke 因仍期待已退休 acceptance 字段而失败；其 spawn 参数也仍为旧 delegation envelope。更新消费者，不恢复废弃产品接口。
- Inputs and prerequisites: /tmp/pi-harness-compiled-smoke.log 的实际失败；collaboration-contract.ts 当前 schema/validate 实现。
- Scope or files: scripts/check-native-subagent-product.mjs、.github/workflows/ci.yml。
- Expected output: 编译模块的当前 task/context/tools 输入、当前结果校验结构和完整 shutdown；CI build 后执行该 offline gate，并显式运行私有包原生协作/权限定向测试，避免缺少 broad legacy test script 导致覆盖缺失。
- Dependencies: None.
- Execution steps:
  1. 保留失败证据，按当前契约修正最小断言/输入；重新运行整个 smoke。
- Acceptance criteria:
  - 编译后的 native spawn、tool catalog、退休 exports、CLI metadata、npm pack inventories 全部通过，零真实模型调用。
- Verification method:
  - PI_OFFLINE=1 node scripts/check-native-subagent-product.mjs；root check。
- Validation evidence: root观察旧acceptance断言失败并核对当前schema后修正；native只读child spawn、catalog/retired exports、CLI help/version、两份npm-pack inventory通过；严格空环境隔离smoke再次通过（/tmp/pi-harness-compiled-isolated-final.log），CI YAML解析/步骤检查通过，新增source contract命令实际通过233+18测试。
- Priority: P2.
- Expected benefit: 运行产物验收真正覆盖当前接口，不被过期断言挡住。
- Compatibility risk: 只更新验证消费者/CI本地验收；不改变产品行为、恢复旧接口或发布外部产物。
- Blocker: None.
- Unblock condition: None.


### [x] T-164 — 收敛完整隔离套件的两个验收失败

- Status: done
- Owner: fix-validation-tail
- Objective: 最终 ./test.sh 实际出现 footer reftable watcher 等待超时及大历史 fork 恢复态旧断言失败；分别判定产品故障/fixture 契约，不能放宽门槛掩盖。
- Inputs and prerequisites: /tmp/pi-harness-final-tests.log:223–254；前一基线日志与当前 fork audit-only 契约。
- Scope or files: coding-agent/footer-data-provider.ts 与 test/footer-data-provider.test.ts（产品改动仅根因证实后）；test/suite/regressions/01a0c4e0-large-recovery-session.test.ts。
- Expected output: 可判定且稳定的真实 watcher 验收、历史保留而非可执行恢复的准确断言。
- Dependencies: None.
- Execution steps:
  1. 定向重现、分析首个分歧；如间歇则受控调度/注入事件验证，不盲加 sleep/超时。
  2. 最小修复/fixture纠正，重复并运行邻域，保留全部历史/内存保护断言。
- Acceptance criteria:
  - 两文件定向通过；全套重跑通过；若不能复现/修复，明确不计完成。
- Verification method:
  - 指定两文件及相关邻域、可控重复、root ./test.sh。
- Validation evidence: red/green、变更位置及定向命令见 docs/reports/2026-10-18-harness-audit/validation-validation-tail.md；root复核实施回执与独立复查闭环，并执行最终统一check/build/隔离测试（/tmp/pi-harness-check-final.log、/tmp/pi-harness-tests-verified.log）通过。 接受的是测试就绪/历史契约修正：97项邻域和30轮native测试通过，原生产watcher未改；最初OS事件缺失底层原因未唯一证明，不计为已修复OS缺陷。
- Priority: P2.
- Expected benefit: 完整验收无已知失败，且不恢复错误的 fork 自动执行。
- Compatibility risk: 不更改用户 history、不弱化 watcher 更新可见性或大历史安全读取。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 不调用真实模型或外部服务；特定包使用仓库 vitest CLI 指定文件，TUI 用 node --test。
2. 修复先通过最小故障重现证明因果，再加入正常/异常/取消回归。
3. 统一运行 npm run check（完整输出），立即核对自动改写范围。
4. 视跨模块风险运行 ./test.sh；命令长期运行用后台任务并保留日志。
5. 文档使用 task_document.py validate；所有子结果须检查 diff 并重跑关键验收。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 审查规模大，采用包边界分工与显式覆盖，不宣称消灭所有未知问题。
- macOS 本机不能证明 Windows/Linux 原生终端或所有远端 provider 行为。
- 并发 agent 共用工作树，写入按文件所有权隔离；统一检查最后串行。
- 无外部阻碍。已说明真实provider/跨平台/原生事件根因等验证边界；不计为已验证或已修复的生产能力。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18: 创建 execute 文档；确认干净基线、工具链与全模块清单；T-001 至 T-007 开始，子审查仅授予 read。
- 2026-10-18: 隔离 ./test.sh 基线后台执行，日志 /tmp/pi-harness-baseline-tests.log；追加 T-009，开始跨项目非交互重现与文档修正。

- 2026-10-18: T-010/T-011 经 root 检查 diff 和独立 27-test 验证通过；后续 T-100/103–106/115 交给同一 fix-service worker，文件所有权串行交接。

- 2026-10-18: T-001–T-007 审查覆盖完成，88 条模块初审候选加两项 root CLI/文档候选（共 90 条）全部进入证据/重现流程；同源重复服务发现合并，不重复计算。只读审查 worker 已关闭，实现按文件边界分配；不把任何未重现条目宣称已修复。

- 2026-10-18: 独立只读复查发现 T-020 的 symlink cwd + ../ 缺口、T-041 默认 Grok 摘要入口未净化、T-042 失败工厂异步回调可重新注册；均未计完成，交 fix-review-boundaries 重现和补齐。证据 review-boundary-ui.md。

- 2026-10-18: 独立 MCP/sandbox 复查确认 codemode/snapshot 未发现新的可行动问题，但 T-025 leader exit 早于 stdout drain、T-026 错误体失败丢失已知 HTTP status 需补齐；未计完成，交 fix-mcp-review 重现/修复。

- 2026-10-18: 第二批独立复查发现并回流：standalone compaction 结束未唤醒 RPC shutdown、tree supersession 旧 continuation 抢占 UI、OAuth 显式 token 丢 provider headers、pause-vs-finish、未落盘 reconciliation 的 live effect 重放、SQLite failed close 不可重试。均属于原整改验收缺口，原项仍 in_progress；不计完成。

- 2026-10-18: 全仓 npm run check 通过且无自动改写；offline build 通过。首轮最终隔离测试仍2失败（T-164），编译 smoke 的旧契约断言/参数经T-163修正后通过。会话独立复查另发现 post-commit hook 取消续跑与 startup signal 越阶段复用，回流 T-080/T-084，未接受完成。

- 2026-10-18: 所有纳入的模块整改与后续验收修正完成并通过相应定向验证；root统一check/build/隔离完整套件通过，严格隔离编译native/CLI/pack检查通过。完整套件coding-agent4073通过/74跳过，真实provider跳过不计通过。T-008进入最终文档与提交阶段；两条已验证教训写入/合并LEARNS。

- 2026-10-18: T-008完成，109项任务全部done、无blocked项。最终CI结构/文档引用/validator/diff检查通过；代码提交bf3ab709bbc759f7134c5655997b11a154c448b1精确包含203个已核对路径，无依赖/锁文件/生成模型数据改动。clone无已安装的Git hook入口，故显式运行原.husky/pre-commit脚本通过并检查完整输出；hash核对源代码/测试无变化。其余52个审查/计划/学习记录路径单独归档，不包含dist、临时日志或外部参考仓库。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 109项任务全部done。npm run check、npm run build:offline、隔离./test.sh、严格隔离编译native/CLI/npm-pack smoke与补充native233/权限18/desktop10均通过；详细分包结果和日志索引见docs/reports/2026-10-18-harness-audit.md。最终CI YAML/步骤/shell语法、206个本地链接、34个报告证据引用与31个计划报告引用、task_document.py validate、git diff --check通过。代码提交bf3ab709bbc759f7134c5655997b11a154c448b1；sh .husky/pre-commit再次通过，1608文件无formatter改写，完整输出/tmp/pi-harness-manual-hook.log已检查。
- Limitations: 未调用真实provider/OAuth/桌面服务，未完整验证Linux/Windows/Bun/Cloudflare；跳过用例不计通过，远端CI未运行。native watcher初次全套超时的OS原因未唯一证明，接受的是测试就绪与历史契约修正，生产watcher未改。Full Access/工具过滤/VM不是OS sandbox；未发布/推送/部署，已运行实例需重启才能加载新构建。
