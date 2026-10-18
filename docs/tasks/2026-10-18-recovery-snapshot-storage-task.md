# Task Plan: 恢复快照大字段去重与非破坏迁移

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: in_progress
- Source: 用户在恢复快照重复存储分析后授权“执行整改”。

<!-- task-doc-section:background-goal -->
## Background and goal

减少原生任务恢复日志反复保存输入和暂停任务产生的磁盘放大，保留逐快照、分支与崩溃恢复语义。先落实大字段引用编码，再验证安全的历史文件复制迁移；不通过减少持久化、丢弃历史或改变 unknown-effect 处理来减小文件。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`pi-task-recovery` 的 `prompt`、`systemPrompt`、`suspendedTasks` 去重编码；SessionManager 的读取、追加、重写、clone/fork、解析/导出边界；非破坏复制迁移入口；针对性回归、文档与提交。
不做：`/resume` 列表索引/空壳过滤、事件溯源重写、工具结果等第二阶段细粒度去重、全局 CAS/GC、减少 fsync、调用真实模型。不得删除原始用户数据、自动覆盖活跃会话或清理用户备份。真实历史仅在临时目录生成验证副本；原位切换需要单独确认。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 起始代码 HEAD 为 `62c2613ec`，分支 `my-pi`，worktree clean。 | 执行前 git status/rev-parse。 |
| F-002 | 真实 recovered 样本为 17,161,211,295 字节；15,957 条恢复记录占 16,891,821,702 字节。 | 前序只读逐记录统计，文件 size/mtime 前后不变。 |
| F-003 | suspendedTasks 累计 7.909GB/3 种内容；prompt 7.714GB/67 种；systemPrompt 329.56MB/5 种。 | 前序字段哈希统计。仅前三字段引用化估算恢复记录约 1.00GB，未含格式开销、未验证恢复。 |
| F-004 | save 每次写完整状态；现有 lazy payload/receipt 索引只降低内存，不减少磁盘。 | core/task-recovery.ts:828；core/session-manager.ts:630–710、1393–1471。 |
| F-005 | 历史快照用于分支恢复与效果核对；fork 副本 audit-only；必须先持久化再推进内存。 | docs/stream-recovery.md；large-recovery-session、durable-storage、agent-session-task-recovery 测试。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 仅三个大字段去重能达到主要收益，实际以完整编码后的大小及逐记录等价检查验证。
- Decision: 使用同一 JSONL 内已提交恢复记录中的不可变字段作为引用来源，避免 sidecar 生命周期、额外事务和全局 GC。物理格式为恢复 entry 顶层 `recoveryStorage:{version:1,refs:{field:{entryId,sha256}}}`，逻辑 entry.data 透明展开；直接引用较早 inline 来源，不建立引用链。复制/重写重新编码为自包含文件。仅对显著大于引用开销的字段编码。
- Decision: 保留现有逻辑 entry.data 与恢复状态接口，存储编码与恢复状态机分离。
- Open question: 是否替换用户真实历史文件留待验证后单独授权；本任务仅复制验证，不影响代码交付。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 重复大字段只保存一次或有界重复；小状态每次正常持久化；不存在对未来记录、外部文件或可变对象的依赖。
- 首次输入、队列、取消、并行快结果、unknown 效果与嵌套调用语义不变。
- 缺失/损坏/非法引用 fail closed；提交失败不能污染后续引用索引或推进内存。
- branch/repair/clone/fork 后历史仍完整，删除源文件后副本可独立读取；sourceSessionId 和所有 entry ID/parentId 保留。
- receipt 查询不解码全量历史；保持现有有界内存回归。
- 历史复制迁移拒绝覆盖、保留原件；逐快照数据和非恢复记录语义等价。
- 定向测试、`npm run check`、独立审查及最终 diff 通过，仅提交本任务文件。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003 → T-004；T-001 → T-005 → T-004；T-001 → T-006 → T-004。
- Parallel batches: API冻结后将导出接线独立为T-006。T-002复制CLI通过后，T-003真实只读样本验证、T-005冻结core/CLI审查、T-006导出集成并行，文件/数据不重叠。T-004汇合全部结果。
- Serialization constraints: 核心实现者独占 session-manager 及新 codec/核心测试；coordinator 独占任务文档、迁移脚本、集成回归和用户数据验证。不得由子代理提交或运行会改写共享 worktree 的全仓 check。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 实现自包含恢复字段引用编码

- Status: done
- Owner: recovery-storage-impl
- Objective: 在不改变恢复状态机的前提下减少三个大字段重复写入，覆盖追加、加载和重写路径。
- Inputs and prerequisites: F-001 至 F-005、现有完整源码与回归。
- Scope or files: packages/coding-agent/src/core/session-manager.ts；必要的新 recovery codec；专属核心回归测试。
- Expected output: 可审查的编码格式、最小实现、先红后绿的体积与正确性回归；供复制迁移调用的安全入口。
- Dependencies: None.
- Execution steps:
  1. 建立重复字段回归并验证旧实现失败。
  2. 实现同文件引用、校验、lazy 解码与 receipt 投影；重写时重新编码。
  3. 验证失败写入、分支、clone/fork 以及源文件删除边界。
- Acceptance criteria:
  - 满足存储正确性、有界内存及原子提交约束；旧数据读取不自动重写。
- Verification method:
  - 专属测试及 session-manager/durable-storage、large-recovery-session 测试。
- Validation evidence: coordinator 审阅 codec/完整 session-manager diff，并独立运行 `node ../../node_modules/vitest/dist/cli.js --run test/session-manager/recovery-storage.test.ts test/session-manager/durable-storage.test.ts test/suite/regressions/01a0c4e0-large-recovery-session.test.ts`：3 files/50 passed（6.01s）。实现者额外报告相关7 files/95 passed；最终集成仍在T-004验证。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 集成非破坏复制迁移与格式文档

- Status: done
- Owner: coordinator
- Objective: 提供显式 source/output 的安全迁移方式与格式文档；导出接线独立在T-006。
- Inputs and prerequisites: T-001 已审查编码和安全复制入口。
- Scope or files: scripts/compact-session-recovery.mjs及其测试；docs/session-format.md、docs/stream-recovery.md。
- Expected output: 拒绝覆盖的迁移工具、说明与回归。
- Dependencies: T-001.
- Execution steps:
  1. 检查 parse/export/import 等消费者，补齐发现的必要边界。
  2. 实现显式复制迁移，校验来源稳定性及逐记录等价。
  3. 文档说明格式、部署需重启及旧文件切换边界。
- Acceptance criteria:
  - 不覆盖或删除原件；失败不留下可误用的已发布半成品；正常迁移自包含。
- Verification method:
  - 迁移边界测试及脚本 CLI 检查；最终恢复集成由T-004执行。
- Validation evidence: `node --test scripts/compact-session-recovery.test.mjs` 4/4 passed（1.10s）：逐记录语义验证、原件不变、重复迁移、拒绝覆盖/原位/悬空链接/损坏尾部、help；最终发布前复查源及staging身份。两份文档已更新，最终格式检查归T-004。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 真实样本非破坏验证

- Status: done
- Owner: coordinator
- Objective: 在临时目录验证真实样本的体积、逻辑等价与加载，不启动恢复执行。
- Inputs and prerequisites: T-001、T-002。
- Scope or files: 临时诊断脚本/副本；真实源文件只读。
- Expected output: 编码前后字节数、逐记录哈希等价、来源未改动证据；清理本任务临时副本。
- Dependencies: T-002.
- Execution steps:
  1. 检查空间与源文件状态；复制迁移到临时目录。
  2. 验证所有 entry ID、父链、逻辑恢复内容和消息一致。
  3. 验证副本可加载，记录指标后清理临时资料。
- Acceptance criteria:
  - 原始文件不变；真实恢复记录等价；不调用模型、不重放工具。
- Verification method:
  - 固定样本逐记录语义比较及有界内存加载。
- Validation evidence: 真实recovered样本复制CLI在2048MiB堆限制下通过（3m25s），20,936条entry逐项isDeepStrictEqual一致；17,161,211,295B → 1,271,158,632B（减少约92.59%）。另512MiB V8堆限制新进程open/context/journal/receipt查询通过：20,936 entries、4,568 messages、15,957 recovery、603 context messages、completed、1 suspended、1,899 receipts；约1.15s，heapUsed361,300,832B，峰值RSS855,184KiB（不等于512MiB进程内存）。源size/mtime/nlink复查不变；副本nlink=1。临时副本在最终收尾清理，不安装到用户sessions。
- Blocker: None.
- Unblock condition: None.

### [ ] T-004 — 独立审查、全仓检查与提交

- Status: in_progress
- Owner: coordinator
- Objective: 确认数据安全与集成质量后提交任务专属变更。
- Inputs and prerequisites: T-001 至 T-003。
- Scope or files: 本任务所有变更、任务文档。
- Expected output: 独立审查结论、检查证据及 Git commit。
- Dependencies: T-003, T-005, T-006.
- Execution steps:
  1. 集成独立审查结论，复核导出集成边界，修复有证据的问题。
  2. 运行定向套件、完整 npm run check 并检查格式改写范围。
  3. 更新任务状态、验证文档、只暂存任务文件并提交。
- Acceptance criteria:
  - 所有必需测试/check 通过，无未处理的数据完整性问题，worktree 不含本任务遗留。
- Verification method:
  - 定向 Vitest、npm run check、任务文档校验、git diff/status。
- Validation evidence: root定向18 files/297 passed；最终CLI5/5 passed；`npm run check` exit0（1611 files，No fixes applied，含tsc、依赖/导入/锁文件/browser-smoke检查）；git diff --check通过，修改范围仅本任务11个文件。审查发现已修复，LEARNS新增且root回读核验。临时真实副本已清理；待执行任务专属Git提交。
- Blocker: None.
- Unblock condition: None.

### [x] T-005 — 独立复核已冻结存储与复制迁移边界

- Status: done
- Owner: recovery-storage-review
- Objective: 在导出接线期间独立检查核心codec/SessionManager与已通过CLI测试的迁移实现。
- Inputs and prerequisites: T-001通过；coordinator已完成CLI实现及4项CLI测试。
- Scope or files: recovery-storage.ts、session-manager.ts、compact-session-recovery.mjs及其测试；只读，不审查仍在编辑的export。
- Expected output: 有源码证据的完整性/恢复安全问题或无actionable finding结论。
- Dependencies: T-001.
- Execution steps:
  1. fresh isolated上下文审查失败提交、引用校验、分支、自包含复制、inode和清理边界。
  2. coordinator复现与处理发现；交由T-004汇合验收。
- Acceptance criteria:
  - 具体问题均经验证处理，无未决数据完整性问题。
- Verification method:
  - 只读代码/测试证据审查；有发现时追加定向复现。
- Validation evidence: 独立review仅发现CLI发布顺序问题：fsync目录后才unlink staging，断电可能残留多硬链接而被open拒绝。root新增调用顺序回归先红（directory-sync,directory-sync,staging-unlink），改为link→unlink staging→fsync目录后5/5 CLI测试通过。未做物理断电实验。审查未见其他可证完整性/authority问题。
- Blocker: None.
- Unblock condition: None.

### [x] T-006 — JSONL导出保持去重与自包含

- Status: done
- Owner: recovery-export-impl
- Objective: 导出逐项写入新文件字典，不重新展开全部快照驻留；保持分支和输出契约。
- Inputs and prerequisites: T-001已通过，writeSessionFile(Iterable)接口固定。
- Scope or files: core/agent-session.ts仅exportToJsonl/imports；test/suite/regressions/recovery-storage-export.test.ts。
- Expected output: 最小导出接线及faux回归。
- Dependencies: T-001.
- Execution steps:
  1. 大字段导出大小回归先红，再接入generator与writer。
  2. 验证跨分支来源、自包含、原件删除、header重链、覆盖和链接边界。
- Acceptance criteria:
  - 导出大小不随重复字段线性放大，逻辑恢复内容等价且不新增sourceSessionId。
- Verification method:
  - 专属suite/harness+faux回归，root独立复测。
- Validation evidence: 实现者先红：12次小更新使旧export增量2,253,555B，超过225,355.5B阈值；接线后6/6通过。root审阅完整回归/方法diff，并在18 files/297 passed组合中独立复测（16.52s），含跨分支来源、删源后首次open、header/provenance、普通覆盖、symlink保留与dangling/hardlink拒绝。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先观察存储增长回归在旧代码失败，再跑核心测试。集成覆盖原生 task recovery、队列、unknown 效果、durable-storage 和大日志有界内存；复制迁移逐记录比较，不只比较最新 state。真实数据只读且不调用 AgentSession 自动恢复。最后独立审查与 npm run check（不运行 build/npm test/全量 Vitest）。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 预留 message ID 不等于已提交 payload；引用只能指向已持久存在的不可变内容。
- 失败 append 或 repair 后引用索引不得含未提交记录；文件替换后的旧 inode getter 生命周期必须保持。
- 跨分支物理去重不能变成跨分支执行授权；重写/clone/fork 必须自包含。
- 真实文件包含私有内容，只输出结构/大小/哈希，不保存正文到仓库。
- 逻辑文件体积与 APFS 实际分配不同；备份/旧打开 inode 未释放前不声称已回收用户磁盘。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18: 用户授权执行；确认 HEAD/worktree，记录第一阶段与非破坏迁移边界。T-001 开始，生产用户会话保持只读。
- 2026-10-18: 实现者报告先红：16 条快照占 2,697,933B，超过回归阈值 202,730B；待 coordinator 复核最终测试。固定同文件直接字段引用格式，禁止逻辑 entries 携带失效的物理引用标记。
- 2026-10-18: 消费者检查发现 JSONL 导出先展开所有 entries 并 join；T-002 将改用逐记录编码写入，保持导出 header/rechain 行为。迁移 CLI 先生成隐藏 staging，逐记录语义验证再发布最终 output；HTML 导出既有全量序列化不在本轮范围。
- 2026-10-18: T-001 已由 coordinator 审阅并独立复测50项通过；包括96MB heap、非法引用、失败fsync及同尺寸替换。T-002 开始，接口固定为 writeSessionFile(Iterable) 与 rewriteSessionRecoveryFile(source,destination)。
- 2026-10-18: CLI非破坏迁移已实现并通过 `node --test scripts/compact-session-recovery.test.mjs` 4/4；导出实现由 recovery-export-impl 独占，root负责CLI/docs。新增T-005独立只读审查冻结的core/CLI。
- 2026-10-18: 将API固定后独立的导出工作单列T-006，避免让真实样本等待无关导出接线。T-002验收完成；T-003开始生成临时验证副本，原数据只读。
- 2026-10-18: root独立相关14文件/241测试通过；真实副本逐记录验证与512MiB heap加载通过，T-003验收。独立审查指出CLI硬链接发布顺序问题，调用顺序回归先红后绿，CLI5/5通过，T-005验收；已委托专属LEARNS收尾记录。
- 2026-10-18: export实现者报告6/6通过；root已审阅最小方法diff与完整新回归，正在合并运行18文件定向套件。
- 2026-10-18: root组合定向18文件/297测试通过，T-006验收；T-004开始全仓检查与提交收尾。LEARNS由专属代理新增发布顺序lesson，待root复核。
- 2026-10-18: npm run check完整通过（1611文件，无改写）；root复核LEARNS、导出/迁移文档与最终diff，CLI5项最终复测通过。验证用1.27GB临时副本及脚本已清理；原始用户文件未改。下一步仅显式暂存11个本任务文件并提交。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: 实现、独立审查、18文件297项Vitest、5项CLI、完整check及真实副本逐记录验证均通过；T-004仅剩Git提交。
- Limitations: 未运行build/全量测试/真实模型API或物理断电实验；不含用户原始会话原位切换与旧备份清理。512MiB约束仅为V8堆而非进程RSS；体积为逻辑文件字节。新驱动需重启后加载代码，旧会话须显式非破坏迁移才能缩小。
