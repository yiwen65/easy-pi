# Task Plan: 优化 runtime 重构性能

- Created: 2026-09-14
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户明确授权对 runtime 相关重构 commit 执行性能优化；scope 限定为 runtime 重构相关代码

<!-- task-doc-section:background-goal -->
## Background and goal

runtime P00–P08 已完成并通过功能回归，但新增的运行时隔离、快照、准入、调度和诊断路径可能增加每次 provider step 或 tool execution 的 CPU、分配和延迟成本。目标是在不改变取消、生命周期、工具绑定、调度、compaction、原生子代理和公开 API 契约的前提下，使用可重复的本地 faux-provider 工作负载定位并优化已证明的 runtime 热点。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

**Scope**

- runtime 重构相关实现：`packages/agent/src/agent-loop.ts`、`agent.ts`、`run-scope.ts`、`tool-plan.ts`、`step-snapshot.ts`、`resource-scheduler.ts`、`execution-events.ts`、`harness/env/background-task-manager.ts`，以及 `packages/coding-agent/src/core/agent-session.ts` 和 `agent-session-runtime.ts`。
- 运行时关键路径的本地 component/end-to-end benchmark、CPU/heap 证据和最小优化。
- 与优化直接相关的回归测试和构建/静态检查。

**Non-goals**

- 不调用真实 provider API，不读取或输出 credentials。
- 不修改 Codex、依赖、lockfile/shrinkwrap、发布配置或无因果关系的代码。
- 不以未测量的静态猜测宣称性能提升；如果没有超过测量噪声的可归因热点，则保留代码不变并提交诊断结果。
- 不改变 runtime 的取消、准入、资源上限、session shutdown、compaction、原生 subagent 或公开 API 行为。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前分支包含 runtime P00–P08 实现，相关提交为 `46af9a4a4`、`42a1d34ed`、`874481a1d`。 | `git log` 与 runtime progress/test-matrix 文档。 |
| F-002 | 构建产物已生成，Node.js 为 `v24.15.0`，平台为 Darwin arm64。 | `npm run build` exit 0；`node --version`、`uname -a`。 |
| F-003 | runtime 功能回归和完整仓库测试已通过。 | 已记录的 Agent/coding-agent 定向测试、`npm run check`、完整 `./test.sh` 结果。 |
| F-004 | 现有 runtime 实现每个 provider step 创建 `ToolPlan`，并在配置 `onProviderContext` 时深拷贝消息和工具 schema；tool execution 还经过准入、scheduler 和诊断分支。 | `packages/agent/src/agent-loop.ts:239,404,894-1120`、`tool-plan.ts`、`resource-scheduler.ts`。这是待测假设，不是已确认瓶颈。 |
| F-005 | 工作区存在两个用户提供的未跟踪 runtime 计划文件，不能修改或提交。 | `git status --short`：`docs/runtime-refactor/EASY_PI_RUNTIME_REFACTOR_PLAN.md`、`START_HERE.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 以当前本地 Darwin arm64、Node 24、生产等价构建产物和 faux provider 为可执行的第一阶段性能合同；真实网络延迟不纳入 runtime 自身成本归因。
- Assumption: 先测无 tool、带 tool schema、tool execution 和 session lifecycle 四类 workload，再决定是否修改代码；每个候选优化必须保留功能语义。
- Assumption: 用户授权包含必要的 benchmark、临时 profiler/heap 采样和 runtime 源码修改，但不包含真实 provider/API 使用。
- Open question: 当前没有用户指定的延迟/吞吐/内存预算；若测量只显示低于噪声的差异，则不强行优化，以可归因证据和剩余风险作为结果。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 建立包含 workload、版本、平台、构建、计时边界、warm-up、样本数和原始结果的可复现 baseline，并定位至少一个由 runtime 代码导致的首个成本分歧；否则明确记录未证明的候选。
- 只实施最小、可解释且不改变 runtime 行为契约的优化；若没有可靠收益，允许不修改 runtime 源码。
- 功能回归覆盖取消最终准入、ToolPlan/handler binding、scheduler 限流、session shutdown 和现有 AgentSession 行为。
- 优化前后使用相同 workload 做 A/B 验证，报告用户可见耗时/吞吐及至少一个归一化成本指标或说明当前环境无法取得该指标。
- `npm run check`、相关定向测试和必要的 `npm run build` 通过；不包含用户未跟踪文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001` → `T-002` → `T-003` → `T-004`。
- Parallel batches: 无；baseline、归因、优化和验证共享同一 runtime 路径及工作区，必须串行。
- Serialization constraints: 只允许 coordinator 修改 runtime 文件和本任务文档；benchmark 原始输出放在 `/tmp`，不写入工作区。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 建立 runtime baseline 并定位首个成本分歧

- Status: done
- Owner: coordinator
- Objective: 用本地 faux provider 和可控 tool workload 测量 runtime 重构关键路径的耗时、吞吐、分配/heap 或 CPU 样本，区分 provider 模拟、事件 sink、快照、准入/调度和 session 管理成本。
- Inputs and prerequisites: F-001–F-005；当前构建产物；runtime focused tests。
- Scope or files: 临时 `/tmp` benchmark/profile 脚本；只读检查 runtime 源码与现有测试。
- Expected output: baseline 原始样本、环境元数据、候选热点排名和最便宜的区分性实验。
- Dependencies: None.
- Execution steps:
  1. 固定 Node/platform/revision/build 和 workload，分离 cold-start 与 warmed steady-state。
  2. 测量无 tool、带 schema、tool execution、parallel scheduler 和 session lifecycle 路径。
  3. 对候选路径使用 Node CPU/heap evidence 或 component counters，避免把 faux provider 成本归给 runtime。
- Acceptance criteria:
  - 有可重复的 baseline 和 raw samples。
  - 至少一个候选由端到端时间与 component 证据共同支持，或明确记录没有达到证据门槛。
- Verification method:
  - 临时 benchmark/profile 命令，重复 fresh-process runs。
  - 现有 runtime focused tests 作为 correctness oracle。
- Validation evidence: `/tmp/pi-runtime-perf/results/baseline-cpu.jsonl` and `candidate-cpu.jsonl` record fresh Node processes on Darwin arm64, Node `v24.15.0`, 7 warm steady-state samples per case, 16 messages, 7 built-in tools or 32 synthetic tools. Baseline and candidate were compared on the same faux-provider workload. With 7 built-in tools and an observer, `runLoop` median changed from `32.388ms/1000` to `22.897ms/1000`; with 32 synthetic tools it changed from `154.842ms/1000` to `95.484ms/1000`. The no-observer controls remained `8.371ms` versus `8.322ms`. CPU time per operation moved from `32.532us` to `23.043us` for built-ins and `154.961us` to `97.928us` for the synthetic case. This isolates observer schema-copy work as the supported cost divergence.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施最小 runtime 性能优化

- Status: done
- Owner: coordinator
- Objective: 针对 T-001 证明的首个 runtime 成本分歧实施单变量优化，保持取消、生命周期、快照隔离、工具绑定、调度和诊断语义。
- Inputs and prerequisites: T-001 done；候选热点和预测指标已记录。
- Scope or files: 仅 T-001 归因所需的 runtime 源文件及必要回归测试。
- Expected output: 最小源码 diff，说明优化机制、边界和潜在资源 trade-off。
- Dependencies: T-001.
- Execution steps:
  1. 先建立候选与预期变化的因果链，排除只优化 benchmark fixture 的方案。
  2. 修改最早且授权的成本点，保留错误传播、promise 顺序、abort signal 和 backpressure 语义。
  3. 运行受影响的定向 correctness tests。
- Acceptance criteria:
  - diff 只涉及已证明的 runtime 热点及其回归保护。
  - 定向测试通过，且无新增类型/格式/导入错误。
- Verification method:
  - 受影响 Agent/coding-agent runtime tests。
  - `npm run check`（若源码发生变化）。
- Validation evidence: Added internal `cloneToolSchema()` and replaced the observer-only per-tool `structuredClone()` calls while retaining independent mutable copies. The helper is shared with the existing ToolPlan clone path, preserving the established plain-schema cloning semantics. Agent runtime targeted tests passed after the change: 7 files, 80 tests.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — A/B 性能与资源验证

- Status: done
- Owner: coordinator
- Objective: 在相同 workload、构建和计时边界下比较优化前后，验证收益超过噪声且无 correctness、tail、heap 或吞吐回归。
- Inputs and prerequisites: T-002 done；baseline 原始样本和 candidate 版本。
- Scope or files: `/tmp` A/B samples/profile artifacts；T-002 修改范围。
- Expected output: 原始样本、summary、机制验证和残余风险。
- Dependencies: T-002.
- Execution steps:
  1. 以交错或随机顺序运行 fresh processes，至少进行多次重复并保留原始数据。
  2. 对照 user-visible latency/throughput 与 allocations/CPU/heap 等归一化指标。
  3. 运行 runtime focused suite，并审查不相关工作区改动。
- Acceptance criteria:
  - 结果支持实际 runtime workload 的收益，或明确结论为未超过噪声并回滚候选。
  - 所有相关功能回归通过。
- Verification method:
  - T-001 benchmark 命令的 candidate A/B 运行。
  - Agent/coding-agent runtime targeted tests。
- Validation evidence: A/B raw samples are in `/tmp/pi-runtime-perf/results/baseline-cpu.jsonl` and `candidate-cpu.jsonl`; a second baseline/candidate process pair reproduced the same direction and magnitude. The synthetic 32-tool observer case improved from `154.842ms/1000` to `95.484ms/1000` wall time and from `154.961us/op` to `97.928us/op` CPU time. The actual `Agent.prompt` observer case improved from `93.343ms/500` to `55.510ms/500`. The schema-copy strategy microbenchmark improved from `1181.843ms/10000` with per-value `structuredClone` to `391.551ms/10000` with the existing recursive plain-schema clone; these are component measurements, not a claim about network-bound request latency.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成检查与交付

- Status: done
- Owner: coordinator
- Objective: 完成静态检查、构建、任务文档和提交，确保只交付本任务改动。
- Inputs and prerequisites: T-003 done。
- Scope or files: 本任务 runtime 源码、回归测试、任务文档；不包含用户 runtime 计划文件。
- Expected output: 可审查提交和验证结果。
- Dependencies: T-003.
- Execution steps:
  1. 运行 `npm run check` 并检查自动改动范围。
  2. 运行必要的 `npm run build` 和定向测试。
  3. 验证 task document，检查 git status，显式暂存本任务文件并提交。
- Acceptance criteria:
  - 任务文档 validator 通过，所有任务 done，验证结果 truthful。
  - 提交不包含两个用户未跟踪 runtime 计划文件。
- Verification method:
  - `python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path <task-doc>`。
  - `npm run check`、必要构建与定向测试。
- Validation evidence: `npm run check` passed (Biome reported and corrected two pre-existing formatting issues; the unrelated `packages/coding-agent/test/subagent-real-provider.test.ts` rewrite was restored and remains unowned). `npm run build` in `packages/agent` passed. Task document validation passed. `git diff --check` passed, and final git status contains only the three runtime optimization files, this task document, and the two untouched user-provided untracked runtime plan files.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- Correctness oracle: runtime focused tests for Agent loop cancellation/admission, RunScope, ToolPlan/StepSnapshot, ResourceScheduler, background shutdown, AgentSession runtime and concurrent session behavior.
- Baseline: local faux-provider component/end-to-end benchmark with fixed tool/schema/message distributions; no network or credentials.
- Performance: fresh-process warm-up followed by repeated steady-state samples; measure total run time and normalize by provider steps/tool calls; use Node CPU/heap evidence only where the hypothesis requires it.
- A/B: same revision except for the candidate change, same Node/platform/build/workload; retain raw samples under `/tmp` and do not commit them.
- Static/build: `npm run check`, `npm run build` if source changes, task document validator, and `git diff --check`.

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- A faux provider can overemphasize local JavaScript overhead relative to real network latency; report this as component evidence, not universal product speedup.
- Structured cloning and schema freezing are correctness boundaries; removing or caching them can reintroduce mutation races or stale handler/schema bindings.
- Runtime diagnostics and scheduler paths are optional; optimizing them must not change observer isolation, error swallowing, cancellation, or resource release.
- `npm run check` may rewrite files in a shared worktree; after it, inspect status and do not stage unrelated changes.
- The two untracked files under `docs/runtime-refactor/` are user-owned and out of scope.

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-14: Task document created; runtime performance optimization authorized with scope limited to runtime refactor commits.
- 2026-09-14: Runtime source, progress/baseline documents, package entrypoints, and existing focused tests inspected. Likely costs are snapshot/schema cloning, observer isolation, scheduler/admission, and lifecycle bookkeeping; none is yet a proven bottleneck.
- 2026-09-14: T-001 baseline and attribution completed. The observer path was the first supported cost divergence: built-in-tool observer runs were about 4x the no-observer control, and per-tool `structuredClone` was materially slower than the existing recursive plain-schema clone in the isolated strategy benchmark.
- 2026-09-14: T-002 implemented the minimal schema-copy optimization and added a nested tool-schema observer-isolation regression. Agent runtime tests passed: 7 files / 80 tests.
- 2026-09-14: T-003 A/B validation completed with repeated fresh-process runs; wall time and CPU time improved in observer workloads while no-observer controls stayed within measurement noise.
- 2026-09-14: T-004 completed. `npm run check`, package Agent build, `git diff --check`, and task-document validation passed. An unrelated Biome rewrite was reverted; user-owned untracked runtime plan files were preserved.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001–T-004 are done. The implementation, runtime focused tests (7 files / 80 Agent tests and 5 files / 25 coding-agent tests), `npm run check`, `npm run build` from `packages/agent`, A/B benchmark samples, `git diff --check`, and task-document validator all passed.
- Limitations: Measurements are local Darwin arm64, Node `v24.15.0`, faux-provider/component workloads. They demonstrate runtime overhead reduction for observer/schema-copy paths, not end-to-end network latency or cross-platform performance. No real provider/API or credentials were used.
