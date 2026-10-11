# Task Plan: easy-pi 剩余可选上游提交实施

- Created: 2026-10-11
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户“按照建议实施”，并通过结构化问题确认全部8项逐项推进、最小SDK/锁文件升级、只加模型不改默认、全屏整词选区及完整实施合同。

<!-- task-doc-section:background-goal -->
## Background and goal

在已完成18项选择性合并的my-pi上继续处理8个暂缓候选，保留easy定制。性能两项是评估后选择，不是预先承诺合入。前一轮权威记录已完成且不修改；本文是本次运行唯一任务和状态源。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 1355cd36e：适配BOM输入读取，保留模糊edit及文件BOM回写。
- a6ca86102：Fast按priority计费；允许所需最小OpenAI SDK升级，固定精确版本，审查release/type差异及锁文件。后续明确修订：内建显式缓存长期TTL按SDK声明使用30m，旧式prompt_cache_retention=24h路径保留，采用SDK原生类型，不cast伪造能力；原有onPayload/samplingParams自定义接点保持。
- 943a10e74：在现有generator/API上保留各catalog的prompt-length tiers，不顺带迁移模型体系。
- 12c416e1a：新增GPT-6.1 Sol目录/能力；明确不改变任何provider默认模型。
- 605a1b038：受限SIGWINCH启动防御；1ac6128e6：全屏路径/kebab-case双击整词，保护Thinking点击和逻辑复制。
- b485fa312、54c19a252：先测后选非重复hunk，有可复现收益且无渲染/内存回归才合；不足时记录不合入的实际依据。
- 原工作树不切分支、不覆盖其他会话；在独立worktree `/tmp/easy-pi-optional-upstream-20261011`、分支 `integrate/optional-upstream-20261011` 实施。Git/lockfile/模型再生成/根formatter仅协调者串行操作。最终仅原my-pi仍为起点且除本文外干净时ff-only；漂移则停止，不stash/reset。SDK/模型新增不能只交付源码却留下原运行环境不可用：新增T-012准备版本/数据哈希与有界离线产物，T-010交付时同时验证原ignored数据/SDK未漂移，再以ignore-scripts刷新必要SDK并应用仅三个Sol生成记录/manifest。任何额外数据/依赖变化停止，不覆盖其他会话。
- 不真实API/凭证/付费评测，不安装生命周期脚本，不build、全vitest、npm test、push、发布或架构迁移。模型生成仅离线数据/fixtures，不请求服务。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前my-pi起点4eb4cb91df14bc641b41e3d52eedc19526495182，开工干净，包含前轮18项修复及原三个本地修复。 | 本轮git status/rev-parse和前轮已提交权威文档。 |
| F-002 | main=e37cdc420669e48b4df4bbce0fb2617fc3c71328，easy-pi/main=e1ae7912ba4ce8b3da251a3d08f900b8847ac079。 | 本轮refs复验，不再fetch。 |
| F-003 | 8个来源SHA及文件范围已复验；BOM20文件，性能两项均与easy实现有重叠。 | 本轮git show --stat八项，前轮选择矩阵。 |
| F-004 | 当前OpenAI固定6.40.0；上轮已证实类型缺fast。本轮用户明确允许最小升级及必要锁文件。 | packages/ai/package.json及本轮确认回答。 |
| F-005 | 当前运行可用286MB既有依赖；不能将workspace链接指回旧源码，SDK升级不能写原共享node_modules。 | 原依赖目录检查、前轮collection和源码facade证据。 |
| F-006 | 新独立worktree已在固定起点建立；原工作树仅新增本文。 | git worktree add实际成功输出。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 额外需求假设：无。用户明确确认了实施合同。
- 待验证事实：最小支持fast的SDK版本、tiers/GPT目录在当前分支的已有覆盖、性能剩余hunk收益、平台测试能力。必须先取得证据，不把源码干跑或微基准当产品收益。
- 主要关闭分支：不改默认模型，不全量升级依赖，不直接合入大架构，不用真实API；性能无证据时不合。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 每个候选有实际适配/已有覆盖/条件未满足的可追溯处置，不宣称8个必然全部合入。
- 新修复具备红/绿或等效反事实证据，所有新增/修改测试执行；保持前轮18项和原三个修复可达。
- 计费与模型生成用离线fixtures；生成文件经generator生成，默认模型源码和默认行为不变。
- 依赖升级限必要版本，锁文件变化可解释，忽略lifecycle，根check及定向回归通过。
- 性能记录完整环境、重复A/B原始样本、代表性组件路径与正确性/内存检查；收益未超过噪声或无法验证则不合。
- 原工作树安全交付，本文最终校验并单独docs提交，无push/release。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- B0：T-001环境与定向基线；完成后B1开放。
- B1：T-002 BOM、T-003 SIGWINCH、T-004选区三任务无owned重叠，使用一次parallel分派；协调者T-005 SDK审查/升级单写者。
- B2：T-006 Fast依赖T-005；T-007 tiers实证只依赖现有ModelCostTier接口及T-001，不需要SDK升级，可与B1/SDK只读审查并行；T-008 GPT依赖T-007，因为同一generator只允许一个owner。SDK实际安装和模型再生成由协调者串行，安装前暂停/等候使用node_modules的测试。
- B3：T-012依赖T-005/T-008准备有界运行产物；T-009性能两项依赖功能任务T-002至T-008及T-012完成，同一agent串行评估两项，在安静环境测量，不与测试/根check并发。
- B4：T-010最终集成依赖T-001至T-009、T-011及T-012完成。新增T-011显式缓存兼容修订，负责同一openai-responses.ts/compat测试，先T-011后T-005验收再T-006 Fast，禁止同文件并发；必要任务使用新稳定ID，不隐藏在日志。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 独立环境及定向基线

- Status: done
- Owner: coordinator
- Objective: 固定起点，建立不污染原依赖的源码测试环境。
- Inputs and prerequisites: 用户最终确认、F-001至F-006、AGENTS及相关LEARNS。
- Scope or files: 新worktree的ignored依赖/data/dist源码facades、本文；不改产品。
- Expected output: 依赖隔离、基线测试与实际路径证据。
- Dependencies: None.
- Execution steps: 复制既有外部依赖而非共享可写SDK；重映射workspace；离线复制data/facades；运行定向基线。
- Acceptance criteria: 无原工作树依赖写入，无真实API，测试导入新源码。
- Verification method: package links/version核查及V-001/V-002/V-003当前存在的定向子集。
- Validation evidence: task-55私有复制外部依赖、workspace全部指向新worktree、离线data及相对源码facades就绪，OpenAI6.40.0为真实私有目录，产品tracked仍零改动；task-58 TUI49/49、task-59 ai70/70通过。task-57 coding180通过/1已有失败：Fireworks默认kimi-k2p6未出现在复制的离线catalog中，记录为基线待定位，不忽略或声称全绿。无install/build/API，原依赖未变；文档validator通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — BOM输入读取适配

- Status: done
- Owner: /root/optional-bom
- Objective: forward-port1355cd36e并保留easy编辑合同。
- Inputs and prerequisites: 完整上游patch及当前所有目标文件、T-001。
- Scope or files: coding-agent/src的cli/file-processor、config、core/{auth-storage,keybindings,model-config,models-store,package-manager,pi-manifest,resource-loader,settings-manager,trust-manager}、tools/{edit-diff,edit}、migrations、external-editor、theme、utils/{frontmatter,text}；对应BOM回归及已有必要测试。旧分支不存在的模块不得创建架构占位。
- Expected output: 统一剥离一个leading UTF-8 BOM，读取解析成功且edit仍回写原BOM。
- Dependencies: T-001.
- Execution steps: 读取全文件及消费者；先红后最小适配；保留原helper导出消费者或显式迁移所有本地调用；验证配置/frontmatter/编辑/资源入口。
- Acceptance criteria: BOM/非BOM行为均正确，模糊edit、.epi路径、audit/任务恢复不变。
- Verification method: V-001及完整diff审查。
- Validation evidence: clean语义红11失败/13对照，修正前两项fixture错误后才移植产品，后33新回归通过；父代理读完整regression、helper、所有源hunk/消费者及红日志，task-71 12文件187、task-72 edit47/41明确过滤skip、task-73 local package28/94过滤skip通过，共262项。BOM/非BOM、嵌入标记、fuzzy preview、CRLF/原BOM写回、.epi、auth/settings锁中合并与nested-worktree合同保持；rootcheck仅格式化owned测试，未测Windows/真实凭证。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 受限SIGWINCH启动防御

- Status: done
- Owner: /root/optional-sigwinch
- Objective: 适配605a1b038，不让自发信号的EPERM/EACCES使启动崩溃。
- Inputs and prerequisites: 完整patch、当前terminal启动/resize流程、T-001。
- Scope or files: tui/src/terminal.ts；regression-sigwinch-kill-eacces.test.ts及必要terminal测试。
- Expected output: 精确异常保护和无权限/无TTY/正常路径回归。
- Dependencies: T-001.
- Execution steps: 读取全文件；mock进程信号先红后绿；保护signal无重复/吞其他启动异常。
- Acceptance criteria: 受限异常被处理且其他终端功能不回退，真实Linux限制如实注明。
- Verification method: V-002定向信号回归。
- Validation evidence: 子代理先红2失败/3对照，再同5例全绿及扩大33/33；父代理读取语义红测/完整新增12例fixture及源码diff，task-69信号/terminal/选区/安全/ASCII五文件99/99、0skip通过。生产hunk与上游一致，catch仅包围kill调用，raw-mode/keyboard-query错误仍传播；Linux/Windows平台条件是scoped mock，未测真实seccomp。
- Blocker: None.
- Unblock condition: None.

### [x] T-004 — 全屏双击整词选择

- Status: done
- Owner: /root/optional-word-selection
- Objective: 适配1ac6128e6并保护easy内容点击/逻辑文本复制。
- Inputs and prerequisites: 用户明确采用整词、当前完整鼠标状态机、T-001。
- Scope or files: tui/src/tui-alt-screen.ts、tui/test/tui-alt-screen.test.ts；coding-agent Thinking mouse和复制测试只运行。
- Expected output: /、-合并选区，宽字/ANSI/边框/真实点击回归。
- Dependencies: T-001.
- Execution steps: 先红/应用最小hunk；用VirtualTerminal实际SGR按下/释放/多击验证，不仅私有方法断言。
- Acceptance criteria: 路径整词且Thinking点击不误复制、同格motion不拖选、输入复制仍为逻辑文本。
- Verification method: V-002及V-003交互回归。
- Validation evidence: 子代理真实SGR状态机红11失败/3对照，之后TUI66、coding交互23通过；父代理读取完整red、新测试及局部源码diff，task-69组合TUI99、task-70 Thinking/pending-tool/interactive逻辑复制三文件23通过。只改getWordSelection合并，lastClick消费/同格motion/OSC52/逻辑源保持；覆盖joiner、CJK/emoji/ANSI、双向拖选及跨段三击。未测物理终端/实际系统剪贴板。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 最小OpenAI SDK与锁文件升级

- Status: done
- Owner: coordinator
- Objective: 找到支持fast的最小SDK，升级不引入无关依赖漂移。
- Inputs and prerequisites: 用户明确许可、旧6.40.0类型证据、T-001。
- Scope or files: 必要package manifests、package-lock、coding-agent shrinkwrap/install-lock；新worktree私有node_modules，不改undici。
- Expected output: 版本/release/types审查与精确依赖变化。
- Dependencies: T-001, T-011.
- Execution steps: 只读registry/release/type确定版本；固定pin；ignore-scripts安装及刷新锁；按官方repo脚本生成shrinkwrap/install-lock；检查间接漂移与lifecycle。
- Acceptance criteria: 新类型实际支持fast，原依赖环境不变，没有无关升级或脚本执行。
- Verification method: V-004 pinned/type/lock及定向provider/auth回归。
- Validation evidence: npm官方tar/CHANGELOG及7.1缺fast、7.2有fast真实类型已读，最低版本7.2.0实装于私有worktree，原环境仍6.40.0。task-66/74全部ignore-scripts；恢复npm无关清理后root lock仅两个必要entries改变，shrinkwrap/install-lock官方再生成且--check通过，无undici/其他SDK升级。前后完整audit告警集合完全相同：既有10 high/1 critical，不运行audit fix。task-75根check格式化3个owned测试/helper，随后实际出现2个SDK类型冲突：既有OpenAIPromptCacheOptions长期ttl=24h，而7.2、7.20及当前age gate内7.30.1的PromptCacheOptions均只声明30m且mode可选；该冲突后经用户明确修订和T-011处理；task-80完整根check exit0、1412文件No fixes applied（pinned/TS/locks/browser全通过），task-81十四AI文件269通过/4明确API-gated skip，升级已接受。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — Fast服务等级计费

- Status: done
- Owner: /root/optional-openai-cache
- Objective: 移植a6ca86102仅将fast费用倍率与priority一致。
- Inputs and prerequisites: T-005新SDK类型及当前service tier合并合同。
- Scope or files: ai/src/api/openai-responses.ts及openai-responses-compat.test.ts。
- Expected output: Fast响应与请求后备计费回归，其他tier保持。
- Dependencies: T-005.
- Execution steps: 读取全文件；先红后窄改；验证input/output/cache各项及缺失service tier后备。
- Acceptance criteria: 类型无需cast伪造，默认/priority/flex费用及响应usage合并不回退。
- Verification method: V-004 provider兼容测试。
- Validation evidence: root读实际1行源码hunk/18新场景及语义红6失败/58对照，之后compat64、邻域135/4已存在API skip；父代理task-86十四AI文件287通过/4明确API-gated skip，task-85完整根check exit0、1412文件No fixes applied。response tier优先、缺失request后备、5.5/其他倍率、所有cost字段/一次fetch+一次done均保留；native SDK fast字段无casts，原默认/flex/缓存政策不回退。
- Blocker: None.
- Unblock condition: None.

### [x] T-007 — 多catalog阶梯计费保留

- Status: done
- Owner: /root/optional-cost-tiers
- Objective: forward-port943a10e74至easy现有generator，不迁移schema。
- Inputs and prerequisites: 上游完整patch、当前generator/cost字段/data、T-001；现有ModelCostTier接口已证实，不依赖SDK。
- Scope or files: ai/scripts/generate-models.ts及必要窄pricing helpers/离线fixtures/tests；生成models.generated.ts仅协调者通过generator产生。
- Expected output: OpenRouter/Gateway/现有catalog tiers边界正确并保留基础cost。
- Dependencies: T-001.
- Execution steps: 核对已有支持；用离线catalog红测定位丢失；最小归一化适配；不复制上游新模型目录架构。
- Acceptance criteria: tiers条件/边界/单位和fallback正确，cache子集无重复；无网络生成或默认/schema变化。
- Verification method: V-004 model-cost tiers及generator离线tests；再生成差异检查。
- Validation evidence: 子代理实际复制generator+严格mock四个catalog来源的离线emit红38失败/1对照→39通过；父代理读完整helper/test/generator diff和报告并核对SHA，task-77成本/模型数据验证/目录类型三文件54/54通过。保留31 loaders及派生目录、missing/zero/invalid rates、threshold单位/边界、Gateway max恢复、time/day排除和metadata/cache子集。生产raw快照不在仓库，PI_OFFLINE不是fetch guard；没有调用真实catalog或全量刷新现有ignored生产数据，不重构/虚构缺失价格。生成器规则已验证，实际最新公开价格/完整生产再生成仍不在本次证据内。
- Blocker: None.
- Unblock condition: None.

### [x] T-008 — GPT-6.1 Sol目录与能力，保留默认

- Status: done
- Owner: /root/optional-cost-tiers
- Objective: 移植12c416e1a适用模型元数据，不改默认选择。
- Inputs and prerequisites: 用户明确保留默认、T-007同generator释放owner。
- Scope or files: ai/scripts/generate-models.ts及模型能力tests（串行继承T-007 model-cost-tiers.test.ts以复用实际离线emit）；models.generated.ts/provider产物仅协调者经生成器输出更新；model-resolver源码只读。
- Expected output: OpenAI/Azure/Codex模型metadata、reasoning与pricing正确，默认选择合同保持。
- Dependencies: T-007.
- Execution steps: 核对已有覆盖；补离线overrides与能力测试；由协调者再生成并重跑默认模型回归。
- Acceptance criteria: 目录能力/tiers适配，不接受unsupported off/none；不改默认模型或批量更新catalog。
- Verification method: V-004 max-thinking/supports-xhigh/model-cost及V-003 model-resolver。
- Validation evidence: 实际复制generator红13/39对照→52成本/metadata绿，+已有能力两文件共88通过；父代理读取完整delta/三个真实emit记录/proof及合法clamp类型修正，task-81成本/缓存/能力等14文件269通过、4API skip；task-80完整根check通过无修复。83→86 fixture模型，仅3条Sol新增且所有非Sol深等；未从fixture假造其他catalog。Codex/Azure default cap272k与上游12定义确认一致；model-resolver源diff为空。现有原始catalog缺项/最新价格不在此证据内，runtime有界产物由T-012单独完成。
- Blocker: None.
- Unblock condition: None.

### [x] T-009 — 两项性能候选先测后选

- Status: done
- Owner: /root/optional-performance
- Objective: 评估b485fa312、54c19a252，选择有证据的非重复hunk或有理由地不合。
- Inputs and prerequisites: 完整性能patch、Node性能skill/adapter/benchmark约束、所有功能任务完成。
- Scope or files: tui/src/{utils,components/box,components/markdown,components/text}.ts，coding-agent footer/bash renderer/shell/session-manager的适用hunk及必要回归；临时bench文件在/tmp，不生成第二任务状态文档。
- Expected output: 组件/正常渲染负载与micro attribution的重复A/B样本、正确性/CPU/heap对照、逐hunk选择。
- Dependencies: T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-012.
- Execution steps: 列出已重叠实现；固定宽度/文本/streaming/主题负载与环境，独立进程交错A/B；评估两项的因果收益及强/弱引用内存；无充分收益则不改产品，仅记录处置。
- Acceptance criteria: 不以静态推断/单次微测宣布产品加速；有效收益超过噪声且无输出/heap回退，root复验；不测时不合。
- Verification method: V-005代表性组件测量、输出相等及邻域回归。
- Validation evidence: child65 fresh进程≥5配对/variant，源码/原始samples/环境/逐hunk处置可追溯；parent读完整bench/loader/Box/实际diff与report，并追加两组5fresh配对（20进程）复验published source，其中task-89明确交替AB/BA：组件stream墙钟ratio0.413、CPU0.456；模拟TUI stream ratio0.392(CI0.389-0.395)、CPU0.430；retained heap0.873(CI0.867-0.879)，全部byte hashes/observables相等。仅接受b485 Box+ANSI tracker/wrap非重复hunk；width缓存rewrite、强token cache、footer/session/shell等未合；54 WeakRef流式CPU1.206x/heap1.014x而暂缓，flatten虽有内存收益但增量render未达预设门禁且resize1.017x而不合，非声称无内存价值。parent133回归+3完整255inputs/72frames oracle通过；发现新test遗漏Component.invalidate必需接口后补stateless noop，不改public类型或生产代码，task-92完整check exit0、1413 No fixes applied，task-93最后133通过。只有组件/模拟renderer证据，无实际CLI/terminal latency提升宣称。
- Blocker: None.
- Unblock condition: None.

### [x] T-010 — 最终范围门禁与安全交付

- Status: done
- Owner: coordinator
- Objective: 验证本轮组合并交付原my-pi，保留之前修复和默认合同。
- Inputs and prerequisites: T-001至T-009实际验证、owned diff、候选处置与来源SHA。
- Scope or files: Git集成提交、本文；原my-pi条件式ff-only、必要SDK ignore-scripts hydration和仅三条已验证Sol记录/manifest交付；本文独立docs提交。
- Expected output: 来源映射、实际测试/check/bench结果、限制和干净状态。
- Dependencies: T-001, T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-009, T-011, T-012, T-013, T-014.
- Execution steps: 父代理审查实际diff/红绿并复验，串行根check核对自动改写；审计锁文件/生成差异、默认未改、所有原提交ancestor；显式路径提交；严格漂移门禁安全快进；validator及最终状态提交。
- Acceptance criteria: 所有候选有合入/不合的证据，回归/check通过，无无关变化或API/push/release。
- Verification method: V-001至V-006、git diff --check/refs/log、文档validator。
- Validation evidence: task-100源码HEAD a40049515审计/完整根check/typed data全部通过，36 paths、7来源、默认/原18/local3/upstream refs保持。最终selected85文件实际1708通过、1开工前同签名Fireworks catalog校验fail、139明确skip（4API、135过滤），新增/修改测试全绿；performance parent AB/BA测量/133+3 oracle通过。task-102原环境门禁发现HEAD已漂移，立即在ff/npm/data写入前停止；再次git观察原my-pi为90f013f7e8bd7bc6648fc4676ad359706f196144，新增别的会话subagent counters commit，3文件非owned；原SDK仍6.40，worktree仅本文未跟踪，集成branch干净。没有覆盖/回滚该提交；后经用户明确确认新起点并完成T-014，task-107所有source/data/SDK/stage门禁通过，ff-only交付a6ca868a6，offline ignore-scripts安装7.2、仅3Sol+manifest hash投放原目录。恢复NPM无关ghost workspace锁元数据后源码diff精确为0；task-108原目录runtime3Sol/validator/完整rootcheck通过且No fixes applied，SDK7.2确认，task-109原目录五AI文件172通过/4API skip。本文完成validator后单独docs提交，无push/release。
- Blocker: None.
- Unblock condition: None.

### [x] T-011 — 显式缓存30m与SDK原生请求类型

- Status: done
- Owner: /root/optional-openai-cache
- Objective: 按用户明确修订修正内建显式缓存TTL策略，保留旧式24h路径并解除SDK类型冲突。
- Inputs and prerequisites: 用户选择显式缓存30m并确认修订合同；task-75两项真实TS错误、7.2/7.20/7.30.1 SDK类型；私有SDK7.2已安装。
- Scope or files: ai/src/api/openai-responses.ts、openai-responses-compat.test.ts及cache-retention.test.ts的显式缓存预期/邻域；T-006尚未编辑同文件，T-011验收后串行交接。
- Expected output: 原生SDK请求类型，显式none/short/long与旧式long策略回归，原有callback/cache亲缘保持。
- Dependencies: T-001.
- Execution steps: 读取完整source/test；先写long显式30m红测，保留旧式long24h对照；改最小内建策略/原生类型；验证payload回调替换、breakpoints、cache key/affinity与取消；根type/check由协调者运行。
- Acceptance criteria: 显式long30m、旧式long24h，none不误启用缓存；不窄cast掉TTL或Fast类型，不改默认/重试/流协议。
- Verification method: V-004 provider兼容和缓存邻域，根tsgo/check。
- Validation evidence: 语义红4显式long24h/42对照→compat46全绿，必要邻域旧预期对齐后135通过/4API skip；父代理实际源码/红测/旧式24h对照及custom escape检查，task-81十四AI文件269通过/4明确API skip。task-80完整根check exit0，原两项SDK TS冲突消失，无casts/Omit伪造cache/Fast能力。内建模式30m、旧式支持long24h、none无TTL/key/breakpoint/affinity；custom payload证明仅透传，不代表服务端支持。
- Blocker: None.
- Unblock condition: None.

### [x] T-012 — 有界SDK/模型运行产物准备

- Status: done
- Owner: coordinator
- Objective: 使源码交付可在原运行环境使用，避免原SDK6.40类型缺字段及Codex缺Sol，但不批量刷新catalog。
- Inputs and prerequisites: T-005 SDK7.2与T-008确定性Sol生成记录、真实generator proof及原私有/原目录快照。
- Scope or files: 新worktree ignored provider data三个Sol记录/.manifest.json、临时准备脚本/哈希证明；原环境在T-010安全交付阶段才刷新。
- Expected output: 三个记录由实际generator产生，非Sol记录/其他provider字节均不变，完整typed/identity/hash validation通过；SDK版本和有界投放方案。
- Dependencies: T-005, T-008.
- Execution steps: 父代理重跑离线emitter并核对源码SHA/记录SHA；保存原数据/SDK状态；复制全normalized data到新temp stage，仅合入三条record，官方manifest函数/validator验证后原子发布私有数据；复验runtime模型能力。T-010原环境source/data/SDK均无漂移时同样投放，并以ignore-scripts安装固定SDK，保留四项无关锁元数据。
- Acceptance criteria: 不从synthetic其他模型/价格构建真实catalog，不伪造完整raw快照；默认和非Sol数据不变，原共享环境不在实施过程中提前写入。
- Verification method: 跨所有provider的nonSol deep equality/文件hash、model-data validator、runtime getModel/能力及SDK版本核对。
- Validation evidence: root核对3-record bundle SHA/源常量/proof，task-82仅合入3个Sol+manifest、39 providers官方validator通过，every nonSol deep equal、other provider bytes/hash保持；original data仅stage未写，before/after全哈希在T-012-prepared-data.json。task-84 runtime实际getModel三个provider均存在、off合法clamp/levels/272k边界通过，四文件51通过，model-resolver源diff为空。原SDK6.40基线文件sha另存，私有实装7.2；原SDK/data仅在T-010重新验证无漂移后交付。
- Blocker: None.
- Unblock condition: None.

### [x] T-013 — 独立只读功能安全复核

- Status: done
- Owner: /root/optional-functional-review
- Objective: 独立复核已提交功能批次的真实行为与有界产物方案，不把本轮SDK/目录适配变成隐含行为回退。
- Inputs and prerequisites: 4eb4cb91d..1c4726ef3固定diff、当前source/tests、3-record emitter/proof与产物准备脚本、用户缓存30m修订。
- Scope or files: 上述功能源码/测试/证据只读，工具仅read；不审计整个repo、不检查尚在评估的性能candidate。
- Expected output: 具体有证据可行动finding或无finding，真实验证缺口；不能自行接受。
- Dependencies: T-002, T-003, T-004, T-005, T-006, T-007, T-008, T-011, T-012.
- Execution steps: 阅读完整相关函数/调用者与review skill，反例检查cache/cost/model/BOM/产物投放；引用精确路径/因果，不改文件或执行命令。
- Acceptance criteria: parent读实际结果并处置有效findings，缺口与测试结果不混淆。
- Verification method: fresh isolated read-only agent；parent复核finding/源码与必要重现。
- Validation evidence: fresh isolated工具仅read审查固定4eb..1c4726ef3功能diff及完整cost/helpers/generator/caching/BOM/edit/trust/selection源、3-record emitter/proof/产物脚本与官方validator，结果No actionable issues found in the reviewed scope；父代理读取保留结果并核对自己的源码/实际test/hash依据后接受。reviewer未执行命令/测试/独立hash，不审查performance；API/LINUX/Windows/物理终端/全新catalog价格仍未验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-014 — 保留并重验新原分支提交

- Status: done
- Owner: coordinator
- Objective: 按用户明确修订保留90f013f7e，重新集成而不覆盖并发工作。
- Inputs and prerequisites: 用户选择保留新提交重新集成并再次确认；原90f013f7e与集成a40049515、SDK/data基线哈希。
- Scope or files: 在隔离集成分支合并既有90f013f7e三文件，完整保留原提交；不手改non-owned source，冲突需停止。原环境仍等待T-010门禁。
- Expected output: 两条历史均ancestor、new fixed delivery base90f013f7e，新增受影响定向验证/完整check。
- Dependencies: T-009, T-013.
- Execution steps: 只读读取新提交完整diff及目标文件；确认无源码重叠；在集成worktree merge既有提交；跑subagent-turn-group/transcript-category-headers及交互/TUI/协作邻域；rootcheck与范围/SDK/data哈希复验。
- Acceptance criteria: 不回滚/重写新提交、原三个文件与90f tree精确一致；没有隐含新默认/SDK/data变更；再次漂移仍停止。
- Verification method: Git ancestor/blob/tree审计、定向mock/VirtualTerminal、根check、更新文档validator。
- Validation evidence: 读完整90f diff/source及两个测试后task-103无冲突merge，head=a6ca868a6128a29f767b4366285a1d5a95444922，parent=a40049515+90f013f7e。task-105审计原90f三个blob与合并head精确相同、所有原修复ancestor，默认/refs不变、锁仅SDK两必要entries，完整check exit0、1413 No fixes applied；task-104新增受影响7coding文件47通过，task-106五TUI文件92通过。无手工修改新提交source/test，集成tree干净，原环境仍等待T-010按新固定90f门禁交付。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

- V-001：coding-agent BOM regression（新增后才运行）、edit/frontmatter/auth/settings/resource-loader/文件处理相应定向mock测试；其他新增/修改tests全部运行。具体可执行文件由T-001/T-002核对后记录。
- V-002：tui `node --test test/tui-alt-screen.test.ts test/terminal-output-safety.test.ts`；SIGWINCH回归新增后运行，ANSI/宽度/editor/补全邻域按实际变更追加。
- V-003：coding-agent faux/VirtualTerminal定向 Thinking鼠标、逻辑复制、model-resolver、任务恢复/branch/cache回归，绝不全vitest。
- V-004：ai指定provider compat/model cost tiers/generator/max-thinking/supports-xhigh及前轮stream/auth/retry定向tests；`PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run <specific files>`，from package root。
- V-005：独立进程交错A/B、固定数据/宽度、warmup与至少重复样本，记录runtime/OS/CPU/源码hash；墙钟与CPU/heap检查及输出相等。测量时没有并发build/test/formatter负载。
- V-006：协调者 `npm run check` 完整输出（含write），前后diff/status范围核对；官方shrinkwrap/install-lock --check；git diff --check；默认模型源码及旧修复ancestor审计；task_document.py validate。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- SDK支持fast的最小版本尚未确定，不能以cast代替升级；新锁文件要排除无关漂移和生命周期脚本。
- 旧generator与上游不同，需以离线fixture适配而非整体覆盖；已有GPT/tiers覆盖必须确认，不能重复或回退。
- 性能源码部分重叠、heap与组件缓存影响不同，没证据就不合，不把所有上游改动视作必需。
- 当前环境为macOS；真实Linux/seccomp、Windows、物理终端和真实API行为可能无法验证，必须区分模拟与平台实测。
- 根formatter与Git为单写者；原worktree/refs存在多会话漂移可能，最终门禁必须重新检查。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-11: 用户确认全部8项逐项推进，并明确SDK最小升级许可、默认模型保持、整词选区及测量门禁；无底层实施发生在确认前。
- 2026-10-11: 创建本文并立即填入合同；T-001开始，固定起点4eb4cb91d，新集成worktree/分支已创建；开工refs与原工作树干净复验通过。

- 2026-10-11: T-001→done，私有依赖/源码链接核查与定向基线就绪：TUI49、ai70通过，coding180通过/1离线Fireworks默认catalog缺项。T-002/T-003/T-004→in_progress按无重叠owned paths一次parallel派发；T-005协调者开始只读SDK最小版本审查。基线catalog失败仍须定位并在最终门禁前处置，不通过删断言来隐藏。

- 2026-10-11: SDK审查实际6.41.0与6.49.0仍无fast类型；7.32.0包获取被项目48小时npm age gate拒绝，不绕过，继续寻找已稳定版本。原工作树task-61同样复现Fireworks离线catalog基线失败，证实非本轮产品变化。核实现有ModelCostTier接口后消除T-007对SDK的非必要依赖，T-007→in_progress并分派generator唯一owner；实际install/再生成仍协调者串行。

- 2026-10-11: T-003/T-004经父代理实际diff/红测与99+23项复验后→done。T-005确定最小支持版本OpenAI7.2.0：实测7.1.0缺fast、7.2.0有fast，并读完6.40→7.2 release区间；7.0仅公告Node>=22破坏性门槛，与项目>=22.19和当前24.15相容。GitHub匿名页面读取失败，证据来自npm官方tar内CHANGELOG/types，而非未读网页。task-66仅刷新manifest/lock、忽略scripts，实际SDK尚未切换；发现npm顺带清理四项既有pi-codex-accounts锁元数据，最终会保留这些无关基线项。完整audit原分支与新锁均有既有安全告警，未运行audit fix，不纳入本轮无关依赖升级。

- 2026-10-11: T-002经父代理187+47+28项及源码/消费者/红测审查→done。T-007报告39离线实际generator用例通过，但真实raw catalog快照不可用，root尚未验收再生成范围。SDK7.2私有hydration完成，锁仅必要entries变化、官方锁生成通过，原SDK6.40未变；audit前后相同10 high/1 critical告警，属于既有超范围风险。task-75根check在格式化3个owned文件后被真实类型冲突阻止：旧显式缓存long发送24h，新SDK仅声明30m（7.20及当前age gate内7.30.1同样），且mode optional与本地required交叉不兼容。T-005→blocked，记录需用户决策；不降低TTL、不伪造类型，原my-pi尚未快进/提交本轮代码。

- 2026-10-11: 用户明确选择显式缓存30m，并再次确认修订合同；T-005 blocked→in_progress，新增T-011处理该真实兼容冲突，旧式24h和其他合同不变。不改变默认模型、不启用真实API，也不通过断言伪造SDK能力。

- 2026-10-11: T-007经父代理完整helper/test/diff/SHA审查及task-77三文件54项复验→done；仅修改生成规则，原始公开catalog快照不可用，明确不虚构/反推缺失价格或进行真实服务刷新。T-008→in_progress由同一generator owner串行接续模型metadata；当前ignored快照OpenAI/Azure已有Sol但Codex缺失，需源常量确定性emit及有界产物交付，不改变其他model/default。T-011同时只拥有另两个provider文件，无文件重叠。

- 2026-10-11: T-011子代理报告原生SDK请求类型及内建显式long30m已实现，红4/绿46；邻域发现cache-retention.test旧预期24h与已批准新行为矛盾，未越界修改。T-011保持in_progress，扩大owned测试范围到该必要邻域，由同agent串行对齐；不删除/skip断言，仍保留旧式24h对照。

- 2026-10-11 10:10 +0800: T-011三文件46+135邻域报告绿，父代理读实际cache源diff/完整red与旧式24h对照；T-008报告生成3条Sol记录、13红/52绿及非Sol深等对照，父代理读源码delta/3记录/proof，并确认上游Codex/Azure默认cap272k。task-78八文件210通过/4既有env-gated API skip；task-79根check仅剩T-008新测试将off传给不接受off的SimpleStreamOptions类型错误，已要求在合法clamp层测试，禁止cast/扩schema。根formatter只改该owned test。新增T-012：仅生成器确定性三记录与私有SDK有界运行产物准备，最终原环境漂移门禁后才交付，不能只更新源码留下缺模型/旧SDK。

- 2026-10-11 10:15 +0800: T-008测试off误用经合法clamp层修复，parent task-80完整根check exit0、1412文件No fixes applied；task-81十四AI文件269通过/4env-gated API skip（命令清除四个provider key环境以保证不调用API）。父代理接受T-005/T-008/T-011→done；T-006解除依赖并由同API owner串行开始，T-012开始父代理有界模型产物准备。code/ignored-data/依赖交付均尚在私有worktree，原my-pi未漂移；准备完成后的功能组合再开放性能测量。

- 2026-10-11 10:23 +0800: T-006接受→done：parent红测/1行hunk/18场景及task-86十四AI文件287项通过、4API skip；task-85根check exit0、1412文件No fixes applied。T-012接受→done：parent三记录有界合入与39 providers完整validator、全nonSol/其他文件不变证明、task-84 runtime能力/边界与51测试通过；original SDK/data仍未写。准备显式路径提交功能批次，随后在全部测试settled的安静窗口启动T-009性能两项先测后选。

- 2026-10-11 10:24 +0800: 功能批次协调者显式路径提交成功：58e29e174(BOM)、558acacd7(SIGWINCH)、6f09e35bc(选区)、f7d7300ce(SDK/Fast/明确缓存修订，用户许可锁文件flag)、1c4726ef3(tiers+Sol，不改默认)。新worktree干净，6个非性能来源已可追溯；所有原子功能代理已settled/closed。T-009→in_progress，待在无并发test/install/check的安静窗口测量两项性能候选，未预先承诺合入。

- 2026-10-11: 性能测量窗口继续安静，协调者不跑test/install/check。新增T-013 fresh isolated只读功能审查，与性能任务无修改边界交集，工具仅read；固定功能diff已保存，不把任何评估中的性能源码计入已验收结果。

- 2026-10-11: T-013只读独立复核无行动性finding，parent读取实际保留结果后接受→done并关闭reviewer；其静态结论不代替root测试/哈希/交付门禁。T-009仍在收尾测量/对照和候选选择，未提前接受bench摘要或合并性能源码。

- 2026-10-11 10:46 +0800: T-009经parent真实diff/bench/source与额外20fresh进程复验及133+3回归接受→done；只合b485 Box+ANSI/wrap，54与其他未测/不满足门禁的hunk保留不合处置。初Rootcheck查出新Box fixture无invalidate，补纯test no-op后完整task-92 check通过无修复，task-93 133通过，不改生产来迎合测试。所有child已closed。T-010 pending→in_progress，准备性能提交和最终有界宽回归/范围审计/原环境source+SDK+data安全门禁。

- 2026-10-11 10:55 +0800: 性能显式提交a40049515完成（仅b485 Box+ANSI/wrap），源码候选HEAD=a40049515de1e27b0695f92dc56c861e8ad88bf8。task-100最终审计通过：36 reviewed源码/test/lock路径、7完整来源SHA、原18/local3 ancestor、默认源及main/easy-pi refs不变；锁仅OpenAI/ai两entries改，完整check exit0、1413 No fixes applied、数据validator通过。最终宽回归task-95 AI520/4API skip、task-96 coding517、task-97 agent51、task-99 TUI498，共82通过文件1586项；task-101本地edit47/41过滤skip、package28/94过滤skip再绿；task-98 model-resolver47通过/1开工前同签名Fireworks缺项失败，不隐藏/删assert或改默认，nonSol数据字节未变。合计实际1708通过、1已知基线fail、139明确skip，新增/修改测试全部通过，完整API/Core默认行为无新增fail。T-010继续完成原source/data/SDK无漂移门禁和offline ignore-scripts交付。

- 2026-10-11: task-102最终门禁实际发现原HEAD漂移，按既定合同立即停止（尚未执行ff、npm、data原环境写入）。重新只读观察确认90f013f7e新commit `feat(coding-agent): show running and total subagent counts`，改动subagent-group/两测试3个非owned路径；不回滚、不stash、不覆盖。T-010 in_progress→blocked，其他任务done且本轮6个集成commits保留于a40049515；需用户明确新集成基线决定。原SDK/data未交付，不能宣称全部完成。

- 2026-10-11: 用户选择并确认交付合同修订：保留90f013f7e，以其为新固定交付起点，在隔离分支重集成并追加门禁；再漂移仍停止。T-010 blocked→in_progress，新增T-014开始；原实施起点4eb保持历史事实，原SDK/data尚未写入，新提交3文件不可手改或回滚。

- 2026-10-11 11:10 +0800: T-014接受→done：隔离分支无冲突合并90f013f7e形成a6ca868a6；原并发3个blob完全保持，两个parents及全部原修复ancestor。47coding/92TUI受影响回归与完整rootcheck/锁/范围审计均绿、No fixes applied；旧宽回归结果不冒充新UI边界，新增结果单列。新固定原交付起点90f；准备再次漂移门禁及原SDK/data投放。

- 2026-10-11 11:15 +0800: task-107原my-pi=90f、index/worktree/data/SDK/hash全部无漂移后ff-only到a6ca868a6，原并发提交保留；SDK7.2通过offline ignore-scripts实装，3Sol+manifest投放并全文件hash一致。NPM仅另动4个既有ghost锁元数据，精确恢复后原source diff0；offline命令的0vulnerability不代表既有完整在线audit告警已消失。task-108原目录3runtime Sol/官方validator/全check exit0、1413 No fixes applied、7.2版本确认；task-109原目录五AI文件172通过/4API skip。T-010验收→done，全部14任务完成，本文最终validator后单独docs提交并再次核对原/集成clean/refs/祖先；未build/push/release/API。LEARNS.md不在本轮owned交付范围，已发生且纠正的typed-test fixture/SDK冲突/锁元数据过程证据保留于本文，没有扩展写入。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: 本轮限定范围验收通过，T-001至T-014均done、无blocked；7来源适用行为合入6修复commits（b485仅Box/ANSI-wrapping有效子集），54按测量门禁不合。merge commit `a6ca868a6128a29f767b4366285a1d5a95444922`完整保留新并发提交90f及此前18/local3，原my-pi已安全ff到该源码head；默认/refs不变、36本轮source/test/lock路径，SDK7.2和仅3生成Sol数据/manifest已交付原环境并验证。最终新代码/modified tests全绿，原和隔离目录完整npm run check通过、No fixes applied；原目录172项关键API回归及3Sol runtime/官方数据validator再绿。本文单独docs提交。
- Limitations: 不宣称全部测试全绿：宽回归/filtered85文件1708通过、1开工前原/隔离目录同签名Fireworks默认缺项校验失败、139明确skip（4API/135过滤）；该default源和nonSol数据未变，未隐瞒/删断言。重集成后另47coding/92TUI受影响回归通过。未真实API/账单/平台seccomp/Windows/物理终端/全新catalog价格或CLI端到端性能验证；只测组件/模拟TUI renderer，parent明确AB/BA复验stream ratio0.392、heap0.873，不能推为真实终端整体加速。完整在线audit原/候选集合相同10high/1critical，不运行audit fix；offline安装的0告警不是清零证据。所有暂缓hunk及54保留，未build/push/release；LEARNS范围之外未写。

### 实际来源处置及提交

| 来源 | 实际处置 | 集成提交 |
| --- | --- | --- |
| 1355cd36e | BOM输入解析，fuzzy/BOM原字节写回保持 | 58e29e174 |
| 605a1b038 | SIGWINCH最佳努力启动防御，真实平台未测 | 558acacd7 |
| 1ac6128e6 | 全屏路径/kebab-case整词，Thinking/逻辑复制保持 | 6f09e35bc |
| a6ca86102 | Fast与priority倍率；最小SDK7.2；用户明确显式30m/旧式24h | f7d7300ce |
| 943a10e74 | 旧generator保留tiers，严格离线fixture，非完整实时catalog刷新 | 1c4726ef3 |
| 12c416e1a | Sol三provider metadata/能力/阶梯cost，默认模型不变 | 1c4726ef3 |
| b485fa312 | 仅Box+ANSI tracker/wrap，parent测量/字节等价通过；其他hunk已有覆盖/不合 | a40049515 |
| 54c19a252 | WeakRef有流式CPU/heap代价，不合；flatten内存有收益但render未达门禁且resize adverse，不合 | 无源码提交；本文记录实际处置 |
| 90f013f7e | 保留其他会话提交，3个blob精确不变 | a6ca868a6 merge，两条历史保留 |
