import { type Component, Container } from "@earendil-works/pi-tui";

export type TurnActivityKind = "background" | "subagent" | "thinking" | "tools";
const ACTIVITY_ORDER: readonly TurnActivityKind[] = ["background", "subagent", "thinking", "tools"];

/** Flat transcript whose activity rows remain at their owning user turn's tail.
 * Inherit Container.render unchanged so displayed-frame child offsets remain native.
 */
export class TurnTranscriptContainer extends Container {
	currentTurn: object = {};
	private turns = new Map<object, number>([[this.currentTurn, 0]]);
	private owners = new Map<Component, object>();
	private activities = new Map<object, Map<TurnActivityKind, Component>>();

	get currentBodyChildren(): Component[] {
		const tail = this.activities.get(this.currentTurn);
		return this.children.filter(
			(child) =>
				this.owners.get(child) === this.currentTurn && !ACTIVITY_ORDER.some((kind) => tail?.get(kind) === child),
		);
	}

	beginTurn(): void {
		this.currentTurn = {};
		this.turns.set(this.currentTurn, this.turns.size);
	}

	override addChild(component: Component): void {
		const tail = this.activities.get(this.currentTurn);
		const members = tail && new Set(tail.values());
		const index = members ? this.children.findIndex((child) => members.has(child)) : -1;
		this.owners.set(component, this.currentTurn);
		this.children.splice(index < 0 ? this.children.length : index, 0, component);
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
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		const owner = this.owners.get(component);
		this.owners.delete(component);
		const tail = owner && this.activities.get(owner);
		if (tail) for (const [kind, child] of tail) if (child === component) tail.delete(kind);
	}

	override clear(): void {
		super.clear();
		this.currentTurn = {};
		this.turns.clear();
		this.turns.set(this.currentTurn, 0);
		this.owners.clear();
		this.activities.clear();
	}
}
