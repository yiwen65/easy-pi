/** Manual real-model acceptance of the same source CLI entry used by AgentPort. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const RUN = process.env.PI_REAL_MODEL_EVAL === "1";
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
type Event = {
	type: string;
	id?: string;
	success?: boolean;
	command?: string;
	data?: Record<string, unknown>;
	toolName?: string;
	isError?: boolean;
	message?: { role?: string; stopReason?: string };
};

test.skipIf(!RUN)(
	"source CLI uses a real model to delegate, query, close and cleanly resume its retained team",
	async () => {
		const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-cli-real-")));
		const agentDir = join(cwd, "agent");
		await mkdir(agentDir);
		const source = process.env.PI_AGENT_DIR ?? join(homedir(), ".epi", "agent");
		await symlink(join(source, "auth.json"), join(agentDir, "auth.json"));
		await symlink(join(source, "models.json"), join(agentDir, "models.json"));
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				transport: "sse",
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			{ mode: 0o600 },
		);
		const provider = process.env.PI_REAL_SUBAGENT_PROVIDER ?? "openai-codex";
		const model = process.env.PI_REAL_SUBAGENT_MODEL ?? "gpt-6-astra";
		const children: ReturnType<typeof spawn>[] = [];
		const exits: Promise<number | null>[] = [];
		function launch(sessionFile?: string) {
			const args = [
				join(repo, "pi-test.sh"),
				"--mode",
				"rpc",
				"--provider",
				provider,
				"--model",
				model,
				"--thinking",
				"low",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--no-prompt-templates",
				"--session-dir",
				join(cwd, "root"),
			];
			if (sessionFile) args.push("--session", sessionFile);
			const env: NodeJS.ProcessEnv = { ...process.env, EASY_PI_CODING_AGENT_DIR: agentDir };
			delete env.PI_OFFLINE;
			const child = spawn("bash", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const events: Event[] = [];
			const waiters = new Map<string, (value: Event) => void>();
			let buffer = "";
			let stderrBytes = 0;
			child.stderr!.on("data", (data: Buffer) => {
				stderrBytes += data.length;
			});
			child.stdout!.on("data", (data: Buffer) => {
				buffer += data.toString();
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) break;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					let event: Event;
					try {
						event = JSON.parse(line) as Event;
					} catch {
						continue;
					}
					events.push(event);
					if (event.type === "response" && event.id) {
						waiters.get(event.id)?.(event);
						waiters.delete(event.id);
					}
				}
			});
			const exited = new Promise<number | null>((done, fail) => {
				child.once("error", fail);
				child.once("exit", (code, signal) => {
					if (signal) fail(new Error(`CLI terminated by signal ${signal}`));
					else done(code);
				});
			});
			exits.push(exited);
			let sequence = 0;
			async function request(command: Record<string, unknown>) {
				const id = `req-${++sequence}`;
				const response = new Promise<Event>((done, fail) => {
					const timer = setTimeout(() => {
						waiters.delete(id);
						fail(new Error(`CLI RPC timeout; stderr bytes=${stderrBytes}`));
					}, 30_000);
					waiters.set(id, (event) => {
						clearTimeout(timer);
						done(event);
					});
				});
				child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
				return response;
			}
			async function settled() {
				const deadline = Date.now() + 180_000;
				while (!events.some((event) => event.type === "agent_settled")) {
					if (Date.now() > deadline) throw new Error("CLI root did not settle");
					await new Promise((done) => setTimeout(done, 50));
				}
			}
			async function close() {
				child.stdin!.end();
				const code = await Promise.race([
					exited,
					new Promise<never>((_done, fail) => {
						const timer = setTimeout(() => fail(new Error("CLI cleanup did not exit")), 15_000);
						timer.unref();
					}),
				]);
				expect(code).toBe(0);
			}
			return { child, events, request, settled, close };
		}
		try {
			const first = launch();
			const state = await first.request({ type: "get_state" });
			expect(state.success).toBe(true);
			const sessionId = String(state.data?.sessionId);
			const sessionFile = String(state.data?.sessionFile);
			const result = await first.request({
				type: "prompt",
				message:
					'Execute only this probe in order: spawn_agent {"task_name":"cli-worker","task":{"objective":"Call deliver_result with summary CLI_READY and outcome succeeded. Do nothing else."},"relationship":"verify","context":"isolated","tools":[]}; wait_agent {"target":"cli-worker","timeout_ms":60000}; get_agent_result {"target":"cli-worker"}; close_agent {"target":"cli-worker"}; list_agents {}; then give a brief final confirmation. Do not use other tools.',
			});
			expect(result.success).toBe(true);
			await first.settled();
			const names = first.events
				.filter((event) => event.type === "tool_execution_start")
				.map((event) => event.toolName);
			expect(names).toEqual(
				expect.arrayContaining(["spawn_agent", "wait_agent", "get_agent_result", "close_agent", "list_agents"]),
			);
			expect(first.events.filter((event) => event.type === "tool_execution_end" && event.isError)).toEqual([]);
			await first.close();
			const registry = join(agentDir, "teams", sessionId, "registry.sqlite");
			const db = new DatabaseSync(registry, { readOnly: true });
			try {
				const row = db.prepare("SELECT owner, snapshot FROM team WHERE id=1").get()!;
				expect(row.owner).toBeNull();
				const snapshot = JSON.parse(String(row.snapshot)) as { agents: Array<{ status: string; result: string }> };
				expect(snapshot.agents[0].status).toBe("closed");
				expect(snapshot.agents[0].result).toContain("CLI_READY");
			} finally {
				db.close();
			}
			const second = launch(sessionFile);
			expect((await second.request({ type: "get_state" })).success).toBe(true);
			await second.request({ type: "prompt", message: "/agents" });
			expect(
				second.events.filter((event) => event.type === "message_start" && event.message?.role === "assistant"),
			).toEqual([]);
			await second.close();
			console.log(
				"[real-cli] source RPC root/child/wait/query/close and zero-inference resume passed: " +
					provider +
					"/" +
					model,
			);
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await Promise.allSettled(exits);
			await rm(cwd, { recursive: true, force: true });
		}
	},
	240_000,
);
