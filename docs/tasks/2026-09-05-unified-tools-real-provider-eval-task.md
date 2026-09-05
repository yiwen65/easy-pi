# Task Plan: 统一工具链真实 provider 配对测试

- Created: 2026-09-05
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户请求“继续真实provider测试，使用gpt-5.6-luna max”，选择沿用上轮限额，并确认新的配对测试约定。

<!-- task-doc-section:background-goal -->
## Background and goal

在统一 Bash 后，以真实 openai-codex/gpt-5.6-luna、thinkingLevel=max 比较当前 legacy 原生四工具与 v2 四工具。使用独立新样本验证任务完成和失败恢复，记录真实调用与成本；不自动优化产品代码，不把本轮描述为历史改动的因果 A/B 或普遍性能结论。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 当前同一 revision 的 legacy read/bash/edit/write 与 v2 search/read/edit/bash；新合成临时工作区，4 个任务各执行 2 个 profile，共 8 个会话，交替 profile 顺序，每会话最多 10 次模型请求、10 分钟。
- 新任务覆盖重复候选定位、跨文件受控更新、真实 Bash 语法失败恢复、显式子目录 cwd 与文件创建。每次重建相同任务输入；首次付费前冻结场景、顺序、schema/system-prompt 与独立文件系统 oracle。
- 独立预算：$15、80 次模型请求、800000 总 tokens、150 分钟，任一先到即停；时钟从首个评测命令开始，包含本地评测验证。失败和未完成记录不丢弃、不重跑以改善结果。
- 仅发送合成/公开数据及公开工具 schema/guidance；不发送私有仓库内容、凭据、环境变量；禁用 embedding、额外内部模型调用、自动重试、扩展/skills/context-file 发现、磁盘会话持久化。
- Bash 仅允许固定无网络的检查/发现命令；执行前验证可信检查脚本未被修改，子进程使用清洗环境。此限制是评测安全边界，不代表产品 OS sandbox 能力，也不评价任意 shell 工作流。
- 不改任何产品源码、依赖/锁文件、既有评测源码、冻结 manifests/results、旧 held-out 或历史任务。只新增本轮测试/结果/任务文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前基线为 my-pi / 9fbba6fceabd126a0ea3d53822385c4d4464eaf3，tracked/index clean；既有无关 untracked 保留。 | git status/rev-parse，2026-09-05 本轮恢复检查。 |
| F-002 | 用户确认模型、max、独立 $15/80 请求/80 万 tokens/150 分钟预算、无 embedding、新样本、仅测试。 | real_provider_test_budget 与 confirm_real_provider_test 两次结构化选择。 |
| F-003 | 目录模型将 max 映射为 max，contextWindow=272000、maxTokens=128000。 | packages/ai/src/providers/data/openai-codex.json；docs/models.md Thinking Level Map。 |
| F-004 | 当前 Codex request body 没有 max_output_tokens；不能把传入 maxTokens 当硬输出上限。 | packages/ai/src/api/openai-codex-responses.ts buildRequestBody。本轮每请求保守预留整个目录输入/输出容量，再按实际 usage 结算；不沿用旧 chars/4 输出配额假设。 |
| F-005 | 原有真实 executor 固定旧 Run/场景/预算，不适用于当前 Bash；通用内容审计/hash helpers 可只读复用。 | test/tool-profile-eval/v2-bounded-real-eval.ts 与对应 real.test.ts；docs/sdk.md 冻结评测迁移边界。 |
| F-006 | SDK 可显式传入 runtime、禁用资源发现、内存 settings/session；HF compaction 默认可能额外调用模型。 | examples/sdk/12-full-control.ts、src/core/sdk.ts、agent-session.ts 与已检索 LEARNS。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 无待用户确认的实质假设。当前目录容量/价格用于保守预留，不是提供商账单保证；usage 缺失或超出预留时立即停止并报告未知成本风险。
- Open question: None.

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A-001：所有真实请求选择指定 provider/model/max；payload 级确认 reasoning.effort=max；SSE 与 maxRetries=0，不隐藏重试或内部模型调用。
- A-002：付费前独立 oracle 的初始失败/正确修复通过/干扰文件修改失败均有本地测试；profile 名单、生产 schema/guidance、隔离与预算拦截有回归。
- A-003：预算逐请求预留并持久化；一个会话只运行一次；未知 usage、provider/基础设施、安全边界异常停止整个矩阵，任务失败保留真实结果。
- A-004：结果只含白名单元数据、计数、hash、状态和数值；记录分 profile/配对完成率、错误、工具调用、tokens、耗时、费用，缺失样本明确列出，不用模型自述判成功。
- A-005：旧冻结资产、产品源码、无关 untracked 保持；运行修改/新增的具体测试、root npm run check、diff check、任务 validator；显式提交后核验。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-004。
- Parallel batches: None。固定样本、预算与 anti-rerun 状态共享且必须按顺序冻结；不使用会产生额外私有源码模型调用的 subagent。
- Serialization constraints: coordinator 独占本权威文档、评测文件和预算；不并行运行 provider 会话；不修改正在执行的 runner/fixture/oracle。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 新样本与隔离评测实现

- Status: done
- Owner: coordinator
- Objective: 建立不依赖旧 Run 合同的新 paired evaluator。
- Inputs and prerequisites: F-001 至 F-006，确认的权限边界。
- Scope or files: 新增 packages/coding-agent/test/tool-profile-eval/unified-tools-real-eval.ts、unified-tools-real-eval.test.ts、unified-tools-real-eval.real.test.ts；本权威文档。
- Expected output: 4 个新任务、8 会话固定顺序、内容安全边界、独立 oracle、保守账本与无内容记录。
- Dependencies: None.
- Execution steps:
  1. 用生产 SDK 工具与 guidance，显式禁用资源发现/compaction/retry/embedding。
  2. 限制工具访问临时 fixture 与固定命令；保护检查脚本；使用真实 Bash 执行和结构化错误结果。
  3. 新建逐请求账本与记录；只读复用通用 hash/content-free helpers，不改旧评测合同。
- Acceptance criteria:
  - A-001/A-002/A-003。
- Verification method:
  - V-001；静态边界/成本/停止条件审查。
- Validation evidence: 19:28 V-001 14 passed / 1 real-test skipped；4 场景分别证明初始失败、正确修复通过、干扰/额外写入失败，两 profile 真实 SDK schema/Bash 非零与成功/无 compaction 通过；v2 FFF Search 不污染 fixture。预算预留、未知 usage、费用/token/request/time 拦截、不可覆盖记录、路径/命令/环境边界均通过。19:27 root check 通过；formatter 仅修改新 evaluator 文件。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 本地验证、presence-only 预检与冻结

- Status: done
- Owner: coordinator
- Objective: 在零模型请求下验证场景/oracle/预算并冻结真实调用输入。
- Inputs and prerequisites: T-001 实现完成。
- Scope or files: 新增 evaluator 的指定单测；外部 task-owned 临时合同与时钟；本任务记录。
- Expected output: 本地通过证据、模型/auth 是否可用的无凭据输出、冻结 hash。
- Dependencies: T-001.
- Execution steps:
  1. 首个评测命令前创建独立计时记录，执行 V-001 与 V-002。
  2. 验证两 profile 真实 schema/guidance、禁用额外模型调用及 safe transport。
  3. 冻结当前 HEAD、三个 evaluator 文件、8 会话顺序与 schema/system-prompt hash，禁止真实调用后调参改 oracle。
- Acceptance criteria:
  - A-001/A-002/A-005。
- Verification method:
  - V-001/V-002/V-004；presence-only preflight 不调用模型。
- Validation evidence: 19:28:54 单独运行 PI_UNIFIED_EVAL_PREFLIGHT=1 的新 real.test.ts，1/1 passed、模型生成请求 0；配置 auth 存在，max 映射可用，8 个真实 SDK session 的 schema/system-prompt 与出站静态边界通过并冻结。freeze.json 位于 /tmp/pi-unified-real-eval-cT7D0V；casesHash=78ef3e96…bdc92e，legacy schema=dcd9bf1a…f0f32，v2 schema=a24c4847…23f1c；同 profile 跨场景 prompt/hash 相同。每请求预留 400000 tokens / $0.3664。V-001 14 passed/1 gated skip，V-002/V-004 通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 单次有界真实配对运行

- Status: done
- Owner: coordinator
- Objective: 获得当前两 profile 的真实提供商证据。
- Inputs and prerequisites: T-002 done，冻结输入与预算可用。
- Scope or files: 显式双 opt-in 的新 real.test.ts；外部临时 ledger/不可覆盖 attempt records。
- Expected output: 最多 8 会话、80 请求，已完成/失败/未开始均真实记录。
- Dependencies: T-002.
- Execution steps:
  1. 仅运行 V-003 指定文件；一次 sequential matrix，不跑其他旧真实测试。
  2. 请求前检查 max、schema、数据与时间/费用/token/request 配额；请求后核对 usage。
  3. 独立 grade 文件系统与 Bash 激活顺序，保存仅元数据结果；触发停止不重试或隐藏缺失项。
- Acceptance criteria:
  - A-001/A-003/A-004。
- Verification method:
  - V-003 与账本/记录一致性审计。
- Validation evidence: 19:30:15 开始唯一一次 V-003，304.13 秒内结束（测试主体 301.60 秒），1/1 test passed，8/8 task sessions passed；40 requests 与 40 个 max payload 对应，98087 总 tokens；总账本 input=55725/output=4474/cacheRead=37888/cacheWrite=0、costUsd=0.017271560000000002，无 pending/stop/missing。两个 U-03 都记录 exitCode=1 → Read/Edit → exitCode=0。读回所有 records/budget 与冻结源码 hash，源码与 freeze 完全相同。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 结果审计、文档与提交

- Status: done
- Owner: coordinator
- Objective: 交付有证据边界的配对结果并提交 task-owned 变更。
- Inputs and prerequisites: T-003 已运行或真实停止证据可审计。
- Scope or files: 新增 unified-tools-real-eval-results.json、UNIFIED-TOOLS-REAL-EVAL.md；本任务文件；必要时仅追加已验证 LEARNS。
- Expected output: 完成率/调用/tokens/时间/费用及失败轨迹元数据，明确局限，显式 commits。
- Dependencies: T-003.
- Execution steps:
  1. 审计模型/max、总费用、预留、未完成项与内容安全；仅对完整配对报告描述性差值。
  2. 验证 frozen source/oracle 与旧资产未变，运行 V-001/V-002/V-004。
  3. 显式 stage/commit，核验提交清单与残余状态；保留无关文件。
- Acceptance criteria:
  - A-004/A-005；不声称显著优势、名称提速或全部能力覆盖。
- Verification method:
  - V-001/V-002/V-004；git diff/status/show。
- Validation evidence: 19:47 独立离线审计通过：不可覆盖记录/账本/40 个 max payload/最终工作区一致，合计 98087 tokens、$0.01727156 目录价成本，无 pending/missing/非预期错误。legacy/v2 各 4/4 通过，工具调用数 19/20、总 tokens 36756/61331；如实报告 v2 工具结果 bytes −40.6% 但总 tokens +66.9%、目录价费用 +23.5%，不宣称总体优势。结果 JSON 与外部不可变原件字节一致，SHA-256=233da4d66d7e576e826bab59c9f0e55d00848e308fec6dc264eadb09963ff5c1；三份冻结 TS hash 未变。19:45 V-001 再跑 14 passed/1 gated skip，root check 全通过、No fixes applied，旧 tracked 文件和既有 untracked 不变。LEARNS 现有 addressed/canonical 路径条目已说明相关平台风险，本轮不重复扩写。19:50 显式提交 e4ea1a96bc54933b42827ce5f85391157b1cd9f6，git show --name-status 核验只有 5 个新 evaluator/结果/报告文件；提交中的结果 SHA-256 与外部原件完全相同。tracked/index 无残余修改，无关 untracked 保留。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001：在 packages/coding-agent 根运行 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tool-profile-eval/unified-tools-real-eval.test.ts test/tool-profile-eval/unified-tools-real-eval.real.test.ts`，无 opt-in 时真实测试必须 skipped。
- V-002：root `npm run check`，完整输出，随后立即审计 Biome 写入范围。
- V-003：同 package root，只有 `PI_REAL_MODEL_EVAL=1 PI_REAL_UNIFIED_TOOLS=1 PI_UNIFIED_EVAL_DIR=<task-owned temp root>` 时运行 `--run test/tool-profile-eval/unified-tools-real-eval.real.test.ts`；不得运行旧 paid/held-out 文件。
- V-004：`git diff --check`；`python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-09-05-unified-tools-real-provider-eval-task.md`。
- 不运行 build、npm test、全套 Vitest、安装或付费 embedding。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- max reasoning 可能占用大量时间/输出；Codex 当前不转发输出上限，因此按目录容量保守预留，可能提前耗尽可分配额度而非消费到硬限。
- 小样本、单次顺序运行受 provider 噪声影响，不能给出统计显著性或通用性能结论。
- 真实工具失败不等于评测基础设施失败，二者分开；未知 usage/安全边界失败立即停止，不能以无 usage 当零费用继续。
- Bash 固定命令与 workspace guard 是测试隔离；不能宣称原生完整 OS sandbox。验证脚本不执行模型编写的 JS，仅解析数据/匹配内容或使用 node --check。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-05T19:05+08:00：用户确认本轮预算与完整执行约定；读取当前 SDK/模型/provider/旧评测通用边界，未读取或重跑旧 held-out 输入，未调用任何付费 provider。确认 Codex request body 不转发 maxTokens，本轮改用目录级保守预留；新建唯一任务 authority，T-001 → in_progress。

- 2026-09-05T19:28+08:00：19:21:47 开启不可重置评测时钟，临时根 /tmp/pi-unified-real-eval-cT7D0V。首轮 V-001 13 passed/1 failed，原因是 macOS /tmp 与 /var 的系统软链触发 strict policy；评测 workspace 改用 canonical realpath，不放宽产品策略，重跑 14 passed/1 gated skip。root check 首次发现目标 ES lib 不含 findLast 与 SDK heterogeneous renderer 边界，改为 reverse/find 和窄类型断言后通过。T-001 → done；T-002 → in_progress，下一步 presence-only 实际 schema/context 边界预检与冻结。当前模型请求数仍为 0。

- 2026-09-05T19:29+08:00：presence-only 预检 1/1 passed，核对生成请求为 0、已配置认证和 max、8 个 SDK session 的模型可见 schema/context；读回 freeze.json，三份 evaluator 源码与所有样本/顺序/限额已封存。T-002 → done；T-003 → in_progress，下一步仅执行一次双 opt-in 的新矩阵；禁止再修改冻结 runner/fixture/oracle，仍保留原 19:21:47 时钟。

- 2026-09-05T19:35+08:00：V-003 唯一真实矩阵结束，8/8 sessions 独立验收通过、40 requests、40 个 max payload，无未知 usage 或预算停止。源码三个 SHA-256 与冻结值完全一致，所有旧 tracked 资产未变。T-003 → done；T-004 → in_progress，下一步只做离线聚合/内容审计、保存结果、回归与提交，不再调用 provider。

- 2026-09-05T19:47+08:00：离线独立审计实际文件、冻结源码、账本、40 次 max payload 与 8 个记录全部通过；结果原样导出到新的 unified-tools-real-eval-results.json，新增报告解释成本/体积/缓存/单次延迟边界，不修改产品或历史评测。19:45 最终本地回归 14 passed/1 gated skip，root check 全通过且不改文件。T-004 下一步只显式 stage/commit 并核对提交清单；没有追加真实请求。

- 2026-09-05T19:50+08:00：任务 validator 与 staged diff --check 通过，显式提交 e4ea1a96bc54933b42827ce5f85391157b1cd9f6。独立核对提交仅新增 5 个授权评测路径，结果字节 hash 与外部原件一致，tracked/index 无残余变化，既有 untracked 原样保留。T-004 → done；本权威文档单独收尾提交，保留外部封存证据，仅清理本轮离线审计临时脚本。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: execute 模式下 T-001 至 T-004 全部 done，无 blocked；真实 8/8 任务通过，40 requests，全为 max；本地 14 passed 与 presence-only/真实测试各 1 passed，root check、结果内容/账本/源码审计、任务 validator 与 diff check 通过。结果提交 e4ea1a96bc54933b42827ce5f85391157b1cd9f6 已核验范围和原件 hash；没有改产品、旧冻结资产或追加真实请求。
- Limitations: 4 对新合成任务不代表复杂仓库、所有 v2 能力、Windows 或普遍性能优势；目录价费用不等于实际账单。外部封存证据保留于本任务临时根，既有无关 untracked 保留，不宣称整个工作树为空。
