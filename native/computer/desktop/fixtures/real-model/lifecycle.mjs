export async function closeNative(session, feature) {
	const cleanupErrors = [];
	try {
		const report = await session?.shutdown();
		if (report?.complete === false) cleanupErrors.push("session_shutdown_incomplete");
	} catch {
		cleanupErrors.push("session_shutdown_unproved");
	}
	// Still close the host after a rejected session drain. close() is memoized;
	// this does not retry native input or clear quarantine.
	try {
		await feature?.close();
	} catch (error) {
		cleanupErrors.push(error?.code === "desktop_quarantined" ? "desktop_quarantined" : "native_close_unproved");
	}
	return { nativeClosed: cleanupErrors.length === 0, cleanupErrors };
}
