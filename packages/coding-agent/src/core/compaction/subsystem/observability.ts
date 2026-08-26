export type AuditEventType = "checkpoint_validated" | "provider_context";

export interface AuditEvent {
	type: AuditEventType;
	at: string;
	sessionId: string;
	details: Record<string, string | number | boolean | undefined>;
}

export class AuditTrail {
	private events: AuditEvent[] = [];

	record(type: AuditEventType, sessionId: string, details: AuditEvent["details"] = {}): void {
		this.events.push({ type, at: new Date().toISOString(), sessionId, details });
	}

	list(): AuditEvent[] {
		return [...this.events];
	}

	byType(type: AuditEventType): AuditEvent[] {
		return this.events.filter((event) => event.type === type);
	}
}
