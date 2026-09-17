export {
	BackgroundTaskManager,
	type BackgroundTaskManagerOptions,
	type BackgroundTaskOutput,
	type BackgroundTaskRecord,
	type BackgroundTaskStallInfo,
	type BackgroundTaskStatus,
	DEFAULT_BACKGROUND_TIMEOUT_MS,
	DEFAULT_MAX_LOG_BYTES,
	DEFAULT_MAX_TASKS,
	DEFAULT_STALL_TIMEOUT_MS,
	DEFAULT_STOP_GRACE_MS,
	isBackgroundTaskStalled,
	isTerminalTaskStatus,
} from "./harness/env/background-task-manager.ts";
export {
	killNodeProcessTree,
	type NodeProcessExecutionOptions,
	type NodeProcessExecutionResult,
	NodeProcessExecutor,
	type NodeProcessExecutorOptions,
	type NodeProcessShellConfig,
	terminateNodeProcessTree,
} from "./harness/env/node-process-executor.ts";
export { NodeExecutionEnv, type NodeExecutionEnvOptions } from "./harness/env/nodejs.ts";
export * from "./index.ts";
