import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, StdioTransport } from "../src/index.ts";

const leaderFixture = fileURLToPath(new URL("./fixtures/leader-exits-server.mjs", import.meta.url));
const unrelatedFixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

// Only signal groups created by this test, and never retry an identity after observing its exit.
function forceCleanup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

describe.skipIf(process.platform === "win32")("stdio group cleanup after leader exit", () => {
	describe.each(["client", "transport"] as const)("%s close", (owner) => {
		it.each([
			["inherit", true],
			["ignore", true],
			["inherit", false],
			["ignore", false],
		] as const)("cleans descendants with %s stdio (leader exits before close: %s)", async (stdio, exitFirst) => {
			const transport = new StdioTransport({
				command: process.execPath,
				args: [leaderFixture, stdio],
				closeTimeoutMs: 50,
			});
			const unrelatedTransport = new StdioTransport({ command: process.execPath, args: [unrelatedFixture] });
			const client = new McpClient({ name: "test", version: "1" });
			const unrelated = new McpClient({ name: "unrelated", version: "1" });
			let group: number | undefined;
			let unrelatedGroup: number | undefined;
			try {
				const connected = client.connect(transport);
				group = transport.pid;
				await connected;
				const unrelatedConnected = unrelated.connect(unrelatedTransport);
				unrelatedGroup = unrelatedTransport.pid;
				await unrelatedConnected;
				const descendant = Number(/descendant (\d+)/.exec(transport.stderr)?.[1]);
				expect(Number.isSafeInteger(descendant)).toBe(true);
				expect(group).toBeTypeOf("number");
				if (exitFirst) {
					await client.notify("exit-leader");
					await expect.poll(() => alive(group as number)).toBe(false);
				}
				// All close callers must wait for the same cleanup, not return on the closed flag.
				const closer = owner === "client" ? client : transport;
				const first = closer.close();
				const second = closer.close();
				await second;
				expect.soft(alive(descendant)).toBe(false);
				await first;
				await expect.poll(() => alive(descendant), { timeout: 500 }).toBe(false);
				await expect.poll(() => alive(-(group as number)), { timeout: 500 }).toBe(false);
				group = undefined;
				await unrelated.ping();
				expect(unrelated.connectionState).toBe("connected");
			} finally {
				// Assertions on a faulty transport must not leave the test's stubborn process behind.
				forceCleanup(group);
				forceCleanup(unrelatedGroup);
				await Promise.allSettled([
					client.close(),
					unrelated.close(),
					transport.close(),
					unrelatedTransport.close(),
				]);
			}
		});
	});
});
