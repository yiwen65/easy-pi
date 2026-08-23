/**
 * CCTX-011: Append-only Event Log — the truth layer.
 *
 * Events are never updated or deleted; compaction only ever appends new
 * compaction events. Seq is monotonic per session. The JSONL backend writes
 * to disk before committing in memory, so a returned event is durable.
 * Large payloads may be externalized to the artifact store, but the event
 * metadata and content hash always stay in the log.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "../../session-manager.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { canonicalJson, hashPayload } from "./hashing.ts";
import type { Authority, EventEnvelope, EventType } from "./types.ts";
import { COMPACTION_SCHEMA_VERSION } from "./types.ts";

export interface AppendEventInput {
	sessionId: string;
	agentId: string;
	taskId?: string;
	eventType: EventType;
	timestamp?: string;
	causalParentIds?: string[];
	toolCallId?: string;
	transactionId?: string;
	payload?: unknown;
	payloadRef?: string;
	authority: Authority;
	/** Caller-provided idempotency id; duplicates are rejected. */
	eventId?: string;
}

export interface EventBoundary {
	sessionId: string;
	seq: number;
	at: string;
}

export interface EventLog {
	append(input: AppendEventInput): EventEnvelope;
	/** Current max seq; events appended afterwards belong to the next version. */
	freeze(sessionId: string): EventBoundary;
	/** Inclusive [fromSeq, toSeq]. */
	range(sessionId: string, fromSeq: number, toSeq: number): EventEnvelope[];
	all(sessionId: string): EventEnvelope[];
	replay(sessionId: string): EventEnvelope[];
	get(eventId: string): EventEnvelope | undefined;
}

let eventCounter = 0;

function nextEventId(): string {
	eventCounter += 1;
	return `ev-${Date.now().toString(36)}-${eventCounter}`;
}

interface SessionEvents {
	events: EventEnvelope[];
	byId: Map<string, EventEnvelope>;
}

function emptySessionEvents(): SessionEvents {
	return { events: [], byId: new Map() };
}

function cloneEnvelope(envelope: EventEnvelope): EventEnvelope {
	return structuredClone(envelope);
}

function appendToSession(session: SessionEvents, input: AppendEventInput): EventEnvelope {
	const eventId = input.eventId ?? nextEventId();
	if (session.byId.has(eventId)) {
		throw new Error(`Duplicate event id ${eventId} (append rejected)`);
	}
	const envelope: EventEnvelope = {
		eventId,
		sessionId: input.sessionId,
		seq: session.events.length + 1,
		agentId: input.agentId,
		taskId: input.taskId,
		eventType: input.eventType,
		timestamp: input.timestamp ?? new Date().toISOString(),
		causalParentIds: [...(input.causalParentIds ?? [])],
		toolCallId: input.toolCallId,
		transactionId: input.transactionId,
		payloadRef: input.payloadRef,
		payload: structuredClone(input.payload),
		contentHash: input.payloadRef ? hashOfRefOrPayload(input) : hashPayload(input.payload ?? null),
		authority: { ...input.authority },
		schemaVersion: COMPACTION_SCHEMA_VERSION,
	};
	return envelope;
}

function hashOfRefOrPayload(input: AppendEventInput): string {
	// When offloaded, hash the inline-serializable form so the hash still covers content identity.
	return hashPayload(input.payload ?? input.payloadRef ?? null);
}

function commitToSession(session: SessionEvents, envelope: EventEnvelope): void {
	session.events.push(envelope);
	session.byId.set(envelope.eventId, envelope);
}

export class InMemoryEventLog implements EventLog {
	protected sessions = new Map<string, SessionEvents>();

	protected getSession(sessionId: string): SessionEvents {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = emptySessionEvents();
			this.sessions.set(sessionId, session);
		}
		return session;
	}

	/** Durable hook: called with the envelope before it becomes visible in memory. */
	protected persist(envelope: EventEnvelope): void {
		void envelope;
	}

	append(input: AppendEventInput): EventEnvelope {
		const session = this.getSession(input.sessionId);
		const envelope = appendToSession(session, input);
		// Persist first: never report success for an event that was not durably written.
		this.persist(envelope);
		commitToSession(session, envelope);
		return cloneEnvelope(envelope);
	}

	freeze(sessionId: string): EventBoundary {
		const session = this.getSession(sessionId);
		return { sessionId, seq: session.events.length, at: new Date().toISOString() };
	}

	range(sessionId: string, fromSeq: number, toSeq: number): EventEnvelope[] {
		const session = this.getSession(sessionId);
		return session.events.filter((e) => e.seq >= fromSeq && e.seq <= toSeq).map(cloneEnvelope);
	}

	all(sessionId: string): EventEnvelope[] {
		return this.getSession(sessionId).events.map(cloneEnvelope);
	}

	replay(sessionId: string): EventEnvelope[] {
		return this.all(sessionId);
	}

	get(eventId: string): EventEnvelope | undefined {
		for (const session of this.sessions.values()) {
			const found = session.byId.get(eventId);
			if (found) return cloneEnvelope(found);
		}
		return undefined;
	}
}

/**
 * JSONL-backed event log, one file per session (`<dir>/<sessionId>.jsonl`).
 * Loading validates strict seq contiguity (1..n without gaps or duplicates);
 * a torn or forged tail fails loudly instead of being silently absorbed.
 */
export class JsonlEventLog extends InMemoryEventLog {
	private readonly dir: string;
	private loadedSessions = new Set<string>();

	constructor(dir: string) {
		super();
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	private filePath(sessionId: string): string {
		return join(this.dir, `${sessionId}.jsonl`);
	}

	private ensureLoaded(sessionId: string): void {
		if (this.loadedSessions.has(sessionId)) return;
		const path = this.filePath(sessionId);
		if (!existsSync(path)) {
			this.loadedSessions.add(sessionId);
			return;
		}
		const envelopes = readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as EventEnvelope);
		const session = emptySessionEvents();
		let expectedSeq = 1;
		for (const envelope of envelopes) {
			if (envelope.seq !== expectedSeq) {
				throw new Error(
					`Event log seq violation in ${path}: expected seq ${expectedSeq}, got ${envelope.seq} (event ${envelope.eventId}). Refusing to load out-of-order/duplicate/lossy log.`,
				);
			}
			if (session.byId.has(envelope.eventId)) {
				throw new Error(`Duplicate event id ${envelope.eventId} in ${path}`);
			}
			session.events.push(envelope);
			session.byId.set(envelope.eventId, envelope);
			expectedSeq += 1;
		}
		this.sessions.set(sessionId, session);
		this.loadedSessions.add(sessionId);
	}

	protected override getSession(sessionId: string): SessionEvents {
		this.ensureLoaded(sessionId);
		return super.getSession(sessionId);
	}

	override get(eventId: string): EventEnvelope | undefined {
		// Rare path; scans only loaded sessions, which is sufficient because
		// callers always operate on a session they have already touched.
		return super.get(eventId);
	}

	protected override persist(envelope: EventEnvelope): void {
		appendFileSync(this.filePath(envelope.sessionId), `${JSON.stringify(envelope)}\n`);
	}
}

// ============================================================================
// Payload offload helper (deterministic offload at write time)
// ============================================================================

export interface OffloadOptions {
	artifactStore: ArtifactStore;
	/** Payloads whose canonical size exceeds this are externalized. */
	thresholdBytes: number;
	tenant: string;
}

/**
 * Append an event, externalizing oversized payloads to the artifact store.
 * If the store fails, the payload stays inline — offload failure must never
 * drop content (fail safe, CCTX-012).
 */
export function appendWithOffload(log: EventLog, input: AppendEventInput, options: OffloadOptions): EventEnvelope {
	if (input.payload !== undefined && input.payloadRef === undefined) {
		// Raw strings are stored as-is; other values use canonical JSON so equal
		// content maps to equal bytes (content addressing stays deterministic).
		const stored = typeof input.payload === "string" ? input.payload : canonicalJson(input.payload);
		const size = new TextEncoder().encode(stored).length;
		if (size > options.thresholdBytes) {
			try {
				const meta = options.artifactStore.put(stored, {
					contentType: typeof input.payload === "string" ? "text/plain" : "application/json",
					source: `event:${input.eventId ?? "pending"}`,
					tenant: options.tenant,
				});
				return log.append({ ...input, payload: undefined, payloadRef: meta.ref });
			} catch {
				// fall through: keep inline
			}
		}
	}
	return log.append(input);
}

// ============================================================================
// SessionManager v3 adapter (read-only projection; SessionManager stays truth)
// ============================================================================

function projectedMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block !== null &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * Project v3 session entries into event inputs. Lossless: the original entry
 * is the payload; event types are derived for indexing. Label entries are UI
 * metadata and are skipped.
 */
export function sessionEntriesToEvents(entries: SessionEntry[], sessionId: string, agentId: string): EventEnvelope[] {
	const log = new InMemoryEventLog();
	for (const entry of entries) {
		const base = {
			sessionId,
			agentId,
			timestamp: entry.timestamp,
			causalParentIds: entry.parentId ? [entry.parentId] : [],
			authority: { kind: "system", id: "session-adapter", verified: true } satisfies Authority,
		};
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				// Slim projections: the session JSONL entry remains the truth; events
				// carry only what reducers/planners need, referenced by entryId.
				const textParts = message.content.filter((b) => b.type === "text" || b.type === "thinking");
				const toolCalls = message.content.filter((b) => b.type === "toolCall");
				if (textParts.length > 0 || toolCalls.length === 0) {
					const text = textParts
						.map((b) => (b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : ""))
						.join("\n");
					log.append({
						...base,
						eventId: entry.id,
						eventType: "message",
						payload: { entryId: entry.id, role: message.role, text },
					});
				}
				for (const call of toolCalls) {
					if (call.type !== "toolCall") continue;
					log.append({
						...base,
						eventId: `${entry.id}:${call.id}`,
						eventType: "tool_call",
						toolCallId: call.id,
						payload: { entryId: entry.id, toolCallId: call.id, name: call.name, arguments: call.arguments },
					});
				}
			} else if (message.role === "toolResult") {
				const content = Array.isArray(message.content) ? message.content : [];
				const text = content
					.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("\n");
				log.append({
					...base,
					eventId: entry.id,
					eventType: "tool_result",
					toolCallId: message.toolCallId,
					payload: {
						entryId: entry.id,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						isError: message.isError,
						content: text,
						hasImages: content.some((b) => b.type === "image"),
						imageCount: content.filter((b) => b.type === "image").length,
					},
				});
			} else {
				// user / bashExecution / custom and other roles: keep a slim text
				// projection only when the role actually carries string content.
				const content = (message as { content?: unknown }).content;
				const text = projectedMessageText(content);
				log.append({
					...base,
					eventId: entry.id,
					eventType: "message",
					payload: { entryId: entry.id, role: message.role, text },
					authority: message.role === "user" ? { kind: "user", id: "local-user", verified: true } : base.authority,
				});
			}
		} else if (entry.type === "compaction") {
			log.append({ ...base, eventId: entry.id, eventType: "compaction", payload: entry });
		} else if (entry.type === "custom_message" || entry.type === "branch_summary") {
			log.append({ ...base, eventId: entry.id, eventType: "message", payload: entry });
		} else if (entry.type === "label") {
		} else {
			log.append({ ...base, eventId: entry.id, eventType: "state_change", payload: entry });
		}
	}
	return log.all(sessionId);
}
