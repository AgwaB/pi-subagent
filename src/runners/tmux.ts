import { execFile } from "node:child_process";
import { chmod, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createTaskArtifactStore, type ArtifactRef, type ResultEnvelope } from "../artifacts/index.ts";
import type { ResultWorkspace } from "../artifacts/result.ts";
import type { FailureKind, SandboxInput, Status } from "../core/constants.ts";
import { SandboxUnavailableError, withSandboxedArgv } from "../sandbox/srt.ts";
import { buildPiArgv, parsePiJsonLines, type RunHeadlessModelOptions } from "./headless-model.ts";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 100;

interface RunTmuxProcessOptions {
  argv: readonly string[];
  cwd?: string;
  artifactCwd?: string;
  runId?: string;
  taskId?: string;
  runsDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  sandbox?: SandboxInput | null;
  workspace?: Partial<ResultWorkspace>;
}

export type RunTmuxModelOptions = RunHeadlessModelOptions;

interface WorkerMeta {
  status: Status;
  failureKind: FailureKind | null;
  exitCode: number | null;
  signal: string | null;
}

interface TmuxRunResult {
  meta: WorkerMeta;
  stdoutRef: ArtifactRef;
  stderrRef: ArtifactRef;
  tmux: {
    sessionName: string;
    sessionId: string | null;
    paneId: string | null;
  };
}

function assertRunnableArgv(argv: readonly string[]): asserts argv is readonly [string, ...string[]] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("argv must be a non-empty array of non-empty strings.");
  }

  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`argv[${index}] must be a non-empty string.`);
    }
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number when provided.");
  }
  return timeoutMs;
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

async function pathBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readWorkerMeta(path: string): Promise<WorkerMeta | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WorkerMeta>;
    if (parsed.status !== "completed" && parsed.status !== "failed") return undefined;
    return {
      status: parsed.status,
      failureKind: parsed.failureKind ?? null,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
    };
  } catch {
    return undefined;
  }
}

async function tmuxSessionAlive(sessionName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
    // Session may already have exited; cleanup remains best-effort.
  }
}

function workerScript(argv: readonly [string, ...string[]], cwd: string, stdoutPath: string, stderrPath: string, metaPath: string): string {
  return `import { spawn } from "node:child_process";\nimport { appendFileSync, closeSync, openSync, writeFileSync } from "node:fs";\nconst argv = ${JSON.stringify(argv)};\nconst cwd = ${JSON.stringify(cwd)};\nconst stdoutPath = ${JSON.stringify(stdoutPath)};\nconst stderrPath = ${JSON.stringify(stderrPath)};\nconst metaPath = ${JSON.stringify(metaPath)};\ncloseSync(openSync(stdoutPath, "w"));\ncloseSync(openSync(stderrPath, "w"));\nlet settled = false;\nfunction writeMeta(meta) {\n  if (settled) return;\n  settled = true;\n  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\\n");\n}\nconst env = { ...process.env };\ndelete env.TMUX;\nconst child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });\nchild.stdout?.on("data", (chunk) => { appendFileSync(stdoutPath, chunk); process.stdout.write(chunk); });\nchild.stderr?.on("data", (chunk) => { appendFileSync(stderrPath, chunk); process.stderr.write(chunk); });\nchild.on("error", () => { writeMeta({ status: "failed", failureKind: "spawn", exitCode: null, signal: null }); });\nchild.on("close", (exitCode, signal) => {\n  const failureKind = exitCode === 0 ? null : "exit";\n  writeMeta({ status: failureKind === null ? "completed" : "failed", failureKind, exitCode, signal });\n});\n`;
}

async function runTmuxProcess(options: RunTmuxProcessOptions): Promise<{ result: TmuxRunResult | null; store: Awaited<ReturnType<typeof createTaskArtifactStore>>; cwd: string; artifactCwd: string; startedAt: Date; failure?: WorkerMeta; stderr?: string }> {
  const argv = options.argv;
  assertRunnableArgv(argv);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const cwd = resolve(options.cwd ?? process.cwd());
  const artifactCwd = resolve(options.artifactCwd ?? cwd);
  const startedAt = new Date();
  const store = await createTaskArtifactStore({ cwd: artifactCwd, runId: options.runId, taskId: options.taskId, runsDir: options.runsDir });

  if (!(await tmuxAvailable())) {
    return {
      result: null,
      store,
      cwd,
      artifactCwd,
      startedAt,
      failure: { status: "failed", failureKind: "spawn", exitCode: null, signal: null },
      stderr: "tmux is not available on PATH; install tmux or choose backend \"headless\".\n",
    };
  }

  const sessionName = `pi-subagent-${store.runId}-${store.taskId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const stdoutPath = store.pathFor("stdout");
  const stderrPath = store.pathFor("stderr");
  const metaPath = join(store.taskDir, "tmux-worker-meta.json");
  const scriptPath = join(store.taskDir, "tmux-worker.mjs");
  const launchPath = join(store.taskDir, "tmux-launch.sh");

  await writeFile(scriptPath, workerScript(argv, cwd, stdoutPath, stderrPath, metaPath));

  await writeFile(launchPath, `#!/usr/bin/env bash\nset -euo pipefail\nunset TMUX\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}\n`);
  await chmod(launchPath, 0o700);

  async function runSession(tmuxCommand: string, tmuxArgs: readonly string[], tmuxEnv?: NodeJS.ProcessEnv): Promise<{ result: TmuxRunResult | null; store: Awaited<ReturnType<typeof createTaskArtifactStore>>; cwd: string; artifactCwd: string; startedAt: Date; failure?: WorkerMeta; stderr?: string }> {
    let sessionId: string | null = null;
    let paneId: string | null = null;
    try {
      const { stdout } = await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-P", "-F", "#{session_id}\t#{pane_id}", tmuxCommand, ...tmuxArgs], { cwd, ...(tmuxEnv === undefined ? {} : { env: tmuxEnv }) });
      const [rawSessionId, rawPaneId] = stdout.trim().split("\t");
      sessionId = rawSessionId || null;
      paneId = rawPaneId || null;
    } catch (error) {
      return {
        result: null,
        store,
        cwd,
        artifactCwd,
        startedAt,
        failure: { status: "failed", failureKind: "spawn", exitCode: null, signal: null },
        stderr: error instanceof Error ? `${error.message}\n` : `${String(error)}\n`,
      };
    }

    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let stopKind: "timeout" | "abort" | null = null;

    while (true) {
      const meta = await readWorkerMeta(metaPath);
      if (meta !== undefined) {
        await killTmuxSession(sessionName);
        return {
          result: {
            meta,
            stdoutRef: store.refFor("stdout", await pathBytes(stdoutPath)),
            stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
            tmux: { sessionName, sessionId, paneId },
          },
          store,
          cwd,
          artifactCwd,
          startedAt,
        };
      }

      if (options.signal?.aborted) stopKind = "abort";
      if (deadline !== undefined && Date.now() >= deadline) stopKind = "timeout";
      if (stopKind !== null) {
        await killTmuxSession(sessionName);
        return {
          result: {
            meta: { status: "failed", failureKind: stopKind, exitCode: null, signal: "SIGTERM" },
            stdoutRef: store.refFor("stdout", await pathBytes(stdoutPath)),
            stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
            tmux: { sessionName, sessionId, paneId },
          },
          store,
          cwd,
          artifactCwd,
          startedAt,
        };
      }

      if (!(await tmuxSessionAlive(sessionName))) {
        return {
          result: {
            meta: { status: "failed", failureKind: "spawn", exitCode: null, signal: null },
            stdoutRef: store.refFor("stdout", await pathBytes(stdoutPath)),
            stderrRef: store.refFor("stderr", await pathBytes(stderrPath)),
            tmux: { sessionName, sessionId, paneId },
          },
          store,
          cwd,
          artifactCwd,
          startedAt,
        };
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    if (options.sandbox) {
      return await withSandboxedArgv([process.execPath, scriptPath], { sandbox: options.sandbox, cwd, writablePaths: [store.taskDir], allowPty: true, signal: options.signal }, async (launch) => {
        await writeFile(launchPath, `#!/usr/bin/env bash\nset -euo pipefail\nunset TMUX\nexec ${launch.argv.map(shellQuote).join(" ")}\n`);
        await chmod(launchPath, 0o700);
        return await runSession("/bin/bash", [launchPath], launch.env);
      });
    }
    return await runSession("/bin/bash", [launchPath]);
  } catch (error) {
    if (!(error instanceof SandboxUnavailableError)) throw error;
    return {
      result: null,
      store,
      cwd,
      artifactCwd,
      startedAt,
      failure: { status: "failed", failureKind: "sandbox", exitCode: null, signal: null },
      stderr: `${error.message}\n`,
    };
  }
}

export async function runTmuxModel(options: RunTmuxModelOptions): Promise<ResultEnvelope> {
  const sandbox = options.sandbox ? { enabled: true } : { enabled: false };
  if (typeof options.agent !== "string" || options.agent.length === 0) {
    throw new Error("agent must be a non-empty string.");
  }
  if (typeof options.task !== "string" || options.task.length === 0) {
    throw new Error("task must be a non-empty string.");
  }

  const { result, store, cwd, artifactCwd, startedAt, failure, stderr } = await runTmuxProcess({ ...options, argv: buildPiArgv(options) });
  if (result === null) {
    const artifacts: ArtifactRef[] = [await store.writeTextArtifact("stdout", ""), await store.writeTextArtifact("stderr", stderr ?? ""), await store.writeTextArtifact("output", "")];
    return await store.writeResult({
      backend: "tmux",
      status: failure?.status ?? "failed",
      failureKind: failure?.failureKind ?? "spawn",
      cwd: artifactCwd,
      startedAt,
      completedAt: new Date(),
      workspace: options.workspace ?? { mode: "shared", cwd },
      sandbox,
      exitCode: failure?.exitCode ?? null,
      signal: failure?.signal ?? null,
      artifacts,
    });
  }

  const stdoutText = await import("node:fs/promises").then(({ readFile }) => readFile(store.pathFor("stdout"), "utf8").catch(() => ""));
  const parsed = parsePiJsonLines(stdoutText);
  let meta = result.meta;
  if (meta.status === "completed" && parsed.parseErrors.length > 0 && parsed.finalAssistantText.length === 0) {
    meta = { ...meta, status: "failed", failureKind: "parse" };
  } else if (meta.status === "completed" && parsed.errors.length > 0) {
    meta = { ...meta, status: "failed", failureKind: "model" };
  }

  const outputRef = await store.writeTextArtifact("output", parsed.finalAssistantText);
  return await store.writeResult({
    backend: "tmux",
    status: meta.status,
    failureKind: meta.failureKind,
    cwd: artifactCwd,
    startedAt,
    completedAt: new Date(),
    workspace: options.workspace ?? { mode: "shared", cwd },
    sandbox,
    exitCode: meta.exitCode,
    signal: meta.signal,
    artifacts: [result.stdoutRef, result.stderrRef, outputRef],
    tmux: result.tmux,
  });
}
