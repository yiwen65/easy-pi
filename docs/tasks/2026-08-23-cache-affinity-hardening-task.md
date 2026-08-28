# Task Plan: 缓存亲和优化全方位测试与修复

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求基于缓存命中率优化 handoff，设计并执行全方位测试，发现并修复潜在 bug 和优化项。

<!-- task-doc-section:background-goal -->
## Background and goal

上一任务已实现 durable `AgentHarness` 默认 session cache affinity、OpenAI 长 prompt cache key 的前缀加 hash 编码、Provider assistant message 的 strict-JSON 规范化，以及 TUI `CR` 指标语义纠正。本轮目标是对这些改动进行独立、对抗性和跨模块验证：扩大边界、状态迁移、Provider adapter、持久化和展示层测试覆盖；稳定复现真实缺陷后进行最小修复；验证修复没有覆盖共享工作树中的其他会话改动。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- OpenAI/Azure OpenAI prompt cache key：undefined、0/1/63/64/65 code point、Unicode、超长输入、确定性、共享前缀差异和 adapter 一致性；
- durable `AgentHarness`：create/setStreamOptions 的默认与显式 affinity 语义、faux cache 隔离/关闭路径，以及 Provider message strict-JSON 持久化边界；
- TUI/Grok `CR`：最新 assistant、零 prompt token、cache read/write 组合、累计 usage、窄宽度和命名一致性；
- 相关定向测试、非 e2e 回归、`npm run check`、任务路径 diff/格式检查；
- 仅修复可稳定复现且属于上述路径的 bug，优化必须有明确成本或重复逻辑证据。

Non-goals:

- 不运行全量 `npm test` 或全量 Vitest；仓库规则说明可能触发真实 Provider e2e；
- 不调用真实 Provider。handoff 中历史授权不视为本轮新授权；opt-in real eval 仅验证默认 skip；
- 不引入跨 tenant/session cache cohort、语义答案缓存、结构化 prompt 重写或新 telemetry 系统；
- 不清理、重置、提交或格式化与本任务无关的共享工作树改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前工作树包含大量其他会话的 tracked/untracked 改动，本任务相关共享文件也已被修改。 | 2026-08-23 `git status --short`；handoff 的 workspace risk。 |
| F-002 | `AgentHarness.create()` 当前用 metadata ID 补默认 `sessionId`，`setStreamOptions()` 用当前 ID 与新 options 合并。 | `packages/agent/src/harness/agent-harness.ts:400-420,992-999`（当前工作树）。 |
| F-003 | OpenAI cache key helper 对超过 64 code point 的 key 使用可读前缀、`~` 和完整输入的 `shortHash`。 | `packages/ai/src/api/openai-prompt-cache.ts`；`packages/ai/src/utils/hash.ts`。 |
| F-004 | OpenAI completions 新测试通过，但 Azure OpenAI adapter 仍断言旧的 64 个 `x` 截断结果。 | 定向 Vitest：`openai-completions-prompt-cache.test.ts` passed；`azure-openai-base-url.test.ts:157` failed，expected old truncation, received `...~hash`。 |
| F-005 | TUI `CR` 公式为 `cacheRead / (input + cacheRead + cacheWrite)`，累计 totals 包含 assistant、tool usage、compaction 和 branch summary。 | `packages/coding-agent/src/modes/interactive/components/footer.ts:45-77`。 |
| F-006 | strict durable session conformance 明确拒绝 object property 和 array element 中的 `undefined`。 | `packages/agent/src/harness/session/testing/conformance.ts:760-810`；现有 `stripUndefined` 只移除 object properties，array branch 递归保留 undefined element。 |
| F-007 | 仓库规定修改代码后运行 `npm run check`，且该命令会写入格式化结果；禁止全量测试，要求指定测试文件。 | `/Users/w/Projects/easy-pi/pi/AGENTS.md`；相关 `LEARNS.md` 条目。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 本轮“全方位”指围绕 handoff 中缓存优化改动的确定性纵深测试，而不是整个 monorepo 的无界测试；这样能在共享脏工作树中保持可归因性。
- Assumption: 可选 `sessionId: undefined` 应视为未提供，不能清除 durable metadata affinity；显式非空字符串仍保持优先。将用回归测试判定当前行为。
- Assumption: Provider message 数组出现 `undefined` 虽不符合静态类型，但 Provider SDK/runtime 数据可越过类型边界；既然持久化边界承诺 strict JSON，规范化应覆盖该输入或明确拒绝。通过失败回归确定最小行为。
- Open question: 无阻塞问题。任何真实 Provider 调用均保持未授权，不执行。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- OpenAI 与 Azure OpenAI adapter 对长 cache key 使用同一 helper 语义；所有输出不超过 64 Unicode code point，短 key 原样、长 key 稳定且共享长前缀的不同后缀可区分。
- durable affinity 在 create 和后续 `setStreamOptions` 的缺省/undefined/显式值路径中行为一致；不同 session 不共享 faux cache，`cacheRetention: none` 无 cache read/write。
- Provider assistant message 经持久化边界后满足 strict JSON；回归覆盖嵌套 object 与 array 中的 runtime `undefined`，且不改变已定义值和 usage。
- `CR` 的计算、最新消息选择、累计 usage 和 standard/Grok 展示在边界输入及窄宽度下有确定性测试，旧 `CH` 命名无任务路径残留。
- 每个稳定复现的问题有修复前失败与修复后通过证据；未复现或收益无证据的优化不实施。
- 所有选定定向测试、real eval 默认 skip、`npm run check`、任务路径 `git diff --check` 和 task document validator 通过；如被无关改动阻塞则准确记录。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001,T-002,T-003 -> T-004 -> T-005 -> T-006`。
- Parallel batches: T-001（AI adapter/key）、T-002（AgentHarness/persistence）、T-003（TUI metric）为只读审计，可由独立 scout 并行；所有写入由 coordinator 在 T-004/T-005 串行完成，避免隔离 worktree 看不到当前未提交实现。
- Serialization constraints: `agent-harness.ts` 和其 scaffold 测试混有其他任务改动；不得由并行 writer 修改。`npm run check` 最后单独运行，前后核对 `git status` 路径集合和任务路径 diff。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 审计 prompt cache key 与 Provider adapter

- Status: done
- Owner: coordinator
- Objective: 全量读取相关 helper、OpenAI/Azure adapter 和测试，建立边界矩阵并识别可复现缺陷或低成本优化。
- Inputs and prerequisites: F-003、F-004；当前工作树内容。
- Scope or files: `packages/ai/src/api/openai-prompt-cache.ts`; `packages/ai/src/utils/hash.ts`; OpenAI completions/responses/Azure adapter 调用点；相关测试。
- Expected output: 具体测试缺口、失败命令、候选修复及风险，不修改文件。
- Dependencies: None.
- Execution steps:
  1. 完整读取范围文件并追踪 helper 调用点。
  2. 检查 code-point 上限、确定性、adapter 一致性、极端输入和算法成本。
  3. 运行最小定向测试或临时只读实验。
- Acceptance criteria:
  - 每项发现有路径/行号和可执行验证方法。
  - 区分产品 bug、测试漂移和无证据优化。
- Verification method:
  - AI 包指定 Vitest 文件；代码审查。
- Validation evidence: 完整追踪 helper 的四个调用点（OpenAI completions/responses、Azure responses、Codex responses）。确认 Azure stale assertion（AI 两文件 29/30 passed）和产品缺口：Azure `buildParams` 未在 `cacheRetention: none` 时移除 key；确认 helper 对全长 `Array.from` 有 O(n) 额外数组分配，可改为最多保留 64 code point。OpenAI prompt test 16/16、faux provider 23/23 passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 审计 durable affinity 与 strict-JSON 边界

- Status: done
- Owner: coordinator
- Objective: 对 default/override/update/cache isolation 和 Provider message 规范化做状态与数据边界审计。
- Inputs and prerequisites: F-002、F-006；Session strict-JSON contract。
- Scope or files: `packages/agent/src/harness/agent-harness.ts`; session JSON contract；harness affinity/scaffold tests；faux provider 测试。
- Expected output: 可复现缺陷、缺口矩阵和最小修复建议，不修改文件。
- Dependencies: None.
- Execution steps:
  1. 完整读取 harness 与相关测试/contract。
  2. 检查 create/setStreamOptions、session 隔离、禁用缓存、嵌套 undefined 和 usage 保真。
  3. 设计可先失败的回归测试。
- Acceptance criteria:
  - 明确每条状态迁移和 strict-JSON 输入的预期与现状。
  - 发现必须可由离线 faux/runtime 数据复现。
- Verification method:
  - Agent 包指定 Vitest 文件；代码审查。
- Validation evidence: 完整读取 1987 行 AgentHarness、scaffold、strict-JSON validator/conformance 和 faux cache。确认两个可先失败缺陷：create/setStreamOptions 中显式 optional `sessionId: undefined` 会覆盖默认 affinity；`stripUndefined` 的 array branch 保留 undefined/sparse element，而 strict contract 明确拒绝 `[undefined]`。现有 scaffold 7/7、faux provider 23/23 passed，但未覆盖上述边界及两 harness session 隔离。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 审计 CR 指标计算与双 TUI 展示

- Status: done
- Owner: coordinator
- Objective: 验证缓存读取比例的数学语义、最新消息选择、累计 usage、standard/Grok 一致性和窄宽度行为。
- Inputs and prerequisites: F-005；TUI 测试主题与宽度规则。
- Scope or files: footer、Grok stats bar、usage totals、对应测试与 README。
- Expected output: 边界矩阵、可复现缺陷或测试缺口，不修改文件。
- Dependencies: None.
- Execution steps:
  1. 完整读取源文件和对应测试。
  2. 覆盖 0%、100%、read+write、最新零 token、tool/summary totals 和窄宽度。
  3. 检查旧命名和 standard/Grok 输出一致性。
- Acceptance criteria:
  - 每个候选问题有当前行为证据和预期依据。
  - 测试设计遵守 ANSI 零宽样式规则。
- Verification method:
  - coding-agent 指定 Vitest 文件；代码审查和 `rg`。
- Validation evidence: 完整读取 standard footer、Grok stats bar、usage totals 和两个测试。公式与 handoff 一致，未发现产品 bug；缺口为 0%/100%、多 assistant 取最新、tool/summary 不覆盖最新比例的直接测试。现有 footer/Grok 26/26 passed；任务路径无旧 `CH`/`latestCacheHitRate` 残留。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 实施可复现 bug 修复与纵深回归

- Status: done
- Owner: coordinator
- Objective: 根据 T-001 至 T-003 证据，先添加失败回归，再实施最小产品/测试修复。
- Inputs and prerequisites: T-001、T-002、T-003 完成。
- Scope or files: 仅上述审计确认的任务路径；任务文档。
- Expected output: 可归因的测试和最小修复，无无关重构。
- Dependencies: T-001, T-002, T-003.
- Execution steps:
  1. 将确认缺陷转化为独立回归；记录修复前失败。
  2. 在最早正确边界做最小修复。
  3. 逐文件运行定向测试并审查 diff。
- Acceptance criteria:
  - 所有实施项都有失败复现；修复后相关测试通过。
  - 不修改未确认范围，不覆盖共享改动。
- Verification method:
  - 各包指定 Vitest 文件；任务路径 diff 审查。
- Validation evidence: 修复前回归：Azure `cacheRetention:none` 31/32 failed；Agent scaffold 2/9 failed，分别为 affinity 被 undefined 清除和 `SessionError: Durable payload contains undefined`。修复后 AI key/Azure 32/32、Agent scaffold 9/9、TUI 27/27 passed。另修正 Azure、OpenAI Responses、Codex 三处旧截断断言；未改变 adapter 产品语义。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 补齐优化与跨模块集成验证

- Status: done
- Owner: coordinator
- Objective: 仅对有证据的重复扫描/分配或测试重复逻辑做低风险优化，并运行跨模块离线集成测试。
- Inputs and prerequisites: T-004 完成；审计中的性能/维护性证据。
- Scope or files: 任务直接相关文件。
- Expected output: 有行为等价测试支持的优化，或记录“不实施无证据优化”。
- Dependencies: T-004.
- Execution steps:
  1. 对候选优化做复杂度/分配分析或小型基准。
  2. 只实施收益明确且不扩大 API 的方案。
  3. 运行 cache key、harness、TUI、server construction 和 real-eval default-skip 测试。
- Acceptance criteria:
  - 优化不改变已验证语义；若无充分证据则无产品 diff。
  - 跨包选择性回归全部通过。
- Verification method:
  - 指定 Vitest 文件和必要的临时 benchmark（临时文件位于 `/tmp` 并删除）。
- Validation evidence: cache key helper 不再 `Array.from` 全长输入，只保留至多 64 个 code point，额外数组空间由 O(n) 降为 O(64)，64 ASCII/Unicode 边界及长 key 测试保持通过。Agent harness suite 25 files、412 passed/1 skipped；AI cache/provider suite 7 files、148 passed/4 skipped；coding-agent 39 passed/1 skipped，real eval 默认文件 skipped，未调用 Provider。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 静态检查、对抗复核与收口

- Status: done
- Owner: coordinator
- Objective: 完成静态检查、任务边界核对、对抗性复核和权威文档收口。
- Inputs and prerequisites: T-005 完成。
- Scope or files: 本任务路径、工作树状态、任务文档。
- Expected output: 可重复的最终证据与诚实限制。
- Dependencies: T-005.
- Execution steps:
  1. 记录 `npm run check` 前状态，运行后核对路径和内容漂移。
  2. 运行任务路径 `git diff --check`、旧命名检索和 task validator。
  3. 对修复做反例审查，更新任务状态和最终结论。
- Acceptance criteria:
  - 所有任务完成且验证证据当前有效。
  - 共享工作树边界与未执行真实 Provider 的限制明确。
- Verification method:
  - `npm run check`; `git diff --check`; `rg`; task document validator。
- Validation evidence: `npm run check` 全阶段通过；Biome fixed 1 file，为本任务 Azure source 的预期换行格式化，check 前后 `git status --porcelain` 路径集合完全一致。任务路径 `git diff --check` 通过，旧 `CH`/`latestCacheHitRate` 检索无结果。check 后 AI 103/103、Agent 9/9、coding-agent 39 passed/1 skipped；对抗复核未发现需要扩大修复范围的新问题。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- AI：OpenAI completions prompt cache、Azure OpenAI base URL/cache key，以及必要的 helper 边界测试；不访问网络。
- Agent：scaffold/affinity、faux cache 隔离与关闭、Provider response strict-JSON 嵌套输入；使用 InMemorySessionStorage。
- TUI：直接验证 `computeSessionUsageStats` 数学边界，并验证 standard footer/Grok stats bar 在常规与窄宽度输出。
- 集成：coding-agent server harness construction；real cache eval 无 opt-in 时必须 skip。
- 静态：`npm run check`（先后核对共享工作树）、任务路径 `git diff --check`、旧 `CH`/`latestCacheHitRate` 定点检索、任务文档 validator。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 共享工作树高度脏且 `agent-harness.ts` 含大量其他任务修改：所有编辑使用唯一小块定点替换，逐路径核对；禁止 reset/stash/clean/广泛格式化。
- `npm run check` 会写文件：运行前后保存 `git status --porcelain`，若触及任务外路径则立即区分既有状态和新 mtime/diff，不把他人改动归为本任务。
- 真实 Provider 调用可能产生费用和泄露风险：本轮不执行，仅验证门控 skip。
- “全方位”不能证明不存在所有 bug；最终结论限定为记录的确定性矩阵、选定路径和当前工作树版本。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: Task document created.
- 2026-08-23: 读取 handoff、原任务文档、仓库规则和相关 lessons；确认本轮为新 execute run，且不继承真实 Provider 历史授权。
- 2026-08-23: 基线定向测试发现 Azure OpenAI 测试仍期望旧截断：AI 两文件共 30 tests，29 passed/1 failed；OpenAI 新语义测试通过，失败仅为 Azure stale expectation。
- 2026-08-23: T-001/T-002/T-003 -> in_progress；分别交由只读 scout-ai/scout-agent/scout-tui 并行审计，所有写入保留给 coordinator。
- 2026-08-23: 三轮 bounded subagent 审计均因 child output limit（并伴随 sibling cancellation）失败，未产出可核验报告；T-001/T-002/T-003 -> blocked，等待用户授权改由 coordinator 串行审计。
- 2026-08-23: 用户选择“串行继续”；T-001/T-002/T-003 blocked -> in_progress，owner 改为 coordinator。
- 2026-08-23: T-001/T-002/T-003 -> done；确认 Azure cache-disable 缺口、optional undefined 清除 affinity、array undefined 未被清洗三项产品 bug，以及 Azure stale assertion 和 TUI 边界覆盖缺口；T-004 -> in_progress。
- 2026-08-23: 新回归稳定复现三项产品 bug：Azure none 仍发送 key；create/setStreamOptions 的 optional undefined 清除 affinity；Provider content array undefined 被 strict durable contract 拒绝。
- 2026-08-23: T-004 -> done；最小修复后 AI 32/32、Agent 9/9、TUI 27/27 passed，并修复 Azure/OpenAI Responses/Codex 三个 adapter 的 stale assertions。
- 2026-08-23: T-005 -> done；长 key prefix 暂存由全输入数组改为最多 64 code point；扩展回归 Agent 412 passed/1 skipped、AI 148 passed/4 skipped、coding-agent 39 passed/1 skipped；T-006 -> in_progress。
- 2026-08-23: `npm run check` 全阶段通过；Biome 仅格式化本任务 Azure source，status 路径集合前后不变；任务路径 diff check 与旧命名检索通过。
- 2026-08-23: check 后回归 AI 103/103、Agent 9/9、coding-agent 39 passed/1 skipped；T-006 -> done，Overall status -> done。
- 2026-08-23: 将本轮已验证的跨 adapter、optional affinity 与 strict-JSON 边界教训定点追加到项目 `LEARNS.md`；未改写既有条目。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-006 全部 `[x] done`；稳定复现并修复 3 个产品 bug（Azure 禁用缓存仍发送 key、optional undefined 清除 durable affinity、array undefined 未被 strict-JSON 规范化），修正 Azure/OpenAI Responses/Codex 三个 adapter 的 stale assertions，补齐 key/TUI/session isolation 边界测试，并将长 key 临时数组空间从 O(n) 降为 O(64)。扩展回归共 Agent 412 passed/1 skipped、AI 148 passed/4 skipped、coding-agent 39 passed/1 skipped；`npm run check`、任务路径 `git diff --check` 和 task validator 通过；可复用教训已追加到 `LEARNS.md`。
- Limitations: 未运行整个 monorepo 测试或真实 Provider；真实 eval 仅验证默认 skip。结论限于 handoff 相关缓存路径、离线 Provider/faux 测试和当前高度脏的共享工作树；所有改动仍未提交。
