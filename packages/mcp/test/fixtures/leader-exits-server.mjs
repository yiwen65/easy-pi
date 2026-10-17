// The leader exits first; its same-group descendant ignores TERM, with or without inherited pipes.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "descendant") {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
	process.send("ready");
} else {
	const stdio = process.argv[2] === "inherit" ? "inherit" : "ignore";
	const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
		stdio: ["ignore", stdio, stdio, "ipc"],
	});
	await new Promise((resolve) => descendant.once("message", resolve));
	console.error(`descendant ${descendant.pid}`);
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	lines.on("close", () => process.exit(0));
	lines.on("line", (line) => {
		const message = JSON.parse(line);
		if (message.method === "exit-leader") process.exit(0);
		if (message.method !== "initialize") return;
		const result = {
			protocolVersion: "2025-06-18",
			capabilities: {},
			serverInfo: { name: "leader-exits-fixture", version: "1" },
		};
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
	});
}
