import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import codingAgentConfig from "../../../../packages/coding-agent/vitest.config.ts";

export default mergeConfig(
	codingAgentConfig,
	defineConfig({
		test: {
			include: [
				fileURLToPath(new URL("./context.test.ts", import.meta.url)),
				fileURLToPath(new URL("./loop.test.ts", import.meta.url)),
				fileURLToPath(new URL("./compaction.test.ts", import.meta.url)),
				fileURLToPath(new URL("./drag.test.ts", import.meta.url)),
			],
		},
	}),
);
