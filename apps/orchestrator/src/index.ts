import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeRequirements, createArchitecturePlan } from "@hephaestus/agents";
import {
  type AgentFileContext,
  type AgentRole,
  type AgentRunManifest,
  type AgentRunResult,
  type ModelProvider
} from "@hephaestus/hermes-adapter";
import {
  generateDatabaseArtifacts,
  generateGoBackend,
  generateReactFrontend
} from "@hephaestus/project-generator";
import {
  type ArtifactRetentionReport,
  ProjectSandbox,
  type SandboxRunnerOptions
} from "@hephaestus/project-sandbox";
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

export { parseSandboxRunnerFromEnv } from "@hephaestus/project-sandbox";
export type { SandboxRunnerOptions } from "@hephaestus/project-sandbox";

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
  requireManifest?: boolean;
}

interface AgentGenerationStageOptions {
  noScaffold?: boolean;
  maxStageAttempts?: number;
}

export interface ValidateProjectStageOptions {
  checks?: ValidationCheck[];
  timeoutMs?: number;
  sandboxRunner?: SandboxRunnerOptions;
}

export interface FixProjectStageOptions extends ValidateProjectStageOptions {
  maxAttempts?: number;
  contextFiles?: string[];
  writableFiles?: string[];
}

export interface BootstrapProjectOptions extends FixProjectStageOptions {
  noScaffold?: boolean;
  maxStageAttempts?: number;
  runIntegration?: boolean;
  runValidation?: boolean;
  autoFix?: boolean;
  runDocumentation?: boolean;
  pruneArtifacts?: boolean;
  artifactAllowlist?: string[];
}

export interface BootstrapProjectResult {
  spec: ProjectSpec;
  validationReport?: ValidationReport;
}

interface ArtifactCompletenessCheck {
  id: string;
  description: string;
  paths: string[];
  mode: "all" | "any";
}

export interface ArtifactCompletenessCheckResult extends ArtifactCompletenessCheck {
  passed: boolean;
  missingPaths: string[];
}

export interface ArtifactCompletenessReport {
  passed: boolean;
  generatedAt: string;
  checks: ArtifactCompletenessCheckResult[];
}

export interface ArtifactCompletenessOptions {
  includeIntegration?: boolean;
}

export interface GenerationReport {
  generatedAt: string;
  scaffoldMode: "no-scaffold" | "template";
  deterministicScaffoldUsed: boolean;
  agentRunCount: number;
  manifestCount: number;
  agentRoles: string[];
  manifestRoles: string[];
  agentAuthoredFiles: string[];
  agentAuthoredFileCount: number;
  manifestCoverage: {
    filesDeclaredByRuns: number;
    filesDeclaredByManifests: number;
    coveredFiles: string[];
    missingFromManifest: string[];
  };
  sandboxValidation: SandboxValidationSummary;
  artifactRetention: ArtifactRetentionSummary;
}

export interface SandboxValidationSummary {
  validationRan: boolean;
  passed: boolean | null;
  commandCount: number;
  failedCheckIds: string[];
  timedOutCheckIds: string[];
  signaledCheckIds: string[];
  outputTruncatedCheckIds: string[];
  failureModes: string[];
}

export interface ArtifactRetentionSummary {
  pruningRan: boolean;
  allowedPaths: string[];
  keptPathCount: number;
  removedPaths: string[];
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
    if (options.noScaffold && !this.modelProvider) {
      throw new Error("No-scaffold bootstrap requires a ModelProvider");
    }

    const spec = await this.createRequirementsStage(projectDir, requestText);

    if (options.noScaffold) {
      await this.initializeProject(projectDir, spec);
    } else {
      await this.scaffoldProject(projectDir, spec);
    }

    await this.planProject(projectDir);
    const generationOptions = {
      noScaffold: options.noScaffold ?? false,
      maxStageAttempts: options.maxStageAttempts
    };

    await this.generateApiContractStage(projectDir, generationOptions);
    await this.generateDatabaseStage(projectDir, generationOptions);
    await this.generateBackendStage(projectDir, generationOptions);
    await this.generateFrontendStage(projectDir, generationOptions);
    if (options.runIntegration ?? true) {
      await this.integrateProjectStage(projectDir, generationOptions);
    }
    if (options.noScaffold) {
      await this.validateArtifactCompletenessStage(projectDir, {
        includeIntegration: options.runIntegration ?? true
      });
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

    const artifactRetentionReport = (options.pruneArtifacts ?? true)
      ? await this.pruneProjectArtifacts(projectDir, options.artifactAllowlist)
      : undefined;

    await this.writeGenerationReport(projectDir, {
      noScaffold: options.noScaffold ?? false,
      validationReport,
      artifactRetentionReport
    });

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
      { id: "api", type: "api", status: "pending", dependsOn: ["architecture"], files: ["openapi.json"] },
      { id: "database", type: "database", status: "pending", dependsOn: ["api"], files: ["backend/migrations"] },
      { id: "backend", type: "backend", status: "pending", dependsOn: ["database", "api"], files: ["backend"] },
      { id: "frontend", type: "frontend", status: "pending", dependsOn: ["backend", "api"], files: ["frontend"] },
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

  async generateApiContractStage(
    projectDir: string,
    options: AgentGenerationStageOptions = {}
  ): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    const spec = await this.store.readSpec(projectDir);
    if (!plan || !spec) {
      throw new Error("SPEC.json или PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "api", "in_progress");

    if (this.modelProvider && options.noScaffold) {
      await this.runAgentGenerationStage(projectDir, {
        role: "api",
        instruction: buildOpenApiInstruction(plan),
        contextFiles: ["REQUEST.md", "SPEC.json", "PLAN.json"],
        writableFiles: ["openapi.json", "README.md"],
        validationCommand: "cat openapi.json",
        requireManifest: true
      }, options);
    } else {
      await writeFile(join(projectDir, "openapi.json"), `${JSON.stringify(renderOpenApiDocument(spec, plan), null, 2)}\n`, "utf8");
    }

    await this.updateTaskStatus(projectDir, "api", "done");
  }

  async generateBackendStage(
    projectDir: string,
    options: AgentGenerationStageOptions = {}
  ): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "backend", "in_progress");

    if (this.modelProvider) {
      await this.runAgentGenerationStage(projectDir, {
        role: "backend",
        instruction: buildBackendInstruction(plan, options),
        contextFiles: options.noScaffold
          ? ["REQUEST.md", "SPEC.json", "PLAN.json", "openapi.json", "AGENT_RUNS.jsonl"]
          : [
              "SPEC.json",
              "PLAN.json",
              "openapi.json",
              "backend/go.mod",
              "backend/cmd/api/main.go",
              "backend/internal/http/router.go",
              "backend/internal/http/generated_routes.go",
              "backend/internal/platform/database/database.go",
              "backend/internal/platform/database/migrate.go",
              "backend/migrations/0001_generated_schema.sql",
              "README.md"
            ],
        writableFiles: options.noScaffold
          ? ["backend", "docker-compose.yml", "README.md", ".env.example", "scripts"]
          : ["backend", "docker-compose.yml", "README.md"],
        validationCommand: "cd backend && go test ./...",
        requireManifest: options.noScaffold
      }, options);
    } else {
      await generateGoBackend({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "backend", "done");
  }

  async generateDatabaseStage(
    projectDir: string,
    options: AgentGenerationStageOptions = {}
  ): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "database", "in_progress");

    if (this.modelProvider) {
      await this.runAgentGenerationStage(projectDir, {
        role: "database",
        instruction: buildDatabaseInstruction(plan, options),
        contextFiles: options.noScaffold
          ? ["REQUEST.md", "SPEC.json", "PLAN.json", "openapi.json", "AGENT_RUNS.jsonl"]
          : [
              "SPEC.json",
              "PLAN.json",
              "openapi.json",
              "backend/migrations/0001_generated_schema.sql",
              "backend/internal/platform/database/database.go",
              "backend/internal/platform/database/migrate.go",
              "docker-compose.yml",
              "README.md"
            ],
        writableFiles: options.noScaffold
          ? ["backend", "docker-compose.yml", "README.md", ".env.example", "scripts"]
          : ["backend", "docker-compose.yml", "README.md"],
        validationCommand: "cd backend && go test ./...",
        requireManifest: options.noScaffold
      }, options);
    } else {
      await generateDatabaseArtifacts({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "database", "done");
  }

  async generateFrontendStage(
    projectDir: string,
    options: AgentGenerationStageOptions = {}
  ): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    if (!plan) {
      throw new Error("PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "frontend", "in_progress");

    if (this.modelProvider) {
      await this.runAgentGenerationStage(projectDir, {
        role: "frontend",
        instruction: buildFrontendInstruction(plan, options),
        contextFiles: options.noScaffold
          ? ["REQUEST.md", "SPEC.json", "PLAN.json", "openapi.json", "AGENT_RUNS.jsonl"]
          : [
              "SPEC.json",
              "PLAN.json",
              "openapi.json",
              "frontend/package.json",
              "frontend/src/main.tsx",
              "frontend/src/App.tsx",
              "frontend/src/styles.css",
              "README.md"
            ],
        writableFiles: options.noScaffold
          ? ["frontend", "README.md", "docker-compose.yml", ".env.example", "scripts"]
          : ["frontend", "README.md"],
        validationCommand: "cd frontend && npm run build",
        requireManifest: options.noScaffold
      }, options);
    } else {
      await generateReactFrontend({ projectDir, plan });
    }

    await this.updateTaskStatus(projectDir, "frontend", "done");
  }

  async integrateProjectStage(
    projectDir: string,
    options: AgentGenerationStageOptions = {}
  ): Promise<void> {
    const plan = await this.store.readPlan(projectDir);
    const spec = await this.store.readSpec(projectDir);
    if (!plan || !spec) {
      throw new Error("SPEC.json или PLAN.json не найден");
    }

    await this.setStage(projectDir, "GENERATING");
    await this.updateTaskStatus(projectDir, "integration", "in_progress");

    if (this.modelProvider) {
      await this.runAgentGenerationStage(projectDir, {
        role: "integrator",
        instruction: buildIntegrationInstruction(plan, options),
        contextFiles: options.noScaffold
          ? [
              "REQUEST.md",
              "SPEC.json",
              "PLAN.json",
              "openapi.json",
              "backend/go.mod",
              "backend/cmd/api/main.go",
              "frontend/package.json",
              "frontend/src/main.tsx",
              "docker-compose.yml",
              "README.md",
              "AGENT_RUNS.jsonl"
            ]
          : [
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
        writableFiles: options.noScaffold
          ? ["backend", "frontend", "docker-compose.yml", "README.md", ".env.example", "scripts"]
          : ["backend", "frontend", "docker-compose.yml", "README.md"],
        validationCommand: "docker compose config",
        requireManifest: options.noScaffold
      }, options);
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
          "openapi.json",
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

    const writableTargets = input.writableFiles.map((path) => sandbox.resolveInsideRoot(path));
    const manifest = input.requireManifest
      ? requireAgentManifest(result, input.validationCommand)
      : result.manifest;

    if (manifest) {
      validateAgentManifest(manifest, writableTargets, sandbox);
      validateManifestCoversUpdatedFiles(manifest, result.updatedFiles ?? []);
    }

    for (const file of result.updatedFiles ?? []) {
      const targetPath = sandbox.resolveInsideRoot(file.path);
      if (!isWritablePath(targetPath, writableTargets)) {
        throw new Error(`Model provider attempted to write outside allowed files: ${file.path}`);
      }

      await sandbox.writeText(file.path, file.content);
    }

    await appendFile(
      join(projectDir, "AGENT_RUNS.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), input, result })}\n`,
      "utf8"
    );

    if (manifest) {
      await appendFile(
        join(projectDir, "AGENT_MANIFESTS.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), role: input.role, manifest })}\n`,
        "utf8"
      );
    }

    return result;
  }

  async validateArtifactCompletenessStage(
    projectDir: string,
    options: ArtifactCompletenessOptions = {}
  ): Promise<ArtifactCompletenessReport> {
    const checks = NO_SCAFFOLD_ARTIFACT_CHECKS.filter((check) => {
      return options.includeIntegration ?? true
        ? true
        : check.id !== "integration-compose" && check.id !== "integration-env";
    });
    const results = await Promise.all(
      checks.map(async (check): Promise<ArtifactCompletenessCheckResult> => {
        const pathResults = await Promise.all(
          check.paths.map(async (path) => ({
            path,
            exists: await artifactPathExists(projectDir, path)
          }))
        );
        const passed = check.mode === "all"
          ? pathResults.every((result) => result.exists)
          : pathResults.some((result) => result.exists);

        return {
          ...check,
          passed,
          missingPaths: pathResults.filter((result) => !result.exists).map((result) => result.path)
        };
      })
    );
    const report: ArtifactCompletenessReport = {
      passed: results.every((result) => result.passed),
      generatedAt: new Date().toISOString(),
      checks: results
    };

    await writeJson(join(projectDir, "ARTIFACT_CHECKS.json"), report);

    if (!report.passed) {
      await this.setStage(projectDir, "FAILED");
      const failedIds = report.checks.filter((check) => !check.passed).map((check) => check.id);
      throw new Error(`No-scaffold artifact completeness failed: ${failedIds.join(", ")}`);
    }

    return report;
  }

  async writeGenerationReport(
    projectDir: string,
    options: {
      noScaffold?: boolean;
      validationReport?: ValidationReport;
      artifactRetentionReport?: ArtifactRetentionReport;
    } = {}
  ): Promise<GenerationReport> {
    const runRecords = await readJsonLines(join(projectDir, "AGENT_RUNS.jsonl"));
    const manifestRecords = await readJsonLines(join(projectDir, "AGENT_MANIFESTS.jsonl"));
    const filesDeclaredByRuns = collectAgentRunFiles(runRecords);
    const filesDeclaredByManifests = collectManifestFiles(manifestRecords);
    const agentAuthoredFiles = new Set([...filesDeclaredByManifests, ...filesDeclaredByRuns]);
    const coveredFiles = [...filesDeclaredByRuns].filter((path) => filesDeclaredByManifests.has(path)).sort();
    const missingFromManifest = [...filesDeclaredByRuns].filter((path) => !filesDeclaredByManifests.has(path)).sort();
    const report: GenerationReport = {
      generatedAt: new Date().toISOString(),
      scaffoldMode: options.noScaffold ? "no-scaffold" : "template",
      deterministicScaffoldUsed: !options.noScaffold,
      agentRunCount: runRecords.length,
      manifestCount: manifestRecords.length,
      agentRoles: collectRecordRoles(runRecords, "result"),
      manifestRoles: collectRecordRoles(manifestRecords),
      agentAuthoredFiles: [...agentAuthoredFiles].sort(),
      agentAuthoredFileCount: agentAuthoredFiles.size,
      manifestCoverage: {
        filesDeclaredByRuns: filesDeclaredByRuns.size,
        filesDeclaredByManifests: filesDeclaredByManifests.size,
        coveredFiles,
        missingFromManifest
      },
      sandboxValidation: buildSandboxValidationSummary(options.validationReport),
      artifactRetention: buildArtifactRetentionSummary(options.artifactRetentionReport)
    };

    await writeJson(join(projectDir, "GENERATION_REPORT.json"), report);

    return report;
  }

  async pruneProjectArtifacts(
    projectDir: string,
    allowedPaths: string[] = DEFAULT_PROJECT_ARTIFACT_ALLOWLIST
  ): Promise<ArtifactRetentionReport> {
    const sandbox = new ProjectSandbox({ rootDir: projectDir, allowedCommands: [] });
    const report = await sandbox.pruneArtifacts(allowedPaths);
    await writeJson(join(projectDir, "ARTIFACT_RETENTION.json"), report);
    return report;
  }

  private async runAgentGenerationStage(
    projectDir: string,
    input: AgentStageInput,
    options: AgentGenerationStageOptions = {}
  ): Promise<AgentRunResult> {
    const maxAttempts = Math.max(1, options.noScaffold ? options.maxStageAttempts ?? 2 : 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.runAgentStage(projectDir, {
          ...input,
          instruction: attempt === 1
            ? input.instruction
            : `${input.instruction}\n\nPrevious attempt ${attempt - 1} failed before artifacts were accepted. Regenerate the stage, include a complete manifest, and stay within writableFiles.`
        });

        if (attempt > 1) {
          await appendFile(
            join(projectDir, "AGENT_STAGE_RETRIES.jsonl"),
            `${JSON.stringify({ at: new Date().toISOString(), role: input.role, attempt, status: "recovered" })}\n`,
            "utf8"
          );
        }

        return result;
      } catch (error) {
        lastError = error;
        await appendFile(
          join(projectDir, "AGENT_STAGE_RETRIES.jsonl"),
          `${JSON.stringify({
            at: new Date().toISOString(),
            role: input.role,
            attempt,
            status: attempt === maxAttempts ? "failed" : "retrying",
            error: error instanceof Error ? error.message : String(error)
          })}\n`,
          "utf8"
        );

        if (attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      timeoutMs: options.timeoutMs,
      runner: options.sandboxRunner
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
        timeoutMs: options.timeoutMs,
        runner: options.sandboxRunner
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

const NO_SCAFFOLD_ARTIFACT_CHECKS: ArtifactCompletenessCheck[] = [
  {
    id: "api-contract",
    description: "OpenAPI contract exists for backend/frontend coordination",
    paths: ["openapi.json"],
    mode: "all"
  },
  {
    id: "backend-module",
    description: "Go backend module exists",
    paths: ["backend/go.mod"],
    mode: "all"
  },
  {
    id: "backend-entrypoint",
    description: "Go backend has an executable entrypoint",
    paths: ["backend/cmd/api/main.go", "backend/cmd/server/main.go", "backend/main.go"],
    mode: "any"
  },
  {
    id: "database-migrations",
    description: "Database migration files exist",
    paths: ["backend/migrations", "migrations"],
    mode: "any"
  },
  {
    id: "frontend-package",
    description: "Frontend package manifest exists",
    paths: ["frontend/package.json"],
    mode: "all"
  },
  {
    id: "frontend-entrypoint",
    description: "Frontend has an application entrypoint",
    paths: ["frontend/src/main.tsx", "frontend/src/main.ts", "frontend/src/App.tsx"],
    mode: "any"
  },
  {
    id: "integration-compose",
    description: "Docker Compose integration exists",
    paths: ["docker-compose.yml"],
    mode: "all"
  },
  {
    id: "integration-env",
    description: "Environment example exists",
    paths: [".env.example"],
    mode: "all"
  }
];

const DEFAULT_PROJECT_ARTIFACT_ALLOWLIST = [
  "REQUEST.md",
  "SPEC.json",
  "PLAN.json",
  "TASKS.json",
  "STATUS.json",
  "openapi.json",
  "backend",
  "frontend",
  "docker-compose.yml",
  ".env.example",
  ".gitignore",
  "package.json",
  "scripts",
  "README.md",
  "REVIEW.md",
  "ARTIFACT_CHECKS.json",
  "ARTIFACT_RETENTION.json",
  "GENERATION_REPORT.json",
  "AGENT_RUNS.jsonl",
  "AGENT_MANIFESTS.jsonl",
  "AGENT_STAGE_RETRIES.jsonl"
];

async function artifactPathExists(projectDir: string, path: string): Promise<boolean> {
  try {
    const pathStat = await stat(join(projectDir, path));
    if (!pathStat.isDirectory()) {
      return true;
    }

    return (await readdir(join(projectDir, path))).length > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isWritablePath(path: string, writableFiles: string[]): boolean {
  return writableFiles.some((allowedPath) => {
    return path === allowedPath || path.startsWith(`${allowedPath}/`);
  });
}

function requireAgentManifest(
  result: AgentRunResult,
  validationCommand?: string
): AgentRunManifest {
  if (!result.manifest) {
    throw new Error(`Agent ${result.role} did not return a required manifest`);
  }

  if (validationCommand && !result.manifest.validationCommands.includes(validationCommand)) {
    throw new Error(`Agent ${result.role} manifest does not include validation command: ${validationCommand}`);
  }

  return result.manifest;
}

function validateAgentManifest(
  manifest: AgentRunManifest,
  writableTargets: string[],
  sandbox: ProjectSandbox
): void {
  const manifestPaths = [...manifest.createdFiles, ...manifest.updatedFiles];
  for (const path of manifestPaths) {
    const targetPath = sandbox.resolveInsideRoot(path);
    if (!isWritablePath(targetPath, writableTargets)) {
      throw new Error(`Agent manifest path is outside allowed files: ${path}`);
    }
  }
}

function validateManifestCoversUpdatedFiles(
  manifest: AgentRunManifest,
  updatedFiles: AgentFileContext[]
): void {
  const manifestPaths = new Set([...manifest.createdFiles, ...manifest.updatedFiles]);
  for (const file of updatedFiles) {
    if (!manifestPaths.has(file.path)) {
      throw new Error(`Agent manifest does not include updated file: ${file.path}`);
    }
  }
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

async function readJsonLines(path: string): Promise<unknown[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function collectAgentRunFiles(records: unknown[]): Set<string> {
  const files = new Set<string>();
  for (const record of records) {
    const result = getObjectProperty(record, "result");
    for (const path of getStringArrayProperty(result, "changedFiles")) {
      files.add(path);
    }

    for (const file of getArrayProperty(result, "updatedFiles")) {
      const path = getStringProperty(file, "path");
      if (path) {
        files.add(path);
      }
    }
  }

  return files;
}

function collectManifestFiles(records: unknown[]): Set<string> {
  const files = new Set<string>();
  for (const record of records) {
    const manifest = getObjectProperty(record, "manifest");
    for (const path of getStringArrayProperty(manifest, "createdFiles")) {
      files.add(path);
    }
    for (const path of getStringArrayProperty(manifest, "updatedFiles")) {
      files.add(path);
    }
  }

  return files;
}

function collectRecordRoles(records: unknown[], nestedProperty?: string): string[] {
  const roles = new Set<string>();
  for (const record of records) {
    const source = nestedProperty ? getObjectProperty(record, nestedProperty) : record;
    const role = getStringProperty(source, "role");
    if (role) {
      roles.add(role);
    }
  }

  return [...roles].sort();
}

function buildSandboxValidationSummary(report?: ValidationReport): SandboxValidationSummary {
  if (!report) {
    return {
      validationRan: false,
      passed: null,
      commandCount: 0,
      failedCheckIds: [],
      timedOutCheckIds: [],
      signaledCheckIds: [],
      outputTruncatedCheckIds: [],
      failureModes: []
    };
  }

  const failedCheckIds = new Set<string>();
  const timedOutCheckIds = new Set<string>();
  const signaledCheckIds = new Set<string>();
  const outputTruncatedCheckIds = new Set<string>();
  const failureModes = new Set<string>();

  for (const result of report.results) {
    if (!result.passed) {
      failedCheckIds.add(result.check.id);
      failureModes.add("command_failed");
    }

    if (result.commandResult.timedOut) {
      timedOutCheckIds.add(result.check.id);
      failureModes.add("timeout");
    }

    if (result.commandResult.signal) {
      signaledCheckIds.add(result.check.id);
      failureModes.add("signal");
    }

    if (result.commandResult.stdoutTruncated || result.commandResult.stderrTruncated) {
      outputTruncatedCheckIds.add(result.check.id);
      failureModes.add("output_truncated");
    }
  }

  return {
    validationRan: true,
    passed: report.passed,
    commandCount: report.results.length,
    failedCheckIds: [...failedCheckIds].sort(),
    timedOutCheckIds: [...timedOutCheckIds].sort(),
    signaledCheckIds: [...signaledCheckIds].sort(),
    outputTruncatedCheckIds: [...outputTruncatedCheckIds].sort(),
    failureModes: [...failureModes].sort()
  };
}

function buildArtifactRetentionSummary(report?: ArtifactRetentionReport): ArtifactRetentionSummary {
  if (!report) {
    return {
      pruningRan: false,
      allowedPaths: [],
      keptPathCount: 0,
      removedPaths: []
    };
  }

  return {
    pruningRan: true,
    allowedPaths: report.allowedPaths,
    keptPathCount: report.keptPaths.length,
    removedPaths: report.removedPaths
  };
}

function getObjectProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return propertyValue && typeof propertyValue === "object" && !Array.isArray(propertyValue)
    ? propertyValue as Record<string, unknown>
    : undefined;
}

function getArrayProperty(value: unknown, property: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return Array.isArray(propertyValue) ? propertyValue : [];
}

function getStringArrayProperty(value: unknown, property: string): string[] {
  return getArrayProperty(value, property).filter((item): item is string => typeof item === "string");
}

function getStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

function buildRequirementsInstruction(): string {
  return [
    "Сформируй файл SPEC.json как валидный JSON без markdown.",
    "SPEC.json должен содержать:",
    '- projectName: kebab-case имя проекта',
    "- description: краткое описание",
    "- actors: минимум один актор",
    '- features: массив; минимум одна feature с id, title, description, priority; priority строго "must", "should" или "could", не число',
    "- entities: массив сущностей; не объект/map; каждая сущность содержит name, fields и при необходимости indexes",
    "- requiresAuth, requiresDatabase",
    "- constraints: массив строк, не объект/map",
    "- acceptanceCriteria: массив строк",
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

function buildOpenApiInstruction(plan: ProjectPlan): string {
  return [
    `Сформируй openapi.json для проекта ${plan.projectName} как валидный OpenAPI 3.0 JSON без markdown.`,
    "Используй SPEC.json и PLAN.json как источник истины.",
    "Опиши paths для всех endpoints из PLAN.json, базовые request/response schemas для ресурсов и health endpoints.",
    "No-scaffold режим: backend и frontend будут опираться на этот контракт, поэтому пути, методы и JSON поля должны быть стабильными.",
    "Возвращай полное содержимое openapi.json."
  ].join("\n");
}

function buildDatabaseInstruction(
  plan: ProjectPlan,
  options: { noScaffold?: boolean } = {}
): string {
  return [
    `Сгенерируй весь database layer проекта ${plan.projectName} на основе SPEC.json и PLAN.json.`,
    options.noScaffold
      ? "No-scaffold режим: шаблона нет. Создай все нужные backend database files с нуля, включая migrations и wiring."
      : "Работай поверх текущего scaffold.",
    "Нужно обновить PostgreSQL migration files и backend database wiring в разрешенных файлах.",
    "Соблюдай связи между сущностями, индексы, типы полей и совместимость с Go backend.",
    "Возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildBackendInstruction(
  plan: ProjectPlan,
  options: { noScaffold?: boolean } = {}
): string {
  return [
    `Сгенерируй весь Go backend проекта ${plan.projectName} на основе SPEC.json и PLAN.json.`,
    options.noScaffold
      ? [
          "No-scaffold режим: backend директория может быть пустой.",
          "Создай полный Go module с go.mod, cmd/api/main.go, HTTP router, handlers, storage/database layer, migrations и тестами.",
          "Backend должен запускаться в Docker и проходить `go test ./...`."
        ].join(" ")
      : "Разрешено переписывать scaffolded backend-файлы полностью.",
    "Нужны рабочие REST handlers, routing, models, storage/repository integration и startup wiring.",
    "Сохраняй совместимость с database migrations и docker-compose.",
    "Возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildFrontendInstruction(
  plan: ProjectPlan,
  options: { noScaffold?: boolean } = {}
): string {
  return [
    `Сгенерируй весь React frontend проекта ${plan.projectName} на основе SPEC.json и PLAN.json.`,
    options.noScaffold
      ? [
          "No-scaffold режим: frontend директория может быть пустой.",
          "Создай полный Vite React TypeScript project с package.json, tsconfig, index.html, src files, styles и тестами.",
          "Frontend должен собираться командой `npm run build`."
        ].join(" ")
      : "Разрешено переписывать scaffolded frontend-файлы полностью.",
    "Сделай интерфейс под основные user flows и связанные ресурсы из плана.",
    options.noScaffold
      ? "Не рассчитывай на заранее созданные файлы. Возвращай полное содержимое каждого созданного файла."
      : "Используй существующий Vite/TypeScript scaffold и возвращай полное содержимое каждого измененного файла."
  ].join("\n");
}

function buildIntegrationInstruction(
  plan: ProjectPlan,
  options: { noScaffold?: boolean } = {}
): string {
  return [
    `Интегрируй backend, frontend и docker-compose проекта ${plan.projectName} в единый рабочий контур.`,
    options.noScaffold
      ? "No-scaffold режим: создай или исправь docker-compose.yml, Dockerfile files, .env.example и scripts с нуля."
      : "Работай поверх существующего scaffold.",
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

function renderOpenApiDocument(spec: ProjectSpec, plan: ProjectPlan): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: plan.projectName,
      version: "0.1.0",
      description: spec.description
    },
    paths: Object.fromEntries(
      plan.endpoints.map((endpoint) => [
        endpoint.path,
        {
          [endpoint.method.toLowerCase()]: {
            summary: endpoint.summary,
            security: endpoint.authRequired ? [{ bearerAuth: [] }] : [],
            responses: {
              "200": {
                description: "Successful response"
              },
              "400": {
                description: "Invalid request"
              },
              "404": {
                description: "Not found"
              },
              "500": {
                description: "Internal server error"
              }
            }
          }
        }
      ])
    ),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT"
        }
      },
      schemas: Object.fromEntries(
        plan.databaseEntities.map((entity) => [
          entity.name,
          {
            type: "object",
            properties: Object.fromEntries([
              ["id", { type: "string" }],
              ...entity.fields.map((field) => [
                toJsonSchemaPropertyName(field.name),
                renderJsonSchemaProperty(field.type)
              ])
            ]),
            required: [
              "id",
              ...entity.fields
                .filter((field) => field.required)
                .map((field) => toJsonSchemaPropertyName(field.name))
            ]
          }
        ])
      )
    }
  };
}

function toJsonSchemaPropertyName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function renderJsonSchemaProperty(type: ProjectSpec["entities"][number]["fields"][number]["type"]): Record<string, string> {
  switch (type) {
    case "integer":
      return { type: "integer" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "json":
      return { type: "object" };
    case "text":
    case "string":
    default:
      return { type: "string" };
  }
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
