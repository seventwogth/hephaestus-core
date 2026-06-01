import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentRole, type AgentRunResult, type ModelProvider } from "@hephaestus/hermes-adapter";
import { ProjectSandbox } from "@hephaestus/project-sandbox";
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
  writeTasks(projectDir: string, tasks: ProjectTask[]): Promise<void>;
}

export interface AgentStageInput {
  role: AgentRole;
  instruction: string;
  contextFiles: string[];
  writableFiles: string[];
  validationCommand?: string;
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
