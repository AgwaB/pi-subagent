import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const api = await jiti.import("./src/api.ts");

export const runSubagent = api.runSubagent;
export const getSubagentStatus = api.getSubagentStatus;
export const getSubagentLogs = api.getSubagentLogs;
export const waitForSubagent = api.waitForSubagent;
export const interruptSubagent = api.interruptSubagent;
export const reconcileSubagentRun = api.reconcileSubagentRun;
export const recordSubagentChildEvent = api.recordSubagentChildEvent;
export const assertDurableLaunchBarrierV2ExecutionAuthorized =
	api.assertDurableLaunchBarrierV2ExecutionAuthorized;
export const createDurableLaunchBarrier = api.createDurableLaunchBarrier;
export const createDurableLaunchBarrierV2 = api.createDurableLaunchBarrierV2;
export const durableLaunchBarrierDigest = api.durableLaunchBarrierDigest;
export const DurableLaunchBarrierError = api.DurableLaunchBarrierError;
export const DurableLaunchBarrierRevokedError =
	api.DurableLaunchBarrierRevokedError;
export const isDurableLaunchBarrierError = api.isDurableLaunchBarrierError;
export const isDurableLaunchBarrierRevokedError =
	api.isDurableLaunchBarrierRevokedError;
export const readDurableLaunchBarrierV2State =
	api.readDurableLaunchBarrierV2State;
export const releaseDurableLaunchBarrier = api.releaseDurableLaunchBarrier;
export const resolveDurableLaunchBarrierV2Release =
	api.resolveDurableLaunchBarrierV2Release;
export const revokeDurableLaunchBarrierV2 = api.revokeDurableLaunchBarrierV2;
export const waitForDurableLaunchBarrierAck = api.waitForDurableLaunchBarrierAck;
export const waitForDurableLaunchBarrierReady = api.waitForDurableLaunchBarrierReady;
export const waitForDurableLaunchBarrierV2Ack =
	api.waitForDurableLaunchBarrierV2Ack;
export const waitForDurableLaunchBarrierV2Ready =
	api.waitForDurableLaunchBarrierV2Ready;
export const SubagentValidationError = api.SubagentValidationError;
