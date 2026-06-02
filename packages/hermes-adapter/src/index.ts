import { spawn } from "node:child_process";

export type AgentRole =
  | "requirements"
  | "architect"
  | "database"
  | "backend"
  | "frontend"
  | "integrator"
  | "tester"
  | "fixer"
  | "documentation";

export interface AgentFileContext {
  path: string;
  content: string;
}

export interface AgentRunInput {
  role: AgentRole;
  instruction: string;
  files: AgentFileContext[];
  writableFiles: string[];
  validationCommand?: string;
}

export interface AgentRunResult {
  role: AgentRole;
  summary: string;
  changedFiles: string[];
  updatedFiles: AgentFileContext[];
  rawOutput: string;
}

export interface ModelProvider {
  generate(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface CommandModelProviderOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class StubModelProvider implements ModelProvider {
  async generate(input: AgentRunInput): Promise<AgentRunResult> {
    return {
      role: input.role,
      summary: `Stubbed ${input.role} run`,
      changedFiles: [],
      updatedFiles: [],
      rawOutput: JSON.stringify({
        role: input.role,
        filesReceived: input.files.map((file) => file.path),
        writableFiles: input.writableFiles,
        validationCommand: input.validationCommand ?? null
      })
    };
  }
}

export class CommandModelProvider implements ModelProvider {
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(private readonly options: CommandModelProviderOptions) {
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async generate(input: AgentRunInput): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, this.args, {
        cwd: this.options.cwd,
        env: {
          ...process.env,
          ...this.options.env
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
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

      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
          return;
        }

        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }

        settled = true;

        if (code !== 0) {
          reject(
            new Error(
              `Model command failed with exit code ${code}: ${stderr.trim() || stdout.trim() || "no output"}`
            )
          );
          return;
        }

        try {
          resolve(parseCommandResult(input.role, stdout));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}

function parseCommandResult(role: AgentRole, stdout: string): AgentRunResult {
  const payload = JSON.parse(stdout) as Partial<AgentRunResult> & { rawOutput?: string };

  return {
    role,
    summary: payload.summary ?? "Command model provider run completed",
    changedFiles: payload.changedFiles ?? [],
    updatedFiles: payload.updatedFiles ?? [],
    rawOutput: payload.rawOutput ?? stdout
  };
}
