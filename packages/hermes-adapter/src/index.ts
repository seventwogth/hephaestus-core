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

export interface OllamaModelProviderOptions {
  model: string;
  baseUrl?: string;
  temperature?: number;
  timeoutMs?: number;
  systemPrompt?: string;
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
          resolve(parseAgentRunResult(input.role, stdout));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}

export class OllamaModelProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly systemPrompt: string;

  constructor(private readonly options: OllamaModelProviderOptions) {
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:11434";
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.temperature = options.temperature ?? 0.1;
    this.systemPrompt =
      options.systemPrompt ??
      [
        "Ты агент Hermes, который генерирует и редактирует файлы проекта.",
        "Отвечай строго JSON-объектом без markdown и без пояснений вне JSON.",
        'Формат ответа: {"summary":"...","changedFiles":["path"],"updatedFiles":[{"path":"...","content":"..."}],"rawOutput":"optional"}',
        "Если файл не нужно менять, не добавляй его в updatedFiles.",
        "Содержимое файлов возвращай полностью."
      ].join(" ");
  }

  async generate(input: AgentRunInput): Promise<AgentRunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          system: this.systemPrompt,
          prompt: buildOllamaPrompt(input),
          format: "json",
          stream: false,
          options: {
            temperature: this.temperature
          }
        }),
        signal: controller.signal
      });

      const payload = (await response.json()) as { response?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Ollama request failed with status ${response.status}`);
      }

      if (!payload.response) {
        throw new Error("Ollama response payload does not contain `response`");
      }

      return parseAgentRunResult(input.role, payload.response);
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseAgentRunResult(role: AgentRole, rawOutput: string): AgentRunResult {
  const payload = JSON.parse(rawOutput) as Partial<AgentRunResult> & { rawOutput?: string };

  return {
    role,
    summary: payload.summary ?? "Command model provider run completed",
    changedFiles: payload.changedFiles ?? [],
    updatedFiles: payload.updatedFiles ?? [],
    rawOutput: payload.rawOutput ?? rawOutput
  };
}

function buildOllamaPrompt(input: AgentRunInput): string {
  const filesBlock = input.files.length === 0
    ? "Контекстных файлов нет."
    : input.files
        .map((file) => {
          return [
            `FILE: ${file.path}`,
            "```",
            file.content,
            "```"
          ].join("\n");
        })
        .join("\n\n");

  return [
    `Роль агента: ${input.role}`,
    "",
    "Инструкция:",
    input.instruction,
    "",
    "Файлы, которые разрешено изменять:",
    ...input.writableFiles.map((path) => `- ${path}`),
    "",
    input.validationCommand
      ? `Команда валидации после правок: ${input.validationCommand}`
      : "Команда валидации не задана.",
    "",
    "Текущий контекст проекта:",
    filesBlock
  ].join("\n");
}
