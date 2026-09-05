# Task Plan: V2 分项成本归因与三维整改

- Created: 2026-09-05
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户要求分项计量、找原因并整改，选择“三维整体领先”和新的专项额度，确认完整执行约定。

<!-- task-doc-section:background-goal -->
## Background and goal

定位 V2 工具结果更小但任务 tokens 更高的首个成本差异，验证因果机制后最小整改。目标是在预先固定的新验证集上：准确度或安全性至少一项严格改善、另一项不退化，同时端到端任务耗时、总 tokens 和费用改善。允许个别任务持平；任何安全退化不接受。没有证据支持的维度标记未证明，不承诺所有任务上普遍优越。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 比较 A=基线原生 read/bash/edit/write、B=基线 V2、C=整改后 V2；工具名称与默认 legacy profile 不变。
- 新增独立分项计量/实验包于 packages/coding-agent/test/tool-profile-eval/v2-attribution/；不改此前 frozen evaluator、场景或结果，不运行旧 held-out/U-01 至 U-04 真实场景。
- 分项：schema/系统提示/用户输入/历史 assistant 文本与工具参数/工具结果/推理签名/传输元数据；首次与重复携带；provider input/cache/output/reasoning/cost；模型阶段、工具执行、编排和任务 wall time。JSON 分区 bytes 必须可加总核对；没有 tokenizer 时不得将 bytes/4 伪称精确模型 tokens。用单变量 provider 探针测固定协议的实际 input-token 差。
- 仅当因果证据支持时整改 V2 schema、指导或实现与必要共享接线；优先范围为 agent harness tools 的 search-v2/read-v2/edit-v2、coding-agent 的 tools/tool-profile/system-prompt 及其回归。修改前全文阅读。不削弱版本/范围/权限等校验，不擅自删除既有能力或故意让原生基线变差；需要破坏性 API 变更时另行确认。
- 最多两轮基于开发集的整改，之后冻结 candidate，独立新验证集只执行一次。保留失败/预算停止，不改 oracle 或重跑以改善分数。
- 新独立上限 $15 / 240 个模型请求 / 2000000 总 tokens / 180 分钟，首个评测命令启动不可重置时钟。模型固定 openai-codex/gpt-5.6-luna，max，SSE，maxRetries=0；无 embedding、compaction 或额外模型调用。Codex 不转发 maxTokens，继续目录级保守预留并结算真实 usage。
- 只发送新合成/公开数据与工具协议；私有源码/凭据/完整 tool/model 内容不进入结果。不修改依赖、锁文件、进程执行后端、沙箱/PTY、模型目录或旧资产。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 基线 my-pi / 38c64d5b60eadaff13a7ff480c32d92f62b3817e，tracked/index clean；保留既有无关 untracked。 | 20:32 git status/rev-parse。 |
| F-002 | 前一轮 40 请求都为 max；V2 多 24575 tokens，其中 23433 为输入增量，1142 为输出增量；没有逐区块 token 归因。 | 已冻结 UNIFIED-TOOLS-REAL-EVAL.md 与 JSON；仅作为问题证据，不重跑/调优该样本。 |
| F-003 | provider 原始 input_tokens 包含缓存；Pi 先扣除再单列 cacheRead，原合计未重复计数。 | packages/ai/src/api/openai-responses-shared.ts:570-584。 |
| F-004 | Codex payload 包含 instructions/tools/转换后的整个 active history；SSE 路径每次提交该 payload。 | packages/ai/src/api/openai-codex-responses.ts buildRequestBody；openai-responses-shared.ts message conversion。 |
| F-005 | 基线 Read V2 四个 schema 分支重复预算属性、V2指导较长；common prompt有Search时仍添加Bash发现指导。 | 基线源码；整改已去除指导冲突，Read未改。个别tool的精确token份额未测定。 |
| F-006 | 当前 Node v24.15.0，macOS 26.5.1 arm64 / Apple M5 / 24 GiB；未找到已安装 tokenizer。 | node --version、sw_vers、sysctl、限定 node_modules 查询。 |
| F-007 | Vitest base 用绝对 workspace aliases 指向本 checkout 的 AI/Agent/TUI 源码。可为旧 revision 建隔离 worktree 并验证实际 schema/hash，避免错误混用 live 产品代码。 | vitest.base.ts、packages/coding-agent/vitest.config.ts。 |
| F-008 | 用户已确认三维口径、新预算、同模型、权限及失败结论边界。 | v2_superiority_gate、v2_attribution_optimization_budget、confirm_v2_attribution_optimization。 |
| F-009 | 7个完整探针分离固定协议差：V2每请求多1170 input tokens，tools+812、system+358。 | v2-attribution/results.json，已核对原始request记录。 |
| F-010 | 最终离线C固定system+tools字节13595→12448，-1147/-8.4%；148项本地回归通过。 | offline-C2.json及指定6+8文件Vitest结果；只有bytes收益，不是C任务token/时延证据。 |
| F-011 | 9号请求无可结算usage后所有真实执行停止；pending保持400000 tokens/$0.3664。 | budget.json与9条request记录；known总8011 tokens/$0.0017882，底层失败类型未知。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Accepted assumption: 当前 Mac/Node 宿主；结论限于固定负载，不推广 Windows/所有任务。
- Verified assumption: 隔离baseline worktree、同一runner、公开catalog副本及实际alias/schema/function hash通过前后验证；未混用live产品源码。
- Open question: None。固定协议成本差已测定；任务级策略贡献、候选真实token/时延/正确性改善因breaker缺证，不能预判成功。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- A-001：每请求实际 payload 的 model/max、分区 bytes 加总、新增/重复历史、usage 与费用均可核对；provider token 差和本地 bytes/估算严格区分；不保存内容/凭据。
- A-002：整改前固定分项探针、开发/独立验证场景及 oracle/顺序/预算；真实输入基线版本正确，无旧场景复用，无隐藏重试/内部调用；失败/unknown usage 保留并停止。
- A-003：修改有 MEASURED → SUPPORTED INFERENCE → 单变量干预 → 机制验证链；只改解释主要成本的必要源代码；版本/范围/错误传播和既有工具能力回归通过。
- A-004：新验证集上 C 准确度或安全性至少一项优于 A、另一项不退化，C 无错误位置/并发条件下的错误写入，且不退化 B 的正确性与安全性。
- A-005：完整记录总 tokens/目录价费用/耗时与成功率；失败不当作低成本胜出。C 对 A 的总 tokens 和费用降低；共同完成任务的 paired latency 改善需超出噪声（预先定义成配对 log-ratio bootstrap 95% 区间上界小于 0），同时报告中位数与尾部。区间仅描述本固定样本的不确定性，不外推总体。
- A-006：A-004/A-005 任一未证实则“部分改进”，不声称全面超越；若功能回归、安全退化或证据不可信，不发布该候选为已验证优化。
- A-007：所有新增/修改的指定测试、root npm run check、diff check 与任务 validator 通过；只提交 owned 文件，旧资产/无关变更保留。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: 原主路径 T-001 → T-002 → T-003 → T-004，unknown usage后blocked。离线路径 T-001 → T-006 → T-005仅作partial结案，不替代三维验收。
- Parallel batches: None。版本隔离、样本封存、分项接口、预算和 anti-overfitting 状态共享；串行执行，不向无法纳入本预算/数据边界的 subagent 发送源码。
- Serialization constraints: coordinator 独占 authority；付费请求逐个预留/结算；开发和独立验证分开；C 冻结后不再编辑产品或计量代码。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 分项计量、新样本与版本隔离

- Status: done
- Owner: coordinator
- Objective: 零模型请求下建立可验证且不混版的新实验包。
- Inputs and prerequisites: F-001 至 F-008；已完成 bounded LEARNS 检索。
- Scope or files: 新增 v2-attribution/{metrics,fixtures,runner}.ts、metrics.test.ts、runner.test.ts、real.test.ts；外部 task-owned temp root / detached baseline worktree；本 authority。
- Expected output: 精确可加总的 bytes 分区、provider usage/时序账本、2 个新开发任务、3 类×2 实例独立验证任务、固定预算与安全 oracle、可靠 baseline/source 接线。
- Dependencies: None.
- Execution steps:
  1. 复用既有只读通用 helpers 与生产 SDK，不扩写旧 frozen 包。
  2. 构造已知路径、小/大检索窗口、并发前置条件变化的独立样本；验证初始/修复/干扰写入 oracle，禁止脚本执行模型生成代码。
  3. 封存最多 12 个分项探针、开发 baseline 4 会话×8 请求、两轮 candidate 最多 4 会话×8 请求、独立验证 18 会话×9 请求，共最多 238 请求，低于用户 240 上限。
  4. 版本比较使用同一 runner、同一 cwd/任务与文档引用规范化；验证旧 schema 不受 live 变化影响。
- Acceptance criteria:
  - A-001/A-002；必须先证明测量可信，不能直接改 schema。
- Verification method:
  - V-001；源版本/schema/prompt 哈希和 scope 审计。
- Validation evidence: V-001 live/baseline 各 21 passed / 1 skipped；两 checkout 的 product/catalog/runner/fixture/allocation/function 哈希完全一致。V-004 passed，tracked diff 空；21:39 freeze-AB 预检 passed，0 请求。runnerHash=5a36f191520e1731b4bccc6ec4e66c72627cc6ad221738a60891948363aa2af1。
- Blocker: None.
- Unblock condition: None.

### [ ] T-002 — 固定协议探针、开发基线与因果归因

- Status: blocked
- Owner: coordinator
- Objective: 找到首个主要成本差异，而不是仅凭字段多下结论。
- Inputs and prerequisites: T-001 done；新 clock/freeze/ledger，auth presence/max 可用。
- Scope or files: 新 runner/probe 输出与开发记录；只读产品代码；本 authority。
- Expected output: A/B 的分项 bytes 与真实 token 差、完整开发轨迹计数、带反证的候选排序与最小干预。
- Dependencies: T-001.
- Execution steps:
  1. 固定小请求分别启用系统提示、工具协议及其组合，toolChoice=none；计量 provider input/cache/output，探针不混入任务得分。
  2. 运行一次开发 A/B，定位 schema/system/history/arguments/results/round trips 的首次差异和比例。
  3. 只为可被单变量实验区分的主要机制制定最小补丁；未归因部分明确保留。
- Acceptance criteria:
  - A-001/A-002/A-003；未证明的因素不写成根因。
- Verification method:
  - V-002 的 probes/development stages；账本与 artifact 审计。
- Validation evidence: 7/7协议探针完整通过；full input A=1062/B=2232，差1170，其中tools差812、system差358，精确加和。首个开发A会话第2请求没有usage：9次总请求中8次已结算，8011 tokens/$0.0017882；第9请求保留400000 tokens/$0.3664预留。ledger.stop=usage_unknown，无后续调用。
- Blocker: 合同要求unknown usage停止本轮真实执行；开发A/B无完整配对，不能归因任务策略或完成端到端基线。
- Unblock condition: 本轮不解锁、不清除pending、不重试；只有用户另行批准的新独立运行可补足缺失的任务级证据。

### [ ] T-003 — 最多两轮最小整改与开发验证

- Status: blocked
- Owner: coordinator
- Objective: 消除已证明的主要成本，保持全部安全及能力合同。
- Inputs and prerequisites: T-002 done，明确主要机制和预测指标。
- Scope or files: 必要的 agent tools 与 coding-agent prompt/profile 源码、对应指定回归和当前 SDK 文档；本 authority。旧 frozen assets 不变。
- Expected output: 可审核最小 diff，开发集前后与分项干预证据，完整候选安全回归。
- Dependencies: T-002.
- Execution steps:
  1. 全文读实际目标及消费者，必要回归先证明旧形态/成本，再进行单机制修改。
  2. 跑 V-003 与 root check；逐请求/工具的计量器与 oracle 不随候选变化。
  3. 验证预测的区块成本下降及任务结果；仅在明确剩余原因时做第二轮，禁止看独立验证集后调参。
- Acceptance criteria:
  - A-003/A-007；不把移除安全校验/能力当性能优化。
- Verification method:
  - V-001/V-002 candidate development/probes、V-003/V-004。
- Validation evidence: 真实candidate开发未运行；协议证据支持的零模型整改转由T-006，不替代本任务的端到端验证。
- Blocker: T-002的unknown usage breaker，禁止后续真实调用。
- Unblock condition: 本轮不解锁、不清除pending、不重试；只有用户另行批准的新独立运行可补足缺失的任务级证据。

### [ ] T-004 — 冻结候选并进行一次独立三方验证

- Status: blocked
- Owner: coordinator
- Objective: 用未用于整改的新样本检验三维目标。
- Inputs and prerequisites: T-003 通过本地安全回归；candidate/metrics/oracle 已冻结。
- Scope or files: 新 validation stage、外部不可覆盖 records；只读基线和候选产品源码。
- Expected output: 6 个新任务×A/B/C，共最多 18 会话的完整或明确 partial 记录。
- Dependencies: T-003.
- Execution steps:
  1. 按固定交替顺序在独立 process 中运行相同新任务，排除 SDK/fixture setup 时间，同时报告该边界。
  2. 验证正确性、并发前置条件、无旁路/错误位置写入及明确 tool verification；记录失败而非只收成功。
  3. 到预算/unknown usage/infra boundary 即停，不重跑独立验证样本。
- Acceptance criteria:
  - A-002/A-004/A-005/A-006。
- Verification method:
  - V-002 validation stage；独立 oracle 与 raw metadata 审计。
- Validation evidence: 独立验证0请求、0会话；未查看模型验证输出，也未调优验证oracle。
- Blocker: unknown usage breaker；T-002/T-003不完整。
- Unblock condition: 本轮不解锁、不清除pending、不重试；只有用户另行批准的新独立运行可补足缺失的任务级证据。

### [x] T-005 — 分项结论、三维判定与提交

- Status: done
- Owner: coordinator
- Objective: 发布真实归因与整改结果，不把局部改进标成全面领先。
- Inputs and prerequisites: T-004 已取得可审计结果或明确停止证据；本轮采用已记录的breaker partial出口，审计T-006离线改动。
- Scope or files: 新 v2-attribution/RESULTS.md、results.json；当前 SDK 文档的必要变更；本 authority；仅必要的已验证 LEARNS。
- Expected output: MEASURED/推断/未知分离，三维各自 passed/未证明/failed，task-owned commits。
- Dependencies: T-001, T-006.
- Execution steps:
  1. 重算账本、分区加总、成功/错误/安全分母和配对区间；核对所有冻结资产与源 hash。
  2. V-001/V-003/V-004/V-005 通过后显式 staging/commit，核验路径与原始数据一致性。
  3. 未满足 A-004/A-005 则整体 partial，保留可独立证明的最小收益，不放宽门槛。
- Acceptance criteria:
  - 审核A-001至A-007，按A-006如实发布partial；本任务done仅表示报告、审计和提交完成，不代表A-004/A-005通过。
- Verification method:
  - V-001/V-003/V-004/V-005、git diff/status/show。
- Validation evidence: 148项本地回归、root check（No fixes applied）、diff检查、任务validator与独立offline审计通过；9请求/8结算/1pending、分区和原始记录全部一致。结果SHA256=478465987f479b0f3375ad37676203fb63adfe34d795977a0926abf5fad15ed6。17个owned路径提交38ecfc43f8bf11cc129ede8f48e1bc265e177c87，提交后路径/status/hash审计通过；旧资产和无关untracked未变。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 已收齐协议证据的离线整改

- Status: done
- Owner: coordinator
- Objective: 不再调用provider，以已测固定协议差为依据削减冗余表示；仅发布局部、未获任务性能验证的改进。
- Inputs and prerequisites: T-001 done；7个已结算探针；公开协议快照；unknown usage断路器保持不变。
- Scope or files: 必要的Search schema有限值表示、V2 promptContributions/common Search指导及指定回归；新增离线计量测试不修改封存evaluator/fixtures/账本。
- Expected output: 保持完整输入/能力/安全合同的最小diff、可核对字节差和本地回归；candidate provider tokens/延迟/准确度明确not_run。
- Dependencies: T-001.
- Execution steps:
  1. MEASURED：固定协议每请求多1170 input tokens，tools占69.4%、system占30.6%；参数字节Search3123/Read3058/Edit1486/Bash313。
  2. 对不改变接受输入集合的有限字符串表示、重复指导措辞做最小缩减；消除Bash与Search发现指导的静态冲突，保留能力和安全指导。
  3. 用字段域/验证器等价、生产profile/schema/prompt/过时View/范围/权限回归验证；不将bytes下降称为provider token下降或任务胜出。
- Acceptance criteria:
  - 原有能力/默认profile/安全限制不变；本地bytes下降；所有指定回归与root check通过；不运行真实请求。
- Verification method:
  - V-003/V-004/V-005及新增离线协议成本测试，旧资产/封存runner hash审计。
- Validation evidence: Agent指定6文件77 passed、coding-agent指定8文件71 passed/1默认real skipped，共148 unique tests。strict-sampling/接受域/参数规范化等价通过；root check passed。最终offline-C2固定system+tools字节13595→12448（-1147/-8.4%），Search参数3123→2533。Read/Edit/Bash协议完全不变，baseline后验13项测试和全部旧hash复核通过；0候选provider请求。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001：在 coding-agent package root 用 repository Vitest CLI 指定运行 `test/tool-profile-eval/v2-attribution/{metrics,runner}.test.ts` 及默认应 skipped 的 `real.test.ts`；不跑全套。
- V-002：仅双 opt-in `PI_REAL_MODEL_EVAL=1 PI_V2_ATTRIBUTION_REAL=1` 的新 real.test.ts；stage/attempt/root 必须匹配 freeze，按 probes → development → candidate → validation 单次执行。每请求先预留后结算，unknown usage 禁止继续。
- V-003：按实际 source diff 选择 Agent Search/Read/Edit/state/workspace 与 coding-agent profile/adapter/prompt/current deterministic gate 指定文件；修改过的测试必须实际运行，不运行旧 real/held-out。
- V-004：root `npm run check`，完整输出，随后立即核对 Biome 写入范围与 frozen source hash。
- V-005：`git diff --check`；`python3 /Users/w/.pi/agent/skills/wjskill-plan-and-execute-tasks/scripts/task_document.py validate --path /Users/w/Projects/easy-pi/pi/docs/tasks/2026-09-05-v2-cost-attribution-remediation-task.md`。
- 不 build、不 npm test、不全 Vitest、不 install、不付费 embedding。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 仅固定 bytes 不等于 provider tokens，cached tokens 是分类而非膨胀原因；分项归因需 payload 与服务端用量互证。
- baseline worktree 若误用 live workspace dependency，会使比较无效；实际 schema/source hash gate 必须防止混版。
- 小样本/API 噪声可能不足以证明时延优势；不能只看均值或只保留较快样本。功能失败不能被较少调用“奖励”。
- 并发条件 fixture 的安全判定与 task success 分开，不能以错误回包少作为准确度指标。
- 当前没有可验证的本地目标 tokenizer，先用精确 bytes 分区和 provider 单变量 token 差，不新增依赖或假装精确分词。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-05T20:32+08:00：确认新合同、基线、目标宿主、无关 untracked；读取适用 skills/SDK/payload/测试别名与 bounded LEARNS。当前未修改产品、未启动本轮模型请求或评测时钟。
- 2026-09-05T20:40+08:00：创建唯一 authority，T-001 → in_progress。将旧评测仅作问题证据；新实验独立。首步是可信分项与 baseline 版本隔离，不预设 schema 为主因。
- 2026-09-05T21:33:13.621+08:00：首个评测命令启动不可重置时钟 1788615193621；外部 root `/tmp/pi-v2-attribution-FhvQ0M`，deadline 2026-09-06T00:33:13.621+08:00。已建 detached baseline 和新 evaluator；首轮指定本地测试 20 passed / 1 failed / 1 skipped。失败为测试把 replacement 的 edits 数组混入 operations update；PATCH_PARSE_ERROR 来自共用 parseOperation，并不代表默认 patch 方言。读取 normalizeInput/createEditV2Tool/validateViewBinding 后确认默认 operations，应直接提供 oldText/newText，过时 Read 预期 STALE_VIEW；只修正测试。尚无本轮 provider 请求。公开协议输入快照仅在 task-owned 外部 root 支持交叉探针，不包含模型输出或凭据；结果仍只存内容无关计量。

- 2026-09-05T21:39+08:00：T-001 done、T-002 in_progress。baseline 初次加载因 Git 忽略的 providers/data 缺失而失败；只复制本机现有公开模型 JSON 并纳入 catalogHash，未生成/下载模型目录。重新执行两 checkout V-001 均通过，源/运行时函数哈希一致。freeze-AB 成功，默认非 experimental sampling（仍保留 constrainedSampling 元数据）；provider 预留 400000 tokens/$0.3664/请求。计量、样本、oracle、基线封存，准备 7 个基线探针及 4 个开发会话。

- 2026-09-05T21:43+08:00：9号请求已确认payload/max，19643ms后没有可结算usage。停止控制器及所有后续provider执行，保留pending和失败会话。无法从内容无关记录认定底层provider/网络故障类型，不猜测、不复现付费请求。T-002/T-003/T-004 blocked；新增T-006执行合同范围内、由7个完整探针支持的离线最小整改。T-005使用明确停止证据进行partial审计出口，三维门槛不变。

- 2026-09-05T22:18+08:00：T-006 done、T-005 in_progress。最终148项本地回归通过，baseline隔离后验通过；第一份offline-C1记录-1158bytes，复核纠正targetKind不应称为alias后，最终offline-C2为-1147bytes/-8.4%，两份保留不覆盖。未运行任何C provider请求。新增可复用LEARNS：detached worktree需要显式复制/哈希Git忽略的公开模型JSON，不复制认证。分项结果与完整partial/pending账本写入RESULTS.md/results.json；独立离线审计9请求/8结算/1pending全部对账，正在做最终范围审计与显式提交。

- 2026-09-05T22:34+08:00：T-005 done，Overall blocked / final partial。提交38ecfc43f8bf11cc129ede8f48e1bc265e177c87后再次审计通过；仅剩既有无关untracked。本轮停止后0provider调用，所有未完成三维门槛保持未证明。下一步只能在用户另行授权的新独立运行中补证，不解锁本轮ledger、不重跑已封存真实场景。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 7个完整协议探针准确拆出+1170 input tokens/request（tools+812、system+358）；本地整改固定协议bytes下降8.4%，148项本地回归通过；真实ledger第9请求usage_unknown后停机，保留全部失败和pending。
- Limitations: T-002/T-003/T-004 blocked；T-001/T-005/T-006 done。无完整开发配对、无candidate provider数据、无独立验证；准确度/安全性、任务tokens/费用、时延优势均未证明。不得清除pending或继续本轮付费调用。
