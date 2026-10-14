import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const executeFile = promisify(execFile);
const ref = z.string().regex(/^@[A-Za-z0-9_-]+:e\d+$/, "Use a qualified ref from this server's snapshot");
const app = z.string().min(1).max(512);
export const schemas = {
	status: z.strictObject({}),
	"list-apps": z.strictObject({ app: app.optional() }),
	snapshot: z.strictObject({
		app,
		window_id: z.string().min(1).optional(),
		max_depth: z.number().int().min(1).max(50).default(10),
		interactive_only: z.boolean().default(true),
		compact: z.boolean().default(true),
		skeleton: z.boolean().default(false),
		surface: z.enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"]).optional(),
		root: ref.optional(),
	}).refine((args) => !(args.root && args.surface), "root and surface cannot be combined"),
	click: z.strictObject({ ref_id: ref }),
	type: z.strictObject({
		ref_id: ref,
		text: z.string().max(65536).refine((text) => Buffer.byteLength(text) <= 65536, "Text exceeds 64 KiB"),
	}),
	press: z.strictObject({ combo: z.string().min(1).max(128).regex(/^[A-Za-z0-9+_-]+$/), app }),
};
const batchSchema = z.strictObject({
	actions: z.array(z.discriminatedUnion("command", Object.entries(schemas).map(([command, args]) =>
		z.strictObject({ command: z.literal(command), args }),
	))).min(1).max(64),
	headed: z.boolean().default(false),
}).refine((args) => Buffer.byteLength(JSON.stringify(args.actions)) <= 65536, "Batch exceeds 64 KiB; split it into smaller batches");

export function commandArgs(command, args) {
	if (command === "click") return [command, args.ref_id];
	// The positional separator keeps user text beginning with '-' from becoming a CLI option.
	if (command === "type") return [command, "--", args.ref_id, args.text];
	if (command === "press") return [command, "--app", args.app, "--", args.combo];
	const argv = [command];
	for (const [key, value] of Object.entries(args)) {
		const flag = `--${key.replaceAll("_", "-")}`;
		if (value === true) argv.push(flag);
		else if (value !== false && value !== undefined) argv.push(flag, String(value));
	}
	return argv;
}

export function resultFromOutput(stdout, failed = false) {
	const payload = JSON.parse(stdout);
	if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.ok !== "boolean") {
		throw new Error("CLI returned an invalid JSON envelope");
	}
	const isError = failed || !payload.ok || payload.data?.results?.some((entry) => !entry.ok) || false;
	return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}

export function createServer({
	binary = process.env.AGENT_DESKTOP_BIN || "agent-desktop",
	session = `epi-mcp-${randomUUID()}`,
	execute = executeFile,
} = {}) {
	const server = new McpServer({ name: "agent-desktop", version: "0.1.0" });
	let queue = Promise.resolve();
	function run(argv) {
		const pending = queue.then(async () => {
			try {
				const { stdout } = await execute(binary, ["--session", session, ...argv], {
					timeout: 45000,
					maxBuffer: 8 * 1024 * 1024,
					shell: false,
				});
				return resultFromOutput(stdout);
			} catch (error) {
				// A killed process may have already changed the desktop: never retry automatically.
				if (!error.killed && typeof error.code === "number" && error.stdout) {
					try { return resultFromOutput(error.stdout, true); } catch { /* Report malformed output below. */ }
				}
				return {
					isError: true,
					content: [{ type: "text", text: `agent-desktop execution failed: ${error.message}. Desktop effects may be unknown; observe before retrying.` }],
				};
			}
		});
		queue = pending.then(() => undefined, () => undefined);
		return pending;
	}
	const descriptions = {
		status: "Read desktop health and permissions without prompting.",
		"list-apps": "List running GUI applications.",
		snapshot: "Observe an app accessibility tree. Keep qualified refs; re-observe after changes. Dense apps can use skeleton then root drill-down.",
		click: "Click a qualified snapshot ref. Observe the result before continuing or retrying.",
		type: "Insert text into a qualified snapshot ref. This is not proof of document-level commit.",
		press: "Send a key combo to the explicitly named app (may change focus). No force override. Confirm sensitive actions with the user first.",
	};
	for (const [command, schema] of Object.entries(schemas)) {
		const readOnly = ["status", "list-apps", "snapshot"].includes(command);
		const inputSchema = readOnly || command === "press" ? schema : schema.extend({ headed: z.boolean().default(false) });
		server.registerTool(`desktop_${command.replaceAll("-", "_")}`, {
			description: descriptions[command],
			inputSchema,
			annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
		}, async ({ headed, ...args }) => run([...(headed ? ["--headed"] : []), ...commandArgs(command, args)]));
	}
	server.registerTool("desktop_batch", {
		description: "Execute up to 64 allowed commands sequentially in one CLI process. Non-atomic; stops on the first error. Inspect partial results; never replay a whole batch blindly. All refs must come from this server. No session overrides or arbitrary commands.",
		inputSchema: batchSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, async ({ actions, headed }) => run([
		...(headed ? ["--headed"] : []), "batch", "--stop-on-error", "--timeout-ms", "40000", JSON.stringify(actions),
	]));
	return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await createServer().connect(new StdioServerTransport());
}
