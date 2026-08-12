#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDurableLaunchBarrier } from "../../src/durable-launch-barrier.ts";

const root = await mkdtemp(join(tmpdir(), "pi-subagent-worker-preflight-"));
try {
	const barrier = await createDurableLaunchBarrier({
		directory: join(root, "barrier"),
		subjectSha256: "1".repeat(64),
		authorityBindingSha256: "invalid",
	}).catch(() => null);
	assert.equal(barrier, null);

	const validBarrier = await createDurableLaunchBarrier({
		directory: join(root, "valid-barrier"),
		subjectSha256: "1".repeat(64),
	});
	const payloadPath = join(root, "payload.json");
	const resultPath = join(root, "result.json");
	await writeFile(
		payloadPath,
		`${JSON.stringify({
			input: {
				async: true,
				durableLaunchBarrier: {
					...validBarrier,
					authorityBindingSha256: "invalid",
				},
			},
			cwd: root,
			runId: "run-preflight",
			attemptId: "attempt-preflight",
		})}\n`,
	);
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../fixtures/durable-worker-preflight-invalid.mjs"),
			payloadPath,
			resultPath,
		],
		{ stdio: "inherit" },
	);
	const exit = await new Promise((resolveExit) =>
		child.once("exit", (code, signal) => resolveExit({ code, signal })),
	);
	assert.deepEqual(exit, { code: 0, signal: null });
	const result = JSON.parse(await readFile(resultPath, "utf8"));
	assert.equal(result.failureKind, "guard_failure");
	assert.match(result.message, /authority binding/u);
	await assert.rejects(access(validBarrier.readyPath));
	await assert.rejects(access(validBarrier.ackPath));
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log("durable worker preflight checks passed");
