import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import {
	createDurableLaunchBarrierV2,
	durableLaunchBarrierDigest,
	readDurableLaunchBarrierV2State,
	resolveDurableLaunchBarrierV2Release,
	revokeDurableLaunchBarrierV2,
} from "../../src/durable-launch-barrier.ts";

async function readyFixture(directory) {
	const descriptor = await createDurableLaunchBarrierV2({
		directory,
		subjectSha256: "a".repeat(64),
		authorityBindingSha256: "b".repeat(64),
		timeoutMs: 5000,
		pollIntervalMs: 2,
	});
	const body = {
		schema: "pi-subagent-durable-launch-barrier-ready-v2",
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		decisionNonce: descriptor.decisionNonce,
		subjectSha256: descriptor.subjectSha256,
		authorityBindingSha256: descriptor.authorityBindingSha256,
		runId: "run-temp-alias",
		attemptId: "attempt-temp-alias",
		workerPid: process.pid,
		launchPayloadSha256: "c".repeat(64),
		executionPlanSha256: "d".repeat(64),
	};
	const ready = { ...body, readySha256: durableLaunchBarrierDigest(body) };
	await fs.writeFile(descriptor.readyPath, JSON.stringify(ready), { flag: "wx", mode: 0o600 });
	return { descriptor, ready };
}

export async function checkTransactionTempAliasRace(root) {
	for (const permissionFailure of [false, true]) {
		const { descriptor, ready } = await readyFixture(join(root, `alias-race-${permissionFailure}`));
		const transaction = `${descriptor.decisionPath}.txn`;
		const alias = `${transaction}.${process.pid}.${randomUUID()}.tmp`;
		const unrelated = `${transaction}.${process.pid}.unrelated.tmp`;
		await fs.writeFile(unrelated, "different inode", { flag: "wx", mode: 0o600 });
		const originalReaddir = fs.readdir;
		const originalRm = fs.rm;
		let inserted = false;
		let raced = false;
		fs.readdir = async (directory, options) => {
			if (!inserted && resolve(String(directory)) === resolve(descriptor.directory)) {
				// Emulate another writer's still-visible temporary alias.
				await fs.link(transaction, alias);
				inserted = true;
			}
			return originalReaddir(directory, options);
		};
		fs.rm = async (path, options) => {
			if (String(path) === alias) {
				raced = true;
				if (permissionFailure) {
					const error = new Error("synthetic alias permission failure");
					error.code = "EACCES";
					throw error;
				}
				// The owner removes it after cleanup's lstat, before cleanup's rm.
				await originalRm(alias, { force: true });
			}
			return originalRm(path, options);
		};
		syncBuiltinESMExports();
		try {
			const decision = resolveDurableLaunchBarrierV2Release(descriptor, ready, "e".repeat(64));
			if (permissionFailure) {
				await assert.rejects(decision, error => error.code === "EACCES");
			} else {
				assert.equal((await decision).outcome, "released");
				assert.equal((await readDurableLaunchBarrierV2State(descriptor)).decision.kind, "released");
				const final = await fs.lstat(descriptor.decisionPath);
				const retained = await fs.lstat(transaction);
				assert.equal(final.ino, retained.ino);
				assert.equal(final.nlink, 2, "the permanent transaction link is retained");
				await assert.rejects(fs.access(alias), { code: "ENOENT" });
			}
			assert.ok(inserted && raced, "the real alias-cleanup race seam was exercised");
			assert.equal(await fs.readFile(unrelated, "utf8"), "different inode");
		} finally {
			fs.readdir = originalReaddir;
			fs.rm = originalRm;
			syncBuiltinESMExports();
		}
	}

	for (let iteration = 0; iteration < 16; iteration++) {
		const { descriptor, ready } = await readyFixture(join(root, `alias-concurrent-${iteration}`));
		const release = () => resolveDurableLaunchBarrierV2Release(descriptor, ready, "e".repeat(64));
		const revoke = () => revokeDurableLaunchBarrierV2(descriptor, { cancellationId: "cancel", reasonSha256: "f".repeat(64) });
		const results = await Promise.allSettled(iteration % 2 ? [revoke(), release(), revoke(), release()] : [release(), revoke(), release(), revoke()]);
		for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.stack);
		assert.equal(new Set(results.map(result => result.value.decision.decisionSha256)).size, 1);
	}
}
