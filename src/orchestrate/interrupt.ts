import { appendRunEvent, readRunRecord, recordInterruptRequest, type RunRecord, type RunTaskRecord } from "../artifacts/index.ts";
import { isTerminalStatus } from "./status.ts";

export interface InterruptRunOptions {
  cwd?: string;
  runId: string;
  runsDir?: string;
  reason?: string;
  signal?: NodeJS.Signals;
  escalateAfterMs?: number;
  killAfterMs?: number;
}

export interface InterruptRunResult {
  status: "interrupt-requested" | "not-found" | "already-terminal" | "unsupported";
  runId: string;
  signal: NodeJS.Signals;
  interruptedTasks: string[];
  unsupportedTasks: string[];
  record: RunRecord | null;
}

function sendProcessSignal(task: RunTaskRecord, signal: NodeJS.Signals): boolean {
  const pid = task.process?.pid;
  if (pid === undefined) return false;
  try {
    const target = process.platform === "win32" ? pid : -(task.process?.processGroupId ?? pid);
    process.kill(target, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function runningTasks(record: RunRecord): RunTaskRecord[] {
  return record.tasks.filter((task) => task.status === "running" || task.status === "pending");
}

async function escalate(options: InterruptRunOptions, signal: NodeJS.Signals): Promise<void> {
  const record = await readRunRecord(options).catch(() => null);
  if (record === null || isTerminalStatus(record.status)) return;
  for (const task of runningTasks(record)) sendProcessSignal(task, signal);
  await appendRunEvent(options, { type: "run.interrupt_requested", status: record.status, message: `interrupt escalation ${signal}`, data: { signal } }).catch(() => undefined);
}

export async function interruptRun(options: InterruptRunOptions): Promise<InterruptRunResult> {
  const signal = options.signal ?? "SIGINT";
  const record = await readRunRecord(options);
  if (record === null) {
    return { status: "not-found", runId: options.runId, signal, interruptedTasks: [], unsupportedTasks: [], record: null };
  }
  if (isTerminalStatus(record.status)) {
    return { status: "already-terminal", runId: options.runId, signal, interruptedTasks: [], unsupportedTasks: [], record };
  }

  const candidates = runningTasks(record);
  const interruptedTasks: string[] = [];
  const unsupportedTasks: string[] = [];
  for (const task of candidates) {
    if (sendProcessSignal(task, signal)) interruptedTasks.push(task.taskId);
    else unsupportedTasks.push(task.taskId);
  }

  if (interruptedTasks.length === 0) {
    await appendRunEvent(options, { type: "run.interrupt_requested", status: record.status, message: "interrupt unsupported: no interruptable process metadata", data: { signal, unsupportedTasks } });
    return { status: "unsupported", runId: options.runId, signal, interruptedTasks, unsupportedTasks, record };
  }

  const updated = await recordInterruptRequest(options, signal, options.reason ?? null);
  await appendRunEvent(options, {
    type: "run.interrupt_requested",
    status: updated.status,
    message: `interrupt requested with ${signal}`,
    data: { signal, interruptedTasks, unsupportedTasks, reason: options.reason ?? null },
  });

  const termDelay = options.escalateAfterMs ?? 1_000;
  const killDelay = options.killAfterMs ?? 3_000;
  setTimeout(() => void escalate(options, "SIGTERM"), termDelay).unref?.();
  setTimeout(() => void escalate(options, "SIGKILL"), killDelay).unref?.();

  return { status: "interrupt-requested", runId: options.runId, signal, interruptedTasks, unsupportedTasks, record: updated };
}
