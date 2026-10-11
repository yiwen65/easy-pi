import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function userExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mcp_user_probe", {
		description: "Unrelated user extension retained when built-in MCP is suppressed",
		handler: async () => {
			pi.appendEntry("mcp-loader-user-probe", { called: true });
		},
	});
}
