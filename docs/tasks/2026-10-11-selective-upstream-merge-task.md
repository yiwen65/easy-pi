# Task Plan: easy-pi 上游高价值提交选择性合并计划

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户先要求制定选择性合并计划，随后明确“开始实施”；按计划以当前my-pi为集成起点，执行18项修复，不执行暂缓项或发布/push。

<!-- task-doc-section:background-goal -->
## Background and goal

目标不是把 easy-pi 升级成上游 1.1.0，而是在保留现有产品合同的前提下移植确有价值的修复。按照“防止错误执行/历史损失 → 修复流式可靠性 → 修复显示和计费”的顺序推进。

从1111个上游增量的主题扫描中深入筛查29个候选：选择18个来源提交（部分只移植适用行为），3个已有对应实现，8个暂缓。本文是唯一任务与状态记录；原计划阶段未授权实施，后经用户授权执行，实际进度以各任务Status及验证证据为准。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

### 本轮权限

2026-10-11用户明确授权实施：以固定my-pi为起点，在独立worktree/集成分支中应用18项适用源码及测试，按DAG分派子代理，执行定向mock/faux测试和npm run check，协调者审查后提交。原主工作树不切换；不升级依赖、不实施暂缓项、不使用真实provider或真实凭证、不构建/发布/push。原计划阶段的只读验证记录保留。

### 原计划建议范围（执行选择已记录于Q-001及T-014）

- 默认在包含三个本地修复的my-pi之上创建独立集成分支；真正执行前需用户确认目标与授权。在共享主工作树中不直接切换分支；建议授权后创建位于`/tmp`的独立worktree，所有产品编辑仍只针对pi仓库。
- 仅移植下表18个提交的适用源码和回归测试；独立记录每个上游SHA，不把大范围上游祖先当作先决条件。
- 保留：有界模型重试、完成item恢复、效果确定性、后台任务、root-only协作/回执、clone/fork缓存继承、skill mention、逻辑文本复制、Thinking点击语义、TUI安全过滤、epi/.epi身份和独立打包。
- 不合并整个main；不迁移pi-durable/Chord/codemode/MCP；不引入TranscriptContext/finishTurn大迁移；不升级模型schema、SDK或工具链；不改默认模型、删旧harness、移除shrinkwrap或切回上游发布流程。
- 不执行真实provider请求、登录、读取真实凭证、收费评测、发布或push。测试使用faux/mock和临时文件。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | main=`e37cdc420669e48b4df4bbce0fb2617fc3c71328`；easy-pi/main=`e1ae7912ba4ce8b3da251a3d08f900b8847ac079`。 | 本轮`git rev-parse main easy-pi/main HEAD`。 |
| F-002 | 工作树my-pi=`728c443b8a33f8fd777e4e2e7b2b0df1dba554c5`，开工干净，比easy-pi/main多三个提交；其中有恢复缓存前缀、审查报告验证和退役capture恢复修复。 | `git status --short --branch`；`git log easy-pi/main..HEAD`；`git diff --name-only easy-pi/main HEAD`。 |
| F-003 | 有效共同树为上游59a71b235和easy696f59b36，tree均为`a1ac1d6c46ce41238f6e25b720aab4d8646a7c7d`；上游增量1111，easy增量256，包含merge。 | 本轮重验两个tree及`git rev-list --count 59a71b235..main`、`696f59b36..easy-pi/main`。 |
| F-004 | 29个候选已获取完整git show；通过关键源码hunk、相关调用者、测试合同做定向对照。源码hunk dry-check为12通过/17不适用；推荐18项中9通过/9需适配。 | `git show <SHA>`；只取源码/生成脚本路径的`git apply --check`，当前固定HEAD；未包含测试、changelog和后续组合状态。 |
| F-005 | 仅凭hunk适用不能认定编译兼容：a6ca86102源码hunk通过，但当前OpenAI SDK类型没有`fast`。 | `packages/ai/package.json`固定openai=6.40.0；已安装版本一致；`node_modules/openai/resources/responses/responses.d.ts:896,5440,6283,6522`枚举无fast。 |
| F-006 | 本轮计费修复不必升级Bedrock SDK：现有锁定/安装的3.1048.0已声明CacheDetail和TokenUsage.cacheDetails。 | `packages/ai/package.json:64`；SDK`dist-types/models/models_0.d.ts:3296-3342`。 |
| F-007 | Mistral超时修复所需combineAbortSignals已存在，不依赖TranscriptContext迁移。 | `packages/ai/src/utils/abort-signals.ts`完整读取；当前Mistral模块仍使用Context。 |
| F-008 | npm run check包含biome --write；共享worktree存在自动改写非owned文件的风险。 | 当前`package.json:18`、AGENTS.md及匹配的LEARNS条目。 |

### 推荐选择矩阵：18个来源提交

“源码可应用”只指本轮独立源码hunk dry-check通过；完整commit、测试适配、组合状态、功能正确性仍未验证。默认采用限定路径forward-port并带上测试，而不是整段cherry-pick；排除上游发布changelog和版本改动。

| 优先级 / 任务 | Commit | 对easy-pi的价值与当前证据 | 方式 / 依赖 |
| --- | --- | --- | --- |
| P0 / T-003 | ebc374490 | proxy无done/error的EOF可能使result等待不结束；当前`agent/src/proxy.ts`在EOF直接end，未处理残余行。 | 源码可应用；保留easy新增itemComplete、thinking正文、promptCacheKey等协议字段。 |
| P0 / T-003 | 64eeb82a4 | Codex最后SSE frame无空行时被丢弃；当前`parseSSE`在done后直接break。 | 源码可应用；只改SSE收尾，不覆盖缓存亲缘/WebSocket/中断恢复。 |
| P0 / T-004 | 509ee2bd0 | user_bash路由hook抛错会被runner吞掉；InteractiveMode随后走本地执行。会破坏扩展所声明的执行目的地。 | 手工适配runner/types/UI及RPC回归；undefined仍允许正常传播，错误或非法定义值fail closed。 |
| P0 / T-005 | bde882c74 | OAuth已开始刷新时取消调用可能丢弃唯一有效的新refresh token；当前请求和模型刷新均把caller signal传给refresh。 | 源码可应用但有行为变更；提取公共刷新路径，不取消已开始的刷新/持久化，保留15秒界限、取消锁等待和调用者快速退出。 |
| P0 / T-006 | 97fa14e39 | 本地compaction已拒绝非stop，但`generateBranchSummary`只拒绝error/aborted，仍会接受length截断。 | **只移植branch summary的拒绝length行为和测试**；不恢复已移除的旧summary/split-turn生成器。 |
| P1 / T-007 | 2bbfcca43 | 无效Retry-After可产生NaN并近乎立即重试；当前provider-retry无finite检查。 | 源码可应用；补充无效日期/Infinity/有效秒数/日期和取消回归，不改变预算/上限。 |
| P1 / T-007 | 5b6c792b4 | 当前分类器缺HTTP/2 pending stream cancellation文案；错误会结束而非进入已有有界重试。 | 手工放入easy网络分类表；同时检查isRetryableAssistantError/isNetworkAssistantError，禁止扩大到用户abort。 |
| P1 / T-007 | 8b5708dbb | 当前分类表缺server_busy及servers are currently busy。 | 手工仅加精确瞬态模式；保留quota/billing优先拒绝、maxRetries与30秒退避上限。 |
| P1 / T-008 | 6c87d9a02 | Mistral续段缺ID时，以id+index为key会把同一toolCall拆开。 | 源码可应用；先用稳定index合并再保留首次真实ID，测试多调用及无index后备。 |
| P1 / T-008 | 7fb59f995 | Mistral finish_reason=error的旧文案不匹配瞬态server error分类。 | 源码可应用；依赖T-007；保留rawStopReason，未知原因不得被误判可重试。 |
| P1 / T-008 | 6b07b4e57 | 当前timeoutSignal贯穿整个body；持续有数据的长thinking也会被固定deadline中断。 | 适配旧Context接口，用现有combineAbortSignals；header deadline和body/caller cancellation分离，不能顺便移除HTTP idle timeout。 |
| P1 / T-009 | 27c7b6ff4 | 当前executeBashWithOperations按chunk stripAnsi，拆开的CSI/OSC会留下碎片，decoder EOF也未flush。 | 手工适配旧临时文件实现；有限pending ANSI、EOF/abort flush，保留滚动缓冲和输出路径语义。 |
| P1 / T-010 | 17f3dccbe | sliceWithWidth把选区起点ANSI放在之前的pending样式前，产生颜色外溢；当前仍是旧分支。 | 源码可应用；保留最新d8256088c宽度优化和正文安全过滤。 |
| P1 / T-012 | f1b2e77f5 | 当前worktree去重比较context file真实路径，使指向主仓库AGENTS的worktree符号链接也被遮蔽。 | 源码可应用；按walked dir真实路径+basename比较，保留AGENTS.override.md优先级和子代理trust政策。 |
| P1 / T-011 | bfa686240 | CJK标点后的@/路径触发与引用缺失，当前delimiter只识别ASCII；中文用户的常见输入受影响。 | 在easy provider/editor适配边界regex、Unicode索引、quoted路径与目录排序；不覆盖skill mention模型。 |
| P1 / T-011 | d5629e204 | 括号/反引号包装的@/路径不会被正确提取；当前未剥离前导wrapper。 | 在bfa686240行为落地后移植；保留[slug]、(group)等真实路径及原包装符。 |
| P1 / T-013 | 8a7b0c03d | 当前Bedrock usage未保留1h cacheDetails，成本会用短TTL计算。 | 源码可应用；无需SDK升级，测试混合TTL和缺失字段，保留total cacheWrite。 |
| P1 / T-013 | 667fc3dd3 | Anthropic目前仅message_start读取cacheWrite1h；Vercel只在message_delta返回拆分时计费不准。 | 在旧SDK usage类型上做窄字段适配；保持reasoning和既有usage字段合并，不升级SDK。 |

### 已有对应行为：不重复移植源码

| Commit | 已确认覆盖面 | 处置 |
| --- | --- | --- |
| 65117e31f | `findLeadingSlashCommandStart`已经trimStart；getSuggestions/applyCompletion保留缩进，还支持重复slash skill lookup。 | 跳过源码；T-011补上游空格/tab/参数案例并继续测试mention。 |
| afda4d620 | executePreparedToolCall在admission、scheduler等待和dispatch后均检查signal；`agent-loop.test.ts:724`已有取消preflight回归。 | 跳过源码；T-014运行现有取消门禁，不用更窄的上游局部判断替换runtime资源/确定性逻辑。 |
| 56700d42e | runLoop已仅在lastCompletedTurn将继续时prepareNextTurn；AgentSession在该接点调用本地压缩。 | 跳过旧自动压缩接线；T-014验证post-tool context、恢复和steering，不引入第二触发器。 |

### 有价值但本轮暂缓：8个候选

| Commit | 暂缓原因 / 重新纳入条件 |
| --- | --- |
| a6ca86102 | Fast计费确有价值，但锁定SDK6.40.0类型不支持fast；需另行批准SDK升级、类型/API差异审查、lockfile/shrinkwrap更新，不能cast掉合同或把source dry-check当编译通过。 |
| 943a10e74 | 长prompt阶梯计费有价值；当前缺openrouter-catalog.ts等上游拆分，patch依赖新模型体系；另开旧generator适配与离线catalog fixture工作，不为定价修复升级schema。 |
| b485fa312 | styled ASCII等部分与d8256088c重叠，footer/bash renderer落点不同；先对easy现有benchmark测增量，按hunk挑非重复优化。 |
| 54c19a252 | WeakRef token cache直接依赖b485fa312新缓存结构；当前不满足原补丁形状，也未测easy保留堆。需CPU/heap对照和渲染一致性证据后再选。 |
| 1355cd36e | BOM配置/frontmatter修复有价值，但触及20文件并重命名edit BOM helper；本轮避免扩大读取/编辑接口范围。后续单独适配，必须保留easy模糊edit、.epi配置和文件BOM回写。 |
| 605a1b038 | 源码hunk可应用，受限Linux/seccomp启动防御有价值；尚无本任务的目标部署条件或复现，放入小型平台加固后续批次，不阻塞核心同步。 |
| 1ac6128e6 | 源码hunk可应用，但把path/kebab-case合成整词是选区产品行为变更；先确认目标，与Thinking点击/逻辑文本复制一起验收。 |
| 12c416e1a | 提交不仅加模型，还改Codex默认；easy当前默认gpt-5.5，与“真实测试默认gpt-6.1-sol”不是同一合同。目录元数据可以另选，默认模型变化必须单独确认。 |

### 架构增量：明确排除

`7fd478a2e`旧harness移除、`466db0fec`canonical context/finishTurn、`9e05370b2`TranscriptContext、`a328aa89a`统一模型schema、`8562bcf66`codemode/MCP、`ba03e03f2`SSH env、`ca7460d16`TS7、`581e7ba78`shrinkwrap移除，均不属于本轮18项修复。它们可供设计参考，不作为小补丁的隐含依赖。也不移植`8dab70281`/`3a0b9a3ee`的cache compaction/provider context回滚。

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption A-001: 后续集成以固定my-pi为起点，保留三个本地提交；若用户选择easy-pi/main起点，必须先安排三个本地修复的保留策略并重做干跑，不能静默丢弃。
- Assumption A-002: 18个来源提交采用最小行为forward-port，可保持0.84.2时代的easy公开API和依赖。源码适用性已检查，功能/类型兼容仍由实施测试确认；发现额外依赖时停止该任务并扩充明确范围，不拉入大迁移。
- Decision Q-001: 用户“开始实施”已授权既定B0-B4，采用计划默认my-pi起点；2026-10-11复验HEAD=728c443b8，三个本地提交保留。
- Open question Q-002: 是否另开Fast SDK/阶梯catalog/性能/BOM/平台批次；本计划不默认实施这些暂缓项。
- user_bash失败中止和OAuth已开始刷新不随请求取消，是明确的行为变更，执行授权时需接受本文合同；正常undefined传播、请求快速取消、凭证安全与有界timeout仍保留。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

### 原计划阶段验收（授权实施前）

- 29个候选有推荐/覆盖/暂缓处置；18个推荐项有具体当前落点、任务、依赖和验收方式。
- 原计划阶段只修改本文，无分支、产品、依赖或测试执行；任务文档结构校验通过。

### 已授权实施验收

- B0-B3中每个任务达成自己的验收条件，相关定向测试、跨任务门禁和npm run check通过。
- 没有引入本节排除的破坏性API或依赖升级；没有丢失三个本地修复和上述easy合同。
- 每个集成提交引用来源SHA，限定owned paths；源码dry-check失败的候选按easy接口重写最小适配，不能以解决文本冲突代替行为验证。
- 任何新fail、基线已有fail、未跑验证分别记录；无法验证时不标done。产品集成或真实API验证未获授权时不得用模拟结果替代。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- B0：T-002固定目标、隔离执行位置、刷新干跑和基线测试；依赖T-001及执行授权。
- B1（P0，5个来源提交）：T-003流收尾、T-004bash hook、T-005OAuth、T-006branch summary；各自依赖T-002。文件边界不同，可在明确owned paths后并行。
- B2（P1可靠性，9个来源提交）：B1全部done后，T-007分类/退避、T-009shell ANSI、T-010TUI ANSI、T-012worktree context可并行；T-008 Mistral须等T-007完成。
- B3（P1体验/计费，4个来源提交）：B2全部done后，T-011补全与T-013缓存计费可并行。
- B4：T-014最终跨任务回归、范围检查和集成报告；依赖T-003至T-013全部done。
- 批次规则：每个任务先定向验证；协调者串行集成、运行本批次npm run check并检查自动改写范围后，才开放下一批次。Git、lockfile、文档与共享检查均单写者。
- 文件串行规则：retry.ts由T-007唯一拥有；Mistral API/test由T-008拥有；utils.ts先T-010后T-011；autocomplete/editor由T-011；resolve/models由T-005；Anthropic/Bedrock adapter由T-013；interactive-mode/extension types由T-004。其他既有回归只运行，不让多个任务改同一测试文件。
- 当前执行模式：B0完成后才能分派B1；子代理不得修改本文、自行提交或接受自己的结果。协调者核对diff与验证后更新唯一状态记录。运行时没有专门DAG工具，使用一次parallel包装同时启动本批次的边界明确任务。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 补丁级筛选与完整选择计划

- Status: done
- Owner: coordinator
- Objective: 完成候选处置、当前代码证据、依赖DAG和回归门禁。
- Inputs and prerequisites: F-001至F-008、29个git show、当前源码/测试/SDK类型、项目规则。
- Scope or files: 只读pi相关源码和Git；仅写本文。
- Expected output: 18项推荐、3项覆盖、8项暂缓及B0-B4执行合同。
- Dependencies: None.
- Execution steps: 对照补丁/调用者；做只读源码hunk干跑；交叉检查类型依赖、重叠行为、任务图与权限；校验文档。
- Acceptance criteria: 选择矩阵与任务完整；没有把适用性当功能通过；仅本文发生项目变更。
- Verification method: 文档validator；refs/tree/count复验；Git范围核对；新文档空白检查。
- Validation evidence: 完整文档task_document.py validate通过；只读计划自检通过：18个唯一且属于main的来源SHA、14任务、推荐项9/9源码干跑、所有当前测试路径存在且4个未来测试明确排除、无行尾空白；29项源码dry-check实际12通过/17不适用；等树/1111/256计数复验通过；Git状态仅本文新增，HEAD和index未改变。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 执行授权、隔离集成位置与基线门禁

- Status: done
- Owner: coordinator
- Objective: 建立不会覆盖并行工作的固定集成起点和可复现基线。
- Inputs and prerequisites: 用户明确执行授权、确认my-pi或替代起点；读取本文完整内容。
- Scope or files: pi Git refs、授权后独立worktree、V-001/V-002/V-004/V-005/V-007中当前已存在的基线测试及V-003安全核查；不改源文件，不在基线阶段运行尚未新增的测试。
- Expected output: 实际执行SHA、worktree路径、基线测试输出、owned paths；原主工作树不切换。
- Dependencies: T-001.
- Execution steps: 复验clean/refs和三个本地提交；新建授权集成worktree，本文留在原绝对路径作为唯一权威，不复制第二状态源；确认依赖已按pin安装且无lifecycle执行，若环境不满足则记录阻塞；重做源码及测试patch干跑；只跑既有定向基线并登记已有失败。
- Acceptance criteria: 起点和权限明确；无遗失/覆盖工作；测试环境可运行且无真实API。
- Verification method: git status/rev-parse/log；V-001至V-007；核对实际安装依赖。
- Validation evidence: 固定HEAD=728c443b8、三个本地提交保留；创建integrate/upstream-fixes-20261011和/tmp/easy-pi-selective-upstream-20261011。外部依赖复用且workspace链接正确；ignored离线provider JSON及源码dist facades补齐后，ai 155/155、agent 40/40、TUI 265/265通过；coding 20文件通过/1文件失败，271通过/2既有断言失败，已归入T-015。task-8、task-5、task-7、task-10日志为实际基线。无真实API/安装/编译，tracked文件仍零改动。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — Codex与proxy流的EOF收尾

- Status: done
- Owner: /root/merge-streams-b1
- Objective: 移植64eeb82a4和ebc374490，保证末尾frame被处理且异常EOF有终态。
- Inputs and prerequisites: 两个完整patch、当前parseSSE/streamProxy、B0固定起点。
- Scope or files: ai/src/api/openai-codex-responses.ts；agent/src/proxy.ts；各自openai-codex-stream.test.ts/proxy.test.ts及对应必要回归。
- Expected output: 限定源码/测试patch，保留easy协议字段和缓存身份。
- Dependencies: T-002.
- Execution steps: 移植decoder/residual flush与proxy终态检测；添加不以空行/换行终结、正常终态、mid-stream EOF、caller abort与完成item场景。
- Acceptance criteria: result在正常/异常EOF均settle；abort不伪装成正常完成；完成item与thinking不丢失；无重复执行。
- Verification method: V-001、V-002的proxy测试，V-007完成thinking/任务恢复门禁。
- Validation evidence: 子代理修复前Codex3项、proxy4项语义失败；协调者读取红测日志并审查源码/完整proxy回归。父代理task-14 Codex41/41、task-15 proxy+agent-loop42/42通过；保留completed blocks、itemComplete/thinking/signature、abort和promptCacheKey。V-007由B1/T-014跨任务门禁统一运行，不能据单位通过提前开放B2。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — user_bash路由错误fail closed

- Status: done
- Owner: /root/merge-bash-hook-b1
- Objective: 移植509ee2bd0，防止失败的路由hook落回本地shell。
- Inputs and prerequisites: emitUserBash、handleBashCommand、RPC bash入口、正常扩展合同。
- Scope or files: coding-agent/src/core/extensions/{runner,types}.ts、modes/interactive/interactive-mode.ts；extensions-runner.test.ts、9068回归；必要扩展说明，不改权限包。
- Expected output: 合法互斥operations/result类型和运行时验证；明确失败退出。
- Dependencies: T-002.
- Execution steps: 明确undefined仅表示继续；非法返回或throw时报告并中止；适配UI/RPC；验证后续handler与本地exec计数。
- Acceptance criteria: throw/null/空对象/双分支不运行后续handler或local exec；合法operations/result只执行/记录一次；!和!!及RPC响应正常。
- Verification method: V-004的extensions-runner与新增9068回归；faux harness，不执行外部命令。
- Validation evidence: 修复前41项语义失败/52通过，协调者读取红测日志及完整9068回归并审查三个源模块diff。父代理task-16 extensions-runner+9068+bash-persistence三文件104/104通过；!、!!、RPC非法/throw无本地exec，undefined及合法override保持。B1根静态检查尚待统一门禁。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — OAuth旋转凭证的取消安全

- Status: done
- Owner: /root/merge-oauth-b1
- Objective: 移植bde882c74的公共刷新路径，取消请求不丢已开始刷新的旋转token。
- Inputs and prerequisites: resolveStoredOAuth、Models.resolveRefreshCredential、CredentialStore.modify、现有取消测试。
- Scope or files: ai/src/auth/resolve.ts、ai/src/models.ts；models-runtime.test.ts；coding-agent/model-runtime-auth-options.test.ts；auth-storage测试只增加必要fixture。
- Expected output: 取消锁等待与不可取消已开始刷新/持久化分离的最小实现。
- Dependencies: T-002.
- Execution steps: 适配共用helper；保留easy ModelsError cause诊断；验证请求/目录刷新/并发/锁等待/超时/logout；旧ImagesModels仍使用同一auth resolver，不迁移模型集合。
- Acceptance criteria: caller abort迅速返回；refresh开始后受独立timeout约束并保存新凭证；并发刷新只一次；不保存失败结果；不读取/输出真实凭证。
- Verification method: V-001 models-runtime/images-models与V-004 auth/runtime mock；所有credential使用内存/临时测试文件。
- Validation evidence: 修复前请求/目录刷新两项真实语义红测未持久化rotated token；协调者读取红测并审查五文件diff。父代理task-17 models/images56/56，task-18 auth-options/auth-storage35/35通过。独立只读verify-b1-safety检查取消/锁/回落合同，无行动性问题；未测真实OAuth/跨进程锁。15秒为响应AbortSignal的provider协作式deadline，不是对忽略signal实现的强制时限。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — 仅补齐branch summary截断保护

- Status: done
- Owner: /root/merge-branch-summary-b1
- Objective: 从97fa14e39移植尚缺的branch length拒绝，不重复改本地compaction。
- Inputs and prerequisites: generateBranchSummary完整函数、narrative.generateCompactionItem既有stop-only校验。
- Scope or files: coding-agent/src/core/compaction/branch-summarization.ts；branch-summarization.test.ts、新增7048 branch持久化回归；compaction-subsystem只运行已有测试。
- Expected output: length摘要返回失败、不改变session branch/history的保护。
- Dependencies: T-002.
- Execution steps: inline拒绝length；用faux构造部分摘要；核对上层navigateTree在失败时不持久化该摘要，保留原分支/历史；验证stop/abort/toolCall旧行为。
- Acceptance criteria: 截断摘要不生成BranchSummaryEntry、不切换leaf；旧完整摘要可用；不恢复旧generateSummary/split-turn函数、不新增第二套compactor。
- Verification method: V-004 branch与新增7048回归；V-007 narrative/session-integration。
- Validation evidence: 修复前2项语义失败（partial被接受并持久化/导航）；协调者读取红测、完整新增回归并审查仅branch-check的源diff。父代理task-13四文件33/33通过；length无BranchSummaryEntry/leaf或历史改变，正常/abort兼容，本地compactor未改动。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 精确瞬态分类与无效Retry-After回退

- Status: done
- Owner: /root/merge-retry-b2
- Objective: 移植2bbfcca43、5b6c792b4、8b5708dbb，不改变easy有界策略。
- Inputs and prerequisites: provider-retry与retry两个完整模块、B1全部通过。
- Scope or files: ai/src/utils/{retry,provider-retry}.ts；ai/test/{retry,provider-retry}.test.ts；coding-agent socket retry预算回归只读运行。
- Expected output: 新分类模式和finite delay回退，旧重试预算保持。
- Dependencies: T-003, T-004, T-005, T-006.
- Execution steps: 先finite-check，再加入HTTP/2网络模式和busy瞬态模式；fake timers验证有效/无效Retry-After、quota优先级、预算耗尽与abort。
- Acceptance criteria: 非finite值走指数退避；quota/billing/用户取消不重试；HTTP/2在network与retryable分类一致；所有瞬态共享既有maxRetries与上限。
- Verification method: V-001 retry/provider-retry；V-007 socket-retry-budget和retry-events。
- Validation evidence: 子代理先红21失败/76通过，修复后97通过；协调者源diff仅5行模式/2处finite检查，父代理task-26 97/97通过；子代理socket+retry-events35通过。已核对有界预算/abort/quota优先不变；B2全局门禁仍未完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — Mistral分片、错误终态与header timeout

- Status: done
- Owner: /root/merge-mistral-b2
- Objective: 按6c87d9a02→7fb59f995→6b07b4e57的行为顺序移植三项修复。
- Inputs and prerequisites: 当前Context和cache key合同；现有combineAbortSignals；T-007分类器。
- Scope or files: ai/src/api/mistral-conversations.ts；mistral-http-transport.test.ts、mistral-raw-stop-reason.test.ts；不改SDK/TranscriptContext。
- Expected output: 连续toolCall可正确合并，瞬态error可分类，长活动流不受header deadline中断。
- Dependencies: T-007.
- Execution steps: 优先index匹配；保留raw stop；适配header-only signal并清理监听器；body保留caller cancellation；添加多工具、缺ID、长流、header超时、body取消和缓存参数回归。特别验证无caller signal的长流：现有combineAbortSignals对单signal直接返回，cleanup不解耦；用尊重request signal的mock或loopback证实deadline不会继续取消response body，避免照搬仅在双signal下有效的组合。
- Acceptance criteria: 缺ID续段不产生重复调用；未知stop reason仍不重试；header超时可诊断；活动流超过deadline仍正常；取消及时且cache affinity/payload不变。
- Verification method: V-001三项Mistral定向测试和V-007有界retry门禁；fetch全部mock。
- Validation evidence: 子代理产品修复前11项语义失败/87通过，最终100通过；协调者读取红测/反事实日志并审查三文件diff，父代理task-31四文件100/100通过。临时去掉inactive fallback时callerless长流1失败/带caller1通过，恢复后两者通过；同一个精确header信号mock验证response body绑定及监听器清理，未改共享helper/SDK/Context。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 用户bash输出的有界分块ANSI解码

- Status: done
- Owner: /root/merge-shell-ansi-b2
- Objective: 移植27c7b6ff4，清除跨chunk的CSI/OSC残片并flush decoder。
- Inputs and prerequisites: 当前bash-executor临时文件实现、ansi.ts和B1合同。
- Scope or files: coding-agent/src/core/bash-executor.ts、utils/ansi.ts；ansi-utils.test.ts、suite/agent-session-bash-persistence.test.ts；不重写后台任务执行器。
- Expected output: 有限pending buffer和收尾处理，流式/返回/持久化输出一致。
- Dependencies: T-003, T-004, T-005, T-006, T-015.
- Execution steps: 只移植跨chunk解码和flush；保留原输出文件生成器与滚动buffer；覆盖CSI/OSC/分段UTF-8/abort/超长未终结序列/大输出路径。
- Acceptance criteria: pending长度有界；正常/取消均正确收尾；不引入输出文件关闭/截断回归；不放宽正文DEC模式安全边界。
- Verification method: V-004 ansi-utils/bash-persistence和V-007任务输出/terminal-output-safety。
- Validation evidence: 子代理修复前9项语义失败/19通过，最终47通过；协调者读取红测并审查源diff及完整新增边界测试，父代理task-30 ansi/bash-persistence/task-recovery三文件83/83通过。pending≤256、正常/abort decoder flush、原raw-byte tempfile门槛/rolling截断/错误清理和T-015严格audit断言保持，DEC安全测试另由task-25通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — ANSI列切片顺序修复

- Status: done
- Owner: /root/merge-tui-ansi-b2
- Objective: 移植17f3dccbe，保留slice起点pending ANSI的源顺序。
- Inputs and prerequisites: 当前sliceWithWidth与d8256088c宽度快路径。
- Scope or files: tui/src/utils.ts的sliceWithWidth；新增regression-slice-by-column-ansi-order.test.ts及相邻切片测试。
- Expected output: 小hunk修复及原上游断言，未改变其他宽度/缓存算法。
- Dependencies: T-003, T-004, T-005, T-006.
- Execution steps: 移植边界flush；检查ANSI reset、CJK宽字、strict边界、OSC与搜索高亮；不改选区点击或复制的数据源。
- Acceptance criteria: 精确ANSI顺序断言通过；文本和宽度无变化；现有overlay/鼠标/内容安全合同通过。
- Verification method: V-005切片/wrap/overlay/安全定向门禁。
- Validation evidence: 子代理精确ANSI顺序红测0通过/2失败；协调者审查7行生产hunk和完整7例新测试，task-25四文件52/52通过（0skip）；子代理邻接editor/宽度/补全222通过。快路径及复制/点击策略未变，未做性能测量或真实剪贴板测试。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 中文与包装符补全，保留skill mention

- Status: done
- Owner: /root/merge-completion-b3
- Objective: 适配bfa686240再适配d5629e204；只补65117e31f的测试，不重复源码。
- Inputs and prerequisites: easy完整CombinedAutocompleteProvider、atomic mention模型、T-010完成。
- Scope or files: tui/src/{autocomplete,utils}.ts、components/editor.ts；autocomplete.test.ts、editor.test.ts、slash-skill-autocomplete.test.ts；coding-agent skill mention回归只运行。
- Expected output: CJK分隔、quoted路径、wrapper前缀正确，原mention编码/提交/原子编辑完整保留。
- Dependencies: T-008, T-009, T-010, T-012, T-016.
- Execution steps: 在现有leading/trailing slash接线中加入路径边界而不替换provider；Unicode索引按UTF-16合同计算；覆盖中文文件名、内嵌@、包裹符、[slug]/(group)、引号、缩进和重复skill。
- Acceptance criteria: 前缀替换位置/光标正确；skill不能退化成普通文本或自动提交；目录排序正确；已有中文/emoji/软折行/剪贴板逻辑不变。
- Verification method: V-005补全/editor/mention；V-004 interactive-mode-skill-mentions；fd缺失必须明确报告而非静默跳过关键案例。
- Validation evidence: bfa阶段12红/9对照、wrapper阶段5红/1对照；独立复核发现partial literal和连续Tab下钻遗漏，追加红测分别2失败/1对照，最终最小filesystem候选优先和同类wrapper深度配对修正，backtick按下一次出现闭合。协调者审查实际源diff/红测/新交互用例，连续专项review无行动性问题；父代理task-50七文件299/299、task-49 coding24文件368/368通过（0skip），task-51根check exit0、1408文件No fixes applied。fd10.4.2实测，关键fixtures未静默skip；原mention/slash/参数/逻辑文本/安全边界未覆盖重写，未测Windows或物理终端。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — nested worktree符号链接AGENTS加载

- Status: done
- Owner: /root/merge-worktree-context-b2
- Objective: 移植f1b2e77f5，修正worktree自身AGENTS被误去重。
- Inputs and prerequisites: 当前findShadowedContextFile/loadProjectContextFiles、工作区路径规范化行为。
- Scope or files: coding-agent/src/core/resource-loader.ts；resource-loader.test.ts的worktree context组；不改trust/身份规则。
- Expected output: worktree symlink只加载一次，主仓库重复不注入。
- Dependencies: T-003, T-004, T-005, T-006.
- Execution steps: 移植dir realpath+basename比较；覆盖worktree→main symlink、两者指向共享文件、缺worktree override、普通/sibling/bare/submodule路径。
- Acceptance criteria: 该加载时加载，不重复/扩展到无关祖先；AGENTS.override优先级与现有全局/父目录继承保持。
- Verification method: V-004 resource-loader、V-007资源/trust与child合同回归。
- Validation evidence: 子代理红测2失败/41通过，之后43通过；协调者读取红测并审查完整diff，task-24 resource-loader+collaboration-cache两文件50/50通过；全局/普通/sibling/bare/submodule和override层级既有测试保持，实际child trust来源未改。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — Bedrock/Vercel长TTL缓存计费

- Status: done
- Owner: /root/merge-cache-cost-b3
- Objective: 移植8a7b0c03d与667fc3dd3；不含Fast SDK升级或阶梯catalog迁移。
- Inputs and prerequisites: 现有SDK3.1048.0类型、calculateCost cacheWrite1h支持、Anthropic旧usage合并合同。
- Scope or files: ai/src/api/{bedrock-converse-stream,anthropic-messages}.ts；新增bedrock-cache-write-1h-cost.test.ts、anthropic-cache-write-1h-cost.test.ts；不改生成目录。
- Expected output: 1h与5m混合usage正确，cache总量和cost一致。
- Dependencies: T-008, T-009, T-010, T-012, T-016.
- Execution steps: Bedrock读取cacheDetails；Vercel delta读取1h拆分；使用当前模型或合成cost fixture，不为测试拉入新catalog；保留reasoning、缺失delta字段与start usage。
- Acceptance criteria: 混合TTL、仅delta拆分、无拆分后备均正确；totalTokens不重复累加子集；SDK、schema、默认模型不变。
- Verification method: V-001两项TTL成本回归；V-007 cache-stats与session-cache-affinity只读门禁。
- Validation evidence: 子代理红测3失败/7通过，源代码仅4+7行，之后10通过；协调者读取红测/完整新fixture和源diff，task-38 TTL/metadata/raw-stop四文件21/21、task-40 UI/usage/cache六文件31/31通过；task-41根check exit0且No fixes applied。无SDK/模型目录/计费器schema变更，未测真实提供商。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — 最终集成、跨任务门禁与报告

- Status: done
- Owner: coordinator
- Objective: 验证18项适配组合不会回退easy定制，产生可审查的集成记录。
- Inputs and prerequisites: 所有owned patch、每项来源SHA与实际定向验证记录，B1-B3检查通过。
- Scope or files: 集成分支；全部门禁通过后安全快进原my-pi（仅HEAD仍为728c443b8且工作区除本文外干净，遇漂移停止）；本文始终留在原绝对路径，最终在my-pi单独提交，不创建竞争状态文档。
- Expected output: 逐来源映射/明确跳过项、真实check/test结果、范围diff、剩余风险；不自动push/release。
- Dependencies: T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-010, T-011, T-012, T-013, T-015, T-016.
- Execution steps: 串行核对diff和owned files；跑V-001至V-007；跑V-006并核对自动改写范围；核对三个本地提交可达、依赖/身份/API不变；按显式路径提交来源可追溯的最小patch；最终检查原my-pi refs/index/worktree未漂移，执行git merge --ff-only到已验证集成分支，若有其他改动则停止而不stash/reset；复验并单独提交完整验证后的本文。
- Acceptance criteria: 当前所有选中任务都有验证证据；无越界源码/lockfile修改；回归与检查通过或明确阻塞；未获授权的发布/真实API不执行。
- Verification method: V-001至V-007、git diff --check、git log、文档validator和最终worktree状态。
- Validation evidence: 最后源码版本task-47 agent51、task-48 ai239、task-49 coding368、task-50 TUI299通过，共47文件957项、0skip；task-51完整npm run check exit0、1408文件No fixes applied，前后tracked diff完全相同。task-52提交后审计确认41个owned源码/测试文件、18个完整上游SHA、原三个提交ancestor及main/easy-pi基线不变。task-53严格验证原my-pi仍728c443b8、index/worktree除本文外干净后ff-only到aa38c9a7d；原分支未切换且源码tree与已验证集成worktree精确相同。所有代理已关闭，文档validator通过；本文按明确路径单独docs提交，不push/release。基线两项旧审计断言已由T-015修正而非忽略，真实API/平台限制见最终结果。
- Blocker: None.
- Unblock condition: None.

### [x] T-015 — 对齐既有bash持久化测试与审计记录合同

- Status: done
- Owner: coordinator
- Objective: 处理B0已复现的两项过时断言，不改变任务恢复产品逻辑。
- Inputs and prerequisites: task-10两项失败；task-recovery.ts写入pi-task-recovery；session-manager.ts将pi-task-recovery/pi-tool-interruption作为内部记录投影过滤的合同。
- Scope or files: 仅coding-agent/test/suite/agent-session-bash-persistence.test.ts中原有两个失败案例；T-009启动前完成，避免同文件并发。
- Expected output: 持久化消息顺序/aborted message断言保持，显式允许且检查已知审计记录，不跳过任意未知custom条目。
- Dependencies: T-002.
- Execution steps: 对照审计写入和消息投影；只调整测试选取消息的方式并增加内部记录类型断言；重跑该文件和任务恢复相关基线。
- Acceptance criteria: 原两项失败转绿且消息顺序/abort/audit合同仍严格；产品源码零改动。
- Verification method: 定向bash-persistence.test.ts、task-recovery.test.ts、4a61062a-recovery-cache-prefix.test.ts；diff审查。
- Validation evidence: 基线task-10两项失败已复现；只调整消息选取并显式校验audit customType只能为pi-task-recovery/pi-tool-interruption。task-11运行bash-persistence、task-recovery、4a61062a-cache-prefix三文件49/49通过；协调者diff审查和git diff --check通过。产品源码未因T-015变化，批次静态检查仍由B1协调者门禁负责。
- Blocker: None.
- Unblock condition: None.

### [x] T-016 — proxy EOF接入既有完成item恢复分类

- Status: done
- Owner: coordinator
- Objective: 验证并补齐T-003新proxy EOF错误与easy原生完成item恢复的分类接线，不更改执行/重试政策。
- Inputs and prerequisites: T-003/T-007通过；agent-loop.ts只有isRetryableAssistantError时才生成完成item checkpoint，现有network表不匹配新proxy EOF文案。
- Scope or files: ai/src/utils/retry.ts的一条精确网络模式；agent/test/proxy.test.ts新增源级Agent集成回归；不修改agent-loop/task recovery实现。T-007已停止编辑，避免文件并发。
- Expected output: proxy中断后已完成tool item形成checkpoint且只执行一次，未完成/无标记项不执行；用户取消不恢复。
- Dependencies: T-003, T-007.
- Execution steps: 用mock proxy EOF+Agent复现分类遗漏并记录红测；如证明，加入精确文案并验证checkpoint/结果/调用计数；运行retry、proxy、agent-loop、task恢复门禁。
- Acceptance criteria: 新EOF路径遵守既有itemComplete恢复合同；无广泛cancel/error分类变化；不扩大自动重试预算。
- Verification method: mock源级Agent/proxy集成测试、retry/agent-loop及task-recovery回归；diff检查。
- Validation evidence: task-27源级Agent红测1失败/3通过：已完成tool item执行次数0而非1，证实分类接线缺失；加入单条精确网络文案后，task-28 proxy+agent-loop46/46、task-29 retry/provider-retry97/97通过；未完成/无itemComplete/用户abort仍不执行。task-35完整coding回归366通过（含task-recovery），task-32根check通过且No fixes applied；协调者审查精确单模式和四种checkpoint场景。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

以下为**批准后的定向命令合同**，实际执行及结果见各任务证据和日志。使用包目录执行；`VITEST`指向执行worktree根`node_modules/vitest/dist/cli.js`。任何创建/修改的测试必须执行。测试列表中的“新增”只在相应任务落地后运行，不作为原计划阶段的已有覆盖证据。最终门禁在此列表基础上另含Bedrock error-metadata/raw-stop及grok-thinking-mouse邻域，共47文件、957项通过。

- V-001 / ai（cwd=`packages/ai`）：`node "$VITEST" --run test/openai-codex-stream.test.ts test/retry.test.ts test/provider-retry.test.ts test/mistral-http-transport.test.ts test/mistral-raw-stop-reason.test.ts test/mistral-tool-schema.test.ts test/models-runtime.test.ts test/images-models.test.ts test/anthropic-cache-write-1h-cost.test.ts test/bedrock-cache-write-1h-cost.test.ts`；最后一项新增。按任务只运行对应文件，集成时再组合。
- V-002 / agent（cwd=`packages/agent`）：`node "$VITEST" --run test/proxy.test.ts test/agent-loop.test.ts test/tool-plan.test.ts test/resource-scheduler.test.ts`；守住预检取消/资源释放/完成item协议。
- V-003 / fixture安全：实施前读取选中的测试，确认mock/faux、不启用真实provider；真实/e2e文件和PI_REAL_MODEL_*开关不属于本计划，禁止跑全vitest套件。
- V-004 / coding-agent（cwd=`packages/coding-agent`）：`node "$VITEST" --run test/extensions-runner.test.ts test/model-runtime-auth-options.test.ts test/auth-storage.test.ts test/branch-summarization.test.ts test/resource-loader.test.ts test/ansi-utils.test.ts test/suite/agent-session-bash-persistence.test.ts test/interactive-mode-skill-mentions.test.ts test/suite/regressions/9068-user-bash-fail-closed.test.ts test/suite/regressions/7048-branch-summary-truncated.test.ts`；最后两项新增/适配名，fixture必须遵守easy API和.epi产品路径，以当前CONFIG_DIR_NAME为准，不能照搬上游.pi断言。
- V-005 / tui（cwd=`packages/tui`）：`node --test test/regression-slice-by-column-ansi-order.test.ts test/autocomplete.test.ts test/editor.test.ts test/slash-skill-autocomplete.test.ts test/wrap-ansi.test.ts test/overlay-options.test.ts test/terminal-output-safety.test.ts`；切片回归新增。补全fixture需要fd时明确安装/现有定位条件，不让关键案例skip冒充通过。鼠标/Thinking要走实际输入状态机；输入复制断言逻辑文本而非带边框屏幕行。
- V-006 / 静态与范围（cwd=pi根）：协调者串行`npm run check`，完整输出，不tail；前后记录`git status --porcelain=v1`与`git diff --stat`，核对biome自动改写仅owned paths。若触及别人改动，停止并报告，禁止stash/reset/clean。通过后`git diff --check`。不运行npm run build、npm test或release命令。
- V-007 / easy跨任务合同（cwd=`packages/coding-agent`）：`node "$VITEST" --run test/suite/agent-session-thinking-completion.test.ts test/suite/agent-session-task-recovery.test.ts test/suite/agent-session-socket-retry-budget.test.ts test/suite/agent-session-retry-events.test.ts test/suite/runtime-tool-cancellation.test.ts test/compaction-subsystem/narrative.test.ts test/compaction-subsystem/session-integration.test.ts test/session-cache-affinity.test.ts test/session-cache-affinity-hint.test.ts test/pi-collaboration-cache-affinity.test.ts test/cache-stats.test.ts test/suite/regressions/4a61062a-recovery-cache-prefix.test.ts test/suite/regressions/4167-thinking-toggle-pending-tool-render.test.ts`；保留任务恢复、缓存亲缘、已完成thinking、预算和交互合同。B0记录任何已有fail，不声称上游修复已验证这些路径。

测试通过不能证明真实平台/服务行为：本轮不承诺真实缓存命中率、真实OAuth提供商行为、Linux seccomp或终端图片协议。发现mock无法覆盖的重要边界时记为未验证，另行请求授权，不隐式启用真实API。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

1. 执行授权已提供，B0-B3已完成；仍不实施暂缓项、架构迁移、真实API或发布/push。
2. 历史哈希重写：raw merge-base很早，禁止据此整段同步；来源范围固定为59a71b235..e37cdc420。
3. 文本干跑不是编译/运行验证：9个选中源码hunk能应用，9个要适配；测试和changelog未包含在干跑里。组合后的patch还可能改变上下文。
4. a6ca86102是干跑通过却缺SDK类型的实际反例；本轮把它暂缓，不伪造编译通过，不用断言绕过类型合同。
5. OAuth取消边界会改变既有断言，需更新期望而非简单删除测试；刷新不可无限运行，退出/锁/持久化都须验证。
6. 本地compaction比上游旧摘要器更深入；97fa14e39仅补branch分支，其他保护已覆盖，不恢复退役实现。
7. CJK/ANSI补丁接触近期优化区；utils.ts串行，保留原mention、内容安全过滤和逻辑复制，不靠外观截图证明状态机正确。
8. 共享worktree的formatter会写文件；优先隔离执行，Git和检查单写者；任何无关diff不擅自回滚。
9. 范围界限：仅29个候选的定向分析，不是1111个commit完整缺陷审计；暂缓不代表这些补丁无价值，也不证明它们在easy一定有可达问题。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 创建plan文档并立即填入合同；T-001 pending→in_progress，Owner=coordinator；工作区和refs未漂移，未启动子代理。
- 2026-10-11: 取得29个候选完整git show并对照关键源码、调用者及回归测试；初稿文档validator通过。
- 2026-10-11: 对29项的源码/生成脚本hunk运行只读git apply --check，12通过/17不适用；项目仅本文未跟踪文件，源代码未变化。
- 2026-10-11: 确认65117e31f、afda4d620、56700d42e已有对应行为；97fa14e39的本地compaction部分已覆盖，但branch summary仍需保护，改为仅移植该分支。
- 2026-10-11: 对照锁定和安装SDK；a6ca86102虽源码干跑通过，OpenAI6.40.0类型不含fast，纳入暂缓；Bedrock3.1048.0已有cacheDetails，不需要升级。
- 2026-10-11: 完成18项选择、3项覆盖、8项暂缓和14任务DAG；所有实施状态pending。
- 2026-10-11: 完整文档validator及计划自检通过；只读自检确认18项唯一SHA、任务数量/干跑统计、既有测试路径/4项未来测试、无行尾空白及仅本文新增。T-001 in_progress→done；整体pending表示实施等待授权，T-002至T-014未开始。

- 2026-10-11 02:59 +0800: 用户授权“开始实施”；Mode转为execute，T-002 pending→in_progress，Owner=coordinator；refs及三项本地修复未漂移，原主工作树仅有本任务文档。

- 2026-10-11 03:04 +0800: 创建`integrate/upstream-fixes-20261011`，worktree=`/tmp/easy-pi-selective-upstream-20261011`，起点728c443b8；原主工作树保持my-pi。外部node_modules复用既有安装，workspace包链接指向新worktree，未安装/升级依赖。
- 2026-10-11 03:04 +0800: 首轮基线agent 40/40、TUI 265/265通过；ai/coding基线因新worktree缺ignored provider JSON及dist入口而collection失败，非产品回归。离线复制既有provider数据，并在ignored dist中增加grok-tui/Codex API源码facade，确保验证新worktree源码而非旧编译产物；重跑ai/coding基线进行中，产品tracked文件仍零改动。

- 2026-10-11 03:05 +0800: B0完成：ai155、agent40、TUI265通过；coding271通过/2项既有断言失败。新增T-015（同一T-009测试文件的审计合同对齐，纯测试）并启动；T-002→done，T-003至T-006→in_progress，按owned paths准备一次并行分派；文档仍由协调者唯一写入。

- 2026-10-11 03:09 +0800: T-015两项既有断言按审计合同对齐，限定同一持久化测试文件；task-11三文件49/49通过，协调者审查diff及whitespace通过；T-015→done。B1四子任务并行执行中，尚未接受其修复结果。

- 2026-10-11 03:14 +0800: 父代理独立复验并接受T-003（task-14 41、task-15 42）、T-004（task-16 104）、T-006（task-13 33），三任务→done；已检查语义红测及实际diff。T-005仍进行中，B1批次静态/跨任务门禁尚未完成，不开放B2。另派发独立只读verify-b1-safety复核OAuth/路由取消合同，无编辑权限。

- 2026-10-11 03:17 +0800: T-005经父代理56+35项复验、diff/红测审查及独立只读复核后→done；全部B1单位任务已接受。独立审查没有行动性问题，注明15秒协作式timeout和未测跨进程锁边界。根check(task-19)全阶段无诊断且No fixes applied；额外直接check(task-20)与B1完整ai/coding跨任务门禁(task-22/task-21)运行中，尚未提交或开放B2。

- 2026-10-11 03:18 +0800: B1完整门禁通过：task-20直接npm run check exit0、1406文件No fixes applied，scope无额外文件；task-22 ai9文件169/169、task-21 coding23文件333/333，父代理agent-loop/proxy42通过。B1提交：bf8b0d8ca(T-015)、6495c67f9(T-003)、835e029db(T-004)、dbb564ac1(T-005)、32e2e2283(T-006)；集成worktree干净，原my-pi未变。
- 2026-10-11 03:18 +0800: 开放B2：T-007/T-009/T-010/T-012 pending→in_progress并指定owned paths；T-008等待T-007完成，T-011/T-013仍等待B2。准备一次parallel分派四个无文件重叠任务。

- 2026-10-11 03:21 +0800: 协调者补充T-008已在原目标内的无caller-signal验收边界：现有combineAbortSignals单signal时返回原signal且cleanup为no-op，必须验证fetch body与header deadline解耦，不能让忽略signal的mock掩盖问题；暂不改共享helper或扩大生产文件范围。

- 2026-10-11 03:27 +0800: 父代理接受T-007（97）、T-010（52）、T-012（50）的源diff/红测及独立复验，三任务→done；T-008解除依赖并启动。新增T-016，仅验证T-003新proxy EOF文案与既有完成item gate的接线，独立于18项来源列表；如果语义红测证实则最小修正classifier，不改runtime。B3依赖增加T-016，避免遗漏恢复集成边界。

- 2026-10-11 03:32 +0800: T-009父代理83项及diff/红测审查通过→done。T-016完成item恢复红测实际复现：proxy新EOF文案未匹配retryable gate，使完成调用执行0次；最小精确网络模式后46+97项转绿，保留未完成/用户abort不执行；运行最终恢复和静态门禁前仍in_progress。T-008继续进行中。

- 2026-10-11 03:39 +0800: B2单位T-008及T-016接受→done；全部B2门禁通过：task-32根check exit0、1407文件No fixes applied；task-33 ai220、task-34 agent51、task-35 coding366、task-36 TUI272，合计909项（无skip）。9个B2来源与proxy恢复接线均已验证，准备协调者提交并开放B3。

- 2026-10-11 03:42 +0800: B2提交完成：2b8dcfdb4(T-007/T-016)、bd399974c(T-008)、91b6ab20d(T-009)、8f34e2e70(T-010)、58cfc751e(T-012)；集成worktree干净，累计14个选中上游来源已适配。开放B3，T-011/T-013 pending→in_progress，按无重叠文件一次parallel分派；T-014等待两项接受。

- 2026-10-11 03:55 +0800: B3两子任务报告完成；父代理已审查11行计费源diff/完整新fixture及TUI适配源diff、红测，实际父代理复验进行中；独立只读verify-b3-completion在检查语法边界。明确T-014最终交付：先验证并提交集成分支，再仅在原my-pi无漂移/其他改动时安全快进，不切分支或覆盖；权威文档继续只有原路径一份，最终在my-pi提交。

- 2026-10-11 04:01 +0800: 父代理接受T-013，21+31项及task-41根check通过。独立B3复核提出partial literal '[sl'/'(gr'被剥离的Medium回归；T-011仍in_progress，followup要求先红后绿且保留真实目录优先的旧行为。fd反馈与既定关键场景“不静默skip”合同冲突，保留requireFdPath（本机fd10.4.2实测存在），未改变生产fd可选性。未提交B3或快进原my-pi。

- 2026-10-11 04:11 +0800: T-011首次复核遗漏已通过新增partial-prefix红测（2失败/1对照通过）及最小filesystem优先策略修复；父代理task-42 TUI296通过。但连续只读复查发现外层同类wrapper包裹字面目录后的第二次Tab下钻（`see ((gr`→`see ((group)/`）仍误判closer归属，T-011继续in_progress并要求深度配对专项红/绿；尚不接受B3或快进。此前task-43及当前tests结果只用于已读版本，最终门禁将在修正后重跑。

- 2026-10-11 04:16 +0800: T-011连续Tab修正红2/绿3及实际diff通过父代理审查；连续专项复核确认旧缺陷均已修，无行动性问题（非新的全量独立审查）。最后源码版本父代理V-001 ai12文件239、V-002 agent4文件51、V-004/V-007 coding24文件368、V-005 TUI7文件299，合计957通过、0skip；task-51根npm run check exit0、1408文件No fixes applied，锁定元数据不变。T-011→done，B3接受；T-014 pending→in_progress，准备显式路径提交和范围/归属审计后安全快进。既定文件范围不含LEARNS.md，已证实的适配边界保留于本文而不额外扩大修改范围。

- 2026-10-11 04:16 +0800: B3显式路径提交99bc1c4dc(T-011)、aa38c9a7d(T-013)；最后源码HEAD=aa38c9a7de713e6a94d91de8a3688b09fcffaa07。task-52最终审计通过：41个owned源码/测试文件、18个完整来源SHA均在提交正文、三个原有修复ancestor、main/easy-pi基线refs未变、集成worktree干净。check前后tracked diff完全相同；所有B3代理已关闭，准备严格漂移门禁快进原my-pi。

- 2026-10-11 04:16 +0800: task-53原my-pi漂移门禁全部通过，ff-only交付到aa38c9a7de713e6a94d91de8a3688b09fcffaa07；原分支仍my-pi，index干净，源码tree与已验证集成worktree精确相同，只剩本权威文档未跟踪。T-014验收→done，全部16任务完成；最终状态文档通过validator后按明确路径单独docs提交，提交后再次核对clean/refs/来源归属。未执行build、依赖更新、真实API、push或发布。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001至T-016均done、无blocked。18个上游来源已限定行为适配，12个集成提交、41个源码/测试文件；最后版本定向47文件957项通过、0skip（ai239、agent51、coding368、TUI299），根npm run check exit0、No fixes applied。原my-pi已安全快进到已验证源码HEAD `aa38c9a7de713e6a94d91de8a3688b09fcffaa07`，三个原有修复均保留；本文作为最终记录单独docs提交。集成分支和独立worktree保留供审查。
- Limitations: 无真实提供商/API、真实账单/缓存命中、OAuth跨进程锁、Windows或物理终端验证；OAuth15秒是provider遵守AbortSignal的协作式deadline，不是强制promise时间上限。只用mock/faux/离线fixtures，worktree的ignored dist源码facades不是构建产物；未运行build、全套测试或发布。8个暂缓项和3个已覆盖项的处置不变，main/easy-pi基线refs不变，未push。LEARNS.md不在授权owned范围，已证实的适配边界记录于本文，无额外编辑。

### 来源与集成提交映射

| 集成提交 | 任务 | 上游来源（完整SHA见提交正文） |
| --- | --- | --- |
| bf8b0d8ca | T-015 | 本地既有audit断言对齐，无新增上游来源 |
| 6495c67f9 | T-003 | 64eeb82a4、ebc374490 |
| 835e029db | T-004 | 509ee2bd0 |
| dbb564ac1 | T-005 | bde882c74 |
| 32e2e2283 | T-006 | 97fa14e39（仅branch length保护） |
| 2b8dcfdb4 | T-007/T-016 | 2bbfcca43、5b6c792b4、8b5708dbb；另补proxy EOF精确恢复分类接线 |
| bd399974c | T-008 | 6c87d9a02、7fb59f995、6b07b4e57 |
| 91b6ab20d | T-009 | 27c7b6ff4 |
| 8f34e2e70 | T-010 | 17f3dccbe |
| 58cfc751e | T-012 | f1b2e77f5 |
| 99bc1c4dc | T-011 | bfa686240、d5629e204；保留literal目录及连续Tab下钻 |
| aa38c9a7d | T-013 | 8a7b0c03d、667fc3dd3 |
