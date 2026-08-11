#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { awaitDurableLaunchBarrier } from "../../src/durable-launch-barrier.ts";

const [descriptorPath, markerPath, runId, attemptId, launchPayloadSha256] =
	process.argv.slice(2);
if (
	!descriptorPath ||
	!markerPath ||
	!runId ||
	!attemptId ||
	!launchPayloadSha256
) {
	throw new Error("durable launch barrier fixture arguments are incomplete");
}
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
await awaitDurableLaunchBarrier({
	descriptor,
	runId,
	attemptId,
	launchPayloadSha256,
});
await writeFile(markerPath, "released\n", "utf8");
