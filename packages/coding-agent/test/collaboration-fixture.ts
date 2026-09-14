import type { Context } from "@earendil-works/pi-ai";
import type { Delegation, DelegationContext } from "@easy-pi/subagent/collaboration-contract";

export function taskContract(objective: string): Delegation["task"] {
	// The wire contract needs only the free-text objective; relationship defaults to continue.
	return { relationship: "continue", objective };
}
export function spawnArgs(task_name: string, objective: string, context: DelegationContext = { mode: "isolated" }) {
	// Flat wire shape: no delegation wrapper; context/capabilities sit beside task.
	return {
		task_name,
		task: taskContract(objective),
		context,
		tools: "inherit" as const,
	};
}
export function followupArgs(target: string, objective: string) {
	return { target, task: taskContract(objective), tools: "inherit" };
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
