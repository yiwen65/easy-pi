import type { SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { attachSession, collectRequests, connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("PiClient", () => {
	test("correlates coalesced out-of-order responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		const attached = client.attachSession("session-1");
		expect(requests).toHaveLength(2);

		const attachRequest = requests.find((request) => request.request.command === "attach");
		const listRequest = requests.find((request) => request.request.command === "list");
		if (!attachRequest || !listRequest) throw new Error("Missing requests");
		server.sendTogether([
			{
				type: "response",
				id: attachRequest.id,
				ok: true,
				result: { command: "attach", session: sessionSnapshot("session-1") },
			},
			{
				type: "response",
				id: listRequest.id,
				ok: true,
				result: { command: "list", sessions: [] },
			},
		]);

		await expect(listed).resolves.toEqual([]);
		await expect(attached).resolves.toMatchObject({ id: "session-1", attached: true });
	});

	test("rejects a mismatched response instead of leaving its request pending", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const listed = client.listSessions();
		expect(requests).toMatchObject([{ request: { command: "list" } }]);
		server.send({
			type: "response",
			id: requests[0]!.id,
			ok: true,
			result: { command: "attach", session: sessionSnapshot("session-1") },
		});

		await expect(listed).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: "Response command attach does not match list",
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test.each(["attach", "detach", "prompt", "steer", "abort", "set_model", "set_thinking"] as const)(
		"rejects a %s response for another session before applying it",
		async (command) => {
			const server = new MemoryByteServer();
			const client = await connectClient(server);
			const other = await attachSession(client, server, sessionSnapshot("other"));
			const snapshots: SessionSnapshot[] = [];
			other.subscribe((snapshot) => snapshots.push(snapshot));
			const target =
				command === "attach" ? undefined : await attachSession(client, server, sessionSnapshot("target"));
			const errors: Error[] = [];
			client.onConnectionStateChange((change) => {
				if (change.error) errors.push(change.error);
			});
			const requests = collectRequests(server);
			const operations = {
				attach: () => client.attachSession("target"),
				detach: () => target!.detach(),
				prompt: () => target!.prompt("go"),
				steer: () => target!.steer("adjust"),
				abort: () => target!.abort(),
				set_model: () => target!.setModel({ provider: "faux", id: "model" }),
				set_thinking: () => target!.setThinking("off"),
			};
			const pending = operations[command]();
			server.send({
				type: "response",
				id: requests[0]!.id,
				ok: true,
				result:
					command === "detach"
						? { command, sessionId: "other" }
						: { command, session: sessionSnapshot("other", { revision: 2 }) },
			});
			try {
				// Lease cleanup becomes a no-op when the protocol failure invalidates all leases.
				if (command === "detach") await pending;
				else await expect(pending).rejects.toMatchObject({ name: "ProtocolValidationError" });
				expect(errors).toEqual([expect.objectContaining({ name: "ProtocolValidationError" })]);
				expect(client.connectionState).toBe("disconnected");
				expect(snapshots).toEqual([]);
			} finally {
				await client.dispose();
			}
		},
	);

	test("surfaces typed request errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests = collectRequests(server);
		const attaching = client.attachSession("locked");
		server.send({
			type: "response",
			id: requests[0]?.id ?? "missing",
			ok: false,
			error: { code: "session_locked", message: "Already attached" },
		});
		await expect(attaching).rejects.toMatchObject({ name: "PiServerError", code: "session_locked" });
	});
});
