import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { StubModelProvider, type ModelProvider } from "@hephaestus/hermes-adapter";
import { FileProjectStateStore, Orchestrator } from "./index.js";

describe("Orchestrator", () => {
  it("initializes project artifacts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));

      expect(status.stage).toBe("SPEC_APPROVAL");
      expect(tasks.tasks).toHaveLength(9);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("scaffolds the generated application template with project artifacts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.scaffoldProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      await expect(readFile(join(projectDir, "backend/go.mod"), "utf8")).resolves.toContain("module");
      await expect(readFile(join(projectDir, "frontend/package.json"), "utf8")).resolves.toContain("vite");
      await expect(readFile(join(projectDir, "SPEC.json"), "utf8")).resolves.toContain("book-tracker");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("runs an agent stage with scoped file context", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(
        new FileProjectStateStore(),
        new StubModelProvider()
      );

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const result = await orchestrator.runAgentStage(projectDir, {
        role: "architect",
        instruction: "Create a project plan",
        contextFiles: ["SPEC.json"],
        writableFiles: ["PLAN.json"],
        validationCommand: "npm test"
      });

      const log = await readFile(join(projectDir, "AGENT_RUNS.jsonl"), "utf8");

      expect(result.summary).toContain("architect");
      expect(log).toContain("SPEC.json");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("applies file updates returned by the model provider", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    const provider: ModelProvider = {
      async generate(input) {
        return {
          role: input.role,
          summary: "Updated plan",
          changedFiles: ["PLAN.json"],
          updatedFiles: [
            {
              path: "PLAN.json",
              content: "{\"projectName\":\"updated\"}\n"
            }
          ],
          rawOutput: "ok"
        };
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      await orchestrator.runAgentStage(projectDir, {
        role: "architect",
        instruction: "Update plan",
        contextFiles: ["SPEC.json"],
        writableFiles: ["PLAN.json"]
      });

      await expect(readFile(join(projectDir, "PLAN.json"), "utf8")).resolves.toContain("updated");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("creates architecture plan from stored spec", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const plan = await orchestrator.planProject(projectDir);
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const architectureTask = tasks.tasks.find((task: { id: string }) => task.id === "architecture");

      expect(plan.backendModules).toContain("books");
      expect(status.stage).toBe("GENERATING");
      expect(architectureTask.status).toBe("done");
      await expect(readFile(join(projectDir, "PLAN.json"), "utf8")).resolves.toContain("/api/books");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("bootstraps a project from prompt through provider-backed agent stages", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    const provider: ModelProvider = {
      async generate(input) {
        if (input.role === "requirements") {
          return {
            role: input.role,
            summary: "Created SPEC",
            changedFiles: ["SPEC.json"],
            updatedFiles: [
              {
                path: "SPEC.json",
                content: `${JSON.stringify({
                  projectName: "agent-library",
                  description: "LLM generated library tracker",
                  actors: [{ name: "user" }],
                  features: [
                    {
                      id: "books-crud",
                      title: "Manage books",
                      description: "Create and edit books",
                      priority: "must"
                    }
                  ],
                  entities: [{ name: "Book", fields: ["title", "author"] }],
                  requiresAuth: true,
                  requiresDatabase: true,
                  constraints: [],
                  acceptanceCriteria: ["User can create books"]
                }, null, 2)}\n`
              }
            ],
            rawOutput: "spec"
          };
        }

        if (input.role === "architect") {
          return {
            role: input.role,
            summary: "Created PLAN",
            changedFiles: ["PLAN.json"],
            updatedFiles: [
              {
                path: "PLAN.json",
                content: `${JSON.stringify({
                  projectName: "agent-library",
                  stack: {
                    frontend: "react-vite-typescript",
                    backend: "go-chi",
                    database: "postgresql",
                    api: "rest-openapi"
                  },
                  backendModules: ["books"],
                  frontendRoutes: ["/", "/books"],
                  databaseEntities: [{ name: "Book", fields: ["title", "author"] }],
                  endpoints: [
                    {
                      method: "GET",
                      path: "/api/books",
                      summary: "List books",
                      authRequired: true
                    }
                  ],
                  validationCommands: ["npm run build", "go test ./..."]
                }, null, 2)}\n`
              }
            ],
            rawOutput: "plan"
          };
        }

        if (input.role === "database") {
          return {
            role: input.role,
            summary: "Created migration",
            changedFiles: ["backend/migrations/0001_generated_schema.sql"],
            updatedFiles: [
              {
                path: "backend/migrations/0001_generated_schema.sql",
                content: "CREATE TABLE IF NOT EXISTS books (id uuid primary key, title text not null);\n"
              }
            ],
            rawOutput: "database"
          };
        }

        if (input.role === "backend") {
          return {
            role: input.role,
            summary: "Created backend routes",
            changedFiles: ["backend/internal/http/generated_routes.go"],
            updatedFiles: [
              {
                path: "backend/internal/http/generated_routes.go",
                content: "package http\n\nfunc registerGeneratedRoutes() {}\n"
              }
            ],
            rawOutput: "backend"
          };
        }

        if (input.role === "frontend") {
          return {
            role: input.role,
            summary: "Created frontend",
            changedFiles: ["frontend/src/main.tsx"],
            updatedFiles: [
              {
                path: "frontend/src/main.tsx",
                content: 'console.log("agent-library")\n'
              }
            ],
            rawOutput: "frontend"
          };
        }

        if (input.role === "integrator") {
          return {
            role: input.role,
            summary: "Integrated stack",
            changedFiles: ["docker-compose.yml"],
            updatedFiles: [
              {
                path: "docker-compose.yml",
                content: "services:\n  api:\n    image: agent-library\n"
              }
            ],
            rawOutput: "integrator"
          };
        }

        if (input.role === "documentation") {
          return {
            role: input.role,
            summary: "Updated docs",
            changedFiles: ["README.md"],
            updatedFiles: [
              {
                path: "README.md",
                content: "# agent-library\n\nGenerated by agents.\n"
              }
            ],
            rawOutput: "documentation"
          };
        }

        throw new Error(`unexpected role: ${input.role}`);
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);
      const result = await orchestrator.bootstrapProjectFromPrompt(
        projectDir,
        "Сделай сервис для учета книг с CRUD интерфейсом.",
        {
          checks: [
            {
              id: "npm-version",
              title: "Проверка npm",
              command: "npm",
              args: ["--version"],
              cwd: ".",
              required: true
            }
          ]
        }
      );

      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));

      expect(result.spec.projectName).toBe("agent-library");
      expect(result.validationReport?.passed).toBe(true);
      await expect(readFile(join(projectDir, "REQUEST.md"), "utf8")).resolves.toContain("CRUD");
      await expect(readFile(join(projectDir, "PLAN.json"), "utf8")).resolves.toContain("/api/books");
      await expect(readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8")).resolves.toContain("CREATE TABLE");
      await expect(readFile(join(projectDir, "frontend/src/main.tsx"), "utf8")).resolves.toContain("agent-library");
      await expect(readFile(join(projectDir, "README.md"), "utf8")).resolves.toContain("Generated by agents");
      expect(tasks.tasks.find((task: { id: string }) => task.id === "frontend")?.status).toBe("done");
      expect(tasks.tasks.find((task: { id: string }) => task.id === "integration")?.status).toBe("done");
      expect(tasks.tasks.find((task: { id: string }) => task.id === "documentation")?.status).toBe("done");
      expect(status.stage).toBe("READY");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("generates Go backend from stored plan", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.scaffoldProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author", "genre", "status"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });
      await orchestrator.planProject(projectDir);
      await orchestrator.generateDatabaseStage(projectDir);
      await orchestrator.generateBackendStage(projectDir);

      const routes = await readFile(join(projectDir, "backend/internal/http/generated_routes.go"), "utf8");
      const migration = await readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8");
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const databaseTask = tasks.tasks.find((task: { id: string }) => task.id === "database");
      const backendTask = tasks.tasks.find((task: { id: string }) => task.id === "backend");

      expect(routes).toContain('router.Route("/books"');
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS books");
      expect(databaseTask.status).toBe("done");
      expect(backendTask.status).toBe("done");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("generates React frontend from stored plan", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.scaffoldProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author", "genre", "status"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });
      await orchestrator.planProject(projectDir);
      await orchestrator.generateFrontendStage(projectDir);

      const main = await readFile(join(projectDir, "frontend/src/main.tsx"), "utf8");
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const frontendTask = tasks.tasks.find((task: { id: string }) => task.id === "frontend");

      expect(main).toContain("Учет книг");
      expect(frontendTask.status).toBe("done");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("moves project to READY after successful validation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.validateProjectStage(projectDir, {
        checks: [
          {
            id: "npm-version",
            title: "Проверка npm",
            command: "npm",
            args: ["--version"],
            cwd: ".",
            required: true
          }
        ]
      });
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const testingTask = tasks.tasks.find((task: { id: string }) => task.id === "testing");

      expect(report.passed).toBe(true);
      expect(status.stage).toBe("READY");
      expect(testingTask.status).toBe("done");
      await expect(readFile(join(projectDir, "REVIEW.md"), "utf8")).resolves.toContain("Отчет проверки");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("moves project to FAILED after unsuccessful validation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.validateProjectStage(projectDir, {
        checks: [
          {
            id: "missing-script",
            title: "Отсутствующий npm-скрипт",
            command: "npm",
            args: ["run", "missing"],
            cwd: ".",
            required: true
          }
        ]
      });
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const testingTask = tasks.tasks.find((task: { id: string }) => task.id === "testing");

      expect(report.passed).toBe(false);
      expect(status.stage).toBe("FAILED");
      expect(testingTask.status).toBe("failed");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("runs a limited fixer loop and reaches READY after applying a fix", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    let fixApplied = false;
    const provider: ModelProvider = {
      async generate(input) {
        if (input.role !== "fixer") {
          throw new Error("unexpected role");
        }

        fixApplied = true;
        return {
          role: "fixer",
          summary: "Applied fix from REVIEW.md",
          changedFiles: ["package.json"],
          updatedFiles: [
            {
              path: "package.json",
              content: JSON.stringify({
                scripts: {
                  pass: "node -e \"process.exit(0)\""
                }
              }, null, 2)
            }
          ],
          rawOutput: "fixed"
        };
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.fixProjectStage(projectDir, {
        maxAttempts: 2,
        checks: [
          {
            id: "pass-script",
            title: "Исправляемый npm-скрипт",
            command: "npm",
            args: ["run", "pass"],
            cwd: ".",
            required: true
          }
        ],
        writableFiles: ["package.json"]
      });

      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const fixingTask = tasks.tasks.find((task: { id: string }) => task.id === "fixing");

      expect(report.passed).toBe(true);
      expect(fixApplied).toBe(true);
      expect(status.stage).toBe("READY");
      expect(status.attempts.fixing).toBe(2);
      expect(fixingTask.status).toBe("done");
      await expect(readFile(join(projectDir, "REVIEW.md"), "utf8")).resolves.toContain("успешно");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("stops fixer loop after max attempts and leaves project FAILED", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    const provider: ModelProvider = {
      async generate() {
        return {
          role: "fixer",
          summary: "No changes",
          changedFiles: [],
          updatedFiles: [],
          rawOutput: "noop"
        };
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.fixProjectStage(projectDir, {
        maxAttempts: 2,
        checks: [
          {
            id: "still-failing",
            title: "Постоянно падающая проверка",
            command: "npm",
            args: ["run", "missing"],
            cwd: ".",
            required: true
          }
        ]
      });

      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const fixingTask = tasks.tasks.find((task: { id: string }) => task.id === "fixing");

      expect(report.passed).toBe(false);
      expect(status.stage).toBe("FAILED");
      expect(status.attempts.fixing).toBe(2);
      expect(fixingTask.status).toBe("failed");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 120_000);
});
