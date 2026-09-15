# Task Plan: 定位并修复 web-fetch 导航连接故障

- Created: 2026-09-15
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: blocked
- Source: 用户“继续定位历史导航故障并修复”。

<!-- task-doc-section:background-goal -->
## Background and goal

历史三个飞书公开页面经匿名 Chrome 导航失败，仅保留通用错误；上一轮已补充安全的 Chromium 错误码，但原始输入连续成功，尚未证明历史根因。本轮通过受控好坏对照定位可重现的导航故障，仅修复有因果证据的问题。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 修改范围：`packages/pi-web-search/src/network.ts` 及直接相关浏览器代码、测试、包 README；本任务文档。
- 允许匿名读取用户指定公开网页，临时脚本写入 `/tmp`；不使用 Tavily、模型 API 或凭据。
- 保持匿名隔离、浏览器 sandbox/TLS、全 DNS 答案公网校验、每次读取固定 DNS 快照、连接/域名/时间限制和取消清理。
- 不修改并行 compaction 等工作、不修改依赖/锁、不重建工作区 dist、不重启用户进程，不恢复旧外置包。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 历史三个同域名 URL 的 browser 调用均返回通用导航错误，没有记录 Chromium 原因或 IP | 上轮有界 session 取证；`/tmp/pi-fetch-navigation-fix.OzmvsQ/REPORT.md` |
| F-002 | 原始页面在诊断补丁前后均成功，成功不能归因于该补丁 | 上轮 10 次真实读取，REPORT.md 中列出日志 |
| F-003 | 修复前代理校验所有 DNS 答案，但只使用首个 IPv4（无 IPv4 时首个地址），连接失败不尝试其他已批准地址 | 基线 `before/src/network.ts` 的 resolvePublicHost、HTTP 和 CONNECT 路径 |
| F-004 | 代理 socket idle timeout 15s，浏览器总 deadline 30s | `network.ts`、`browser.ts` |
| F-005 | 前一轮 65/65 离线测试通过；全仓检查有 6 个任务外 lint 警告 | 上轮日志和 REPORT.md；本轮须重新验证 |
| F-006 | 工作树有迁移和其他 session 修改，当前包基线已备份 | `/tmp/pi-fetch-navigation.v1pNVl/before/`、`preexisting.diff`；本轮 git status |
| F-007 | 首 IP 失败、其余健康时，原代码不尝试替代地址并导致导航失败；修复后同一故障条件下成功 | `before-live.log`、`after-live.log`、`regressions-red.log`，均在上述临时目录 |
| F-008 | 修复后原三个 URL 同一进程并发成功，直接 HTTP 代理及 browser live 也通过；80/80 离线用例、类型及定向 lint 通过 | `concurrent-live.log`、`http-live.log`、`regressions-green.log` |
| F-009 | 全仓 check 受其他模块 6 warnings、5 infos 阻塞；其自动格式化的 1 个非本任务文件已精确还原 | `full-check.log`、`check-backup/`；开工前 tracked diff 与还原后 byte-for-byte 相同 |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- H-001（T-001 已证实的可重现缺陷）：首个 CDN IP 连接失败而其余正常时，只保留首地址导致本可成功的页面导航失败；不等于历史事件已确定归因。
- Hypothesis H-002：并行浏览器、DNS、超时或站点临时波动可能解释历史事件；没有旧错误/IP，不能仅凭 H-001 重现认定历史唯一根因。
- Open question：历史事件实际 TCP 地址及 Chromium 错误不可从现有通用结果恢复；若不能重现，不作确定性归因。
- 无阻碍当前有界诊断的用户决策。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 先取得可重复坏基线与控制变量对照，记录第一处分歧和因果链；不能取得则停止在有界诊断。
- 修复前回归必须因预期缺陷失败，修复后通过；不重放已发送 HTTP 操作，不扩大网络权限。
- 所有实际 TCP 尝试限于已完整校验的 DNS 快照；私网混合记录、取消、资源清理、HTTP 和 CONNECT 路径保有覆盖。
- 包离线测试、类型及定向 lint 通过，原三个飞书 URL 及受控故障真实路径通过；全仓检查失败与本任务隔离记录。
- 最终报告区分已证明缺陷与历史归因的不确定性，说明运行实例需要重启生效。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 -> T-002 -> T-003。
- Parallel batches: 无；诊断确定修复设计，修复与验证共享包文件和本机网络状态，按依赖串行执行。
- Serialization constraints: coordinator 独占本任务文档和 web-search 包编辑；不操作其他 session 文件。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — 受控复现并定位首处分歧

- Status: done
- Owner: coordinator
- Objective: 用确定性故障与健康对照检验 DNS/连接假设，区分历史事实与新复现。
- Inputs and prerequisites: 用户授权、包和历史证据、基线备份。
- Scope or files: 只读 production；`/tmp` 诊断脚本和日志；包回归测试。
- Expected output: 好坏基线、实际导航错误、第一处分歧及最小失败回归。
- Dependencies: None.
- Execution steps:
  1. 验证 Node 多地址连接行为并受控注入首地址拒绝/停滞，比较去掉故障的控制组。
  2. 使用真实匿名浏览器验证同一页面和失败条件，观察导航错误及清理。
  3. 在生产行为变更前运行最低稳定边界的失败回归。
- Acceptance criteria:
  - 有客观可重复的错误及因果对照；或明确证明当前环境无法继续。
- Verification method:
  - 临时脚本、真实浏览器与 `node packages/pi-web-search/test/run.mjs` 的失败回归输出。
- Validation evidence: `probe.mjs` 的 8 个真实 IP 均在 62–66ms 连通；native Node 对照验证拒绝/停滞后转下个 IPv4，HTTP createConnection 生效。原代码真实浏览器健康组成功（17,608ms/678字）；注入首地址拒绝/停滞分别在 1,661/16,353ms 返回 net::ERR_EMPTY_RESPONSE，只尝试首地址，清理及零凭据通过。日志 `pi-bash-task-4-46584433.log`。新增 connection.test.mjs 在原代码上 7 个预期失败，健康/取消/旧 65 测试全通过（70/77），日志 `pi-bash-task-5-0d8c8627.log`；日志均在系统 TMPDIR。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 实施证据支持的最小连接修复

- Status: done
- Owner: coordinator
- Objective: 修正 T-001 证实的缺陷，不通过重试请求或放宽安全策略掩盖问题。
- Inputs and prerequisites: T-001 的坏基线、因果证据和失败回归。
- Scope or files: `packages/pi-web-search/src/network.ts`、相关测试与 README；必要时浏览器代码。
- Expected output: 最小补丁及安全/取消/双协议边界回归。
- Dependencies: T-001.
- Execution steps:
  1. 依据实验证据选最小方案，核对本地 Node API/types；无新依赖。
  2. 实现仅在应用请求发送前的有界连接选择，维护 DNS 快照和清理。
  3. 运行失败回归及所有包离线测试并审查差异。
- Acceptance criteria:
  - 原回归由红转绿，全部实际连接尝试限于已批准快照，取消后无新连接或泄漏。
- Verification method:
  - 包测试、定向类型检查、diff 审查。
- Validation evidence: `node packages/pi-web-search/test/run.mjs` 80/80 通过，原 7 个红回归全绿；`node_modules/.bin/tsgo --noEmit` 和定向 Biome（network.ts；mjs 被仓库配置忽略）通过，日志 `pi-bash-task-7-0614ec34.log`。生产 diff 仅完整快照及 HTTP/CONNECT 共用原生多地址连接器；15s/30s、DNS 全答案校验和取消机制不变。补充 mixed-private/no-replay 回归。测试 all-refused 的 close 需等真实 close 事件而非一个 setImmediate；已更正测试同步点。
- Blocker: None.
- Unblock condition: None.

### [ ] T-003 — 原始 URL、故障真实链路与仓库检查

- Status: blocked
- Owner: coordinator
- Objective: 验证修复和邻近路径，报告历史归因剩余风险及运行边界。
- Inputs and prerequisites: T-002 已通过的补丁与回归。
- Scope or files: 包 live 测试、临时产物、本任务文档；不改其他文件。
- Expected output: 真实读取和清理证据、质量检查结果、最终有限结论。
- Dependencies: T-002.
- Execution steps:
  1. 重跑故障注入真实浏览器和原三个 URL 的并发读取。
  2. 执行包离线、root tsgo、定向 Biome、`npm run check`；前后核查其他 worktree 文件。
  3. 审查补丁、删除临时诊断程序，保留日志，验证任务文档。
- Acceptance criteria:
  - 真实因果回归和原 URL 通过，匿名/零凭据/清理验证通过；全仓门禁若受外部修改阻碍如实标记。
- Verification method:
  - test/run.mjs、test/live.mjs、故障注入记录、tsgo/Biome/check 输出及差异。
- Validation evidence: 原页首 IP 拒绝/停滞注入修复后分别在 14,321/16,948ms 读到 678 字；停滞后约 252ms 尝试已批准次地址。原三 URL 同进程并发成功（25,441/25,543/25,101ms；678/483/759 字，可见快照不是完整文档保证）。`node packages/pi-web-search/test/live.mjs 'http://example.com/' 'Example Domain'` 5,226ms 通过且确认匿名隔离、逐 TCP 尝试 pin 和清理；直接代理 HTTP port80 返回 200。所有 live 零 key/Node fetch 调用、拥有的浏览器和 socket 清理通过。连接回归额外两轮通过，`git diff --check`、network.ts Biome 通过。完整 `npm run check` exit1，未执行其 && 后续门禁；root tsgo 已单独通过。最终 package diff 审查仅 5 个预期文件；临时脚本已删除，日志/备份留存 `/tmp/pi-fetch-navigation.v1pNVl/`。
- Blocker: 全仓质量门禁被任务外 6 个 lint warnings 和并行 zz-debug.test.ts 的 5 个 infos 阻塞，不能在本任务范围修复或提交。
- Unblock condition: 相关修改的负责方修复全仓门禁后重跑 `npm run check`，或用户明确接受该验证限制；本任务不擅自修改其他模块。

<!-- task-doc-section:validation-plan -->
## Test and validation plan

1. 在未改 production 上固定一主变量：DNS 快照首地址的可连接性；同页健康对照、首连接拒绝/停滞、必要的并发对照。
2. Node 多地址实验验证仅 IPv4 列表、fallback 上限、HTTP 接线支持、每次实际目标与快照一致；不假设某公网 IP 必然失效。
3. 回归覆盖 CONNECT/HTTP 地址选择、所有候选失败、不重放请求、混合私网拒绝、DNS 固定、取消和清理。
4. `node packages/pi-web-search/test/run.mjs`；原三个公开页及注入路径 live 读取；`node_modules/.bin/tsgo --noEmit`；定向 `biome check`；规定 `npm run check` 完整输出。
5. 不运行全量测试、build、真实模型/API，检查外部修改漂移。仅质量门禁绿且权限满足才提交。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

- 最大证据缺口：历史实际导航原因已丢失，受控注入不能证明当时同因。
- 连接选择跨 SSRF 安全边界：不重复 DNS、不接受部分私网结果、不继承代理或个人状态。
- 多地址尝试必须有界且可取消，不能增加页面请求重放。
- 共享 worktree 的 `npm run check` 带 `--write`；执行前后快照比对，不清理他人代码。已证明本次全仓门禁失败原因在任务外（6 warnings/5 infos），因此未提交。
- 本轮仅在 Node v24.15.0、本机 macOS Chrome 上实测，未重建/替换 dist、未重启用户进程。AgentPort 源码启动需重启实际 easy-pi 进程；`/new` 或 `/reload` 不重导入内置模块。
- 本修复只针对建立 TCP 连接阶段；不覆盖已连接后的 TLS/HTTP/站点临时失败，不重试整页。历史事件没有真实 IP/Chromium 错误，无法确认唯一归因。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-15：创建文档，复核 repo、包及并行修改；当前包备份到 `/tmp/pi-fetch-navigation.v1pNVl/before/`。
- 2026-09-15：T-001 in_progress，下一步为受控连接失败实验；production 尚未修改。
- 2026-09-15：T-001 done：真实浏览器单变量注入和 7 个红回归证明单地址缺陷；当前全部真实 IP 可连接，因此不能直接归因历史事件。
- 2026-09-15：T-002 in_progress：选择 Node 原生 autoSelectFamily + 固定快照 lookup；先 IPv4、每非末次尝试 250ms、保留 15s socket/client 及 30s 页面上限。HTTP 使用已验证的 createConnection 接入同一选择器，无请求重试，无新增依赖。
- 2026-09-15：T-002 done，80/80 tests、类型及 network.ts lint 通过；T-003 in_progress，下一步真实故障注入/原始 URL 并发/全仓门禁。
- 2026-09-15：真实故障注入由失败转成功；同进程原三 URL 并发、browser live、直接 HTTP 80 均通过，匿名、零凭据和清理验证通过。
- 2026-09-15：`npm run check` 被任务外 6 warnings/5 infos 阻塞；Biome 自动格式化了 session-integration.ts 两处 import，已逐处还原并与执行前快照 byte 比对一致，未改动他人逻辑。所有开工前 tracked diff byte-for-byte 保持。
- 2026-09-15：T-003 blocked；本任务定向验证已通过，额外两轮连接回归通过，审查最终 diff（network.ts、connection.test.mjs、network.test.mjs、live-child.mjs、README.md）。临时诊断程序已删除，证据与 hash 清单保留在 `/tmp/pi-fetch-navigation.v1pNVl/`。
- 2026-09-15：LEARNS.md 未改；已有 shared-worktree 格式化教训无需重复，包外文件不扩展写入。未提交、未启动全量测试/build、未访问 Tavily/模型 API、未重启用户会话。
- 2026-09-15：最终文档 validator 通过，5 个修改文件 SHA256 复核通过，开工前 tracked diff byte-for-byte 保持；无本任务活跃后台进程。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: partial
- Evidence: T-001/T-002 done；7 个修复前失败回归转绿，80/80 包测试通过，连接回归额外重复两轮通过；root tsgo、network.ts Biome、diff 检查通过。真实受控故障及原 URL 并发、browser live/HTTP 80 通过。证据目录 `/tmp/pi-fetch-navigation.v1pNVl/` 包含 before/after-live、regressions-red/green、concurrent-live、http-live、full-check、repeated-connections、final-package.diff 和 final-sha256.txt。
- Limitations: T-003 被任务外全仓 lint 门禁阻塞，未提交。历史原始 IP/错误已丢失，只能确认修复的单地址缺陷，不能证明历史唯一根因。未重建 dist、未重启运行实例；源码启动需实际进程重启生效。
