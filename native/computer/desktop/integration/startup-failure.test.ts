import { expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../../../packages/coding-agent/src/core/extensions/types.ts";
import { createComputerFeature } from "../entry.ts";

const mocks = vi.hoisted(() => ({ failure: { inner: { reason: "desktop_lease_unavailable" } }, create: vi.fn() }));
vi.mock("../renderer-helper.ts", () => ({
	inspectRendererHelper: () => "/trusted/renderer",
	installedRendererSha256: "verified",
}));
vi.mock("../loader.ts", () => ({
	loadDesktopSdk: () => ({
		SessionPermissionMode: { Unrestricted: 1 },
		ComputerRendererConfig: { Required: class {} },
		ComputerError: { Refused: { instanceOf: (error: unknown) => error === mocks.failure } },
		ComputerHost: { createWithRenderer: mocks.create },
	}),
}));

it("preserves desktop lease refusal through startup revocation and never retries ownership", async () => {
	mocks.create.mockReset().mockImplementation(() => {
		throw mocks.failure;
	});
	const feature = createComputerFeature();
	const execute = () =>
		feature.binding.tools[0]!.execute(
			"discover",
			{ request: { op: "discover" } },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
	try {
		await expect(execute()).rejects.toThrow("desktop_lease_unavailable");
		expect(feature.binding.rendererHealth).toEqual({ status: "failed", code: "desktop_lease_unavailable" });
		await expect(execute()).rejects.toThrow("desktop_lease_unavailable");
		expect(() => feature.binding.renew()).toThrow("desktop_lease_unavailable");
		expect(mocks.create).toHaveBeenCalledTimes(1);
	} finally {
		await feature.close();
	}
});
