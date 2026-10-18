# Task Plan: 历史会话批量迁移与旧文件清理

- Created: 2026-10-18
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户明确授权“执行所有历史session的迁移，迁移完成后清除旧的大文件”。

<!-- task-doc-section:background-goal -->
## Background and goal

将当前easy-pi历史会话切换到已验证的恢复大字段引用编码，逐记录验证后原路径原身份原子替换，移除旧的大文件，回收重复恢复数据。前序实现/测试已提交d7ba90bbd及5a8affba5；本任务是用户数据运维，不扩展存储格式。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：`~/.epi/agent/sessions`和`~/.epi/agent/teams`中的合法会话JSONL；没有pi-task-recovery的文件无需重新编码。原路径、header、entry IDs、parent links、provenance和逻辑data不变；校验成功后原子替换即清除旧inode的此路径链接。
保护：跳过活跃进程持有的会话、活跃/未知team owner、已有锁/claim、符号链接/非普通文件、损坏或变化来源。当前team整体保护。独立`~/.pi`、`recovery-backups`、非session支持日志、SQLite/工具产物/导出文件不在清理范围。不结束其他会话、不调用模型、不重放工具、不递归删用户目录。多硬链接若涉及范围外副本，不能声称范围外空间已释放。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 执行前HEAD d7ba90bbd，worktree clean。 | git status/rev-parse。 |
| F-002 | 初始盘点2816个JSONL，合计26,636,332,077逻辑字节；2334位于sessions，482位于teams。 | /tmp/epi-history-migration.3pU9PZ/inventory.json，lsof无警告。 |
| F-003 | 有合法session header的文件2234个；582个非session支持日志不改。 | 只读前1MiB header分类。 |
| F-004 | 当前team有7个session受PID193的live controller保护，其中1个有open FD；无task/append锁。 | 只读lsof及registry.sqlite owner查询。 |
| F-005 | 最大两份diary历史17.16GB、3.06GB无open FD；1份其他历史nlink=2。 | 初始stat/lsof。 |
| F-006 | compact-session-recovery逐entry语义验证后exclusive发布；前序17.16GB样本已验证可缩至1.27GB。 | 已提交脚本与前序任务验证。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Decision: “所有历史”解释为当前easy-pi数据根的非活跃会话，含历史native child，不触碰独立产品/备份。
- Decision: 仅更小且逐记录等价的输出才替换；无恢复记录或无收益的文件保持原样，不制造格式变更。
- Decision: 原子rename替换前检查来源identity/size/mtime/ctime稳定、无open FD；持有task claim、append lock以及关联inactive team的SQLite事务，避免合作写者/owner并发进入。
- Decision: 替换前写耐久审计manifest（身份、sha256、大小、阶段），替换后同步目录并校验最终sha256/nlink，源旧版本不另留大型备份。
- Open question: 如发现活跃/损坏历史会话无法安全完成，明确报告跳过/阻塞项，不以全局kill或删除绕过。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 所有盘点内合法非活跃session均分类为成功迁移、无需变更或有明确保护/错误原因。
- 每份替换文件的所有逻辑entry、header/IDs/父链与旧文件一致；最终原路径sha256等于已验证副本。
- 不改活跃会话、team元数据、支持日志及范围外目录；不遗留本任务claim/lock/staging/旧大文件。
- 记录迁移数量、逻辑/分配字节差异和实际可用空间变化，区别磁盘估算与APFS实际空间。
- 小型故障/并发保护演练通过，真实操作可从manifest辨认完成状态。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003。
- Parallel batches: 串行单写者，逐文件迁移；不并发操作共享用户数据或team registry。
- Serialization constraints: coordinator独占用户数据与任务文档；所有辅助脚本位于临时目录，审计manifest保存在easy-pi migrations目录；不向子代理授权生产数据写入。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 完成盘点和迁移保护演练

- Status: done
- Owner: coordinator
- Objective: 分类真实session/支持日志与live owner，准备安全逐文件替换脚本并测试。
- Inputs and prerequisites: F-001至F-006、现有compact CLI。
- Scope or files: 临时inventory/批量脚本、隔离临时测试fixtures；用户数据只读。
- Expected output: 候选清单、保护清单与演练证据。
- Dependencies: None.
- Execution steps:
  1. 盘点header、大小、open FD、team owner及是否含恢复记录。
  2. 实现逐文件锁定、验证复制、审计和原子替换流程。
  3. 在隔离fixture验证成功、无收益、活跃/锁定/损坏/来源变化/同身份维护。
- Acceptance criteria:
  - 禁止写入条件能可靠跳过；成功输出可独立加载，原路径不缺失。
- Verification method:
  - 本地隔离演练、检查脚本及清单。
- Validation evidence: 只读扫描确认484份恢复候选合计25,915,072,760B，1743份无恢复记录、582份支持日志、7份live team保护。10项隔离测试通过（3.15s）：成功/身份与纳秒mtime保持、持锁、live FD/team、已有锁、source/staging变化、损坏保留、无收益、审计目录同步。独立只读review发现审计目录未fsync，已补inventory/manifest/逐级父目录同步并新增测试；未做物理断电实验。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 串行迁移并清除旧版本

- Status: done
- Owner: coordinator
- Objective: 对候选历史会话逐项验证并原路径原子替换，移除旧副本。
- Inputs and prerequisites: T-001完成。
- Scope or files: 候选session文件、临时同目录staging/locks、专属manifest。
- Expected output: 完整操作结果、保护/错误清单和字节统计。
- Dependencies: T-001.
- Execution steps:
  1. 写开始manifest，逐文件刷新保护与来源检查。
  2. 生成语义等价副本，较小时替换并同步目录、校验最终hash。
  3. 清理仅本任务拥有的临时输出与claim/append锁；有异常保留可判明证据。
- Acceptance criteria:
  - 只删除已由等价完整副本替代的旧表示；未验证来源保持不动。
- Verification method:
  - CLI逐记录比较、atomic rename、最终sha256和来源稳定性检查。
- Validation evidence: 单写者批量任务exit0（552.54s）：309 migrated_old_removed、175 verified_no_savings、1743 no_recovery_untouched、582 support_log_untouched、7 protected；无error状态。每份替换先完整逐record语义比较与source/output SHA256，再原子rename、fsync目录、最终hash/mtime/nlink验证；逻辑节省21,057,945,688B。耐久清单位于~/.epi/agent/migrations/recovery-fields-20261018-3pU9PZ。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 最终盘点、审计与交付

- Status: done
- Owner: coordinator
- Objective: 核验迁移覆盖范围、数据安全与空间回收，提交运维记录。
- Inputs and prerequisites: T-002结束。
- Scope or files: 最终只读盘点、manifest、本文档。
- Expected output: 汇总、残余活跃/损坏项、无临时遗留证据和文档提交。
- Dependencies: T-002.
- Execution steps:
  1. 最终数量/大小/open FD与支持日志身份核对，确认范围外目录未动。
  2. 核对每份成功文件与manifest的hash/entry数，清除本任务临时资料。
  3. 验证任务文档、提交专属记录并说明剩余限制。
- Acceptance criteria:
  - 汇总数字有实测依据，未完成项明确，不把逻辑节省冒充物理释放。
- Verification method:
  - manifest汇总、最终stat/df/残留扫描、task validator、git status。
- Validation evidence: 独立最终SHA256复查309份迁移文件全部匹配，身份/nlink=1/纳秒mtime一致；1743无恢复、175无收益、582支持日志的原inode/大小/mtime/ctime全部未变。初始2816个JSONL均有终态；最终多1份新审查子会话，属于当前live team保护，总保护8份。无临时锁/claim/staging遗留。独立Node进程加载309份会话/159120条entries通过（7.96s）；最大会话仍有20936 entries、603 context messages、completed、1 suspended、1899 receipts。逻辑26,636,332,077B→5,578,386,389B；stat分配字节减少21,042,122,752B；运行期文件系统可用空间增加14,910,521,344B（不将差异归因为全部迁移收益）。final-verification/independent-load/summary已同步保存到专属审计目录；仅本文档作为Git交付变更。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先隔离fixtures验证批量脚本，不直接试错真实用户数据。生产使用已提交compact CLI作逐record等价比较，保留header身份不调用fork；每文件替换前后检查sha256、inode和锁归属。独立进程加载最终最大样本，不启动自动恢复。最终manifest覆盖所有盘点文件，报告live保护/损坏跳过项。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 进程当前空闲不意味着历史安全；open FD/live team owner/已有task claim任一存在即保护。
- 不合作写者仍需来源稳定性和最终检查；无法证明安全时跳过。
- 非session日志、外部硬链接副本与恢复备份不属于原件替换清理，不可误删。
- 源数据正文/工具内容不输出到仓库，manifest仅身份/hash/大小/状态。
- APFS快照/克隆或未关闭的inode可能使物理释放小于逻辑字节差异。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-18: 用户授权全历史迁移及校验后删除旧大文件；创建单写者运维任务。初始只读盘点完成，2234个session、582个支持日志、7个live team保护。
- 2026-10-18: T-001完成：484份恢复候选、10项隔离测试通过；独立只读审查指出审计目录持久化缺口，已修复。T-002开始，仅处理冻结候选清单；新产生的当前team历史在最终盘点中归为活跃保护。
- 2026-10-18: T-002结束exit0，309份成功迁移并移除旧表示、175份等价但无缩小收益、7份活跃保护，无错误。T-003开始最终SHA256/覆盖/独立加载和空间核对。
- 2026-10-18: T-003最终核验通过：309份全部hash一致且独立加载；其余未变分类为1743份无恢复、175份无收益、582份支持日志。无临时遗留；最终新增1份本轮审查子历史，同属当前live team，未迁移。最大diary文件17,161,211,295B→1,271,158,632B；另一个3,062,549,928B→674,096,751B。
- 2026-10-18: 耐久审计目录保留inventory/manifest/operation/验证脚本与summary，不含session正文；临时工作目录在交付前清理。当前运行驱动需重启后再恢复新编码历史；不结束当前会话。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001至T-003完成；10项隔离测试、独立脚本安全审查及修正、484份候选校验、309份替换/旧版本移除、全部迁移文件hash复查与独立加载均通过。所有初始文件有终态且无错误/临时残留，精确统计见~/.epi/agent/migrations/recovery-fields-20261018-3pU9PZ/summary.json。
- Limitations: 当前live team初始7份及新增1份受保护，不改活跃文件；~/.pi、恢复备份和非session日志不清理。范围外硬链接/备份/APFS快照仍可能占空间；不把逻辑体积差当作物理释放。未运行物理断电实验/真实模型；用户需重启旧epi驱动后再恢复新编码历史。
