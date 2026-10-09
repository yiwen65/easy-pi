# Task Plan: 中断任务原子接续整改

- Created: 2026-10-09
- Workspace: /home/w/Project/easy-pi
- Mode: execute
- Overall status: done
- Source: 用户“修复以上问题”；覆盖崩溃重启，未知副作用暂停核实。

<!-- task-doc-section:background-goal -->
## Background and goal

修复任务意图和完整项丢失、并行结果保存过晚、残缺尾部、未知副作用继续执行、工具超时后继续运行及两套运行时恢复差异。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

覆盖原生 AgentSession、Agent 循环、durable Harness、JSONL 和离线验证。保留流结束后执行工具的顺序；不调用真实模型，不发布，不承诺任意外部副作用恰好一次。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 六类问题已由离线探针复现 | 上轮分析及 agent-loop.ts、session-manager.ts、agent-harness.ts |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 未声明安全重放的工具按可能产生副作用处理。
- Open question: None. 用户已确认范围与未知结果策略。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 已提交进度不丢失、结果不重跑；未知结果暂停核实；目标回归与根检查通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-005; T-003, T-005 -> T-006; T-001, T-002 -> T-007; T-001, T-002, T-003, T-005, T-006, T-007 -> T-004 最终验收。
- Parallel batches: 首批存储、循环、Harness 独立处理；第二批协调者集成。
- Serialization constraints: 根检查、任务文档和 Git 提交由协调者串行执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 原生 JSONL 可靠提交和尾部修复

- Status: done
- Owner: storage
- Objective: 首条 assistant 前持久化，修复残缺尾部，可靠提交。
- Inputs and prerequisites: 上轮探针和 AGENTS.md。
- Scope or files: session-manager.ts 与对应存储测试。
- Expected output: 最小修复和回归。
- Dependencies: None.
- Execution steps:
  1. 完整读文件，先红回归，再修复与目标验证。
- Acceptance criteria:
  - 首次提交、残缺尾部和中间损坏行为通过。
- Verification method:
  - 具体存储测试文件。
- Validation evidence: 存储新增稳定 input ID、hardlink/canonical 修复后 8 文件 117 项通过；最终 V-002 全部通过，包含真实 SIGKILL、尾部损坏、写入失败和重复 ID。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 执行循环完整项和逐工具结果提交

- Status: done
- Owner: loop
- Objective: 执行循环完整项和逐工具结果提交。
- Inputs and prerequisites: 上轮探针和用户授权。
- Scope or files: packages/agent/src/agent-loop.ts、agent.ts、types.ts
- Expected output: 修复和离线回归。
- Dependencies: None.
- Execution steps:
  1. 读文件、红回归、实现、目标验证。
- Acceptance criteria:
  - 已复现缺口修复且邻近行为保持。
- Verification method:
  - 具体测试文件及最终根检查。
- Validation evidence: 协调者执行 agent 6 个具体文件 75 项通过，持久回调、派发失败和批次恢复覆盖。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Harness 未知结果、超时和完整项恢复

- Status: done
- Owner: harness
- Objective: Harness 未知结果、超时和完整项恢复。
- Inputs and prerequisites: 上轮探针和用户授权。
- Scope or files: packages/agent/src/harness 与对应测试
- Expected output: 修复和离线回归。
- Dependencies: None.
- Execution steps:
  1. 读文件、红回归、实现、目标验证。
- Acceptance criteria:
  - 已复现缺口修复且邻近行为保持。
- Verification method:
  - 具体测试文件及最终根检查。
- Validation evidence: harness/诊断/工具身份审查 202 项通过；最终 V-001 20 文件 430 项通过，涵盖关闭、完整项恢复、已知结果不重跑、未知结果核实和超时信号。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 原生会话持久任务恢复和集成

- Status: done
- Owner: coordinator
- Objective: 原生会话持久任务恢复和集成。
- Inputs and prerequisites: 上轮探针和用户授权。
- Scope or files: AgentSession、恢复模块、测试、文档
- Expected output: 修复和离线回归。
- Dependencies: T-001, T-002, T-003, T-005, T-006, T-007.
- Execution steps:
  1. 读文件、红回归、实现、目标验证。
- Acceptance criteria:
  - 已复现缺口修复且邻近行为保持。
- Verification method:
  - 具体测试文件及最终根检查。
- Validation evidence: V-001/V-002/V-003 共 770 项通过，1 项 Windows 专用用例按平台跳过；V-004 通过。原生 suite 24 项，包含实际工具副作用后 SIGKILL、流中完整项先落盘、显式核实/重试、队列恢复及提交失败后的排空。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — v4 JSONL 持久提交和写入所有权

- Status: done
- Owner: storage
- Objective: v4 JSONL 后端不能仅依赖逻辑 append 顺序，需同步提交和单写者保证。
- Inputs and prerequisites: T-003 后端检查发现 fs 接口缺少同步和写者声明。
- Scope or files: agent harness JSONL storage/repo/types、nodejs filesystem 和对应测试。
- Expected output: 可靠提交能力和恢复写者接口。
- Dependencies: T-001.
- Execution steps:
  1. 完整读文件，补充离线回归和最小接口。
- Acceptance criteria:
  - 无持久能力的后端不冒充安全；同会话竞争不能派发副作用。
- Verification method:
  - 具体 JSONL 后端测试文件。
- Validation evidence: V-001 JSONL/Node/memory 验证与 V-003 SQLite 38 项通过；真实 SIGKILL、同步失败/阻塞、writer 竞争、readonly inspect、hardlink 拒绝覆盖。新 claim 临时文件导致列表 ENOENT 的竞态曾 3/15 失败，修复后 15 轮/150 项通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — durable 服务端接续投影和核实入口

- Status: done
- Owner: loop
- Objective: 新的独占存储与待核实状态不破坏远端服务的会话列表、恢复通知及核实入口。
- Inputs and prerequisites: T-003/T-005 的接口已完成；服务端仍以 open 读取名字、仅监听 run_end。
- Scope or files: coding-agent/src/server/harness-service.ts 及对应测试；需要只读存储能力时与 storage 所有者协调。
- Expected output: 持有者安全的列表、恢复暂停通知、显式恢复和核实命令。
- Dependencies: T-003, T-005.
- Execution steps:
  1. 检查消费者，新增真实 JSONL 离线回归，修复并验证。
- Acceptance criteria:
  - 已连接客户端得到暂停快照；列表不竞争正在执行会话的所有权。
- Verification method:
  - harness-service.test.ts 与新增消费者回归。
- Validation evidence: V-002 内 harness-service 10 项及 create-harness/easy-pi-harness 邻近验证通过，涵盖活动 JSONL 会话跨 service 列举、恢复暂停通知、核实入口和未退出工具的拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 请求接收与队列的持久身份

- Status: done
- Owner: coordinator
- Objective: 已接受的排队输入同样不能在崩溃后丢失或重复注入；请求接收通知必须晚于意图提交。
- Inputs and prerequisites: 接收顺序检查发现 streaming queue 仍只在内存；恢复原始输入不能依赖消息数量猜测。
- Scope or files: task-recovery.ts、AgentSession、SessionManager 的预分配 entry ID、suite 回归。
- Expected output: 初始和排队输入使用持久 target ID，恢复按 branch-visible target 是否存在决定注入。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 用丢失队列的重开回归证明，再补齐记录和确定性恢复。
- Acceptance criteria:
  - 初始/排队输入先落盘再确认；重开不重复已提交输入。
- Verification method:
  - native suite 输入恢复和 RPC preflight 回归。
- Validation evidence: V-002 原生 suite 的初始 intent、已接受队列 exactly-once 注入、已取消队列、nextTurn 语义和 acceptance-before-I/O 检查通过；显式 entry ID 的存储回归先红后绿。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

存储首次提交/尾部恢复/写入失败，循环完整项/快慢工具/取消，Harness 未知结果/超时，原生 faux provider 重开恢复与副作用门。最终 npm run check。

- V-001（packages/agent）：`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/durable-agent-loop.test.ts test/agent-loop.test.ts test/agent.test.ts test/execution-admission.test.ts test/resource-scheduler.test.ts test/agent-loop-tool-error.test.ts test/harness/agent-harness-recovery.test.ts test/harness/agent-harness-faults.test.ts test/harness/agent-harness-run.test.ts test/harness/agent-harness-controls.test.ts test/harness/agent-harness-tool-gateway.test.ts test/harness/agent-harness-operations.test.ts test/harness/agent-harness-budgets.test.ts test/harness/reducer.test.ts test/harness/session/jsonl-codec.test.ts test/harness/session/jsonl-storage.test.ts test/harness/session/jsonl-durable.test.ts test/harness/session/jsonl.test.ts test/harness/session/memory.test.ts test/harness/nodejs-env.test.ts` — 430 passed，1 platform skip。
- V-002（packages/coding-agent）：同一 Vitest CLI `--run test/session-manager/durable-storage.test.ts test/session-manager/custom-session-id.test.ts test/session-manager/file-operations.test.ts test/session-manager/tree-traversal.test.ts test/suite/agent-session-task-recovery.test.ts test/suite/agent-session-stream-checkpoint.test.ts test/interactive-mode-retry.test.ts test/suite/agent-session-thinking-completion.test.ts test/suite/agent-session-queue.test.ts test/suite/agent-session-retry-events.test.ts test/suite/agent-session-socket-retry-budget.test.ts test/suite/agent-session-retry-compaction-history.test.ts test/suite/agent-session-compaction.test.ts test/suite/agent-session-model-extension.test.ts test/harness-service.test.ts test/server/create-harness.test.ts test/easy-pi-harness.test.ts test/suite/regressions/7150-rpc-prompt-during-compaction.test.ts test/sdk-session-manager.test.ts test/sdk-stream-options.test.ts test/sdk-skills.test.ts` — 302 passed。
- V-003（packages/session-backends/sqlite-node）：同一 CLI `--run test/conformance.test.ts test/writer-leases.test.ts` — 38 passed。
- V-004（repo root）：`npm run check` — Biome、依赖 pins、导入、shrinkwrap、install-lock、tsgo、browser smoke 全部通过；`git diff --check` 无错误。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

外部副作用与本地日志无法形成通用事务，未知结果必须暂停。保持扩展和模型可见批次顺序。

不支持持久 session 的多硬链接别名；需独立复制。无目录同步能力的文件系统、非法 owner 和中断的 claim guard 会停止自动恢复，需操作方核实。只读检查不获取写者也不修复文件。未执行真实 provider、全套 e2e、build 或硬件掉电测试。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-09: 执行合同已填写，首批三项开始，协调者负责原生集成。
- 2026-10-09: T-001/T-002/T-003 目标验证通过；T-004 实现并验证 10 个 native 场景；追加 T-005 补齐 v4 存储能力和生命周期。邻近 retry tests 发现内部记录影响可见 transcript，正在恢复透明投影。
- 2026-10-09: transcript 透明投影恢复，native 15 个场景及重试/压缩等邻近回归通过；新增 T-006 验证新持久语义的远端消费者。
- 2026-10-09: 补齐 T-007 稳定初始/队列 target ID；取消队列和 nextTurn 上下文保持原语义；所有 T-001 至 T-007 已完成。最终 V-001 至 V-004 通过，无必要工作未完成。
- 2026-10-09: 最终接收审查修复被拒绝提示提前消耗 nextTurn、completed 状态队列取消未持久化两项；补充回归后 V-002 全部 302 项通过，根检查再次通过。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 770 targeted tests passed，1 Windows platform skip；npm run check、diff check 和任务文档校验通过。
- Limitations: 任意外部副作用不能和本地日志组成通用事务，结果未知必须核实；未执行真实模型、硬件掉电、跨 OS 全覆盖或 build。无阻塞任务。
