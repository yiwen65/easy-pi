# 真实模型测试报告 — 2026-09-25

## 最新修复状态

### 普通 HTML 点击处理器与动作选择

受限 SPAN/DIV 直接 click 处理器支持已安装，SDK `08b4fdbdb39b0322ffb7529c8a06ed8b87d88962b8c652bea1c79b8d081f3575`。新观察引用、精确 DOM 对象、页面/弹窗边界、禁用与可见性检查保留；不支持跨 frame、任意脚本、事件委托或个人浏览器。最终点击 guard 13/13、弹窗 11/11、加载期提示 7/7、select 15/15，全部关闭；visibility:hidden 曾使初版负例失败，修正 CSS visibility/opacity 检查后通过，原始失败保留。

安装后 click-tab-2 首次 rawReward=1，但模型误用 press 的值后置条件，最终报告未能确认；没有把业务 oracle 通过冒充完整可见验证。随后仅明确工具描述：普通激活使用 click，press.value 不是元素标签。相同模型/seed 42/任务的后续结果：

| 任务 | task 秒 | 回合 | 独立结果/关闭 |
| --- | --- | --- | --- |
| MiniWoB click-tab-2 | 28.683 | 7 | 通过/正常 |
| Chrome form | 24.756 | 6 | 通过/正常 |
| Chrome dialog | 23.217 | 6 | 通过/正常 |
| Chrome navigation | 25.863 | 7 | 通过/正常 |

该批零工具错误，click-tab-2 使用 click 并读回页面奖励；总报告费用 0.1226096 USD，最终 C0680。前一批费用 0.1353116 USD、四任务 oracle 均通过，但保留上述 unknown 与一次旧引用拒绝。两批不是交错性能试验，不证明普遍提速或全量 benchmark 达标。21 browser 契约/工具、15 context、8 package、native TS、根 check 通过；点击修复另有 13 page、24 CDP、139 desktop/context 与独立 renderer 检查。证据 `/tmp/epi-click-handler.mz5oXh/{model-installed,model-action-guidance,listeners-final,installed-smoke}`；原包分别保留 `installed-before`、`installed-before-action-guidance`。

### 可选合并观察（前轮）

浏览器可选 `observeAfter:true` 已通过原生动作结束/读取结束/取消/失败事实保留/实际 provider context 回归，并安装实验版。用法见 `native/computer/browser/README.md`。原生 SDK 不变；只合并工具返回，不省略读取或业务验收。

同模型、任务、脚本和原生指纹的 A1/B1/A2/B2 交错筛查，A/B 各六次任务全部通过且正常关闭：

| 场景 | A 秒（两次） | B 秒（两次） | A 回合 | B 回合 |
| --- | --- | --- | --- | --- |
| form | 35.490 / 39.955 | 29.016 / 35.074 | 10 / 10 | 6 / 6 |
| dialog | 34.477 / 46.198 | 62.830 / 22.857 | 10 / 10 | 6 / 6 |
| navigation | 40.986 / 43.980 | 30.976 / 29.740 | 13 / 12 | 7 / 7 |

总回合 65→38；报告费用 0.2303368→0.1668468 USD；总 task 时间 241.087→210.493 秒。B 全部零失败工具调用，A1 navigation 有一次旧引用正确拒绝后恢复。B 每项确实使用 4/4/5 次合并观察，业务 oracle 不变。B1 dialog 的模型阶段占 59.790 秒，该慢样本保留；只有两次独立进程/版本且 A1 早于实现，因此**不能声称稳定 12.7% 提速、可靠 p95 或普遍非劣**。可确认往返减少，端到端收益仍需扩展样本；T-013 保持进行中。

证据 `/tmp/epi-observe-after.MCxmC4/{ab-contract.json,comparison.json,model-b1,model-a2,model-b2,guard-installed}`，A1 为 `/tmp/epi-nav-final.VvOeIZ/model-unlocked`。原包保留 `installed-before`；候选和安装后的真实 Chrome 5-call Unicode/select/save fixture 均通过，最终 C0610。17 browser 契约/工具、9 context（已含于 133 desktop/context pass + 1 skip）、native TypeScript、npm check 通过。临时独立目录探针曾两次因缺少产品 dist/node_modules 而在加载前失败，补齐指向现有依赖的链接后才运行；未将导入失败报告为产品动作故障。

### 导航期间原生提示修复

导航期间原生 alert 的只读等待修复已安装，SDK `e25bdbd56d3017d4928e669e2ade42667fc3b7c0e088f6c425b5cff41cffa62e`；旧包保留 `/tmp/epi-nav-final.VvOeIZ/installed-before`。详情见 `native/computer/patches/browser-navigation-alert.md`。加载期提示最终 guard 7/7、解锁且进程目录恢复后的弹窗邻域 11/11；不自动接受提示、不重放未知输入。桥接 e8679b3e1 保留安全 cause，同时保持 outcome_unknown。

后续保持解锁条件下，同三个真实模型任务 **3/3 通过**：form 35.490s/10 回合、dialog 34.477s/10 回合、navigation 40.986s/13 回合。业务 oracle 分别为完整表单、approved 你好、R-204/reviewed 你好，均准确且关闭。导航一次旧 observation 被正确拒绝，刷新后完成；其他两项零失败工具调用，不宣称全批零失败。费用 0.1221164 USD。安装后加载期提示 guard 再次 7/7，导航 35–56ms、未触发 watchdog 或自动 dismiss，全部关闭。证据 `/tmp/epi-nav-final.VvOeIZ/{model-unlocked,guards-installed}`。此轮非交错性能 A/B，不能证明普遍提速。

安装后真实模型三项 **0/3**：form 11.049s、dialog 7.604s、navigation 7.867s，均在 prepare 的 browser_window_unproved 后停止，各 2 回合，全部关闭，最终 C05fa。模型可见真实 cause 和禁止重放说明，没有重复未知动作；未产生业务回执。报告费用合计 0.012692 USD。批次结束时系统再次明确 locked=true；不能把这批失败排除或据此称正常解锁场景的模型资格通过。证据 `/tmp/epi-nav-final.VvOeIZ/model-installed`。仍需保持解锁后的相同任务复测，不以新安装替代验收。

环境故障分别保留：原宿主及 Chrome 扩展进程路径 ENOENT 已在后续只读检查消失；锁屏时 CG 窗口尺寸与 CDP 不匹配，解锁后同一探针 prepare/close 成功且尺寸一致。没有强杀个人应用、自动解锁或删除租约。端点偶发失败仍属 T-012，诊断版 75 次未复现不等于已修复。

### 上轮 HTML select 修复

HTML select 修复已安装，详情见 `native/computer/patches/browser-select.md`。原生按实际观察的 OPTION/SELECT 身份选择并读回；桥接增加 `select_option`，可操作行优先进入模型输出预算。没有删除权限或目标身份校验。

| select 修复后同三项真实模型任务 | 结果 | task 秒 | 模型回合 | 关闭 |
| --- | --- | --- | --- | --- |
| Chrome form | 通过 | 37.851 | 10 | 正常 |
| Chrome dialog | 通过 | 35.092 | 10 | 正常 |
| Chrome navigation | 通过 | 38.503 | 12 | 正常 |

三项均无失败工具调用，独立 oracle 和模型可见回执一致。表单为 `王小明 café` / `Hangzhou` / consent `on` / `Pro`，弹窗和导航回执与前轮相同。报告费用 0.105892 USD，最终 lease C054e。SDK `fd2ecf68deac2277f1213adeaa637935561f61a550868a473934da89bbec7aba`；旧包保留 `/tmp/epi-select.l1vU6w/installed-before`。证据 `/tmp/epi-select.l1vU6w/{guards,dialog-guards,model}`。

确定性真实 Chrome select 15/15、弹窗邻域 11/11，全部 native close 证明；拒绝场景零输入/变更事件。离线 12 page、21 CDP、10 browser、131 desktop/context（1 skip）、9 package、UniFFI、native TS、npm check 通过。单次三任务不构成速度 A/B，也不更新历史十三场景整体分数。加载期 alert 问题仍由 T-011 单独诊断，尚未修复。

### 上轮受限 HTML dialog 修复

受限 HTML dialog 修复现已安装：只允许当前页面单个、经 DOM 元数据确认的 HTML dialog 内输入；派发时复核同一个弹窗和目标归属。权限、原生提示、多弹窗、跨 frame、取消与关闭检查保留。源码及复现命令见 `native/computer/patches/browser-dialog.md`。

| 本轮真实模型任务 | 结果 | task 秒 | 模型回合 | 关闭 |
| --- | --- | --- | --- | --- |
| Chrome dialog | 通过 | 37.640 | 11 | 正常 |
| Chrome navigation | 通过 | 37.580 | 13 | 正常 |

同一 gpt-6-sol/browser 路径、同一独立 oracle；弹窗回执 `approved 你好`、导航回执 R-204 / `reviewed 你好` 均准确且被模型看到。弹窗中一次旧 ref 被正确拒绝，刷新后恢复，不宣称零失败调用。报告费用合计 0.0702204 USD，最终 lease C0531。SDK `222302e7c9fb6cdca8faa5775346e1deed504deece18c05c5d5a46d83a87f914`；安装前包保留 `/tmp/epi-dialog.UEensN/installed-before`。不是交错速度对照，不声称稳定 p95 或普遍提速。

另外，最终确定性真实 Chrome guard 11/11：一次正确 Unicode 填充/提交，十种拒绝情形零误输入，全部关闭。所有四批共 44 次原始尝试保留，不将不同 harness 版本混为成功率。前三批包括三个测试断言错误（拒绝阶段/外层错误码）和一个真实残留竞态：页面加载时立即 alert，导航等待至 15 秒 watchdog 取消，terminal 和 close 正常。最终协议改为页面就绪后触发 alert，仅证明“已打开原生提示”拒绝，**不证明导航期间 alert 已修复**。

证据 `/tmp/epi-dialog.UEensN/{guards,guards-final,qualified-guards,qualified-stable-guards,model}`。select 仍未实现；本轮没有重跑已知失败的 form，也不改写历史全套分数。11 page、21 CDP、129 desktop/context + 单独 renderer-value 1/1、package 9/9、UniFFI、native TS 和 npm check 通过。长驻 easy-pi 进程需要正常退出重开以加载新原生库。

### 上轮动作契约修复

动作契约后续已修复并安装（原生 SDK 不变）：单次 click 使用实际 provider view 的 observation/token；结果只报提交，必须再观察。无效 press.expect 与 mutation 后旧 ref 分别在派发前返回明确错误，不再误报成统一“刷新即可”的问题。桌面像素 click 协议保持独立。

候选同三项：导航 PASS 41.796s/13回合；弹窗 FAIL 24.397s/6回合（确已打开，随后原生 modal 检查拒绝）；表单 FAIL 48.077s/11回合（两个文本字段连续 confirmed，随后 select 操作不受支持）。全部正常关闭。最终安装版导航再次 PASS 40.844s/13回合，独立回执包含 R-204 和 reviewed 你好，lease C0503。不是交错 A/B，不声称速度统计提升。此轮四次报告费用共 0.1486388 USD。证据 `/tmp/epi-contract.fIKCCx/{real-model,final-navigation}`；T-010 跟踪弹窗/select 剩余能力。

### helper 恢复后的原始回归

用户随后授权正常重启独立 helper。launchctl stop/start 后 PID 564→64621，进程路径检查失败数 1→0。原生 prepare/close 成功，随后三项真实 gpt-6-sol/browser 测试均 prepare/close 成功，最终 lease C04ff，无再次人工清锁。

| 续验任务 | 业务结果 | task 秒 | 关闭 | 失败事实 |
| --- | --- | --- | --- | --- |
| Chrome form | 失败 | 43.955 | 正常 | 首字段写入并 value_readback confirmed；第二个旧 ref 被拒绝，随后 provider_error |
| Chrome dialog | 失败 | 23.035 | 正常 | press.expect 使用尚未出现的 Confirm 控件，被统一报 stale_observation，重复 observe 无效 |
| Chrome navigation | 失败 | 46.709 | 正常 | press.expect 使用尚未出现的 Records 标题，同样拒绝并重复 observe |

报告费用合计 0.0528276 USD，业务 0/3，不与前轮合并为成功率提升。证据 `/tmp/epi-repair.BJD4uG/{helper-restarted-probe.log,model-after-helper,model-browser-neighbors}`。动作契约与错误分类待 T-009；本轮未放宽目标授权或重放输入。

### 上轮修复记录

后续获准受控恢复，原位恢复 D04f7 后取得确切错误：`image_path_unavailable`；企业微信独立 IPCHelper 的进程路径读取返回 ENOENT。正常退出重开企业微信未重启该 helper，正在等待单独正常重启授权。

已安装 canonical parent 和 browser-preflight：同一异常环境，原版启动 Chrome 后 close=Quarantined；修复版在副作用前拒绝，inputCommitted=false，close 成功。候选、安装 SDK、安装 Computer 工具三次均保持 clean lease，最后 C04fb。固定错误码已对 agent 可见，未知原生文本仍隐藏。详见 `native/computer/patches/browser-preflight.md`；此轮没有新增模型成功样本，不改写下列历史分数。

## 原始故障记录：当时停止 GUI，等待受控恢复决定

最后一次原生浏览器准备对照出现 `outcome_unknown`，关闭证明失败，租约为 `pi-computer-desktop-v1 D 00000000000004f7`。没有删除锁、清除隔离或自动重试。只读 `lsof` 未发现锁持有者；测试 Chrome PID 33473 已退出；进程列表未发现该测试 browser/renderer。**进程已退出不等于原生清理证明成功。**

保留根目录：`/private/tmp/epi-computer-browser-1L3AE8`。原始结果：`/tmp/epi-real-bench.iqOfvX/browser-canonical-control`。后续须先审核原生关闭失败并获得受控恢复授权，不能继续启动桌面任务。

## 已执行范围

模型 `openai-codex/gpt-6-sol`、low reasoning，通过真实 AgentSession；只有 Computer 工具可操作任务。Chrome for Testing 153.0.8010.52，独立空 profile，不访问个人 Chrome。官方 MiniWoB 原始 HTML/reward，固定 seed 42，180 秒适配时限；不是官方全量分数。

| 分组 | 任务通过/尝试 | 正常关闭 | 模型报告费用 USD |
| --- | --- | --- | --- |
| Chrome image-first | 1/5 | 5/5 | 0.324089 |
| Chrome semantic-first | 1/5 | 5/5 | 0.233656 |
| MiniWoB semantic-first | 2/8 | 8/8 | 0.640831 |
| MiniWoB image-first 单项 | 0/1 | 1/1 | 0.047454 |
| browser DOM 默认临时路径 | 0/1 | 1/1 | 0.003482 |
| browser DOM 规范化临时路径对照 | 0/1 | **0/1** | 0.003468 |

另保留三次 bring-up 失败：首次文档 readiness 竞争、两次代理 dispatcher 未初始化导致 provider 连接失败；未混进上表的有效配置组。它们不能被从原始尝试记录中删除。连通性探针报告约 0.00009 USD；本轮已报告合计约 **1.2531 USD**，不是账单核验。失败连接可能未报告实际消费。

十三个不同场景完整单轮（semantic-first）为 **3/13**；各场景仅一个种子/样本，不能证明可靠成功率或 p95。

| 场景 | 结果 | task 秒 | 工具调用数 |
| --- | --- | --- | --- |
| Chrome Unicode 表单、checkbox、select | 失败 | 28.4 | 5 |
| Chrome 跨页查找记录并保存 | 通过 | 73.4 | 13 |
| Chrome 新标签读取并回填 | 失败 | 43.9 | 8 |
| Chrome 长页面底部按钮 | 失败 | 49.9 | 6 |
| Chrome 模态表单 | 失败 | 63.6 | 3 |
| MiniWoB click-test-2 | 失败 | 45.4 | 8 |
| MiniWoB enter-text | 失败，末轮 WebSocket 错误 | 110.2 | 8 |
| MiniWoB click-checkboxes | 失败 | 164.9 | 19 |
| MiniWoB choose-list | 通过 | 55.2 | 13 |
| MiniWoB click-tab-2 | 180 秒中止 | — | 16 |
| MiniWoB drag-box | 失败 | 35.1 | 7 |
| MiniWoB scroll-text | 通过 | 61.1 | 15 |
| MiniWoB login-user | 失败 | 62.5 | 15 |

## 原因与优化决定

1. **全图过期判定是明确障碍。** 原生 `ImageReference::matches` 比较窗口身份、几何和整张 PNG SHA256；倒计时/光标等远处变化也会使坐标点击失效。13 场景轨迹记录到 19 次 `stale_image_observation`。目标区域校验尚待授权与负向回归，未启用。
2. **输入投递不等于输入成功。** 表单轨迹出现 synthetic/background 已投递，但新观察字段仍为空；另有 `foreground_focus_unproved`。焦点与后台投递原因尚未完成因果证明，不能通过删除校验宣称修复。
3. **仅改提示不能普遍修好。** 两种 Chrome 策略均 1/5。导航单样本 89.9→73.4 秒，但调用数 10→13，顺序非交错且样本太小，不作为速度提升结论。未将 semantic-first 推为产品默认。
4. **主要耗时在模型往返。** 首轮 Chrome 模型阶段约占 97%–98%；工具合计每任务约 1–3 秒。下一步优先解决失效后的无效往返和动作可靠性，不优先删毫秒级保护。
5. **浏览器 parent 路径违反原生契约。** macOS 默认 `/var/...` 是 `/private/var/...` 别名；entry 未规范化，native 要求 canonical private parent。已写候选源码与 symlink/mode 回归，未安装。只改变 TMPDIR 的对照确实创建了独立 Chrome profile/DevToolsActivePort，随后发生更深层 prepare/close 失败；**不是浏览器 E2E 修复通过**。该失败的确切原生拒绝原因尚未知，不能推断为某个特定进程回收错误。
6. **harness 改善。** 初始化与 CLI 相同的代理 dispatcher；等待正确 URL/document readiness；连接、调用和退出等待设上限；保留超时/费用/失败；模型异常不记为通过；session shutdown 失败仍调用幂等 host close，并分别记录关闭失败。最后一项仅完成离线回归，因 dirty lease 未再做 GUI 验证。

## 验证与未完成门禁

- 新 benchmark 单测 11/11；directory/entry 定向 3/3；打包资格 9/9。
- 桌面相关加载级测试 124 通过、1 跳过（renderer state test），不是全部通过；无真实 GUI 的该组不能代替本报告。
- `npm run check` 已通过；最终文档/格式与定向测试结果见任务文档。
- 原始测试结束时安装包尚未替换；后续已安装上述 preflight 修复，原包备份 `/tmp/epi-repair.BJD4uG/installed-before`。浏览器成功任务资格仍未完成。
- WebArena/VisualWebArena 官方网站镜像、WorkArena ServiceNow 实例、OSWorld VM/任务资格未准备，未跑官方全量。Chrome 文件上传下载、跨应用办公文档、真实 IME、多屏及长时 soak 仍未覆盖。

原始运行：`/tmp/epi-real-bench.iqOfvX/{smoke,smoke2,smoke3,smoke4,chrome-baseline,semantic,browser-smoke,browser-canonical-control}`。每组 contract、summary、每任务 trace/截图/result 保留；不同版本结果不混称正式 A/B。早期组只记脚本哈希，最终 runner 额外保存 sources 快照。
