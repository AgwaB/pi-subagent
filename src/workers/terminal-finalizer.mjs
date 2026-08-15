#!/usr/bin/env node
import { createJiti } from "jiti";

const encoded = process.argv[2];
if (!encoded) process.exit(2);
const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const jiti = createJiti(import.meta.url, { interopDefault: false });
const [reconciliation, artifacts, identity] = await Promise.all([
	jiti.import("../orchestrate/reconcile.ts"),
	jiti.import("../artifacts/index.ts"),
	jiti.import("../process-identity.ts"),
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let index = 0; index < 600; index += 1) {
	const workerState = await identity.verifyProcessIdentity(payload.worker);
	const groupState = identity.inspectProcessGroup(payload.worker.processGroupId);
	if (workerState !== "alive" && groupState === "dead") break;
	if (workerState === "unknown" || groupState === "unknown") process.exit(3);
	if (index === 599) process.exit(4);
	await sleep(100);
}
for (let index = 0; index < 100; index += 1) {
	const reconciled = await reconciliation.reconcileSubagentRun({
		...payload.ref,
		staleAfterMs: 0,
	});
	if (
		reconciled.status === "committed-result" ||
		reconciled.status === "already-terminal"
	) {
		const terminalType =
			payload.status === "completed"
				? "completed"
				: payload.status === "cancelled"
					? "cancelled"
					: "failed";
		const events = await artifacts.readRunEvents(payload.ref, Infinity);
		if (
			!events.some(
				(event) =>
					event.type === `attempt.${terminalType}` &&
					event.attemptId === payload.attemptId,
			)
		)
			await artifacts.appendRunEvent(payload.ref, {
				type: `attempt.${terminalType}`,
				attemptId: payload.attemptId,
				status: payload.status,
				message: "durable worker exited and ownership was drained",
			}).catch(() => undefined);
		if (!events.some((event) => event.type === `run.${terminalType}`))
			await artifacts.appendRunEvent(payload.ref, {
				type: `run.${terminalType}`,
				status: payload.status,
				message: `run ${payload.status}`,
			}).catch(() => undefined);
		process.exit(0);
	}
	await sleep(100);
}
process.exit(5);
