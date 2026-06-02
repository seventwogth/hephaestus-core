import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createArchitecturePlan } from "@hephaestus/agents";
import { type AgentRole, type AgentRunResult, type ModelProvider } from "@hephaestus/hermes-adapter";
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
    const files = await Promise.all(
      input.contextFiles.map(async (path) => ({
        path,
        content: await sandbox.readText(path)
      }))
    );

    const result = await this.modelProvider.generate({
      role: input.role,
      instruction: input.instruction,
      files,
      writableFiles: input.writableFiles,
      validationCommand: input.validationCommand
    });

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
    await this.store.writeStatus(projectDir, newStatus("TESTING"));
    await this.updateTaskStatus(projectDir, "testing", "in_progress");

    const report = await validateGeneratedWebApp({
      projectDir,
      checks: options.checks,
      timeoutMs: options.timeoutMs
    });

    await this.updateTaskStatus(projectDir, "testing", report.passed ? "done" : "failed");
    await this.store.writeStatus(projectDir, newStatus(report.passed ? "READY" : "FAILED"));

    return report;
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
