import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountProvider, addAccount, DEFAULT, listAccounts, PREFIX, providerId } from "./accounts.ts";

class UserError extends Error {}

export default function codexAccounts(pi: ExtensionAPI) {
  const directory = join(getAgentDir(), "codex-accounts");
  const registered = new Set<string>();
  function syncAccounts() {
    const names = listAccounts(directory);
    for (const name of names) {
      if (!registered.has(name)) {
        pi.registerProvider(accountProvider(name));
        registered.add(name);
      }
    }
    return [DEFAULT, ...names];
  }
  syncAccounts();

  function status(ctx: ExtensionContext, provider = ctx.model?.provider) {
    if (!ctx.hasUI) return;
    const name = provider === "openai-codex" ? DEFAULT : provider?.startsWith(PREFIX) ? provider.slice(PREFIX.length) : undefined;
    ctx.ui.setStatus("codex-account", name ? `Codex: ${name}` : undefined);
  }
  pi.on("session_start", async (_event, ctx) => { status(ctx); });
  pi.on("model_select", async (event, ctx) => { status(ctx, event.model.provider); });

  pi.registerCommand("codex-account", {
    description: "Codex 多账号：add <别名> | login <别名> | list | switch <别名>，无参数打开切换菜单",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new UserError("请在 Pi 交互模式中管理 Codex 账号。");
      try {
        const [action = "switch", argument, ...extra] = args.trim().split(/\s+/).filter(Boolean);
        if (extra.length || !["add", "login", "list", "switch"].includes(action) || (action === "list" && argument)) {
          throw new UserError("用法：/codex-account [add <别名> | login <别名> | list | switch [别名]]");
        }
        const names = syncAccounts();
        if (action === "list") {
          ctx.ui.notify(names.map((name) => {
            const id = providerId(name);
            const configured = ctx.modelRegistry.getProviderAuthStatus(id).configured;
            return `${ctx.model?.provider === id ? "→ " : "  "}${name} — ${configured ? "已配置登录（不代表令牌仍有效）" : "未登录"}`;
          }).join("\n"), "info");
          return;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new UserError("请等待当前请求和排队消息结束后再管理账号。");
        if (action === "add") {
          if (!argument) throw new UserError("用法：/codex-account add <别名>");
          if (names.includes(argument)) throw new UserError("别名已存在；请使用 login 重新登录或 switch 切换。");
          addAccount(directory, argument);
          syncAccounts();
        }
        const name = argument ?? (action === "switch" ? await ctx.ui.select("切换 Codex 账号", names) : undefined);
        if (!name) {
          if (action === "login") throw new UserError("用法：/codex-account login <别名>");
          return;
        }
        if (!syncAccounts().includes(name)) throw new UserError("账号别名不存在，请先使用 add 创建。");
        // A picker may remain open while another extension starts work.
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new UserError("当前有请求或排队消息，未切换账号。");
        const id = providerId(name);
        if (action === "add" || action === "login") {
          ctx.ui.setEditorText(`/login ${id}`);
          ctx.ui.notify(`已准备 ${name} 的登录命令，按 Enter 开始。请在浏览器确认使用目标账号；登录成功后运行 /codex-account switch ${name}。`, "info");
          return;
        }
        if (!ctx.modelRegistry.getProviderAuthStatus(id).configured) throw new UserError(`尚未登录，请运行 /codex-account login ${name}。`);
        const models = ctx.modelRegistry.getAll().filter((model) => model.provider === id);
        let model = models.find((candidate) => candidate.id === ctx.model?.id);
        if (!model) {
          const selected = await ctx.ui.select("选择 Codex 模型", models.map((candidate) => candidate.id));
          if (!selected) return;
          model = models.find((candidate) => candidate.id === selected);
        }
        if (!model) throw new UserError("没有可用的 Codex 模型。");
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new UserError("当前有请求或排队消息，未切换账号。");
        if (!await pi.setModel(model)) throw new UserError(`切换未成功，请重新登录 ${name}。`);
        status(ctx, id);
        ctx.ui.notify(`已切换到 Codex 账号 ${name}（${model.id}）。`, "info");
      } catch (error) {
        // Do not expose raw provider/network errors that could contain credential data.
        const message = error instanceof UserError ? error.message : "账号操作失败。请检查别名格式、目录权限或使用 login 重新登录；原始错误已隐藏以保护认证信息。";
        ctx.ui.notify(message, "error");
      }
    },
  });
}
