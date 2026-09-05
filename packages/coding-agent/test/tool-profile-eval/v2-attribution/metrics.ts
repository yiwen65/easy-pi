import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { assertContentFreeRecord, sha256 } from "../v2-bounded-real-eval.ts";

export const BASELINE = "38c64d5b60eadaff13a7ff480c32d92f62b3817e";
export const LIMITS = {
	requests: 240,
	tokens: 2_000_000,
	costUsd: 15,
	elapsedMs: 180 * 60_000,
	sessionMs: 10 * 60_000,
} as const;
export type Variant = "A" | "B" | "C";
export type Stage = "local" | "probe" | "development" | "validation";

export function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function bytes(value: unknown): number {
	return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
}
export function contentFreeWrite(path: string, value: unknown, exclusive = false): void {
	assertContentFreeRecord(value);
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: exclusive ? "wx" : "w", mode: 0o600 });
}

export interface PayloadSections {
	system: number;
	tools: number;
	user: number;
	assistantText: number;
	assistantCalls: number;
	toolResults: number;
	reasoning: number;
	otherHistory: number;
	protocol: number;
}
export interface PayloadMeasurement {
	bytes: number;
	sections: PayloadSections;
	retainedHistoryBytes: number;
	newHistoryBytes: number;
	toolParameterBytes: Record<string, number>;
	toolDescriptionBytes: Record<string, number>;
}

/** Counts disjoint serialized JSON values; field names, separators and other fields belong to protocol. */
export class PayloadMeter {
	private readonly seen = new Set<string>();
	observe(payload: unknown): PayloadMeasurement {
		const body = object(payload);
		if (!body || !Array.isArray(body.input)) throw new Error("invalid_payload");
		const sections: PayloadSections = {
			system: bytes(body.instructions),
			tools: bytes(body.tools),
			user: 0,
			assistantText: 0,
			assistantCalls: 0,
			toolResults: 0,
			reasoning: 0,
			otherHistory: 0,
			protocol: 0,
		};
		let retainedHistoryBytes = 0;
		let newHistoryBytes = 0;
		const newlySeen: string[] = [];
		for (const item of body.input) {
			const value = object(item);
			const size = bytes(item);
			const section =
				value?.role === "user"
					? "user"
					: value?.type === "reasoning"
						? "reasoning"
						: value?.type === "function_call" || value?.type === "custom_tool_call"
							? "assistantCalls"
							: value?.type === "function_call_output" || value?.type === "custom_tool_call_output"
								? "toolResults"
								: value?.role === "assistant"
									? "assistantText"
									: "otherHistory";
			sections[section] += size;
			const fingerprint = sha256(JSON.stringify(item));
			if (this.seen.has(fingerprint)) retainedHistoryBytes += size;
			else newHistoryBytes += size;
			newlySeen.push(fingerprint);
		}
		for (const fingerprint of newlySeen) this.seen.add(fingerprint);
		const total = bytes(payload);
		sections.protocol = total - Object.values(sections).reduce((sum, value) => sum + value, 0);
		if (sections.protocol < 0) throw new Error("overlapping_payload_sections");
		const toolParameterBytes: Record<string, number> = {};
		const toolDescriptionBytes: Record<string, number> = {};
		for (const item of Array.isArray(body.tools) ? body.tools : []) {
			const tool = object(item);
			if (!tool || typeof tool.name !== "string" || !["read", "bash", "edit", "write", "search"].includes(tool.name))
				throw new Error("unexpected_tool_schema");
			toolParameterBytes[tool.name] = bytes(tool.parameters);
			toolDescriptionBytes[tool.name] = bytes(tool.description);
		}
		return {
			bytes: total,
			sections,
			retainedHistoryBytes,
			newHistoryBytes,
			toolParameterBytes,
			toolDescriptionBytes,
		};
	}
}

export function assistantMetrics(message: AssistantMessage) {
	let argumentBytes = 0;
	let textBytes = 0;
	let thinkingSummaryBytes = 0;
	let reasoningSignatureBytes = 0;
	let toolCalls = 0;
	for (const part of message.content) {
		if (part.type === "toolCall") {
			argumentBytes += bytes(part.arguments);
			toolCalls += 1;
		} else if (part.type === "text") textBytes += Buffer.byteLength(part.text);
		else if (part.type === "thinking") {
			thinkingSummaryBytes += Buffer.byteLength(part.thinking);
			reasoningSignatureBytes += Buffer.byteLength(part.thinkingSignature ?? "");
		}
	}
	return {
		argumentBytes,
		textBytes,
		thinkingSummaryBytes,
		reasoningSignatureBytes,
		toolCalls,
		reportedReasoningTokens: message.usage.reasoning ?? null,
	};
}

export interface BudgetState {
	clock: number;
	attempts: string[];
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	pending?: { id: number; tokens: number; costUsd: number };
	stop?: string;
}

/** Shared by serialized fresh processes; an unresolved reservation prevents any continuation. */
export class Budget {
	readonly state: BudgetState;
	private readonly path: string;
	constructor(path: string, clock: number) {
		if (!Number.isSafeInteger(clock) || clock <= 0) throw new Error("invalid_clock");
		this.path = path;
		this.state = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as BudgetState)
			: {
					clock,
					attempts: [],
					requests: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0,
				};
		if (this.state.clock !== clock) throw new Error("clock_changed");
		for (const value of [
			this.state.requests,
			this.state.inputTokens,
			this.state.outputTokens,
			this.state.cacheReadTokens,
			this.state.cacheWriteTokens,
		]) {
			if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_budget_state");
		}
		if (
			!Number.isFinite(this.state.costUsd) ||
			this.state.costUsd < 0 ||
			new Set(this.state.attempts).size !== this.state.attempts.length
		)
			throw new Error("invalid_budget_state");
	}
	get tokens(): number {
		return (
			this.state.inputTokens + this.state.outputTokens + this.state.cacheReadTokens + this.state.cacheWriteTokens
		);
	}
	assertTime(): void {
		if (Date.now() < this.state.clock || Date.now() - this.state.clock >= LIMITS.elapsedMs)
			throw new Error("time_budget");
	}
	start(id: string): void {
		this.assertTime();
		if (
			!/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
			this.state.stop ||
			this.state.pending ||
			this.state.attempts.includes(id)
		)
			throw new Error("attempt_forbidden");
		this.state.attempts.push(id);
		this.flush();
	}
	reserve(tokens: number, costUsd: number): number {
		this.assertTime();
		if (this.state.stop || this.state.pending) throw new Error("unreconciled_usage");
		if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(costUsd) || costUsd <= 0)
			throw new Error("invalid_reservation");
		if (this.state.requests >= LIMITS.requests) throw new Error("request_budget");
		if (this.tokens + tokens > LIMITS.tokens) throw new Error("token_budget");
		if (this.state.costUsd + costUsd > LIMITS.costUsd) throw new Error("cost_budget");
		this.state.requests += 1;
		this.state.pending = { id: this.state.requests, tokens, costUsd };
		this.flush();
		return this.state.requests;
	}
	commit(usage: Usage): void {
		const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
		const tokens = values.reduce((sum, value) => sum + value, 0);
		if (
			!this.state.pending ||
			values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
			tokens <= 0 ||
			!Number.isFinite(usage.cost.total) ||
			usage.cost.total <= 0
		) {
			this.stop("usage_unknown");
			throw new Error("usage_unknown");
		}
		const pending = this.state.pending;
		this.state.inputTokens += usage.input;
		this.state.outputTokens += usage.output;
		this.state.cacheReadTokens += usage.cacheRead;
		this.state.cacheWriteTokens += usage.cacheWrite;
		this.state.costUsd += usage.cost.total;
		this.state.pending = undefined;
		if (tokens > pending.tokens || usage.cost.total > pending.costUsd) this.stop("reservation_exceeded");
		this.flush();
	}
	stop(reason: string): void {
		this.state.stop ??= reason;
		this.flush();
	}
	private flush(): void {
		contentFreeWrite(`${this.path}.next`, this.state);
		renameSync(`${this.path}.next`, this.path);
	}
}

export function unionDuration(intervals: Array<[number, number]>): number {
	const ordered = intervals.map(([start, end]) => [start, end] as [number, number]).sort((a, b) => a[0] - b[0]);
	let total = 0;
	let end = Number.NEGATIVE_INFINITY;
	for (const [start, next] of ordered) {
		total += Math.max(0, next - Math.max(start, end));
		end = Math.max(end, next);
	}
	return total;
}

/** Fixed paired case resampling; descriptive uncertainty, not population-wide inference. */
export function pairedLogRatioInterval(pairs: Array<[number, number]>, seed = 173): [number, number] | null {
	if (pairs.length < 2 || pairs.some((pair) => pair.some((value) => !Number.isFinite(value) || value <= 0)))
		return null;
	const values = pairs.map(([baseline, candidate]) => Math.log(candidate / baseline));
	let state = seed >>> 0;
	const samples = Array.from({ length: 4000 }, () => {
		let sum = 0;
		for (let i = 0; i < values.length; i += 1) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			sum += values[Math.floor((state / 0x1_0000_0000) * values.length)];
		}
		return sum / values.length;
	}).sort((a, b) => a - b);
	return [samples[100], samples[3899]];
}
