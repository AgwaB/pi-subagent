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
export const createDurableLaunchBarrier = api.createDurableLaunchBarrier;
export const durableLaunchBarrierDigest = api.durableLaunchBarrierDigest;
export const DurableLaunchBarrierError = api.DurableLaunchBarrierError;
export const isDurableLaunchBarrierError = api.isDurableLaunchBarrierError;
export const releaseDurableLaunchBarrier = api.releaseDurableLaunchBarrier;
export const waitForDurableLaunchBarrierAck = api.waitForDurableLaunchBarrierAck;
export const waitForDurableLaunchBarrierReady = api.waitForDurableLaunchBarrierReady;
export const SubagentValidationError = api.SubagentValidationError;
