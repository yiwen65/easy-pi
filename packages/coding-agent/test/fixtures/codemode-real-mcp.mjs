import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Isolated, deterministic stdio fixture; never reads credentials or accesses a network.
const auditPath = process.argv[2];
const tools = [{
	name: "lookup_rate",
	description: "Look up the exchange rate for the fictional currency ZED; returns rate 7.",
	inputSchema: { type: "object", properties: { currency: { type: "string", enum: ["ZED"] } }, required: ["currency"] },
	annotations: { readOnlyHint: true, idempotentHint: true },
}];
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	let result = {};
	if (request.method === "initialize") {
		result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "rates", version: "1" } };
	} else if (request.method === "tools/list") {
		result = { tools };
	} else if (request.method === "tools/call") {
		appendFileSync(auditPath, `${JSON.stringify(request.params)}\n`);
		const valid = request.params?.name === "lookup_rate" && request.params?.arguments?.currency === "ZED";
		result = valid
			? { content: [{ type: "text", text: "ZED rate: 7" }], structuredContent: { currency: "ZED", rate: 7 } }
			: { content: [{ type: "text", text: "Invalid rate request" }], isError: true };
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
