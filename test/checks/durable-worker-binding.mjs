#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
	buildDurableWorkerBinding,
	DURABLE_WORKER_BINDING_ENV,
	executionInputAfterDurableLaunch,
	installDurableWorkerBinding,
	isDurableWorkerGuardError,
	prepareDurableWorkerBinding,
} from "../../src/workers/durable-worker-binding.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const payload = {
	runId: "run-binding",
	attemptId: "attempt-binding",
	cwd: "/tmp/binding-cwd",
	input: {
		durableLaunchBarrier: {
			identitySha256: "1".repeat(64),
			subjectSha256: "2".repeat(64),
			authorityBindingSha256: "6".repeat(64),
		},
	},
};
const ack = {
	readySha256: "3".repeat(64),
	releaseSha256: "4".repeat(64),
	ackSha256: "5".repeat(64),
};
const executionInput = executionInputAfterDurableLaunch({
	...payload.input,
	async: true,
	onComplete: "detach",
});
assert.equal(executionInput.async, false);
assert.equal(executionInput.onComplete, undefined);
assert.equal(executionInput.durableLaunchBarrier, undefined);
assert.throws(
	() => executionInputAfterDurableLaunch({ async: true }),
	(error) =>
		isDurableWorkerGuardError(error) &&
		error.failureKind === "guard_failure",
);
const executionPlanSha256 = "8".repeat(64);
const executionCwd = "/tmp/binding-worktree";
const preflight = prepareDurableWorkerBinding({
	payload,
	launchPayloadSha256: "7".repeat(64),
	executionPlanSha256,
	executionCwd,
	workerPid: 1234,
});
assert.deepEqual(preflight, {
	schema: "pi-subagent-durable-worker-binding-preflight-v1",
	runId: payload.runId,
	attemptId: payload.attemptId,
	cwdSha256: sha(executionCwd),
	runsDirSha256: sha("/tmp/binding-cwd/.pi/agent/runs"),
	workerPid: 1234,
	launchPayloadSha256: "7".repeat(64),
	executionPlanSha256,
	barrierIdentitySha256: "1".repeat(64),
	barrierSubjectSha256: "2".repeat(64),
	authorityBindingSha256: "6".repeat(64),
});
const binding = buildDurableWorkerBinding({
	payload,
	launchPayloadSha256: "7".repeat(64),
	ack,
	workerPid: 1234,
	executionPlanSha256,
	preflight,
});
assert.deepEqual(binding, {
	schema: "pi-subagent-durable-worker-binding-v1",
	runId: payload.runId,
	attemptId: payload.attemptId,
	cwdSha256: sha(executionCwd),
	runsDirSha256: sha("/tmp/binding-cwd/.pi/agent/runs"),
	workerPid: 1234,
	launchPayloadSha256: "7".repeat(64),
	executionPlanSha256,
	barrierIdentitySha256: "1".repeat(64),
	barrierSubjectSha256: "2".repeat(64),
	authorityBindingSha256: "6".repeat(64),
	readySha256: "3".repeat(64),
	releaseSha256: "4".repeat(64),
	ackSha256: "5".repeat(64),
});
const correlated = prepareDurableWorkerBinding({
	payload: {
		...payload,
		input: {
			...payload.input,
			correlationId: "consumer:task-1",
			runsDir: ".runs",
		},
	},
	launchPayloadSha256: "7".repeat(64),
	executionPlanSha256,
	workerPid: 1234,
});
assert.equal(correlated.correlationId, "consumer:task-1");
assert.equal(correlated.runsDirSha256, sha("/tmp/binding-cwd/.runs"));
const installed = installDurableWorkerBinding({
	payload,
	launchPayloadSha256: "7".repeat(64),
	ack,
	executionPlanSha256,
	workerPid: 1234,
});
assert.deepEqual(JSON.parse(process.env[DURABLE_WORKER_BINDING_ENV]), installed);
assert.throws(
	() =>
		prepareDurableWorkerBinding({
			payload: {
				...payload,
				input: {
					...payload.input,
					durableLaunchBarrier: {
						...payload.input.durableLaunchBarrier,
						authorityBindingSha256: "forged",
					},
				},
			},
			launchPayloadSha256: "7".repeat(64),
			executionPlanSha256,
		}),
	(error) =>
		isDurableWorkerGuardError(error) &&
		/authority binding/u.test(error.message),
);
delete process.env[DURABLE_WORKER_BINDING_ENV];
console.log(
	JSON.stringify({
		result: "DURABLE_WORKER_BINDING_VALID",
		authorityBoundPerRun: true,
		ambientWorkflowGrantRemoved: true,
		optionalConsumerMetadataResolved: true,
		preflightBeforeAck: true,
		guardFailureTyped: true,
		barrierConsumedBeforeSynchronousExecution: true,
	}),
);
