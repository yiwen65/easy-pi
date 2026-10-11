import { type Component, Container, Spacer } from "@earendil-works/pi-tui";

export type TurnActivityKind = "background" | "subagent" | "thinking" | "tools" | "duration";
const ACTIVITY_ORDER: readonly TurnActivityKind[] = ["background", "subagent", "thinking", "tools", "duration"];

/** Flat transcript whose activity rows remain at their owning user turn's tail.
 * Inherit Container.render unchanged so displayed-frame child offsets remain native.
 */
export class TurnTranscriptContainer extends Container {
	currentTurn: object = {};
	private turns = new Map<object, number>([[this.currentTurn, 0]]);
	private owners = new Map<Component, object>();
	private activities = new Map<object, Map<TurnActivityKind, Component>>();
	private spacers = new Map<object, { before: Spacer; duration: Spacer }>();

	get currentBodyChildren(): Component[] {
		const tail = this.activities.get(this.currentTurn);
		const spacers = this.spacers.get(this.currentTurn);
		return this.children.filter(
			(child) =>
				this.owners.get(child) === this.currentTurn &&
				!ACTIVITY_ORDER.some((kind) => tail?.get(kind) === child) &&
				child !== spacers?.before &&
				child !== spacers?.duration,
		);
	}

	beginTurn(): void {
		this.currentTurn = {};
		this.turns.set(this.currentTurn, this.turns.size);
	}

	override addChild(component: Component): void {
		const tail = this.activities.get(this.currentTurn);
		const spacers = this.spacers.get(this.currentTurn);
		const members = new Set([...(tail?.values() ?? []), ...(spacers ? [spacers.before, spacers.duration] : [])]);
		const index = this.children.findIndex((child) => members.has(child));
		this.owners.set(component, this.currentTurn);
		this.children.splice(index < 0 ? this.children.length : index, 0, component);
		if (tail) this.syncSpacers(this.currentTurn);
	}

	mountActivity(kind: TurnActivityKind, component: Component, owner = this.currentTurn): void {
		const turnIndex = this.turns.get(owner);
		// Cleared-session tokens must not resurrect stale groups.
		if (turnIndex === undefined) return;
		let tail = this.activities.get(owner);
		if (!tail) {
			tail = new Map();
			this.activities.set(owner, tail);
		}
		const previous = tail.get(kind);
		if (previous && previous !== component) {
			super.removeChild(previous);
			this.owners.delete(previous);
		}
		super.removeChild(component);
		tail.set(kind, component);
		this.owners.set(component, owner);
		const categoryIndex = ACTIVITY_ORDER.indexOf(kind);
		const index = this.children.findIndex((child) => {
			const childOwner = this.owners.get(child);
			if (childOwner && (this.turns.get(childOwner) ?? -1) > turnIndex) return true;
			return ACTIVITY_ORDER.some((category, i) => i > categoryIndex && tail?.get(category) === child);
		});
		this.children.splice(index < 0 ? this.children.length : index, 0, component);
		this.syncSpacers(owner);
	}

	private syncSpacers(owner: object): void {
		let spacers = this.spacers.get(owner);
		if (!spacers) {
			spacers = { before: new Spacer(1), duration: new Spacer(1) };
			this.spacers.set(owner, spacers);
		}
		for (const spacer of [spacers.before, spacers.duration]) {
			super.removeChild(spacer);
			this.owners.delete(spacer);
		}
		const tail = this.activities.get(owner);
		const first = this.children.findIndex((child) => tail && [...tail.values()].includes(child));
		if (first < 0) return;
		if (first > 0 && this.owners.get(this.children[first - 1]) === owner) {
			this.children.splice(first, 0, spacers.before);
			this.owners.set(spacers.before, owner);
		}
		const duration = tail?.get("duration");
		if (duration && tail && tail.size > 1) {
			this.children.splice(this.children.indexOf(duration), 0, spacers.duration);
			this.owners.set(spacers.duration, owner);
		}
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const owner = this.owners.get(component);
		this.owners.delete(component);
		const tail = owner && this.activities.get(owner);
		if (tail) {
			for (const [kind, child] of tail) if (child === component) tail.delete(kind);
			if (owner) this.syncSpacers(owner);
		}
	}

	override clear(): void {
		super.clear();
		this.currentTurn = {};
		this.turns.clear();
		this.turns.set(this.currentTurn, 0);
		this.owners.clear();
		this.activities.clear();
		this.spacers.clear();
	}
}
