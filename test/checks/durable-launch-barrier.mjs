#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
	assertDurableLaunchBarrierV2ExecutionAuthorized,
	createDurableLaunchBarrier,
	createDurableLaunchBarrierV2,
	durableLaunchBarrierDigest,
	readDurableLaunchBarrierV2State,
	releaseDurableLaunchBarrier,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
	waitForDurableLaunchBarrierAck,
	waitForDurableLaunchBarrierReady,
	waitForDurableLaunchBarrierV2Ack,
	waitForDurableLaunchBarrierV2Ready,
} from "../../src/durable-launch-barrier.ts";
import { validateResolveInput } from "../../src/core/validation.ts";
import { checkTransactionTempAliasRace } from "../fixtures/barrier-temp-alias-race.mjs";

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

	// TEST-ONLY dependency substitution: production code still imports the real
	// lstat; Jiti replaces only that builtin dependency for both source variants.
	let injectedLstat = lstat;
	const lstatModulePath = join(root, "durable-barrier-fs-promises.mjs");
	await writeFile(
		lstatModulePath,
		'export * from "node:fs/promises";\nexport const lstat = (...args) => globalThis.__durableBarrierTestLstat(...args);\n',
	);
	globalThis.__durableBarrierTestLstat = (...args) => injectedLstat(...args);
	const instrumentedJiti = createJiti(import.meta.url, {
		interopDefault: true,
		moduleCache: false,
	});
	const instrumentedSourcePath = join(root, "durable-launch-barrier.instrumented.ts");
	const instrumentedSource = (await readFile(
		resolve("src/durable-launch-barrier.ts"),
		"utf8",
	)).replaceAll(
		'from "node:fs/promises"',
		`from "${pathToFileURL(lstatModulePath).href}"`,
	);
	await writeFile(instrumentedSourcePath, instrumentedSource);
	const instrumentedBarrier = await instrumentedJiti.import(instrumentedSourcePath);
	const {
		createDurableLaunchBarrierV2: createInstrumentedBarrierV2,
		readDurableLaunchBarrierV2State: readInstrumentedState,
	} = instrumentedBarrier;
	const interleaveBarrier = await createInstrumentedBarrierV2({
		directory: join(root, "pending-interleave-barrier"),
		subjectSha256: "6".repeat(64),
		authorityBindingSha256: "7".repeat(64),
		timeoutMs: 100,
	});
	const fixture = join(root, "pending-lstat-fixture");
	await writeFile(fixture, "fixture\n", { mode: 0o600 });
	const realPendingLstat = lstat;
	let sequenceCalls = 0;
	const runPendingSequence = async (first, second, third) => {
		let calls = 0;
		injectedLstat = async (path) => {
			if (path !== `${interleaveBarrier.readyPath}.pending`)
				return realPendingLstat(path);
			calls += 1;
			if (calls === 1) return first();
			if (calls === 2) return second();
			if (calls === 3 && third !== undefined) return third();
			const error = new Error("injected missing pending");
			error.code = "ENOENT";
			throw error;
		};
		try {
			return await readInstrumentedState(interleaveBarrier);
		} finally {
			sequenceCalls = calls;
			injectedLstat = realPendingLstat;
		}
	};
	const staleInfo = await realPendingLstat(fixture);
	Object.defineProperty(staleInfo, "nlink", { value: 0 });
	assert.deepEqual(await runPendingSequence(() => staleInfo, () => staleInfo), {});
	await assert.rejects(
		runPendingSequence(() => staleInfo, () => staleInfo, () => staleInfo),
		/durable launch barrier pending fence identity mismatch/u,
	);
	const validInfo = await realPendingLstat(fixture);
	assert.deepEqual(
		await runPendingSequence(
			() => staleInfo,
			() => validInfo,
			() => validInfo,
		),
		{},
	);
	await assert.rejects(
		runPendingSequence(async () => {
			const error = new Error("injected permission failure");
			error.code = "EACCES";
			throw error;
		}, () => validInfo),
		(error) => error?.code === "EACCES",
	);
	const invalidCases = [
		["mode", async () => {
			await chmod(fixture, 0o644);
			return realPendingLstat(fixture);
		}],
		["nlink", async () => {
			const alias = `${fixture}.alias`;
			await link(fixture, alias);
			const info = await realPendingLstat(fixture);
			await rm(alias);
			return info;
		}],
		["uid", async () => {
			const info = await realPendingLstat(fixture);
			Object.defineProperty(info, "uid", { value: (info.uid ?? 0) + 1 });
			return info;
		}],
		["nonregular", async () => realPendingLstat(root)],
		["symlink", async () => {
			const alias = `${fixture}.symlink`;
			await symlink(fixture, alias);
			const info = await realPendingLstat(alias);
			await rm(alias);
			return info;
		}],
	];
	for (const [label, makeInvalid] of invalidCases) {
		await chmod(fixture, 0o600);
		await assert.rejects(
			runPendingSequence(makeInvalid, () => validInfo),
			/durable launch barrier pending fence identity mismatch/u,
			label,
		);
		assert.equal(sequenceCalls, 1, `${label} must reject before a later safe observation`);
	}
	delete globalThis.__durableBarrierTestLstat;
	await rm(fixture);

	const deletedBarrier = await createDurableLaunchBarrier({
		directory: join(root, "deleted-barrier"),
		subjectSha256: "8".repeat(64),
		timeoutMs: 100,
	});
	await rm(deletedBarrier.directory, { recursive: true, force: true });
	await assert.rejects(
		waitForDurableLaunchBarrierReady(deletedBarrier),
		(error) =>
			error?.failureKind === "guard_failure" && /ENOENT/u.test(error.message),
	);

	for (const [index, prefix] of [
		Buffer.alloc(0),
		Buffer.from('{"schema":'),
	].entries()) {
		const crashBarrier = await createDurableLaunchBarrier({
			directory: join(root, `crash-barrier-${index}`),
			subjectSha256: "7".repeat(64),
			timeoutMs: 100,
		});
		await writeFile(`${crashBarrier.releasePath}.pending`, "pending\n", {
			mode: 0o600,
		});
		const crashedTempPath = `${crashBarrier.releasePath}.txn.crashed.tmp`;
		await writeFile(crashedTempPath, prefix, { mode: 0o600 });
		const fakeReadyBody = {
			schema: "pi-subagent-durable-launch-barrier-ready-v1",
			barrierIdentitySha256: crashBarrier.identitySha256,
			challenge: crashBarrier.challenge,
			subjectSha256: crashBarrier.subjectSha256,
			runId: `run-crash-${index}`,
			attemptId: `attempt-crash-${index}`,
			workerPid: process.pid,
			launchPayloadSha256: "6".repeat(64),
			executionPlanSha256: "3".repeat(64),
		};
		const fakeReady = {
			...fakeReadyBody,
			readySha256: durableLaunchBarrierDigest(fakeReadyBody),
		};
		if (index === 1) {
			await rm(crashedTempPath);
			const expectedReleaseBody = {
				schema: "pi-subagent-durable-launch-barrier-release-v1",
				barrierIdentitySha256: crashBarrier.identitySha256,
				challenge: crashBarrier.challenge,
				subjectSha256: crashBarrier.subjectSha256,
				runId: fakeReady.runId,
				attemptId: fakeReady.attemptId,
				readySha256: fakeReady.readySha256,
				releasePayloadSha256: "4".repeat(64),
			};
			const expectedRelease = {
				...expectedReleaseBody,
				releaseSha256: durableLaunchBarrierDigest(expectedReleaseBody),
			};
			await writeFile(
				crashedTempPath,
				`${JSON.stringify(canonical(expectedRelease))}\n`,
				{ mode: 0o600 },
			);
			await link(crashedTempPath, `${crashBarrier.releasePath}.txn`);
		}
		const recovered = await releaseDurableLaunchBarrier(
			crashBarrier,
			fakeReady,
			"4".repeat(64),
		);
		assert.equal(recovered.readySha256, fakeReady.readySha256);
		await assert.rejects(access(`${crashBarrier.releasePath}.pending`));
		if (index === 1) await assert.rejects(access(crashedTempPath));
	}

	const abortedBarrier = await createDurableLaunchBarrier({
		directory: join(root, "aborted-barrier"),
		subjectSha256: "2".repeat(64),
		timeoutMs: 100,
	});
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		import("../../src/durable-launch-barrier.ts").then(
			({ awaitDurableLaunchBarrier }) =>
				awaitDurableLaunchBarrier({
					descriptor: abortedBarrier,
					runId: "run-aborted",
					attemptId: "attempt-aborted",
					launchPayloadSha256: "1".repeat(64),
					executionPlanSha256: "0".repeat(64),
					signal: aborted.signal,
				}),
		),
		/aborted before ready/u,
	);
	await assert.rejects(access(abortedBarrier.readyPath));
	await assert.rejects(access(abortedBarrier.ackPath));

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
	assert.equal(ready.executionPlanSha256, "e".repeat(64));
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
	const concurrentReleases = await Promise.all(
		Array.from({ length: 8 }, () =>
			releaseDurableLaunchBarrier(descriptor, ready, "d".repeat(64)),
		),
	);
	assert.equal(concurrentReleases.length, 8);
	for (const concurrent of concurrentReleases)
		assert.deepEqual(concurrent, release);

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

	const descriptorV2 = await createDurableLaunchBarrierV2({
		directory: join(root, "barrier-v2-release"),
		subjectSha256: "1".repeat(64),
		authorityBindingSha256: "2".repeat(64),
		timeoutMs: 15_000,
		pollIntervalMs: 5,
	});
	assert.equal(
		validateResolveInput({
			backend: "headless",
			task: "fixture-v2",
			async: true,
			durableLaunchBarrier: descriptorV2,
		}).ok,
		true,
	);
	const descriptorV2Path = join(root, "descriptor-v2.json");
	const markerV2Path = join(root, "released-v2.txt");
	await writeFile(
		descriptorV2Path,
		`${JSON.stringify(descriptorV2)}\n`,
		"utf8",
	);
	const childV2 = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../fixtures/durable-launch-barrier-worker.mjs"),
			descriptorV2Path,
			markerV2Path,
			"run-v2-release",
			"attempt-v2-release",
			"3".repeat(64),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const childV2Output = [];
	childV2.stdout.on("data", (chunk) => childV2Output.push(chunk));
	childV2.stderr.on("data", (chunk) => childV2Output.push(chunk));
	const childV2Exit = new Promise((resolveExit) => {
		childV2.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
	const readyV2 = await waitForDurableLaunchBarrierV2Ready(descriptorV2);
	assert.equal(readyV2.runId, "run-v2-release");
	assert.equal(readyV2.executionPlanSha256, "e".repeat(64));
	const releasedV2 = await resolveDurableLaunchBarrierV2Release(
		descriptorV2,
		readyV2,
		"4".repeat(64),
	);
	assert.equal(releasedV2.outcome, "released");
	assert.equal(releasedV2.decision.kind, "released");
	const ackV2 = await waitForDurableLaunchBarrierV2Ack(
		descriptorV2,
		releasedV2.decision,
	);
	assert.equal(ackV2.decisionSha256, releasedV2.decision.decisionSha256);
	assert.equal(
		(await assertDurableLaunchBarrierV2ExecutionAuthorized(
			descriptorV2,
			ackV2,
		)).decisionSha256,
		releasedV2.decision.decisionSha256,
	);
	assert.deepEqual(
		await childV2Exit,
		{ code: 0, signal: null },
		Buffer.concat(childV2Output).toString(),
	);
	assert.equal(await readFile(markerV2Path, "utf8"), "released\n");
	const revokeAfterRelease = await revokeDurableLaunchBarrierV2(descriptorV2, {
		cancellationId: "cancel-after-release",
		reasonSha256: "5".repeat(64),
	});
	assert.equal(revokeAfterRelease.outcome, "released");
	assert.equal(
		(await readDurableLaunchBarrierV2State(descriptorV2)).decision
			?.decisionSha256,
		releasedV2.decision.decisionSha256,
	);

	const revokedV2 = await createDurableLaunchBarrierV2({
		directory: join(root, "barrier-v2-revoke"),
		subjectSha256: "6".repeat(64),
		timeoutMs: 15_000,
		pollIntervalMs: 5,
	});
	const revokedV2Path = join(root, "descriptor-v2-revoke.json");
	const revokedMarkerPath = join(root, "revoked-v2-marker.txt");
	await writeFile(revokedV2Path, `${JSON.stringify(revokedV2)}\n`, "utf8");
	const revokedChild = spawn(
		process.execPath,
		[
			join(import.meta.dirname, "../fixtures/durable-launch-barrier-worker.mjs"),
			revokedV2Path,
			revokedMarkerPath,
			"run-v2-revoke",
			"attempt-v2-revoke",
			"7".repeat(64),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const revokedExit = new Promise((resolveExit) => {
		revokedChild.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
	const revokedReady = await waitForDurableLaunchBarrierV2Ready(revokedV2);
	const revokeWinner = await revokeDurableLaunchBarrierV2(revokedV2, {
		cancellationId: "cancel-before-release",
		reasonSha256: "8".repeat(64),
	});
	assert.equal(revokeWinner.outcome, "revoked");
	const releaseAfterRevoke = await resolveDurableLaunchBarrierV2Release(
		revokedV2,
		revokedReady,
		"9".repeat(64),
	);
	assert.equal(releaseAfterRevoke.outcome, "revoked");
	const revokedChildExit = await revokedExit;
	assert.notEqual(revokedChildExit.code, 0);
	await assert.rejects(access(revokedMarkerPath));
	const revokedState = await readDurableLaunchBarrierV2State(revokedV2);
	assert.equal(revokedState.decision?.kind, "revoked");
	assert.equal(revokedState.ack, undefined);

	for (const [winner, finalLinked] of [
		["released", true],
		["revoked", true],
		["released", false],
		["revoked", false],
	]) {
		const crashV2 = await createDurableLaunchBarrierV2({
			directory: join(root, `barrier-v2-crash-${winner}-${finalLinked}`),
			subjectSha256: "a".repeat(64),
			timeoutMs: 500,
			pollIntervalMs: 5,
		});
		const readyBody = {
			schema: "pi-subagent-durable-launch-barrier-ready-v2",
			barrierIdentitySha256: crashV2.identitySha256,
			challenge: crashV2.challenge,
			decisionNonce: crashV2.decisionNonce,
			subjectSha256: crashV2.subjectSha256,
			runId: `run-crash-${winner}-${finalLinked}`,
			attemptId: `attempt-crash-${winner}-${finalLinked}`,
			workerPid: process.pid,
			launchPayloadSha256: "b".repeat(64),
			executionPlanSha256: "c".repeat(64),
		};
		const crashReady = {
			...readyBody,
			readySha256: durableLaunchBarrierDigest(readyBody),
		};
		await writeFile(
			crashV2.readyPath,
			`${JSON.stringify(canonical(crashReady))}\n`,
			{ mode: 0o600 },
		);
		const decisionBody =
			winner === "released"
				? {
						schema: "pi-subagent-durable-launch-barrier-decision-v2",
						kind: "released",
						barrierIdentitySha256: crashV2.identitySha256,
						challenge: crashV2.challenge,
						decisionNonce: crashV2.decisionNonce,
						subjectSha256: crashV2.subjectSha256,
						runId: crashReady.runId,
						attemptId: crashReady.attemptId,
						readySha256: crashReady.readySha256,
						releasePayloadSha256: "d".repeat(64),
					}
				: {
						schema: "pi-subagent-durable-launch-barrier-decision-v2",
						kind: "revoked",
						barrierIdentitySha256: crashV2.identitySha256,
						challenge: crashV2.challenge,
						decisionNonce: crashV2.decisionNonce,
						subjectSha256: crashV2.subjectSha256,
						cancellationId: "crashed-revocation",
						reasonSha256: "e".repeat(64),
					};
		const crashDecision = {
			...decisionBody,
			decisionSha256: durableLaunchBarrierDigest(decisionBody),
		};
		const transactionPath = `${crashV2.decisionPath}.txn`;
		await writeFile(
			transactionPath,
			`${JSON.stringify(canonical(crashDecision))}\n`,
			{ mode: 0o600 },
		);
		if (finalLinked) await link(transactionPath, crashV2.decisionPath);
		await writeFile(`${crashV2.decisionPath}.pending`, "pending\n", {
			mode: 0o600,
		});
		const recoveredWinner =
			winner === "released"
				? await revokeDurableLaunchBarrierV2(crashV2, {
						cancellationId: "opposite-revocation",
						reasonSha256: "f".repeat(64),
					})
				: await resolveDurableLaunchBarrierV2Release(
						crashV2,
						crashReady,
						"0".repeat(64),
					);
		assert.equal(recoveredWinner.outcome, winner);
		assert.equal(
			recoveredWinner.decision.decisionSha256,
			crashDecision.decisionSha256,
		);
		await assert.rejects(access(`${crashV2.decisionPath}.pending`));
	}
	await checkTransactionTempAliasRace(root);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("durable launch barrier checks passed");
