import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Durable worker launch payload (`worker.json`).
 *
 * The orchestrator persists the launch input so a detached worker can read it
 * after the parent session exits. Long prompt strings are stored as sibling
 * files (`task.md`, `system-prompt.md`) and referenced from the payload by
 * name, size, and SHA-256 instead of being inlined. That keeps `worker.json`
 * small, lets callers that already persisted the same prompt bytes hard-link
 * to the sidecars, and keeps the integrity chain intact: the payload digest
 * covers the references, and the worker verifies each sidecar against its
 * reference before use.
 *
 * Compatibility: a payload whose `input.task`/`input.systemPrompt` are inline
 * strings (the pre-reference format) is accepted unchanged. A payload may not
 * carry both the inline value and the reference for the same field.
 */

export const DURABLE_WORKER_TASK_FILE = "task.md";
export const DURABLE_WORKER_SYSTEM_PROMPT_FILE = "system-prompt.md";

const SAFE_SIDECAR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface DurableWorkerTextRef {
	path: string;
	bytes: number;
	sha256: string;
}

export interface DurableWorkerPayload {
	input: object;
	cwd: string;
	backend: string;
	runId: string;
	attemptId: string;
	startedAt: string;
}

export interface WriteDurableWorkerPayloadOptions extends DurableWorkerPayload {
	payloadPath: string;
}

export interface WrittenDurableWorkerPayload {
	text: string;
	bytes: number;
	sidecars: string[];
}

interface SidecarField {
	field: "task" | "systemPrompt";
	ref: "taskRef" | "systemPromptRef";
	file: string;
}

const SIDECAR_FIELDS: readonly SidecarField[] = [
	{ field: "task", ref: "taskRef", file: DURABLE_WORKER_TASK_FILE },
	{
		field: "systemPrompt",
		ref: "systemPromptRef",
		file: DURABLE_WORKER_SYSTEM_PROMPT_FILE,
	},
];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Write `worker.json` plus prompt sidecars. Only string prompt fields are
 * externalized; every other input field is persisted exactly as given.
 */
export async function writeDurableWorkerPayload(
	options: WriteDurableWorkerPayloadOptions,
): Promise<WrittenDurableWorkerPayload> {
	const { payloadPath, input, ...rest } = options;
	const attemptDir = dirname(payloadPath);
	const persisted: Record<string, unknown> = { ...(input as Record<string, unknown>) };
	const sidecars: string[] = [];
	for (const { field, ref, file } of SIDECAR_FIELDS) {
		const value = persisted[field];
		if (typeof value !== "string") continue;
		if (ref in persisted) {
			throw new Error(
				`durable worker payload input already declares ${ref}; refusing to overwrite`,
			);
		}
		const bytes = Buffer.from(value, "utf8");
		const sidecarPath = join(attemptDir, file);
		await writeFile(sidecarPath, bytes);
		delete persisted[field];
		persisted[ref] = {
			path: file,
			bytes: bytes.byteLength,
			sha256: sha256(bytes),
		} satisfies DurableWorkerTextRef;
		sidecars.push(sidecarPath);
	}
	const text = `${JSON.stringify({ ...rest, input: persisted }, null, 2)}\n`;
	await writeFile(payloadPath, text);
	return { text, bytes: Buffer.byteLength(text, "utf8"), sidecars };
}

function requireTextRef(value: unknown, ref: string): DurableWorkerTextRef {
	if (!isRecord(value)) {
		throw new Error(`durable worker payload ${ref} must be an object`);
	}
	const { path, bytes, sha256: digest } = value;
	if (typeof path !== "string" || !SAFE_SIDECAR_NAME.test(path)) {
		throw new Error(
			`durable worker payload ${ref}.path must be a plain file name inside the attempt directory`,
		);
	}
	if (!Number.isInteger(bytes) || (bytes as number) < 0) {
		throw new Error(`durable worker payload ${ref}.bytes must be a non-negative integer`);
	}
	if (typeof digest !== "string" || !SHA256_HEX.test(digest)) {
		throw new Error(`durable worker payload ${ref}.sha256 must be a lowercase hex SHA-256`);
	}
	return { path, bytes: bytes as number, sha256: digest };
}

/**
 * Resolve prompt references in a parsed `worker.json`. Returns a new payload
 * whose `input.task`/`input.systemPrompt` are inline strings; inline payloads
 * pass through unchanged. Sidecars are read only from the payload's own
 * directory and must match the referenced size and SHA-256 exactly.
 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const BACKENDS = new Set(["inline", "headless", "tmux"]);

/**
 * Structural validation of a launch payload before anything in the worker
 * relies on its fields: plain-field presence and shape, safe ids, a known
 * backend, a parseable start time, and an absolute cwd.
 */
export function assertDurableWorkerPayloadShape(
	payload: unknown,
): asserts payload is DurableWorkerPayload {
	if (!isRecord(payload)) throw new Error("durable worker payload must be an object");
	for (const field of ["cwd", "runId", "attemptId", "backend", "startedAt"] as const) {
		if (typeof payload[field] !== "string" || (payload[field] as string).length === 0)
			throw new Error(`durable worker payload ${field} must be a non-empty string`);
	}
	if (!isRecord(payload.input)) throw new Error("durable worker payload input must be an object");
	const { cwd, runId, attemptId, backend, startedAt } = payload as unknown as DurableWorkerPayload;
	if (!SAFE_ID.test(runId)) throw new Error(`durable worker payload runId ${JSON.stringify(runId)} is not a safe id`);
	if (!SAFE_ID.test(attemptId))
		throw new Error(`durable worker payload attemptId ${JSON.stringify(attemptId)} is not a safe id`);
	if (!BACKENDS.has(backend)) throw new Error(`durable worker payload backend ${JSON.stringify(backend)} is unknown`);
	if (!Number.isFinite(Date.parse(startedAt)))
		throw new Error(`durable worker payload startedAt ${JSON.stringify(startedAt)} is not a timestamp`);
	if (!isAbsolute(cwd)) throw new Error("durable worker payload cwd must be absolute");
}

export async function resolveDurableWorkerPayload<T extends { input?: unknown }>(
	payload: T,
	payloadPath: string,
): Promise<T> {
	if (!isRecord(payload.input)) return payload;
	const attemptDir = dirname(payloadPath);
	const input: Record<string, unknown> = { ...payload.input };
	for (const { field, ref } of SIDECAR_FIELDS) {
		if (!(ref in input)) continue;
		if (field in input) {
			throw new Error(
				`durable worker payload declares both ${field} and ${ref}; refusing ambiguous launch input`,
			);
		}
		const textRef = requireTextRef(input[ref], ref);
		const bytes = await readFile(join(attemptDir, textRef.path));
		if (bytes.byteLength !== textRef.bytes) {
			throw new Error(
				`durable worker payload ${ref} size mismatch: expected ${textRef.bytes} bytes, found ${bytes.byteLength}`,
			);
		}
		if (sha256(bytes) !== textRef.sha256) {
			throw new Error(`durable worker payload ${ref} digest mismatch for ${textRef.path}`);
		}
		input[field] = bytes.toString("utf8");
		delete input[ref];
	}
	return { ...payload, input };
}
