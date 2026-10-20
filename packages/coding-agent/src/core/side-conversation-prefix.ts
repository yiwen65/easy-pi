import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import type { CodexServiceTier } from "./codex-service-tier.ts";

/** A detached neutral provider prefix. Cache affinity is not a native session identity. */
export interface SideConversationPrefix {
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly codexServiceTier?: CodexServiceTier;
	readonly context: Context;
	readonly cacheAffinityId?: string;
	readonly promptCacheKey?: string;
	readonly leafId: string | null;
	/** The owning session and effective checkpoint prevent reuse across unrelated branches. */
	readonly sessionId: string;
	readonly checkpointId?: string;
}

const prefixes = new WeakMap<AgentSession, { owner: symbol; prefix: SideConversationPrefix }>();

/** Preserve every declared schema and its order, never executable tool implementations. */
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

/** Observe requests without taking ownership of the parent's existing diagnostic observer. */
export function observeSideConversationPrefix(parent: AgentSession): () => void {
	const previous = parent.agent.onProviderContext;
	const owner = Symbol("side-conversation-prefix");
	let active = true;
	const observer: NonNullable<typeof previous> = (model, context) => {
		let prefix: SideConversationPrefix | undefined;
		if (active) {
			try {
				// Clone before invoking another observer: diagnostic mutation must not alter this snapshot.
				const tools = schemas(context.tools);
				prefix = {
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
				};
			} catch {
				// The stream must proceed, but an uncloneable request must never retain an older snapshot.
			}
		}
		try {
			previous?.(model, context);
		} catch {
			// Independent observers cannot fail provider execution or cache capture.
		}
		if (!active) return;
		prefixes.delete(parent);
		if (prefix) prefixes.set(parent, { owner, prefix });
	};
	parent.agent.onProviderContext = observer;
	return () => {
		active = false;
		if (parent.agent.onProviderContext === observer) parent.agent.onProviderContext = previous;
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
	if (parent.extensionRunner.hasHandlers("before_provider_request"))
		throw new Error(
			"Side conversation cannot preserve the request prefix with payload-transforming extensions enabled.",
		);
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
	return structuredClone(captured.prefix);
}
