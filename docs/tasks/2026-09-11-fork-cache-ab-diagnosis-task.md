# Task Plan: Fork preserve 缓存真实 A/B 诊断

- Created: 2026-09-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户要求fork保证缓存命中并诊断；已授权新增最多18次真实请求/15分钟的luna/max隔离A/B。

<!-- task-doc-section:background-goal -->
## Background and goal

区分preserve前缀、prompt_cache_key与服务端缓存波动的影响，避免把独立sessionId造成的路由差异直接当成唯一根因。诊断不等于承诺Provider永不淘汰缓存。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

只使用openai-codex/gpt-5.6-luna/max/SSE、合成前缀、独立临时SDK/native会话和test-only请求观察。18次实际HTTP尝试/15分钟包括重试；新增预算从本轮第一次实际请求开始。对照只改变子请求的逻辑promptCacheKey，保持父子传输sessionId独立。不改产品、设置、当前会话、真实历史、冻结tool-profile-eval或旧恢复材料；不build、提交、委派实现、共享session-id或实验外网络绕路。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 上轮native preserve实际通过11429字节prefix guard，但usage.cacheRead=0 | epi-luna-real-g3zf91/events.jsonl #15/#19及child epi-collaboration-prefix记录 |
| F-002 | SDK默认sessionId独立；native fork未显式传promptCacheKey，Codex回退到sessionId | sdk.ts:358、agent.ts:473-474、openai-codex-responses.ts:267-272 |
| F-003 | 上轮parent只请求一次且无warm对照，未留最终请求body/hash或raw cached_tokens字段 | 上轮events/report与harness记录 |
| F-004 | 既往gpt-6-astra矩阵同body/key/头warm控制也曾miss，不支持session-id严格绑定缓存 | epi-cache-header-matrix-uXfOys/conclusion.md；不能等同本轮luna结论 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 3组有界配对实验仅能给局部证据，不是统计稳定性或必命中保证。
- Resolved boundary: 当前源码中客户端key差异是事实，但反向A/B反驳“只要共享key就能命中”；服务端具体路由/淘汰机制仍不可见。全部18条raw cached_tokens字段存在，0不是SDK补值。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每组native root实际请求后捕获canonical context/options，原样重放一次作为warm对照；native preserve child实际执行后对其原始请求做仅key不同的重放。
- 每组最多6调用：parent cold/warm、child own/shared（交替次序）、child shared复查、parent回测。warm不成立时不声称key因果成立。
- 同child对照除prompt_cache_key外body严格相同；父prefix确实等于child input前缀，system/tools/model/effort一致；headers只保留哈希，不记录凭证。
- 保存raw usage字段是否存在、cached_tokens/cache_write_tokens、延迟、前缀hash和实际计数。到限取消测试，关闭native资源。
- 不从单次命中推导保证，不按未请求的优化方向改产品。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003.
- Parallel batches: 无。
- Serialization constraints: 一个预算守卫，三组逐一执行，组内请求串行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 隔离A/B harness与无调用预检

- Status: done
- Owner: coordinator
- Objective: 构造可比请求和不会绕过预算的计数。
- Inputs and prerequisites: 用户明确授权18请求/15分钟；现有dist。
- Scope or files: /tmp诊断脚本、本文件。
- Expected output: opt-in、SSE fetch守卫、native prefix/body一致性断言、raw usage脱敏记录。
- Dependencies: None.
- Execution steps:
  1. 沿用CLI代理初始化、内存credential/catalog，禁用个人context/skills。
  2. dry-run核验native工具、模型max、预算守卫；不发送模型请求。
- Acceptance criteria:
  - 无付费调用即可验证接线和guard；不改产品。
- Verification method:
  - --dry显式脚本。
- Validation evidence: `PI_OFFLINE=1 node /tmp/epi-fork-cache-ab.mjs --dry`通过，0真实请求、native六工具、luna/max、18次预算拒绝与shutdown均核验；证据epi-fork-cache-ab-zfhEbK/report.json。使用CLI同款代理初始化、内存credential/catalog；模型输入仅合成材料。parent/child原始请求通过compiled ModelRuntime捕获，headers只hash，认证options/capture对象被持久化replacer排除。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 三组有界真实对照

- Status: done
- Owner: coordinator
- Objective: 在同body/独立transport前提下检验逻辑key共享的效果。
- Inputs and prerequisites: T-001。
- Scope or files: 临时合成native sessions、请求证据与raw usage摘要。
- Expected output: 3组最多18请求的对照结果，或预算/网络阻塞证据。
- Dependencies: T-001.
- Execution steps:
  1. 对每个新prefix执行cold/warm和child两种key，交替顺序。
  2. child共享key复查及parent回测，记录有效性门。
- Acceptance criteria:
  - 严格计数且请求可比，失败不自动无限重复。
- Verification method:
  - PI_REAL_MODEL_EVAL=1显式运行，raw字段与hash断言。
- Validation evidence: 主实验14请求；第二组warm失败后跳过child。余量4请求在原始deadline内追加fresh第四组shared-first反向对照，省略repeat/return；累计18次、全部HTTP200、365274ms，所有fixture shutdown=true。最终body/header/raw usage独立离线复核通过；详细表与证据路径见下方。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 因果边界与建议

- Status: done
- Owner: coordinator
- Objective: 给出证据支持的诊断，不夸大为保证。
- Inputs and prerequisites: T-002证据或有界停止。
- Scope or files: 本文件、诊断摘要；移除本轮临时脚本。
- Expected output: body/key/路由的已知与未知，下一步建议，资源关闭证明。
- Dependencies: T-002.
- Execution steps:
  1. 汇总每组raw cache usage与控制，判断假设是否被支持或反驳。
  2. 检查预算/cleanup，验证authority，保留合成证据。
- Acceptance criteria:
  - 不改代码、不共享传输身份、不声称未验证的必命中或并发安全。
- Verification method:
  - 日志/汇总/进程/diff与任务结构校验。
- Validation evidence: 18条编号连续且成功、最终wire输入前缀和仅key变量检查通过；raw cache数据明确区分0/正数。正向两组与反向一组均为首个child miss/后续child hit，不能把效果归因于共享key。全部native资源关闭且未发现诊断Node残留；仅文档/临时harness改动，无产品改动。诊断完成不代表必命中验收。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

用现有compiled SDK/native host和真实Provider；重放只使用本次已捕获的合成provider context，不修改实际会话history或重复执行工具。exact body差异检查在发送前做，拒绝wrong model/effort/endpoint，实际fetch计数含内部重试。对照不共享父子native/session-id/x-client-request-id；只测试已有promptCacheKey参数。最终结果区分raw字段缺失、0、正数。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

服务端cache路由和淘汰不可见，前一个请求会预热后一个请求，组内观察非独立样本。当前最终JSON提示修复未build，实验采用上一轮已构建产物（不影响此前prefix/key逻辑对照）。raw usage在流结束才可获得，缓存miss无法在本客户端发送前保证拒绝计费。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-11: 静态确认key未继承与上轮测量缺口；用户授权新增18请求/15分钟。T-001开始。
- 2026-09-11: T-001完成，T-002开始。3个fresh prefix/native root，单进程串行请求；每组parent cold/warm，native preserve child与其捕获请求replay进行own/shared对照。child两臂比较全部header hash和除key外全部body；parent原始input前缀/system/tools与child在实际fetch前严格断言。流clone只提取raw usage，完整request body只含本次合成材料。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 有界诊断完成；18实际HTTP尝试全部200，累计365274ms（约6分5秒，含两段实验之间的分析），未重置预算。最终wire复核、资源关闭与任务结构校验通过。这里passed仅指诊断交付，不指fork必命中。
- Limitations: 不能保证Provider命中；key因果收益未成立，服务端内部机制未知；无稳定性统计、延迟收益、WebSocket/并发安全结论。未改产品、build或增加预算；源代码结果JSON提示修复仍未构建。

### Raw cached_tokens observations

| Fixture | Parent cold | Parent warm | First child | Second child | Shared repeat | Parent return |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 0 | 6656 | own: 0 | shared: 7680 | 7680 | 0 |
| 2 | 0 | 0 | skipped | skipped | skipped | skipped |
| 3 | 0 | 6656 | own: 0 | shared: 7680 | 7680 | 0 |
| 4 | 0 | 6656 | shared: 0 | own: 7680 | not run | not run |

**Measured:** 每组parent replay的完整body及全部header哈希不变；child两臂除prompt_cache_key外body及全部header哈希一致；child input以parent input为完整精确前缀，其他body字段相同；父子session-id/x-client-request-id独立。所有cache_write_tokens字段存在且为0。前3组主实验14次，第四组反向4次。父回测在两组均为0，证明同body/key/headers重复也不保证命中。

**Supported inference:** 命中更符合子请求首次发送后的重复预热/时序效应，而非“共享父key”单变量收益。共享key在第四组首次child请求仍为0，独立key随后为7680，反驳共享key足以保证命中。首两组7680还略超过父input的7676/7677，不能把这些命中全部归为父预热贡献。独立key能命中说明共享key也不是本次命中的必要条件。

**Unknown:** Provider内部实际token前缀、路由、写入时机和淘汰策略；wire前缀相同不等于已验证内部缓存索引。不能从本实验断言key完全无效、session header应共享，或某个具体服务端机制已证实。

**Recommendation:** 不把共享key作为已证实修复，不自动重复付费请求“刷命中”。客户端可维持严格preserve并增加可审计的cache usage/逻辑key来源观测；若要优化逻辑key继承，应另行授权并以首个fork请求命中率验证，而不是同child重放命中率。若业务硬要求必命中，需要Provider支持明确的缓存资源/保留及命中保证；本轮端点没有验证到此能力，当前无法承诺。

### Evidence and reproducibility

共同临时目录前缀：`/private/var/folders/rb/jccv7g0d5gnf20hz77wy08jw0000gn/T/`。

- 主实验：`epi-fork-cache-ab-JvTFcz`，report SHA256 `ae1e00c5ad1bc06bda8907229ee340c44f10be075ba1a7e03b0947b25f60b3a1`。
- 反向实验：`epi-fork-cache-ab-eKaqaK`，report SHA256 `8f2d22152aba4bbc7e57018e9fdb2e2405849712686d2a0c0640d8bb9ab954b2`。
- 汇总：`/tmp/epi-fork-cache-ab-summary.json`；原始目录保留events.jsonl、report.json、18条合成request body与native sessions。凭证仅内存使用；headers只保留hash。
- 主实验首次请求`1789065359296`，原始deadline `1789066259296`。反向继续使用`EPI_CACHE_PRIOR_REQUESTS=14 EPI_CACHE_STARTED_MS=1789065359296 EPI_CACHE_SHORT_REVERSE=1`，未扩预算。
- 运行环境、compiled SDK/host hash和逐条耗时见reports；串行、SSE、luna/max、store=false、maxRetries=0、合成128-record前缀。
- 初次harness执行在fetch前因structuredClone捕获可执行tools失败，0请求；harness改为只复制可序列化tool schema字段后解决，未改产品。反向模式syntax check及dry预检通过，dry累计计数显示14但没有新增请求。
- 停止时移除本轮ad-hoc harness和离线汇总脚本，保留证据和日志。
