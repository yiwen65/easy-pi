import { describe, it } from "vitest";
import { LIMITS } from "./metrics.ts";
import { entry } from "./runner.ts";

const REAL = process.env.PI_REAL_MODEL_EVAL === "1" && process.env.PI_V2_ATTRIBUTION_REAL === "1";
const PREFLIGHT = process.env.PI_V2_ATTRIBUTION_PREFLIGHT === "1" && process.env.PI_V2_ATTRIBUTION_MODE === "freeze";
describe.skipIf(!REAL && !PREFLIGHT)("new bounded v2 attribution", () => {
	it("executes only the explicit immutable phase and attempt", { timeout: LIMITS.sessionMs + 60_000 }, entry);
});
