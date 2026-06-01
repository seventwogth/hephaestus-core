import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxOptions {
  rootDir: string;
  allowedCommands: string[];
  timeoutMs?: number;
}

export class ProjectSandbox {
  private readonly rootDir: string;
  private readonly allowedCommands: Set<string>;
  private readonly timeoutMs: number;

  constructor(options: SandboxOptions) {
    this.rootDir = resolve(options.rootDir);
    this.allowedCommands = new Set(options.allowedCommands);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async readText(path: string): Promise<string> {
    return readFile(this.resolveInsideRoot(path), "utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = this.resolveInsideRoot(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async run(command: string, args: string[] = [], cwd = "."): Promise<CommandResult> {
    if (!this.allowedCommands.has(command)) {
      throw new Error(`Command is not allowed: ${command}`);
    }

    const workingDirectory = this.resolveInsideRoot(cwd);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: workingDirectory,
        shell: false,
        env: {
          ...process.env,
          GOCACHE: process.env.GOCACHE ?? "/tmp/hephaestus-go-cache",
          GOMODCACHE: process.env.GOMODCACHE ?? "/tmp/hephaestus-go-mod"
        }
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolvePromise({
            command,
            args,
            cwd: workingDirectory,
            exitCode,
            stdout,
            stderr,
            timedOut
          });
        }
      });
    });
  }

  resolveInsideRoot(path: string): string {
    const target = resolve(this.rootDir, path);
    const relation = relative(this.rootDir, target);

    if (relation === "" || (!relation.startsWith("..") && !relation.startsWith("/"))) {
      return target;
    }

    throw new Error(`Path escapes project root: ${path}`);
  }
}

export const defaultAllowedCommands = [
  "npm",
  "go",
  "docker",
  "git"
] as const;
