import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	CollaborationError,
	parseCollaborationArguments,
	validateDelegation,
} from "@easy-pi/subagent/collaboration-contract";
import type { CollaborationController } from "@easy-pi/subagent/collaboration-controller";
import type { ChildSessionIdentity } from "@easy-pi/subagent/session-host";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import { buildSessionContext, CURRENT_SESSION_VERSION, type SessionEntry } from "../core/session-manager.ts";

const MAX_PREVIEW = 64 * 1024;
const MAX_HISTORY = 4 * 1024 * 1024;
const OMITTED = "[Earlier preview omitted]\n";
const bound = (text: string) =>
	text.length > MAX_PREVIEW ? OMITTED + text.slice(-(MAX_PREVIEW - OMITTED.length)) : text;

function messageText(message: AgentMessage): string {
	if ("content" in message) {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.map((part) => {
							if (part.type === "text") return part.text;
							if (part.type === "thinking") return `[thinking] ${part.thinking}`;
							if (part.type === "toolCall")
								return `[tool ${part.name}] ${bound(JSON.stringify(part.arguments))}`;
							return "[image omitted]";
						})
						.join("\n");
		return bound(
			`[${message.role}${message.role === "toolResult" ? ` ${message.toolName} ${message.isError ? "error" : "done"}` : ""}]\n${content}`,
		);
	}
	if ("summary" in message) return bound(`[${message.role}] ${message.summary}`);
	if (message.role === "bashExecution") return bound(`[bash] ${message.command}\n${message.output}`);
	return "[unsupported message]";
}

interface RuntimePreview {
	text: string;
	partial: string;
	tools: Map<string, string>;
	phase: string;
}
export interface AgentRuntimeView {
	path: string;
	status: string;
	loaded: boolean;
	model: string;
	sessionFile?: string;
	text: string;
}

/** Bounded, display-only projection. No log text is reinjected into any session. */
export class PiCollaborationMonitor {
	private readonly controller: CollaborationController;
	private readonly root: AgentSession;
	readonly identity: ChildSessionIdentity;
	private readonly previews = new Map<string, RuntimePreview>();
	private readonly listeners = new Set<() => void>();
	private readonly subscriptions = new Set<() => void>();
	private closed = false;
	private children: ReturnType<CollaborationController["list"]>;
	private readonly records = new Map<string, ReturnType<CollaborationController["inspect"]>>();
	get isClosed(): boolean {
		return this.closed;
	}
	constructor(controller: CollaborationController, root: AgentSession) {
		this.controller = controller;
		this.root = root;
		this.identity = { rootSessionId: root.sessionId, agentPath: "/root" };
		this.children = controller.list(this.identity);
		this.subscriptions.add(
			controller.subscribe(() => {
				try {
					this.children = controller.list(this.identity);
				} catch {
					this.dispose();
					return;
				}
				this.records.clear();
				this.changed();
			}),
		);
		this.attach(this.identity, root);
	}
	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* Observation cannot fail execution. */
			}
		}
	}
	subscribe(listener: () => void): () => void {
		if (this.closed) throw new Error("Team monitor closed");
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	attach(identity: Readonly<ChildSessionIdentity>, session: AgentSession): () => void {
		if (this.closed || identity.rootSessionId !== this.identity.rootSessionId) throw new Error("Wrong monitor owner");
		const preview: RuntimePreview = {
			text: bound(session.messages.slice(-100).map(messageText).join("\n\n")),
			partial: "",
			tools: new Map(),
			phase: "idle",
		};
		this.previews.set(identity.agentPath, preview);
		const update = (event: AgentSessionEvent) => {
			switch (event.type) {
				case "message_update":
					preview.partial = messageText(event.message);
					break;
				case "message_end":
					preview.text = bound(`${preview.text}\n\n${messageText(event.message)}`);
					if (event.message.role === "assistant") preview.partial = "";
					if (event.message.role === "toolResult") preview.tools.delete(event.message.toolCallId);
					break;
				case "agent_start":
					preview.phase = "running";
					break;
				case "agent_settled":
					preview.phase = "idle";
					break;
				case "compaction_start":
					preview.phase = "compacting";
					break;
				case "compaction_end":
					preview.phase = event.aborted ? "compaction interrupted" : "running";
					break;
				case "auto_retry_start":
					preview.phase = `retry ${event.attempt}`;
					break;
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end": {
					const value =
						event.type === "tool_execution_update"
							? event.partialResult
							: event.type === "tool_execution_end"
								? event.result
								: event.args;
					const state = event.type === "tool_execution_end" ? (event.isError ? "error" : "done") : "running";
					preview.tools.set(
						event.toolCallId,
						`[tool ${event.toolName} ${state}] ${bound(JSON.stringify(value) ?? "")}`,
					);
					// Native tool batches are bounded separately; don't retain unlimited display rows.
					if (preview.tools.size > 32) preview.tools.delete(preview.tools.keys().next().value!);
					break;
				}
				default:
					return;
			}
			this.changed();
		};
		const unsubscribe = session.subscribe((event) => {
			try {
				update(event);
			} catch {
				preview.phase = "preview unavailable";
				this.changed();
			}
		});
		let detached = false;
		const detach = () => {
			if (detached) return;
			detached = true;
			unsubscribe();
			preview.phase = "unloaded";
			preview.tools.clear();
			this.subscriptions.delete(detach);
			this.changed();
		};
		this.subscriptions.add(detach);
		this.changed();
		return detach;
	}
	list() {
		if (this.closed) throw new Error("Team monitor closed");
		return [
			{ task_name: "/root", status: this.root.isStreaming ? "running" : "idle", loaded: true },
			...this.children.map((child) => ({ ...child })),
		];
	}
	view(path: string): AgentRuntimeView {
		const row = this.list().find((item) => item.task_name === path);
		if (!row) throw new Error("Unknown agent");
		if (path !== "/root" && !this.records.has(path))
			this.records.set(path, this.controller.inspect(this.identity, path));
		const record = this.records.get(path);
		const preview = this.previews.get(path);
		return {
			path,
			status: `${row.status}${preview ? ` / ${preview.phase}` : ""}`,
			loaded: row.loaded,
			model: record
				? `${record.model.provider}/${record.model.id} (${record.model.thinkingLevel})`
				: `${this.root.model?.provider ?? "?"}/${this.root.model?.id ?? "?"} (${this.root.thinkingLevel})`,
			sessionFile: record?.sessionPath ?? (path === "/root" ? this.root.sessionFile : undefined),
			text: preview
				? bound([preview.text, preview.partial, ...preview.tools.values()].filter(Boolean).join("\n\n"))
				: (record?.result ?? "No runtime preview. Open retained history to inspect."),
		};
	}
	/** Cold history inspection is read-only and size bounded; never creates a native session. */
	async readHistory(path: string): Promise<void> {
		if (path === "/root" || this.previews.has(path)) return;
		const record = this.controller.inspect(this.identity, path);
		if (!record.sessionPath) return;
		const directory = await lstat(dirname(record.sessionPath));
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe history directory");
		const file = await open(record.sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		let text: string;
		try {
			const metadata = await file.stat();
			if (!metadata.isFile() || metadata.size > MAX_HISTORY)
				throw new Error("History exceeds the 4 MiB viewer limit; inspect the session file separately");
			const buffer = Buffer.alloc(metadata.size + 1);
			let bytes = 0;
			while (bytes < buffer.length) {
				const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
				if (!result.bytesRead) break;
				bytes += result.bytesRead;
			}
			if (bytes !== metadata.size) throw new Error("History changed during inspection");
			text = buffer.subarray(0, bytes).toString("utf8");
		} finally {
			await file.close();
		}
		const entries = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const header = entries.shift();
		const identities = entries.filter(
			(entry) => entry.type === "custom" && entry.customType === "epi-collaboration-identity",
		);
		if (
			header?.type !== "session" ||
			header.version !== CURRENT_SESSION_VERSION ||
			identities.length !== 1 ||
			identities[0].data?.rootSessionId !== this.identity.rootSessionId ||
			identities[0].data?.agentPath !== path
		)
			throw new Error("History identity mismatch");
		// The native parser's effective branch/checkpoint semantics, without open()/migration/appends.
		const messages = buildSessionContext(entries as SessionEntry[]).messages;
		if (this.closed || this.previews.has(path)) return; // A newer live attachment wins the race.
		this.previews.set(path, {
			text: bound(messages.slice(-100).map(messageText).join("\n\n")),
			partial: "",
			tools: new Map(),
			phase: "retained history",
		});
		this.changed();
	}
	async act(
		path: string,
		action: "send" | "followup" | "interrupt",
		text = "",
		signal?: AbortSignal,
	): Promise<string> {
		if (this.closed || path === "/root") throw new Error("Use the main editor to control root");
		const tool = { send: "send_message", followup: "followup_task", interrupt: "interrupt_agent" }[action];
		if (!this.root.getActiveToolNames().includes(tool))
			throw new CollaborationError("forbidden", "This collaboration operation is disabled in the root session");
		if (signal?.aborted) throw new CollaborationError("interrupted", "Operator action cancelled before admission");
		if (action === "send")
			return `Message accepted: ${await this.controller.send(this.identity, path, text, signal)} (not necessarily consumed)`;
		if (action === "followup") {
			const record = this.controller.inspect(this.identity, path);
			if (["pending", "running", "closed"].includes(record.status))
				throw new CollaborationError("busy", "Child is not idle");
			let input: unknown;
			try {
				input = JSON.parse(text);
			} catch {
				throw new CollaborationError(
					"invalid_arguments",
					"Paste followup_task JSON with task, context=existing and capabilities",
					"invalid_followup",
				);
			}
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new CollaborationError("invalid_arguments", "Expected a task contract object", "invalid_followup");
			const args = parseCollaborationArguments("followup_task", { ...input, target: path });
			const delegation = validateDelegation({
				version: 1,
				task: args.task,
				capabilities: args.capabilities,
				context: record.delegation?.context ?? { mode: "fork", turns: "all", prefix: "rebuild" },
			});
			const available = this.root
				.getActiveToolNames()
				.filter((name) => this.controller.toolAllowed({ ...this.identity, agentPath: path }, name));
			const tools = args.capabilities.tools === "inherit" ? available : args.capabilities.tools;
			if (tools.some((name) => !available.includes(name)))
				throw new CollaborationError("forbidden", "Follow-up cannot expand delegated tools", "tools_unavailable");
			return `Task accepted: ${await this.controller.followup(this.identity, path, args.task.objective, signal, { delegation, tools })}`;
		}
		return `Interrupt finished; previous status: ${await this.controller.interrupt(this.identity, path)}`;
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const unsubscribe of [...this.subscriptions]) unsubscribe();
		this.subscriptions.clear();
		this.changed();
		this.listeners.clear();
		this.previews.clear();
		this.records.clear();
		this.children = [];
	}
}
