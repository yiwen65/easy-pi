import type { Context } from "@earendil-works/pi-ai";
import type { Delegation, DelegationContext } from "@easy-pi/subagent/collaboration-contract";

export function taskContract(objective: string): Delegation["task"] {
	return {
		relationship: "continue",
		objective,
		scope: "Synthetic fixture only",
		material: [],
		deliverables: ["Report result"],
		acceptance: ["Use the supplied fixture"],
	};
}
export function spawnArgs(task_name: string, objective: string, context: DelegationContext = { mode: "isolated" }) {
	return {
		task_name,
		delegation: {
			version: 1 as const,
			task: taskContract(objective),
			context,
			capabilities: { tools: "inherit" as const },
		},
	};
}
export function followupArgs(target: string, objective: string) {
	return { target, task: taskContract(objective), context: "existing", capabilities: { tools: "inherit" } };
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
