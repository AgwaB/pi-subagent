#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	captureProcessIdentity,
	inspectProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";

const sourcePath = fileURLToPath(
	new URL("../../src/native/darwin-process-identity.c", import.meta.url),
);
const binaryPath = fileURLToPath(
	new URL("../../src/native/darwin-process-identity", import.meta.url),
);
const manifestPath = fileURLToPath(
	new URL(
		"../../src/native/darwin-process-identity.manifest.json",
		import.meta.url,
	),
);
const [source, binary, manifestText, binaryStat] = await Promise.all([
	readFile(sourcePath),
	readFile(binaryPath),
	readFile(manifestPath, "utf8"),
	stat(binaryPath),
]);
const manifest = JSON.parse(manifestText);
const sha256 = (bytes) =>
	createHash("sha256").update(bytes).digest("hex");

assert.equal(
	manifest.schema,
	"pi-subagent-darwin-process-identity-helper-v1",
);
assert.equal(manifest.sourceSha256, sha256(source));
assert.equal(manifest.binarySha256, sha256(binary));
assert.deepEqual(manifest.architectures, ["arm64", "x86_64"]);
assert.equal(manifest.minimumMacOS, "11.0");
assert.match(manifest.compilerVersion, /clang/u);
assert.match(manifest.sdkVersion, /^\d+(?:\.\d+)+$/u);
assert.notEqual(binaryStat.mode & 0o111, 0, "native helper must be executable");

assert.equal(binary.readUInt32BE(0), 0xcafebabe);
const architectureCount = binary.readUInt32BE(4);
assert.equal(architectureCount, 2);
const cpuTypes = new Set();
for (let index = 0; index < architectureCount; index += 1) {
	const architectureOffset = 8 + index * 20;
	const cpuType = binary.readUInt32BE(architectureOffset);
	const sliceOffset = binary.readUInt32BE(architectureOffset + 8);
	const sliceSize = binary.readUInt32BE(architectureOffset + 12);
	cpuTypes.add(cpuType);
	assert.ok(sliceOffset + sliceSize <= binary.length);
	assert.equal(binary.readUInt32LE(sliceOffset), 0xfeedfacf);
	assert.equal(binary.readUInt32LE(sliceOffset + 4), cpuType);
	const commandCount = binary.readUInt32LE(sliceOffset + 16);
	const commandsSize = binary.readUInt32LE(sliceOffset + 20);
	const commandsEnd = sliceOffset + 32 + commandsSize;
	assert.ok(commandsEnd <= sliceOffset + sliceSize);
	let commandOffset = sliceOffset + 32;
	let buildVersionFound = false;
	for (let commandIndex = 0; commandIndex < commandCount; commandIndex += 1) {
		const command = binary.readUInt32LE(commandOffset);
		const commandSize = binary.readUInt32LE(commandOffset + 4);
		assert.ok(commandSize >= 8);
		assert.ok(commandOffset + commandSize <= commandsEnd);
		if (command === 0x32) {
			assert.equal(binary.readUInt32LE(commandOffset + 8), 1);
			assert.equal(binary.readUInt32LE(commandOffset + 12), 0x000b0000);
			buildVersionFound = true;
		}
		commandOffset += commandSize;
	}
	assert.equal(commandOffset, commandsEnd);
	assert.equal(buildVersionFound, true);
}
assert.deepEqual(cpuTypes, new Set([0x01000007, 0x0100000c]));

if (process.platform === "darwin") {
	assert.deepEqual(await inspectProcessIdentity(-1), {
		state: "unknown",
		reason: "process pid is invalid",
	});
	assert.deepEqual(await inspectProcessIdentity(99_999_999), { state: "dead" });
	const identity = await captureProcessIdentity(process.pid);
	assert.match(identity.birthIdentity, /^darwin:\d+:\d{6}$/u);
	assert.equal(await verifyProcessIdentity(identity), "alive");

	let sameSecondPair;
	for (let attempt = 0; attempt < 20 && sameSecondPair === undefined; attempt += 1) {
		const children = [
			spawn("/bin/sleep", ["30"], { stdio: "ignore" }),
			spawn("/bin/sleep", ["30"], { stdio: "ignore" }),
		];
		try {
			const identities = await Promise.all(
				children.map((child) => {
					assert.equal(typeof child.pid, "number");
					return captureProcessIdentity(child.pid);
				}),
			);
			const firstStartSecond = identities[0].birthIdentity.split(":")[1];
			const secondStartSecond = identities[1].birthIdentity.split(":")[1];
			if (firstStartSecond === secondStartSecond) sameSecondPair = identities;
		} finally {
			for (const child of children)
				if (child.pid !== undefined)
					try {
						process.kill(child.pid, "SIGKILL");
					} catch {
						// Child already exited.
					}
		}
	}
	assert.ok(sameSecondPair, "expected two probe processes born in one second");
	assert.notEqual(
		sameSecondPair[0].birthIdentity,
		sameSecondPair[1].birthIdentity,
		"microsecond identity must distinguish same-second process births",
	);

	const zombieParent = spawn(
		"/usr/bin/perl",
		[
			"-e",
			"$|=1; my $child=fork(); if ($child == 0) { exit 0; } print qq{$child\\n}; sleep 30;",
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		const [chunk] = await once(zombieParent.stdout, "data");
		const zombiePid = Number(String(chunk).trim());
		assert.ok(Number.isSafeInteger(zombiePid) && zombiePid > 0);
		let zombieState;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			zombieState = await inspectProcessIdentity(zombiePid);
			if (zombieState.state === "dead") break;
			assert.notEqual(zombieState.state, "unknown");
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
		}
		assert.deepEqual(zombieState, { state: "dead" });
	} finally {
		try {
			zombieParent.kill("SIGKILL");
		} catch {
			// Parent already exited.
		}
	}
}

console.log(
	JSON.stringify(
		{
			name: "check-darwin-process-identity-helper",
			status: "completed",
			architectures: manifest.architectures,
		},
		null,
		2,
	),
);
