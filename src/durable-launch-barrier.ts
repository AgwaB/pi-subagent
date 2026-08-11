import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{64}$/u;

export interface DurableLaunchBarrierDescriptor {
	schema: "pi-subagent-durable-launch-barrier-v1";
	identitySha256: string;
	directory: string;
	readyPath: string;
	releasePath: string;
	ackPath: string;
	challenge: string;
	subjectSha256: string;
	directoryIdentity: {
		device: number;
		inode: number;
		uid?: number;
	};
	timeoutMs: number;
	pollIntervalMs: number;
}

export interface DurableLaunchBarrierReady {
	schema: "pi-subagent-durable-launch-barrier-ready-v1";
	barrierIdentitySha256: string;
	challenge: string;
	subjectSha256: string;
	runId: string;
	attemptId: string;
	workerPid: number;
	workerProcessGroupId?: number;
	launchPayloadSha256: string;
	readySha256: string;
}

export interface DurableLaunchBarrierRelease {
	schema: "pi-subagent-durable-launch-barrier-release-v1";
	barrierIdentitySha256: string;
	challenge: string;
	subjectSha256: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	releasePayloadSha256: string;
	releaseSha256: string;
}

export interface DurableLaunchBarrierAck {
	schema: "pi-subagent-durable-launch-barrier-ack-v1";
	barrierIdentitySha256: string;
	challenge: string;
	runId: string;
	attemptId: string;
	readySha256: string;
	releaseSha256: string;
	ackSha256: string;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) =>
					left < right ? -1 : left > right ? 1 : 0,
				)
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonical(value));
}

export function durableLaunchBarrierDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertSha256(label: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || !SHA256.test(value))
		throw new Error(`${label} is not SHA-256`);
}

function assertNonEmpty(label: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${label} is empty`);
}

function assertPositiveInteger(
	label: string,
	value: unknown,
	minimum: number,
	maximum: number,
): asserts value is number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new Error(`${label} is outside the supported range`);
}

async function assertOwnerOnlyDirectory(
	path: string,
	expected?: DurableLaunchBarrierDescriptor["directoryIdentity"],
): Promise<DurableLaunchBarrierDescriptor["directoryIdentity"]> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error("durable launch barrier directory is not a real directory");
	if ((info.mode & 0o777) !== 0o700)
		throw new Error("durable launch barrier directory is not owner-only 0700");
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && info.uid !== uid)
		throw new Error("durable launch barrier directory owner mismatch");
	const identity = {
		device: info.dev,
		inode: info.ino,
		...(uid === undefined ? {} : { uid }),
	};
	if (
		expected !== undefined &&
		(expected.device !== identity.device ||
			expected.inode !== identity.inode ||
			expected.uid !== identity.uid)
	)
		throw new Error("durable launch barrier directory was replaced");
	return identity;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeDurableExclusive(path: string, value: unknown): Promise<void> {
	const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	const handle = await open(
		temporary,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			(constants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await link(temporary, path);
		await rm(temporary);
		await syncDirectory(resolve(path, ".."));
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function readStrictJson(path: string): Promise<unknown> {
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (info.nlink === 2) {
			const transient = new Error(
				"durable launch barrier file commit is still in progress",
			) as NodeJS.ErrnoException;
			transient.code = "EAGAIN";
			throw transient;
		}
		if (
			!info.isFile() ||
			info.nlink !== 1 ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new Error("durable launch barrier file identity mismatch");
		return JSON.parse((await handle.readFile()).toString("utf8"));
	} finally {
		await handle.close();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForFile(
	descriptor: DurableLaunchBarrierDescriptor,
	path: string,
): Promise<unknown> {
	const deadline = Date.now() + descriptor.timeoutMs;
	while (Date.now() <= deadline) {
		const value = await readStrictJson(path).catch(
			(error: NodeJS.ErrnoException) => {
				if (error?.code === "ENOENT" || error?.code === "EAGAIN")
					return undefined;
				throw error;
			},
		);
		if (value !== undefined) return value;
		await sleep(descriptor.pollIntervalMs);
	}
	throw new Error("durable launch barrier timed out");
}

export async function createDurableLaunchBarrier(options: {
	directory: string;
	subjectSha256: string;
	challenge?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}): Promise<DurableLaunchBarrierDescriptor> {
	if (!isAbsolute(options.directory))
		throw new Error("durable launch barrier directory must be absolute");
	assertSha256("durable launch barrier subject", options.subjectSha256);
	const challenge = options.challenge ?? randomBytes(32).toString("hex");
	if (!NONCE.test(challenge))
		throw new Error("durable launch barrier challenge is invalid");
	const directory = resolve(options.directory);
	await mkdir(directory, { mode: 0o700 });
	const directoryIdentity = await assertOwnerOnlyDirectory(directory);
	const body = {
		schema: "pi-subagent-durable-launch-barrier-v1" as const,
		directory,
		readyPath: join(directory, "ready.json"),
		releasePath: join(directory, "release.json"),
		ackPath: join(directory, "ack.json"),
		challenge,
		subjectSha256: options.subjectSha256,
		directoryIdentity,
		timeoutMs: options.timeoutMs ?? 30_000,
		pollIntervalMs: options.pollIntervalMs ?? 10,
	};
	assertPositiveInteger("durable launch barrier timeout", body.timeoutMs, 100, 120_000);
	assertPositiveInteger("durable launch barrier poll interval", body.pollIntervalMs, 1, 1_000);
	return Object.freeze({
		...body,
		identitySha256: durableLaunchBarrierDigest(body),
	});
}

export function assertDurableLaunchBarrierDescriptor(
	value: unknown,
): asserts value is DurableLaunchBarrierDescriptor {
	if (!value || typeof value !== "object")
		throw new Error("durable launch barrier descriptor is invalid");
	const descriptor = value as DurableLaunchBarrierDescriptor;
	if (descriptor.schema !== "pi-subagent-durable-launch-barrier-v1")
		throw new Error("durable launch barrier schema mismatch");
	if (!isAbsolute(descriptor.directory) || resolve(descriptor.directory) !== descriptor.directory)
		throw new Error("durable launch barrier directory identity mismatch");
	if (!NONCE.test(descriptor.challenge))
		throw new Error("durable launch barrier challenge is invalid");
	assertSha256("durable launch barrier subject", descriptor.subjectSha256);
	assertSha256("durable launch barrier identity", descriptor.identitySha256);
	assertPositiveInteger("durable launch barrier timeout", descriptor.timeoutMs, 100, 120_000);
	assertPositiveInteger("durable launch barrier poll interval", descriptor.pollIntervalMs, 1, 1_000);
	assertPositiveInteger(
		"durable launch barrier directory device",
		descriptor.directoryIdentity?.device,
		0,
		Number.MAX_SAFE_INTEGER,
	);
	assertPositiveInteger(
		"durable launch barrier directory inode",
		descriptor.directoryIdentity?.inode,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	if (descriptor.directoryIdentity.uid !== undefined)
		assertPositiveInteger(
			"durable launch barrier directory uid",
			descriptor.directoryIdentity.uid,
			0,
			Number.MAX_SAFE_INTEGER,
		);
	if (
		descriptor.readyPath !== join(descriptor.directory, "ready.json") ||
		descriptor.releasePath !== join(descriptor.directory, "release.json") ||
		descriptor.ackPath !== join(descriptor.directory, "ack.json")
	)
		throw new Error("durable launch barrier path identity mismatch");
	const { identitySha256, ...body } = descriptor;
	if (durableLaunchBarrierDigest(body) !== identitySha256)
		throw new Error("durable launch barrier identity digest mismatch");
}

function assertReady(
	descriptor: DurableLaunchBarrierDescriptor,
	value: unknown,
): DurableLaunchBarrierReady {
	if (!value || typeof value !== "object")
		throw new Error("durable launch barrier ready record is invalid");
	const ready = value as DurableLaunchBarrierReady;
	const { readySha256, ...body } = ready;
	if (
		ready.schema !== "pi-subagent-durable-launch-barrier-ready-v1" ||
		ready.barrierIdentitySha256 !== descriptor.identitySha256 ||
		ready.challenge !== descriptor.challenge ||
		ready.subjectSha256 !== descriptor.subjectSha256 ||
		!Number.isSafeInteger(ready.workerPid) ||
		ready.workerPid <= 0 ||
		(ready.workerProcessGroupId !== undefined &&
			(!Number.isSafeInteger(ready.workerProcessGroupId) ||
				ready.workerProcessGroupId <= 0))
	)
		throw new Error("durable launch barrier ready record mismatch");
	assertNonEmpty("durable launch barrier run id", ready.runId);
	assertNonEmpty("durable launch barrier attempt id", ready.attemptId);
	assertSha256("durable launch barrier payload", ready.launchPayloadSha256);
	assertSha256("durable launch barrier ready digest", readySha256);
	if (durableLaunchBarrierDigest(body) !== readySha256)
		throw new Error("durable launch barrier ready digest mismatch");
	return ready;
}

export async function waitForDurableLaunchBarrierReady(
	descriptor: DurableLaunchBarrierDescriptor,
): Promise<DurableLaunchBarrierReady> {
	assertDurableLaunchBarrierDescriptor(descriptor);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	return assertReady(descriptor, await waitForFile(descriptor, descriptor.readyPath));
}

export async function releaseDurableLaunchBarrier(
	descriptor: DurableLaunchBarrierDescriptor,
	ready: DurableLaunchBarrierReady,
	releasePayloadSha256: string,
): Promise<DurableLaunchBarrierRelease> {
	assertDurableLaunchBarrierDescriptor(descriptor);
	assertReady(descriptor, ready);
	assertSha256("durable launch barrier release payload", releasePayloadSha256);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	const body = {
		schema: "pi-subagent-durable-launch-barrier-release-v1" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		subjectSha256: descriptor.subjectSha256,
		runId: ready.runId,
		attemptId: ready.attemptId,
		readySha256: ready.readySha256,
		releasePayloadSha256,
	};
	const release = {
		...body,
		releaseSha256: durableLaunchBarrierDigest(body),
	};
	await writeDurableExclusive(descriptor.releasePath, release);
	return release;
}

function assertRelease(
	descriptor: DurableLaunchBarrierDescriptor,
	ready: DurableLaunchBarrierReady,
	value: unknown,
): DurableLaunchBarrierRelease {
	if (!value || typeof value !== "object")
		throw new Error("durable launch barrier release record is invalid");
	const release = value as DurableLaunchBarrierRelease;
	const { releaseSha256, ...body } = release;
	if (
		release.schema !== "pi-subagent-durable-launch-barrier-release-v1" ||
		release.barrierIdentitySha256 !== descriptor.identitySha256 ||
		release.challenge !== descriptor.challenge ||
		release.subjectSha256 !== descriptor.subjectSha256 ||
		release.runId !== ready.runId ||
		release.attemptId !== ready.attemptId ||
		release.readySha256 !== ready.readySha256
	)
		throw new Error("durable launch barrier release record mismatch");
	assertSha256("durable launch barrier release payload", release.releasePayloadSha256);
	assertSha256("durable launch barrier release digest", releaseSha256);
	if (durableLaunchBarrierDigest(body) !== releaseSha256)
		throw new Error("durable launch barrier release digest mismatch");
	return release;
}

export async function awaitDurableLaunchBarrier(options: {
	descriptor: DurableLaunchBarrierDescriptor;
	runId: string;
	attemptId: string;
	launchPayloadSha256: string;
	workerProcessGroupId?: number;
}): Promise<DurableLaunchBarrierAck> {
	const { descriptor } = options;
	assertDurableLaunchBarrierDescriptor(descriptor);
	assertNonEmpty("durable launch barrier run id", options.runId);
	assertNonEmpty("durable launch barrier attempt id", options.attemptId);
	assertSha256("durable launch barrier payload", options.launchPayloadSha256);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	const readyBody = {
		schema: "pi-subagent-durable-launch-barrier-ready-v1" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		subjectSha256: descriptor.subjectSha256,
		runId: options.runId,
		attemptId: options.attemptId,
		workerPid: process.pid,
		...(options.workerProcessGroupId === undefined
			? {}
			: { workerProcessGroupId: options.workerProcessGroupId }),
		launchPayloadSha256: options.launchPayloadSha256,
	};
	const ready = {
		...readyBody,
		readySha256: durableLaunchBarrierDigest(readyBody),
	};
	await writeDurableExclusive(descriptor.readyPath, ready);
	const release = assertRelease(
		descriptor,
		ready,
		await waitForFile(descriptor, descriptor.releasePath),
	);
	const ackBody = {
		schema: "pi-subagent-durable-launch-barrier-ack-v1" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		runId: options.runId,
		attemptId: options.attemptId,
		readySha256: ready.readySha256,
		releaseSha256: release.releaseSha256,
	};
	const ack = { ...ackBody, ackSha256: durableLaunchBarrierDigest(ackBody) };
	await writeDurableExclusive(descriptor.ackPath, ack);
	return ack;
}

export async function waitForDurableLaunchBarrierAck(
	descriptor: DurableLaunchBarrierDescriptor,
	release: DurableLaunchBarrierRelease,
): Promise<DurableLaunchBarrierAck> {
	assertDurableLaunchBarrierDescriptor(descriptor);
	const value = await waitForFile(descriptor, descriptor.ackPath);
	if (!value || typeof value !== "object")
		throw new Error("durable launch barrier acknowledgement is invalid");
	const ack = value as DurableLaunchBarrierAck;
	const { ackSha256, ...body } = ack;
	if (
		ack.schema !== "pi-subagent-durable-launch-barrier-ack-v1" ||
		ack.barrierIdentitySha256 !== descriptor.identitySha256 ||
		ack.challenge !== descriptor.challenge ||
		ack.runId !== release.runId ||
		ack.attemptId !== release.attemptId ||
		ack.readySha256 !== release.readySha256 ||
		ack.releaseSha256 !== release.releaseSha256
	)
		throw new Error("durable launch barrier acknowledgement mismatch");
	assertSha256("durable launch barrier acknowledgement digest", ackSha256);
	if (durableLaunchBarrierDigest(body) !== ackSha256)
		throw new Error("durable launch barrier acknowledgement digest mismatch");
	return ack;
}
