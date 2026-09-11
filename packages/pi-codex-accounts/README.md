# Pi Codex 多账号插件

适配本机 **Pi 0.84.2 / Node.js 24**。每个别名是独立的 Codex provider，复用原生登录、请求和令牌刷新。不修改 Pi 源码或覆盖原有登录。

## 安装

```bash
pi install /Users/w/Projects/easy-pi/packages/pi-codex-accounts
```

重启 Pi 或 `/reload`。插件尚未发布到 npm。复制到其他机器时，先在插件目录运行 `npm install` 安装依赖，再安装该本地路径；请使用匹配的 Pi 版本。本机开发依赖链接到现有 Pi 工作区。

## 使用

1. `/codex-account add work` 创建别名，编辑器会填入原生登录命令，**按 Enter** 开始授权。
2. 在浏览器确认使用目标 OpenAI 账号。若自动选中旧账号，请使用另一浏览器配置文件或无痕窗口打开授权链接。设备码方式也沿用 Pi 原生流程。
3. 登录成功后，运行 `/codex-account switch work`。
4. `/codex-account add personal` 添加另一个账号，重复授权步骤。

| 命令 | 用途 |
| --- | --- |
| `/codex-account` | 打开切换菜单 |
| `/codex-account list` | 查看别名、登录配置状态及当前账号 |
| `/codex-account switch personal` | 切换账号，尽量保留相同模型 |
| `/codex-account switch default` | 回到原有 Codex 账号 |
| `/codex-account login work` | 准备重新登录命令，按 Enter 执行 |

别名支持 1–32 位小写英文字母、数字和连字符，以字母开头；`default` 为原账号保留。不同别名不保证对应不同 OpenAI 身份，请核对授权页面。

退出某个登录：使用 Pi 原生 `/logout` 菜单，选择 `OpenAI Codex [work]`。退出不会删除别名，可以重新登录。

## 行为与安全

- 切换只修改当前会话的模型/provider；已有上下文会随继续对话发送给切换后的账号。不自动重发请求或按额度轮换账号。
- 有请求或排队消息时拒绝切换。不影响其他会话选择的账号；恢复会话沿用 Pi 自身的模型恢复机制。
- 原账号使用 `openai-codex`；新增账号使用 `openai-codex-account-<别名>`，也可在 `/model` 中选择。
- 凭据仅由 Pi 原生认证存储管理，本插件不另外复制或加密凭据，不读取浏览器 Cookie。请勿分享或提交 Pi 的认证文件。
- 只在 `~/.pi/agent/codex-accounts/<别名>/` 保存空目录作为元数据，尊重 `PI_CODING_AGENT_DIR`。并发新增不同别名不会覆盖彼此。其他进程下次执行此命令时发现新别名。
- 底层错误文本不显示，避免意外泄露凭据。列表的“已配置登录”不代表令牌仍有效。
- 移除插件不会删除认证信息。如需退出账号，先使用 `/logout`。

## 验证

```bash
npm test
npm run typecheck
```

测试覆盖别名校验与持久化、真实 Codex provider 的认证隔离、登录命令准备与切换保护、重载恢复，以及 Pi 原生 Jiti 加载器。

`codex-provider.mjs` 是绕开 Pi 0.84.2 Jiti 子路径别名问题的原生 ESM 桥接，没有自定义 OAuth 实现。测试使用 Node 原生 TypeScript 支持，不使用会改变此桥接行为的 tsx。

测试不使用真实令牌或网络。真实浏览器授权、在线令牌刷新和 Codex 请求仍需登录后验证。
