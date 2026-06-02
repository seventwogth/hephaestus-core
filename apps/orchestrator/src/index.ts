import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeRequirements, createArchitecturePlan } from "@hephaestus/agents";
import {
  type AgentFileContext,
  type AgentRole,
  type AgentRunResult,
  type ModelProvider
} from "@hephaestus/hermes-adapter";
import {
  generateDatabaseArtifacts,
  generateGoBackend,
  generateReactFrontend
} from "@hephaestus/project-generator";
import { ProjectSandbox } from "@hephaestus/project-sandbox";
import {
  type ValidationCheck,
  type ValidationReport,
  validateGeneratedWebApp
} from "@hephaestus/project-validator";
import { materializeGeneratedWebApp } from "@hephaestus/templates";
import {
  type ProjectPlan,
  type ProjectSpec,
  type ProjectStatus,
  projectPlanSchema,
  projectSpecSchema,
  projectStatusSchema,
  taskSchema,
  type ProjectTask
} from "@hephaestus/contracts";

export type Stage =
  | "NEW"
  | "REQUIREMENTS"
  | "SPEC_APPROVAL"
  | "PLANNING"
  | "GENERATING"
  | "TESTING"
  | "FIXING"
  | "DOCUMENTING"
  | "READY"
  | "FAILED";

export interface ProjectStateStore {
  readSpec(projectDir: string): Promise<ProjectSpec | null>;
  writeSpec(projectDir: string, spec: ProjectSpec): Promise<void>;
  readPlan(projectDir: string): Promise<ProjectPlan | null>;
  writePlan(projectDir: string, plan: ProjectPlan): Promise<void>;
  readStatus(projectDir: string): Promise<ProjectStatus | null>;
  writeStatus(projectDir: string, status: ProjectStatus): Promise<void>;
  readTasks(projectDir: string): Promise<ProjectTask[] | null>;
  writeTasks(projectDir: string, tasks: ProjectTask[]): Promise<void>;
}

export interface AgentStageInput {
  role: AgentRole;
  instruction: string;
  contextFiles: string[];
  writableFiles: string[];
  validationCommand?: string;
}

export interface ValidateProjectStageOptions {
  checks?: ValidationCheck[];
  timeoutMs?: number;
}

export interface FixProjectStageOptions extends ValidateProjectStageOptions {
  maxAttempts?: number;
  contextFiles?: string[];
  writableFiles?: string[];
}

export interface BootstrapProjectOptions extends FixProjectStageOptions {
  runIntegration?: boolean;
  runValidation?: boolean;
  autoFix?: boolean;
  runDocumentation?: boolean;
}

export interface BootstrapProjectResult {
  spec: ProjectSpec;
  validationReport?: ValidationReport;
}

export class FileProjectStateStore implements ProjectStateStore {
  async readSpec(projectDir: string): Promise<ProjectSpec | null> {
    return readJson(join(projectDir, "SPEC.json"), projectSpecSchema);
  }

  async writeSpec(projectDir: string, spec: ProjectSpec): Promise<void> {
    await writeJson(join(projectDir, "SPEC.json"), projectSpecSchema.parse(spec));
  }

  async readPlan(projectDir: string): Promise<ProjectPlan | null> {
    return readJson(join(projectDir, "PLAN.json"), projectPlanSchema);
  }

  async writePlan(projectDir: string, plan: ProjectPlan): Promise<void> {
    await writeJson(join(projectDir, "PLAN.json"), projectPlanSchema.parse(plan));
  }

  async readStatus(projectDir: string): Promise<ProjectStatus | null> {
    return readJson(join(projectDir, "STATUS.json"), projectStatusSchema);
  }

  async writeStatus(projectDir: string, status: ProjectStatus): Promise<void> {
    await writeJson(join(projectDir, "STATUS.json"), projectStatusSchema.parse(status));
  }

  async readTasks(projectDir: string): Promise<ProjectTask[] | null> {
    const taskFile = await readJson(
      join(projectDir, "TASKS.json"),
      {
        parse(value: unknown) {
          return {
            tasks: (value as { tasks?: unknown[] }).tasks?.map((task) => taskSchema.parse(task)) ?? []
          };
        }
      }
    );

    return taskFile?.tasks ?? null;
  }

  async writeTasks(projectDir: string, tasks: ProjectTask[]): Promise<void> {
    const parsedTasks = tasks.map((task) => taskSchema.parse(task));
    await writeJson(join(projectDir, "TASKS.json"), { tasks: parsedTasks });
  }
}

export class Orchestrator {
  constructor(
    private readonly store: ProjectStateStore,
    private readonly modelProvider?: ModelProvider
  ) {}

  async bootstrapProjectFromPrompt(
    projectDir: string,
    requestText: string,
    options: BootstrapProjectOptions = {}
  ): Promise<BootstrapProjectResult> {
    const spec = await this.createRequirementsStage(projectDir, requestText);

    await this.scaffoldProject(projectDir, spec);
    await this.planProject(projectDir);
    await this.generateDatabaseStage(projectDir);
    await this.generateBackendStage(projectDir);
    await this.generateFrontendStage(projectDir);
    if (options.runIntegration ?? true) {
      await this.integrateProjectStage(projectDir);
    }

    let validationReport: ValidationReport | undefined;
    if (options.runValidation ?? true) {
      validationReport = await this.validateProjectStage(projectDir, options);
      if (!validationReport.passed && (options.autoFix ?? true) && this.modelProvider) {
        validationReport = await this.fixProjectStage(projectDir, options);
      }
    }

    if ((options.runDocumentation ?? true) && (validationReport?.passed ?? true)) {
      await this.documentProjectStage(projectDir);
    }

    return {
      spec,
      validationReport
    };
  }

  async scaffoldProject(projectDir: string, spec: ProjectSpec): Promise<void> {
    await materializeGeneratedWebApp({ targetDir: projectDir });
    await this.initializeProject(projectDir, spec);
  }

  async initializeProject(projectDir: string, spec: ProjectSpec): Promise<void> {
    await mkdir(projectDir, { recursive: true });
    await this.store.writeSpec(projectDir, spec);
    await this.store.writeStatus(projectDir, newStatus("SPEC_APPROVAL"));
    await this.store.writeTasks(projectDir, [
      { id: "requirements", type: "requirements", status: "done", dependsOn: [], files: ["SPEC.json"] },
      { id: "architecture", type: "architecture", status: "pending", dependsOn: ["requirements"], files: ["PLAN.json"] },
      { id: "database", type: "database", status: "pending", dependsOn: ["architecture"], files: ["backend/migrations"] },
      { id: "backend", type: "backend", status: "pending", dependsOn: ["database"], files: ["backend"] },
      { id: "frontend", type: "frontend", status: "pending", dependsOn: ["backend"], files: ["frontend"] },
      { id: "integration", type: "integration", status: "pending", dependsOn: ["frontend"], files: ["docker-compose.yml"] },
      { id: "testing", type: "testing", status: "pending", dependsOn: ["integration"], files: ["REVIEW.md"] },
      { id: "fixing", type: "fixing", status: "pending", dependsOn: ["testing"], files: ["REVIEW.md", "AGENT_RUNS.jsonl"] },
      { id: "documentation", type: "documentation", status: "pending", dependsOn: ["testing"], files: ["README.md"] }
    ]);
  }

  async approveSpec(projectDir: string, plan: ProjectPlan): Promise<void> {
    await this.store.writePlan(projectDir, plan);
    await this.store.writeStatus(projectDir, newStatus("GENERATING"));
  }

  async planProject(projectDir: string): Promise<ProjectPlan> {
    const spec = await this.store.readSpec(projectDir);
    if (!spec) {
      throw new Error("SPEC.json не найден");
    }

    await this.setStage(projectDir, "PLANNING");
    await this.updateTaskStatus(projectDir, "architecture", "in_progress");

    const plan = this.modelProvider
      ? await this.planWithAgent(projectDir)
      : createArchitecturePlan(spec);

    await this.approveSpec(projectDir, plan);
    await this.updateTaskStatus(projectDir, "architecture", "done");

    return plan;
  }

  async generateBackendStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "backend", "in_progress");

    if (this.modelProvider) {
      await this.runAgentStage(projectDir, {
        role: "backend",
        instruction: buildBackendInstruction(plan),
        contextFiles: [
          "SPEC.json",
          "PLAN.json",
          "backend/go.mod",
          "backend/cmd/api/main.go",
          "backend/internal/http/router.go",
          "backend/internal/http/generated_routes.go",
          "backend/internal/platform/database/database.go",
          "backend/internal/platform/database/migrate.go",
          "backend/migrations/0001_generated_schema.sql",
          "README.md"
        ],
        writableFiles: ["backend", "docker-compose.yml", "README.md"],
        validationCommand: "cd backend && go test ./..."
      });
    } else {
      await generateGoBackend({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "backend", "done");
  }

  async generateDatabaseStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "database", "in_progress");

    if (this.modelProvider) {
      await this.runAgentStage(projectDir, {
        role: "database",
        instruction: buildDatabaseInstruction(plan),
        contextFiles: [
          "SPEC.json",
          "PLAN.json",
          "backend/migrations/0001_generated_schema.sql",
          "backend/internal/platform/database/database.go",
          "backend/internal/platform/database/migrate.go",
          "docker-compose.yml",
          "README.md"
        ],
        writableFiles: ["backend", "docker-compose.yml", "README.md"],
        validationCommand: "cd backend && go test ./..."
      });
    } else {
      await generateDatabaseArtifacts({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "database", "done");
  }

  async generateFrontendStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "frontend", "in_progress");

    if (this.modelProvider) {
      await this.runAgentStage(projectDir, {
        role: "frontend",
        instruction: buildFrontendInstruction(plan),
        contextFiles: [
          "SPEC.json",
          "PLAN.json",
          "frontend/package.json",
          "frontend/src/main.tsx",
          "frontend/src/App.tsx",
          "frontend/src/styles.css",
          "README.md"
        ],
        writableFiles: ["frontend", "README.md"],
        validationCommand: "cd frontend && npm run build"
      });
    } else {
      await generateReactFrontend({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "frontend", "done");
  }

  async integrateProjectStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    const spec = await this.store.readSpec(projectDir);
    if (!plan || !spec) {
      throw new Error("SPEC.json или PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "integration", "in_progress");

    if (this.modelProvider) {
      await this.runAgentStage(projectDir, {
        role: "integrator",
        instruction: buildIntegrationInstruction(plan),
        contextFiles: [
          "SPEC.json",
          "PLAN.json",
          "docker-compose.yml",
          "backend/go.mod",
          "backend/cmd/api/main.go",
          "backend/internal/http/generated_routes.go",
          "frontend/package.json",
          "frontend/src/main.tsx",
          "frontend/src/App.tsx",
          "README.md"
        ],
        writableFiles: ["backend", "frontend", "docker-compose.yml", "README.md"],
        validationCommand: "docker compose config"
      });
    }

    await this.updateTaskStatus(projectDir, "integration", "done");
  }

  async documentProjectStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    const spec = await this.store.readSpec(projectDir);
    if (!plan || !spec) {
      throw new Error("SPEC.json или PLAN.json не найден");
    }

    await this.setStage(projectDir, "DOCUMENTING");
    await this.updateTaskStatus(projectDir, "documentation", "in_progress");

    if (this.modelProvider) {
      await this.runAgentStage(projectDir, {
        role: "documentation",
        instruction: buildDocumentationInstruction(spec, plan),
        contextFiles: [
          "REQUEST.md",
          "SPEC.json",
          "PLAN.json",
          "REVIEW.md",
          "docker-compose.yml",
          "backend/go.mod",
          "frontend/package.json",
          "README.md"
        ],
        writableFiles: ["README.md"]
      });
    } else {
      await writeFile(join(projectDir, "README.md"), renderProjectReadme(spec, plan), "utf8");
    }

    await this.updateTaskStatus(projectDir, "documentation", "done");
    await this.setStage(projectDir, "READY");
  }

  async runAgentStage(projectDir: string, input: AgentStageInput): Promise<AgentRunResult> {
    if (!this.modelProvider) {
      throw new Error("Model provider is not configured");
    }

    const sandbox = new ProjectSandbox({ rootDir: projectDir, allowedCommands: [] });
    const files = await this.readContextFiles(sandbox, input.contextFiles);

    const result = await this.modelProvider.generate({
      role: input.role,
      instruction: input.instruction,
      files,
      writableFiles: input.writableFiles,
      validationCommand: input.validationCommand
    });

    for (const file of result.updatedFiles ?? []) {
      if (!isWritablePath(file.path, input.writableFiles)) {
        throw new Error(`Model provider attempted to write outside allowed files: ${file.path}`);
      }

      await sandbox.writeText(file.path, file.content);
    }

    await appendFile(
      join(projectDir, "AGENT_RUNS.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), input, result })}\n`,
      "utf8"
    );

    return result;
  }

  async validateProjectStage(
    projectDir: string,
    options: ValidateProjectStageOptions = {}
  ): Promise<ValidationReport> {
    await this.setStage(projectDir, "TESTING");
    await this.updateTaskStatus(projectDir, "testing", "in_progress");

    const report = await validateGeneratedWebApp({
      projectDir,
      checks: options.checks,
      timeoutMs: options.timeoutMs
    });

    await this.updateTaskStatus(projectDir, "testing", report.passed ? "done" : "failed");
    await this.setStage(projectDir, report.passed ? "READY" : "FAILED");

    return report;
  }

  async fixProjectStage(
    projectDir: string,
    options: FixProjectStageOptions = {}
  ): Promise<ValidationReport> {
    if (!this.modelProvider) {
      throw new Error("Model provider is not configured");
    }

    const maxAttempts = options.maxAttempts ?? 3;
    const writableFiles = options.writableFiles ?? [
      "backend",
      "frontend",
      "docker-compose.yml",
      "README.md",
      "package.json"
    ];
    const contextFiles = options.contextFiles ?? [
      "REVIEW.md",
      "STATUS.json",
      "TASKS.json",
      "PLAN.json",
      "SPEC.json"
    ];

    await this.setStage(projectDir, "FIXING");
    await this.updateTaskStatus(projectDir, "testing", "in_progress");
    await this.updateTaskStatus(projectDir, "fixing", "in_progress");

    let latestReport: ValidationReport | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.incrementAttempt(projectDir, "fixing", "FIXING");
      latestReport = await validateGeneratedWebApp({
        projectDir,
        checks: options.checks,
        timeoutMs: options.timeoutMs
      });

      if (latestReport.passed) {
        await this.updateTaskStatus(projectDir, "testing", "done");
        await this.updateTaskStatus(projectDir, "fixing", "done");
        await this.setStage(projectDir, "READY");
        return latestReport;
      }

      if (attempt === maxAttempts) {
        break;
      }

      await this.runAgentStage(projectDir, {
        role: "fixer",
        instruction: buildFixInstruction(latestReport, attempt, maxAttempts),
        contextFiles,
        writableFiles,
        validationCommand: formatValidationCommand(latestReport)
      });
    }

    await this.updateTaskStatus(projectDir, "testing", "failed");
    await this.updateTaskStatus(projectDir, "fixing", "failed");
    await this.setStage(projectDir, "FAILED");

    if (!latestReport) {
      throw new Error("Validation report was not produced");
    }

    return latestReport;
  }

  async createRequirementsStage(projectDir: string, requestText: string): Promise<ProjectSpec> {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "REQUEST.md"), ensureTrailingNewline(requestText), "utf8");

    if (!this.modelProvider) {
      const spec = analyzeRequirements({ text: requestText });
      await this.store.writeSpec(projectDir, spec);
      return spec;
    }

    await this.setStage(projectDir, "REQUIREMENTS");
    await this.runAgentStage(projectDir, {
      role: "requirements",
      instruction: buildRequirementsInstruction(),
      contextFiles: ["REQUEST.md"],
      writableFiles: ["SPEC.json"]
    });

    const spec = await this.store.readSpec(projectDir);
    if (!spec) {
      throw new Error("Requirements agent did not produce a valid SPEC.json");
    }

    return spec;
  }

  private async planWithAgent(projectDir: string): Promise<ProjectPlan> {
    await this.runAgentStage(projectDir, {
      role: "architect",
      instruction: buildPlanInstruction(),
      contextFiles: ["SPEC.json"],
      writableFiles: ["PLAN.json"],
      validationCommand: "cat PLAN.json"
    });

    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("Architect agent did not produce a valid PLAN.json");
    }

    return plan;
  }

  private async readContextFiles(
    sandbox: ProjectSandbox,
    paths: string[]
  ): Promise<AgentFileContext[]> {
    const files = await Promise.all(
      paths.map(async (path) => {
        try {
          return {
            path,
            content: await sandbox.readText(path)
          };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      })
    );

    return files.filter((file): file is AgentFileContext => file !== null);
  }

  private async setStage(projectDir: string, stage: Stage): Promise<void> {
    const status = await this.store.readStatus(projectDir);
    await this.store.writeStatus(projectDir, {
      stage,
      attempts: status?.attempts ?? {},
      updatedAt: new Date().toISOString()
    });
  }

  private async incrementAttempt(
    projectDir: string,
    key: string,
    stage: Stage
  ): Promise<void> {
    const status = await this.store.readStatus(projectDir);
    const attempts = {
      ...(status?.attempts ?? {}),
      [key]: (status?.attempts[key] ?? 0) + 1
    };

    await this.store.writeStatus(projectDir, {
      stage,
      attempts,
      updatedAt: new Date().toISOString()
    });
  }

  private async updateTaskStatus(
    projectDir: string,
    taskId: string,
    status: ProjectTask["status"]
  ): Promise<void> {
    const tasks = await this.store.readTasks(projectDir);
    if (!tasks) {
      return;
    }

    await this.store.writeTasks(
      projectDir,
      tasks.map((task) => (task.id === taskId ? { ...task, status } : task))
    );
  }
}

function newStatus(stage: Stage): ProjectStatus {
  return {
    stage,
    attempts: {},
    updatedAt: new Date().toISOString()
  };
}

function isWritablePath(path: string, writableFiles: string[]): boolean {
  return writableFiles.some((allowedPath) => {
    return path === allowedPath || path.startsWith(`${allowedPath}/`);
  });
}

function formatValidationCommand(report: ValidationReport): string | undefined {
  const failedCheck = report.results.find((result) => !result.passed);
  if (!failedCheck) {
    return undefined;
  }

  return [failedCheck.check.command, ...failedCheck.check.args].join(" ");
}

function buildFixInstruction(
  report: ValidationReport,
  attempt: number,
  maxAttempts: number
): string {
  const failedChecks = report.results.filter((result) => !result.passed);
  const failedSummary = failedChecks
    .map((result) => {
      const command = [result.check.command, ...result.check.args].join(" ");
      return `- ${result.check.title}: ${command}`;
    })
    .join("\n");

  return [
    `Исправь проект по REVIEW.md. Попытка ${attempt} из ${maxAttempts}.`,
    "Меняй только файлы, которые напрямую относятся к ошибкам проверки.",
    "После правок оркестратор заново запустит валидацию.",
    "",
    "Ошибки текущего прогона:",
    failedSummary || "- REVIEW.md содержит детали ошибки."
  ].join("\n");
}

async function readJson<T>(path: string, schema: { parse(value: unknown): T }): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildRequirementsInstruction(): string {
  return [
    "Сформируй файл SPEC.json как валидный JSON без markdown.",
    "SPEC.json должен содержать:",
    '- projectName: kebab-case имя проекта',
    "- description: краткое описание",
    "- actors: минимум один актор",
    "- features: минимум одна feature с id, title, description, priority",
    "- entities: сущности с fields и при необходимости indexes",
    "- requiresAuth, requiresDatabase, constraints, acceptanceCriteria",
    "Не добавляй комментарии и лишние поля вне схемы."
  ].join("\n");
}

function buildPlanInstruction(): string {
  return [
    "Сформируй файл PLAN.json как валидный JSON без markdown на основе SPEC.json.",
    "Используй стек строго:",
    '- frontend: "react-vite-typescript"',
    '- backend: "go-chi"',
    '- database: "postgresql"',
    '- api: "rest-openapi"',
    "Укажи backendModules, frontendRoutes, databaseEntities, endpoints и validationCommands.",
    "Каждый endpoint должен иметь method, path, summary и authRequired."
  ].join("\n");
}

function buildDatabaseInstruction(plan: ProjectPlan): string {
  return [
    `Сгенерируй весь database layer проекта ${plan.projectName} на основе SPEC.json и PLAN.json.`,
    "Нужно обновить PostgreSQL migration files и backend database wiring в разрешенных файлах.",
    "Соблюдай связи между сущностями, индексы, типы полей и совместимость с Go backend.",
    "Возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildBackendInstruction(plan: ProjectPlan): string {
  return [
    `Сгенерируй весь Go backend проекта ${plan.projectName} на основе SPEC.json, PLAN.json и текущего scaffold.`,
    "Разрешено переписывать scaffolded backend-файлы полностью.",
    "Нужны рабочие REST handlers, routing, models, storage/repository integration и startup wiring.",
    "Сохраняй совместимость с database migrations и docker-compose.",
    "Возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildFrontendInstruction(plan: ProjectPlan): string {
  return [
    `Сгенерируй весь React frontend проекта ${plan.projectName} на основе SPEC.json, PLAN.json и текущего scaffold.`,
    "Разрешено переписывать scaffolded frontend-файлы полностью.",
    "Сделай интерфейс под основные user flows и связанные ресурсы из плана.",
    "Используй существующий Vite/TypeScript scaffold и возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildIntegrationInstruction(plan: ProjectPlan): string {
  return [
    `Интегрируй backend, frontend и docker-compose проекта ${plan.projectName} в единый рабочий контур.`,
    "Проверь согласованность API routes, переменных окружения, URL, портов и docker-compose wiring.",
    "Исправляй только разрешенные файлы и возвращай их полное содержимое."
  ].join("\n");
}

function buildDocumentationInstruction(spec: ProjectSpec, plan: ProjectPlan): string {
  return [
    `Обнови README.md для проекта ${spec.projectName}.`,
    `Опиши назначение проекта, стек (${plan.stack.frontend}, ${plan.stack.backend}, ${plan.stack.database}),`,
    "основные команды запуска, структуру каталогов и ключевые endpoints.",
    "Пиши по-русски и возвращай полное содержимое README.md."
  ].join("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function renderProjectReadme(spec: ProjectSpec, plan: ProjectPlan): string {
  const endpointLines = plan.endpoints
    .map((endpoint) => `- \`${endpoint.method} ${endpoint.path}\` — ${endpoint.summary}`)
    .join("\n");
  const entityLines = spec.entities.length === 0
    ? "- нет явно описанных сущностей"
    : spec.entities.map((entity) => `- ${entity.name}`).join("\n");

  return [
    `# ${spec.projectName}`,
    "",
    spec.description,
    "",
    "## Стек",
    "",
    `- Frontend: ${plan.stack.frontend}`,
    `- Backend: ${plan.stack.backend}`,
    `- Database: ${plan.stack.database}`,
    `- API: ${plan.stack.api}`,
    "",
    "## Сущности",
    "",
    entityLines,
    "",
    "## API",
    "",
    endpointLines,
    "",
    "## Локальный запуск",
    "",
    "```bash",
    "docker compose up --build",
    "```",
    "",
    "## Проверка",
    "",
    ...plan.validationCommands.map((command) => `- \`${command}\``),
    ""
  ].join("\n");
}
