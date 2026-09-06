import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";
export default mergeConfig(baseConfig, defineConfig({ test: { environment: "node", testTimeout: 30000, env: { PI_OFFLINE: "1" } } }));
