import { createHash } from "node:crypto";

export const LIVE_ACTIVITY_LIMITS = {
	thinkingChars: 4_000,
	textChars: 4_000,
	toolCallIdChars: 128,
	toolNameChars: 128,
	toolArgsChars: 1_000,
	toolOutputChars: 2_000,
	recentTools: 8,
} as const;

export type LiveToolStatus = "pending" | "running" | "success" | "error";

export interface LiveToolActivity {
	toolCallId: string;
	toolName: string;
	args: string;
	output: string;
	status: LiveToolStatus;
}

/** Presentation-only child activity. It must never be written to the durable ledger. */
export interface LiveActivity {
	thinking: string;
	text: string;
	tools: LiveToolActivity[];
}

export function createLiveActivity(): LiveActivity {
	return { thinking: "", text: "", tools: [] };
}

export function snapshotLiveActivity(activity: LiveActivity): LiveActivity {
	return { ...activity, tools: activity.tools.map((tool) => ({ ...tool })) };
}

/** Coalesce token-frequency activity into one trailing update per interval. */
export class LiveActivityUpdateScheduler {
	private readonly callback: () => void;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	private disposed = false;

	constructor(callback: () => void, intervalMs = 100) {
		this.callback = callback;
		this.intervalMs = intervalMs;
	}

	schedule(): void {
		if (this.disposed) return;
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.emitIfDirty();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	flush(): void {
		if (this.disposed) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.emitIfDirty();
	}

	dispose(flush = false): void {
		if (flush) this.flush();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.dirty = false;
		this.disposed = true;
	}

	private emitIfDirty(): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.callback();
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tail(value: string, limit: number): string {
	return value.length <= limit ? value : value.slice(-limit);
}

function head(value: string, limit: number): string {
	return value.length <= limit ? value : value.slice(0, limit);
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function boundedToolCallId(value: string): string {
	if (value.length <= LIVE_ACTIVITY_LIMITS.toolCallIdChars) return value;
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedToolName(value: string): string {
	return head(value, LIVE_ACTIVITY_LIMITS.toolNameChars);
}

function boundedToolArgs(value: unknown): string {
	return head(stringify(value), LIVE_ACTIVITY_LIMITS.toolArgsChars);
}

function resultOutput(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (!isRecord(value) || !Array.isArray(value.content)) {
		return tail(stringify(value), LIVE_ACTIVITY_LIMITS.toolOutputChars);
	}
	const text: string[] = [];
	for (const part of value.content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text.push(part.text);
	}
	return tail(text.length > 0 ? text.join("\n") : stringify(value.content), LIVE_ACTIVITY_LIMITS.toolOutputChars);
}

function upsertTool(activity: LiveActivity, next: LiveToolActivity): LiveActivity {
	const tools = [...activity.tools];
	const index = tools.findIndex((tool) => tool.toolCallId === next.toolCallId);
	if (index === -1) tools.push(next);
	else tools[index] = next;
	return { ...activity, tools: tools.slice(-LIVE_ACTIVITY_LIMITS.recentTools) };
}

function assistantContent(message: unknown): { thinking: string; text: string } | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const thinking: string[] = [];
	const text: string[] = [];
	for (const part of message.content) {
		if (!isRecord(part)) continue;
		if (part.type === "thinking" && typeof part.thinking === "string") thinking.push(part.thinking);
		else if (part.type === "text" && typeof part.text === "string") text.push(part.text);
	}
	return {
		thinking: tail(thinking.join("\n"), LIVE_ACTIVITY_LIMITS.thinkingChars),
		text: tail(text.join("\n"), LIVE_ACTIVITY_LIMITS.textChars),
	};
}

/** Purely reduce one full RPC event into bounded, ephemeral presentation state. */
export function reduceLiveActivity(activity: LiveActivity, event: Readonly<Record<string, unknown>>): LiveActivity {
	if (event.type === "message_start" || event.type === "message_end") {
		const content = assistantContent(event.message);
		if (!content) return activity;
		let next = { ...activity, ...content };
		if (event.type === "message_end" && isRecord(event.message) && Array.isArray(event.message.content)) {
			for (const part of event.message.content) {
				if (
					!isRecord(part) ||
					part.type !== "toolCall" ||
					typeof part.id !== "string" ||
					typeof part.name !== "string"
				) {
					continue;
				}
				const id = boundedToolCallId(part.id);
				const existing = next.tools.find((tool) => tool.toolCallId === id);
				next = upsertTool(next, {
					toolCallId: id,
					toolName: boundedToolName(part.name),
					args: boundedToolArgs(part.arguments),
					output: existing?.output ?? "",
					status: existing?.status ?? "pending",
				});
			}
		}
		return next;
	}

	if (event.type === "message_update") {
		const update = event.assistantMessageEvent;
		if (!isRecord(update) || typeof update.type !== "string") return activity;
		if (update.type === "thinking_delta" && typeof update.delta === "string") {
			return {
				...activity,
				thinking: tail(activity.thinking + update.delta, LIVE_ACTIVITY_LIMITS.thinkingChars),
			};
		}
		if (update.type === "text_delta" && typeof update.delta === "string") {
			return {
				...activity,
				text: tail(activity.text + update.delta, LIVE_ACTIVITY_LIMITS.textChars),
			};
		}
		if (update.type !== "toolcall_end" || !isRecord(update.toolCall)) return activity;
		const call = update.toolCall;
		if (typeof call.id !== "string" || typeof call.name !== "string") return activity;
		return upsertTool(activity, {
			toolCallId: boundedToolCallId(call.id),
			toolName: boundedToolName(call.name),
			args: boundedToolArgs(call.arguments),
			output: "",
			status: "pending",
		});
	}

	if (
		(event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end") &&
		typeof event.toolCallId === "string" &&
		typeof event.toolName === "string"
	) {
		const id = boundedToolCallId(event.toolCallId);
		const existing = activity.tools.find((tool) => tool.toolCallId === id);
		if (event.type === "tool_execution_start") {
			return upsertTool(activity, {
				toolCallId: id,
				toolName: boundedToolName(event.toolName),
				args: event.args === undefined ? (existing?.args ?? "") : boundedToolArgs(event.args),
				output: existing?.output ?? "",
				status: "running",
			});
		}
		if (event.type === "tool_execution_update") {
			return upsertTool(activity, {
				toolCallId: id,
				toolName: boundedToolName(event.toolName),
				args: event.args === undefined ? (existing?.args ?? "") : boundedToolArgs(event.args),
				output: resultOutput(event.partialResult),
				status: "running",
			});
		}
		return upsertTool(activity, {
			toolCallId: id,
			toolName: boundedToolName(event.toolName),
			args: existing?.args ?? "",
			output: resultOutput(event.result),
			status: event.isError === true ? "error" : "success",
		});
	}
	return activity;
}
