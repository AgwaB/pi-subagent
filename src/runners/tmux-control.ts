import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResultTmuxMetadata } from "../artifacts/result.ts";

const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/u;
const MAX_SOCKET_PATH_BYTES = 100;
const NO_SERVER_DIAGNOSTICS = [
	"no server running on",
	"failed to connect to server",
	"no such file or directory",
];

export class TmuxOwnershipError extends Error {
	readonly failureKind = "internal" as const;
	readonly terminalBlocked = true as const;

	constructor(message: string) {
		super(message);
		this.name = "TmuxOwnershipError";
	}
}

export function privateTmuxSocketPath(
	serverName: string,
	env: NodeJS.ProcessEnv,
): string {
	if (!SAFE_SERVER_NAME.test(serverName))
		throw new TmuxOwnershipError("tmux private server name is invalid");
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
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

export async function preparePrivateTmuxSocket(
	socketPath: string,
): Promise<void> {
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
}

async function socketExists(socketPath: string): Promise<boolean> {
	try {
		const info = await lstat(socketPath);
		return info.isSocket();
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw new TmuxOwnershipError(
			`tmux socket identity check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function runTmuxControl(
	socketPath: string,
	command: string,
): Promise<"alive" | "dead"> {
	return await new Promise((resolveControl, rejectControl) => {
		const child = spawn("tmux", ["-S", socketPath, command], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (error) =>
			rejectControl(
				new TmuxOwnershipError(`tmux control spawn failed: ${error.message}`),
			),
		);
		child.once("close", (code, signal) => {
			if (signal !== null) {
				rejectControl(
					new TmuxOwnershipError(
						`tmux control command terminated by ${signal}`,
					),
				);
				return;
			}
			if (code === 0) {
				resolveControl("alive");
				return;
			}
			const diagnostic = stderr.trim().toLowerCase();
			if (NO_SERVER_DIAGNOSTICS.some((text) => diagnostic.includes(text))) {
				resolveControl("dead");
				return;
			}
			rejectControl(
				new TmuxOwnershipError(
					`tmux control command failed with exit code ${String(code)}: ${stderr.trim() || "no diagnostic"}`,
				),
			);
		});
	});
}

export async function privateTmuxServerAlive(
	tmux: Pick<ResultTmuxMetadata, "socketPath">,
): Promise<boolean> {
	if (!(await socketExists(tmux.socketPath))) return false;
	return (await runTmuxControl(tmux.socketPath, "list-sessions")) === "alive";
}

export async function terminatePrivateTmuxServer(
	tmux: Pick<ResultTmuxMetadata, "socketPath">,
): Promise<boolean> {
	if (await privateTmuxServerAlive(tmux))
		await runTmuxControl(tmux.socketPath, "kill-server");
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!(await privateTmuxServerAlive(tmux))) return true;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
	}
	return !(await privateTmuxServerAlive(tmux));
}
