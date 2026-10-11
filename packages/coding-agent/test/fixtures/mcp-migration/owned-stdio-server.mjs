// Local-only MCP fixture. Each instance audits its own process and protocol requests.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [auditPath, server] = process.argv.slice(2);
if (!auditPath || !server) throw new Error("Expected audit path and server name");
const audit = (event, details = {}) => {
	appendFileSync(auditPath, `${JSON.stringify({ event, server, pid: process.pid, ...details })}\n`);
};
audit("start", { cwd: process.cwd(), marker: process.env.MCP_MIGRATION_FIXTURE_MARKER });
process.once("exit", () => audit("exit"));

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
	const message = JSON.parse(line);
	audit("request", { method: message.method, params: message.params });
	if (!("id" in message)) continue;
	let result;
	switch (message.method) {
		case "initialize":
			result = {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: server, version: "1.0.0" },
			};
			break;
		case "tools/list":
			result = {
				tools: [
					{
						name: "echo",
						description: "Echo documentation query",
						inputSchema: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
						},
					},
					{ name: "other", description: "Other undiscovered operation", inputSchema: { type: "object", properties: {} } },
				],
			};
			break;
		case "tools/call":
			result = { content: [{ type: "text", text: `${server}:${process.pid}:${message.params.arguments.query ?? message.params.name}` }] };
			break;
		case "resources/list":
			result = { resources: [{ uri: `${server}://intro`, name: "intro" }] };
			break;
		case "resources/templates/list":
			result = { resourceTemplates: [] };
			break;
		case "resources/read":
			result = { contents: [{ uri: message.params.uri, text: "Local fixture resource" }] };
			break;
		case "ping":
			result = {};
			break;
		default:
			process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown fixture method" } })}\n`);
			continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
