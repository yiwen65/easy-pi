import type { Message } from "@earendil-works/pi-ai";

/** Request-only projection. Never mutate persisted messages or the current evidence group. */
export function recentComputerImages(messages: Message[]): Message[] {
	let remaining = 2;
	let cutoff = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult" || message.toolName !== "computer") continue;
		if (!message.content.some((part) => part.type === "image")) continue;
		if (remaining-- === 0) {
			cutoff = index;
			break;
		}
	}
	if (cutoff === -1) return messages;
	return messages.map((message, index) => {
		if (index > cutoff || message.role !== "toolResult" || message.toolName !== "computer") return message;
		if (!message.content.some((part) => part.type === "image")) return message;
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "image"
					? {
							type: "text" as const,
							text: "[Historical Computer screenshot omitted; text evidence retained. Not current input authority.]",
						}
					: part,
			),
		};
	});
}
