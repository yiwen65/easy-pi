# Task Plan: /resume 摘要索引与空壳会话筛选

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户授权“继续优化/resume 摘要索引和无 message session 处理”。

<!-- task-doc-section:background-goal -->
## Background and goal

已有恢复快照去重和历史迁移，但/resume仍每次读取所有JSONL且等待全部完成；纯初始化会话也混在历史中。建立可丢弃重建的持久摘要/搜索投影索引，已有写者增量维护，列表尽早显示可用结果；默认隐藏纯初始化空壳，同时保留查看/管理入口和全部正文搜索能力。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：SessionManager列表读取和已提交追加/加载/重写的投影接线、派生索引模块、metadata-only标志、选择器增量加载/空壳显示开关、keybindings、测试及说明。仅缓存写入可新增用户cache；不得改写/删除session正文、减少持久化、改变工具恢复authority、批量清理用户会话。不引入SQLite/新依赖、事件日志重构或全局内容搜索新语义；现有regex/phrase/fuzzy与allMessagesText正文覆盖保持不变。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 起始HEAD54d11c85e，worktree clean。 | git status/rev-parse。 |
| F-002 | buildSessionInfo每次stat后readline/JSON.parse全文件，list只在全部结束返回。 | core/session-manager.ts（当前2306行）。 |
| F-003 | selector loadScope仅在await loader完成后setSessions；缓存仅组件实例内。 | components/session-selector.ts:1013起。 |
| F-004 | 搜索使用id/name/allMessagesText/cwd，支持regex、短语和fuzzy。 | components/session-selector-search.ts全文。 |
| F-005 | 当前diary目录10会话、7个初始化空壳，两个非空大文件约1.27GB和0.674GB。 | 前序逐record统计及本次ls；源数据本任务只读。 |
| F-006 | 提前落盘是可靠性契约，不能以延迟首条回复保存替代列表筛选。 | durable-storage.test.ts及前序恢复分析。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Decision: 使用每文件可重建的摘要/搜索投影缓存（agentDir私有cache），指纹匹配dev/ino/size/mtimeNs/ctimeNs；完整搜索文本保留，不截断搜索能力。
- Decision: 仅已知本进程成功持久化的append做投影增量更新；未知/外部变化、truncate/replace、损坏cache回退原始扫描，不假定同inode变长必然只有append。复用原本完整加载过程建立投影，避免额外全文扫描。
- Decision: 缓存不是恢复authority；写入失败不得影响原始会话提交，可丢弃重建；缓存需原子写、权限受限和并发源指纹复核。读列表时保证已生成投影持久化，写者可合并后台最佳努力flush。
- Decision: SessionInfo增加可选isMetadataOnly；SDK list仍返回全部有效会话。只把header/model/thinking/session_info（无有效名称）及明确初始化custom类型判定为空壳；message/custom_message/compaction/branch-summary/label/recovery/未知扩展状态均保守保留，有名称也保留。
- Decision: selector默认隐藏isMetadataOnly=true，增加可配置app.session.toggleEmptyFilter（默认ctrl+shift+e）显示/隐藏空壳，不删文件。未知标志不隐藏。
- Decision: SessionListProgress追加可选第三参数readonly SessionInfo[]作为本scope可用部分结果；旧两参数回调兼容。必须在current scope按cwd过滤后发布，不能泄漏custom directory其他cwd。
- Open question: 无需用户补充；缓存首次冷建允许一次扫描，首屏通过已有结果渐进展示，不声称冷建零成本。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 暖列表/新进程复用缓存不读取session JSONL正文；已知本进程append后不重新扫描旧前缀。
- 外部变化、同大小覆盖、原位替换、truncate、缓存损坏/只读缓存目录均正确回退，不返回失效摘要或影响会话写入。
- 正文regex/phrase/fuzzy、最近活动时间、命名清除/修改、当前cwd/all及符号链接目录行为不退化。
- 纯初始化空壳默认隐藏，可显式显示与管理；消息数0但有实际/恢复/扩展内容的会话不误隐藏。
- 加载中能显示部分结果，选择稳定，scope/request过期结果不污染当前列表；删改后刷新正确。
- 可测量的实际目录冷/暖加载与首屏证据，用户原始session指纹不变。
- 定向回归、完整npm run check、独立审查、任务校验和提交通过。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001和T-002并行；T-003依赖二者；T-004依赖T-003。
- Parallel batches: 第1批core索引与UI筛选分别独占文件，共享只读契约已固定。第2批coordinator集成复测和真实目录验证，fresh isolated reviewer只读复核；第3批收尾。
- Serialization constraints: core代理独占session-manager.ts/新index模块/索引回归；UI代理独占selector.ts/keybindings.ts/新UI回归；coordinator独占任务文档/产品docs和任何真实数据cache验证。其他测试只读，必要更改由coordinator串行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现派生摘要索引与增量维护

- Status: done
- Owner: resume-index-impl
- Objective: 暖列表不读正文，已提交写者增量维护，未知变化安全重建；输出metadata-only与部分结果。
- Inputs and prerequisites: F-001至F-006及固定SessionInfo/Progress契约。
- Scope or files: core/session-manager.ts、新core/session-summary-index.ts、test/session-manager/session-summary-index.test.ts。
- Expected output: 最小可重建索引、接线及先红后绿回归。
- Dependencies: None.
- Execution steps:
  1. 完整读取源/相关测试，建立暖读取/追加不扫旧前缀回归先红。
  2. 实现指纹、投影、持久cache、已知append增量及失败回退。
  3. 输出保守isMetadataOnly和按scope过滤部分结果，验证格式/并发/损坏边界。
- Acceptance criteria:
  - 索引正确性与读取字节回归通过，恢复状态机与session正文无改动。
- Verification method:
  - 新索引定向测试及modified-timestamp/file-operations/recovery-storage相关测试。
- Validation evidence: 旧实现2条新回归失败：warm仍读正文1次、append/name clear后读2次。root审阅新module全文与session-manager完整diff，独立运行4文件98项通过（7.24s），含新索引44项；覆盖fresh进程0源读取、精确指纹、LRU/oversize、缓存/投影失败隔离和保守分类。新增read/write投影不得因malformed message失败的4回归由root审查提出后通过。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 空壳筛选与渐进加载交互

- Status: done
- Owner: resume-selector-impl
- Objective: 默认隐藏纯初始化会话并提供可配置显示开关，加载中可显示已有结果并维持选择。
- Inputs and prerequisites: 固定可选isMetadataOnly和progress第三参数契约。
- Scope or files: components/session-selector.ts、core/keybindings.ts、新test/session-selector-loading.test.ts。
- Expected output: 选择器最小改动与先红后绿交互回归。
- Dependencies: None.
- Execution steps:
  1. 验证旧组件隐藏/部分结果行为失败。
  2. 实现开关、提示、保留named/未知内容、请求过期保护和选中项稳定。
  3. 验证搜索/scope/rename/delete邻域。
- Acceptance criteria:
  - 不以messageCount===0直接过滤，当前/未知有内容会话可访问，过期loader不污染。
- Verification method:
  - 新组件测试及现有selector/keybindings定向测试。
- Validation evidence: 实现者新增回归在旧组件17项失败，接线后绿；root审阅selector/keybindings完整diff并独立运行5文件47项全部通过（474ms）。覆盖分类/快捷键/partial/过期请求/选择/关闭timer/窄屏；默认未交互跟随首项，输入后按path锚定。成功删除调用forgetSessionSummary。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成验证、真实目录计量与独立审查

- Status: done
- Owner: coordinator
- Objective: 合并契约并量化冷/暖加载；独立审查数据完整性、缓存失效、UI边界。
- Inputs and prerequisites: T-001、T-002完成并审阅。
- Scope or files: 本任务改动、临时测试脚本、真实目录只读/派生cache写入；必要的既有file-operations和modified-timestamp测试隔离修正。
- Expected output: 真实指标、全部回归及审查结论。
- Dependencies: T-001, T-002.
- Execution steps:
  1. root审阅diff并独立复测组合套件。
  2. 原始session指纹固定，测冷/暖新进程列表与搜索一致性。
  3. fresh只读审查并解决可证问题。
- Acceptance criteria:
  - 指标有原始样本，不隐藏搜索/恢复/缓存损坏问题，原会话不变。
- Verification method:
  - 定向Vitest、真实Node读取计数/计时、diff与独立review。
- Validation evidence: root组合28files/426tests通过后补fresh-writer跨进程维护回归，最终28files/427tests全通过（18.49s）。diary10行全文搜索/摘要SHA与旧版一致，fresh进程2.12ms、冷建首可见6.29ms，7空壳默认隐藏；实际离线tmux开关验证通过。独立review的alias私有缓存残留已通过fresh-process先红后绿回归修复并获复核。真实listAll预热1747份可发现会话，cache共2,845,122B；fresh进程120.11ms/首可见55.65ms/JSONL stream0，全部源指纹未变。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 文档、完整检查与提交

- Status: in_progress
- Owner: coordinator
- Objective: 说明索引重建/空壳规则与快捷键，完成门禁和任务专属提交。
- Inputs and prerequisites: T-003完成。
- Scope or files: docs/session-format.md、docs/keybindings.md、README相关段、任务文档及任务源码。
- Expected output: 文档、check证据、Git commit与明确限制。
- Dependencies: T-003.
- Execution steps:
  1. 更新用户可见行为及cache不是authority的说明。
  2. 完整npm run check，复核共享worktree改写范围。
  3. 校验任务文档、显式暂存任务文件提交。
- Acceptance criteria:
  - 所有必需验证通过，未完成/冷建成本如实说明，worktree无任务遗留。
- Verification method:
  - npm run check、任务validator、git diff/status。
- Validation evidence: 最终npm run check exit0（1614文件，No fixes applied，含tsc与依赖/导入/锁文件/browser-smoke检查）；git diff --check通过。README/session-format/keybindings说明已核对，LEARNS新增并回读旧测试持久cache隔离教训。只包含本任务13个文件；待任务专属Git提交。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

回归用文件读取spy证明暖列表/增量追加不扫描旧JSONL，而非仅靠耗时阈值；fresh进程证明持久索引有效。覆盖外部同大小编辑、替换、truncate、坏cache、source变化期间扫描、private目录/缓存失败、无消息实质内容分类、cwd过滤/符号链接和修改时间。UI测试使用ANSI主题和配置keybindings，验证部分结果/过期请求/选择稳定及显示开关。最后真实diary目录冷/暖固定数据测量，完整check，不build或真实模型。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 不把指纹不一致的缓存当作truth，不根据猜测offset跳过未知旧前缀。
- 后台cache写不能把旧数据覆盖成新指纹；先提交源后发布派生投影。
- 全文搜索不得以只搜摘要替换；不随cache增长再制造无界RAM/磁盘开销。
- 冷建时部分列表可能重排，不能使用户选中的session悄悄变为另一条。
- 纯消息数0不等于无内容；未知扩展/恢复journal保守可见。
- 真实目录只读；验证可使用隔离agentDir缓存，禁止清理无关用户cache/活跃会话。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18: 用户授权优化/resume；确认HEAD54d11c85e/worktree clean，固定索引、保守空壳标志、渐进progress契约与两代理文件边界。T-001/T-002开始。
- 2026-10-18: root在旧源码真实diary目录完成3次基线，原始文件未改；core warm/append读源回归先红（1次与2次读正文），索引实现进行中。
- 2026-10-18: T-002交付，root审阅并独立复测5文件47项通过。补充删除时清理私有搜索cache、默认选择策略和UI-only预览区分。文档初稿说明完整正文搜索与私有cache，不改会话正文。
- 2026-10-18: T-001经root独立4文件98项复测验收；root指出并修正缓存投影异常不能破坏核心reader/writer的边界，新增4项malformed-message回归。T-003开始真实冷/暖/fresh进程计量与fresh独立审查。
- 2026-10-18: diary真实数据对照：旧2.235–2.348s；新首次冷建2.912s、首个非空壳partial6.29ms；同进程0.21–0.37ms，fresh进程2.12ms。10rows全部摘要/完整搜索文本SHA一致，7 metadata-only/3visible；原文件指纹不变，10个派生cache共221315B。
- 2026-10-18: 独立review发现别名删除仅清单path缓存；追加显式/隐式dev/ino+fresh进程alias回归先红后绿，按同inode清当前agentDir所有别名，UI传删前identity。review复核原finding关闭。
- 2026-10-18: root发现2个既有测试未隔离ENV_AGENT_DIR，新增持久cache导致18个tmp-fixture投影写入用户cache。已精确清除这18份派生cache（不删源），修正2文件临时agentDir/源目录/flush清理；2文件26项及最终28文件426项全过，用户cache目录计数0证明未继续污染。
- 2026-10-18: 受控离线tmux启动实际TUI，用4个固定fixture验证3行默认可见（named空、custom state、user消息），CtrlShiftE后5行含当前新会话及fixture空壳；/quit干净退出，无模型/API请求。
- 2026-10-18: 真实listAll可发现1747份主会话预热完成：首次3.661s/首可见58.44ms，fresh进程120.11ms/首可见55.65ms、JSONL stream0；93初始化空壳/1654可见，1747个cache共2.85MB，原始session指纹全部不变。T-003验收，T-004开始完整check、文档与提交收尾。
- 2026-10-18: root最终复核补充fresh writer不打开picker就追加的跨进程回归：旧实现fresh reader仍尝试读JSONL1次，修正为source全读重建投影时保留既有磁盘索引兴趣，之后fresh reader零正文读取；从未列出的writer仍只维护memory。新回归先红后绿，最终28文件427项通过。
- 2026-10-18: 最终完整check通过（1614文件，无改写），临时benchmark/fixture已清理，受控tmux已退出。保留用户真实派生索引2.85MB以供重启后直接使用；原始会话未改。下一步仅任务专属13文件提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001至T-003全部通过；实现、独立审查与复核、427项回归、真实目录与实际TUI验证、完整check通过。T-004仅剩Git提交。
- Limitations: 首次无缓存/未知外部变更/超大投影仍需扫描；扫描期间变化的源本次跳过，下次重建。cache删除是当前agentDir内best-effort，手工删除源不是全局cache擦除。未运行build/全量Vitest/真实模型请求；性能计时限当前机器和数据，冷建不声称零成本。重启epi加载本轮代码，真实会话正文未改。
