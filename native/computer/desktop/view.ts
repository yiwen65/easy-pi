import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

type Content = readonly (TextContent | ImageContent)[];

function fingerprint(content: Content): string {
	const hash = createHash("sha256");
	for (const item of content) {
		// Length-delimited fields prevent text/image or adjacent-block ambiguities.
		const fields = item.type === "text" ? [item.type, item.text] : [item.type, item.mimeType, item.data];
		for (const field of fields) hash.update(`${Buffer.byteLength(field)}:`).update(field);
	}
	return hash.digest("hex");
}

/** Ephemeral capability evidence, never reconstructed from session history or persisted details. */
export class DesktopView<T> {
	private pending: { callId: string; fingerprint: string; image: boolean; value: T } | undefined;
	private visible: T | undefined;

	/** Publish only after the owning operation's result AND terminal have succeeded. */
	publish(callId: string, content: Content, value: T): void {
		this.clear();
		if (!callId || content.length === 0) throw new Error("Invalid Computer view");
		this.pending = {
			callId,
			fingerprint: fingerprint(content),
			image: content.some((item) => item.type === "image"),
			value,
		};
	}

	/** Called with final canonical model messages, after transforms and image filtering. */
	observeContext(imagesEnabled: boolean, messages: readonly Message[]): void {
		const candidate = this.pending;
		// The Agent swallows observer exceptions: clear BEFORE inspecting even one message.
		this.clear();
		if (!candidate || (candidate.image && !imagesEnabled)) return;
		const matches = messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === candidate.callId,
		);
		if (matches.length !== 1) return;
		const message = matches[0];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== "computer" ||
			message.isError ||
			fingerprint(message.content) !== candidate.fingerprint
		)
			return;
		this.pending = candidate;
		this.visible = candidate.value;
	}

	/** Every attempt consumes the view, including invalid requests and refused native work. */
	consume(): T | undefined {
		const value = this.visible;
		this.clear();
		return value;
	}

	clear(): void {
		this.pending = undefined;
		this.visible = undefined;
	}
}
