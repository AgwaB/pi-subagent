#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
	buildDurableWorkerBinding,
	DURABLE_WORKER_BINDING_ENV,
	installDurableWorkerBinding,
} from "../../src/workers/durable-worker-binding.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const payload = {
	runId: "run-binding",
	attemptId: "attempt-binding",
	cwd: "/tmp/binding-cwd",
	input: {
		correlationId: "workflow-run:task-1",
		runsDir: "/tmp/binding-runs",
		durableLaunchBarrier: {
			identitySha256: "1".repeat(64),
			subjectSha256: "2".repeat(64),
		},
	},
};
const ack = {
	readySha256: "3".repeat(64),
	releaseSha256: "4".repeat(64),
	ackSha256: "5".repeat(64),
};
const grant = "6".repeat(64);
const binding = buildDurableWorkerBinding({
	payload,
	launchPayloadSha256: "7".repeat(64),
	ack,
	workerPid: 1234,
	externalLaunchGrantSha256: grant,
});
assert.deepEqual(binding, {
	schema: "pi-subagent-durable-worker-binding-v1",
	runId: payload.runId,
	attemptId: payload.attemptId,
	correlationId: payload.input.correlationId,
	cwdSha256: sha(payload.cwd),
	runsDirSha256: sha(payload.input.runsDir),
	workerPid: 1234,
	launchPayloadSha256: "7".repeat(64),
	barrierIdentitySha256: "1".repeat(64),
	barrierSubjectSha256: "2".repeat(64),
	readySha256: "3".repeat(64),
	releaseSha256: "4".repeat(64),
	ackSha256: "5".repeat(64),
	externalLaunchGrantSha256: grant,
});
process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT = "1";
assert.throws(
	() =>
		buildDurableWorkerBinding({
			payload,
			launchPayloadSha256: "7".repeat(64),
			ack,
			workerPid: 1234,
		}),
	/required external launch grant digest is absent/u,
);
process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256 = grant;
const installed = installDurableWorkerBinding({
	payload,
	launchPayloadSha256: "7".repeat(64),
	ack,
	workerPid: 1234,
});
assert.deepEqual(JSON.parse(process.env[DURABLE_WORKER_BINDING_ENV]), installed);
assert.throws(
	() =>
		buildDurableWorkerBinding({
			payload,
			launchPayloadSha256: "7".repeat(64),
			ack,
			externalLaunchGrantSha256: "forged",
		}),
	/external launch grant digest/u,
);
delete process.env.PI_WORKFLOW_EXTERNAL_LAUNCH_GRANT_SHA256;
delete process.env.PI_WORKFLOW_REQUIRE_EXTERNAL_LAUNCH_GRANT;
delete process.env[DURABLE_WORKER_BINDING_ENV];
console.log(
	JSON.stringify({
		result: "DURABLE_WORKER_BINDING_VALID",
		grantBound: true,
		barrierBound: true,
		workerBound: true,
	}),
);
