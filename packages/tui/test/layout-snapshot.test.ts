import assert from "node:assert/strict";
import { it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { Container, recordRenderedContentClickHandler } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

it("returns copied displayed nested Container geometry without rendering again", async () => {
	const terminal = new VirtualTerminal(20, 3);
	const chat = new Container();
	const before = new Text("before", 0, 0);
	let renders = 0;
	const target = {
		render: () => {
			renders++;
			return ["target", "detail"];
		},
		invalidate: () => {},
	};
	chat.addChild(before);
	chat.addChild(target);
	const document = new Container();
	document.addChild(new Text("header", 0, 0));
	document.addChild(chat);
	const scroll = new ScrollView(document);
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scroll);
	assert.equal(tui.getRenderedChildOffsets(scroll, chat), undefined);
	tui.start();
	tui.renderNow();
	await terminal.flush();
	const count = renders;
	const expected = [
		{ component: before, start: 1, height: 1 },
		{ component: target, start: 2, height: 2 },
	];
	assert.deepEqual(tui.getRenderedChildOffsets(scroll, chat), expected);
	before.setText("before\nundisplayed growth");
	chat.render(20); // External renders must not overwrite displayed geometry.
	const externalCount = renders;
	const ranges = tui.getRenderedChildOffsets(scroll, chat)!;
	ranges[0]!.start = 99;
	assert.deepEqual(tui.getRenderedChildOffsets(scroll, chat), expected);
	assert.equal(renders, externalCount);
	assert.equal(externalCount, count + 1);
	terminal.resize(10, 4);
	assert.equal(tui.getRenderedChildOffsets(scroll, chat), undefined);
	tui.renderNow();
	assert.equal(tui.getRenderedChildOffsets(scroll, chat)?.[1]?.start, 4);
	tui.setLayoutRoot(undefined);
	assert.equal(tui.getRenderedChildOffsets(scroll, chat), undefined);
	tui.stop({ preserveScreen: true });
});

it("captures content controls from the displayed render result and guards stale frames", () => {
	const terminal = new VirtualTerminal(20, 4);
	let renders = 0;
	let value = "displayed";
	const lines = [value];
	const calls: Array<{ value: string; row: number; col: number }> = [];
	const target = {
		render: () => {
			renders++;
			const renderedValue = value;
			recordRenderedContentClickHandler(target, lines, (row, col) => {
				calls.push({ value: renderedValue, row, col });
				return true;
			});
			return lines;
		},
		invalidate: () => {},
	};
	const chat = new Container();
	chat.addChild(target);
	const document = new Container();
	document.addChild(chat);
	const scroll = new ScrollView(document);
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scroll);
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
	tui.start();
	tui.renderNow();
	const handler = tui.getRenderedContentClickHandler(scroll, target)!;
	assert.equal(typeof handler, "function");
	value = "unseen";
	target.render(); // Even reusing the same lines array cannot mutate LayoutBox's copied map.
	const count = renders;
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), handler);
	assert.equal(handler(0, 7), true);
	assert.deepEqual(calls, [{ value: "displayed", row: 0, col: 7 }]);
	assert.equal(renders, count);
	assert.equal(tui.getRenderedContentClickHandler(new ScrollView(document), target), undefined);
	terminal.resize(10, 5);
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
	tui.renderNow();
	assert.notEqual(tui.getRenderedContentClickHandler(scroll, target), handler);
	tui.requestRender(true); // Reset invalidates the displayed frame immediately.
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
	tui.renderNow();
	tui.setLayoutRoot(undefined);
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
	tui.setLayoutRoot(scroll);
	tui.renderNow();
	tui.stop({ preserveScreen: true });
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
});

it("does not leak child content handlers through an opaque super.render result", () => {
	class Header extends Container {
		override render(width: number): string[] {
			const lines = super.render(width);
			lines.unshift("header");
			recordRenderedContentClickHandler(this, lines, (row) => row === 0);
			return lines;
		}
	}
	const target = {
		render: () => {
			const lines = ["body"];
			recordRenderedContentClickHandler(target, lines, () => true);
			return lines;
		},
		invalidate: () => {},
	};
	const header = new Header();
	const nested = new Container();
	nested.addChild(target);
	header.addChild(nested);
	const scroll = new ScrollView(header);
	const tui = new TuiAltScreen(new VirtualTerminal(20, 3));
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	assert.equal(tui.getRenderedContentClickHandler(scroll, target), undefined);
	assert.equal(tui.getRenderedContentClickHandler(scroll, header)?.(0, 0), true);
	assert.equal(tui.getRenderedContentClickHandler(scroll, header)?.(1, 0), false);
	tui.stop({ preserveScreen: true });
});

for (const motion of [false, true]) {
	it(`activates a displayed folding control after reading-anchor movement without copying (motion: ${motion})`, async () => {
		class FoldingCard extends Container {
			expanded = true;
			override render(): string[] {
				const expanded = this.expanded;
				const lines = expanded ? Array.from({ length: 30 }, (_, i) => `reading${i}`) : ["collapsed"];
				recordRenderedContentClickHandler(this, lines, (row) => {
					if (row !== 0) return false;
					this.expanded = !expanded;
					return true;
				});
				return lines;
			}
		}
		const terminal = new VirtualTerminal(30, 5);
		const earlier = new Text("earlier0\nearlier1\nearlier2", 0, 0);
		const card = new FoldingCard();
		const document = new Container();
		document.addChild(earlier);
		document.addChild(card);
		const scroll = new ScrollView(document, { follow: "end" });
		const copied: string[] = [];
		const clicked: number[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
			onContentClick: (click) => {
				clicked.push(click.row);
				const offset = tui.getRenderedChildOffsets(scroll, document)?.find((range) => range.component === card);
				return (
					!!offset &&
					(tui.getRenderedContentClickHandler(scroll, card)?.(click.row - offset.start, click.col) ?? false)
				);
			},
		});
		tui.setLayoutRoot(scroll);
		tui.start();
		try {
			tui.renderNow();
			scroll.scrollTo(3);
			tui.renderNow();
			await terminal.flush();
			assert.match(terminal.getViewport()[0]!, /reading0/);
			terminal.sendInput("\x1b[<0;6;1M");
			earlier.setText(Array.from({ length: 10 }, (_, i) => `earlier${i}`).join("\n"));
			tui.renderNow();
			await terminal.flush();
			assert.equal(scroll.scrollTop, 10);
			assert.match(terminal.getViewport()[0]!, /reading0/);
			if (motion) terminal.sendInput("\x1b[<32;6;1M");
			terminal.sendInput("\x1b[<0;6;1m");
			await terminal.waitForRender();
			assert.deepEqual(clicked, [10]);
			assert.deepEqual(copied, []);
			assert.equal(card.expanded, false);
			assert.match(terminal.getViewport().join("\n"), /collapsed/);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});
}

it("keeps overridden Container headers opaque", () => {
	class Header extends Container {
		override render(width: number): string[] {
			return ["header", ...super.render(width)];
		}
	}
	const header = new Header();
	const nested = new Container();
	nested.addChild(new Text("body", 0, 0));
	header.addChild(nested);
	const scroll = new ScrollView(header);
	const tui = new TuiAltScreen(new VirtualTerminal(20, 3));
	tui.setLayoutRoot(scroll);
	tui.start();
	tui.renderNow();
	assert.equal(tui.getRenderedChildOffsets(scroll, header), undefined);
	assert.equal(tui.getRenderedChildOffsets(scroll, nested), undefined);
	tui.stop({ preserveScreen: true });
});
