export type ResourceAccessMode = "shared" | "exclusive";

export interface ResourceRequest {
	readonly key?: string;
	readonly mode?: ResourceAccessMode;
}

export interface ResourceLease {
	readonly release: () => void;
}

interface Waiter {
	request: ResourceRequest;
	resolve: (lease: ResourceLease | undefined) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Small, host-agnostic bounded scheduler for tool execution slots and resource keys. */
export class ResourceScheduler {
	private readonly maxConcurrency: number;
	private activeCount = 0;
	private readonly activeKeys = new Map<string, ResourceAccessMode[]>();
	private readonly waiters: Waiter[] = [];

	constructor(maxConcurrency = 4) {
		if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
			throw new Error("ResourceScheduler maxConcurrency must be a positive integer");
		}
		this.maxConcurrency = maxConcurrency;
	}

	get pendingCount(): number {
		return this.waiters.length;
	}

	get runningCount(): number {
		return this.activeCount;
	}

	acquire(request: ResourceRequest = {}, signal?: AbortSignal): Promise<ResourceLease | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		if (this.canStart(request)) return Promise.resolve(this.start(request));
		return new Promise((resolve) => {
			const waiter: Waiter = { request, resolve, signal };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index !== -1) this.waiters.splice(index, 1);
					resolve(undefined);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	private canStart(request: ResourceRequest): boolean {
		if (this.activeCount >= this.maxConcurrency) return false;
		if (!request.key) return true;
		const activeModes = this.activeKeys.get(request.key) ?? [];
		if (activeModes.length === 0) return true;
		const requestedMode = request.mode ?? "exclusive";
		return requestedMode === "shared" && activeModes.every((mode) => mode === "shared");
	}

	private start(request: ResourceRequest): ResourceLease {
		this.activeCount++;
		if (request.key) {
			const modes = this.activeKeys.get(request.key) ?? [];
			modes.push(request.mode ?? "exclusive");
			this.activeKeys.set(request.key, modes);
		}
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.activeCount--;
				if (request.key) {
					const modes = this.activeKeys.get(request.key) ?? [];
					modes.pop();
					if (modes.length === 0) this.activeKeys.delete(request.key);
				}
				this.schedule();
			},
		};
	}

	private schedule(): void {
		for (let index = 0; index < this.waiters.length; ) {
			const waiter = this.waiters[index];
			if (waiter.signal?.aborted) {
				this.waiters.splice(index, 1);
				waiter.resolve(undefined);
				continue;
			}
			if (!this.canStart(waiter.request)) {
				index++;
				continue;
			}
			this.waiters.splice(index, 1);
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(this.start(waiter.request));
		}
	}
}
