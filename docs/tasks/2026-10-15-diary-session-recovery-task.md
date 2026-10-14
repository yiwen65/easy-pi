# Task Plan: 修复 diaryApp 大会话恢复崩溃并保全恢复副本

- Created: 2026-10-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户授权“继续”修复 epi 并制作 diaryApp 恢复副本。

<!-- task-doc-section:background-goal -->
## Background and goal

`/resume` 恢复 diaryApp 后发生 Node OOM，回到 Shell 后出现鼠标协议数字残片。保全原始会话，修复大会话恢复内存问题并验证不调用真实模型的恢复路径。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

范围：epi 会话读取/任务恢复记录、针对性回归、diaryApp 非破坏性恢复副本及终端恢复验证。不得改动原始 JSONL、丢弃用户对话、关闭现有 Session、调用付费 API、修改 AgentPort 或其他项目；不得把过滤数字作为修复。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | diaryApp 会话为 3,062,549,928 字节，共 9272 行。 | ~/.epi/agent/sessions/--Users-w-Projects-diary-app--/2026-09-21T16-50-13-212Z_01a0c4e0-0e5c-7221-aa3f-4efbabeed5ae.jsonl 只读流式统计。 |
| F-002 | 6697 条 pi-task-recovery 占 2,917,576,925 字节，普通消息约 145 MB。 | 只读按 type/customType 统计。 |
| F-003 | 两次 easy-pi 进程崩溃均为 V8 OOM，第二次父 PID 19315 对应 AgentPort diary Shell。 | ~/Library/Logs/DiagnosticReports/node-2026-10-15-005623.ips、005709.ips；ses_01M346Z7A4KVXA2R/host.log。 |
| F-004 | 当前读取器将每行 JSON.parse 后保留全部 entries；journal 每次持久化完整状态。 | packages/coding-agent/src/core/session-manager.ts readSessionFile；core/task-recovery.ts persist。 |
| F-005 | 最初指定 ses_01M4XR8RJAQEA0MZ 是独立 shell-4，只有 305 字节正常提示符，不是当前 diaryApp epi 所在终端。 | Host 只读 hello/replay；epi PID 58446 父链指向 ses_01M346Z7A4KVXA2R。 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- Assumption: 历史恢复状态重复驻留是内存耗尽主要原因；以受限堆重放原始数据的修复前后对照确认。
- Assumption: 数字残片来自异常退出后的鼠标模式残留；通过独立 PTY 验证，不能仅凭外观宣布完整证明。
- Open question: 无需用户决策即可继续；数据安全边界为只生成副本，不替换原始会话。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 原始会话 SHA256、字节数不变；恢复副本保留对话、分支关系、有效任务恢复状态。
- 针对 OOM 的回归在修复前失败、修复后通过，包含分支恢复与持久化语义。
- 真实 diaryApp 在有界内存下可加载，验证不调用模型、不自动重放工具。
- 完成 scoped tests、npm run check、diff 复核及任务专属 Git commit。
- 验证更新后的 epi 交互界面渲染；不关闭无关 GUI 或现有 Session。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 与 T-002 可并行；T-003 依赖 T-001、T-002。
- Parallel batches: 第一批为代码修复及非破坏数据保全，第二批为集成恢复和提交。
- Serialization constraints: coordinator 独占本文档、恢复副本与脚本；子任务独占会话存储代码和回归测试；集成验证与提交由 coordinator 串行执行。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 修复历史任务恢复记录的内存放大

- Status: done
- Owner: recovery-loader
- Objective: 证明并消除历史恢复快照导致的加载内存放大，保留所有分支及写回语义。
- Inputs and prerequisites: F-001 至 F-004、仓库说明和现有 session-manager/task-recovery 测试。
- Scope or files: packages/coding-agent/src/core/session-manager.ts、必要的 task-recovery.ts、针对性测试。
- Expected output: 最小修复、修复前后回归证据、设计限制说明。
- Dependencies: None.
- Execution steps:
  1. 检查读取、分支和持久化接口，设计不删除历史数据的有界方案。
  2. 先运行失败回归，再修改实现并验证邻近行为。
- Acceptance criteria:
  - 对话、历史分支恢复和 durable-storage 语义不退化。
- Verification method:
  - 定向 session-manager/task-recovery 回归和受限堆重放。
- Validation evidence: 子任务建立 180×1 MiB journal/96 MiB 堆的修复前 OOM 失败；修复后 coordinator 独立运行 11 files/183 tests 全过，补充 CRLF/空行/跨 1 MiB 的 UTF-8/无换行尾部回归后该文件 5/5 通过。真实副本在 512 MiB 堆下通过父链、完整上下文及任务状态恢复；875 个 receipt 的多次查询在历史 getter 全部替换为 throw 时仍通过（6 ms）。独立只读复核确认 receipt 查询问题已解决，无进一步 actionable finding。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 保全原始 diaryApp 并准备恢复副本

- Status: done
- Owner: coordinator
- Objective: 对原始数据做可核验的非破坏保全，确定安全的副本恢复入口。
- Inputs and prerequisites: F-001、用户授权。
- Scope or files: 临时诊断脚本和 ~/.epi/agent/recovery-backups/ 下的数据副本；必要的任务专属恢复工具。
- Expected output: 校验和、只读统计、可恢复副本路径。
- Dependencies: None.
- Execution steps:
  1. 记录原始数据校验和、标识和最后有效恢复状态。
  2. 创建独立副本，原始文件不修改；优先让修复后的 loader 原样恢复。
- Acceptance criteria:
  - 原始数据不变，副本可核验，敏感内容不提交仓库。
- Verification method:
  - SHA256 对比、记录数量及父链核验。
- Validation evidence: `/tmp/prepare-diary-recovery.py` 创建 APFS 独立克隆并核验原始与备份 SHA256 为 ccde15b9c3b5f67f2c6144e34594054112eb52031f35806f271884145d23b71c；`/tmp/verify-diary-copy.py` 验证头之后 3,062,549,778 字节完全一致。恢复副本只更换 header UUID 并追加 diaryApp (recovered) 名称；共 9273 行，原始 9272 行不变。备份/副本位于 `~/.epi/agent/recovery-backups/diaryApp-20261015-021127/`；最新任务记录 52d56a25 状态 completed。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 集成验证、交互恢复及提交

- Status: done
- Owner: coordinator
- Objective: 验证真实会话加载、终端界面和代码检查，提交任务专属改动。
- Inputs and prerequisites: T-001、T-002。
- Scope or files: epi 相关修改、定向验证、本文档和提交。
- Expected output: 验证结果、可运行的恢复会话、Git commit。
- Dependencies: T-001, T-002.
- Execution steps:
  1. 审查 diff，独立运行定向测试及 npm run check。
  2. 在独立 PTY 恢复副本，不发送模型请求或接管现有 Session。
  3. 核验原始数据不变，更新本文档并提交。
- Acceptance criteria:
  - 验证失败必须修正或明确阻塞，不能假称已恢复。
- Verification method:
  - scoped tests、受限堆验证、交互截图或 PTY 画面、diff、Git status。
- Validation evidence: coordinator 独立 11 文件/183 测试通过，增加 UTF-8/CRLF 边界后新增回归文件 5/5 通过；`npm run check` exit 0（1531 文件，无格式改写）；`node scripts/build-easy-pi-product.mjs` exit 0，实际 dist 在 512 MiB 堆下完整恢复副本 2.264 秒、堆约 170 MB、875 条 receipt 重复查询 6 ms。实际 `epi --offline --session <恢复副本>` tmux 离线启动显示完整历史与空闲输入框，随后 /quit 干净退出；已在原始指定 AgentPort shell-4 启动同一恢复副本，InputBatch accepted/completed 只发送一次，epi PID 71514 稳定运行约 2 分钟 RSS 296640 KiB。统一 `restart-debug-app.py --skip-build` 仅重启 GUI（95564→62527），Host 73028 保持；ps 核验精确 debug .app 路径，`/tmp/diary-recovery-agentport-final.png` 确认 diaryApp (recovered) 历史、输入框正常非白屏、无鼠标数字残片。最终原始与备份 SHA256 均为 ccde15b9c3b5f67f2c6144e34594054112eb52031f35806f271884145d23b71c。任务专属 diff 审查及 Git 提交作为交付收尾，不包含用户数据或其他项目改动。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

先修复前后定向回归，再执行相关 session-manager/task-recovery 测试、真实 diaryApp 有界内存只读加载、npm run check。npm run check 可自动格式化，运行后只保留本任务文件变更。使用独立 PTY 验证交互恢复，不运行真实模型，不执行会话中工具。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 会话包含图片及私有工具结果，不打印正文、不提交用户数据。
- 不能直接删历史 journal：branch/getBranch/写回依赖其 ID 和数据；须保留行为或使用完整副本。
- 当前有其他运行中的 epi，不能全局查杀；不修改原始数据或启动自动续跑。
- Native V8 OOM 不能由 JS catch 捕获；必须防止触发，而不是只加异常处理。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-10-15: 用户授权继续。建立非破坏恢复与 loader 修复并行边界；T-001、T-002 开始。
- 2026-10-15 02:11: T-002 完成。原始文件未修改；完整副本校验通过，并确认无待自动重放的未完成任务。
- 2026-10-15: 修复前真实数据基线：已安装 dist 的 loadEntriesFromFile 读取备份，在 1.04 秒超过 1200 MiB RSS 安全阈值（峰值观测 1,281,179,648 字节），watchdog 精确终止探针子进程，未影响现有 Session。
- 2026-10-15: 子任务压缩实验表明完整历史 journal 仍压到约 2.12 GB，不能可靠解决内存问题；转为仅对内部恢复记录使用文件支撑的惰性数据读取，保留历史分支与 inode 生命周期。
- 2026-10-15: coordinator 实测首版修复可在 2.206 秒加载原始全部 9272 条记录，GC 后堆约 166 MB；恢复副本在 512 MiB 堆限制下通过 SessionManager.open、父链核验、上下文构建和最新任务状态读取（2.019 秒，堆约 170 MB），不调用模型。
- 2026-10-15: 独立只读 reviewer 指出 resultEntrySources 每次遍历会触发全量惰性 journal 读取；coordinator 核实后要求 T-001 增加轻量 occurrence/receipt 索引及重复查询回归，避免修复引入每次工具结果查询读取数 GB 的阻塞。
- 2026-10-15 02:20: T-001 完成，T-003 开始。coordinator 独立 11 文件/183 tests 通过；补充字节边界回归 5/5 通过。最终代码真实副本加载 1.937 秒、堆 170,692,024 字节，875 项结果归属重复查询 6 ms 且不读历史 payload。
- 2026-10-15: 独立 reviewer 连续复核 receipt 索引及未知效果保护，无剩余具体问题；恢复副本另以新 UUID 安装到默认 sessions 目录便于后续 /resume，原始文件仍不变。
- 2026-10-15 02:21: `npm run check` 无错误、警告或改写；产品 dist 已通过统一产品脚本更新。实际 dist 的受限堆、完整父链/上下文/任务状态与无 payload receipt 查询验证通过。
- 2026-10-15: 真实 epi 离线 tmux 恢复成功并通过 /quit 清理；安全核验 shell-4 仍为未输入的空闲 Shell 后，通过一次已确认的 InputBatch 打开恢复副本。按仓库脚本仅重启调试 GUI，Session Hosts 未中断。
- 2026-10-15: GUI 截图确认 diaryApp (recovered) 可见且非白屏，epi 进程稳定；原始与备份最终 SHA256 不变。T-003 完成验证，收尾提交仅包含两份源码、一份回归、任务文档和合并后的 LEARNS。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001、T-002、T-003 的定向回归、真实原始数据/恢复副本受限堆加载、实际已安装 epi 离线交互恢复、AgentPort 精确进程路径和窗口截图、原始 SHA256、仓库完整 check 均通过。恢复副本为 `~/.epi/agent/sessions/--Users-w-Projects-diary-app--/2026-10-14T18-18-57-000Z_7778ac99-391c-4530-86d8-106e386d401f.jsonl`，现已运行于 shell-4（ses_01M4XR8RJAQEA0MZ）。
- Limitations: 未调用真实模型、未提交新用户提示或自动重放旧工具；未在实体手机上复测触摸操作。旧 OOM 后鼠标模式残留是符合证据的下游解释，本次未人为使真实会话再崩溃。完整历史仍保存在磁盘，未解决 journal 磁盘增长，也未删除任何历史快照。
