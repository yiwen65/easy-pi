import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { providerId } from "../accounts.ts";
import extension from "../index.ts";

test("commands register, prepare native login, switch safely and restore aliases", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-codex-extension-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const providers = new Map<string, Provider>();
		let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		let editor = "";
		let idle = true;
		let pending = false;
		let configured = false;
		let switches = 0;
		let failSwitch = false;
		const notices: string[] = [];
		const api = {
			registerProvider(provider: Provider) {
				providers.set(provider.id, provider);
			},
			on() {},
			registerCommand(_name: string, options: { handler: typeof handler }) {
				handler = options.handler;
			},
			async setModel(model: { provider: string }) {
				if (failSwitch) throw new Error("secret-token-must-not-leak");
				switches++;
				assert.equal(model.provider, providerId("work"));
				return true;
			},
		} as unknown as ExtensionAPI;
		extension(api);
		const ctx = {
			hasUI: true,
			isIdle: () => idle,
			hasPendingMessages: () => pending,
			ui: {
				notify(message: string) {
					notices.push(message);
				},
				setEditorText(text: string) {
					editor = text;
				},
				setStatus() {},
				async select() {
					return undefined;
				},
			},
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured }),
				getAll: () => [...providers.values()].flatMap((provider) => [...provider.getModels()]),
			},
		} as unknown as ExtensionCommandContext;
		await handler("add work", ctx);
		assert.equal(editor, `/login ${providerId("work")}`);
		assert.equal(providers.size, 1);
		const model = providers.get(providerId("work"))!.getModels()[0]!;
		Object.assign(ctx, { model });
		await handler("switch work", ctx);
		assert.equal(switches, 0);
		configured = true;
		idle = false;
		await handler("switch work", ctx);
		assert.equal(switches, 0);
		idle = true;
		pending = true;
		await handler("switch work", ctx);
		assert.equal(switches, 0);
		pending = false;
		await handler("switch work", ctx);
		assert.equal(switches, 1);
		failSwitch = true;
		await handler("switch work", ctx);
		assert.ok(!notices.join("\n").includes("secret-token-must-not-leak"));
		await handler("add work", ctx);
		assert.equal(providers.size, 1);
		providers.clear();
		extension(api);
		assert.ok(providers.has(providerId("work")));
		await handler("", ctx); // Cancelled picker does not change anything.
		assert.equal(switches, 1);
		await handler("list", ctx);
		assert.ok(notices.at(-1)?.includes("work"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
