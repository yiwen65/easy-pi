import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { Container } from "../src/tui.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("counts explicit scroll requests without counting layout maintenance", () => {
		const document = new Container();
		const before = new Text("before", 0, 0);
		const reading = new Text("read0\nread1\nread2\nread3\nread4\nread5", 0, 0);
		document.children = [before, reading];
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 20, 2, () => {});
		assert.equal(scroll.scrollRevision, 0);
		render();
		assert.equal(scroll.scrollRevision, 0);
		scroll.scrollToEnd();
		scroll.scrollToEnd();
		assert.equal(scroll.scrollRevision, 2, "same-clamped end requests count");
		scroll.scrollTo(99);
		assert.equal(scroll.scrollRevision, 3, "clamped scrollTo counts");
		assert.equal(scroll.scrollBy(10), 10);
		assert.equal(scroll.scrollRevision, 4, "nonzero blocked scrollBy counts");
		scroll.scrollBy(0);
		scroll.scrollBy(Number.NaN);
		assert.equal(scroll.scrollRevision, 4, "zero normalized deltas do not count");
		scroll.scrollToStart();
		scroll.scrollToStart();
		assert.equal(scroll.scrollRevision, 6, "same start requests count");
		scroll.scrollTo(3);
		const savedTop = scroll.scrollTop;
		const savedRevision = scroll.scrollRevision;
		scroll.scrollBy(-1);
		scroll.scrollBy(1);
		assert.equal(scroll.scrollTop, savedTop);
		assert.equal(scroll.scrollRevision, savedRevision + 2, "away-and-back is distinguishable");
		render();
		before.setText("before0\nbefore1\nbefore2");
		render();
		assert.equal(scroll.scrollTop, savedTop + 2, "reading anchor still restores geometry");
		assert.equal(scroll.scrollRevision, savedRevision + 2, "anchor updates do not count");
		scroll.scrollToEnd();
		const endRevision = scroll.scrollRevision;
		reading.setText("read0\nread1\nread2\nread3\nread4\nread5\nnew end");
		render();
		assert.equal(scroll.isFollowingEnd, true);
		assert.equal(scroll.scrollRevision, endRevision, "follow-end maintenance does not count");
	});
	it("prefers the leaf over identical root and single-child container bounds", () => {
		for (const nested of [false, true]) {
			const document = new Container();
			const reading = new Text("read0\nread1\nread2\nread3\nread4\nread5", 0, 0);
			const parent = nested ? new Container() : document;
			parent.addChild(reading);
			if (nested) document.addChild(parent);
			const scroll = new ScrollView(document, { follow: "end" });
			const render = () => visibleLines(renderLayoutFrame(scroll, 20, 2, () => {}).lines);
			render();
			scroll.scrollTo(0, { disableFollow: true });
			assert.equal(render()[0], "read0");
			parent.children.unshift(new Text("prepended", 0, 0));
			assert.equal(render()[0], "read0");
			assert.equal(scroll.scrollTop, 1);
		}
	});
	it("falls back to a surviving parent local row when all old neighbours disappear", () => {
		const document = new Container();
		const parent = new Container();
		parent.addChild(new Text("read0\nread1\nread2\nread3\nread4\nread5", 0, 0));
		document.children = [new Text("old0\nold1", 0, 0), parent];
		const scroll = new ScrollView(document);
		const render = () => visibleLines(renderLayoutFrame(scroll, 20, 2, () => {}).lines);
		render();
		scroll.scrollTo(5);
		assert.equal(render()[0], "read3");
		parent.children = [new Text("replacement0\nreplacement1", 0, 0)];
		document.children = [
			new Text("new0\nnew1\nnew2\nnew3\nnew4\nnew5", 0, 0),
			parent,
			new Text("tail0\ntail1\ntail2\ntail3", 0, 0),
		];
		assert.equal(render()[0], "replacement1");
		assert.equal(scroll.scrollTop, 7, "clamp local parent row rather than old absolute row");
	});

	it("uses boundary neighbours and clamps the fallback to the viewport", () => {
		const document = new Container();
		const before = new Text("before0\nbefore1\nbefore2\nbefore3\nbefore4\nbefore5", 0, 0);
		const target = new Text("read0\nread1\nread2\nread3\nread4\nread5", 0, 0);
		const after = new Text("after", 0, 0);
		document.children = [before, target, after];
		const scroll = new ScrollView(document);
		const render = () => visibleLines(renderLayoutFrame(scroll, 20, 3, () => {}).lines);
		render();
		scroll.scrollTo(6);
		assert.equal(render()[0], "read0");
		document.removeChild(target);
		assert.deepEqual(render(), ["before4", "before5", "after"]);
		assert.equal(scroll.scrollTop, 4, "next neighbour at old end boundary is viewport-clamped");
		document.children = [before, target];
		render();
		scroll.scrollTo(6);
		assert.equal(render()[0], "read0");
		document.children = [before, new Text("new0\nnew1\nnew2\nnew3", 0, 0)];
		assert.equal(render()[0], "before0", "previous neighbour at old start boundary is fallback");
	});

	it("keeps the reading component and local row when earlier content grows", () => {
		const document = new Container();
		const earlier = new Text("earlier", 0, 0);
		const target = new Text("target0\ntarget1\ntarget2\ntarget3\ntarget4\ntarget5", 0, 0);
		document.addChild(earlier);
		document.addChild(target);
		document.addChild(new Text("tail0\ntail1\ntail2\ntail3", 0, 0));
		const scroll = new ScrollView(document, { follow: "end" });
		renderLayoutFrame(scroll, 20, 3, () => {});
		scroll.scrollTo(4);
		assert.strictEqual(visibleLines(renderLayoutFrame(scroll, 20, 3, () => {}).lines)[0], "target3");
		earlier.setText("earlier0\nearlier1\nearlier2\nearlier3\nearlier4");
		assert.strictEqual(visibleLines(renderLayoutFrame(scroll, 20, 3, () => {}).lines)[0], "target3");
	});
	it("preserves nested identity through collapse, reorder and resize and falls back on removal", () => {
		const document = new Container();
		const chat = new Container();
		const before = new Text("before0\nbefore1\nbefore2", 0, 0);
		const target = new Text("target0\ntarget1\ntarget2\ntarget3\ntarget4\ntarget5", 0, 0);
		const tail = new Text("tail0\ntail1\ntail2\ntail3\ntail4\ntail5", 0, 0);
		chat.children = [before, target, tail];
		document.addChild(chat);
		const scroll = new ScrollView(document, { follow: "end" });
		const render = (width = 20) => visibleLines(renderLayoutFrame(scroll, width, 3, () => {}).lines);
		render();
		scroll.scrollTo(6);
		assert.equal(render()[0], "target3");
		before.setText("collapsed");
		assert.equal(render()[0], "target3");
		chat.children = [target, before, tail];
		assert.equal(render()[0], "target3");
		assert.equal(render(10)[0], "target3");
		target.setText("target0\ntarget1");
		assert.equal(render()[0], "target1", "clamp offset inside collapsed reading component");
		chat.removeChild(target);
		assert.equal(render()[0], "collapsed", "next surviving neighbour starts at top");
		scroll.scrollToEnd();
		tail.setText("tail0\ntail1\ntail2\ntail3\ntail4\ntail5\nnew end");
		assert.equal(render().at(-1), "new end");
		assert.equal(scroll.isFollowingEnd, true);
	});

	it("keeps a local reading row when resizing wraps content above it", () => {
		const document = new Container();
		const before = new Text("abcdefghijklmnopqrstuvwxyz", 0, 0);
		const target = new Text("t0\nt1\nt2\nt3\nt4\nt5", 0, 0);
		document.children = [before, target, new Text("end0\nend1\nend2", 0, 0)];
		const scroll = new ScrollView(document);
		renderLayoutFrame(scroll, 40, 3, () => {});
		scroll.scrollTo(4);
		assert.equal(visibleLines(renderLayoutFrame(scroll, 40, 3, () => {}).lines)[0], "t3");
		assert.equal(visibleLines(renderLayoutFrame(scroll, 10, 3, () => {}).lines)[0], "t3");
		assert.equal(scroll.scrollTop, 6);
	});

	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("renders a transient proportional scrollbar without replacing cell content", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const scrollbarBackground = "\x1b[48;5;1m";
		const scrollbarStyle = (text: string) => `${scrollbarBackground}${text}\x1b[49m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const thumbRows = (lines: string[]) => lines.map((line) => line.includes(scrollbarBackground));

		let lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, false, false, false]);
		assert.deepStrictEqual(lines.map(stripTerminalSequences), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, true, true, false]);
		assert.deepStrictEqual(lines.map(stripTerminalSequences), sourceLines.slice(2, 6));
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(scrollbarBackground));

		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, false, false, false]);

		scrollView.scrollToEnd();
		lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, false, true, true]);
		assert.deepStrictEqual(lines.map(stripTerminalSequences), sourceLines.slice(4));

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 5);
		assert.ok(growthFrame.lines.every((line) => !line.includes(scrollbarBackground)));

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		assert.ok(
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !line.includes(scrollbarBackground)),
		);

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		assert.ok(alwaysFittingFrame.lines.every((line) => line.includes(scrollbarBackground)));

		const alwaysOverflowing = new ScrollView(content, { scrollbar: "always", scrollbarStyle });
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		assert.strictEqual(alwaysOverflowingFrame.lines.filter((line) => line.includes(scrollbarBackground)).length, 2);

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) => line.includes(scrollbarBackground))
				.length;
		};
		assert.strictEqual(thumbHeightFor(21), 19);
		assert.strictEqual(thumbHeightFor(40), 10);
		assert.strictEqual(thumbHeightFor(100), 4);
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		assert.deepStrictEqual(visibleLines(always.lines), ["12345", "6"]);
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		scrollView.setScrollbar("hidden");
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});
});
