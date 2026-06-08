import type { SandboxInput } from "../core/constants.ts";

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

function defaultConfig(cwd: string, writablePaths: readonly string[], allowPty: boolean): SandboxRuntimeConfig {
  const allowWrite = Array.from(new Set([cwd, ...writablePaths]));
  return {
    network: { allowedDomains: [], deniedDomains: [] },
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
    const srt = await importSandboxRuntime();

    if (!srt.SandboxManager.isSupportedPlatform()) {
      throw new SandboxUnavailableError("sandbox runtime does not support this platform");
    }

    const dependencyCheck = srt.SandboxManager.checkDependencies();
    if (dependencyCheck.errors.length > 0) {
      throw new SandboxUnavailableError(`sandbox dependencies are not available: ${dependencyCheck.errors.join("; ")}`);
    }

    const config = defaultConfig(options.cwd, options.writablePaths ?? [], options.allowPty ?? false);
    validateConfig(srt, config);

    try {
      await srt.SandboxManager.initialize(config);
      const wrapped = await srt.SandboxManager.wrapWithSandboxArgv(commandFromArgv(argv), undefined, undefined, options.signal);
      if (!Array.isArray(wrapped.argv) || wrapped.argv.length === 0 || wrapped.argv.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        throw new SandboxUnavailableError("sandbox runtime returned an invalid argv wrapper");
      }
      return await run({ argv: wrapped.argv as [string, ...string[]], env: wrapped.env });
    } catch (error) {
      if (error instanceof SandboxUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new SandboxUnavailableError(`sandbox setup or execution failed: ${message}`);
    } finally {
      try {
        srt.SandboxManager.cleanupAfterCommand();
      } catch {
        // Best-effort cleanup; reset below is the fail-closed cleanup path.
      }
      await srt.SandboxManager.reset();
    }
  });
}
