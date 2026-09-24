export const scenarios = [
	"unicode-edit",
	"continuous-edit",
	"window-switch",
	"pointer-click",
	"pointer-scroll",
	"pointer-drag",
	"pointer-cancel",
	"web-form",
	"stale-reference",
	"stale-image",
	"cancel-restart",
];

export const protectionScenarios = new Set(["stale-reference", "stale-image", "cancel-restart", "pointer-cancel"]);
