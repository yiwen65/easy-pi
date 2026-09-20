import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
} from "../../src/core/agent-session-runtime.ts";
import { createComputerSessionBinding } from "../../src/core/computer/binding.ts";
import { ComputerHost } from "../../src/core/computer/host.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(closeNative = async () => {}) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "computer-runtime-owner-")));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	const events: string[] = [];
	let nextId = 0;
	const native = {
		openSession: vi.fn(() => {
			const id = ++nextId;
			return {
				id,
				revoke: () => events.push(`revoke:${id}`),
				close: async () => {
					events.push(`session-close:${id}`);
				},
			};
		}),
		close: vi.fn(async () => {
			events.push("host-close");
			await closeNative();
		}),
	};
	const host = new ComputerHost({ desktopId: "runtime-owner-test", createRuntime: () => native });
	const binding = createComputerSessionBinding(host.openSession(), (session) => [
		{
			name: "computer",
			label: "Computer fixture",
			description: "Fake native value through the real AgentSession loop",
			parameters: Type.Object({}),
			executionResource: { key: "desktop:runtime-owner-test", mode: "exclusive" },
			async execute(_id, _input, signal) {
				const id = await session.run(
					(value) => ({ result: Promise.resolve(value.id), terminal: Promise.resolve(), cancel() {} }),
					signal,
				);
				return { content: [{ type: "text", text: String(id) }], details: { id } };
			},
		},
	]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ provider: "computer-runtime-owner-faux", tokensPerSecond: 0 });
	modelRuntime.registerNativeProvider(faux.provider);
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		expect("closeComputerHost" in options).toBe(false);
		const services = {
			cwd,
			agentDir: cwd,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
			resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([], cwd) }),
			diagnostics: [],
		};
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				computer: options.computer,
				model: faux.getModel(),
			})),
			services,
			diagnostics: [],
		};
	};
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir: cwd,
		sessionManager: SessionManager.inMemory(cwd),
		computer: binding,
		closeComputerHost: () => host.close(),
	});
	cleanups.push(async () => {
		if (host.quarantined) await expect(runtime.dispose()).rejects.toMatchObject({ code: "desktop_quarantined" });
		else await runtime.dispose();
	});
	async function prompt() {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await runtime.session.prompt("Use the fake Computer.");
	}
	return { cwd, events, native, host, binding, runtime, prompt };
}

describe("final Computer host ownership", () => {
	it("keeps the runtime across replacement and closes it only on final disposal", async () => {
		const f = await fixture();
		await f.prompt();
		const old = f.runtime.session.computer;
		await f.runtime.newSession();
		expect(old?.revoked).toBe(true);
		expect(f.native.close).not.toHaveBeenCalled();
		expect(f.runtime.session.computer?.scheduler).toBe(f.host.scheduler);
		await f.prompt();
		expect(f.native.openSession).toHaveBeenCalledTimes(2);
		await f.runtime.dispose();
		await f.runtime.dispose();
		expect(f.native.close).toHaveBeenCalledTimes(1);
		expect(f.events.indexOf("host-close")).toBeGreaterThan(f.events.indexOf("session-close:2"));
	});

	it("awaits the actual host close instead of merely disposing the last session", async () => {
		const entered = barrier();
		const release = barrier();
		const f = await fixture(async () => {
			entered.resolve();
			await release.promise;
		});
		await f.prompt();
		let settled = false;
		const closing = f.runtime.dispose().then(() => {
			settled = true;
		});
		try {
			await entered.promise;
			expect(settled).toBe(false);
			expect(f.binding.revoked).toBe(true);
			expect(f.events).toContain("session-close:1");
		} finally {
			release.resolve();
		}
		await closing;
		expect(f.native.close).toHaveBeenCalledTimes(1);
	});

	it("closes the owned host on initial factory failure, without exposing its disposer to the factory", async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "computer-factory-failure-")));
		cleanups.push(() => rm(cwd, { recursive: true, force: true }));
		const close = vi.fn(async () => {});
		await expect(
			createAgentSessionRuntime(
				async (options) => {
					expect("closeComputerHost" in options).toBe(false);
					throw new Error("initial factory failed");
				},
				{ cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd), closeComputerHost: close },
			),
		).rejects.toThrow("initial factory failed");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("reports failed host drain and never retries it as a successful disposal", async () => {
		const f = await fixture(async () => {
			throw new Error("native cleanup unproved");
		});
		await f.prompt();
		const closing = f.runtime.dispose();
		await expect(closing).rejects.toMatchObject({ code: "desktop_quarantined" });
		expect(f.host.quarantined).toBe(true);
		expect(f.runtime.dispose()).toBe(closing);
		expect(f.native.close).toHaveBeenCalledTimes(1);
	});

	it("does not reopen filtered authority during a runtime replacement", async () => {
		const f = await fixture();
		await f.prompt();
		f.runtime.session.setActiveToolsByName(["read"]);
		await f.runtime.newSession();
		expect(f.runtime.session.computer).toBeUndefined();
		f.runtime.session.setActiveToolsByName(["computer"]);
		expect(f.runtime.session.getActiveToolNames()).not.toContain("computer");
		expect(f.native.openSession).toHaveBeenCalledTimes(1);
		await f.runtime.dispose();
		expect(f.native.close).toHaveBeenCalledTimes(1);
	});
});
