import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ImageResizeModule from "../src/utils/image-resize.ts";
import type { ResizedImage } from "../src/utils/image-resize.ts";

const fake = vi.hoisted(() => {
	class FakeWorker {
		listeners = new Map<string, ((value: unknown) => void)[]>();
		message?: { inputBytes: Uint8Array };
		terminated = false;
		finishTermination = (_code = 0): void => {};
		constructor() {
			workers.push(this);
		}
		once(event: string, listener: (value: unknown) => void): void {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		}
		emit(event: string, value: unknown): void {
			const listeners = this.listeners.get(event) ?? [];
			this.listeners.delete(event);
			for (const listener of listeners) listener(value);
		}
		postMessage(message: { inputBytes: Uint8Array }): void {
			this.message = message;
		}
		terminate(): Promise<number> {
			this.terminated = true;
			return new Promise((resolve) => {
				this.finishTermination = (code = 0) => resolve(code);
			});
		}
	}
	const workers: FakeWorker[] = [];
	return { Worker: FakeWorker, workers };
});

vi.mock("node:worker_threads", () => ({ Worker: fake.Worker }));

let api: typeof ImageResizeModule;
function input(value: number): Uint8Array {
	return new Uint8Array([value, value >> 8]);
}
function result(data = "cG5n"): ResizedImage {
	return { data, mimeType: "image/png", width: 1, height: 1, originalWidth: 1, originalHeight: 1, wasResized: false };
}
async function complete(worker: InstanceType<typeof fake.Worker>, output = result()): Promise<void> {
	worker.emit("message", { result: output });
	await vi.waitFor(() => expect(worker.terminated).toBe(true), { interval: 1 });
	worker.finishTermination(0);
}

beforeEach(async () => {
	vi.resetModules();
	fake.workers.length = 0;
	api = await vi.importActual<typeof ImageResizeModule>("../src/utils/image-resize.ts");
});

describe("image work lifetime and bounded reuse", () => {
	it("cancels one subscriber without killing shared work, then isolates cached result ownership", async () => {
		const controller = new AbortController();
		const bytes = input(1);
		const canceled = api.prepareImage(bytes, "image/png", { signal: controller.signal });
		const survivor = api.prepareImage(bytes, "image/png");
		expect(fake.workers).toHaveLength(1);
		const worker = fake.workers[0];
		bytes.fill(99);
		expect(worker.message?.inputBytes).toEqual(input(1));
		controller.abort();
		await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
		expect(worker.terminated).toBe(false);
		await complete(worker);
		const resolved = await survivor;
		resolved.data = "caller mutation";
		expect((await api.prepareImage(input(1), "image/png")).data).toBe("cG5n");
		expect(fake.workers).toHaveLength(1);
	});

	it("waits for termination on last cancellation before admitting the next worker", async () => {
		const controller = new AbortController();
		const pending = api.prepareImage(input(2), "image/png", { signal: controller.signal });
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const next = api.prepareImage(input(3), "image/png");
		let settled = false;
		void pending.catch(() => {
			settled = true;
		});
		controller.abort();
		await vi.waitFor(() => expect(fake.workers[0].terminated).toBe(true), { interval: 1 });
		expect(settled).toBe(false);
		expect(fake.workers).toHaveLength(1);
		fake.workers[0].finishTermination();
		await rejected;
		expect(fake.workers).toHaveLength(2);
		await complete(fake.workers[1]);
		await next;
		// A canceled result never populates the success cache.
		const retried = api.prepareImage(input(2), "image/png");
		expect(fake.workers).toHaveLength(3);
		await complete(fake.workers[2]);
		await retried;
	});

	it("uses per-subscriber deadlines rather than poisoning a longer-lived subscriber", async () => {
		const short = api.prepareImage(input(4), "image/png", { timeoutMs: 1 });
		const long = api.prepareImage(input(4), "image/png", { timeoutMs: 5000 });
		await expect(short).rejects.toMatchObject({ code: "timeout" });
		expect(fake.workers[0].terminated).toBe(false);
		await complete(fake.workers[0]);
		await expect(long).resolves.toMatchObject({ data: "cG5n" });
	});

	it("does not retry codec or resource failures on the main thread or another worker", async () => {
		const pending = api.prepareImage(input(5), "image/png");
		const rejected = expect(pending).rejects.toMatchObject({ code: "pixel_limit" });
		fake.workers[0].emit("message", { error: { code: "pixel_limit", message: "Too many pixels" } });
		await vi.waitFor(() => expect(fake.workers[0].terminated).toBe(true), { interval: 1 });
		fake.workers[0].finishTermination();
		await rejected;
		expect(fake.workers).toHaveLength(1);
		const exhausted = api.prepareImage(input(6), "image/png");
		const resourceRejected = expect(exhausted).rejects.toMatchObject({ code: "input_limit" });
		fake.workers[1].emit("error", Object.assign(new Error("OOM"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
		await vi.waitFor(() => expect(fake.workers[1].terminated).toBe(true), { interval: 1 });
		fake.workers[1].finishTermination();
		await resourceRejected;
		expect(fake.workers).toHaveLength(2);
	});

	it("bounds queued work and lets queued cancellation release its slot without a worker", async () => {
		const controllers = Array.from({ length: 9 }, () => new AbortController());
		const pending = controllers.map((controller, index) =>
			api
				.prepareImage(input(20 + index), "image/png", { signal: controller.signal })
				.catch((error: unknown) => error),
		);
		expect(fake.workers).toHaveLength(1);
		await expect(api.prepareImage(input(100), "image/png")).rejects.toMatchObject({ code: "input_limit" });
		for (const controller of controllers) controller.abort();
		await vi.waitFor(() => expect(fake.workers[0].terminated).toBe(true), { interval: 1 });
		fake.workers[0].finishTermination();
		expect(await Promise.all(pending)).toHaveLength(9);
		expect(fake.workers).toHaveLength(1);
		const next = api.prepareImage(input(100), "image/png");
		await complete(fake.workers[1]);
		await next;
	});

	it("keys cache entries by complete output policy and evicts beyond 32 entries", async () => {
		for (let index = 0; index < 33; index++) {
			const pending = api.prepareImage(input(index), "image/png");
			await complete(fake.workers[index]);
			await pending;
		}
		const evicted = api.prepareImage(input(0), "image/png");
		expect(fake.workers).toHaveLength(34);
		await complete(fake.workers[33]);
		await evicted;
		const changedPolicy = api.prepareImage(input(32), "image/png", { maxWidth: 999 });
		expect(fake.workers).toHaveLength(35);
		await complete(fake.workers[34]);
		await changedPolicy;
	});

	it("evicts by resident Base64 bytes before the entry-count limit", async () => {
		for (let index = 0; index < 17; index++) {
			const pending = api.prepareImage(input(index), "image/png");
			await complete(fake.workers[index], result("A".repeat(2 * 1024 * 1024)));
			await pending;
		}
		const evicted = api.prepareImage(input(0), "image/png");
		expect(fake.workers).toHaveLength(18);
		await complete(fake.workers[17]);
		await evicted;
	});
});
