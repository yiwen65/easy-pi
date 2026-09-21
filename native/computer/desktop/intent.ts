import { createHash, randomUUID } from "node:crypto";
import type { ComputerSegmentInput } from "./segment-contracts.ts";

type Request = ComputerSegmentInput["request"];
interface Intent {
	id: string;
	evidence: number;
	uncertain: boolean;
	resolved: boolean;
	owner: object;
	target: string | undefined;
}

/** Trusted, ephemeral ledger. Reads/context loss never renew an unresolved native intent. */
export class DesktopIntents {
	private readonly intents = new Map<string, Intent>();
	private current: Intent | undefined;
	private count = 0;
	get uncertain(): boolean {
		return this.current?.uncertain === true;
	}
	get unresolved(): boolean {
		return this.current !== undefined && !this.current.resolved;
	}
	begin(request: Request, evidence: number, owner: object, target?: string): string {
		// References are evidence versions, not intent identity. Normalize object key ordering too.
		const normalize = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(normalize);
			if (value && typeof value === "object")
				return Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "ref" && key !== "within")
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, item]) => [key, normalize(item)]),
				);
			return value;
		};
		// Native PID/window evidence separates identical shortcuts on different
		// applications. An opaque owner alone cannot distinguish a different
		// window from reselection of the same window in a new native session.
		const key = createHash("sha256")
			.update(JSON.stringify([target ?? null, normalize(request.actions)]))
			.digest("hex");
		const sameTarget = (intent: Intent) => (target === undefined ? intent.owner === owner : intent.target === target);
		if (request.previousEffect === "observed") {
			const previous = [...this.intents.values()].filter(sameTarget);
			if (
				previous.length === 0 ||
				previous.some((intent) => evidence <= intent.evidence) ||
				(this.current?.uncertain && !sameTarget(this.current))
			)
				throw new Error("resolution_requires_new_visible_evidence");
			// Reconciliation concerns prior effects on this observed target, not
			// just the most recent action signature (A -> B -> A must work).
			// It remains model judgement, never native effect confirmation.
			for (const prior of previous) {
				prior.resolved = true;
				prior.uncertain = false;
			}
		} else if (this.current?.uncertain) throw new Error("previous_intent_unresolved");
		let intent = this.intents.get(key);
		if (!intent || intent.resolved) {
			if (this.count >= 256) throw new Error("intent_capacity_reached");
			this.count++;
			intent = { id: randomUUID(), evidence, uncertain: true, resolved: false, owner, target };
			this.intents.set(key, intent);
		} else {
			if (intent.owner !== owner) throw new Error("unresolved_intent_target_changed");
			intent.evidence = evidence;
			intent.uncertain = true;
		}
		this.current = intent;
		return intent.id;
	}
	finish(status: string, incomplete: boolean): void {
		if (!this.current) return;
		this.current.resolved = status === "confirmed";
		this.current.uncertain = status !== "confirmed" && (status === "outcome_unknown" || incomplete);
	}
}
