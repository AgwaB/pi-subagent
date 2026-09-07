import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import {
	preparePrivateTmuxSocket,
	privateTmuxServerAlive,
	privateTmuxSocketPath,
	readPrivateTmuxRuntimeIdentity,
	terminatePrivateTmuxServer,
	TMUX_OWNERSHIP_ENV,
	tmuxOwnershipTokenDigest,
} from "../../src/runners/tmux-control.ts";
import {
	captureProcessIdentity,
	verifyProcessIdentity,
} from "../../src/process-identity.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const blocked = (error) => error?.terminalBlocked === true;

async function withRuntime(realTmux, check) {
	const root = await fs.mkdtemp("/tmp/pso-runtime-");
	const savedEnv = {
		PATH: process.env.PATH,
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
	};
	const socketPath = privateTmuxSocketPath("ps-runtime", { TMUX_TMPDIR: root });
	const token = randomBytes(32).toString("hex");
	let serverIdentity;
	try {
		await preparePrivateTmuxSocket(socketPath);
		execFileSync(
			realTmux,
			[
				"-S",
				socketPath,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"run",
				process.execPath,
				"-e",
				"setInterval(() => {}, 1000)",
			],
			{
				env: { ...process.env, [TMUX_OWNERSHIP_ENV]: token },
				timeout: 3000,
			},
		);
		// Capture cleanup authority independently of the format under test.
		const pid = Number(
			execFileSync(
				realTmux,
				["-S", socketPath, "display-message", "-p", "#{pid}"],
				{
					encoding: "utf8",
					timeout: 3000,
				},
			).trim(),
		);
		serverIdentity = await captureProcessIdentity(pid);
		execFileSync(
			realTmux,
			["-S", socketPath, "set-option", "-w", "-t", "run", "remain-on-exit", "on"],
			{ timeout: 3000 },
		);
		const proof = {
			serverName: "ps-runtime",
			socketPath,
			ownershipTokenSha256: tmuxOwnershipTokenDigest(token),
			launchState: "running",
			sessionName: "run",
		};
		const runtime = {
			...proof,
			...(await readPrivateTmuxRuntimeIdentity(proof)),
		};
		const pane = {
			pid: runtime.panePid,
			processGroupId: runtime.paneProcessGroupId,
			birthIdentity: runtime.paneProcessBirthIdentity,
		};
		const statePath = join(root, "control.json");
		const bin = join(root, "bin");
		await fs.mkdir(bin);
		// A real control client returns real tmux output. The shim only mutates
		// framing or makes this fixture's verified pane exit at a chosen sample.
		await fs.writeFile(
			join(bin, "tmux"),
			`#!${process.execPath}
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { verifyProcessIdentity } from ${JSON.stringify(new URL("../../src/process-identity.ts", import.meta.url).href)};
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
if (args[0] !== "-S" || args[1] !== state.socketPath) throw new Error("unexpected control target");
const output = execFileSync(${JSON.stringify(realTmux)}, args, { encoding: "utf8", timeout: 1000 });
if (!args.includes("display-message")) { process.stdout.write(output); process.exit(0); }
state.count += 1;
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (state.killAt === state.count) {
 if (await verifyProcessIdentity(state.pane) !== "alive") throw new Error("fixture pane ownership changed");
 process.kill(state.pane.pid, "SIGTERM");
 for (let i = 0; i < 100 && await verifyProcessIdentity(state.pane) !== "dead"; i++) await new Promise(r => setTimeout(r, 5));
 if (await verifyProcessIdentity(state.pane) !== "dead") throw new Error("fixture pane did not exit");
}
const fields = output.trimEnd().split("|");
let response = output;
switch (state.mode) {
 case "extra-field": response = output.trimEnd() + "|extra\\n"; break;
 case "extra-line": response = output + "\\n"; break;
 case "empty-pid": fields[0] = ""; break;
 case "negative-pid": fields[0] = "-1"; break;
 case "fractional-pid": fields[1] = "1.5"; break;
 case "unsafe-pid": fields[0] = "9007199254740992"; break;
 case "missing-token": fields[2] = ""; break;
 case "wrong-token": fields[2] = "incorrect"; break;
 case "changed-pid": if (state.count === 2) fields[0] = String(Number(fields[0]) + 1); break;
}
if (!["extra-field", "extra-line"].includes(state.mode)) response = fields.join("|") + "\\n";
process.stdout.write(response);
`,
			{ mode: 0o700 },
		);
		async function control(options) {
			await fs.writeFile(
				statePath,
				JSON.stringify({ socketPath, pane, count: 0, ...options }),
			);
			process.env.PATH = `${bin}:${savedEnv.PATH}`;
		}
		await check({ runtime, pane, serverIdentity, control });
	} finally {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (
			serverIdentity &&
			(await verifyProcessIdentity(serverIdentity)) === "alive"
		) {
			process.kill(serverIdentity.pid, "SIGTERM");
			for (
				let i = 0;
				i < 100 && (await verifyProcessIdentity(serverIdentity)) !== "dead";
				i++
			)
				await sleep(10);
			assert.equal(
				await verifyProcessIdentity(serverIdentity),
				"dead",
				"owned probe server must exit",
			);
		}
		await fs.rm(root, { recursive: true, force: true });
	}
}

export async function checkTmuxRuntimeProbes(realTmux) {
	await withRuntime(realTmux, async ({ runtime }) => {
		process.env.LANG = "C";
		process.env.LC_ALL = "C";
		assert.equal(
			await privateTmuxServerAlive(runtime),
			true,
			"C locale must preserve the ownership frame",
		);
		assert.deepEqual(await readPrivateTmuxRuntimeIdentity(runtime), {
			serverPid: runtime.serverPid,
			serverProcessGroupId: runtime.serverProcessGroupId,
			serverProcessBirthIdentity: runtime.serverProcessBirthIdentity,
			panePid: runtime.panePid,
			paneProcessGroupId: runtime.paneProcessGroupId,
			paneProcessBirthIdentity: runtime.paneProcessBirthIdentity,
		});
	});
	await withRuntime(realTmux, async ({ runtime, control, serverIdentity }) => {
		for (const mode of [
			"extra-field",
			"extra-line",
			"empty-pid",
			"negative-pid",
			"fractional-pid",
			"unsafe-pid",
			"missing-token",
			"wrong-token",
		]) {
			await control({ mode });
			await assert.rejects(
				privateTmuxServerAlive(runtime),
				blocked,
				`${mode} must fail closed`,
			);
		}
		await control({ mode: "changed-pid" });
		await assert.rejects(
			readPrivateTmuxRuntimeIdentity(runtime),
			blocked,
			"changed sample must fail closed",
		);
		assert.equal(await verifyProcessIdentity(serverIdentity), "alive");
	});
	for (const killAt of [1, 2]) {
		await withRuntime(
			realTmux,
			async ({ runtime, control, pane, serverIdentity }) => {
				await control({ killAt });
				assert.equal(
					await terminatePrivateTmuxServer(runtime),
					true,
					`pane exit at sample ${killAt} must use recorded ownership`,
				);
				assert.equal(await verifyProcessIdentity(pane), "dead");
				assert.equal(await verifyProcessIdentity(serverIdentity), "dead");
			},
		);
	}
	for (const unsafe of ["incomplete", "mismatch"]) {
		await withRuntime(realTmux, async ({ runtime, control, serverIdentity }) => {
			await control({ killAt: 1 });
			await assert.rejects(
				terminatePrivateTmuxServer({
					...runtime,
					serverProcessBirthIdentity:
						unsafe === "incomplete"
							? null
							: `${runtime.serverProcessBirthIdentity}-mismatch`,
				}),
				blocked,
				`${unsafe} recorded identity must block cleanup`,
			);
			assert.equal(
				await verifyProcessIdentity(serverIdentity),
				"alive",
				"unsafe server must not be signalled",
			);
		});
	}
	if (process.platform === "linux") {
		await withRuntime(
			realTmux,
			async ({ runtime, control, serverIdentity, pane }) => {
				await control({ killAt: 1 });
				const readFile = fs.readFile;
				fs.readFile = (path, ...args) =>
					path === `/proc/${serverIdentity.pid}/stat`
						? Promise.reject(
								Object.assign(new Error("injected EACCES"), { code: "EACCES" }),
							)
						: readFile(path, ...args);
				syncBuiltinESMExports();
				try {
					await assert.rejects(
						readPrivateTmuxRuntimeIdentity(runtime),
						blocked,
						"unknown identity must not be hidden by a dead peer",
					);
				} finally {
					fs.readFile = readFile;
					syncBuiltinESMExports();
				}
				assert.equal(await verifyProcessIdentity(serverIdentity), "alive");
				assert.equal(await verifyProcessIdentity(pane), "dead");
			},
		);
	}
	console.log("tmux locale, exit-race and fail-closed probes passed");
}
