import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { getRenderedContainerOffsets } from "../../tui/src/tui.ts";
import {
	type TurnActivityKind,
	TurnTranscriptContainer,
} from "../src/modes/interactive/components/turn-transcript-container.ts";

const row = (text: string) => new Text(text, 0, 0);
const kinds: TurnActivityKind[] = ["background", "subagent", "thinking", "tools"];

describe("turn transcript tail", () => {
	test("orders out-of-order activity creation below all late body rows", () => {
		const chat = new TurnTranscriptContainer();
		chat.addChild(row("user"));
		for (const kind of [...kinds].reverse()) chat.mountActivity(kind, row(kind));
		for (const body of ["assistant", "independent tool", "status", "custom", "worked", "compaction", "cache miss"])
			chat.addChild(row(body));
		expect(chat.render(80).map((line) => line.trimEnd())).toEqual([
			"user",
			"assistant",
			"independent tool",
			"status",
			"custom",
			"worked",
			"compaction",
			"cache miss",
			...kinds,
		]);
		expect(chat.currentBodyChildren).toHaveLength(8);
	});

	test("omits missing categories and expands in place", () => {
		const chat = new TurnTranscriptContainer();
		const tools = row("tools\ndetail");
		chat.mountActivity("tools", tools);
		chat.mountActivity("background", row("background"));
		chat.addChild(row("answer"));
		expect(chat.render(80).map((line) => line.trimEnd())).toEqual(["answer", "background", "tools", "detail"]);
		chat.mountActivity("tools", tools);
		expect(chat.render(80).map((line) => line.trimEnd())).toEqual(["answer", "background", "tools", "detail"]);
	});

	test("late old mounts stay before the next user boundary across multiple turns", () => {
		const chat = new TurnTranscriptContainer();
		const old = chat.currentTurn;
		chat.addChild(row("implicit body"));
		chat.mountActivity("tools", row("old tools"));
		chat.beginTurn();
		const next = chat.currentTurn;
		chat.addChild(row("next spacer"));
		chat.addChild(row("next user"));
		chat.mountActivity("tools", row("next tools"));
		chat.beginTurn();
		chat.addChild(row("last user"));
		chat.mountActivity("background", row("old background"), old);
		chat.mountActivity("subagent", row("next subagent"), next);
		chat.mountActivity("thinking", row("old thinking"), old);
		expect(chat.render(80).map((line) => line.trimEnd())).toEqual([
			"implicit body",
			"old background",
			"old thinking",
			"old tools",
			"next spacer",
			"next user",
			"next subagent",
			"next tools",
			"last user",
		]);
	});

	test("clear retires ownership and does not resurrect old session rows", () => {
		const chat = new TurnTranscriptContainer();
		const old = chat.currentTurn;
		chat.mountActivity("tools", row("old"));
		chat.clear();
		expect(chat.currentTurn).not.toBe(old);
		chat.mountActivity("background", row("stale"), old);
		chat.addChild(row("new session"));
		expect(chat.render(80).map((line) => line.trimEnd())).toEqual(["new session"]);
	});

	test("inherits native Container render and retains real displayed child offsets", () => {
		const chat = new TurnTranscriptContainer();
		const body = row("body\nsecond");
		const tools = row("tools");
		chat.mountActivity("tools", tools);
		chat.addChild(body);
		expect(chat.render).toBe(Container.prototype.render);
		const frame = chat.render(80);
		expect(getRenderedContainerOffsets(frame)?.get(chat)).toEqual([
			{ component: body, start: 0, height: 2 },
			{ component: tools, start: 2, height: 1 },
		]);
		body.setText("changed\nunpainted\nheight");
		expect(getRenderedContainerOffsets(frame)?.get(chat)?.[1].start).toBe(2);
	});
});
