/**
 * Image-only, keyless local provider. The local server must implement
 * POST /v1/images: { input } -> { data: base64, mimeType: "image/png" }.
 * Registration does not contact the server. Use ModelRuntime's image queries
 * and generateImages(); this provider is deliberately absent from /model.
 */
import { createProvider, type ImageModel, type ProviderImages } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const model: ImageModel<"local-images"> = {
	type: "image",
	id: "local-draw",
	name: "Local Draw",
	provider: "local-images",
	api: "local-images",
	baseUrl: "http://localhost:8080/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const images: ProviderImages = {
	async generateImages(requestModel, context, options) {
		const headers = new Headers({ "content-type": "application/json" });
		for (const [name, value] of Object.entries(options?.headers ?? {})) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
		const payload = { input: context.input };
		const replacement = await options?.onPayload?.(payload, requestModel);
		const response = await (options?.fetch ?? fetch)(`${requestModel.baseUrl.replace(/\/$/, "")}/images`, {
			method: "POST",
			headers,
			body: JSON.stringify(replacement === undefined ? payload : replacement),
			signal: options?.signal,
		});
		await options?.onResponse?.(
			{ status: response.status, headers: Object.fromEntries(response.headers) },
			requestModel,
		);
		if (!response.ok) throw new Error(`Local image server returned ${response.status}`);
		const body: unknown = await response.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("data" in body) ||
			typeof body.data !== "string" ||
			!("mimeType" in body) ||
			typeof body.mimeType !== "string"
		) {
			throw new Error("Invalid local image response");
		}
		return {
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			output: [{ type: "image", data: body.data, mimeType: body.mimeType }],
			stopReason: "stop",
			timestamp: Date.now(),
		};
	},
};

export default function (pi: ExtensionAPI) {
	pi.registerProvider(
		createProvider({
			id: "local-images",
			name: "Local Images",
			auth: { apiKey: { name: "Keyless local server", resolve: async () => ({ auth: {} }) } },
			models: [model],
			images: { "local-images": images },
		}),
	);
}
