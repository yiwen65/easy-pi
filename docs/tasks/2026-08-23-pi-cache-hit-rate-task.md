# Task Plan: 提高 Pi Cache Hit Rate

- Created: 2026-08-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求基于 `docs/harness/cache hit rate.md` 制定实施计划并执行。

<!-- task-doc-section:background-goal -->
## Background and goal

Pi 已在 Provider adapter 中解析 cache read/write，并为 Anthropic、OpenAI、Bedrock 等实现部分缓存控制；但 durable `AgentHarness` 默认没有把 durable session ID 传给 Provider，导致依赖 `sessionId` 的 prompt cache key 或路由亲和能力无法默认工作。同时，TUI 的 `CH` 实际计算的是最新请求的 cached-input token ratio，不是请求级 Cache Hit Rate。

本轮目标是在不引入最终答案语义缓存、不调用真实付费 Provider 的前提下，完成一组低风险、可回归的基础优化：修复 durable harness 的缓存亲和身份传递，避免长 OpenAI prompt cache key 的前缀截断碰撞，并把现有缓存指标改成准确语义，从而直接提高可复用请求的命中机会并建立可信观测口径。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

Scope:

- durable `AgentHarness` 的默认 `sessionId` 传播及显式覆盖语义；
- OpenAI prompt cache key 超长时的稳定、限长且保留差异的编码；
- TUI/README 中最新 cached-input token ratio 的命名纠正；
- faux/provider 单元测试与现有定向测试验证。

Non-goals:

- 不实现最终答案精确缓存或语义缓存；
- 不实现跨 tenant/session 的共享 cache cohort；当前缺少授权作用域输入，默认跨 session 共享不安全；
- 不在本轮引入结构化 system prompt 分段、Gemini 显式 cached-content、通用工具缓存或 telemetry 全链路接线；这些需要独立接口设计和 workload 基线；
- 真实 Provider 验证仅使用用户已明确授权且本机已配置的 `openai-codex`，通过显式 `PI_REAL_MODEL_EVAL=1` 门控运行最小双请求测试；不打印或持久化凭证；
- 不修改或清理与本任务无关的现有工作树改动。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | legacy Agent 默认向 Provider 传入 session ID。 | `packages/agent/src/agent.ts:459-466` |
| F-002 | durable AgentHarness 仅复制并转发调用方提供的 `streamOptions`，未根据 session metadata 补 `sessionId`。 | `packages/agent/src/harness/agent-harness.ts:400-420,1590-1603` |
| F-003 | faux provider 只有在存在 `options.sessionId` 且未关闭缓存时才计算 cache read/write。 | `packages/ai/src/providers/faux.ts:229-254` |
| F-004 | OpenAI prompt cache key 超过 64 字符时当前直接保留前 64 字符。 | `packages/ai/src/api/openai-prompt-cache.ts:1-8` |
| F-005 | TUI 的 `CH` 计算公式是 `cacheRead / (input + cacheRead + cacheWrite)`，对应 cached-input token ratio。 | `packages/coding-agent/src/modes/interactive/components/footer.ts:57-76,145-153` |
| F-006 | 工作树已有大量其他会话的修改，且 `agent-harness.ts` 已被修改。 | 2026-08-23 `git status --short` 输出；实施必须采用定点编辑并逐文件核对 diff。 |
| F-007 | 用户已明确授权调用真实 Provider；本机模型列表显示 `openai-codex/gpt-5.5` 可用。 | 用户消息“授权调用真实真实 Provider进行验证”；`./pi-test.sh --list-models` 输出。 |
| F-008 | 用户明确要求恢复验证并改用 `openai-codex/gpt-5.6-luna`，且本机模型列表包含该模型。 | 用户消息“继续OpenAI Codex真实验证，用luna 模型”；既有 `./pi-test.sh --list-models` 输出。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: session metadata ID 是 durable harness 最安全的默认缓存亲和范围；影响是只改善同 session 的路由/缓存复用，不进行未经授权的跨 session 共享。通过显式 `streamOptions.sessionId` 覆盖测试验证。
- Assumption: 对超长 OpenAI key 保留可读前缀并追加确定性 hash，比直接截断更能避免共享前 64 字符的不同 session 被路由到同一 key；通过碰撞回归测试验证，不声称其改变 Provider 的精确前缀安全校验。
- Assumption: 将 UI 标识从 `CH` 改为 `CR`（cache-read ratio）是语义纠正；公式保持不变，因此不会改变计费或执行行为。
- Assumption: 两次请求使用同一 durable session、相同且超过 Provider 最小缓存长度的 system 前缀，可验证真实 provider prefix cache read；测试只断言 warm request 的 `cacheRead > 0`，不要求 OpenAI 报告 cache write。
- Open question: 无阻塞性开放问题。更大的 Prompt 分层和跨 session cohort 设计延后到有真实 workload、授权作用域和更完整 Provider 基准后处理。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- durable AgentHarness 在调用方未提供 `streamOptions.sessionId` 时使用 `session.getMetadata().id`，显式值保持优先。
- 使用 faux provider 的连续同-session 请求能观测到第二次请求 `cacheRead > 0`；关闭缓存时不产生 cache read/write。
- 两个共享前 64 字符但后缀不同的超长 OpenAI cache key 输出不同，且每个输出不超过 64 个 Unicode code point；短 key 保持不变。
- TUI 和 coding-agent README 不再把 cached-input token ratio 表述为请求级 Cache Hit Rate，显示符号统一为 `CR`。
- 相关定向测试通过；代码改动后 `npm run check` 通过，或如被已有无关改动阻塞则记录准确证据。
- 显式门控的真实 `openai-codex/gpt-5.6-luna` 双请求验证通过：冷请求成功，warm 请求报告 `cacheRead > 0`，并记录实际 cached-input ratio、Token 和延迟；凭证与响应正文不写入任务文档。
- 只修改任务文档及本任务直接相关文件；不覆盖其他会话改动。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: `T-001 -> T-002 -> T-004 -> T-007 -> T-005 -> T-006`; `T-003 -> T-004`。真实调用暴露 provider message 含 `undefined` 时 durable persistence 失败，T-007 先修复并回归，再恢复 T-005。
- Parallel batches: 由于当前共享工作树存在未提交且重叠的 `agent-harness.ts` 修改，本轮由 coordinator 串行执行；不创建基于 HEAD 的隔离 writer worktree，以免丢失或覆盖现有改动。
- Serialization constraints: `npm run check` 可能自动改写文件，必须在全部定点修改完成后单独运行，并立即核对 `git status` 与任务相关 diff。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 纠正缓存观测指标语义

- Status: done
- Owner: coordinator
- Objective: 将当前最新请求的 cached-input token ratio 从误导性的 Cache Hit Rate/`CH` 改为 cache-read ratio/`CR`，公式不变。
- Inputs and prerequisites: F-005；相关 TUI、README 和测试。
- Scope or files: `packages/coding-agent/src/modes/interactive/components/footer.ts`; `packages/coding-agent/src/modes/interactive-grok/components/grok-stats-bar.ts`; `packages/coding-agent/README.md`; 对应定向测试。
- Expected output: 内部字段、注释、UI 符号和文档统一使用 cached-input/cache-read ratio 语义。
- Dependencies: None.
- Execution steps:
  1. 完整读取待改源文件和测试。
  2. 定点重命名内部字段和 UI 标签，不改变计算公式。
  3. 更新精确断言与 README 描述。
- Acceptance criteria:
  - 不再出现 `latestCacheHitRate` 或 `CHxx%` 的当前 TUI 实现/断言。
  - 原有 25%/90% 示例数值保持不变，仅标签改变。
- Verification method:
  - 运行 footer 与 Grok stats bar 定向测试。
  - `rg` 检查旧命名残留。
- Validation evidence: `footer-width.test.ts` 9/9 passed；`grok-shell-components.test.ts` 17/17 passed；定点 `rg` 未发现旧 `latestCacheHitRate`、`CH<ratio>` 或误导性 cache hit rate 表述。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 为 durable AgentHarness 注入 session cache affinity

- Status: done
- Owner: coordinator
- Objective: 让 durable harness 默认使用 durable session ID 作为 Provider session/cache affinity，同时保留显式覆盖和 `cacheRetention: none` 语义。
- Inputs and prerequisites: F-001、F-002、F-003；T-001 完成后使用准确指标解释测试结果。
- Scope or files: `packages/agent/src/harness/agent-harness.ts`; 最小相关 agent/coding-agent harness 测试。
- Expected output: 默认 stream options 含 metadata session ID；显式 session ID 不被覆盖；faux 热请求报告 cache read。
- Dependencies: T-001.
- Execution steps:
  1. 完整读取 `agent-harness.ts` 和选定测试文件。
  2. 在异步 `AgentHarness.create()` 边界补默认 `sessionId`，避免构造器异步化。
  3. 增加默认值、覆盖值和 faux 热请求回归测试。
- Acceptance criteria:
  - 默认、显式覆盖和关闭缓存三条路径均有测试。
  - 不改变 legacy Agent 行为。
- Verification method:
  - 运行选定 agent harness/coding-agent harness 测试。
- Validation evidence: `agent-harness-scaffold.test.ts` 7/7 passed，覆盖默认 session ID、显式覆盖、faux 冷写/热读和 `cacheRetention: none`；`server/create-harness.test.ts` 12/12 passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 防止超长 OpenAI cache key 前缀截断碰撞

- Status: done
- Owner: coordinator
- Objective: 在 64 code-point 限制内保留稳定前缀和完整 key 的确定性 hash 差异。
- Inputs and prerequisites: F-004；现有 OpenAI prompt cache key 测试。
- Scope or files: `packages/ai/src/api/openai-prompt-cache.ts`; `packages/ai/test/openai-completions-prompt-cache.test.ts` 或更小的专用测试。
- Expected output: 短 key 无变化；长 key 确定、限长、后缀差异可区分。
- Dependencies: None.
- Execution steps:
  1. 完整读取 helper 和测试。
  2. 复用现有 browser-safe deterministic hash helper，避免 Node-only 依赖。
  3. 添加长度、稳定性和共享长前缀差异测试。
- Acceptance criteria:
  - 输出最多 64 Unicode code point。
  - 同输入稳定；不同长后缀输出不同；短 key 原样返回。
- Verification method:
  - 运行 OpenAI prompt cache 定向测试。
- Validation evidence: `openai-completions-prompt-cache.test.ts` 16/16 passed，覆盖短 key 原样、长 key 确定性、共享 64 字符前缀的不同后缀、64 code-point 上限及 Unicode。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 集成验证与计划收口

- Status: done
- Owner: coordinator
- Objective: 验证三个改动共同满足任务目标且未污染其他会话改动。
- Inputs and prerequisites: T-002、T-003 完成。
- Scope or files: 本任务全部改动；任务文档。
- Expected output: 定向测试、静态检查、完整 `npm run check` 结果和最终状态证据。
- Dependencies: T-002, T-003.
- Execution steps:
  1. 运行所有定向测试。
  2. 运行 `npm run check`，核对可能自动改写的文件。
  3. 检查 task-related diff、旧标识残留和工作树边界。
  4. 更新任务状态、执行日志和最终验证结果。
- Acceptance criteria:
  - 所有本任务 acceptance criteria 有当前证据。
  - 文档 validator 通过。
- Verification method:
  - task document validator；定向 Vitest；`npm run check`; `git diff --check` 和定点 diff 审查。
- Validation evidence: 最终定向回归：agent 7/7、ai 16/16、coding-agent 38/38 passed；`npm run check` 全链路通过（Biome、依赖/导入/锁文件检查、tsgo、browser smoke），Biome 仅格式化本任务测试 `agent-harness-scaffold.test.ts`；任务路径 `git diff --check` 通过；旧 `CH`/`latestCacheHitRate` 定点检索无残留。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 规范化 Provider assistant message 的 durable JSON

- Status: done
- Owner: coordinator
- Objective: 修复 provider 返回可选 `undefined` 字段时 durable AgentHarness 在持久化前抛 `Durable payload contains undefined` 的缺陷。
- Inputs and prerequisites: T-004 完成；T-005 首次真实运行的稳定失败；已有 faux helper 可构造同类消息。
- Scope or files: `packages/agent/src/harness/agent-harness.ts`; `packages/agent/test/harness/agent-harness-scaffold.test.ts`；任务文档。
- Expected output: Provider message 在持久化边界深度移除 object property 的 `undefined`，不改变定义值、usage 或返回语义。
- Dependencies: T-004.
- Execution steps:
  1. 用未清洗的 faux assistant message 保留最小失败回归。
  2. 在 provider→durable entry 的最早边界规范化 message。
  3. 运行回归和邻近 harness 测试，再恢复真实验证。
- Acceptance criteria:
  - 回归在修复前以相同 `SessionError` 失败，修复后通过。
  - 持久化后的 assistant message 不含 object property `undefined`。
  - 已定义内容、usage 和 stopReason 保持不变。
- Verification method:
  - `agent-harness-scaffold.test.ts` 定向测试；原始真实 Provider 命令复跑。
- Validation evidence: 修复前：真实 opt-in 测试 1/1 failed，且未清洗 faux 回归 2/7 failed，均为 `SessionError: Durable payload contains undefined`，首个失败边界为 `AgentHarness.runAssistantStep -> appendOwnedEntry -> Session.commitEntry`；在 provider→durable 边界深度移除 object property `undefined` 后，faux 回归 7/7 passed。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 真实 Provider cache affinity 验证

- Status: done
- Owner: coordinator
- Objective: 使用用户指定的真实 `openai-codex/gpt-5.6-luna` 验证 durable AgentHarness 默认 session affinity 能产生真实 cache read。
- Inputs and prerequisites: T-004 完成；F-007；本机 OAuth 配置由 ModelRuntime 读取但不输出。
- Scope or files: 新增一个 `PI_REAL_MODEL_EVAL=1` 门控的 targeted eval test；任务文档记录脱敏指标。
- Expected output: 两次相同长稳定前缀的 durable harness 请求均成功，第二次 `cacheRead > 0`，输出仅包含 usage/latency 摘要。
- Dependencies: T-007.
- Execution steps:
  1. 新增默认 skip、显式 opt-in 的真实 Provider 定向测试。
  2. 先验证未设置 opt-in 时测试 skip，不触发网络。
  3. 设置 `PI_REAL_MODEL_EVAL=1` 仅运行该文件，记录真实 usage 与延迟。
- Acceptance criteria:
  - 默认测试运行不调用真实 Provider。
  - opt-in 运行仅调用 `openai-codex/gpt-5.6-luna` 两次，无工具、副作用或凭证输出。
  - warm 请求 `cacheRead > 0` 且计算 cached-input ratio。
- Verification method:
  - 定向 Vitest 默认 skip；随后 `PI_REAL_MODEL_EVAL=1` 定向运行。
- Validation evidence: 默认门控检查 1/1 skipped。Luna SSE opt-in 1/1 passed：cold `input=6884, output=9, cacheRead=0, elapsedMs=2403`；warm `input=1025, output=21, cacheRead=5888, cacheWrite=0, cacheReadRatio=0.8517, elapsedMs=1837`。此前 `fetch failed` 的直接原因是 standalone eval 未安装 coding-agent 的 `configureHttpDispatcher()`，导致绕过 EnvHttpProxyAgent 后连接 `chatgpt.com:443` 超时；接入生产 dispatcher 后同命令通过。未打印凭证或响应正文。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 真实验证后最终收口

- Status: done
- Owner: coordinator
- Objective: 复核真实指标、代码质量、任务边界和权威文档状态。
- Inputs and prerequisites: T-005 完成。
- Scope or files: 本任务相关文件与任务文档。
- Expected output: 最终 validator、定向检查和限制说明。
- Dependencies: T-005.
- Execution steps:
  1. 复核运行输出不含凭证或响应正文。
  2. 对新增测试运行定向静态检查和 `npm run check`。
  3. 更新最终状态与限制。
- Acceptance criteria:
  - 所有任务 done，权威文档 validator 通过。
  - 真实验证结论不超出实际 Provider 样本。
- Verification method:
  - targeted test、`npm run check`、`git diff --check`、task document validator。
- Validation evidence: 最终定向测试 agent 7/7、ai 16/16、coding-agent 38/38 passed，real eval 默认 1/1 skipped；Luna opt-in 1/1 passed；`npm run check` 全阶段通过且 Biome 无改写；任务路径 `git diff --check` 通过。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- TUI：运行 `footer-width.test.ts` 和 `grok-shell-components.test.ts`，确认比例数值不变、标签改为 `CR`。
- Harness：使用 faux provider 或 stream spy 验证默认 session ID、显式覆盖、第二请求 cache read、`cacheRetention: none`。
- Provider helper：运行 OpenAI prompt cache key 定向测试，覆盖短 key、Unicode code-point 上限、长前缀差异和确定性。
- 真实 Provider：新增默认 skip 的 opt-in 测试；仅在命令显式设置 `PI_REAL_MODEL_EVAL=1` 且指定 Luna 时调用两次 `openai-codex/gpt-5.6-luna`。
- 集成：按仓库要求运行 `npm run check`；不运行全量 `npm test`，因为仓库规则禁止默认触发可能使用真实 Provider 的 e2e 集合。
- 变更边界：运行 `git diff --check`，并只审查任务相关路径；共享工作树的既有修改不作为本任务验证结果。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- `agent-harness.ts` 已有其他会话未提交修改：采用唯一小块替换，不格式化相邻代码；修改前后核对精确 diff。
- `npm run check` 可能自动格式化共享工作树：运行前记录状态，运行后只接受本任务文件的预期变化，发现其他改写立即记录并停止扩散。
- cache affinity 只能提高具备相关 Provider 能力且存在重复前缀的请求；faux 测试证明接线和因果方向，不代表生产收益数值。
- UI 符号变化是可见行为，但它纠正了指标语义；README 与测试同步更新。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-08-23: Task document created.
- 2026-08-23: 完成仓库与方法论证据检查；确定本轮执行低风险基础优化，较大 Prompt 分层、显式 Gemini 缓存和语义缓存列为 non-goals。
- 2026-08-23: T-001 -> in_progress（owner: coordinator）；开始纠正 TUI 缓存指标语义。
- 2026-08-23: T-001 -> done；footer-width 9/9、Grok shell 17/17 通过，旧指标命名定点检索无残留。
- 2026-08-23: T-002 -> in_progress（owner: coordinator）；开始接入 durable session cache affinity。
- 2026-08-23: T-002 首次 faux 回归发现测试夹具含显式 `undefined`，被 durable JSON 校验拒绝；改用剔除可选 undefined 字段的测试消息，未改变产品持久化语义。
- 2026-08-23: T-002 -> done；AgentHarness scaffold 7/7、coding-agent create-harness 12/12 通过，faux 第二轮确认 `cacheRead > 0`，禁用缓存路径读写均为 0。
- 2026-08-23: T-003 -> in_progress（owner: coordinator）；开始修复超长 OpenAI cache key 截断碰撞。
- 2026-08-23: T-003 -> done；OpenAI prompt cache 定向测试 16/16 通过，长 key 使用可读前缀加完整输入的确定性 hash。
- 2026-08-23: T-004 -> in_progress（owner: coordinator）；开始集成验证与变更边界审查。
- 2026-08-23: 最终定向回归通过：agent 7/7、ai 16/16、coding-agent 38/38；`git diff --check` 通过。
- 2026-08-23: `npm run check` 通过全部阶段；Biome 报告并格式化 1 个文件，经 mtime 与 diff 核对为本任务测试 `packages/agent/test/harness/agent-harness-scaffold.test.ts`，检查前后工作树路径集合一致。
- 2026-08-23: T-004 -> done；所有任务 acceptance criteria 均有证据，未调用真实 Provider。
- 2026-08-23: 最终文档首次校验发现 Overall status 使用了不允许的 `completed`；改为 `done` 后 task document validator 通过。
- 2026-08-23: 用户明确授权真实 Provider 验证；复用本权威文档，新增 T-005/T-006，Overall status 重新进入 in_progress。
- 2026-08-23: `./pi-test.sh --list-models` 确认 `openai-codex/gpt-5.5` 可用；T-005 -> in_progress（owner: coordinator）。
- 2026-08-23: 新增默认 skip 的 `real-cache-affinity-eval.test.ts`；无 opt-in 运行 1/1 skipped，未触发网络。
- 2026-08-23: T-005 首次 opt-in 真实运行 1/1 failed（33.09s）：真实响应到达后 `SessionError: Durable payload contains undefined`，失败位于 provider response 持久化边界，第二次 warm 请求未执行。
- 2026-08-23: T-005 -> blocked；新增 T-007 -> in_progress（owner: coordinator），以同栈 faux 回归定位并修复 durable JSON 规范化。
- 2026-08-23: T-007 修复前最小 faux 回归稳定复现 2/7 failed，同为 `Durable payload contains undefined`；证明失败与真实网络、OAuth、模型输出内容无关。
- 2026-08-23: T-007 -> done；provider response 在 durable entry 写入前深度移除 object property `undefined`，faux 回归 7/7 passed。
- 2026-08-23: T-005 blocked -> in_progress；阻塞条件已解除，重新执行真实 Provider 验证。
- 2026-08-23: T-007 后 OpenAI Codex 真实验证未再触发 durable JSON 错误，但 3 次首请求分别在 auto/SSE transport 以 `fetch failed` 结束，无法获得 usage。
- 2026-08-23: 按已授权 Provider fallback 尝试 Kimi K3；立即及等待 20 秒后两次均返回 403 concurrent request limit，未产生模型输出。
- 2026-08-23: T-005 -> blocked；停止低信息重复请求。T-006 保持 pending，等待 Provider 外部状态恢复后继续。
- 2026-08-23: 默认门控测试 1/1 skipped、AgentHarness 回归 7/7 passed、`npm run check` 与 `git diff --check` 通过；Biome 仅格式化新增 real eval 测试。
- 2026-08-23: 用户指定恢复 OpenAI Codex 验证并改用 `gpt-5.6-luna`；T-005 blocked -> in_progress，外部阻塞视为待以 Luna 重新判定。
- 2026-08-23: Luna 分别用 SSE 与 auto 重试仍 `fetch failed`；安全诊断确认底层为 `UND_ERR_CONNECT_TIMEOUT`，目标 host `chatgpt.com`，standalone eval 未安装 coding-agent EnvHttpProxyAgent。
- 2026-08-23: 在 real eval 的 opt-in 路径调用 `configureHttpDispatcher()` 后，Luna SSE 真实双请求 1/1 passed：cold 6884 input/0 cacheRead/2403ms；warm 1025 input/5888 cacheRead/1837ms，cached-input ratio 85.17%。
- 2026-08-23: T-005 -> done；T-006 -> in_progress（owner: coordinator），开始最终静态与边界验证。
- 2026-08-23: 最终定向测试通过：agent 7/7、ai 16/16、coding-agent 38/38，real eval 默认 1/1 skipped；`git diff --check` 通过。
- 2026-08-23: `npm run check` 全阶段通过，Biome 报告 No fixes applied。
- 2026-08-23: T-006 -> done；所有任务完成，最终结论限定为 Luna 单 session、双请求样本。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001 至 T-007 全部 `[x] done`；faux 冷写/热读和禁用缓存回归通过；OpenAI 长 key、TUI 指标语义和 durable JSON 规范化回归通过；真实 `openai-codex/gpt-5.6-luna` 双请求显示 warm `cacheRead=5888`、cached-input ratio `85.17%`，且 warm 延迟 1837ms 低于 cold 2403ms；最终定向测试 61/61 passed，real eval 默认 1/1 skipped、opt-in 1/1 passed，`npm run check`、`git diff --check`、task document validator 通过。
- Limitations: 真实数据仅来自 Luna、单 session、单个双请求样本，能证明接线和一次真实 prefix-cache 命中，不能外推为生产平均命中率、统计显著的延迟收益或其他 Provider/模型表现。响应内容和凭证未记录；共享工作树开始前已有大量修改，本任务未提交。
