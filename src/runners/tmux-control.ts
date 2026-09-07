import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ResultTmuxMetadata } from "../artifacts/result.ts";
import {
	captureProcessIdentity,
	inspectProcessIdentity,
	inspectProcessGroup,
	type ProcessIdentity,
	verifyProcessIdentity,
} from "../process-identity.ts";

const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOCKET_PATH_BYTES = 100;
const CONTROL_TIMEOUT_MS = 2_000;
const CONTROL_KILL_GRACE_MS = 250;
const NO_SERVER_DIAGNOSTICS = [
	"no server running on",
	"failed to connect to server",
	"no such file or directory",
	"server exited unexpectedly",
];

export const TMUX_OWNERSHIP_ENV = "PI_SUBAGENT_TMUX_OWNERSHIP_TOKEN";

export class TmuxOwnershipError extends Error {
	readonly failureKind = "internal" as const;
	readonly terminalBlocked: boolean;

	constructor(message: string, options: { terminalBlocked?: boolean } = {}) {
		super(message);
		this.name = "TmuxOwnershipError";
		this.terminalBlocked = options.terminalBlocked === true;
	}
}

export function tmuxOwnershipTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

type RecordedIdentity =
	| { state: "absent" }
	| { state: "incomplete" }
	| { state: "complete"; identity: ProcessIdentity };

function recordedIdentity(
	pid: number | null | undefined,
	processGroupId: number | null | undefined,
	birthIdentity: string | null | undefined,
): RecordedIdentity {
	const values = [pid, processGroupId, birthIdentity];
	if (values.every((value) => value === undefined || value === null))
		return { state: "absent" };
	if (
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		typeof processGroupId !== "number" ||
		!Number.isSafeInteger(processGroupId) ||
		processGroupId <= 0 ||
		typeof birthIdentity !== "string" ||
		birthIdentity.length === 0
	)
		return { state: "incomplete" };
	return {
		state: "complete",
		identity: { pid, processGroupId, birthIdentity },
	};
}

interface RuntimeIdentitySet {
	identities: ProcessIdentity[];
	incomplete: boolean;
}

function runtimeIdentities(tmux: ResultTmuxMetadata): RuntimeIdentitySet {
	const recorded = [
		recordedIdentity(
			tmux.launchPid,
			tmux.launchProcessGroupId,
			tmux.launchProcessBirthIdentity,
		),
		recordedIdentity(
			tmux.serverPid,
			tmux.serverProcessGroupId,
			tmux.serverProcessBirthIdentity,
		),
		recordedIdentity(
			tmux.panePid,
			tmux.paneProcessGroupId,
			tmux.paneProcessBirthIdentity,
		),
	];
	return {
		identities: recorded.flatMap((entry) =>
			entry.state === "complete" ? [entry.identity] : [],
		),
		incomplete: recorded.some((entry) => entry.state === "incomplete"),
	};
}

async function identityFallbackAlive(
	tmux: ResultTmuxMetadata,
): Promise<boolean> {
	const identitySet = runtimeIdentities(tmux);
	const { identities } = identitySet;
	if (identitySet.incomplete)
		throw new TmuxOwnershipError(
			"tmux recorded process ownership metadata is incomplete",
			{ terminalBlocked: true },
		);
	if (identities.length === 0) {
		if (tmux.launchState === "planned" || tmux.launchState === "gated")
			return false;
		throw new TmuxOwnershipError(
			"tmux socket is absent and recorded process ownership is incomplete",
			{ terminalBlocked: true },
		);
	}
	let alive = false;
	for (const identity of identities) {
		const status = await verifyProcessIdentity(identity);
		if (status === "mismatch")
			throw new TmuxOwnershipError(
				"tmux recorded process ownership no longer matches the live process",
				{ terminalBlocked: true },
			);
		if (status === "unknown")
			throw new TmuxOwnershipError(
				"tmux recorded process ownership could not be verified",
				{ terminalBlocked: true },
			);
		alive ||= status === "alive";
		if (
			process.platform !== "win32" &&
			identity.pid === identity.processGroupId
		) {
			const groupStatus = inspectProcessGroup(identity.processGroupId);
			if (groupStatus === "unknown")
				throw new TmuxOwnershipError(
					"tmux recorded process group drain could not be verified",
					{ terminalBlocked: true },
				);
			alive ||= groupStatus === "alive";
		}
	}
	if (
		!alive &&
		tmux.launchState === "launching" &&
		tmux.serverProcessBirthIdentity == null &&
		tmux.paneProcessBirthIdentity == null
	)
		throw new TmuxOwnershipError(
			"tmux launch was released but runtime process ownership is unknown",
			{ terminalBlocked: true },
		);
	return alive;
}

export function privateTmuxSocketPath(
	serverName: string,
	env: NodeJS.ProcessEnv,
): string {
	if (!SAFE_SERVER_NAME.test(serverName))
		throw new TmuxOwnershipError("tmux private server name is invalid");
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid === undefined)
		throw new TmuxOwnershipError("tmux private sockets require a numeric uid");
	const root = resolve(env.TMUX_TMPDIR ?? "/tmp");
	const socketPath = join(root, `tmux-${uid}`, serverName);
	if (Buffer.byteLength(socketPath, "utf8") > MAX_SOCKET_PATH_BYTES)
		throw new TmuxOwnershipError(
			"tmux private socket path exceeds the supported Unix path length",
		);
	return socketPath;
}

async function assertOwnerOnlySocketDirectory(
	socketPath: string,
	terminalBlocked: boolean,
): Promise<boolean> {
	const directory = dirname(socketPath);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(directory);
	} catch (error) {
		if (terminalBlocked && (error as NodeJS.ErrnoException)?.code === "ENOENT")
			return false;
		throw new TmuxOwnershipError(
			`tmux socket directory check failed: ${error instanceof Error ? error.message : String(error)}`,
			{ terminalBlocked },
		);
	}
	const uid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (
		!info.isDirectory() ||
		uid === undefined ||
		info.uid !== uid ||
		(info.mode & 0o077) !== 0
	)
		throw new TmuxOwnershipError(
			"tmux socket directory must be an owner-only directory owned by the current uid",
			{ terminalBlocked },
		);
	return true;
}

export async function preparePrivateTmuxSocket(
	socketPath: string,
): Promise<void> {
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	await assertOwnerOnlySocketDirectory(socketPath, false);
}

async function socketExists(socketPath: string): Promise<boolean> {
	try {
		const info = await lstat(socketPath);
		if (!info.isSocket())
			throw new TmuxOwnershipError(
				"tmux socket path exists but is not a Unix socket",
				{ terminalBlocked: true },
			);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		if (error instanceof TmuxOwnershipError) throw error;
		throw new TmuxOwnershipError(
			`tmux socket identity check failed: ${error instanceof Error ? error.message : String(error)}`,
			{ terminalBlocked: true },
		);
	}
}

interface TmuxControlResult {
	state: "alive" | "dead";
	stdout: string;
}

async function runTmuxControl(
	socketPath: string,
	args: readonly string[],
): Promise<TmuxControlResult> {
	return await new Promise((resolveControl, rejectControl) => {
		const child = spawn("tmux", ["-S", socketPath, ...args], {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		let authorizedProcessGroupId: number | undefined;
		let identityCapture: Promise<void> = Promise.resolve();
		let groupDrain: Promise<boolean> | undefined;

		async function drainGroup(): Promise<boolean> {
			await identityCapture;
			const processGroupId = authorizedProcessGroupId;
			if (processGroupId === undefined) return true;
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (inspectProcessGroup(processGroupId) === "dead") return true;
				try {
					process.kill(-processGroupId, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") return false;
				}
				for (let index = 0; index < 10; index += 1) {
					const status = inspectProcessGroup(processGroupId);
					if (status === "dead") return true;
					if (status === "unknown") return false;
					await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
				}
			}
			return inspectProcessGroup(processGroupId) === "dead";
		}

		function startGroupDrain(): Promise<boolean> {
			groupDrain ??= drainGroup();
			return groupDrain;
		}

		function appendLimited(current: string, chunk: unknown): string {
			return `${current}${String(chunk)}`.slice(-64 * 1024);
		}

		function finish(
			result:
				| { ok: true; value: TmuxControlResult }
				| { ok: false; error: TmuxOwnershipError },
		): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
			if (result.ok) resolveControl(result.value);
			else rejectControl(result.error);
		}

		child.stdout?.on("data", (chunk) => {
			stdout = appendLimited(stdout, chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr = appendLimited(stderr, chunk);
		});
		child.once("error", (error) =>
			finish({
				ok: false,
				error: new TmuxOwnershipError(
					`tmux control spawn failed: ${error.message}`,
					{ terminalBlocked: true },
				),
			}),
		);
		child.once("spawn", () => {
			const pid = child.pid;
			if (pid === undefined) return;
			identityCapture = captureProcessIdentity(pid).then(
				(identity) => {
					if (
						process.platform !== "win32" &&
						identity.pid === identity.processGroupId
					)
						authorizedProcessGroupId = identity.processGroupId;
				},
				() => undefined,
			);
		});
		child.once("exit", () => {
			void startGroupDrain();
		});
		child.once("close", (code, signal) => {
			void (async () => {
				if (!(await startGroupDrain())) {
					finish({
						ok: false,
						error: new TmuxOwnershipError(
							"tmux control process group did not drain",
							{ terminalBlocked: true },
						),
					});
					return;
				}
				if (timedOut) {
					finish({
						ok: false,
						error: new TmuxOwnershipError("tmux control command timed out", {
							terminalBlocked: true,
						}),
					});
					return;
				}
				if (signal !== null) {
					finish({
						ok: false,
						error: new TmuxOwnershipError(
							`tmux control command terminated by ${signal}`,
							{ terminalBlocked: true },
						),
					});
					return;
				}
				if (code === 0) {
					finish({ ok: true, value: { state: "alive", stdout } });
					return;
				}
				const diagnostic = stderr.trim().toLowerCase();
				if (NO_SERVER_DIAGNOSTICS.some((text) => diagnostic.includes(text))) {
					finish({ ok: true, value: { state: "dead", stdout } });
					return;
				}
				finish({
					ok: false,
					error: new TmuxOwnershipError(
						`tmux control command failed with exit code ${String(code)}: ${stderr.trim() || "no diagnostic"}`,
						{ terminalBlocked: true },
					),
				});
			})().catch((error) =>
				finish({
					ok: false,
					error: new TmuxOwnershipError(
						`tmux control cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
						{ terminalBlocked: true },
					),
				}),
			);
		});

		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			void identityCapture.then(() => {
				try {
					if (authorizedProcessGroupId !== undefined)
						process.kill(-authorizedProcessGroupId, "SIGTERM");
					else child.kill("SIGTERM");
				} catch {
					// Exit/drain handling below decides the terminal outcome.
				}
			});
			forceKillTimer = setTimeout(() => {
				void identityCapture.then(() => {
					try {
						if (authorizedProcessGroupId !== undefined)
							process.kill(-authorizedProcessGroupId, "SIGKILL");
						else child.kill("SIGKILL");
					} catch {
						// Exit/drain handling below decides the terminal outcome.
					}
				});
			}, CONTROL_KILL_GRACE_MS);
		}, CONTROL_TIMEOUT_MS);
	});
}

function ownershipTokenMatches(
	expectedSha256: string,
	controlOutput: string,
): boolean {
	if (!SHA256.test(expectedSha256)) return false;
	const prefix = `${TMUX_OWNERSHIP_ENV}=`;
	const line = controlOutput
		.split(/\r?\n/u)
		.find((candidate) => candidate.startsWith(prefix));
	if (line === undefined) return false;
	const actual = Buffer.from(
		tmuxOwnershipTokenDigest(line.slice(prefix.length)),
		"hex",
	);
	const expected = Buffer.from(expectedSha256, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface TmuxRuntimeQuery {
	state: "alive" | "dead";
	serverPid?: number;
	panePid?: number;
}

async function queryPrivateTmuxRuntime(
	tmux: Pick<ResultTmuxMetadata, "socketPath"> &
		Partial<
			Pick<
				ResultTmuxMetadata,
				"serverName" | "ownershipTokenSha256" | "sessionName"
			>
		>,
): Promise<TmuxRuntimeQuery> {
	if (
		tmux.serverName === undefined ||
		basename(tmux.socketPath) !== tmux.serverName
	)
		throw new TmuxOwnershipError(
			"tmux socket path does not match the recorded private server name",
			{ terminalBlocked: true },
		);
	if (tmux.ownershipTokenSha256 === undefined)
		throw new TmuxOwnershipError("tmux server ownership proof is missing", {
			terminalBlocked: true,
		});
	const displayed = await runTmuxControl(tmux.socketPath, [
		"display-message",
		"-p",
		"-t",
		tmux.sessionName ?? "run",
		`#{pid}|#{pane_pid}|#{E:${TMUX_OWNERSHIP_ENV}}`,
	]);
	if (displayed.state === "dead") return { state: "dead" };
	// tmux rewrites tabs in non-UTF-8 locales; printable ASCII preserves one
	// atomic sample. Accept exactly three fields and at most one line ending.
	const proof = /^([1-9][0-9]*)\|([1-9][0-9]*)\|([^|\r\n]+)\r?\n?$/u.exec(
		displayed.stdout,
	);
	const [, rawServerPid, rawPanePid, ownershipToken] = proof ?? [];
	const serverPid = Number(rawServerPid);
	const panePid = Number(rawPanePid);
	if (
		proof?.[0] !== displayed.stdout ||
		!Number.isSafeInteger(serverPid) ||
		serverPid <= 0 ||
		!Number.isSafeInteger(panePid) ||
		panePid <= 0 ||
		ownershipToken === undefined ||
		!ownershipTokenMatches(
			tmux.ownershipTokenSha256,
			`${TMUX_OWNERSHIP_ENV}=${ownershipToken}\n`,
		)
	)
		throw new TmuxOwnershipError(
			"tmux runtime ownership proof does not match the run record",
			{ terminalBlocked: true },
		);
	return { state: "alive", serverPid, panePid };
}

export async function privateTmuxServerAlive(
	tmux: Pick<ResultTmuxMetadata, "socketPath"> &
		Partial<Pick<ResultTmuxMetadata, "serverName" | "ownershipTokenSha256">>,
): Promise<boolean> {
	const completeTmux = tmux as ResultTmuxMetadata;
	if (!(await assertOwnerOnlySocketDirectory(tmux.socketPath, true)))
		return await identityFallbackAlive(completeTmux);
	if (!(await socketExists(tmux.socketPath)))
		return await identityFallbackAlive(completeTmux);
	const queried = await queryPrivateTmuxRuntime(completeTmux);
	return queried.state === "alive"
		? true
		: await identityFallbackAlive(completeTmux);
}

export async function readPrivateTmuxRuntimeIdentity(
	tmux: ResultTmuxMetadata,
): Promise<
	Pick<
		ResultTmuxMetadata,
		| "serverPid"
		| "serverProcessGroupId"
		| "serverProcessBirthIdentity"
		| "panePid"
		| "paneProcessGroupId"
		| "paneProcessBirthIdentity"
	>
> {
	const first = await queryPrivateTmuxRuntime(tmux);
	if (first.state !== "alive")
		throw new TmuxOwnershipError(
			"tmux server exited before runtime ownership could be recorded",
		);
	const serverPid = first.serverPid!;
	const panePid = first.panePid!;
	const [serverStatus, paneStatus] = await Promise.all([
		inspectProcessIdentity(serverPid),
		inspectProcessIdentity(panePid),
	]);
	// A proven exit may fall back to persisted cleanup authority. Unknown
	// ownership must still block, even when the other process is already dead.
	if (serverStatus.state === "unknown" || paneStatus.state === "unknown")
		throw new TmuxOwnershipError(
			"tmux runtime process ownership could not be verified",
			{ terminalBlocked: true },
		);
	if (serverStatus.state === "dead" || paneStatus.state === "dead")
		throw new TmuxOwnershipError(
			"tmux server exited before runtime ownership could be recorded",
		);
	const server = serverStatus.identity;
	const pane = paneStatus.identity;
	const second = await queryPrivateTmuxRuntime(tmux);
	const verified = await Promise.all([
		verifyProcessIdentity(server),
		verifyProcessIdentity(pane),
	]);
	if (
		(second.state === "alive" &&
			(second.serverPid !== serverPid || second.panePid !== panePid)) ||
		verified.some((state) => state === "mismatch" || state === "unknown")
	)
		throw new TmuxOwnershipError(
			"tmux runtime ownership changed while it was being recorded",
			{ terminalBlocked: true },
		);
	if (second.state === "dead" || verified.includes("dead"))
		throw new TmuxOwnershipError(
			"tmux server exited before runtime ownership could be recorded",
		);
	return {
		serverPid: server.pid,
		serverProcessGroupId: server.processGroupId,
		serverProcessBirthIdentity: server.birthIdentity,
		panePid: pane.pid,
		paneProcessGroupId: pane.processGroupId,
		paneProcessBirthIdentity: pane.birthIdentity,
	};
}

function signalVerifiedIdentity(
	identity: ProcessIdentity,
	signal: NodeJS.Signals,
): void {
	const target =
		process.platform === "win32" || identity.processGroupId !== identity.pid
			? identity.pid
			: -identity.processGroupId;
	try {
		process.kill(target, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
	}
}

export async function terminatePrivateTmuxServer(
	tmux: Pick<ResultTmuxMetadata, "socketPath"> &
		Partial<Pick<ResultTmuxMetadata, "serverName" | "ownershipTokenSha256">>,
): Promise<boolean> {
	const completeTmux = tmux as ResultTmuxMetadata;
	const identitySet = runtimeIdentities(completeTmux);
	const { identities } = identitySet;
	let unsafe = identitySet.incomplete;
	if (identities.length === 0 && completeTmux.launchState !== "planned")
		unsafe = true;
	if (
		completeTmux.launchState === "launching" &&
		completeTmux.serverProcessBirthIdentity == null &&
		completeTmux.paneProcessBirthIdentity == null
	)
		unsafe = true;
	const authorizedGroups = new Set<number>();
	const recordedLeaderGroups = new Set(
		identities
			.filter((identity) => identity.pid === identity.processGroupId)
			.map((identity) => identity.processGroupId),
	);

	async function inspectIdentities(): Promise<ProcessIdentity[]> {
		const alive: ProcessIdentity[] = [];
		for (const identity of identities) {
			const status = await verifyProcessIdentity(identity);
			if (status === "mismatch" || status === "unknown") {
				unsafe = true;
				continue;
			}
			if (status !== "alive") continue;
			alive.push(identity);
			if (process.platform !== "win32" && identity.pid === identity.processGroupId)
				authorizedGroups.add(identity.processGroupId);
		}
		return alive;
	}

	function signalAuthorizedGroups(signal: NodeJS.Signals): void {
		for (const processGroupId of authorizedGroups) {
			const status = inspectProcessGroup(processGroupId);
			if (status === "dead") {
				authorizedGroups.delete(processGroupId);
				continue;
			}
			if (status === "unknown") {
				unsafe = true;
				continue;
			}
			try {
				process.kill(-processGroupId, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
			}
		}
	}

	function groupsDrained(): boolean {
		let drained = true;
		for (const processGroupId of recordedLeaderGroups) {
			const status = inspectProcessGroup(processGroupId);
			if (status === "dead") {
				authorizedGroups.delete(processGroupId);
				continue;
			}
			drained = false;
			if (status === "unknown" || !authorizedGroups.has(processGroupId))
				unsafe = true;
		}
		return drained;
	}

	let socketOwnershipCaptured = false;
	if (await socketExists(tmux.socketPath)) {
		try {
			const runtime = await readPrivateTmuxRuntimeIdentity(completeTmux);
			for (const identity of [
				recordedIdentity(
					runtime.serverPid,
					runtime.serverProcessGroupId,
					runtime.serverProcessBirthIdentity,
				),
				recordedIdentity(
					runtime.panePid,
					runtime.paneProcessGroupId,
					runtime.paneProcessBirthIdentity,
				),
			])
				if (
					identity.state === "complete" &&
					!identities.some(
						(candidate) =>
							candidate.pid === identity.identity.pid &&
							candidate.processGroupId === identity.identity.processGroupId &&
							candidate.birthIdentity === identity.identity.birthIdentity,
					)
				) {
					identities.push(identity.identity);
					if (identity.identity.pid === identity.identity.processGroupId)
						recordedLeaderGroups.add(identity.identity.processGroupId);
				}
			socketOwnershipCaptured = true;
		} catch (error) {
			if (error instanceof TmuxOwnershipError && error.terminalBlocked === true)
				unsafe = true;
			else if (
				error instanceof TmuxOwnershipError &&
				error.message ===
					"tmux server exited before runtime ownership could be recorded"
			) {
				// Persisted identities below still prove whether cleanup is complete.
			} else throw error;
		}
	}

	const initiallyAlive = await inspectIdentities();
	for (const identity of initiallyAlive)
		signalVerifiedIdentity(identity, "SIGTERM");
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const alive = await inspectIdentities();
		if (alive.length === 0 && groupsDrained()) break;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}

	for (const identity of await inspectIdentities())
		signalVerifiedIdentity(identity, "SIGKILL");
	signalAuthorizedGroups("SIGKILL");
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const alive = await inspectIdentities();
		if (alive.length === 0 && groupsDrained()) break;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}

	let socketAlive = false;
	if (await socketExists(tmux.socketPath)) {
		try {
			socketAlive = await privateTmuxServerAlive(tmux);
		} catch (error) {
			if (error instanceof TmuxOwnershipError && error.terminalBlocked === true)
				unsafe = true;
			else throw error;
		}
	}
	const remainingAlive = await inspectIdentities();
	const cleanupComplete =
		remainingAlive.length === 0 && groupsDrained() && !socketAlive;
	if (unsafe)
		throw new TmuxOwnershipError(
			`tmux cleanup completed only for verified ownership; unsafe identity metadata remains${socketOwnershipCaptured ? "" : " and no socket runtime ownership was captured"}`,
			{ terminalBlocked: true },
		);
	return cleanupComplete;
}
