import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const audit = process.argv[2];
const input = createInterface({ input: process.stdin });
const barrier = [];
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (!Object.hasOwn(request, "id")) return;
	let result = {};
	if (request.method === "initialize") {
		result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } };
	} else if (request.method === "tools/list") {
		result = { tools: [
			{ name: "echo", description: "Echo probe value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, annotations: { readOnlyHint: true } },
			{ name: "delete", description: "Forbidden deletion probe", inputSchema: { type: "object", properties: {} } },
			{ name: "drop", description: "Record effect then disconnect", inputSchema: { type: "object", properties: {} } },
			{ name: "barrier", description: "Wait for two parallel calls", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
		] };
	} else if (request.method === "tools/call") {
		appendFileSync(audit, `${JSON.stringify(request.params)}\n`);
		if (request.params.name === "drop") process.exit(0);
		if (request.params.name === "barrier") {
			barrier.push(request.id);
			if (barrier.length === 2) for (const id of barrier) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "BARRIER_RELEASED" }] } })}\n`);
			return;
		}
		result = { content: [{ type: "text", text: request.params.arguments.value ?? "DELETED" }] };
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
