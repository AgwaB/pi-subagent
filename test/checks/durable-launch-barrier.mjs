#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	access,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDurableLaunchBarrier,
	durableLaunchBarrierDigest,
	releaseDurableLaunchBarrier,
	waitForDurableLaunchBarrierAck,
	waitForDurableLaunchBarrierReady,
} from "../../src/durable-launch-barrier.ts";
import { validateResolveInput } from "../../src/core/validation.ts";

const canonical = (value) =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.filter(([, entry]) => entry !== undefined)
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([key, entry]) => [key, canonical(entry)]),
				)
			: value;

const root = await mkdtemp(join(tmpdir(), "pi-subagent-launch-barrier-"));
try {
	const descriptor = await createDurableLaunchBarrier({
		directory: join(root, "barrier"),
		subjectSha256: "a".repeat(64),
		timeoutMs: 15_000,
		pollIntervalMs: 5,
	});
	const replaced = await createDurableLaunchBarrier({
		directory: join(root, "replaced-barrier"),
		subjectSha256: "f".repeat(64),
		timeoutMs: 100,
	});
	await rename(replaced.directory, `${replaced.directory}-original`);
	await mkdir(replaced.directory, { mode: 0o700 });
	await assert.rejects(
		waitForDurableLaunchBarrierReady(replaced),
		/directory was replaced/,
	);

	const descriptorPath = join(root, "descriptor.json");
	const markerPath = join(root, "released.txt");
	await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, "utf8");

	assert.equal(
		validateResolveInput({
			backend: "headless",
			task: "fixture",
			async: true,
			durableLaunchBarrier: descriptor,
		}).ok,
		true,
	);
	const synchronous = validateResolveInput({
		backend: "headless",
		task: "fixture",
		durableLaunchBarrier: descriptor,
	});
	assert.equal(synchronous.ok, false);
	if (!synchronous.ok)
		assert.match(synchronous.failure.error, /durable async execution/);
	const mutated = validateResolveInput({
		backend: "headless",
		task: "fixture",
		async: true,
		durableLaunchBarrier: { ...descriptor, challenge: "b".repeat(64) },
	});
	assert.equal(mutated.ok, false);

	const runId = "run-general-barrier";
	const attemptId = "attempt-general-barrier";
	const launchPayloadSha256 = "c".repeat(64);
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../fixtures/durable-launch-barrier-worker.mjs"),
			descriptorPath,
			markerPath,
			runId,
			attemptId,
			launchPayloadSha256,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const output = [];
	child.stdout.on("data", (chunk) => output.push(chunk));
	child.stderr.on("data", (chunk) => output.push(chunk));
	const exitPromise = new Promise((resolveExit) => {
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});

	const ready = await waitForDurableLaunchBarrierReady(descriptor);
	assert.equal(ready.runId, runId);
	assert.equal(ready.attemptId, attemptId);
	assert.equal(ready.launchPayloadSha256, launchPayloadSha256);
	await assert.rejects(access(markerPath));

	const releaseBody = {
		schema: "pi-subagent-durable-launch-barrier-release-v1",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		subjectSha256: descriptor.subjectSha256,
		runId: ready.runId,
		attemptId: ready.attemptId,
		readySha256: ready.readySha256,
		releasePayloadSha256: "d".repeat(64),
	};
	const expectedRelease = {
		...releaseBody,
		releaseSha256: durableLaunchBarrierDigest(releaseBody),
	};
	const releaseBytes = Buffer.from(`${JSON.stringify(canonical(expectedRelease))}\n`);
	const transactionPath = `${descriptor.releasePath}.txn`;
	await writeFile(transactionPath, releaseBytes, { mode: 0o600 });
	await link(transactionPath, descriptor.releasePath);
	await writeFile(`${descriptor.releasePath}.pending`, "pending\n", {
		mode: 0o600,
	});
	const release = await releaseDurableLaunchBarrier(
		descriptor,
		ready,
		"d".repeat(64),
	);
	assert.deepEqual(release, expectedRelease);
	await assert.rejects(access(`${descriptor.releasePath}.pending`));
	const ack = await Promise.race([
		waitForDurableLaunchBarrierAck(descriptor, release),
		exitPromise.then((exit) => {
			if (exit.code === 0) return new Promise(() => undefined);
			throw new Error(Buffer.concat(output).toString() || JSON.stringify(exit));
		}),
	]);
	assert.equal(ack.releaseSha256, release.releaseSha256);

	const exit = await exitPromise;
	assert.deepEqual(exit, { code: 0, signal: null }, Buffer.concat(output).toString());
	assert.equal(await readFile(markerPath, "utf8"), "released\n");
	await assert.rejects(
		releaseDurableLaunchBarrier(descriptor, ready, "e".repeat(64)),
		/duplicate payload mismatch|identity mismatch|exists|EEXIST/i,
	);
	const replayedRelease = await releaseDurableLaunchBarrier(
		descriptor,
		ready,
		"d".repeat(64),
	);
	assert.deepEqual(replayedRelease, release);

	const ackReplacement = await createDurableLaunchBarrier({
		directory: join(root, "ack-replacement"),
		subjectSha256: "9".repeat(64),
		timeoutMs: 100,
	});
	const copiedAck = JSON.parse(await readFile(descriptor.ackPath, "utf8"));
	const copiedRelease = {
		...release,
		barrierIdentitySha256: ackReplacement.identitySha256,
		challenge: ackReplacement.challenge,
		subjectSha256: ackReplacement.subjectSha256,
	};
	const copiedReleaseBody = { ...copiedRelease };
	delete copiedReleaseBody.releaseSha256;
	copiedRelease.releaseSha256 = durableLaunchBarrierDigest(copiedReleaseBody);
	const copiedAckBody = {
		...copiedAck,
		barrierIdentitySha256: ackReplacement.identitySha256,
		challenge: ackReplacement.challenge,
		releaseSha256: copiedRelease.releaseSha256,
	};
	delete copiedAckBody.ackSha256;
	copiedAckBody.ackSha256 = durableLaunchBarrierDigest(copiedAckBody);
	await writeFile(ackReplacement.ackPath, `${JSON.stringify(copiedAckBody)}\n`, {
		mode: 0o600,
	});
	await rename(ackReplacement.directory, `${ackReplacement.directory}-original`);
	await mkdir(ackReplacement.directory, { mode: 0o700 });
	await writeFile(ackReplacement.ackPath, `${JSON.stringify(copiedAckBody)}\n`, {
		mode: 0o600,
	});
	await assert.rejects(
		waitForDurableLaunchBarrierAck(ackReplacement, copiedRelease),
		/directory was replaced/u,
	);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("durable launch barrier checks passed");
