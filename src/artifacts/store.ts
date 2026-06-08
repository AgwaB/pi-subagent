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
const DEFAULT_TASK_ID = "task-1";
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  result: "result.json",
  stdout: "stdout.log",
  stderr: "stderr.log",
  output: "output.log",
  "worktree-status": "worktree.status.txt",
  "worktree-diff": "worktree.diff.patch",
};

export type LogArtifactType = Exclude<ArtifactType, "result">;

export interface CreateTaskArtifactStoreOptions {
  cwd?: string;
  runId?: string;
  taskId?: string;
  runsDir?: string;
}

export type StoreResultEnvelopeInput = Omit<ResultEnvelopeInput, "runId" | "taskId"> &
  Partial<Pick<ResultEnvelopeInput, "runId" | "taskId">>;

export interface TaskArtifactStore {
  runId: string;
  taskId: string;
  cwd: string;
  runsDir: string;
  runDir: string;
  taskDir: string;
  pathFor(type: ArtifactType): string;
  refFor(type: ArtifactType, bytes?: number): ArtifactRef;
  writeTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef>;
  appendTextArtifact(type: LogArtifactType, content: string | Uint8Array): Promise<ArtifactRef>;
  writeResult(input: StoreResultEnvelopeInput): Promise<ResultEnvelope>;
}

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

export async function createTaskArtifactStore(options: CreateTaskArtifactStoreOptions = {}): Promise<TaskArtifactStore> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runId = options.runId ?? createRunId();
  const taskId = options.taskId ?? DEFAULT_TASK_ID;

  assertSafeId("runId", runId);
  assertSafeId("taskId", taskId);

  const runsDir = resolve(cwd, options.runsDir ?? DEFAULT_RUNS_DIR);
  if (!isInsideOrEqual(cwd, runsDir)) {
    throw new Error("runsDir must be inside cwd so artifact refs can remain relative and safe.");
  }

  const runDir = join(runsDir, runId);
  const taskDir = join(runDir, taskId);
  await mkdir(taskDir, { recursive: true });

  function pathFor(type: ArtifactType): string {
    return join(taskDir, ARTIFACT_FILENAMES[type]);
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
      taskId: input.taskId ?? taskId,
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
    taskId,
    cwd,
    runsDir,
    runDir,
    taskDir,
    pathFor,
    refFor,
    writeTextArtifact,
    appendTextArtifact,
    writeResult,
  };
}
