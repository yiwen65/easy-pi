# Task Plan: epi 默认 Computer 接线

- Created: 2026-09-23
- Workspace: /Users/w/Projects/easy-pi/pi
- Mode: execute
- Overall status: done
- Source: 用户“接线到 epi”，随后选择“默认可用、按需加载”，并明确确认完整方案。

<!-- task-doc-section:background-goal -->
## Background and goal

将已验收的 General Computer 接入用户当前 PATH 的 epi。普通CLI向模型默认提供Computer，首次实际调用才加载SDK/启动renderer；不调用则不启动原生组件。旧General交付与78项历史验收不修改，本文件是本次CLI默认接线的唯一状态源。

<!-- task-doc-section:scope-non-goals -->
## Scope and non-goals

- 默认仅改变CLI；SDK仍显式注入feature，原Agent loop/共享host/scheduler不变。
- 保留tools/exclude/no-tools优先级、紧急停止、关闭和unknown无重放；不引入配置开关体系或第二loop。
- 更新当前epi实际指向的构建和匹配assets，允许必要离线构建及专用fixture实测；不改凭据/浏览器资料、不操作个人文档、不新增真实provider调用、不发布/push。
- 仅工作树pi内开发和匹配构建部署；保存原有构建用于回退，不终止正在运行的用户会话。
- LEARNS.md及并发review文件/脚本不改、不暂存；旧归档d345396d与b2a0012b保持原样。

<!-- task-doc-section:facts-evidence -->
## Confirmed facts and evidence

| ID | Confirmed fact | Evidence |
| --- | --- | --- |
| F-001 | 当前epi是~/.local/bin/epi，exec node到pi/packages/coding-agent/dist/cli.js | command -v与完整wrapper读取 |
| F-002 | packages/coding-agent/computer不存在，现有dist时间为Sep20；源码已有显式Computer接线 | ls；main.ts shouldActivateComputer/createNativeComputerFeature |
| F-003 | 应用factory只载入JS bridge；native/renderer惰性启动由已有binding拥有 | core/computer/activation.ts；此前真实关闭与惰性资格 |
| F-004 | shouldActivateComputer需要computer:true，exclusion优先、allowlist覆盖no-tools；parseArgs目前没有默认computer | activation.ts、cli/args.ts |
| F-005 | 已验收SDK b7e0ad95/NAPI93ffdcc7/helper1195e23e；最后GUI clean C774 | 前一任务authority及delivery/final/completion-verification.json |
| F-006 | 起始HEAD bf492b81d，LEARNS既有修改及review相关未跟踪文件保持 | git status/log |

<!-- task-doc-section:assumptions-questions -->
## Assumptions and open questions

- 已接受的需求假设：无。用户确认默认工具意味着模型可主动操作桌面。
- 未决需求问题：无。CLI默认策略与资产部署细节按实际源码/验证决定，SDK接口不扩张。

<!-- task-doc-section:acceptance-criteria -->
## Acceptance criteria

- 普通epi无--computer时实际provider schema包含computer；排除/no-tools/allowlist仍按原规则工作。
- 普通无Computer动作的对话、help/version均不加载native或启动renderer。
- 原SDK无computer注入仍不开启；显式Computer/isolated-browser入口不被意外移除。
- 当前epi路径完成专用fixture的发现/选择/观察/实际动作及结果确认、native终态/自然关闭、helper消失。
- 现有构建可回退，匹配库/helper/pins可复查，旧独立归档和无关工作不变。

<!-- task-doc-section:dependencies-batches -->
## Dependencies and parallel batches

- Dependency graph: T-001 → T-002 → T-003。
- Parallel batches: 无；CLI、构建、部署与GUI共享输入，coordinator串行执行。
- Serialization constraints: 唯一原生/GUI owner；不并行写活动构建、不在脏共享树运行write-mode检查。

<!-- task-doc-section:task-list -->
## Task list

### [x] T-001 — CLI默认策略与回归
- Status: done
- Owner: coordinator
- Objective: 用最小改动使默认CLI提供Computer，保留筛选和SDK边界。
- Inputs and prerequisites: 用户确认；实际args/main/activation调用链及文档。
- Scope or files: coding-agent CLI args/activation及必要定向tests/docs；不改Agent loop或native。
- Expected output: 默认策略、明确帮助文案、先失败后通过回归。
- Dependencies: None.
- Execution steps: 完整读取相关源码/文档；编码默认/metadata/filter回归；最小实施；定向测试与隔离完整check。
- Acceptance criteria: 默认available、显式禁用有效、SDK默认不变、零native初始化。
- Verification method: args/activation/原AgentSession定向tests、strict types、隔离npm run check及diff。
- Validation evidence: activation两个真实before失败（默认undefined及默认filter结果false）→after与args/runtime-owner/emergency共111通过。最小产品改动仅parseArgs初值computer:true、去掉已失效的manifest显式flag要求，filter/SDK factory行为不改；帮助/README/SDK及PACKAGING说明更新。check隔离全npm check0/1460文件，四个无关formatter增量仅副本且与旧g07audit一致，live drift0；offline build0。匹配已资格assets的阶段CLI十三入口/场景（print/json/rpc/default/exclusion/no-tools/allowlist等）19个faux请求schema符合预期且nativeLoads0；另真实SDK无computer binding的read-faux仍native-inert。证据.artifacts/computer/epi-default/，未部署当前epi或新GUI。
- Blocker: None.
- Unblock condition: None.

### [x] T-002 — 当前epi匹配构建与资产部署
- Status: done
- Owner: coordinator
- Objective: 不依赖临时独立包，让当前epi入口使用匹配的General构建/assets。
- Inputs and prerequisites: T-001通过；已验收原生candidate和renderer/source materials。
- Scope or files: pi内隔离build/packaging证据、packages/coding-agent/dist及computer部署；仅必要的关联workspace构建。
- Expected output: 备份/部署清单和当前入口，SDK/NAPI/helper逐hash一致。
- Dependencies: T-001
- Execution steps: 核验现有dist和依赖解析；隔离build；备份原输出并部署完整匹配闭包；metadata/零native/faux schema验证。
- Acceptance criteria: 当前epi无额外flag就提供工具，依赖/资产不混用，旧归档和用户配置不变。
- Verification method: 文件hash/链接、epi --help/--version、隔离HOME当前CLI faux及disable矩阵。
- Validation evidence: deploy.py先验证source drift/旧归档、完整备份旧生成输出，再部署匹配workspace dist、三个私有编译依赖和1428 Computer assets，coding-agent/dist最后切换；~/.local/bin/epi wrapper原字节不改，Node实际24.15.0。backup在.artifacts/computer/epi-default/live-output-before/，deployment.json和before/progress保存逐file/hash。真正/Users/w/.local/bin/epi十三场景默认/显式/过滤/no-tools/read-only/allowlist/no-builtins/JSON/RPC/help/version/auth-help全部exit0；19faux请求实际schema符合预期、conversation nativeLoads0，未使用真实provider/原生GUI。旧d345归档未改、用户会话未终止。
- Blocker: None.
- Unblock condition: None.

### [x] T-003 — 实际入口桌面与生命周期验收
- Status: done
- Owner: coordinator
- Objective: 证明接入后的真实epi而非另一示例完成专用桌面动作并正常停止/关闭。
- Inputs and prerequisites: T-002实际入口；fresh console/TCC/Stop/clean lease。
- Scope or files: 自有fixture、无网络faux CLI/SDK测试证据、本任务记录及owned提交。
- Expected output: 默认schema、真实效果、终态和自然退出证据；最终状态与使用说明。
- Dependencies: T-002
- Execution steps: fresh准入；通过当前epi原loop调用Computer；独立fixture oracle/终态/退出/资产核对；审查并提交owned路径。
- Acceptance criteria: 一次实际效果不重放；GUI/native/helper关闭，过滤关闭保持；不消耗真实provider预算。
- Verification method: 原始事件/独立oracle、当前epi路径和mapped binaries、任务validator及diff。
- Validation evidence: live-gui-01通过实际/Users/w/.local/bin/epi、无--computer/无工具allowlist，原AgentSession五个faux请求完成discover/select/capture/segment，四个native终态仅一个committed；独立fixture down/up/counter各1、零键盘/文本，后台delivery2且condition satisfied、recovery0。真实helper父进程/路径匹配；host create/close/destroy各1，owner与fixture自然exit0，helper消失，无强制退出，fresh clean C774→C775。GUI preload为TCC/回执显式载SDK，不能单独证明惰性；惰性由此前真实CLI普通对话nativeLoads0证据建立。GUI stdout探针捕获原writer避开CLI输出接管，产品stdout行为未改。
- Blocker: None.
- Unblock condition: None.

<!-- task-doc-section:validation-plan -->
## Test and validation plan

优先现有args/Computer activation tests和faux provider。任何write-mode全check和构建先在隔离快照验证，只部署有清单的输出；不修无关全套14历史/共享失败。GUI仅专用fixture，实际行动进程fresh准入，不借用C774当未来许可。任何dirty/未知输入停止实验，不自动清锁或重放。

<!-- task-doc-section:risks-blockers -->
## Risks and blockers

默认提供工具扩大普通CLI的模型能力，是用户明确接受的行为变更。缺匹配assets/不支持runtime时须保持明确错误或已有禁用路径，不静默装库。现有epi使用PATH中的node，需核验实际版本。当前工作树有并发修改，提交只选owned路径。

<!-- task-doc-section:execution-log -->
## Execution log

- 2026-09-23: 用户确认CLI默认可用/原生按需加载、SDK与凭据/旧归档不变；已定位真实epi wrapper、发现工作树没有computer assets；T-001由coordinator串行开始。
- 2026-09-23: T-001 done：before2fail、after111pass、隔离check/build0、stage CLI十三场景19faux请求/零native，以及SDK无注入保持零native。新增gitignore仅忽略packages/coding-agent/computer生成资产。T-002开始核验/备份旧workspace输出后部署匹配闭包；wrapper保持原入口，不会停止用户现有进程；新默认用于新启动的epi。
- 2026-09-23: T-002部署和当前epi实际13场景/19faux请求通过，wrapper和旧归档保持。T-003开始专用fixture/实际CLI原loop资格：测试preload仅注册无网络faux、收集native回执及fresh TCC，不替代CLI创建Computer feature，不传--computer；stdio复用只区分测试事件与标准CLI JSON，控制面继续可停止。

<!-- task-doc-section:final-validation -->
## Final validation result

- Result: passed
- Evidence: T-001–T-003完成；111定向回归、隔离完整check/offline build、stage及live各13入口19faux请求、SDK无注入惰性、实际epi GUI C775通过。证据.artifacts/computer/epi-default/{deployment.json,live-cli-verification.json,live-gui-01/result.json}；旧构建备份live-output-before/。最终复核LEARNS SHA dac97fbb、General归档d345396d和P08归档b2a0012b均未变；无新增真实provider调用。新默认对新启动epi生效，已运行会话不自动更新。
- Limitations: 无新真实模型授权/调用；共享全套已知14失败不由本任务扩展修复。
