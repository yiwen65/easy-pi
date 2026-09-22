export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `easy-pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
