import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import type { CodexServiceTier } from "./codex-service-tier.ts";

type PayloadObservation = "not-required" | "unobserved" | "unchanged" | "changed" | "failed";

/** A detached neutral provider prefix. Cache affinity is not a native session identity. */
export interface SideConversationPrefix {
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly codexServiceTier?: CodexServiceTier;
	readonly context: Context;
	readonly cacheAffinityId?: string;
	readonly promptCacheKey?: string;
	readonly leafId: string | null;
	readonly sessionId: string;
	readonly checkpointId?: string;
	/** Opaque ordered handler identities, not source text or executable capabilities. */
	readonly payloadHookIdentity: string;
}

interface PayloadEvidence {
	lifecycle: { active: boolean };
	observation: PayloadObservation;
	bound: boolean;
	settled: boolean;
	calls: number;
}

interface CapturedPrefix {
	owner: symbol;
	prefix: SideConversationPrefix;
	evidence: PayloadEvidence;
}

const prefixes = new WeakMap<AgentSession, CapturedPrefix>();
// Clones retained by a side keep their own lightweight evidence, not a newer parent's observation.
const evidenceByPrefix = new WeakMap<SideConversationPrefix, PayloadEvidence>();
const hookIds = new WeakMap<object, number>();
let nextHookId = 0;

function payloadHookIdentity(parent: AgentSession): string {
	const objects: object[] = [
		parent.extensionRunner,
		...parent.resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => extension.handlers.get("before_provider_request") ?? []),
	];
	return objects
		.map((object) => {
			let id = hookIds.get(object);
			if (id === undefined) {
				id = ++nextHookId;
				hookIds.set(object, id);
			}
			return id;
		})
		.join(",");
}

/** Serialize only plain JSON data without invoking accessors or toJSON during observation. */
function payloadJson(value: unknown, ancestors = new Set<object>()): string | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Non-JSON payload");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
		throw new Error("Non-plain payload");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (descriptors.toJSON) throw new Error("Custom serialization");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const output: string[] = [];
			for (let index = 0; index < descriptors.length.value; index++) {
				const descriptor = descriptors[String(index)];
				if (descriptor && !("value" in descriptor)) throw new Error("Accessor payload");
				output.push(payloadJson(descriptor?.value, ancestors) ?? "null");
			}
			return `[${output.join(",")}]`;
		}
		const output: string[] = [];
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (!descriptor.enumerable) continue;
			if (!("value" in descriptor)) throw new Error("Accessor payload");
			const encoded = payloadJson(descriptor.value, ancestors);
			if (encoded !== undefined) output.push(`${JSON.stringify(key)}:${encoded}`);
		}
		return `{${output.join(",")}}`;
	} finally {
		ancestors.delete(value);
	}
}

/** Preserve every ordered schema, never executable tool implementations. */
function schemas(tools: readonly Tool[] | undefined): Tool[] | undefined {
	return tools?.map(({ name, description, parameters, constrainedSampling }) =>
		structuredClone({
			name,
			description,
			parameters,
			...(constrainedSampling === undefined ? {} : { constrainedSampling }),
		}),
	);
}

function sameRequest(prefix: SideConversationPrefix, model: Model<Api>, context: Context): boolean {
	return (
		JSON.stringify(model) === JSON.stringify(prefix.model) &&
		context.systemPrompt === prefix.context.systemPrompt &&
		JSON.stringify(context.messages) === JSON.stringify(prefix.context.messages) &&
		JSON.stringify(schemas(context.tools)) === JSON.stringify(prefix.context.tools)
	);
}

/** Observe real requests; never execute a speculative payload hook to establish compatibility. */
export function observeSideConversationPrefix(parent: AgentSession): () => void {
	const previous = parent.agent.onProviderContext;
	const previousStream = parent.agent.streamFunction;
	const owner = Symbol("side-conversation-prefix");
	const lifecycle = { active: true };
	const observer: NonNullable<typeof previous> = (model, context) => {
		let captured: CapturedPrefix | undefined;
		if (lifecycle.active) {
			try {
				const tools = schemas(context.tools);
				const prefix: SideConversationPrefix = {
					model: structuredClone(model),
					thinkingLevel: parent.thinkingLevel,
					codexServiceTier: parent.codexServiceTier,
					context: {
						...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
						messages: structuredClone(context.messages),
						...(tools === undefined ? {} : { tools }),
					},
					promptCacheKey: parent.agent.promptCacheKey ?? parent.agent.sessionId,
					...(model.api === "openai-codex-responses"
						? { cacheAffinityId: parent.agent.cacheAffinityId ?? parent.agent.sessionId }
						: {}),
					leafId: parent.sessionManager.getLeafId(),
					sessionId: parent.sessionId,
					checkpointId: parent.sessionManager
						.getBranch()
						.reverse()
						.find((entry) => entry.type === "compaction")?.id,
					payloadHookIdentity: payloadHookIdentity(parent),
				};
				const evidence: PayloadEvidence = {
					lifecycle,
					observation: parent.extensionRunner.hasHandlers("before_provider_request")
						? "unobserved"
						: "not-required",
					bound: false,
					settled: false,
					calls: 0,
				};
				const older = prefixes.get(parent);
				if (
					older?.owner === owner &&
					older.evidence.observation !== "not-required" &&
					!older.evidence.settled &&
					sameRequest(older.prefix, model, context)
				) {
					// Observer -> auth await -> payload settlement is not atomic. Identical outstanding captures are ambiguous.
					older.evidence.observation = "failed";
					evidence.observation = "failed";
				}
				evidenceByPrefix.set(prefix, evidence);
				captured = { owner, prefix, evidence };
			} catch {
				// The parent proceeds, but a failed capture must not retain an older snapshot.
			}
		}
		try {
			previous?.(model, context);
		} catch {
			// Independent diagnostic observers cannot fail capture or execution.
		}
		if (!lifecycle.active) return;
		prefixes.delete(parent);
		if (captured) prefixes.set(parent, captured);
	};
	const stream: typeof previousStream = (model, context, options) => {
		const captured = prefixes.get(parent);
		let matches = false;
		try {
			matches =
				lifecycle.active &&
				captured?.owner === owner &&
				captured.evidence.observation !== "not-required" &&
				sameRequest(captured.prefix, model, context);
		} catch {
			// Observation must not change the parent's execution.
		}
		if (!matches || !captured || !options?.onPayload) return previousStream(model, context, options);
		const evidence = captured.evidence;
		if (evidence.bound) {
			evidence.observation = "failed";
			return previousStream(model, context, options);
		}
		evidence.bound = true;
		const hook = options.onPayload;
		return previousStream(model, context, {
			...options,
			onPayload: async (payload, actualModel) => {
				if (!lifecycle.active) return hook(payload, actualModel);
				evidence.calls++;
				if (evidence.calls !== 1) evidence.observation = "failed";
				let observation: PayloadObservation = "failed";
				let before: string | undefined;
				try {
					before = payloadJson(payload);
				} catch {
					// Still execute the real hook once; do not read getters or change parent failures.
				}
				let failed = false;
				const stopErrors = parent.extensionRunner.onError((error) => {
					if (error.event === "before_provider_request") failed = true;
				});
				try {
					const result = await hook(payload, actualModel);
					try {
						if (!failed && before !== undefined)
							observation = payloadJson(result ?? payload) === before ? "unchanged" : "changed";
					} catch {
						// Store only the verdict, never bodies or raw extension errors.
					}
					return result;
				} finally {
					evidence.settled = true;
					stopErrors();
					if (lifecycle.active && evidence.observation !== "failed" && evidence.observation !== "changed") {
						try {
							evidence.observation =
								payloadHookIdentity(parent) === captured.prefix.payloadHookIdentity ? observation : "failed";
						} catch {
							evidence.observation = "failed";
						}
					}
				}
			},
		});
	};
	parent.agent.onProviderContext = observer;
	parent.agent.streamFunction = stream;
	return () => {
		lifecycle.active = false;
		if (parent.agent.onProviderContext === observer) parent.agent.onProviderContext = previous;
		if (parent.agent.streamFunction === stream) parent.agent.streamFunction = previousStream;
		if (prefixes.get(parent)?.owner === owner) prefixes.delete(parent);
	};
}

/** Fail closed rather than rebuilding or silently claiming a different prefix is cache-compatible. */
export function assertSideConversationPrefixCompatible(parent: AgentSession, prefix: SideConversationPrefix): void {
	if (parent.sessionId !== prefix.sessionId)
		throw new Error("Side conversation prefix belongs to another parent session.");
	if (JSON.stringify(parent.model) !== JSON.stringify(prefix.model) || parent.thinkingLevel !== prefix.thinkingLevel)
		throw new Error(
			"Side conversation prefix is unavailable: parent model or reasoning changed. Send a new parent message first.",
		);
	if (parent.codexServiceTier !== prefix.codexServiceTier)
		throw new Error(
			"Side conversation prefix is unavailable: parent service tier changed. Send a new parent message first.",
		);
	const branch = parent.sessionManager.getBranch();
	if (
		[...branch].reverse().find((entry) => entry.type === "compaction")?.id !== prefix.checkpointId ||
		(prefix.leafId !== null && !branch.some((entry) => entry.id === prefix.leafId))
	)
		throw new Error(
			"Side conversation prefix is unavailable: parent branch or compaction changed. Send a new parent message first.",
		);
	if (payloadHookIdentity(parent) !== prefix.payloadHookIdentity)
		throw new Error(
			"Side conversation prefix is unavailable: parent payload handlers changed. Send a new parent message first.",
		);
	if (parent.extensionRunner.hasHandlers("before_provider_request")) {
		const evidence = evidenceByPrefix.get(prefix);
		if (!evidence?.lifecycle.active || evidence.observation === "failed")
			throw new Error(
				"Side conversation cannot verify the parent payload hook result because observation or hook execution failed.",
			);
		if (evidence.observation === "changed")
			throw new Error(
				"Side conversation cannot preserve the request prefix: a parent payload hook changed the request.",
			);
		if (evidence.observation !== "unchanged")
			throw new Error(
				"The parent payload hook result has not been observed yet. Wait for the parent request to start, then retry.",
			);
	}
	if (parent.extensionRunner.hasHandlers("before_provider_headers"))
		throw new Error("Side conversation cannot preserve cache routing with header-transforming extensions enabled.");
	if (parent.systemPrompt !== (prefix.context.systemPrompt ?? ""))
		throw new Error(
			"Side conversation prefix is unavailable: parent rules changed. Send a new parent message first.",
		);
	if (JSON.stringify(schemas(parent.agent.state.tools)) !== JSON.stringify(prefix.context.tools))
		throw new Error(
			"Side conversation prefix is unavailable: parent tool declarations changed. Send a new parent message first.",
		);
	if (
		(parent.agent.promptCacheKey ?? parent.agent.sessionId) !== prefix.promptCacheKey ||
		(prefix.model.api === "openai-codex-responses" &&
			(parent.agent.cacheAffinityId ?? parent.agent.sessionId) !== prefix.cacheAffinityId)
	)
		throw new Error(
			"Side conversation prefix is unavailable: parent cache routing changed. Send a new parent message first.",
		);
}

export function getSideConversationPrefix(parent: AgentSession): SideConversationPrefix {
	const captured = prefixes.get(parent);
	if (!captured)
		throw new Error("No parent request prefix is available for a side conversation. Send a parent message first.");
	assertSideConversationPrefixCompatible(parent, captured.prefix);
	const clone = structuredClone(captured.prefix);
	evidenceByPrefix.set(clone, captured.evidence);
	return clone;
}
