import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Identity of a file's current content for cache validation. `ctimeMs`
 * changes on every write, rename, or metadata change and cannot be set
 * back by callers (unlike `mtime`), so an in-place rewrite always misses.
 */
export function statsFingerprint(info: Stats): string {
	return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

/** Fingerprint of several files; a missing file contributes a fixed marker. */
export async function fingerprintFiles(
	paths: readonly string[],
): Promise<string> {
	const parts = await Promise.all(
		paths.map(async (path) => {
			const info = await stat(path).catch(() => null);
			return info === null ? "-" : statsFingerprint(info);
		}),
	);
	return parts.join(",");
}
