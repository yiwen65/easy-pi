import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { CollaborationTurnRecord } from "@easy-pi/subagent/collaboration-contract";
import type { CollaborationSnapshot, StoredCollaborationAgent } from "@easy-pi/subagent/collaboration-store";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { realSubagentConfig } from "./subagent-real-config.ts";

export type CliEvent = Record<string, unknown>;
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("E2E observable condition did not occur before its deadline");
		await new Promise((done) => setTimeout(done, 50));
	}
}

export async function createRealCliFixture() {
	if (process.env.PI_REAL_MODEL_EVAL !== "1") throw new Error("Real CLI requires explicit PI_REAL_MODEL_EVAL=1");
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "epi-contract-e2e-")));
	const agentDir = join(cwd, "agent");
	const config = realSubagentConfig();
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
			subagentModel: `${config.provider}/${config.modelId}`,
			subagentThinkingLevel: config.thinkingLevel,
		}),
		{ mode: 0o600 },
	);
	const processes: Array<{ child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }> }> =
		[];
	const launch = async (sessionFile?: string, extensionPaths: string[] = []) => {
		const args = [
			join(repo, "pi-test.sh"),
			"--mode",
			"rpc",
			"--provider",
			config.provider,
			"--model",
			config.modelId,
			"--thinking",
			config.thinkingLevel,
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--session-dir",
			join(cwd, "root"),
		];
		if (sessionFile) args.push("--session", sessionFile);
		for (const path of extensionPaths) args.push("-e", path);
		const env: NodeJS.ProcessEnv = { ...process.env, EASY_PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_OFFLINE;
		const child = spawn("bash", args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const exited = new Promise<{ code: number | null; signal: string | null }>((done, fail) => {
			child.once("error", fail);
			child.once("exit", (code, signal) => done({ code, signal }));
		});
		processes.push({ child, exited });
		const events: CliEvent[] = [];
		const waiters = new Map<string, (event: CliEvent) => void>();
		let buffer = "";
		let stderrBytes = 0;
		child.stderr!.on("data", (bytes: Buffer) => {
			stderrBytes += bytes.length;
		});
		child.stdout!.on("data", (bytes: Buffer) => {
			buffer += bytes.toString();
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				let event: CliEvent;
				try {
					event = JSON.parse(line) as CliEvent;
				} catch {
					continue;
				}
				events.push(event);
				if (event.type === "response" && typeof event.id === "string") {
					waiters.get(event.id)?.(event);
					waiters.delete(event.id);
				}
			}
		});
		let sequence = 0;
		const command = async (body: CliEvent): Promise<CliEvent> => {
			const id = `request-${++sequence}`;
			const pending = new Promise<CliEvent>((done, fail) => {
				const timer = setTimeout(() => {
					waiters.delete(id);
					fail(new Error(`RPC response deadline; stderr bytes=${stderrBytes}`));
				}, 30_000);
				waiters.set(id, (event) => {
					clearTimeout(timer);
					done(event);
				});
			});
			child.stdin!.write(`${JSON.stringify({ ...body, id })}\n`);
			return pending;
		};
		const response = await command({ type: "get_state" });
		if (response.success !== true) throw new Error("Source CLI did not initialize");
		const state = response.data as {
			sessionId: string;
			sessionFile: string;
			thinkingLevel: string;
			model: { id: string; provider: string };
		};
		if (
			state.thinkingLevel !== config.thinkingLevel ||
			state.model.id !== config.modelId ||
			state.model.provider !== config.provider
		)
			throw new Error("Source CLI did not apply the requested real model and effort");
		const registry = join(agentDir, "teams", state.sessionId, "registry.sqlite");
		function snapshot(): CollaborationSnapshot {
			const db = new DatabaseSync(registry, { readOnly: true });
			try {
				return JSON.parse(
					String(db.prepare("SELECT snapshot FROM team WHERE id=1").get()!.snapshot),
				) as CollaborationSnapshot;
			} finally {
				db.close();
			}
		}
		function turns(): CollaborationTurnRecord[] {
			const db = new DatabaseSync(registry, { readOnly: true });
			try {
				return db
					.prepare("SELECT record FROM turns ORDER BY sequence")
					.all()
					.map((row) => JSON.parse(String(row.record)) as CollaborationTurnRecord);
			} finally {
				db.close();
			}
		}
		async function entries(path: string): Promise<SessionEntry[]> {
			return (await readFile(path, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as SessionEntry);
		}
		const childEntries = (record: StoredCollaborationAgent) => {
			if (!record.sessionFile) throw new Error("Missing durable child history");
			return entries(join(agentDir, "teams", state.sessionId, record.id, record.sessionFile));
		};
		const rootEntries = () => entries(state.sessionFile);
		const prompt = async (message: string) => {
			const offset = events.length;
			const accepted = await command({ type: "prompt", message });
			if (accepted.success !== true) throw new Error("E2E root prompt rejected before acceptance");
			await until(() => events.slice(offset).some((event) => event.type === "agent_settled"), 180_000);
			const emitted = events.slice(offset);
			const ended = emitted
				.filter((event) => event.type === "message_end")
				.map((event) => event.message as { role?: string; stopReason?: string });
			const last = ended.filter((message) => message.role === "assistant").at(-1);
			console.log(
				`[real-cli-phase] terminal=${last?.stopReason ?? "missing"} tools=${
					emitted
						.filter((event) => event.type === "tool_execution_start")
						.map((event) => event.toolName)
						.join(",") || "none"
				}`,
			);
			if (!last || last.stopReason === "error" || last.stopReason === "aborted")
				throw new Error("Root model ended unsuccessfully; no successful task execution is claimed");
			return emitted;
		};
		async function close() {
			child.stdin!.end();
			await until(() => child.exitCode !== null || child.signalCode !== null, 15_000);
			const result = await exited;
			if (result.code !== 0) throw new Error("Source CLI did not exit cleanly");
			const db = new DatabaseSync(registry, { readOnly: true });
			try {
				if (db.prepare("SELECT owner FROM team WHERE id=1").get()!.owner !== null)
					throw new Error("Clean exit retained a team owner");
			} finally {
				db.close();
			}
		}
		async function crash() {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-child.pid!, "SIGKILL");
			await exited;
		}
		return {
			child,
			events,
			state,
			registry,
			command,
			prompt,
			close,
			crash,
			snapshot,
			turns,
			rootEntries,
			childEntries,
		};
	};
	async function cleanup() {
		for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.stdin!.end();
		try {
			await until(
				() => processes.every(({ child }) => child.exitCode !== null || child.signalCode !== null),
				15_000,
			);
		} catch {
			for (const { child } of processes)
				if (child.exitCode === null && child.signalCode === null) {
					try {
						if (process.platform === "win32") child.kill("SIGKILL");
						else process.kill(-child.pid!, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
		}
		await Promise.allSettled(processes.map(({ exited }) => exited));
		await rm(cwd, { recursive: true, force: true });
	}
	return { cwd, agentDir, config, launch, cleanup };
}
