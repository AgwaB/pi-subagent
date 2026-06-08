import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const api = await jiti.import("./src/api.ts");

export const runSubagent = api.runSubagent;
export const getSubagentStatus = api.getSubagentStatus;
export const getSubagentLogs = api.getSubagentLogs;
export const waitForSubagent = api.waitForSubagent;
export const interruptSubagent = api.interruptSubagent;
export const SubagentValidationError = api.SubagentValidationError;
