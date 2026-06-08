import { spawn } from "node:child_process";

export type AgentRole =
  | "requirements"
  | "architect"
  | "api"
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

export interface AgentRunManifest {
  createdFiles: string[];
  updatedFiles: string[];
  validationCommands: string[];
  notes?: string[];
}

export interface AgentRunResult {
  role: AgentRole;
  summary: string;
  changedFiles: string[];
  updatedFiles: AgentFileContext[];
  manifest?: AgentRunManifest;
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

export interface LocalModelProviderEnvironment {
  HEPHAESTUS_MODEL_RUNTIME_MAP?: string;
  HEPHAESTUS_OLLAMA_BASE_URL?: string;
  HEPHAESTUS_OLLAMA_TIMEOUT_MS?: string;
}

export interface LocalModelRuntime {
  provider: "stub" | "ollama";
  target: string;
}

export class StubModelProvider implements ModelProvider {
  async generate(input: AgentRunInput): Promise<AgentRunResult> {
    return {
      role: input.role,
      summary: `Stubbed ${input.role} run`,
      changedFiles: [],
      updatedFiles: [],
      manifest: {
        createdFiles: [],
        updatedFiles: [],
        validationCommands: input.validationCommand ? [input.validationCommand] : [],
        notes: ["Stub provider did not change files"]
      },
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
        'Формат ответа: {"summary":"...","changedFiles":["path"],"updatedFiles":[{"path":"...","content":"..."}],"manifest":{"createdFiles":["path"],"updatedFiles":["path"],"validationCommands":["cmd"],"notes":["optional"]},"rawOutput":"optional"}',
        "Поле updatedFiles[].content всегда должно быть строкой с полным содержимым файла; JSON-файлы тоже возвращай как строку, а не вложенный объект.",
        "Если файл не нужно менять, не добавляй его в updatedFiles.",
        "Для каждого запуска обязательно верни manifest: перечисли созданные/обновленные файлы и команды проверки.",
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

export function resolveLocalModelRuntime(
  modelId: string,
  env: LocalModelProviderEnvironment = process.env
): LocalModelRuntime {
  const mappedRuntime = parseRuntimeMap(env.HEPHAESTUS_MODEL_RUNTIME_MAP)[modelId];
  const runtimeSpec = mappedRuntime ?? (modelId === "stub" ? "stub" : `ollama:${modelId}`);

  if (runtimeSpec === "stub") {
    return { provider: "stub", target: "stub" };
  }

  if (runtimeSpec.startsWith("ollama:")) {
    return {
      provider: "ollama",
      target: runtimeSpec.slice("ollama:".length)
    };
  }

  throw new Error(`Unsupported runtime for model ${modelId}: ${runtimeSpec}`);
}

export function createLocalModelProvider(
  modelId: string,
  env: LocalModelProviderEnvironment = process.env
): ModelProvider {
  const runtime = resolveLocalModelRuntime(modelId, env);

  if (runtime.provider === "stub") {
    return new StubModelProvider();
  }

  return new OllamaModelProvider({
    model: runtime.target,
    baseUrl: env.HEPHAESTUS_OLLAMA_BASE_URL,
    timeoutMs: parseOptionalNumber(env.HEPHAESTUS_OLLAMA_TIMEOUT_MS)
  });
}

function parseAgentRunResult(role: AgentRole, rawOutput: string): AgentRunResult {
  const payload = parseJsonObject(rawOutput);

  return {
    role,
    summary: typeof payload.summary === "string" ? payload.summary : "Command model provider run completed",
    changedFiles: getStringArray(payload.changedFiles),
    updatedFiles: parseUpdatedFiles(payload.updatedFiles),
    manifest: parseManifest(payload.manifest),
    rawOutput: typeof payload.rawOutput === "string" ? payload.rawOutput : rawOutput
  };
}

function parseJsonObject(rawOutput: string): Record<string, unknown> {
  const payload = JSON.parse(rawOutput) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Agent result must be a JSON object");
  }

  return payload as Record<string, unknown>;
}

function parseUpdatedFiles(value: unknown): AgentFileContext[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("Agent result updatedFiles must be an array");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Agent result updatedFiles[${index}] must be an object`);
    }

    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error(`Agent result updatedFiles[${index}].path must be a non-empty string`);
    }

    return {
      path: file.path,
      content: normalizeFileContent(file.path, file.content, index)
    };
  });
}

function normalizeFileContent(path: string, content: unknown, index: number): string {
  if (typeof content === "string") {
    return content;
  }

  if (content !== null && typeof content === "object" && path.endsWith(".json")) {
    return `${JSON.stringify(content, null, 2)}\n`;
  }

  throw new Error(
    `Agent result updatedFiles[${index}].content for ${path} must be a string; received ${describeValue(content)}`
  );
}

function parseManifest(value: unknown): AgentRunManifest | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent result manifest must be an object");
  }

  const manifest = value as Record<string, unknown>;
  return {
    createdFiles: getStringArray(manifest.createdFiles),
    updatedFiles: getStringArray(manifest.updatedFiles),
    validationCommands: getStringArray(manifest.validationCommands),
    notes: manifest.notes === undefined ? undefined : getStringArray(manifest.notes)
  };
}

function getStringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
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

function parseRuntimeMap(rawValue: string | undefined): Record<string, string> {
  if (!rawValue) {
    return {};
  }

  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((accumulator, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        throw new Error(`Invalid model runtime entry: ${entry}`);
      }

      const modelId = entry.slice(0, separatorIndex).trim();
      const runtime = entry.slice(separatorIndex + 1).trim();
      if (!modelId || !runtime) {
        throw new Error(`Invalid model runtime entry: ${entry}`);
      }

      accumulator[modelId] = runtime;
      return accumulator;
    }, {});
}

function parseOptionalNumber(rawValue: string | undefined): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${rawValue}`);
  }

  return parsed;
}
