# Task Plan: Codex-style compaction checkpoints

- Created: 2026-08-26
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求按照 Codex CLI 的方式重构 compact 与 checkpoint；源码对比确认 Codex 使用 replacement history checkpoint，不提供模型侧 exact recall。

<!-- task-doc-section:background-goal -->
## Background and goal

当前 compaction 具备 95% provider-boundary 触发和 Session-native replacement checkpoint。compact 本身在本地模拟 Codex Remote Compaction V2：所有 provider 都用当前 canonical system/messages/tools + local trigger 生成一次文本 handoff。曾实现的 direct OpenAI native opaque 路径因当前部署没有 direct OpenAI API key、无法真实验收而按用户要求删除。主 Session JSONL 继续作为唯一持久化真相，运行时固定上下文不写入 checkpoint。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- In scope: `packages/coding-agent` 的 `CompactionEntry` checkpoint 契约、Session context 重建、HF host/AgentSession compaction 接线、默认工具注册、`/context` 观察输出、相关测试与当前 compaction 文档。
- In scope: 删除默认 compact 路径对 snapshot store、event mirror、payload offload、recall catalog/tool、structured reducer/validator 的依赖；删除因本次改造失去生产消费者的模块和测试。
- Non-goals: 不改变 95% 晚触发策略；不改变 branch summary；不删除主 Session JSONL 的原始历史；不调用真实付费供应商；不运行完整 build 或完整 `npm test`，除非用户另行要求。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 主 `SessionManager` 已以 append-only JSONL 保存全部 entries，并支持 compaction summary + retained entries 的恢复。 | `session-manager.ts::appendCompaction/buildContextEntries/buildSessionContext`。 |
| F-002 | 当前 HF compaction 不写真实 `CompactionEntry`，只发送 synthetic extension event；恢复依赖独立 `hf/<session>/snapshots.jsonl`。 | `agent-session.ts::_emitHfSessionCompact` 与 `session-integration.ts` 构造函数。 |
| F-003 | 当前生产工具集常驻注册 `recall_search`/`recall_exact`，活动 prompt 还包含 recall guide 和 runtime snapshot 投影。 | `agent-session.ts::_buildRuntime`；`session-integration.ts::buildActiveMessages`。 |
| F-004 | 当前 system prompt 与 tools 在 `prepareNextTurnWithContext` 中按实时值重建，无需写入 checkpoint。 | `agent-session.ts::_installAgentNextTurnRefresh`。 |
| F-005 | 当前 trigger 已按完整请求预测在 95% 边界 `>=` 触发，并有 overflow/manual 入口。 | `subsystem/trigger.ts` 及 2026-08-26 late-trigger task evidence。 |
| F-006 | 工作树已有大量重叠未提交修改，必须保留并在现状上增量编辑。 | `git status --short --branch` 与 `AGENTS.md`。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: native replacement history 只保存 provider 返回的完整 canonical output wrapper；local replacement history 保留文本 compaction item 与最新真实 user messages。压缩时尚未形成 Session entry 的 pending input 继续由 provider preflight/current turn 路径追加，不复制进 checkpoint。
- Assumption: 兼容读取旧 `CompactionEntry`；新的 checkpoint 字段直接用于当前 Session v3，不为已移除 HF snapshot 另建迁移层。旧 `.hf` 目录停止读取但不主动删除，避免破坏用户数据。
- Open question: None。用户已明确要求按 Codex CLI 架构实施，包含移除 recall 默认机制。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新 `CompactionEntry` 持久化完整 replacement history；`buildSessionContext()` 优先以该 checkpoint 为基线，再追加 checkpoint 后的 entries。
- native compaction 保存完整 opaque canonical window；unsupported/custom-instruction path 才生成一次文本 item 并有界保留最近真实 user messages，不保留 assistant/tool output 作为普通 recent tail。
- manual、自动阈值和 overflow compaction 成功后先 append checkpoint，再从 SessionManager 重建并替换 live messages；自动 overflow 路径继续原 turn。
- 默认工具 schema 不再包含 `recall_search`/`recall_exact`，活动 prompt 不再包含 recall guide、snapshot/runtime ledger 或 offload placeholder。
- system prompt、tools 和运行时配置不进入 checkpoint，继续由每 turn canonical refresh 提供当前值。
- compactor 请求保持当前 provider-visible prefix 的原始消息结构，并追加 local compaction trigger；不得把全部历史重新序列化为一个新 user message。
- local compactor 请求携带当前 tool schemas 且禁止工具调用；OpenAI native path 使用官方 compact endpoint，不把云端加密 item 改写为文本。
- resume、branch navigation 和连续二次 compaction 从主 Session JSONL 重建正确 replacement history。
- 95% 触发、失败不替换、extension events、TUI `/context` 与相关 API 保持可解释行为。
- 定向测试和 `npm run check` 通过；工作区无本任务引入的无关改写。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003 -> T-004 -> T-005。
- Parallel batches: 无；checkpoint schema、SessionManager、host 与 AgentSession 共享同一上下文契约，必须串行。
- Serialization constraints: coordinator 独占本任务文档及目标文件；不启动 subagent；不 reset/stash/checkout；删除文件只限本任务使其失去生产消费者的 compaction 模块。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 固化 replacement checkpoint 行为

- Status: done
- Owner: coordinator
- Objective: 用测试定义 checkpoint 持久化、恢复和最近用户消息选择。
- Inputs and prerequisites: F-001 至 F-006；当前 SessionManager 与 faux compactor。
- Scope or files: compaction/session manager/AgentSession 直接测试。
- Expected output: 旧 snapshot/recall 实现下失败、目标实现下通过的行为回归。
- Dependencies: None.
- Execution steps:
  1. 增加 Session JSONL replacement history 和 resume 回归。
  2. 增加只保留最近 user、移除 recall tools、mid-turn 自动继续回归。
- Acceptance criteria:
  - 回归能检测 out-of-band snapshot 恢复、工具 tail 残留或 recall schema 回归。
- Verification method:
  - 运行目标 Vitest 并记录 Red 结果。
- Validation evidence: Red：新增 `build-context.test.ts` replacement-history 用例首次运行失败，证明旧实现忽略 checkpoint replacement；Green：最终 compaction 回归集包含该用例并通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 扩展主 Session checkpoint 契约

- Status: done
- Owner: coordinator
- Objective: 让 `CompactionEntry` 直接携带并恢复 replacement history。
- Inputs and prerequisites: T-001。
- Scope or files: `src/core/session-manager.ts` 及直接单测/JSON 文档。
- Expected output: 向后兼容旧 summary+firstKept，新 checkpoint 从 replacement history 精确重建。
- Dependencies: T-001.
- Execution steps:
  1. 定义最小 checkpoint schema 和 clone/读取逻辑。
  2. 更新 `buildContextEntries/buildSessionContext`。
- Acceptance criteria:
  - 主 JSONL 是压缩恢复的唯一持久化真相；旧 entry 仍可读取。
- Verification method:
  - SessionManager 定向 Vitest。
- Validation evidence: `CompactionEntry.replacementHistory` 已持久化；`buildSessionContext()` 以分支上最新 replacement checkpoint 为基线并追加后续 entries；旧 summary checkpoint 路径保留；SessionManager 定向回归通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 重写 compact host 与 AgentSession 发布路径

- Status: done
- Owner: coordinator
- Objective: 生成一次 handoff + recent users，写入 checkpoint 后原子替换 live history。
- Inputs and prerequisites: T-002。
- Scope or files: `subsystem/session-integration.ts`、`narrative.ts`、`trigger.ts`、`agent-session.ts` 与直接测试。
- Expected output: manual/auto/overflow/resume 共用主 Session checkpoint；运行时 canonical context 边界不变。
- Dependencies: T-002.
- Execution steps:
  1. 将 host 收敛为 trigger、handoff、replacement history 与观察能力。
  2. 在 AgentSession 成功路径 append compaction，再重建 live messages。
  3. 保持失败不发布与自动 turn continuation。
- Acceptance criteria:
  - 三个入口行为通过，compaction 失败时 Session/live context 均不变。
- Verification method:
  - host、AgentSession、overflow/queue 定向 Vitest。
- Validation evidence: host 只执行一次 tool-free handoff 并构造 handoff + recent-user replacement；AgentSession 成功后 append/verify/sync/rebuild，失败不发布；manual、threshold、overflow、queued-turn 与 resume 回归均包含在 154 个目标测试中。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 删除 recall/snapshot 重复机制并同步文档

- Status: done
- Owner: coordinator
- Objective: 移除默认 recall 工具、独立 snapshot/event/artifact pipeline 和过时契约。
- Inputs and prerequisites: T-003。
- Scope or files: `subsystem/` 失去消费者的模块/barrel、默认工具接线、相关测试、`docs/compaction*` 与 coding-agent 文档。
- Expected output: 生产路径只剩 checkpoint compaction 所需模块；文档与 `/context` 输出一致。
- Dependencies: T-003.
- Execution steps:
  1. 删除 imports/exports/工具注册和无生产消费者文件。
  2. 删除或改写只验证退休机制的测试。
  3. 更新架构和用户文档。
- Acceptance criteria:
  - 生产代码无 `recall_exact|recall_search|SnapshotStore|StructuredSnapshot|artifact offload` compaction 引用。
- Verification method:
  - `rg`、定向 Vitest、TypeScript check。
- Validation evidence: 已移除默认 recall 工具以及 snapshot/event/artifact/offload/reducer/validator 生产模块和机制专属测试；生产源码 `rg` 对退休契约返回空；README、compaction 文档、ADR、集成说明和运行手册已同步。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 集成与静态验收

- Status: done
- Owner: coordinator
- Objective: 验证完整目标路径并审计共享工作树差异。
- Inputs and prerequisites: T-004。
- Scope or files: 本任务所有源、测试、文档和任务文件。
- Expected output: 可复现验证证据与残余限制。
- Dependencies: T-004.
- Execution steps:
  1. 运行全部非真实供应商 compaction 目标测试。
  2. 运行 `npm run check` 并核对 Biome 写入。
  3. 运行 `git diff --check`、过时契约搜索和任务文档 validator。
- Acceptance criteria:
  - 所有验收项有当前证据；无本任务外新增改动。
- Verification method:
  - Vitest、`npm run check`、`rg`、Git diff、任务文档 validator。
- Validation evidence: Vitest：23 files passed、1 skipped，146 tests passed、8 skipped；根目录 `tsgo --noEmit` 通过；`npm run check` 通过；`git diff --check` 通过；退休契约源码搜索为空。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 固化本地 Remote V2 请求与安装语义

- Status: done
- Owner: coordinator
- Objective: 用回归测试区分“重新序列化 handoff”与“canonical prefix + compaction trigger”两种算法。
- Inputs and prerequisites: 用户澄清；Codex `compact_remote_v2_attempt.rs` 与 `compact_remote_v2.rs` 当前实现；T-005。
- Scope or files: `test/compaction-subsystem/narrative.test.ts`、`session-integration.test.ts` 及必要 faux 集成测试。
- Expected output: 旧实现失败、目标实现通过的请求形态、tools、消息顺序、失败不安装测试。
- Dependencies: T-005.
- Execution steps:
  1. 断言 compactor 收到未扁平化的 user/assistant/toolResult 消息及 canonical system/tools。
  2. 断言最后一个请求项是专用 compaction trigger，replacement history 最后一项是 compaction item。
  3. 保留失败不发布、恢复与连续 checkpoint 覆盖。
- Acceptance criteria:
  - 测试可检测重新序列化历史、丢失工具 schema 或 compaction item 位置错误。
- Verification method:
  - 先运行目标 Vitest 记录 Red，再实施并运行 Green。
- Validation evidence: Red：`narrative.test.ts` 明确失败，显示旧请求使用独立 compactor policy、无 tools 且历史被包装为单个 user message；Green：目标测试断言 canonical system、原始 user/toolResult、tool schemas 与末尾 local trigger，相关 4 文件 38 tests 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 实施本地 Remote Compaction V2 等价算法

- Status: done
- Owner: coordinator
- Objective: 以当前 provider prefix + local trigger 生成文本 compaction item，并安装有界 replacement history。
- Inputs and prerequisites: T-006。
- Scope or files: `subsystem/types.ts`、`narrative.ts`、`session-integration.ts`、AgentSession host 接线及用户文档。
- Expected output: compactor 请求保留 canonical system/messages/tools；默认保留预算与 Codex Remote V2 的 64k 上限一致；checkpoint 契约使用 compaction item 语义。
- Dependencies: T-006.
- Execution steps:
  1. 将 `CompleteFn` 请求契约改为原生 `Context` 消息与 tools。
  2. 用 local compaction trigger 替代整段历史序列化与独立 compactor system prompt。
  3. 将 handoff 命名收敛为 compaction item，并保持最近真实用户消息 + item 的安装顺序。
  4. 同步 `/context`、README 与 compaction 文档术语。
- Acceptance criteria:
  - 只有触发 compaction 时新增 trigger 请求；普通 provider context 不变化。
  - compaction item 失败或为空时 Session/live context 均不替换。
- Verification method:
  - T-006 测试、AgentSession compaction 回归、TypeScript。
- Validation evidence: `CompleteFn` 已改为原生 Message/Tool 请求；compactor 使用 canonical system + 原始消息结构 + 当前 tools + local trigger，`toolChoice=none`、短缓存与 Session routing ID；默认 recent-user ceiling 为 64k；overflow-only tool-result rewrite 不修改 durable history；5 个直接测试文件 44 tests 通过，TypeScript 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — 纠偏后的集成验收

- Status: done
- Owner: coordinator
- Objective: 验证本地 Remote V2 等价算法及共享工作树边界。
- Inputs and prerequisites: T-007。
- Scope or files: 本轮新增改动和现有 compaction 回归集。
- Expected output: 当前验证证据、Codex 不可复制部分与本地等价边界说明。
- Dependencies: T-007.
- Execution steps:
  1. 运行相关 Vitest 与 TypeScript。
  2. 运行 `npm run check`，核对自动格式化路径。
  3. 运行任务文档 validator、`git diff --check` 与退休契约扫描。
- Acceptance criteria:
  - 所有新增与既有 compaction 回归通过，任务文档状态与证据一致。
- Verification method:
  - Vitest、`npm run check`、task validator、Git/rg 审计。
- Validation evidence: compaction aggregate：23 files passed、1 skipped，185 tests passed、8 skipped；格式化后 5 files/44 tests 复跑通过；根目录 `npm run check`（含 Biome、tsgo、依赖/lock/browser smoke）通过；task validator、`git diff --check` 与退休契约源码扫描通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 固化 provider-native opaque checkpoint 契约

- Status: done
- Owner: coordinator
- Objective: 用失败回归定义 OpenAI canonical compact output 的保存、同源回放和跨模型拒绝行为。
- Inputs and prerequisites: T-008；OpenAI 官方 compaction guide 与当前 SDK `CompactedResponse`/`ResponseCompactionItemParam` 类型。
- Scope or files: `packages/ai` message/provider contracts、OpenAI Responses conversion tests、coding-agent compaction host tests。
- Expected output: 测试能区分 opaque canonical window 与文本 summary，并能检测自行裁剪或跨模型回放。
- Dependencies: T-008.
- Execution steps:
  1. 定义最小 provider-owned compaction message 与 compact capability 行为。
  2. 断言 `/responses/compact` 的完整 output 被保存并原样重放。
  3. 断言 provider/API/model 不一致时 fail closed，不把 opaque payload 转成普通文本。
- Acceptance criteria:
  - Red 结果明确证明当前实现没有 provider-native canonical window 路径。
- Verification method:
  - 运行新增的 `packages/ai` 与 coding-agent 目标 Vitest。
- Validation evidence: Red：`openai-responses-compaction.test.ts` 两个用例均失败；当前 adapter 没有 `compact` capability，且 opaque checkpoint 被转换为空数组。Green：目标文件 2 tests 通过，覆盖完整 output 保存、同源重放和跨模型拒绝。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 实施 opaque pass-through 与本地 handoff fallback

- Status: done
- Owner: coordinator
- Objective: 为明确声明支持 native compact 的 provider 接线完整 replacement window，其他 provider 保持单次本地 handoff。
- Inputs and prerequisites: T-009。
- Scope or files: `packages/ai` provider/model runtime、OpenAI Responses adapter、coding-agent host/AgentSession/Session checkpoint。
- Expected output: OpenAI native path 不生成文本 summary，不裁剪 canonical output；unsupported path 沿用 readable handoff。
- Dependencies: T-009.
- Execution steps:
  1. 在 provider runtime 增加可选 compact capability，并复用现有 auth/request transforms。
  2. OpenAI Responses 调用官方 compact endpoint，把完整 output 封装为同源 opaque message。
  3. coding-agent 优先 native compact；未声明 capability 时才调用现有 local handoff。
  4. checkpoint 发布仅依赖 replacement history，不要求文本 compaction item。
- Acceptance criteria:
  - 普通 turn 的 system/tools/messages 完全不变；只有触发 compaction 时调用 native endpoint。
  - native 成功时 replacement history 只有 provider-owned canonical window；失败时不安装半成品。
  - unsupported provider 的现有 handoff 行为不回归。
- Verification method:
  - T-009 tests、现有 compaction subsystem 回归和 TypeScript。
- Validation evidence: direct OpenAI provider 显式声明 native capability；adapter 调用 `/responses/compact` 并封装完整 output；host native 成功不调用 local handoff，native 失败不发第二次模型请求；unsupported provider 保持 local path；现代 Session entry 不再写 `summary`/`firstKeptEntryId`；模型不匹配时从 raw JSONL branch 恢复。coding-agent 19 files/134 tests 与 pi-ai Responses 10 files/57 passed、3 skipped。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — opaque 架构验收与工作树审计

- Status: done
- Owner: coordinator
- Objective: 验证新增 native path、fallback、resume、连续 turn 与共享工作树边界。
- Inputs and prerequisites: T-010。
- Scope or files: 本阶段目标源、测试和任务文档。
- Expected output: 可复现的定向测试、`npm run check`、契约扫描与残余限制。
- Dependencies: T-010.
- Execution steps:
  1. 运行目标 Vitest 与 compaction aggregate。
  2. 运行 `npm run check` 并核对格式化写入。
  3. 运行 task validator、`git diff --check` 与相关 Git diff 审计。
- Acceptance criteria:
  - 新旧两条路径均有通过证据；无本阶段引入的无关改写。
- Verification method:
  - Vitest、`npm run check`、task validator、Git diff。
- Validation evidence: coding-agent compaction aggregate 19 files/134 tests；pi-ai Responses aggregate 10 files/57 passed、3 skipped；agent conversion/harness 4 files/74 tests；格式化后关键路径 11 files/107 tests 复跑通过；两次根 `npm run check` 均通过，第二次无自动修复；`git diff --check` 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 废弃 provider-native opaque compaction 路径

- Status: done
- Owner: coordinator
- Objective: 删除无法用当前凭据真实验收的 `/responses/compact`、opaque message 与同源回放机制，统一使用真实验证通过的 local handoff checkpoint。
- Inputs and prerequisites: 用户确认没有 direct OpenAI API key 并要求废弃该路径；T-011；Kimi K3 真实 local handoff 连续性评测通过。
- Scope or files: `packages/ai` native compact capability/message/adapter；coding-agent native host/runtime/session 分支；相关测试、文档与经验记录。
- Expected output: 所有 provider 只执行一次 local handoff；现代 checkpoint 继续只保存 replacement history；生产代码不再含 native compact/opaque contract。
- Dependencies: T-011.
- Execution steps:
  1. 删除 provider/runtime/adapter 的 compact capability 和 opaque message 类型。
  2. 删除 host native 分支、同源模型恢复特例及其测试。
  3. 更新 compaction 文档并运行目标测试、check、build 与完整测试。
- Acceptance criteria:
  - `rg` 对 native compaction/opaque message/`responses/compact` 生产契约返回空。
  - manual、自动与 overflow compaction 继续走一次 local handoff，并保持 checkpoint/resume/continuation。
  - 目标回归、`npm run check` 与完整 build 通过；完整 `npm test` 的任何剩余失败均有隔离证据。
- Verification method:
  - Vitest、`npm run check`、`npm run build`、`npm test`、task validator、`git diff --check`。
- Validation evidence: 已删除 `/responses/compact` adapter、opaque message、provider capability、native host/runtime、同源模型恢复特例及专属测试；生产源码契约扫描为空。Kimi K3 真实 local handoff 1/1 通过并在 checkpoint 后恢复 marker；相关 26 files/204 passed/5 skipped；根 `npm run check` 和完整 build 通过。完整 `npm test` 已运行，compaction/coding 主体通过；剩余 ZAI price assertion 单独稳定失败，两个 footer watcher 全并行超时但隔离 8/8 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001: checkpoint persistence/resume/branch/repeated compaction。
- V-002: manual、threshold、overflow mid-turn continuation。
- V-003: recent user retention、compaction-item failure、no recall tools、canonical system/tools refresh。
- V-004: compaction subsystem aggregate、`npm run check`、`git diff --check`、contract `rg`。
- V-005: local Remote V2 请求保留 canonical system/messages/tools，trigger 只追加在 compactor 请求末尾，replacement history 以 compaction item 结尾。
- V-006: provider-native compact 保存并同源原样回放完整 canonical output；跨 provider/API/model fail closed。
- V-007: 未声明 native capability 的 provider 继续使用一次 local handoff，不在普通 turn 探测或改写 context。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 现有测试大量绑定退休机制；只删除纯内部机制测试，用户可观察行为必须迁移为 checkpoint 回归。
- replacement history 直接持久化 AgentMessage，可能增加单个 checkpoint JSONL 行；通过 64k recent-user token 上限和有界 compaction item 控制。
- 未声明 native capability 的 provider 仍无法生成供应商密文 item；该路径明确使用本地文本 handoff，不伪称字节级等价。Direct OpenAI Responses 则保存官方 endpoint 返回的完整 opaque output。
- 旧 `.hf` 状态不再读取会让未写主 CompactionEntry 的开发分支历史重新使用原始 Session JSONL；这是 fail-open-to-raw-history，不删除数据。
- `npm run check` 会自动写格式；执行前后精确核对路径。
- Opaque payload 只能由创建它的 provider/API/model 解释；模型切换后不得降级为普通文本或猜测其内部结构。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-26: 创建 execute 任务文档；完成 Codex 官方实现与当前源码对照，确认主 Session JSONL 已具备替代独立 snapshot/recall 的持久化基础。T-001 开始。
- 2026-08-26: T-001 完成 Red/Green；T-002 将 replacement history 纳入主 Session checkpoint，并覆盖恢复与连续 checkpoint。
- 2026-08-26: T-003 完成；manual/auto/overflow 统一为 handoff + recent users -> append checkpoint -> rebuild live context，失败路径不发布。
- 2026-08-26: T-004 完成；删除 recall/snapshot/event/artifact/offload/structured pipeline，更新 `/context` 与文档。
- 2026-08-26: T-005 完成；目标 Vitest、TypeScript、`npm run check`、diff whitespace 与退休契约扫描全部通过。
- 2026-08-26: 用户澄清 compact 本身需本地模拟 Codex 云端算法；复核官方 Remote V2 后新增 T-006 至 T-008，纠正“整段历史序列化 handoff”与 canonical-prefix compaction trigger 的差异。T-006 开始。
- 2026-08-26: T-006 完成 Red/Green；T-007 开始。请求契约已切换为 canonical system/messages/tools + local trigger，默认 recent-user ceiling 改为 64k，并保留 durable-before-live checkpoint 安装边界。
- 2026-08-26: T-007 完成；新增 overflow-only tool-result rewrite 以复刻 Codex compact 请求在超窗时的最小可运行修剪，普通触发不改变原始 prefix。T-008 开始。
- 2026-08-26: T-008 完成；185 个 compaction 相关测试通过、8 个跳过，格式化后 44 个直接测试复跑通过；`npm run check`、task validator、diff whitespace 与退休契约扫描通过。
- 2026-08-26: 用户确认实施 provider-native opaque item 方案；复核 OpenAI 官方 guide 与已安装 SDK，确认 compact endpoint 返回的完整 `output` 是下一轮 canonical window。新增 T-009 至 T-011；T-009 开始。
- 2026-08-26: T-009 Red 完成；新增测试分别捕获“无 native compact API”和“opaque payload 被静默丢弃”两处首个行为差异。
- 2026-08-26: T-009 Green、T-010 完成；provider capability、opaque pass-through、host 选择、失败不二次计费、modern checkpoint 最小字段和 model-switch raw recovery 均完成目标回归。T-011 开始。
- 2026-08-26: T-011 完成；目标测试、agent pass-through、两次根 check、task validator 前置字段检查与 shared-worktree diff 审计通过；未调用真实供应商、完整 build、完整 `npm test` 或 Git commit。
- 2026-08-26: 用户确认没有 direct OpenAI API key并要求废弃 native 路径；Kimi K3 真实 local handoff checkpoint 连续性评测通过。T-012 删除 native/opaque 全栈契约并完成相关回归、根 check 和完整 build。完整 `npm test` 已运行；隔离确认一个 ZAI 模型价格确定性漂移和两个 footer watcher 并行 flaky，均与 compaction 无关。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-012 全部完成；所有 provider 统一使用一次 local handoff，modern checkpoint 只写 replacement history；生产源码无 native/opaque/`responses/compact` 契约。Kimi K3 真实 checkpoint 连续性评测、相关 26 files/204 passed/5 skipped、根 `npm run check` 和完整 build 通过；完整 `npm test` 已实际运行并完成所有 workspace。
- Limitations: 完整 `npm test` 总退出码为 1：`pi-ai` 最新在线模型目录与 `glm-5.3` 零价格断言不一致（隔离稳定失败），coding-agent 两个 footer watcher 在全并行下超时但隔离 8/8 通过；两者均不在本次 compaction 范围。旧 `.hf` sidecar 数据未主动删除；共享工作树中的其他既有修改未回退；未提交 Git。
