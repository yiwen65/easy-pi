import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import {
	checkCollaborationStorageAdmission,
	inspectCollaborationStorage,
} from "@easy-pi/subagent/collaboration-storage";
import { CollaborationStore } from "@easy-pi/subagent/collaboration-store";
import { expect, test } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createPiChildSessionHost } from "../src/extensions/pi-child-session-host.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test.each([1, 2, 3])(
	"positive byte budgets admit a second native child while the first owns its task lock (%i)",
	async () => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-native-task-storage-")));
		const cwd = join(directory, "project");
		await mkdir(cwd);
		const options = {
			agentDir: join(directory, "agent"),
			rootSessionId: "team",
			maxTeamBytes: 1_000_000_000,
			maxTotalBytes: 1_000_000_000,
		};
		const teamDir = join(options.agentDir, "teams", options.rootSessionId);
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({ provider: "task-storage-faux", tokensPerSecond: 0 });
		modelRuntime.registerNativeProvider(faux.provider);
		const started = deferred();
		const release = deferred();
		const secondStarted = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("first done");
			},
			() => {
				secondStarted.resolve();
				return fauxAssistantMessage("second done");
			},
		]);
		const store = new CollaborationStore({
			path: join(teamDir, "registry.sqlite"),
			cwd,
			rootSessionId: options.rootSessionId,
		});
		const controller = new CollaborationController({
			store,
			host: createPiChildSessionHost({
				modelRuntime,
				noExtensions: true,
				registerTools: () => {},
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
			}),
			agentDir: options.agentDir,
			getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
			checkStorageAdmission: () => checkCollaborationStorageAdmission(options),
		});
		try {
			const caller = { rootSessionId: options.rootSessionId, agentPath: "/root" };
			const model = { provider: faux.provider.id, id: faux.getModel().id, thinkingLevel: "off" as const };
			await controller.spawn(caller, "first", "first task", model);
			await started.promise;
			const first = store.read().agents[0];
			const lock = join(teamDir, first.id, `${first.sessionFile}.task.lock`);
			expect(existsSync(lock)).toBe(true);
			const duringFirst = inspectCollaborationStorage(options);
			await controller.spawn(caller, "second", "second task", model);
			expect(duringFirst).toMatchObject({ incomplete: false, deletable: false });
			await secondStarted.promise;
			expect(faux.state.callCount).toBe(2);
			expect(existsSync(lock)).toBe(true);
			release.resolve();
			await controller.settled();
			expect(store.read().agents.map((agent) => agent.status)).toEqual(["completed", "completed"]);
			expect(existsSync(lock)).toBe(false);
		} finally {
			release.resolve();
			await controller.shutdown();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
