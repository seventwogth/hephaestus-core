import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, lstat, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, join } from "node:path";

export type SandboxRunnerOptions =
  | { type?: "host" }
  | DockerSandboxRunnerOptions;

export interface DockerSandboxRunnerOptions {
  type: "docker";
  image: string;
  dockerCommand?: string;
  workspaceMount?: string;
  network?: string;
  user?: string;
  cpus?: string;
  memory?: string;
  pidsLimit?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  signal: NodeJS.Signals | null;
  runner: "host" | "docker";
}

export interface SandboxOptions {
  rootDir: string;
  allowedCommands: string[];
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  inheritEnv?: string[];
  runner?: SandboxRunnerOptions;
}

export class ProjectSandbox {
  private readonly rootDir: string;
  private readonly allowedCommands: Set<string>;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly envOverrides: Record<string, string | undefined>;
  private readonly inheritedEnvNames: string[];
  private readonly runner: SandboxRunnerOptions;

  constructor(options: SandboxOptions) {
    this.rootDir = resolve(options.rootDir);
    this.allowedCommands = new Set(options.allowedCommands);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.killGraceMs = Math.max(0, options.killGraceMs ?? 1_000);
    this.maxOutputBytes = Math.max(0, options.maxOutputBytes ?? 1_048_576);
    this.envOverrides = options.env ?? {};
    this.inheritedEnvNames = options.inheritEnv ?? [];
    this.runner = options.runner ?? { type: "host" };
  }

  async readText(path: string): Promise<string> {
    const target = this.resolveInsideRoot(path);
    await this.assertSafeExistingFile(target, path);
    return readFile(target, "utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = this.resolveInsideRoot(path);
    await mkdir(dirname(target), { recursive: true });
    await this.assertSafeWriteTarget(target, path);
    await writeFile(target, content, "utf8");
  }

  async run(command: string, args: string[] = [], cwd = "."): Promise<CommandResult> {
    if (!this.allowedCommands.has(command)) {
      throw new Error(`Command is not allowed: ${command}`);
    }

    const workingDirectory = this.resolveInsideRoot(cwd);
    await this.assertSafeWorkingDirectory(workingDirectory, cwd);
    const env = await this.buildCommandEnv(this.runnerType());
    const commandSpec = buildCommandSpec({
      runner: this.runner,
      rootDir: this.rootDir,
      command,
      args,
      cwd,
      env
    });

    return new Promise((resolvePromise, reject) => {
      const child = spawn(commandSpec.command, commandSpec.args, {
        cwd: commandSpec.hostCwd ?? workingDirectory,
        shell: false,
        detached: process.platform !== "win32",
        env: commandSpec.hostEnv
      });

      let stdout = createLimitedOutputBuffer(this.maxOutputBytes);
      let stderr = createLimitedOutputBuffer(this.maxOutputBytes);
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, "SIGTERM");
        killTimer = setTimeout(() => {
          killProcessTree(child.pid, "SIGKILL");
        }, this.killGraceMs);
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.append(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr.append(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (!settled) {
          settled = true;
          resolvePromise({
            command,
            args,
            cwd: workingDirectory,
            exitCode,
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            timedOut,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            signal,
            runner: commandSpec.runner
          });
        }
      });
    });
  }

  async cleanupRuntimeDirs(): Promise<void> {
    const paths = this.getRuntimeDirs();
    for (const path of paths) {
      await this.removeRuntimeDir(path);
    }
  }

  resolveInsideRoot(path: string): string {
    const target = resolve(this.rootDir, path);
    const relation = relative(this.rootDir, target);

    if (relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"))) {
      return target;
    }

    throw new Error(`Path escapes project root: ${path}`);
  }

  private async buildCommandEnv(runner: "host" | "docker"): Promise<Record<string, string>> {
    const hostRuntimeDirs = this.getRuntimeDirMap(this.rootDir);
    const envRuntimeDirs = runner === "docker"
      ? this.getRuntimeDirMap(DEFAULT_CONTAINER_WORKSPACE)
      : hostRuntimeDirs;
    const env: Record<string, string> = {};

    await mkdir(hostRuntimeDirs.homeDir, { recursive: true });
    await mkdir(hostRuntimeDirs.tmpDir, { recursive: true });
    await mkdir(join(hostRuntimeDirs.cacheDir, "npm"), { recursive: true });
    await mkdir(join(hostRuntimeDirs.cacheDir, "go-build"), { recursive: true });
    await mkdir(join(hostRuntimeDirs.cacheDir, "go-mod"), { recursive: true });

    copyEnvIfSet(env, "PATH");
    copyEnvIfSet(env, "LANG");
    copyEnvIfSet(env, "LC_ALL");
    copyEnvIfSet(env, "NO_COLOR");

    for (const name of this.inheritedEnvNames) {
      copyEnvIfSet(env, name);
    }

    env.HOME = envRuntimeDirs.homeDir;
    env.TMPDIR = envRuntimeDirs.tmpDir;
    env.npm_config_cache = join(envRuntimeDirs.cacheDir, "npm");
    env.GOCACHE = join(envRuntimeDirs.cacheDir, "go-build");
    env.GOMODCACHE = join(envRuntimeDirs.cacheDir, "go-mod");
    env.CI = process.env.CI ?? "true";

    for (const [name, value] of Object.entries(this.envOverrides)) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }

    return env;
  }

  private runnerType(): "host" | "docker" {
    return this.runner.type === "docker" ? "docker" : "host";
  }

  private getRuntimeDirMap(rootDir: string): { homeDir: string; tmpDir: string; cacheDir: string } {
    return {
      homeDir: join(rootDir, ".hephaestus-home"),
      tmpDir: join(rootDir, ".hephaestus-tmp"),
      cacheDir: join(rootDir, ".hephaestus-cache")
    };
  }

  private getRuntimeDirs(): string[] {
    const { homeDir, tmpDir, cacheDir } = this.getRuntimeDirMap(this.rootDir);
    return [homeDir, tmpDir, cacheDir];
  }

  private async removeRuntimeDir(path: string): Promise<void> {
    try {
      await this.chmodRecursive(path);
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private async chmodRecursive(path: string): Promise<void> {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    if (info.isSymbolicLink()) {
      return;
    }

    await chmod(path, 0o700);

    if (!info.isDirectory()) {
      return;
    }

    const entries = await readdir(path);
    await Promise.all(entries.map((entry) => this.chmodRecursive(join(path, entry))));
  }

  private async assertSafeWorkingDirectory(target: string, requestedPath: string): Promise<void> {
    const info = await lstat(target);
    if (!info.isDirectory()) {
      throw new Error(`Command cwd is not a directory: ${requestedPath}`);
    }

    await this.assertRealPathInsideRoot(target, `Command cwd escapes project root: ${requestedPath}`);
  }

  private async assertSafeExistingFile(target: string, requestedPath: string): Promise<void> {
    const info = await lstat(target);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`Path is not a regular file: ${requestedPath}`);
    }

    await this.assertRealPathInsideRoot(target, `Path escapes project root: ${requestedPath}`);
    await this.assertNotHardlinkedFile(target, requestedPath);
  }

  private async assertSafeWriteTarget(target: string, requestedPath: string): Promise<void> {
    await this.assertRealPathInsideRoot(dirname(target), `Path parent escapes project root: ${requestedPath}`);

    try {
      const info = await lstat(target);
      if (!info.isFile() && !info.isSymbolicLink()) {
        throw new Error(`Path is not a writable regular file: ${requestedPath}`);
      }

      await this.assertRealPathInsideRoot(target, `Path escapes project root: ${requestedPath}`);
      await this.assertNotHardlinkedFile(target, requestedPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }
  }

  private async assertRealPathInsideRoot(target: string, message: string): Promise<void> {
    const rootRealPath = await realpath(this.rootDir);
    const targetRealPath = await realpath(target);
    const relation = relative(rootRealPath, targetRealPath);

    if (relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"))) {
      return;
    }

    throw new Error(message);
  }

  private async assertNotHardlinkedFile(target: string, requestedPath: string): Promise<void> {
    const info = await stat(target);
    if (info.isFile() && info.nlink > 1) {
      throw new Error(`Hardlinked files are not allowed in sandbox: ${requestedPath}`);
    }
  }
}

export interface CommandSpecInput {
  runner: SandboxRunnerOptions;
  rootDir: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CommandSpec {
  command: string;
  args: string[];
  hostCwd?: string;
  hostEnv: Record<string, string>;
  runner: "host" | "docker";
}

export function buildCommandSpec(input: CommandSpecInput): CommandSpec {
  if (input.runner.type !== "docker") {
    return {
      command: input.command,
      args: input.args,
      hostCwd: resolve(input.rootDir, input.cwd),
      hostEnv: input.env,
      runner: "host"
    };
  }

  const workspaceMount = input.runner.workspaceMount ?? DEFAULT_CONTAINER_WORKSPACE;
  const containerCwd = toContainerPath(workspaceMount, input.cwd);
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    input.runner.network ?? "none",
    "--mount",
    `type=bind,src=${input.rootDir},dst=${workspaceMount}`,
    "-w",
    containerCwd
  ];

  if (input.runner.user) {
    dockerArgs.push("--user", input.runner.user);
  }

  if (input.runner.cpus) {
    dockerArgs.push("--cpus", input.runner.cpus);
  }

  if (input.runner.memory) {
    dockerArgs.push("--memory", input.runner.memory);
  }

  if (input.runner.pidsLimit !== undefined) {
    dockerArgs.push("--pids-limit", String(input.runner.pidsLimit));
  }

  for (const [name, value] of Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))) {
    dockerArgs.push("--env", `${name}=${value}`);
  }

  dockerArgs.push(input.runner.image, input.command, ...input.args);

  return {
    command: input.runner.dockerCommand ?? "docker",
    args: dockerArgs,
    hostCwd: input.rootDir,
    hostEnv: buildDockerHostEnv(),
    runner: "docker"
  };
}

const DEFAULT_CONTAINER_WORKSPACE = "/workspace";

function copyEnvIfSet(env: Record<string, string>, name: string): void {
  const value = process.env[name];
  if (value !== undefined) {
    env[name] = value;
  }
}

function buildDockerHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  copyEnvIfSet(env, "PATH");
  copyEnvIfSet(env, "DOCKER_HOST");
  copyEnvIfSet(env, "DOCKER_CONTEXT");
  copyEnvIfSet(env, "DOCKER_CONFIG");
  return env;
}

function toContainerPath(workspaceMount: string, path: string): string {
  const normalizedPath = path === "." ? "" : path.replace(/^\/+/, "");
  return normalizedPath ? join(workspaceMount, normalizedPath) : workspaceMount;
}

function createLimitedOutputBuffer(maxBytes: number): {
  append(chunk: Buffer): void;
  toString(): string;
  readonly truncated: boolean;
} {
  let output = "";
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk: Buffer) {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }

      const remainingBytes = maxBytes - bytes;
      if (chunk.byteLength <= remainingBytes) {
        output += chunk.toString("utf8");
        bytes += chunk.byteLength;
        return;
      }

      output += chunk.subarray(0, remainingBytes).toString("utf8");
      bytes = maxBytes;
      truncated = true;
    },
    toString() {
      return output;
    },
    get truncated() {
      return truncated;
    }
  };
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }

    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if (fallbackError instanceof Error && "code" in fallbackError && fallbackError.code === "ESRCH") {
        return;
      }

      throw fallbackError;
    }
  }
}

export const defaultAllowedCommands = [
  "npm",
  "go",
  "docker",
  "git"
] as const;
