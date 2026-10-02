import { arch, platform, release } from "node:os";
import { describe, expect, it } from "vitest";
import type { ProviderHeaders } from "../src/types.ts";
import { forcePiUserAgent, getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("pi request identity", () => {
	it("uses pi with runtime OS information", () => {
		expect(getPiUserAgent()).toBe(`pi (${platform()} ${release()}; ${arch()})`);
	});

	it("replaces user-agent headers regardless of casing", () => {
		const headers: ProviderHeaders = {
			"user-agent": "custom-client",
			"USER-AGENT": "another-client",
			Authorization: "Bearer test-key",
		};
		forcePiUserAgent(headers);
		expect(headers).toEqual({
			"User-Agent": getPiUserAgent(),
			Authorization: "Bearer test-key",
		});
	});
});
