import type { AgentToolCallOutcome, ToolExecutionOutcome } from "@earendil-works/pi-agent-core";
import type { JsonValue, NestedToolCallRecord, NestedToolCalls, Usage } from "@earendil-works/pi-ai";
/** Sum nested usage without dropping provider-specific reasoning/cache accounting. */
export function combineNestedUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		...(left.reasoning !== undefined || right.reasoning !== undefined
			? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
			: {}),
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
			? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
			: {}),
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

/** Display limits do not truncate the durable dispatch journal. */
export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

export interface NestedCallSummary {
	calls?: NestedToolCalls;
	usage?: Usage;
	executionOutcome: ToolExecutionOutcome;
}

/** Own all host promises of one invocation, including calls the tool forgot to await. */
export class ToolInvocationScope {
	readonly controller = new AbortController();
	private readonly pending = new Set<Promise<AgentToolCallOutcome>>();
	private readonly calls: NestedToolCallRecord[] = [];
	private argumentBytes = 0;
	private complete = true;
	private uncertain = false;
	private accepting = true;
	private usage?: Usage;

	get isAccepting(): boolean {
		return this.accepting;
	}

	run(execute: () => Promise<AgentToolCallOutcome>): Promise<AgentToolCallOutcome> {
		const startedAt = performance.now();
		const pending = Promise.resolve()
			.then(execute)
			.then((outcome) => {
				if (outcome.executionOutcome === "unknown") {
					this.uncertain = true;
					this.complete = false;
				}
				const record: NestedToolCallRecord = {
					id: outcome.toolCall.id,
					name: outcome.toolCall.name,
					status: outcome.executionOutcome === "unknown" ? "unfinished" : outcome.isError ? "error" : "ok",
					durationMs: Math.round(performance.now() - startedAt),
				};
				if (outcome.isError || outcome.executionOutcome === "unknown")
					record.error = (outcome.result.content ?? [])
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
						.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
				this.addRecord(record, outcome.toolCall.arguments ?? {});
				for (const child of outcome.result.nestedCalls?.calls ?? []) this.addRecord({ ...child }, child.arguments);
				if (outcome.result.nestedCalls?.complete === false) this.complete = false;
				if (outcome.result.usage)
					this.usage = this.usage ? combineNestedUsage(this.usage, outcome.result.usage) : outcome.result.usage;
				return outcome;
			})
			.catch((error: unknown) => {
				this.uncertain = true;
				this.complete = false;
				throw error;
			});
		this.pending.add(pending);
		// Attach both branches even for unawaited calls; uncertainty is retained for the parent.
		void pending.then(
			() => this.pending.delete(pending),
			() => this.pending.delete(pending),
		);
		return pending;
	}

	private addRecord(record: NestedToolCallRecord, args?: unknown): void {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return;
		}
		delete record.arguments;
		if (args !== undefined) {
			try {
				const json = JSON.stringify(args);
				const bytes = Buffer.byteLength(json);
				if (
					bytes <= NESTED_CALL_LIMITS.maxArgumentBytesPerCall &&
					this.argumentBytes + bytes <= NESTED_CALL_LIMITS.maxArgumentBytesTotal
				) {
					record.arguments = JSON.parse(json) as Record<string, JsonValue>;
					this.argumentBytes += bytes;
				} else {
					record.argumentsBytes = bytes;
					this.complete = false;
				}
			} catch {
				this.complete = false;
			}
		}
		this.calls.push(record);
	}

	async drain(): Promise<ToolExecutionOutcome> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
		return this.uncertain ? "unknown" : "confirmed";
	}

	async finish(): Promise<NestedCallSummary> {
		this.accepting = false;
		this.controller.abort();
		const executionOutcome = await this.drain();
		return {
			calls:
				this.calls.length > 0 || !this.complete
					? { calls: this.calls.map((call) => ({ ...call })), complete: this.complete }
					: undefined,
			usage: this.usage,
			executionOutcome,
		};
	}
}
