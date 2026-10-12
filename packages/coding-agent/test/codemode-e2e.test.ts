import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
interface RequestPayload {
	tools?: { function: { name: string } }[];
	messages: { role: string; content?: string | { type: string; text?: string }[] }[];
}
interface RpcEvent {
	type: string;
	id?: string;
	success?: boolean;
	toolName?: string;
	toolCallId?: string;
	parentToolCallId?: string;
	isError?: boolean;
	data?: { sessionFile?: string; messages?: { role: string; toolName?: string; content?: { text?: string }[] }[] };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	const errors: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) throw new AggregateError(errors, "E2E cleanup failed");
});

async function setup(settings: Record<string, unknown> = {}, mcp = false) {
	const root = mkdtempSync(join(tmpdir(), "epi-codemode-e2e-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
	const requests: RequestPayload[] = [];
	let callId = 0;
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const payload = JSON.parse(body) as RequestPayload;
		requests.push(payload);
		const messageText = (message: RequestPayload["messages"][number]) =>
			typeof message.content === "string"
				? message.content
				: (message.content?.map((block) => block.text ?? "").join("\n") ?? "");
		const scriptIndex = payload.messages.findLastIndex(
			(message) => message.role === "user" && messageText(message).startsWith("CODEMODE_SCRIPT:\n"),
		);
		const scriptMessage = payload.messages[scriptIndex];
		const code =
			scriptMessage && !payload.messages.slice(scriptIndex + 1).some((message) => message.role === "tool")
				? messageText(scriptMessage).slice("CODEMODE_SCRIPT:\n".length)
				: undefined;
		const run = code && payload.tools?.some((tool) => tool.function.name === "codemode");
		response.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = run
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `script-${++callId}`,
							type: "function",
							function: { name: "codemode", arguments: JSON.stringify({ code }) },
						},
					],
				}
			: { role: "assistant", content: "done" };
		response.write(
			`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
		);
		response.end(
			`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: run ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local server address");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"codemode-fixture": {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					apiKey: "local-placeholder",
					models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
			hfCompaction: { mode: "off" },
			...settings,
		}),
	);
	const audit = join(root, "mcp-audit.jsonl");
	if (mcp)
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					probe: {
						command: process.execPath,
						args: [join(repo, "packages/coding-agent/test/fixtures/codemode-e2e-mcp.mjs"), audit],
						exposure: "deferred",
					},
				},
			}),
		);
	async function launch(extra: string[] = [], sessionFile?: string) {
		const child = spawn(
			"bash",
			[
				join(repo, "pi-test.sh"),
				"--no-env",
				"--mode",
				"rpc",
				"--provider",
				"codemode-fixture",
				"--model",
				"fixture",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--no-prompt-templates",
				"--session-dir",
				join(root, "sessions"),
				...(sessionFile ? ["--session", sessionFile] : []),
				...extra,
			],
			{
				cwd: root,
				env: { PATH: process.env.PATH, HOME: root, EASY_PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			},
		);
		const events: RpcEvent[] = [];
		let output = "";
		let stdoutBytes = 0;
		function killGroup() {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else child.kill("SIGKILL");
		}
		let stderr = "";
		let sequence = 0;
		let inputError: Error | undefined;
		child.once("error", (error) => {
			inputError = error;
		});
		child.stderr.setEncoding("utf8");
		child.stdout.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-16000);
		});
		child.stdout.on("data", (chunk: string) => {
			if (inputError) return;
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > 16 * 1024 * 1024 || events.length >= 10000) {
				inputError = new Error("CLI output limit exceeded");
				output = "";
				killGroup();
				return;
			}
			output += chunk;
			for (;;) {
				const end = output.indexOf("\n");
				if (end < 0) break;
				const line = output.slice(0, end);
				output = output.slice(end + 1);
				if (line === "Running without API keys...") continue;
				try {
					events.push(JSON.parse(line) as RpcEvent);
				} catch {
					inputError = new Error(`Malformed RPC line: ${line.slice(0, 200)}`);
					killGroup();
					return;
				}
			}
		});
		let exited = false;
		const exit = new Promise<void>((done) =>
			child.once("close", () => {
				exited = true;
				done();
			}),
		);
		async function wait(predicate: () => boolean) {
			const deadline = Date.now() + 25000;
			while (!predicate()) {
				if (inputError) throw inputError;
				if (exited || Date.now() > deadline)
					throw new Error(`CLI wait failed: ${stderr}; events=${JSON.stringify(events.slice(-3))}`);
				await new Promise((done) => setTimeout(done, 10));
			}
			if (inputError) throw inputError;
		}
		async function request(command: Record<string, unknown>) {
			const id = `rpc-${++sequence}`;
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
			await wait(() => events.some((event) => event.type === "response" && event.id === id));
			return events.find((event) => event.type === "response" && event.id === id)!;
		}
		async function close() {
			if (!exited) {
				child.stdin.end();
				const timer = setTimeout(killGroup, 5000);
				await exit;
				clearTimeout(timer);
			}
		}
		cleanups.push(close);
		const state = await request({ type: "get_state" });
		expect(state.success).toBe(true);
		async function script(code: string) {
			const offset = events.length;
			expect((await request({ type: "prompt", message: `CODEMODE_SCRIPT:\n${code}` })).success).toBe(true);
			await wait(() => events.slice(offset).some((event) => event.type === "agent_settled"));
			return events.slice(offset);
		}
		return { events, request, script, close, wait, sessionFile: state.data?.sessionFile };
	}
	return { root, requests, launch, audit };
}

function declarations(request: RequestPayload) {
	return request.tools?.map((tool) => tool.function.name) ?? [];
}

describe("codemode source CLI E2E (offline)", () => {
	it.each([
		{ label: "default", settings: {}, flags: [], enabled: true },
		{ label: "exclude", settings: {}, flags: ["--exclude-tools", "codemode"], enabled: false },
		{ label: "defaultTools omission", settings: { defaultTools: ["read", "write"] }, flags: [], enabled: false },
	])("honors $label startup activation", async ({ settings, flags, enabled }) => {
		const f = await setup(settings);
		const cli = await f.launch(flags);
		const events = await cli.script('return "activation-probe";');
		expect(declarations(f.requests[0]).includes("codemode")).toBe(enabled);
		expect(events.some((event) => event.type === "tool_execution_start" && event.toolName === "codemode")).toBe(
			enabled,
		);
	});

	it.each(["on", "only"])(
		"orchestrates real read/filter/write with %s declarations and parent-only transcript",
		async (mode) => {
			const f = await setup({ codemode: { mode } });
			writeFileSync(join(f.root, "input.txt"), "keep:3\ndrop:9\nkeep:7\n");
			const cli = await f.launch(["--tools", "codemode,read,write"]);
			const events = await cli.script(
				'const input = await tools.read({path:"input.txt"}); const total = input.split("\\n").filter(x=>x.startsWith("keep:")).reduce((sum,x)=>sum+Number(x.split(":")[1]),0); await tools.write({path:"summary.json",content:JSON.stringify({total})}); return {total};',
			);
			expect(JSON.parse(readFileSync(join(f.root, "summary.json"), "utf8"))).toEqual({ total: 10 });
			expect(declarations(f.requests[0]).includes("read")).toBe(mode === "on");
			expect(declarations(f.requests[0]).includes("write")).toBe(mode === "on");
			const parent = events.find((event) => event.type === "tool_execution_start" && event.toolName === "codemode")!;
			for (const name of ["read", "write"])
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "tool_execution_start",
						toolName: name,
						parentToolCallId: parent.toolCallId,
					}),
				);
			const messages = (await cli.request({ type: "get_messages" })).data?.messages;
			expect(
				messages?.filter((message) => message.role === "toolResult").map((message) => message.toolName),
			).toEqual(["codemode"]);
			expect(f.requests[1].messages.filter((message) => message.role === "tool")).toHaveLength(1);
		},
	);

	it("does not discover or execute write outside codemode+read grants", async () => {
		const f = await setup();
		const cli = await f.launch(["--tools", "codemode,read"]);
		await cli.script(
			'text({listed:ALL_TOOLS.some(t=>t.name==="write"),described:!!(await describeTool("write"))}); try {await tools.write({path:"forbidden",content:"bad"})} catch(e) {text("DENIED")}',
		);
		expect(existsSync(join(f.root, "forbidden"))).toBe(false);
		expect(cli.events.some((event) => event.toolName === "write")).toBe(false);
		const messages = (await cli.request({ type: "get_messages" })).data?.messages;
		const text = messages
			?.find((message) => message.role === "toolResult")
			?.content?.map((block) => block.text)
			.join("\n");
		expect(text).toContain('"listed":false');
		expect(text).toContain('"described":false');
		expect(text).toContain("DENIED");
	});

	it("commits successful store across process resume but discards failed scripts", async () => {
		const f = await setup();
		const first = await f.launch(["--tools", "codemode"]);
		await first.script('store("cursor",17); return load("cursor");');
		await first.script('store("cursor",99); throw Error("intentional failure");');
		expect(first.events).toContainEqual(
			expect.objectContaining({ type: "tool_execution_end", toolName: "codemode", isError: true }),
		);
		const file = first.sessionFile;
		expect(file).toBeTruthy();
		await first.close();
		const second = await f.launch(["--tools", "codemode"], file);
		await second.script('return {cursor:load("cursor")};');
		const messages = (await second.request({ type: "get_messages" })).data?.messages;
		expect(
			messages
				?.filter((message) => message.role === "toolResult")
				.at(-1)
				?.content?.map((block) => block.text)
				.join("\n"),
		).toContain('"cursor":17');
		const entries = readFileSync(file!, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { customType?: string });
		expect(entries.filter((entry) => entry.customType === "codemode-store")).toHaveLength(1);
	});

	it("runs independent nested MCP calls concurrently through a two-call barrier", async () => {
		const f = await setup({}, true);
		const cli = await f.launch(["--tools", "codemode,mcp__probe__barrier"]);
		await cli.script(
			'// @options: {"timeout_ms":5000}\nawait searchTools("parallel barrier"); const results=await Promise.allSettled([tools.mcp__probe__barrier({}),tools.mcp__probe__barrier({})]); text(results);',
		);
		const messages = (await cli.request({ type: "get_messages" })).data?.messages;
		const text = messages
			?.find((message) => message.role === "toolResult")
			?.content?.map((block) => block.text)
			.join("\n");
		expect(text?.match(/BARRIER_RELEASED/g)).toHaveLength(2);
		expect(text?.match(/fulfilled/g)).toHaveLength(2);
		expect(readFileSync(f.audit, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
	});

	it("does not commit store when RPC abort cancels an in-flight nested MCP call", async () => {
		const f = await setup({}, true);
		const cli = await f.launch(["--tools", "codemode,mcp__probe__barrier"]);
		const running = cli.script(
			'await searchTools("parallel barrier"); store("cancelled",true); await tools.mcp__probe__barrier({}); return "unreachable";',
		);
		await cli.wait(() =>
			cli.events.some((event) => event.type === "tool_execution_start" && event.toolName === "mcp__probe__barrier"),
		);
		expect((await cli.request({ type: "abort" })).success).toBe(true);
		await running;
		await cli.close();
		expect(readFileSync(cli.sessionFile!, "utf8")).not.toContain('"customType":"codemode-store"');
		expect(readFileSync(f.audit, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
		expect(cli.events).toContainEqual(
			expect.objectContaining({ type: "tool_execution_end", toolName: "codemode", isError: true }),
		);
	});

	it("does not commit store or replay a disconnected MCP effect after process resume", async () => {
		const f = await setup({}, true);
		const flags = ["--tools", "codemode,mcp__probe__drop"];
		const first = await f.launch(flags);
		await first.script(
			'await searchTools("disconnect"); try {await tools.mcp__probe__drop({})} catch(e) {text("caught")} store("unsafe",true); return "caught is not success";',
		);
		expect(first.events).toContainEqual(
			expect.objectContaining({ type: "tool_execution_end", toolName: "codemode", isError: true }),
		);
		const messages = (await first.request({ type: "get_messages" })).data?.messages;
		const resultText = messages
			?.filter((message) => message.role === "toolResult")
			.at(-1)
			?.content?.map((block) => block.text)
			.join("\n");
		expect(resultText).toMatch(/unknown outcome|outcome is unknown/i);
		const file = first.sessionFile!;
		await first.close();
		expect(readFileSync(file, "utf8")).not.toContain('"customType":"codemode-store"');
		const before = readFileSync(f.audit, "utf8");
		expect(before.split("\n").filter(Boolean)).toHaveLength(1);
		const second = await f.launch(flags, file);
		expect((await second.request({ type: "get_messages" })).success).toBe(true);
		await second.close();
		expect(readFileSync(f.audit, "utf8")).toBe(before);
		expect(second.events.some((event) => event.type === "tool_execution_start")).toBe(false);
	});

	it("discovers deferred MCP schema without provider declaration and audits denied calls", async () => {
		const f = await setup({}, true);
		const cli = await f.launch(["--tools", "codemode,mcp__probe__*", "--exclude-tools", "mcp__probe__delete"]);
		await cli.script(
			'const matches=await searchTools("echo probe"); const name=matches.find(t=>t.name==="mcp__probe__echo").name; text(await describeTool(name)); text(await tools[name]({value:"HELLO"})); text({denied:!!(await describeTool("mcp__probe__delete"))}); try {await tools.mcp__probe__delete({})} catch(e){text("DENIED")}',
		);
		expect(declarations(f.requests[0])).not.toContain("mcp__probe__echo");
		const calls = readFileSync(f.audit, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { name: string });
		expect(calls.map((call) => call.name)).toEqual(["echo"]);
		const messages = (await cli.request({ type: "get_messages" })).data?.messages;
		const text = messages
			?.find((message) => message.role === "toolResult")
			?.content?.map((block) => block.text)
			.join("\n");
		expect(text).toContain("HELLO");
		expect(text).toContain('"denied":false');
		expect(text).toContain("DENIED");
	});
});
