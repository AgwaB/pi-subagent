import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ResultEnvelope } from "./result.ts";

const MAX_PREVIEW_BYTES = 2048;

export interface AnswerPreview {
	text: string;
	partial: boolean;
	truncated: boolean;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Read only the bounded output prefix for this terminal run/attempt. Never raw logs. */
export async function readAnswerPreview(
	result: ResultEnvelope,
	maxBytes = MAX_PREVIEW_BYTES,
): Promise<AnswerPreview | undefined> {
	if (!["completed", "failed", "cancelled"].includes(result.status)) return undefined;
	const limit = Math.min(MAX_PREVIEW_BYTES, Math.max(0, Math.floor(maxBytes)));
	if (!Number.isFinite(limit) || limit === 0) return undefined;
	const output = result.artifacts.find((artifact) => artifact.type === "output");
	if (output === undefined) return undefined;
	try {
		const root = await realpath(result.cwd);
		const path = resolve(root, output.path);
		const attemptDir = dirname(path);
		const parent = dirname(attemptDir);
		const runDir = basename(parent) === "attempts" ? dirname(parent) : parent;
		if (
			!inside(root, path) ||
			basename(path) !== "output.log" ||
			basename(attemptDir) !== result.attemptId ||
			basename(runDir) !== result.runId
		)
			return undefined;
		// Reject symlinked output and ancestor redirects, including redirects within cwd.
		if ((await realpath(path)) !== path) return undefined;
		const handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			if (!(await handle.stat()).isFile()) return undefined;
			const buffer = Buffer.alloc(limit + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const truncated = bytesRead > limit;
			// A clipped UTF-8 suffix is not a replacement character in the preview.
			const text = new TextDecoder().decode(
				buffer.subarray(0, Math.min(bytesRead, limit)),
				{ stream: truncated },
			);
			if (text.length === 0) return undefined;
			return {
				text,
				partial: result.status !== "completed" || result.metadata.outputPartial === true,
				truncated,
			};
		} finally {
			await handle.close();
		}
	} catch {
		// Missing, removed or unreadable output must never change the run outcome.
		return undefined;
	}
}
