import assert from "node:assert/strict";
import { test } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { dispatchLayoutClick, renderLayoutFrame } from "../src/layout.ts";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";

test("layout clicks use clipped local coordinates and do not activate outside controls", () => {
	const clicks: number[][] = [];
	const button: Component = {
		render: () => ["button"],
		invalidate: () => {},
		handleClick: (row, col) => {
			clicks.push([row, col]);
			return true;
		},
	};
	const root = new VStack([
		{ component: new Text("header", 0, 0), basis: 1 },
		{
			component: new HStack([
				{ component: new Text("left", 0, 0), basis: 4 },
				{ component: button, basis: 6 },
			]),
			basis: 1,
		},
	]);
	const frame = renderLayoutFrame(root, 10, 2, () => {});
	assert.equal(dispatchLayoutClick(frame, 5, 1), true);
	assert.deepEqual(clicks, [[0, 1]]);
	assert.equal(dispatchLayoutClick(frame, 5, 0), false);
	assert.equal(dispatchLayoutClick(frame, 10, 1), false);
	assert.equal(dispatchLayoutClick(frame, 5, 2), false);
	const clipped = renderLayoutFrame(root, 10, 1, () => {});
	assert.equal(dispatchLayoutClick(clipped, 5, 1), false);
});

test("layout clicks account for leaf line offsets but leave ScrollView content to its existing handler", () => {
	const clicks: number[][] = [];
	const component: Component = {
		render: () => ["first", `${CURSOR_MARKER}second`],
		invalidate: () => {},
		handleClick: (row, col) => {
			clicks.push([row, col]);
			return true;
		},
	};
	const frame = renderLayoutFrame(component, 10, 1, () => {});
	assert.equal(dispatchLayoutClick(frame, 2, 0), true);
	assert.deepEqual(clicks, [[1, 2]]);
	const scrollFrame = renderLayoutFrame(new ScrollView(component), 10, 1, () => {});
	assert.equal(dispatchLayoutClick(scrollFrame, 2, 0), false);
	assert.equal(clicks.length, 1);
});
