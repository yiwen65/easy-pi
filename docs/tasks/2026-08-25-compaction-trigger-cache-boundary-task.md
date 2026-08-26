# Task Plan: Compaction 触发边界与缓存稳定性整改

- Created: 2026-08-25
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求；`_wiki/raw/articles/model-infra-harness-2026-07-15.md`；当前 compaction/AgentSession 源码

<!-- task-doc-section:background-goal -->
## Background and goal

当前 compaction 同时承担“判断是否需要压缩”和“选择压缩维护策略”两类职责。`incrementalCompactionsSinceRebuild >= 8`、大体积可卸载 tool payload、phase/drift/high-risk 等信号可以在不存在真实 context 压力时返回非 `none` 动作，使 active provider projection 被重写。按参考文档的推理基础设施模型，K/V cache 只复用逐 token 相同的前缀，第一个变化 token 之后都要重新 prefill；因此语义等价的摘要、重建或 system 层重组仍会造成缓存失效。

目标是建立并实现以下唯一边界：**compaction 在没有合法触发时只能观察、计量和纯函数投影，不能改变既有 provider-visible context；只有一次压缩事务成功激活 checkpoint 时，才允许原子替换历史投影。** 新 user/assistant/tool 事件按协议追加、用户显式改变模型/工具/system、以及分支导航属于其他 context change owner，不伪装成 compaction。

目标运行模型：

```text
raw append-only events
        |
        v
compile exact next provider request ----> Gate = false ----> same historical prefix + new tail
        |                                      (zero compactor call / zero publication)
        v
   Gate = true
 manual | soft pressure | hard pressure/overflow
        |
        v
select strategy (offload / incremental / rebuild)
        |
        v
fork compactor -> stage candidate -> validate final serialized request
        |                              |
        | reject/cancel/shadow/error   | pass
        v                              v
keep active projection unchanged   atomic activate checkpoint
```

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

In scope:

- 拆分“是否允许改变 context”的 trigger gate 与“触发后怎样压缩”的 strategy selector。
- 把自动检查集中到每次真实 provider 请求之前，覆盖用户 prompt 和 tool continuation；空闲的 `agent_end` 只记录 pending pressure，不主动压缩。
- 将 active provider projection 视为不可变 checkpoint，统一成功激活入口；no-trigger/reject/cancel/shadow/error 不得改写它。
- 为 provider-visible historical prefix 建立稳定序列化与 fingerprint/首差异诊断。
- 修正 restart/普通 path append 等非压缩路径清除 active snapshot 的行为。
- 增加缓存命中、compaction 成本与激活收益的可观测性和真实供应商对照评测方案。

Non-goals:

- 不恢复已废弃的 task contract、Task Ledger、Tool Ledger、branch binding 或 snapshot CAS。
- 不把 extension、用户显式 model/tool/system 切换或分支导航造成的 context 变化归因给 compaction；只要求这些变化有独立 reason。
- 不修改 provider Chat Template，不手工拼 provider-specific thinking/tool 标签。
- 本计划阶段不修改实现、不运行测试/构建/真实供应商评测、不提交 Git。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | K/V cache 要求序列化后的 token 前缀严格一致，第一个不同 token 后都需重算；语义相同不等于可复用。 | 指定文章第 54、58–60、74–82 行。 |
| F-002 | 文章要求稳定前缀、fork 不原地修改、历史只追加、checkpoint 边界一次完成 compaction，并保留原始事件。 | 指定文章第 110–126 行。 |
| F-003 | 当前 `evaluateTriggers()` 把“第 8 次 incremental”独立提升为 `full_rebuild`，且优先于 context hard/soft pressure。 | `packages/coding-agent/src/core/compaction/subsystem/trigger.ts:60-78`。 |
| F-004 | 当前大 tool payload 在低于 soft threshold 时也会独立返回 `offload_only`。 | `packages/coding-agent/src/core/compaction/subsystem/trigger.ts:96-115`。 |
| F-005 | `phaseChanged`/`manualMilestone` 也可独立返回 `soft_compact`，而 drift/contradiction/high-risk 可独立返回 rebuild。 | `packages/coding-agent/src/core/compaction/subsystem/trigger.ts:67-77,117-128`。 |
| F-006 | 生产 trigger 使用实际 next-request projection、recent provider usage floor、可卸载 token、cooldown 和 incremental count 共同决策。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts:367-468`。 |
| F-007 | host 首次同步或 path 非前缀扩展时会 `clearActive()`；首次重启同步因此可在没有新 compaction 激活时撤销 active projection。 | `packages/coding-agent/src/core/compaction/subsystem/session-integration.ts:320-330`；现有 restart 测试明确期待 active 被清除。 |
| F-008 | compactor 本身在 frozen event boundary 上工作，shadow 不发布；成功后通过 `buildActiveMessages()` 生成 handoff/snapshot/tail 投影。 | `packages/coding-agent/src/core/compaction/subsystem/orchestrator.ts:171-227`；`session-integration.ts:630-680,691-735`。 |
| F-009 | 自动和手动路径都会在 attempt 返回后无条件调用 `_refreshPinnedDirectiveLayer()`；字符串通常应稳定，但目前没有 fingerprint 守恒断言。 | `packages/coding-agent/src/core/agent-session.ts:1971-1981,2255-2295`。 |
| F-010 | 当前已有 cache read/write usage 和 miss-cost 统计基础，可复用而不新增账本机制。 | `packages/coding-agent/src/core/cache-stats.ts:34-128`；`agent-session.ts:3380-3400`。 |
| F-011 | 文章本身没有统一 benchmark，文中的硬件/TTL 数字只是示例，整改成效必须由本仓库对照评测证明。 | 指定文章第 124–128 行。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 合法自动 gate 初始仅包含“预计下一真实 provider 请求超过 soft/hard 阈值”及“实际 overflow”；`/compact` 是显式 manual gate。影响：phase/drift/high-risk/incremental-count/tool-size 不再单独造成 context rewrite，只在 gate 已打开后选择策略。若产品以后需要其他 gate，必须以显式 policy 配置和缓存成本证据加入。
- Assumption: 普通协议追加的新 user/assistant/tool 内容不属于“改变既有 context”；验收比较的是既有 historical prefix 的稳定性，而不是要求整个新请求字节不变。
- Assumption: soft 阈值继续以当前默认 70% 起步，hard 阈值继续以 85% 起步；先修职责边界，再用真实 provider 数据校准，不把来源文章的示例 TTL 当阈值。
- Assumption: 兼容 restart 可利用 snapshot 已有的 trigger head/base coverage 与 branch-visible ancestry 做校验，不需要恢复 branch binding/CAS。
- Open question: None blocking. 真实供应商评测所用 provider/model/API 凭证在执行阶段按现有配置发现；若不可用，则该验收项保持 blocked，不能用 mock 代替。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- Gate 为 false 时 compactor LLM 调用数、offload/archive 写入数、snapshot publication 数均为 0。
- 相同事件和请求输入重复编译时，no-trigger/reject/cancel/shadow/error 前后的 full request fingerprint 完全相同。
- 有正常新事件时，no-trigger 下一请求的既有 provider-visible historical prefix 与上一请求逐字节一致，只允许协议 tail 追加；若 provider 暴露 tokenizer/template hook，再增加逐 token 一致断言。
- `incrementalCompactionsSinceRebuild >= 8`、大 tool payload、phase/drift/contradiction/high-risk 任一信号单独出现时都不能打开 gate；在 soft/hard/manual gate 已打开后，它们可以决定 offload/incremental/rebuild 策略。
- 一次成功 compaction 只产生一次 active snapshot publication 和一次 provider context fingerprint 跳变；失败路径为零次跳变。
- 自动 gate 在每次真实 provider request 之前执行；空闲 `agent_end` 不启动 compactor。queued/tool continuation 在其下一 provider request 前同样受 gate 保护。
- 已知 hard/overflow 请求在压缩失败后不得继续发送同一个已知超限请求；系统执行确定性降级，仍不安全则给出可操作错误并停止该请求。
- 普通 append 和可证明兼容的 restart 保留 active snapshot；rewind/sibling navigation 可以改变 projection，但记录独立的 `navigation` reason。
- 真实供应商对照评测中记录每轮 cacheRead/cacheWrite/input、TTFT、context fingerprint 首差异位置、compaction 调用/激活/拒绝、任务总成本；整改版本不得比基线产生更多“阈值以下的 compaction 激活”，缓存命中率和成功任务成本不得回退。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-003 -> T-004 -> T-005 -> T-006`。先建立身份与守恒契约，再改策略和接线；同一 provider-context 状态链上的修改必须串行。
- Parallel batches: 本计划没有安全的实现并行批次。T-001 完成后，测试 fixture 的准备可与设计复核并行，但不得与同文件实现并写；权威任务文档只由 coordinator 更新。
- Serialization constraints: `trigger.ts`、`session-integration.ts`、`agent-session.ts` 共同决定激活边界；这些任务必须串行。测试更新跟随所属实现任务，不单独抢占共享 fixture。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 定义 provider context 身份与守恒契约

- Status: done
- Owner: coordinator
- Objective: 把“context 未变”“正常 tail 追加”“checkpoint 原子替换”变成可执行的类型、fingerprint 和断言，而不是依赖调用者约定。
- Inputs and prerequisites: F-001、F-002；当前 provider request/message/tool/system 编译链。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/types.ts`、`prompt-builder.ts`，必要时新增局部 `context-identity.ts`；对应测试。
- Expected output: `ActiveProjectionIdentity`/`ContextChangeReason`（命名可调整）、稳定 canonical serializer、historical-prefix/full-request fingerprint、首差异诊断。
- Dependencies: None.
- Execution steps:
  1. 明确 fingerprint 输入至少包括 model/chat-template identity、system、稳定顺序 tool schema、ordered model-visible messages/content/images、active snapshot version；排除 timestamp/audit/metrics 等不进入 provider token 的字段。
  2. 分离 full request hash 与 historical-prefix hash，支持正常 tail append 验证。
  3. 为 `no_trigger`、`compaction_activate`、`navigation`、`explicit_config_change` 等 change owner 建立封闭 reason。
  4. 添加相同输入确定性、tool schema 顺序、timestamp 不污染、首差异定位单元测试。
- Acceptance criteria:
  - 同一 provider-visible 输入的 fingerprint 稳定；任一 token-relevant 字段变化可定位首差异。
  - 守恒断言能区分合法 tail append 与历史前缀改写。
- Verification method:
  - 运行新增 context identity/prompt builder 目标测试；检查 fixture 中 provider-visible 序列化文本。
- Validation evidence: Added `context-identity.ts` and 4 focused tests. `npx vitest --run test/compaction-subsystem/context-identity.test.ts` passed: 1 file, 4 tests. Initial `npm test -- --run ...` did not execute tests because the package script already supplies `--run`; corrected without source changes.
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 拆分 trigger gate 与 compression strategy

- Status: done
- Owner: coordinator
- Objective: 只有 manual/pressure/overflow 能授权 context rewrite；维护信号只在授权后选择压缩方式。
- Inputs and prerequisites: T-001；F-003 至 F-006。
- Scope or files: `packages/coding-agent/src/core/compaction/subsystem/trigger.ts`、`session-integration.ts`；trigger/auto-trigger tests。
- Expected output: 纯函数 `evaluateCompactionGate()` 与 `selectCompactionStrategy()`（命名可调整），决策中分别记录 gate reason 和 strategy reason。
- Dependencies: T-001.
- Execution steps:
  1. Gate 只接受 explicit manual、soft/hard next-request pressure、previous overflow。
  2. Gate=false 直接返回，不计算/执行 offload、rebuild 或 compactor LLM。
  3. Gate=true 后再用 recoverable tool tokens、incremental count、drift/contradiction/high-risk、cooldown 选择 offload/incremental/rebuild；hard/overflow 不被 cooldown 抑制。
  4. 将 count=8 和 below-soft 大 tool payload 的既有期望改成 no-trigger，并新增“同信号在 gate=true 时选策略”的测试。
- Acceptance criteria:
  - 所有非授权信号单独出现时 gate=false。
  - 触发许可与策略原因在类型和审计中不可混淆。
- Verification method:
  - 运行 `trigger`、`auto-trigger-runtime` 目标测试并检查无 compactor/offload side effect。
- Validation evidence: Split pure `evaluateCompactionGate()` from `selectCompactionStrategy()`. Below-soft tool size, phase/milestone, incremental cap, drift, contradiction, and high-risk signals no longer open the gate. `npx vitest --run test/compaction-subsystem/trigger.test.ts test/compaction-subsystem/circuit-breaker.test.ts test/compaction-subsystem/auto-trigger-runtime.test.ts` passed: 3 files, 34 tests.
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 将自动压缩集中到真实 provider request 的 JIT 边界

- Status: done
- Owner: coordinator
- Objective: 不在空闲 `agent_end` 消耗缓存窗口或制造无后续收益的 checkpoint；每个真正请求（含 tool continuation）在发送前统一 gate。
- Inputs and prerequisites: T-002；AgentSession prompt/agent loop 生命周期。
- Scope or files: `packages/coding-agent/src/core/agent-session.ts` 及 agent-session compaction/continuation tests。
- Expected output: 单一 `prepareProviderRequest`/preflight 接线；`agent_end` 仅记录 pending pressure；下一请求到来时基于当时 exact request 重新评估。
- Dependencies: T-002.
- Execution steps:
  1. 移除 prompt、agent_end、overflow 分散路径间的重复策略判断，统一到 provider send 前。
  2. 覆盖普通 user prompt、queued message、tool result continuation 和 overflow retry。
  3. soft pressure 在无下一请求时只记录非 provider-visible pending hint；下一请求前重新计量，若压力消失则不压缩。
  4. hard/overflow 失败执行确定性 offload/rebuild 降级；仍超限则阻止请求，不能发送已知超限原 context。
- Acceptance criteria:
  - 空闲 agent_end 后 compactor 调用为 0；下一真实请求前恰好评估一次。
  - tool continuation 也不能绕过 gate；hard failure 不继续发送超限请求。
- Verification method:
  - 运行 agent-session compaction、prompt、tool continuation、overflow retry 目标测试；用 spy 断言 provider/compactor 调用顺序与次数。
- Validation evidence: Moved threshold evaluation to the exact provider `transformContext` boundary; idle `agent_end` no longer compacts, while overflow retry remains immediate. Added tool-continuation success and hard-failure blocking coverage. AgentSession/auto-trigger/queue focused run passed 3 files, 50 tests; subsequent boundary-specific run passed 2/2.
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 收口 active projection 的原子激活与恢复

- Status: done
- Owner: coordinator
- Objective: 只有验证通过的 checkpoint activation 能替换 provider 历史；所有失败及兼容 restart 保持原 projection。
- Inputs and prerequisites: T-003；F-007 至 F-009；现有 append-only event log 和 snapshot store。
- Scope or files: `session-integration.ts`、`orchestrator.ts`、`snapshot-store.ts`、`agent-session.ts`；restart/shadow/reject/publish-failure tests。
- Expected output: 单一 `activateProjection()` 事务边界；context replacement 与 pinned directive refresh 只发生在 activated outcome；兼容 restart 恢复规则。
- Dependencies: T-003.
- Execution steps:
  1. 将 candidate/offload artifact/recall ref 保持 staged，validator 通过后一次 publish；reject/cancel/shadow/error 不刷新 live projection。
  2. 把 `_refreshPinnedDirectiveLayer()` 和 `agent.state.messages` replacement 移入 activated 分支，并以前后 fingerprint 守恒保护失败路径。
  3. 首次 sync 不再无条件 clear active；用 snapshot trigger head/base coverage 对 branch-visible ancestry 做兼容校验。普通 append 保留，rewind/sibling 以 navigation reason 清除/重投影。
  4. full rebuild 只能作为已打开 gate 的策略，并必须发布保留未完成任务、约束、工具状态和对象引用的 handoff，而不是泛化占位摘要。
- Acceptance criteria:
  - 成功恰好一次 publication/fingerprint jump；所有非成功 outcome 为零。
  - compatible restart/append 复用 active；navigation 变化有独立审计 reason。
- Verification method:
  - 运行 snapshot store、session integration、shadow、publish failure、restart、branch navigation 目标测试并比较 fingerprints。
- Validation evidence: Directive refresh now occurs only after activation; first-sync restart retains only branch-visible compatible snapshots; deterministic rebuild handoff preserves prior semantic handoff. `npx vitest --run` over rebuild, narrative, auto-trigger, durability, and shadow integration passed: 5 files, 39 tests.
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 建立 cache-aware 可观测性与经济性护栏

- Status: done
- Owner: coordinator
- Objective: 证明 compaction 是为可用性/总成本服务，不以“token 变少”单指标误判成功。
- Inputs and prerequisites: T-004；现有 `cache-stats.ts` 和 provider usage cost 字段。
- Scope or files: `cache-stats.ts`、compaction observability/eval runner、`/context` 只读展示；对应测试。
- Expected output: 每轮 context fingerprint/change reason、cacheRead ratio、cacheWrite/input、idle/tool latency、compaction cost、后续节省、激活/拒绝计数与任务总成本。
- Dependencies: T-004.
- Execution steps:
  1. 复用现有 usage/cost，不引入 ledger；记录 compaction 前后 cache 指标和 fingerprint 首差异位置。
  2. hard/overflow 始终以 liveness 优先；soft/manual 记录 break-even 数据，但第一阶段不凭不可验证的“未来轮数预测”阻止用户手动操作。
  3. `/context` 展示只读取观测结果，不展开或重写 active provider context。
  4. 为 no-trigger 零成本、activation 合法 cache reset、工具耗时与 miss 相关性添加统计测试。
- Acceptance criteria:
  - 能把合法 activation、navigation、model/tool/system 变更和异常 compaction rewrite 分开归因。
  - 报告不把未激活轮次的 token 保留率当作压缩成功。
- Verification method:
  - 运行 cache-stats、observability、context command 和 eval reporter 目标测试。
- Validation evidence: Added a non-blocking agent-core observation hook at the exact post-transform/provider boundary; the compaction host records logical request/full-prefix fingerprints, change owner, prefix preservation, and first difference without raw content. `/context` reads these metrics only. Existing cache usage/cost accounting remains the economic source of truth. `npx vitest --run` over agent-loop, cache-stats, context command/inspection/identity, and auto-trigger runtime passed: 6 files, 65 tests. `npm --prefix packages/agent run build` and `npm --prefix packages/coding-agent run build` both passed.
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 回归、完整构建与真实供应商对照评测

- Status: done
- Owner: coordinator
- Objective: 在源码、构建产物和真实 provider 上验证职责边界、长任务连续性及实际缓存/成本效果。
- Inputs and prerequisites: T-005；可用 provider/model/API 配置和网络代理。
- Scope or files: 仅测试/eval fixture、必要的评测报告和任务文档状态；不扩大产品实现范围。
- Expected output: targeted regression、完整 `npm test`、完整 build、真实 provider A/B 报告；明确静态证据、mock 证据与真实运行证据。
- Dependencies: T-005.
- Execution steps:
  1. 先运行 compaction/context/AgentSession targeted suites，再运行 package/root 级完整测试与 build；注意 `npm run check` 可能写文件，若执行必须先记录并核对 status/diff。
  2. 用固定 model、tool schema、system、fixture 和请求间隔对比基线/整改：阈值以下多轮、soft trigger、hard overflow、reject/shadow、restart、长 tool continuation。
  3. 记录逐轮 cacheRead/cacheWrite/input、TTFT、总成本、fingerprint、compactor 调用和 activation；fixture ID/parentId 固定，Node provider runner 使用 CLI 同款代理 dispatcher。
  4. 只在所有 acceptance criteria 有当前证据后将任务标记 done；provider 不报告 cache usage 时标明能力限制，不能推断命中。
- Acceptance criteria:
  - targeted 与完整验证通过；真实 provider 下阈值以下 compactor 调用/激活为 0，historical prefix 稳定。
  - 与同配置基线相比，缓存命中率和成功任务总成本不回退；若统计波动，报告样本量和不确定性而非宣称通过。
- Verification method:
  - 执行阶段记录精确命令、退出码、测试数、provider/model、运行时间和脱敏指标；检查 Git diff 无范围外改动。
- Validation evidence: `npx vitest --run packages/coding-agent/test/compaction-subsystem` passed 37 files / 294 tests with 2 files / 8 explicitly gated real-provider tests skipped. The first root `npm test` exposed one related manual-vs-auto race and one transient reftable watcher timeout; after fixing the race, both focused files passed 9/9 and the second root `npm test` passed all workspaces (coding-agent 273 files / 2298 tests passed, 10 files / 57 skipped; AI 123 / 970 passed, 12 / 795 skipped; all remaining workspace suites passed). Full root `npm run build` passed after adding the missing explicit mixed-API generic to the existing Cloudflare AI Gateway provider; online model generation successfully reached models.dev, NVIDIA, OpenRouter, and Vercel through the inherited proxy. Real OpenAI Codex gpt-5.4-mini compaction evaluation passed in 50.7s: 2/2 rounds activated, 0 rejected, 100% F/C/T/P retention, oracle consistent, 34,204 -> 1,031 tokens (97.0% reduction). Real OpenAI Codex gpt-5.5 cache-affinity passed: cold input 6,884/cacheRead 0/4.506s; warm input 1,025/cacheRead 5,888/cacheRead ratio 85.17%/8.635s. Kimi K3 real extraction was also attempted with the CLI proxy dispatcher but timed out at 300s without a report; it is retained as a provider-specific limitation, not substituted by mock evidence. `git diff --check` passed; the pre-existing shared dirty worktree was preserved.
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. Policy unit：gate/strategy truth table，特别覆盖 count=8、大 tool payload、drift/high-risk 在 below-soft 时均 no-trigger。
2. Context identity unit：canonical serialization、historical prefix、正常 tail append、tool schema order、timestamp/audit exclusion、first-difference diagnostics。
3. Transaction integration：activated/rejected/cancelled/shadow/publish-failure 各路径的 publication count、artifact visibility、messages/system fingerprint。
4. Runtime integration：user prompt、tool continuation、queued continuation、idle agent_end、overflow retry、compatible restart、rewind/sibling navigation。
5. Continuity：至少 9 次压缩跨过现有 rebuild cap，验证第 9 次只在下一次合法 gate 中选择 rebuild，且 handoff 保留进行中任务、约束、工具状态和对象引用。
6. Full verification：targeted suites 后运行完整 `npm test` 与 build；任何会写文件的 check 需单独核对 diff。
7. Real provider A/B：固定输入、provider/model、template/tool schema 和节奏，报告 cache/TTFT/cost/activation；文章理论只作为假设，不能替代实验。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- Provider-visible token 序列可能在 adapter/chat template 内才最终形成；仅 JSON hash 不是充分证明。应优先暴露 provider adapter 的确定性序列化/token hook，无法取得时明确 fingerprint 只是逻辑层代理指标。
- 将 gate 移到每次 provider send 前可能与 agent-core 的 continuation/retry 生命周期交叉；必须先用调用顺序测试定位唯一边界，避免递归触发 compactor。
- soft JIT 可能让下一请求首轮多一次 compactor 延迟，但避免空闲时无收益压缩；需以 TTFT 与任务总成本共同评估。
- restart 兼容校验过松会在 sibling 分支复用错误 snapshot，过严又会破坏 cache；必须使用 branch-visible ancestry，不恢复已删除的 branch binding/CAS。
- 当前 worktree 已有大量用户改动，包含 compaction 核心文件与其他任务文档。执行时禁止 reset/stash/checkout 或覆盖；每个 patch 前重读 live diff 并串行集成。
- 真实 provider 可能不报告 cacheRead/cacheWrite，或路由/TTL 噪声较大；此时只能确认 context fingerprint 和调用行为，缓存收益保持 unknown。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-25: Task document created in plan mode.
- 2026-08-25: Read the user-specified Model Infra/Harness article, repository instructions, relevant project learnings, trigger/session/orchestrator/snapshot/cache source, and focused test inventory.
- 2026-08-25: Recorded the architectural decision to separate gate from strategy and to make successful checkpoint activation the only compaction-owned context replacement boundary. No implementation or test execution started.
- 2026-08-25: User authorized execution. Switched the existing task document to execute mode and started T-001 under coordinator ownership; no parallel-ready implementation task exists.
- 2026-08-25: T-001 implemented logical provider-context identity, historical-prefix preservation, and first-difference diagnostics. Focused test passed 4/4 after correcting one duplicate `--run` CLI invocation. Started T-002.
- 2026-08-25: T-002 separated compaction authority from strategy. Focused trigger/runtime/circuit-breaker tests passed 34/34; started T-003.
- 2026-08-25: T-003 moved automatic threshold compaction to provider-request JIT preflight and blocked hard requests after failed activation. T-004 closed refresh/restart/rebuild continuity leaks. Focused runs passed 50/50, boundary 2/2, and activation/restart/rebuild 39/39. Started T-005.
- 2026-08-25: T-005 added exact logical provider-context observation and read-only `/context` attribution without changing request content. Focused observability/cache/runtime tests passed 65/65 and both changed packages built successfully. Started T-006 full and real-provider validation.
- 2026-08-25: T-006 aggregate testing exposed stale-assistant/new-request and manual-vs-auto ownership races; both were corrected with provider-request-pending semantics and abort-and-await manual supersession. Compaction aggregate, second full `npm test`, and full online build passed. OpenAI real compaction retained 100% with 97.0% token reduction; OpenAI warm cache read ratio was 85.17%. Kimi K3 timed out at 300s. Added the verified reusable boundary lesson to `LEARNS.md`.

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Summary: All implementation tasks and repository-local acceptance checks passed. Real OpenAI provider evidence confirms compaction activation/retention and warm-cache reuse; Kimi availability remains provider-specific unknown due a bounded timeout. No Git commit was created.
- Evidence: T-001 through T-006 contain exact focused, aggregate, build, and real-provider evidence. Final focused integration rerun passed 8 files / 67 tests; the task-document validator and `git diff --check` passed.
- Limitations: Logical context fingerprints stop before provider-specific chat-template tokenization. OpenAI real-provider evidence passed, but Kimi K3 timed out at 300 seconds; no claim is made about Kimi retention or cache behavior. The shared worktree contains substantial pre-existing changes, so validation covered the integrated live tree rather than an isolated old-version A/B checkout.
