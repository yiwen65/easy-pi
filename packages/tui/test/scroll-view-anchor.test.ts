import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView, type ScrollViewContentRange } from "../src/components/scroll-view.ts";
import { type Component, Container } from "../src/tui.ts";

function component(): Component {
	return { render: () => [], invalidate: () => {} };
}

function range(component: Component, start: number, height = 1, depth = 1): ScrollViewContentRange {
	return { component, start, height, depth };
}

function readingScroll(ranges: ScrollViewContentRange[], top: number): ScrollView {
	const scroll = new ScrollView(new Container(), { follow: "end" });
	scroll.updateContentRanges(ranges);
	scroll.updateLayout(1000, 10, () => {});
	scroll.scrollTo(top, { disableFollow: true });
	return scroll;
}

describe("ScrollView lost reading anchors", () => {
	it("keeps the first positive-height duplicate after a missing next neighbour", () => {
		const root = component();
		const anchor = component();
		const next = component();
		const previous = component();
		const scroll = readingScroll(
			[range(root, 0, 1000, 0), range(previous, 1), range(anchor, 5), range(component(), 6), range(next, 7)],
			5,
		);
		const revision = scroll.scrollRevision;
		scroll.updateContentRanges([
			range(root, 0, 1000, 0),
			range(previous, 1),
			range(next, 2, 0),
			range(next, 3, 2),
			range(next, 8, 3),
		]);
		assert.equal(scroll.scrollTop, 3, "next precedes previous; first positive duplicate wins");
		assert.equal(scroll.scrollRevision, revision);
		assert.equal(scroll.isFollowingEnd, false);
	});

	it("falls back to the nearest parent after all neighbours disappear", () => {
		const root = component();
		const parent = component();
		const scroll = readingScroll(
			[
				range(root, 0, 1000, 0),
				range(parent, 2, 20, 1),
				range(component(), 1),
				range(component(), 5, 5, 2),
				range(component(), 20),
			],
			8,
		);
		scroll.updateContentRanges([
			range(root, 0, 1000, 0),
			range(parent, 1, 0),
			range(parent, 7, 2),
			range(parent, 15, 3),
		]);
		assert.equal(scroll.scrollTop, 8, "nearest parent's local offset is clamped to its first positive range");
		scroll.updateLayout(9, 5, () => {});
		assert.equal(scroll.scrollTop, 4, "viewport clamping still occurs after anchor restoration");
	});

	it("restores a parent local row when there are no neighbour candidates", () => {
		const parent = component();
		const scroll = readingScroll([range(parent, 2, 20, 0), range(component(), 5, 5)], 8);
		scroll.updateContentRanges([range(parent, 7, 2, 0)]);
		assert.equal(scroll.scrollTop, 8);
	});

	it("retains the local position when every candidate disappears until viewport clamping", () => {
		const scroll = readingScroll([range(component(), 0, 1000, 0), range(component(), 5), range(component(), 6)], 5);
		scroll.updateContentRanges([]);
		assert.equal(scroll.scrollTop, 5);
		scroll.updateLayout(0, 10, () => {});
		assert.equal(scroll.scrollTop, 0);
	});

	it("does not treat zero-height anchor or neighbour ranges as survivors", () => {
		const root = component();
		const anchor = component();
		const next = component();
		const scroll = readingScroll(
			[range(root, 0, 1000, 0), range(anchor, 5), range(component(), 6), range(next, 7)],
			5,
		);
		scroll.updateContentRanges([range(root, 0, 1000, 0), range(anchor, 2, 0), range(next, 3, 0), range(next, 12)]);
		assert.equal(scroll.scrollTop, 12);
	});

	it("retains stable next-neighbour order when old bounds are equal", () => {
		const root = component();
		const first = component();
		const second = component();
		const scroll = readingScroll(
			[range(root, 0, 1000, 0), range(component(), 5), range(component(), 6), range(first, 7), range(second, 7)],
			5,
		);
		scroll.updateContentRanges([range(root, 0, 1000, 0), range(second, 10), range(first, 20)]);
		assert.equal(scroll.scrollTop, 20, "old traversal order, not new range order, determines the neighbour");
	});

	it("bounds new-range identity reads when hundreds of old neighbours disappear", () => {
		const root = component();
		const old = [range(root, 0, 1000, 0), ...Array.from({ length: 300 }, (_, i) => range(component(), i + 1))];
		const scroll = readingScroll(old, 1);
		let reads = 0;
		const next = [range(root, 0, 1000, 0), ...Array.from({ length: 300 }, (_, i) => range(component(), i + 1))].map(
			(entry): ScrollViewContentRange => ({
				get component() {
					reads++;
					return entry.component;
				},
				start: entry.start,
				height: entry.height,
				depth: entry.depth,
			}),
		);
		scroll.updateContentRanges(next);
		assert.equal(scroll.scrollTop, 1);
		assert.ok(reads <= 5 * next.length, `${reads} identity reads must be linear in new ranges, not old × new`);
	});

	it("does not build an identity index when the first neighbour survives", () => {
		const root = component();
		const anchor = component();
		const next = component();
		const scroll = readingScroll([range(root, 0, 1000, 0), range(anchor, 5), range(next, 6)], 5);
		let reads = 0;
		const ranges = [
			range(root, 0, 1000, 0),
			range(next, 6),
			...Array.from({ length: 300 }, () => range(component(), 20)),
		].map(
			(entry): ScrollViewContentRange => ({
				get component() {
					reads++;
					return entry.component;
				},
				start: entry.start,
				height: entry.height,
				depth: entry.depth,
			}),
		);
		scroll.updateContentRanges(ranges);
		assert.equal(scroll.scrollTop, 6);
		assert.ok(reads <= ranges.length + 5, "only the anchor miss scan and short first-neighbour lookup are needed");
	});
});
