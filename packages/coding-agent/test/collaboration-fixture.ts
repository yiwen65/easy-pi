import type { Context } from "@earendil-works/pi-ai";
import type { Delegation, DelegationContext } from "@easy-pi/subagent/collaboration-contract";

export function taskContract(objective: string): Delegation["task"] {
	// Canonical persisted delegations retain task.relationship; wire tools do not.
	return { relationship: "continue", objective };
}
export function spawnArgs(task_name: string, objective: string, context: DelegationContext = { mode: "isolated" }) {
	// Wire shape: relationship, context, and tools sit beside the objective-only task.
	return {
		task_name,
		task: { objective },
		relationship: "continue" as Delegation["task"]["relationship"],
		context,
		tools: "inherit" as const,
	};
}
export function followupArgs(target: string, objective: string) {
	return { target, task: { objective }, relationship: "continue" as const, tools: "inherit" as const };
}
export function currentCollaborationPath(context: Context): string {
	for (const message of [...context.messages].reverse()) {
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		const child = text.match(/^Current runtime delegation\. You are child ([^;]+);/);
		if (child) return child[1];
		if (text.includes("Current runtime role: /root,")) return "/root";
	}
	return "/root";
}
