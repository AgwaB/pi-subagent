import { createHash } from "node:crypto";

export const EXTERNAL_LAUNCH_GRANT_SHA256_ENV =
	"PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256";
export const DURABLE_WORKER_BINDING_ENV =
	"PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON";

function sha256Text(value) {
	return createHash("sha256").update(value).digest("hex");
}

function requireText(label, value) {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${label} is required`);
	return value;
}

function requireSha256(label, value) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
		throw new Error(`${label} must be lowercase SHA-256`);
	return value;
}

export function buildDurableWorkerBinding({
	payload,
	launchPayloadSha256,
	ack,
	workerPid = process.pid,
	externalLaunchGrantSha256 = process.env[EXTERNAL_LAUNCH_GRANT_SHA256_ENV],
}) {
	const descriptor = payload?.input?.durableLaunchBarrier;
	if (!descriptor) throw new Error("durable launch barrier is required");
	if (!Number.isInteger(workerPid) || workerPid <= 0)
		throw new Error("durable worker pid is invalid");
	if (
		externalLaunchGrantSha256 !== undefined &&
		!/^[a-f0-9]{64}$/u.test(externalLaunchGrantSha256)
	)
		throw new Error("external launch grant digest must be lowercase SHA-256");
	return Object.freeze({
		schema: "pi-subagent-durable-worker-binding-v1",
		runId: requireText("subagent run id", payload.runId),
		attemptId: requireText("subagent attempt id", payload.attemptId),
		correlationId: requireText(
			"workflow correlation id",
			payload.input?.correlationId,
		),
		cwdSha256: sha256Text(requireText("worker cwd", payload.cwd)),
		runsDirSha256: sha256Text(
			requireText("subagent runs directory", payload.input?.runsDir),
		),
		workerPid,
		launchPayloadSha256: requireSha256(
			"launch payload digest",
			launchPayloadSha256,
		),
		barrierIdentitySha256: requireSha256(
			"barrier identity",
			descriptor.identitySha256,
		),
		barrierSubjectSha256: requireSha256(
			"barrier subject",
			descriptor.subjectSha256,
		),
		readySha256: requireSha256("ready digest", ack.readySha256),
		releaseSha256: requireSha256("release digest", ack.releaseSha256),
		ackSha256: requireSha256("ack digest", ack.ackSha256),
		...(externalLaunchGrantSha256 === undefined
			? {}
			: { externalLaunchGrantSha256 }),
	});
}

export function installDurableWorkerBinding(options) {
	const binding = buildDurableWorkerBinding(options);
	process.env[DURABLE_WORKER_BINDING_ENV] = JSON.stringify(binding);
	return binding;
}
