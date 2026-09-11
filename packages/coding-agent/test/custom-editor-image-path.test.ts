import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

const roots: string[] = [];
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
	"base64",
);
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "easy-pi-image-paste-"));
	roots.push(root);
	const path = join(root, "test image.png");
	writeFileSync(path, png);
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keys);
	return { editor, path };
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setKeybindings(new KeybindingsManager());
});

describe("image paths pasted over a terminal", () => {
	it("attaches a real image without submitting and submits its payload only on Enter", async () => {
		const { editor, path } = fixture();
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput(`\x1b[200~${path}\x1b[201~`);
		await vi.waitFor(() => expect(editor.getText()).toBe("[Image #1]"));
		expect(submit).not.toHaveBeenCalled();
		const image = { type: "image", mimeType: "image/png", data: png.toString("base64") };
		expect(editor.getAttachments()).toEqual([image]);
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("[Image #1]", [image]);
	});
	it("handles a split paste and preserves subsequent typing order", async () => {
		const { editor, path } = fixture();
		editor.handleInput("\x1b[200~");
		editor.handleInput(path.slice(0, 12));
		editor.handleInput(`${path.slice(12)}\x1b[201~`);
		editor.handleInput(" describe");
		await vi.waitFor(() => expect(editor.getText()).toBe("[Image #1] describe"));
	});
	it("queues explicit Enter until the attachment is ready", async () => {
		const { editor, path } = fixture();
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput(`\x1b[200~${path}\x1b[201~\r`);
		await vi.waitFor(() =>
			expect(submit).toHaveBeenCalledWith("[Image #1]", [expect.objectContaining({ type: "image" })]),
		);
	});
	it("deletes and undoes an attachment using the existing marker registry", async () => {
		const { editor, path } = fixture();
		editor.handleInput(`\x1b[200~${path}\x1b[201~`);
		await vi.waitFor(() => expect(editor.getText()).toBe("[Image #1]"));
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("");
		expect(editor.getAttachments()).toEqual([]);
		editor.handleInput("\x1f");
		expect(editor.getText()).toBe("[Image #1]");
		expect(editor.getAttachments()).toHaveLength(1);
	});
	it("preserves paths in bash mode", () => {
		const { editor, path } = fixture();
		editor.setText("!cat ");
		editor.handleInput(`\x1b[200~${path}\x1b[201~`);
		expect(editor.getText()).toBe(`!cat ${path}`);
		expect(editor.getAttachments()).toEqual([]);
	});
	it("does not attach a non-image with an image extension", async () => {
		const { editor, path } = fixture();
		writeFileSync(path, "not an image");
		editor.handleInput(`\x1b[200~${path}\x1b[201~`);
		await vi.waitFor(() => expect(editor.getText()).toBe(path));
		expect(editor.getAttachments()).toEqual([]);
	});
	it("keeps a missing image path as text", async () => {
		const { editor, path } = fixture();
		const missing = `${path}.png`;
		editor.handleInput(`\x1b[200~${missing}\x1b[201~`);
		await vi.waitFor(() => expect(editor.getText()).toBe(missing));
		expect(editor.getAttachments()).toEqual([]);
	});
	it("does not inject a late image into a replacement draft", async () => {
		const { editor, path } = fixture();
		editor.handleInput(`\x1b[200~${path}\x1b[201~`);
		editor.setText("replacement");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(editor.getText()).toBe("replacement");
		expect(editor.getAttachments()).toEqual([]);
	});
	it("preserves ordinary multiline pastes and does not interpret paths embedded in prose", () => {
		const { editor, path } = fixture();
		const text = `look at ${path}\nwithout attaching`;
		editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		expect(editor.getText()).toBe(text);
		expect(editor.getAttachments()).toEqual([]);
	});
});
