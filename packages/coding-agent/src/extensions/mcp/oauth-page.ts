/** Local callback pages: no upstream deployment identity, scripts, or external assets. */
function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);
}

export function oauthSuccessHtml(message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>MCP sign-in</title></head><body><h1>Signed in</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export function oauthErrorHtml(message: string, details?: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>MCP sign-in failed</title></head><body><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>${details ? `<pre>${escapeHtml(details)}</pre>` : ""}</body></html>`;
}
