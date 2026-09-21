import type * as CuaSdk from "@trycua/cua-driver";

/** Called only after real lazy runtime creation. The timer is observation, never native proof. */
export function watchRenderer(
	api: Pick<typeof CuaSdk, "ComputerRendererStatus">,
	host: { rendererStatus(): CuaSdk.ComputerRendererStatus },
	stop: {
		readonly stopped: boolean;
		update(
			health:
				| { status: "ready"; pid: number; windowId: number }
				| { status: "emergency_stopped" }
				| { status: "failed"; code: string },
		): void;
	},
): { refresh(): void; dispose(): void } {
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	const dispose = () => {
		disposed = true;
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const poll = () => {
		if (disposed) return;
		try {
			const status = host.rendererStatus();
			if (api.ComputerRendererStatus.EmergencyStopped.instanceOf(status)) {
				dispose();
				stop.update({ status: "emergency_stopped" });
			} else if (api.ComputerRendererStatus.Failed.instanceOf(status)) {
				dispose();
				stop.update({ status: "failed", code: status.inner.code });
			} else if (api.ComputerRendererStatus.Ready.instanceOf(status)) {
				stop.update({ status: "ready", pid: status.inner.pid, windowId: status.inner.windowId });
			} else {
				dispose();
				stop.update({ status: "failed", code: "renderer_required" });
			}
		} catch {
			dispose();
			stop.update({ status: "failed", code: "renderer_status_unavailable" });
		}
	};
	poll();
	if (!stop.stopped) {
		timer = setInterval(poll, 100);
		timer.unref();
	}
	return { refresh: poll, dispose };
}
