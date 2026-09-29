export const scenarios = [
	"unicode-edit",
	"continuous-edit",
	"native-batch",
	"mixed-batch",
	"window-switch",
	"pointer-click",
	"pointer-focus-boundary",
	"pointer-scroll",
	"pointer-drag",
	"pointer-cancel",
	"web-form",
	"stale-reference",
	"stale-image",
	"cancel-restart",
];

export const protectionScenarios = new Set([
	"pointer-focus-boundary",
	"stale-reference",
	"stale-image",
	"cancel-restart",
	"pointer-cancel",
	"mixed-batch",
]);
