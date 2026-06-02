import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createArchitecturePlan } from "@hephaestus/agents";
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

    const plan = createArchitecturePlan(spec);
    await this.approveSpec(projectDir, plan);
    await this.updateTaskStatus(projectDir, "architecture", "done");

    return plan;
  }

  async generateBackendStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await generateGoBackend({ projectDir, plan });
    await this.updateTaskStatus(projectDir, "backend", "done");
  }

  async generateDatabaseStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await generateDatabaseArtifacts({ projectDir, plan });
    await this.updateTaskStatus(projectDir, "database", "done");
  }

  async generateFrontendStage(projectDir: string): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await generateReactFrontend({ projectDir, plan });
    await this.updateTaskStatus(projectDir, "frontend", "done");
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
