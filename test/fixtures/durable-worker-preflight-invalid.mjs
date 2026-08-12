#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { awaitDurableLaunchBarrier } from "../../src/durable-launch-barrier.ts";
import { prepareDurableWorkerBinding } from "../../src/workers/durable-worker-binding.mjs";

const [payloadPath, resultPath] = process.argv.slice(2);
const payloadBytes = await readFile(payloadPath);
const payload = JSON.parse(payloadBytes.toString("utf8"));
let failureKind = null;
let message = null;
try {
	prepareDurableWorkerBinding({
		payload,
		launchPayloadSha256: createHash("sha256").update(payloadBytes).digest("hex"),
		executionPlanSha256: "9".repeat(64),
	});
	await awaitDurableLaunchBarrier({
		descriptor: payload.input.durableLaunchBarrier,
		runId: payload.runId,
		attemptId: payload.attemptId,
		launchPayloadSha256: createHash("sha256").update(payloadBytes).digest("hex"),
		executionPlanSha256: "9".repeat(64),
	});
} catch (error) {
	failureKind = error?.failureKind ?? "internal";
	message = error instanceof Error ? error.message : String(error);
}
await writeFile(
	resultPath,
	`${JSON.stringify({ failureKind, message })}\n`,
	"utf8",
);
process.exitCode = failureKind === "guard_failure" ? 0 : 1;
