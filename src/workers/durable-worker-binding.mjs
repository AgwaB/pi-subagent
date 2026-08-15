import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const DURABLE_WORKER_BINDING_ENV =
	"PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON";

const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_RUNS_DIR = ".pi/agent/runs";

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

function requireText(label, value) {
	if (typeof value !== "string" || value.length === 0)
		throw new DurableWorkerGuardError(`${label} is required`);
	return value;
}

function optionalText(label, value) {
	if (value === undefined) return undefined;
	return requireText(label, value);
}

function requireSha256(label, value) {
	if (typeof value !== "string" || !SHA256.test(value))
		throw new DurableWorkerGuardError(`${label} must be lowercase SHA-256`);
	return value;
}

export class DurableWorkerGuardError extends Error {
	constructor(message) {
		super(message);
		this.name = "DurableWorkerGuardError";
		this.failureKind = "guard_failure";
	}
}

export function isDurableWorkerGuardError(error) {
	return error instanceof DurableWorkerGuardError;
}

export function prepareDurableWorkerBinding({
	payload,
	launchPayloadSha256,
	executionPlanSha256,
	executionCwd = payload?.cwd,
	workerPid = process.pid,
}) {
	const descriptor = payload?.input?.durableLaunchBarrier;
	if (!descriptor) throw new DurableWorkerGuardError("durable launch barrier is required");
	if (!Number.isInteger(workerPid) || workerPid <= 0)
		throw new DurableWorkerGuardError("durable worker pid is invalid");
	const cwd = requireText("worker cwd", payload.cwd);
	const resolvedExecutionCwd = resolve(
		requireText("execution cwd", executionCwd),
	);
	const runsDir = resolve(cwd, payload.input?.runsDir ?? DEFAULT_RUNS_DIR);
	const correlationId = optionalText(
		"subagent correlation id",
		payload.input?.correlationId,
	);
	const authorityBindingSha256 = descriptor.authorityBindingSha256;
	if (authorityBindingSha256 !== undefined)
		requireSha256("authority binding", authorityBindingSha256);
	const v2 = descriptor.schema === "pi-subagent-durable-launch-barrier-v2";
	return Object.freeze({
		schema: v2
			? "pi-subagent-durable-worker-binding-preflight-v2"
			: "pi-subagent-durable-worker-binding-preflight-v1",
		runId: requireText("subagent run id", payload.runId),
		attemptId: requireText("subagent attempt id", payload.attemptId),
		...(correlationId === undefined ? {} : { correlationId }),
		cwdSha256: sha256Text(resolvedExecutionCwd),
		runsDirSha256: sha256Text(runsDir),
		workerPid,
		launchPayloadSha256: requireSha256(
			"launch payload digest",
			launchPayloadSha256,
		),
		executionPlanSha256: requireSha256(
			"execution plan digest",
			executionPlanSha256,
		),
		barrierIdentitySha256: requireSha256(
			"barrier identity",
			descriptor.identitySha256,
		),
		barrierSubjectSha256: requireSha256(
			"barrier subject",
			descriptor.subjectSha256,
		),
		...(authorityBindingSha256 === undefined
			? {}
			: { authorityBindingSha256 }),
	});
}

export function buildDurableWorkerBinding(options) {
	const {
		payload,
		launchPayloadSha256,
		executionPlanSha256,
		ack,
		workerPid = process.pid,
	} = options;
	const preflight =
		options.preflight ??
		prepareDurableWorkerBinding({
			payload,
			launchPayloadSha256,
			executionPlanSha256,
			workerPid,
		});
	const { schema: preflightSchema, ...prepared } = preflight;
	if (preflightSchema === "pi-subagent-durable-worker-binding-preflight-v2") {
		if (ack?.schema !== "pi-subagent-durable-launch-barrier-ack-v2")
			throw new DurableWorkerGuardError(
				"durable launch barrier v2 acknowledgement is required",
			);
		return Object.freeze({
			schema: "pi-subagent-durable-worker-binding-v2",
			...prepared,
			readySha256: requireSha256("ready digest", ack.readySha256),
			decisionSha256: requireSha256(
				"release decision digest",
				ack.decisionSha256,
			),
			ackSha256: requireSha256("ack digest", ack.ackSha256),
		});
	}
	return Object.freeze({
		schema: "pi-subagent-durable-worker-binding-v1",
		...prepared,
		readySha256: requireSha256("ready digest", ack?.readySha256),
		releaseSha256: requireSha256("release digest", ack?.releaseSha256),
		ackSha256: requireSha256("ack digest", ack?.ackSha256),
	});
}

export function executionInputAfterDurableLaunch(input) {
	if (!input?.durableLaunchBarrier)
		throw new DurableWorkerGuardError(
			"durable launch barrier is required before execution",
		);
	return Object.freeze({
		...input,
		async: false,
		onComplete: undefined,
		durableLaunchBarrier: undefined,
	});
}

export function installDurableWorkerBinding(options) {
	// Build a run-scoped value for explicit runner handoff. Never mutate the
	// parent process environment: nested/barrierless inline runs share it.
	return buildDurableWorkerBinding(options);
}
