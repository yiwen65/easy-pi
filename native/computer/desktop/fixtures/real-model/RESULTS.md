# 真实模型测试报告 — 2026-09-24

## 当前状态：停止 GUI，等待受控恢复决定

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
- 当前安装包与 native SDK 未替换；候选包保留 `/tmp/epi-real-bench.iqOfvX/package-canonical`，并未冒充生产资格完成。
- WebArena/VisualWebArena 官方网站镜像、WorkArena ServiceNow 实例、OSWorld VM/任务资格未准备，未跑官方全量。Chrome 文件上传下载、跨应用办公文档、真实 IME、多屏及长时 soak 仍未覆盖。

原始运行：`/tmp/epi-real-bench.iqOfvX/{smoke,smoke2,smoke3,smoke4,chrome-baseline,semantic,browser-smoke,browser-canonical-control}`。每组 contract、summary、每任务 trace/截图/result 保留；不同版本结果不混称正式 A/B。早期组只记脚本哈希，最终 runner 额外保存 sources 快照。
