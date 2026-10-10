import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CollaborationController } from "../src/collaboration-controller.ts";
import { CollaborationStore } from "../src/collaboration-store.ts";
import type { ChildSessionHost } from "../src/session-host.ts";

test("failed native disposal keeps team ownership until the owning process exits", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "epi-disposal-owner-")));
	const path = join(cwd, "registry.sqlite");
	const rootSessionId = randomUUID();
	const store = new CollaborationStore({ path, cwd, rootSessionId });
	const host: ChildSessionHost = {
		async create(options) {
			return {
				identity: options,
				sessionId: randomUUID(),
				sessionFile: undefined,
				context: () => [],
				forkContext: () => [],
				run: async () => ({ status: "completed", text: "done" }),
				abort: async () => {},
				dispose: async () => {
					throw new Error("synthetic incomplete disposal");
				},
			};
		},
	};
	const controller = new CollaborationController({
		store,
		host,
		agentDir: cwd,
		getPermissions: () => ({ mode: "full-access", sessionGrants: [], protectedRoots: [] }),
	});
	let second: CollaborationStore | undefined;
	try {
		await controller.spawn({ rootSessionId, agentPath: "/root" }, "worker", "task", {
			provider: "faux",
			id: "one",
			thinkingLevel: "off",
		});
		await controller.settled();
		await expect(controller.shutdown()).rejects.toMatchObject({ code: "interrupted" });
		expect(() => {
			second = new CollaborationStore({ path, cwd, rootSessionId, recoverInterruptedOwner: true });
		}).toThrow(expect.objectContaining({ code: "busy" }));
		expect(store.read().agents[0].result).toBe("done");
	} finally {
		second?.close();
		store.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
