import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createResultEnvelope,
  mergeArtifactRefs,
  type ArtifactRef,
  type ArtifactType,
  type ResultEnvelope,
  type ResultEnvelopeInput,
} from "./result.ts";

const DEFAULT_RUNS_DIR = ".pi/agent/runs";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  result: "result.json",
  stdout: "stdout.log",
  stderr: "stderr.log",
  output: "output.log",
  worker: "worker.json",
  "worktree-status": "worktree.status.txt",
  "worktree-diff": "worktree.diff.patch",
  "tool-calls": "tool-calls.jsonl",
  "tool-calls-summary": "tool-calls-summary.json",
};

export type LogArtifactType = Exclude<ArtifactType, "result" | "worker">;

export interface CreateAttemptArtifactStoreOptions {
  cwd?: string;
  runId?: string;
  attemptId?: string;
  runsDir?: string;
  /** @deprecated v1 compatibility only; mapped to attemptId when attemptId is absent. */
  taskId?: string;
}

export type StoreResultEnvelopeInput = Omit<ResultEnvelopeInput, "runId" | "attemptId"> &
  Partial<Pick<ResultEnvelopeInput, "runId" | "attemptId">>;

export interface AttemptArtifactStore {
  runId: string;
  attemptId: string;
  cwd: string;
  runsDir: string;
  runDir: string;
  attemptsDir: string;
  attemptDir: string;
  pathFor(type: ArtifactType): string;
  refFor(type: ArtifactType, bytes?: number): ArtifactRef;
  writeTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef>;
  appendTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef>;
  writeResult(input: StoreResultEnvelopeInput): Promise<ResultEnvelope>;
  /** @deprecated v1 compatibility only. */
  taskId: string;
  /** @deprecated v1 compatibility only. */
  taskDir: string;
}

export type CreateTaskArtifactStoreOptions = CreateAttemptArtifactStoreOptions;
export type TaskArtifactStore = AttemptArtifactStore;

function assertSafeId(name: string, value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, or dashes.`);
  }
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function toSafeRelativePath(cwd: string, artifactPath: string): string {
  const artifactRelative = relative(cwd, artifactPath);
  if (artifactRelative === "" || artifactRelative.startsWith("..") || isAbsolute(artifactRelative)) {
    throw new Error("artifact path must stay inside cwd to be exposed as a relative tool path.");
  }
  return artifactRelative.split(sep).join("/");
}

function byteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

export function createRunId(now: Date = new Date()): string {
  return `run_${now.getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function createAttemptId(now: Date = new Date()): string {
  return `attempt_${now.getTime().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export async function createAttemptArtifactStore(options: CreateAttemptArtifactStoreOptions = {}): Promise<AttemptArtifactStore> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runId = options.runId ?? createRunId();
  const attemptId = options.attemptId ?? options.taskId ?? createAttemptId();

  assertSafeId("runId", runId);
  assertSafeId("attemptId", attemptId);

  const runsDir = resolve(cwd, options.runsDir ?? DEFAULT_RUNS_DIR);
  if (!isInsideOrEqual(cwd, runsDir)) {
    throw new Error("runsDir must be inside cwd so artifact refs can remain relative and safe.");
  }

  const runDir = join(runsDir, runId);
  const attemptsDir = join(runDir, "attempts");
  const attemptDir = join(attemptsDir, attemptId);
  await mkdir(attemptDir, { recursive: true });

  function pathFor(type: ArtifactType): string {
    return join(attemptDir, ARTIFACT_FILENAMES[type]);
  }

  function refFor(type: ArtifactType, bytes?: number): ArtifactRef {
    return {
      type,
      path: toSafeRelativePath(cwd, pathFor(type)),
      ...(bytes === undefined ? {} : { bytes }),
    };
  }

  async function writeTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef> {
    await writeFile(pathFor(type), content);
    return refFor(type, byteLength(content));
  }

  async function appendTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef> {
    await appendFile(pathFor(type), content);
    return refFor(type, await fileSize(pathFor(type)));
  }

  async function writeResult(input: StoreResultEnvelopeInput): Promise<ResultEnvelope> {
    const result = createResultEnvelope({
      ...input,
      runId: input.runId ?? runId,
      attemptId: input.attemptId ?? attemptId,
      artifacts: mergeArtifactRefs(input.artifacts ?? [], [refFor("result")]),
    });
    const resultPath = pathFor("result");
    const tempPath = `${resultPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`);
    await rename(tempPath, resultPath);
    return result;
  }

  return {
    runId,
    attemptId,
    cwd,
    runsDir,
    runDir,
    attemptsDir,
    attemptDir,
    pathFor,
    refFor,
    writeTextArtifact,
    appendTextArtifact,
    writeResult,
    taskId: attemptId,
    taskDir: attemptDir,
  };
}

/** @deprecated Use createAttemptArtifactStore. */
export async function createTaskArtifactStore(options: CreateTaskArtifactStoreOptions = {}): Promise<TaskArtifactStore> {
  return await createAttemptArtifactStore(options);
}
