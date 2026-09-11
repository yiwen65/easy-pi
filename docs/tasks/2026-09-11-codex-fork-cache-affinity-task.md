# Task Plan: Codex preserve fork 缓存亲和身份修复

- Created: 2026-09-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户“执行修复”，并确认“采用 SSE 方案（推荐）”。

<!-- task-doc-section:background-goal -->
## Background and goal

修复Codex preserve fork首次请求因独立session-id丢失父缓存亲和的问题，同时保留native session、请求ID、取消和连接状态隔离。缓存命中仍取决于Provider，不承诺100%。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

串行源码实现和离线回归。Codex preserve子会话及后续调用使用独立缓存亲和参数并固定SSE，根会话与其他子模式保持原行为。共享逻辑cache key，不共享native session ID、WebSocket连接/previous_response_id或认证。亲和信息持久化以支持冷加载和嵌套preserve。无build、commit、真实调用、当前会话重启或settings变更；不触碰冻结tool-profile-eval、无关dirty work及历史备份。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 24调用四种header对照：保留session-id的4首次续接均命中7936，改变它的4续接均0；所有warm正 | docs/tasks/2026-09-11-cache-header-isolation-diagnosis.md |
| F-002 | 当前Codex将sessionId用于session-id、x-client-request-id、独立WS池/回退状态 | packages/ai/src/api/openai-codex-responses.ts |
| F-003 | native child身份持久化，preserve前缀通过provider-context observer捕获 | pi-child-session-host.ts、pi-collaboration-context.ts、subagent/session-host.ts |
| F-004 | 用户确认保守SSE方案；WebSocket共享亲和不启用 | 本轮结构化确认 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 共享cache亲和是非授权路由提示，不代表共享会话历史；串行真实对照与离线并发隔离回归支撑客户端接线，真实服务端并发仍未验收。
- Open question: 无阻塞实现的用户决定。源码修复不等于已构建或真实命中率复验。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 新可选cacheAffinityId只影响Codex SSE亲和头并选择SSE；sessionId仍决定请求ID与资源隔离；cacheRetention:none不发送缓存身份。
- 只有显式preserve继承可信父缓存亲和/逻辑key；isolated/curated/rebuild不继承。嵌套preserve和冷followup保持该谱系。
- 亲和metadata不进入模型history/system前缀，旧无metadata历史不重写，非法metadata拒绝。
- 回归先失败后通过，覆盖并发不同响应/取消、参数透传、SSE强制、WS无新连接/延续串用、持久化与邻近语义。
- 根check及限定测试通过，核对共享worktree修改范围；真实calls/build未运行如实报告。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无，用户要求串行实现。
- Serialization constraints: coordinator单写，check formatter前后hash对照。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 流参数与Codex SSE身份隔离

- Status: done
- Owner: coordinator
- Objective: 分离cacheAffinityId和原sessionId，仅SSE启用。
- Inputs and prerequisites: F-001/F-002/F-004。
- Scope or files: ai types/simple-options/codex adapter；agent option透传；相应离线tests。
- Expected output: 独立亲和参数、默认不变、并发隔离回归。
- Dependencies: None.
- Execution steps:
  1. 添加请求header与并发/取消回归，确认旧实现失败。
  2. 最小化修改参数与SSE header，不共享WS状态。
- Acceptance criteria:
  - 亲和头共享，请求ID独立；不影响其他provider/default/cache-none。
- Verification method:
  - 目标Vitest tests及类型检查。
- Validation evidence: 新header回归修改前4例失败（SSE发送child身份，其他transport尝试WS），修改后ai2文件45测试通过；Agent2文件27测试通过。取消测试最初未为兄弟提供signal造成测试假设失败，补充独立controller后通过；无产品取消逻辑变更。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — Preserve谱系与持久化接线

- Status: done
- Owner: coordinator
- Objective: 捕获可信父cache信息并持久化到子身份metadata，支持嵌套/冷加载。
- Inputs and prerequisites: T-001。
- Scope or files: subagent/session-host、coding-agent prefix observer/native host及tests、collaboration docs。
- Expected output: preserve继承、非preserve不继承、持久化验证。
- Dependencies: T-001.
- Execution steps:
  1. 捕获父agent的独立cache亲和/key，不复制认证或连接资源。
  2. 在新子身份metadata中保存并于冷加载恢复；验证合法性。
  3. 补充嵌套/冷followup/非preserve回归与文档。
- Acceptance criteria:
  - native/request IDs独立、亲和谱系稳定、模型历史无metadata注入。
- Verification method:
  - Native faux tests与prefix/tool邻近回归。
- Validation evidence: coding-agent3文件45测试通过，含native nested preserve、LRU cold followup、显式亲和/default key、isolated/rebuild/curated及非Codex不继承、非法持久化metadata拒绝不重写。文档已记录SSE强制和source-only边界。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 综合验证与交付边界

- Status: done
- Owner: coordinator
- Objective: 验证实现与dirty work隔离，交付源码结果。
- Inputs and prerequisites: T-002。
- Scope or files: 本authority、限定测试/check、临时hash证据。
- Expected output: 测试/check结果、最终审查、未验证项。
- Dependencies: T-002.
- Execution steps:
  1. 运行目标聚合tests、root check、diff和task validator。
  2. formatter前后hash核对，不回滚其他会话改动。
- Acceptance criteria:
  - 全部授权源码验收通过；不宣称build/真实服务端/WebSocket验证。
- Verification method:
  - 测试日志、hash、validator与diff审查。
- Validation evidence: 最终目标聚合207 passed /4 skipped（ai3文件65passed4skip、agent3文件52passed、coding-agent3文件45passed、subagent3文件45passed）；root npm run check通过。1691文件hash核对：第一轮formatter只改4个任务文件，第二轮只格式化新增Agent测试；git diff --check通过。任务结构校验通过；未build/真实调用。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

无付费Provider调用，使用mock fetch/WebSocket及native faux。目标测试先Red后Green，覆盖streamSimple和Agent透传、SSE独立请求/abort、继承与cold followup、其他模式保持独立。root npm run check按仓库规则执行，避免full test/build。新增tests单独运行。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

客户端可验证identity隔离，不保证Provider缓存路由稳定；SSE根与WS根跨transport缓存效果未实测。用户接受preserve子会话固定SSE的性能/传输取舍。旧子历史不回填亲和谱系，避免推断/重写真实历史。当前worktree含大量未提交改动，必须保留。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 已检查实际header与WS缓存路径；用户确认SSE方案。创建authority，T-001开始；初始git status/diff保存在/tmp/epi-affinity-initial-status.txt及/tmp/epi-affinity-initial.patch。
- 2026-09-11: T-001完成；T-002开始并完成首轮接线。native谱系回归先Red（prefix未捕获cacheAffinity），实现后coding-agent3文件43测试通过。追加显式亲和、默认key和curated非继承边界，等待最终聚合验证。
- 2026-09-11: T-002完成，T-003开始。首轮root check formatter仅改4个任务自有文件（1691文件hash核对），tsgo发现新Agent测试误用type-only导出作构造器；改用公开createAssistantMessageEventStream工厂，准备重跑。
- 2026-09-11: T-003完成：root check重跑通过，最终全部目标tests207passed/4skipped。差异审查确认cacheAffinityId不用于native/WS池identity，不新增自动Provider修复请求。交付源码结果，未构建/真实复验。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 源码和离线验收完成。新回归Red→Green；最终12个目标测试文件207通过、4个既有条件跳过；root npm run check、diff检查与task validator通过。修复范围为7个产品源码路径、3个新测试文件、collaboration文档及本authority。保留初始diff及两次check的1691文件hash快照（/tmp/epi-affinity-*），移除临时hash脚本。
- Limitations: passed仅指源码/离线范围。无build、新真实调用、真实服务端并发或WS共享亲和验证；当前session不热更新，installed dist仍未包含此修复。缓存不保证100%；WS父缓存→SSE子请求效果未实测；旧子会话无metadata时不回填谱系。

### Final implementation inventory

- packages/ai/src/types.ts、api/simple-options.ts：可选cacheAffinityId及simple参数透传。
- packages/ai/src/api/openai-codex-responses.ts：仅SSE session-id使用亲和ID，x-client-request-id仍为child；存在显式亲和选项时固定SSE，cache-none屏蔽身份/key；WS资源和continuation逻辑不变。
- packages/agent/src/agent.ts：构造/实例/loop参数透传，不覆盖sessionId。
- packages/subagent/src/session-host.ts、coding-agent/src/extensions/pi-collaboration-context.ts：可信Codex前缀捕获cache谱系，工具输入不新增字段。
- packages/coding-agent/src/extensions/pi-child-session-host.ts：非上下文identity metadata保存/验证/恢复谱系，Codex子Agent设置独立亲和/key和SSE，原native身份不改。
- 新回归：agent/test/agent-cache-affinity.test.ts、ai/test/openai-codex-cache-affinity.test.ts、coding-agent/test/pi-collaboration-cache-affinity.test.ts。
- 文档：packages/coding-agent/docs/collaboration.md记录行为与限制。未改provider validator、模型catalog、settings、依赖或history migration。

### Final verification commands

各package根下执行 `PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run ...`：

- ai: test/openai-codex-cache-affinity.test.ts test/openai-codex-stream.test.ts test/cache-retention.test.ts — 65passed、4skipped。
- agent: test/agent-cache-affinity.test.ts test/agent.test.ts + test/agent-loop.test.ts — 52passed。
- coding-agent: test/pi-collaboration-cache-affinity.test.ts test/pi-child-session-host.test.ts test/pi-collaboration-tools.test.ts — 45passed。
- subagent: test/collaboration-controller.test.ts test/context-fork.test.ts test/delegation-contract.test.ts — 45passed。
- Repo root: npm run check（含tsgo/browser smoke）通过；git diff --check通过。
- Task validator: python3 /Users/w/.epi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path docs/tasks/2026-09-11-codex-fork-cache-affinity-task.md。

