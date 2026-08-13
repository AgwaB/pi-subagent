import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{64}$/u;

export class DurableLaunchBarrierError extends Error {
	readonly failureKind = "guard_failure" as const;

	constructor(message: string) {
		super(message);
		this.name = "DurableLaunchBarrierError";
	}
}

export function isDurableLaunchBarrierError(
	error: unknown,
): error is DurableLaunchBarrierError {
	return error instanceof DurableLaunchBarrierError;
}

export interface DurableLaunchBarrierDescriptor {
	schema: "pi-subagent-durable-launch-barrier-v1";
	identitySha256: string;
	directory: string;
	readyPath: string;
	releasePath: string;
	ackPath: string;
	challenge: string;
	subjectSha256: string;
	/** Optional caller-verified per-run authority digest; pi-subagent binds but does not interpret it. */
	authorityBindingSha256?: string;
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
	authorityBindingSha256?: string;
	runId: string;
	attemptId: string;
	workerPid: number;
	workerProcessGroupId?: number;
	launchPayloadSha256: string;
	executionPlanSha256: string;
	readySha256: string;
}

export interface DurableLaunchBarrierRelease {
	schema: "pi-subagent-durable-launch-barrier-release-v1";
	barrierIdentitySha256: string;
	challenge: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
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
		throw new DurableLaunchBarrierError(`${label} is not SHA-256`);
}

function assertNonEmpty(label: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		throw new DurableLaunchBarrierError(`${label} is empty`);
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
		throw new DurableLaunchBarrierError(`${label} is outside the supported range`);
}

function normalizePathGuardError(error: unknown, operation: string): never {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code ?? ""))
		throw new DurableLaunchBarrierError(
			`durable launch barrier ${operation} failed guard check (${code})`,
		);
	throw error;
}

async function assertOwnerOnlyDirectory(
	path: string,
	expected?: DurableLaunchBarrierDescriptor["directoryIdentity"],
): Promise<DurableLaunchBarrierDescriptor["directoryIdentity"]> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		normalizePathGuardError(error, "directory identity");
	}
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new DurableLaunchBarrierError("durable launch barrier directory is not a real directory");
	if ((info.mode & 0o777) !== 0o700)
		throw new DurableLaunchBarrierError("durable launch barrier directory is not owner-only 0700");
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && info.uid !== uid)
		throw new DurableLaunchBarrierError("durable launch barrier directory owner mismatch");
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
		throw new DurableLaunchBarrierError("durable launch barrier directory was replaced");
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

function transientCommitError(): NodeJS.ErrnoException {
	const error = new DurableLaunchBarrierError("durable launch barrier file commit is still in progress") as NodeJS.ErrnoException;
	error.code = "EAGAIN";
	return error;
}

async function removeTransactionTempAliases(
	transactionPath: string,
): Promise<void> {
	const transactionInfo = await lstat(transactionPath);
	const directory = resolve(transactionPath, "..");
	const prefix = `${transactionPath.slice(directory.length + 1)}.`;
	for (const name of await readdir(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const candidate = join(directory, name);
		let info;
		try {
			info = await lstat(candidate);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
			throw error;
		}
		if (
			info.isFile() &&
			!info.isSymbolicLink() &&
			info.dev === transactionInfo.dev &&
			info.ino === transactionInfo.ino
		)
			await rm(candidate);
	}
}

async function assertTransactionLink(
	path: string,
	transactionPath: string,
): Promise<void> {
	const [finalInfo, transactionInfo] = await Promise.all([
		lstat(path),
		lstat(transactionPath),
	]);
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!finalInfo.isFile() ||
		finalInfo.isSymbolicLink() ||
		!transactionInfo.isFile() ||
		transactionInfo.isSymbolicLink() ||
		finalInfo.dev !== transactionInfo.dev ||
		finalInfo.ino !== transactionInfo.ino ||
		finalInfo.nlink !== 2 ||
		transactionInfo.nlink !== 2 ||
		(finalInfo.mode & 0o777) !== 0o600 ||
		(transactionInfo.mode & 0o777) !== 0o600 ||
		(uid !== undefined &&
			(finalInfo.uid !== uid || transactionInfo.uid !== uid))
	)
		throw new DurableLaunchBarrierError("durable launch barrier transaction identity mismatch");
}

async function writeDurableExclusive(
	descriptor: DurableLaunchBarrierDescriptor,
	path: string,
	value: unknown,
): Promise<void> {
	const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
	const transactionPath = `${path}.txn`;
	const temporaryPath = `${transactionPath}.${process.pid}.${randomUUID()}.tmp`;
	const pendingPath = `${path}.pending`;
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	let pending;
	try {
		pending = await open(
			pendingPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				(constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		await pending.writeFile("pending\n");
		await pending.sync();
		await pending.close();
		pending = undefined;
		await syncDirectory(descriptor.directory);
	} catch (error) {
		await pending?.close().catch(() => undefined);
		if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
	}
	let transaction;
	try {
		let temporary;
		try {
			temporary = await open(
				temporaryPath,
				constants.O_RDWR |
					constants.O_CREAT |
					constants.O_EXCL |
					(constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			await temporary.writeFile(bytes);
			await temporary.sync();
			await temporary.close();
			temporary = undefined;
			try {
				await link(temporaryPath, transactionPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			}
			await syncDirectory(descriptor.directory);
		} finally {
			await temporary?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
		await removeTransactionTempAliases(transactionPath);
		await syncDirectory(descriptor.directory);
		transaction = await open(
			transactionPath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		const transactionBytes = await transaction.readFile();
		if (!transactionBytes.equals(bytes))
			throw new DurableLaunchBarrierError(
				"durable launch barrier duplicate payload mismatch",
			);
		await transaction.sync();
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		try {
			await link(transactionPath, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		await assertTransactionLink(path, transactionPath);
		await syncDirectory(descriptor.directory);
	} finally {
		await transaction?.close();
	}
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	await rm(pendingPath, { force: true });
	await syncDirectory(descriptor.directory);
}

async function pendingCommitExists(path: string): Promise<boolean> {
	try {
		const info = await lstat(`${path}.pending`);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.nlink !== 1 ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new DurableLaunchBarrierError(
				"durable launch barrier pending fence identity mismatch",
			);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw error;
	}
}

async function readStrictJson(
	descriptor: DurableLaunchBarrierDescriptor,
	path: string,
): Promise<unknown> {
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	if (await pendingCommitExists(path)) throw transientCommitError();
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			!info.isFile() ||
			(info.nlink !== 1 && info.nlink !== 2) ||
			(info.mode & 0o777) !== 0o600 ||
			(uid !== undefined && info.uid !== uid)
		)
			throw new DurableLaunchBarrierError("durable launch barrier file identity mismatch");
		const bytes = await handle.readFile();
		let value: unknown;
		try {
			value = JSON.parse(bytes.toString("utf8"));
		} catch {
			if (info.nlink === 2) throw transientCommitError();
			throw new DurableLaunchBarrierError("durable launch barrier record is not valid JSON");
		}
		if (info.nlink === 2)
			await assertTransactionLink(path, `${path}.txn`);
		await assertOwnerOnlyDirectory(
			descriptor.directory,
			descriptor.directoryIdentity,
		);
		if (await pendingCommitExists(path)) throw transientCommitError();
		return value;
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
	signal?: AbortSignal,
): Promise<unknown> {
	const deadline = Date.now() + descriptor.timeoutMs;
	while (Date.now() <= deadline) {
		if (signal?.aborted)
			throw new DurableLaunchBarrierError(
				"durable launch barrier wait was aborted",
			);
		const value = await readStrictJson(descriptor, path).catch(
			(error: NodeJS.ErrnoException) => {
				if (error?.code === "ENOENT" || error?.code === "EAGAIN")
					return undefined;
				throw error;
			},
		);
		if (value !== undefined) return value;
		await sleep(descriptor.pollIntervalMs);
	}
	throw new DurableLaunchBarrierError("durable launch barrier timed out");
}

export async function createDurableLaunchBarrier(options: {
	directory: string;
	subjectSha256: string;
	authorityBindingSha256?: string;
	challenge?: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
}): Promise<DurableLaunchBarrierDescriptor> {
	if (!isAbsolute(options.directory))
		throw new DurableLaunchBarrierError("durable launch barrier directory must be absolute");
	assertSha256("durable launch barrier subject", options.subjectSha256);
	if (options.authorityBindingSha256 !== undefined)
		assertSha256(
			"durable launch barrier authority binding",
			options.authorityBindingSha256,
		);
	const challenge = options.challenge ?? randomBytes(32).toString("hex");
	if (!NONCE.test(challenge))
		throw new DurableLaunchBarrierError("durable launch barrier challenge is invalid");
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
		...(options.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: options.authorityBindingSha256 }),
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
		throw new DurableLaunchBarrierError("durable launch barrier descriptor is invalid");
	const descriptor = value as DurableLaunchBarrierDescriptor;
	if (descriptor.schema !== "pi-subagent-durable-launch-barrier-v1")
		throw new DurableLaunchBarrierError("durable launch barrier schema mismatch");
	if (!isAbsolute(descriptor.directory) || resolve(descriptor.directory) !== descriptor.directory)
		throw new DurableLaunchBarrierError("durable launch barrier directory identity mismatch");
	if (!NONCE.test(descriptor.challenge))
		throw new DurableLaunchBarrierError("durable launch barrier challenge is invalid");
	assertSha256("durable launch barrier subject", descriptor.subjectSha256);
	if (descriptor.authorityBindingSha256 !== undefined)
		assertSha256(
			"durable launch barrier authority binding",
			descriptor.authorityBindingSha256,
		);
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
		throw new DurableLaunchBarrierError("durable launch barrier path identity mismatch");
	const { identitySha256, ...body } = descriptor;
	if (durableLaunchBarrierDigest(body) !== identitySha256)
		throw new DurableLaunchBarrierError("durable launch barrier identity digest mismatch");
}

function assertReady(
	descriptor: DurableLaunchBarrierDescriptor,
	value: unknown,
): DurableLaunchBarrierReady {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError("durable launch barrier ready record is invalid");
	const ready = value as DurableLaunchBarrierReady;
	const { readySha256, ...body } = ready;
	if (
		ready.schema !== "pi-subagent-durable-launch-barrier-ready-v1" ||
		ready.barrierIdentitySha256 !== descriptor.identitySha256 ||
		ready.challenge !== descriptor.challenge ||
		ready.subjectSha256 !== descriptor.subjectSha256 ||
		ready.authorityBindingSha256 !== descriptor.authorityBindingSha256 ||
		!Number.isSafeInteger(ready.workerPid) ||
		ready.workerPid <= 0 ||
		(ready.workerProcessGroupId !== undefined &&
			(!Number.isSafeInteger(ready.workerProcessGroupId) ||
				ready.workerProcessGroupId <= 0))
	)
		throw new DurableLaunchBarrierError("durable launch barrier ready record mismatch");
	assertNonEmpty("durable launch barrier run id", ready.runId);
	assertNonEmpty("durable launch barrier attempt id", ready.attemptId);
	assertSha256("durable launch barrier payload", ready.launchPayloadSha256);
	assertSha256(
		"durable launch barrier execution plan",
		ready.executionPlanSha256,
	);
	assertSha256("durable launch barrier ready digest", readySha256);
	if (durableLaunchBarrierDigest(body) !== readySha256)
		throw new DurableLaunchBarrierError("durable launch barrier ready digest mismatch");
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
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: ready.runId,
		attemptId: ready.attemptId,
		readySha256: ready.readySha256,
		releasePayloadSha256,
	};
	const release = {
		...body,
		releaseSha256: durableLaunchBarrierDigest(body),
	};
	await writeDurableExclusive(descriptor, descriptor.releasePath, release);
	return release;
}

function assertRelease(
	descriptor: DurableLaunchBarrierDescriptor,
	ready: DurableLaunchBarrierReady,
	value: unknown,
): DurableLaunchBarrierRelease {
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError("durable launch barrier release record is invalid");
	const release = value as DurableLaunchBarrierRelease;
	const { releaseSha256, ...body } = release;
	if (
		release.schema !== "pi-subagent-durable-launch-barrier-release-v1" ||
		release.barrierIdentitySha256 !== descriptor.identitySha256 ||
		release.challenge !== descriptor.challenge ||
		release.subjectSha256 !== descriptor.subjectSha256 ||
		release.authorityBindingSha256 !== descriptor.authorityBindingSha256 ||
		release.runId !== ready.runId ||
		release.attemptId !== ready.attemptId ||
		release.readySha256 !== ready.readySha256
	)
		throw new DurableLaunchBarrierError("durable launch barrier release record mismatch");
	assertSha256("durable launch barrier release payload", release.releasePayloadSha256);
	assertSha256("durable launch barrier release digest", releaseSha256);
	if (durableLaunchBarrierDigest(body) !== releaseSha256)
		throw new DurableLaunchBarrierError("durable launch barrier release digest mismatch");
	return release;
}

export async function awaitDurableLaunchBarrier(options: {
	descriptor: DurableLaunchBarrierDescriptor;
	runId: string;
	attemptId: string;
	launchPayloadSha256: string;
	executionPlanSha256: string;
	workerProcessGroupId?: number;
	signal?: AbortSignal;
}): Promise<DurableLaunchBarrierAck> {
	const { descriptor } = options;
	assertDurableLaunchBarrierDescriptor(descriptor);
	assertNonEmpty("durable launch barrier run id", options.runId);
	assertNonEmpty("durable launch barrier attempt id", options.attemptId);
	assertSha256("durable launch barrier payload", options.launchPayloadSha256);
	assertSha256(
		"durable launch barrier execution plan",
		options.executionPlanSha256,
	);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	if (options.signal?.aborted)
		throw new DurableLaunchBarrierError(
			"durable launch barrier was aborted before ready",
		);
	const readyBody = {
		schema: "pi-subagent-durable-launch-barrier-ready-v1" as const,
		barrierIdentitySha256: descriptor.identitySha256,
		challenge: descriptor.challenge,
		subjectSha256: descriptor.subjectSha256,
		...(descriptor.authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256: descriptor.authorityBindingSha256 }),
		runId: options.runId,
		attemptId: options.attemptId,
		workerPid: process.pid,
		...(options.workerProcessGroupId === undefined
			? {}
			: { workerProcessGroupId: options.workerProcessGroupId }),
		launchPayloadSha256: options.launchPayloadSha256,
		executionPlanSha256: options.executionPlanSha256,
	};
	const ready = {
		...readyBody,
		readySha256: durableLaunchBarrierDigest(readyBody),
	};
	await writeDurableExclusive(descriptor, descriptor.readyPath, ready);
	const release = assertRelease(
		descriptor,
		ready,
		await waitForFile(descriptor, descriptor.releasePath, options.signal),
	);
	if (options.signal?.aborted)
		throw new DurableLaunchBarrierError(
			"durable launch barrier was aborted before acknowledgement",
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
	await writeDurableExclusive(descriptor, descriptor.ackPath, ack);
	return ack;
}

export async function waitForDurableLaunchBarrierAck(
	descriptor: DurableLaunchBarrierDescriptor,
	release: DurableLaunchBarrierRelease,
): Promise<DurableLaunchBarrierAck> {
	assertDurableLaunchBarrierDescriptor(descriptor);
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	const value = await waitForFile(descriptor, descriptor.ackPath);
	if (!value || typeof value !== "object")
		throw new DurableLaunchBarrierError("durable launch barrier acknowledgement is invalid");
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
		throw new DurableLaunchBarrierError("durable launch barrier acknowledgement mismatch");
	assertSha256("durable launch barrier acknowledgement digest", ackSha256);
	if (durableLaunchBarrierDigest(body) !== ackSha256)
		throw new DurableLaunchBarrierError("durable launch barrier acknowledgement digest mismatch");
	await assertOwnerOnlyDirectory(
		descriptor.directory,
		descriptor.directoryIdentity,
	);
	return ack;
}
