import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sandboxAllowedDomains, type SandboxInput } from "../core/constants.ts";

interface SandboxRuntimeConfig {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  ignoreViolations: Record<string, string[]>;
  allowPty: boolean;
}

interface SandboxRuntimeModule {
  SandboxManager: {
    initialize(config: SandboxRuntimeConfig): Promise<void>;
    isSupportedPlatform(): boolean;
    checkDependencies(): { warnings: string[]; errors: string[] };
    wrapWithSandboxArgv(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, abortSignal?: AbortSignal): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
  };
  SandboxRuntimeConfigSchema?: {
    safeParse(value: unknown): { success: true } | { success: false; error: { message: string } };
  };
}

export interface SandboxLaunch {
  argv: readonly [string, ...string[]];
  env: NodeJS.ProcessEnv;
}

export interface SandboxWrapOptions {
  sandbox: SandboxInput;
  cwd: string;
  writablePaths?: readonly string[];
  allowPty?: boolean;
  signal?: AbortSignal;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

let sandboxQueue: Promise<void> = Promise.resolve();
let sandboxPoisonedError: Error | undefined;
const SANDBOX_RESET_TIMEOUT_MS = 5_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandFromArgv(argv: readonly [string, ...string[]]): string {
  return argv.map(shellQuote).join(" ");
}

async function importSandboxRuntime(): Promise<SandboxRuntimeModule> {
  try {
    return (await import("@anthropic-ai/sandbox-runtime")) as SandboxRuntimeModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxUnavailableError(`could not import @anthropic-ai/sandbox-runtime: ${message}`);
  }
}

/**
 * Pi (0.84+) takes `proper-lockfile` directory locks next to its config files
 * even for reads, so a sandboxed child that cannot create
 * `<agentDir>/settings.json.lock` or `<agentDir>/auth.json.lock` starts
 * without settings or credentials and every model run fails. Grant write on
 * those exact lock paths only; the config files themselves stay read-only.
 */
export function piAgentDirLockPaths(env: NodeJS.ProcessEnv = process.env, childCwd: string = process.cwd()): string[] {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  // The child inherits the environment unchanged and resolves a relative
  // override against its own cwd, so resolve it against the child's cwd here.
  const agentDir = override ? resolve(childCwd, override) : join(homedir(), ".pi", "agent");
  return ["settings.json.lock", "auth.json.lock", "trust.json.lock"].map((name) => join(agentDir, name));
}

function defaultConfig(sandbox: SandboxInput, cwd: string, writablePaths: readonly string[], allowPty: boolean): SandboxRuntimeConfig {
  const allowWrite = Array.from(new Set([cwd, ...writablePaths, ...piAgentDirLockPaths(process.env, cwd)]));
  return {
    // Empty allowedDomains means deny-all network in @anthropic-ai/sandbox-runtime.
    // Callers opt into egress per run via sandbox.allowedDomains.
    network: { allowedDomains: sandboxAllowedDomains(sandbox), deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite, denyWrite: [] },
    ignoreViolations: {},
    allowPty,
  };
}

function validateConfig(srt: SandboxRuntimeModule, config: SandboxRuntimeConfig): void {
  const parsed = srt.SandboxRuntimeConfigSchema?.safeParse(config);
  if (parsed && !parsed.success) {
    throw new SandboxUnavailableError(`invalid sandbox configuration: ${parsed.error.message}`);
  }
}

async function acquireSandboxLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = sandboxQueue;
  let release!: () => void;
  sandboxQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export async function withSandboxedArgv<T>(
  argv: readonly [string, ...string[]],
  options: SandboxWrapOptions,
  run: (launch: SandboxLaunch) => Promise<T>,
): Promise<T> {
  return await acquireSandboxLock(async () => {
    if (sandboxPoisonedError !== undefined) throw sandboxPoisonedError;
    const srt = await importSandboxRuntime();

    if (!srt.SandboxManager.isSupportedPlatform()) {
      throw new SandboxUnavailableError("sandbox runtime does not support this platform");
    }

    const dependencyCheck = srt.SandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      throw new SandboxUnavailableError(`sandbox dependencies are not available: ${dependencyCheck.errors.join("; ")}`);
    }

    const config = defaultConfig(options.sandbox, options.cwd, options.writablePaths ?? [], options.allowPty ?? false);
    validateConfig(srt, config);

    let result!: T;
    let primaryFailed = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      let launch: SandboxLaunch;
      try {
        await srt.SandboxManager.initialize(config);
        const wrapped = await srt.SandboxManager.wrapWithSandboxArgv(commandFromArgv(argv), undefined, undefined, options.signal);
        if (!Array.isArray(wrapped.argv) || wrapped.argv.length === 0 || wrapped.argv.some((entry) => typeof entry !== "string" || entry.length === 0)) {
          throw new SandboxUnavailableError("sandbox runtime returned an invalid argv wrapper");
        }
        launch = { argv: wrapped.argv as [string, ...string[]], env: wrapped.env };
      } catch (error) {
        primaryFailed = true;
        if (options.signal?.aborted) {
          primaryError = Object.assign(
            error instanceof Error ? error : new Error(String(error)),
            { failureKind: "abort" as const },
          );
        } else if (error instanceof SandboxUnavailableError) {
          primaryError = error;
        } else {
          const message = error instanceof Error ? error.message : String(error);
          primaryError = new SandboxUnavailableError(`sandbox setup failed: ${message}`);
        }
      }

      if (!primaryFailed) {
        try {
          result = await run(launch!);
        } catch (error) {
          primaryFailed = true;
          primaryError = error;
        }
      }
    } finally {
      try {
        srt.SandboxManager.cleanupAfterCommand();
      } catch {
        // Best-effort cleanup; reset below is the fail-closed cleanup path.
      }
      try {
        await Promise.race([
          srt.SandboxManager.reset(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("sandbox reset timed out")),
              SANDBOX_RESET_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (error) {
        cleanupError = error;
        sandboxPoisonedError = Object.assign(
          new Error(
            `sandbox cleanup is unresolved: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
          { failureKind: "internal" as const, terminalBlocked: true as const },
        );
      }
    }
    if (cleanupError !== undefined) {
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      if (primaryFailed) {
        throw Object.assign(
          new AggregateError(
            [primaryError, cleanupError],
            `sandbox execution and cleanup failed: ${cleanupMessage}`,
          ),
          { failureKind: "internal" as const, terminalBlocked: true as const },
        );
      }
      throw sandboxPoisonedError;
    }
    if (primaryFailed) throw primaryError;
    return result;
  });
}
