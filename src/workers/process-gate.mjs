#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

async function readStdinPayload() {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	return await new Promise((resolve, reject) => {
		lines.once("line", (value) => {
			resolve(value);
			lines.close();
		});
		lines.once("close", () => resolve(undefined));
		lines.once("error", reject);
	});
}

async function readFilePayload(path) {
	for (;;) {
		try {
			const value = await readFile(path, "utf8");
			await unlink(path).catch(() => undefined);
			return value;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

const raw =
	process.argv[2] === "--file" && typeof process.argv[3] === "string"
		? await readFilePayload(process.argv[3])
		: await readStdinPayload();
if (raw === undefined) process.exit(125);
let payload;
try {
	payload = JSON.parse(raw);
} catch {
	process.exit(125);
}
if (
	!payload ||
	!Array.isArray(payload.argv) ||
	payload.argv.length === 0 ||
	payload.argv.some((entry) => typeof entry !== "string" || entry.length === 0) ||
	typeof payload.cwd !== "string" ||
	!payload.env ||
	typeof payload.env !== "object"
)
	process.exit(125);
const child = spawn(payload.argv[0], payload.argv.slice(1), {
	cwd: payload.cwd,
	env: payload.env,
	stdio: ["ignore", "inherit", "inherit"],
});
child.once("error", (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 127;
});
child.once("exit", (code, signal) => {
	if (signal !== null) {
		try {
			process.kill(process.pid, signal);
		} catch {
			process.exitCode = 1;
		}
		return;
	}
	process.exitCode = code ?? 1;
});
