import type { AgentSession } from "../core/agent-session.ts";
import type { ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { SideConversationController } from "../core/side-conversation.ts";
import type { SideConversation } from "../core/side-conversation-types.ts";
import { GrokSidePanel } from "../modes/interactive-grok/components/grok-side-panel.ts";
import { getNativeSession } from "./native-session-binding.ts";

/** User-facing side conversation; not a team child and never a model-callable tool. */
export function createSideConversationExtension(options?: {
	createConversation?: (parent: AgentSession) => SideConversation;
}): ExtensionFactory {
	return (pi) => {
		let conversation: SideConversation | undefined;
		let panel: GrokSidePanel | undefined;
		let opening = false;
		let stopped = false;
		let generation = 0;
		let startupError: string | undefined;
		const start = (ctx: ExtensionContext) => {
			if (conversation || stopped || ctx.mode !== "tui") return;
			// Native child loaders do not include this factory; also reject accidental manual binding.
			if (
				ctx.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "epi-collaboration-identity")
			) {
				startupError = "Side conversations are unavailable inside a child session.";
				return;
			}
			try {
				const parent = getNativeSession(ctx.sessionManager);
				conversation = options?.createConversation?.(parent) ?? new SideConversationController(parent);
				startupError = undefined;
			} catch (error) {
				startupError = error instanceof Error ? error.message : String(error);
			}
		};
		pi.on("session_start", (_event, ctx) => start(ctx));
		pi.on("session_shutdown", async () => {
			stopped = true;
			generation++;
			panel?.hide();
			panel = undefined;
			await conversation?.shutdown();
		});
		for (const name of ["side", "btw"]) {
			pi.registerCommand(name, {
				description: "Open an in-memory, read-only side conversation that preserves the parent request prefix",
				handler: async (args, ctx) => {
					if (ctx.mode !== "tui") {
						ctx.ui.notify("Side conversations are available only in interactive TUI mode.", "warning");
						return;
					}
					if (stopped) return;
					start(ctx);
					if (!conversation) {
						ctx.ui.notify(`Side conversation unavailable: ${startupError ?? "session not started"}`, "error");
						return;
					}
					if (opening || panel) {
						ctx.ui.notify("A side conversation panel is already open.", "info");
						return;
					}
					opening = true;
					const current = conversation;
					const currentGeneration = generation;
					try {
						await current.open();
						if (stopped || generation !== currentGeneration) return;
						const text = args.trim();
						if (text) {
							// Do not wait for the answer before mounting its streaming UI.
							void current.prompt(text).catch((error: unknown) => {
								if (!stopped && generation === currentGeneration)
									ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							});
						}
						await ctx.ui.custom<void>(
							(tui, theme, keybindings, done) => {
								const view = new GrokSidePanel({
									conversation: current,
									theme,
									keybindings,
									requestRender: () => tui.requestRender(),
									done: () => done(),
									height: () => Math.max(1, tui.terminal.rows),
								});
								panel = view;
								if (stopped || generation !== currentGeneration) view.hide();
								return view;
							},
							{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
						);
					} catch (error) {
						if (!stopped) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					} finally {
						panel = undefined;
						opening = false;
					}
				},
			});
		}
	};
}
