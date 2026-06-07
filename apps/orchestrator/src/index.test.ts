import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(tasks.tasks).toHaveLength(10);
      expect(tasks.tasks.map((task: { id: string }) => task.id)).toContain("api");
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

  it("rejects model file updates that escape an allowed writable subtree", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    const provider: ModelProvider = {
      async generate(input) {
        return {
          role: input.role,
          summary: "Attempted path traversal",
          changedFiles: ["frontend/../STATUS.json"],
          updatedFiles: [
            {
              path: "frontend/../STATUS.json",
              content: "malicious\n"
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

      await expect(
        orchestrator.runAgentStage(projectDir, {
          role: "frontend",
          instruction: "Update frontend",
          contextFiles: [],
          writableFiles: ["frontend"]
        })
      ).rejects.toThrow("outside allowed files");

      await expect(readFile(join(projectDir, "STATUS.json"), "utf8")).resolves.not.toBe("malicious\n");
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

        if (input.role === "api") {
          expect(input.instruction).toContain("openapi.json");
          return {
            role: input.role,
            summary: "Created OpenAPI contract",
            changedFiles: ["openapi.json"],
            updatedFiles: [
              {
                path: "openapi.json",
                content: `${JSON.stringify({
                  openapi: "3.0.3",
                  info: {
                    title: "agent-only-books",
                    version: "0.1.0"
                  },
                  paths: {
                    "/api/books": {
                      get: {
                        summary: "List books",
                        responses: {
                          "200": {
                            description: "OK"
                          }
                        }
                      }
                    }
                  }
                }, null, 2)}\n`
              }
            ],
            manifest: {
              createdFiles: ["openapi.json"],
              updatedFiles: [],
              validationCommands: ["cat openapi.json"],
              notes: ["Created OpenAPI contract from PLAN"]
            },
            rawOutput: "api"
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

  it("rejects no-scaffold bootstrap without a model provider", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await expect(
        orchestrator.bootstrapProjectFromPrompt(projectDir, "Создай сервис книг.", {
          noScaffold: true,
          runValidation: false
        })
      ).rejects.toThrow("requires a ModelProvider");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("bootstraps a no-scaffold project with agent-created application files", async () => {
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
                  projectName: "agent-only-books",
                  description: "Agent-only generated project",
                  actors: [{ name: "user" }],
                  features: [
                    {
                      id: "books-crud",
                      title: "Manage books",
                      description: "Manage books",
                      priority: "must"
                    }
                  ],
                  entities: [{ name: "Book", fields: ["title"] }],
                  requiresAuth: true,
                  requiresDatabase: true,
                  constraints: [],
                  acceptanceCriteria: ["Books can be listed"]
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
                  projectName: "agent-only-books",
                  stack: {
                    frontend: "react-vite-typescript",
                    backend: "go-chi",
                    database: "postgresql",
                    api: "rest-openapi"
                  },
                  backendModules: ["books"],
                  frontendRoutes: ["/"],
                  databaseEntities: [{ name: "Book", fields: ["title"] }],
                  endpoints: [
                    {
                      method: "GET",
                      path: "/api/books",
                      summary: "List books",
                      authRequired: true
                    }
                  ],
                  validationCommands: ["docker compose config", "cd backend && go test ./...", "cd frontend && npm run build"]
                }, null, 2)}\n`
              }
            ],
            rawOutput: "plan"
          };
        }

        if (input.role === "api") {
          expect(input.instruction).toContain("openapi.json");
          return {
            role: input.role,
            summary: "Created OpenAPI contract",
            changedFiles: ["openapi.json"],
            updatedFiles: [
              {
                path: "openapi.json",
                content: `${JSON.stringify({
                  openapi: "3.0.3",
                  info: {
                    title: "agent-only-books",
                    version: "0.1.0"
                  },
                  paths: {
                    "/api/books": {
                      get: {
                        summary: "List books",
                        responses: {
                          "200": {
                            description: "OK"
                          }
                        }
                      }
                    }
                  }
                }, null, 2)}\n`
              }
            ],
            manifest: {
              createdFiles: ["openapi.json"],
              updatedFiles: [],
              validationCommands: ["cat openapi.json"],
              notes: ["Created OpenAPI contract from PLAN"]
            },
            rawOutput: "api"
          };
        }

        if (input.role === "database") {
          expect(input.files.map((file) => file.path)).not.toContain("backend/migrations/0001_generated_schema.sql");
          expect(input.instruction).toContain("No-scaffold");
          return {
            role: input.role,
            summary: "Created database files",
            changedFiles: ["backend/migrations/0001_generated_schema.sql"],
            updatedFiles: [
              {
                path: "backend/migrations/0001_generated_schema.sql",
                content: "CREATE TABLE IF NOT EXISTS books (id uuid primary key, title text not null);\n"
              }
            ],
            manifest: {
              createdFiles: ["backend/migrations/0001_generated_schema.sql"],
              updatedFiles: [],
              validationCommands: ["cd backend && go test ./..."],
              notes: ["Created database migration from scratch"]
            },
            rawOutput: "database"
          };
        }

        if (input.role === "backend") {
          expect(input.instruction).toContain("No-scaffold");
          return {
            role: input.role,
            summary: "Created backend from scratch",
            changedFiles: ["backend/go.mod", "backend/cmd/api/main.go"],
            updatedFiles: [
              {
                path: "backend/go.mod",
                content: "module agent-only-books/backend\n\ngo 1.22\n"
              },
              {
                path: "backend/cmd/api/main.go",
                content: "package main\n\nfunc main() {}\n"
              }
            ],
            manifest: {
              createdFiles: ["backend/go.mod", "backend/cmd/api/main.go"],
              updatedFiles: [],
              validationCommands: ["cd backend && go test ./..."],
              notes: ["Created minimal Go backend from scratch"]
            },
            rawOutput: "backend"
          };
        }

        if (input.role === "frontend") {
          expect(input.instruction).toContain("No-scaffold");
          return {
            role: input.role,
            summary: "Created frontend from scratch",
            changedFiles: ["frontend/package.json", "frontend/src/main.tsx"],
            updatedFiles: [
              {
                path: "frontend/package.json",
                content: "{\"scripts\":{\"build\":\"node -e \\\"process.exit(0)\\\"\"}}\n"
              },
              {
                path: "frontend/src/main.tsx",
                content: 'console.log("agent-only-books")\n'
              }
            ],
            manifest: {
              createdFiles: ["frontend/package.json", "frontend/src/main.tsx"],
              updatedFiles: [],
              validationCommands: ["cd frontend && npm run build"],
              notes: ["Created minimal frontend from scratch"]
            },
            rawOutput: "frontend"
          };
        }

        if (input.role === "integrator") {
          expect(input.instruction).toContain("No-scaffold");
          return {
            role: input.role,
            summary: "Created integration files",
            changedFiles: ["docker-compose.yml", ".env.example"],
            updatedFiles: [
              {
                path: "docker-compose.yml",
                content: "services:\n  api:\n    build: ./backend\n  frontend:\n    build: ./frontend\n"
              },
              {
                path: ".env.example",
                content: "DATABASE_URL=postgres://postgres:postgres@db:5432/app\n"
              }
            ],
            manifest: {
              createdFiles: ["docker-compose.yml", ".env.example"],
              updatedFiles: [],
              validationCommands: ["docker compose config"],
              notes: ["Created integration files from scratch"]
            },
            rawOutput: "integration"
          };
        }

        throw new Error(`unexpected role: ${input.role}`);
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await orchestrator.bootstrapProjectFromPrompt(projectDir, "Создай сервис книг.", {
        noScaffold: true,
        runValidation: false,
        runDocumentation: false
      });

      await expect(readFile(join(projectDir, "backend/go.mod"), "utf8")).resolves.toContain("agent-only-books");
      await expect(readFile(join(projectDir, "openapi.json"), "utf8")).resolves.toContain("/api/books");
      await expect(readFile(join(projectDir, "frontend/src/main.tsx"), "utf8")).resolves.toContain("agent-only-books");
      await expect(readFile(join(projectDir, "docker-compose.yml"), "utf8")).resolves.toContain("build: ./backend");
      await expect(readFile(join(projectDir, "backend/internal/http/router.go"), "utf8")).rejects.toThrow();
      await expect(readFile(join(projectDir, "AGENT_RUNS.jsonl"), "utf8")).resolves.toContain("\"role\":\"integrator\"");
      await expect(readFile(join(projectDir, "AGENT_MANIFESTS.jsonl"), "utf8")).resolves.toContain("docker-compose.yml");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("retries no-scaffold agent stages before failing the bootstrap", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    let databaseAttempts = 0;
    const provider: ModelProvider = {
      async generate(input) {
        databaseAttempts += 1;
        expect(input.role).toBe("database");

        if (databaseAttempts === 1) {
          return {
            role: input.role,
            summary: "Missing manifest",
            changedFiles: ["backend/migrations/0001_generated_schema.sql"],
            updatedFiles: [
              {
                path: "backend/migrations/0001_generated_schema.sql",
                content: "CREATE TABLE books (id text primary key);\n"
              }
            ],
            rawOutput: "database"
          };
        }

        return {
          role: input.role,
          summary: "Created database files",
          changedFiles: ["backend/migrations/0001_generated_schema.sql"],
          updatedFiles: [
            {
              path: "backend/migrations/0001_generated_schema.sql",
              content: "CREATE TABLE books (id text primary key);\n"
            }
          ],
          manifest: {
            createdFiles: ["backend/migrations/0001_generated_schema.sql"],
            updatedFiles: [],
            validationCommands: ["cd backend && go test ./..."]
          },
          rawOutput: "database"
        };
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await orchestrator.initializeProject(projectDir, {
        projectName: "agent-only-books",
        description: "Agent-only generated project",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Manage books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["Books can be listed"]
      });
      await orchestrator.approveSpec(projectDir, {
        projectName: "agent-only-books",
        stack: {
          frontend: "react-vite-typescript",
          backend: "go-chi",
          database: "postgresql",
          api: "rest-openapi"
        },
        backendModules: ["books"],
        frontendRoutes: ["/"],
        databaseEntities: [{ name: "Book", fields: ["title"] }],
        endpoints: [
          {
            method: "GET",
            path: "/api/books",
            summary: "List books",
            authRequired: true
          }
        ],
        validationCommands: ["docker compose config"]
      });
      await writeFile(join(projectDir, "REQUEST.md"), "Создай сервис книг.\n", "utf8");
      await writeFile(join(projectDir, "openapi.json"), "{}\n", "utf8");

      await orchestrator.generateDatabaseStage(projectDir, {
        noScaffold: true,
        maxStageAttempts: 2
      });

      expect(databaseAttempts).toBe(2);
      await expect(readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8")).resolves.toContain(
        "CREATE TABLE books"
      );
      await expect(readFile(join(projectDir, "AGENT_STAGE_RETRIES.jsonl"), "utf8")).resolves.toContain("\"status\":\"recovered\"");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes an artifact completeness report for missing no-scaffold files", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "agent-only-books",
        description: "Agent-only generated project",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Manage books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["Books can be listed"]
      });
      await mkdir(join(projectDir, "backend/cmd/api"), { recursive: true });
      await mkdir(join(projectDir, "backend/migrations"), { recursive: true });
      await mkdir(join(projectDir, "frontend/src"), { recursive: true });
      await writeFile(join(projectDir, "openapi.json"), "{}\n", "utf8");
      await writeFile(join(projectDir, "backend/go.mod"), "module agent-only-books/backend\n", "utf8");
      await writeFile(join(projectDir, "backend/cmd/api/main.go"), "package main\nfunc main() {}\n", "utf8");
      await writeFile(join(projectDir, "backend/migrations/0001_init.sql"), "CREATE TABLE books (id text primary key);\n", "utf8");
      await writeFile(join(projectDir, "frontend/src/main.tsx"), "console.log('app')\n", "utf8");
      await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n", "utf8");

      await expect(orchestrator.validateArtifactCompletenessStage(projectDir)).rejects.toThrow("frontend-package");

      await expect(readFile(join(projectDir, "ARTIFACT_CHECKS.json"), "utf8")).resolves.toContain("\"passed\": false");
      await expect(readFile(join(projectDir, "STATUS.json"), "utf8")).resolves.toContain("\"stage\": \"FAILED\"");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects no-scaffold app stages without an agent manifest", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));
    const provider: ModelProvider = {
      async generate(input) {
        if (input.role === "database") {
          return {
            role: input.role,
            summary: "Missing manifest",
            changedFiles: ["backend/migrations/0001_generated_schema.sql"],
            updatedFiles: [
              {
                path: "backend/migrations/0001_generated_schema.sql",
                content: "CREATE TABLE books (id text primary key);\n"
              }
            ],
            rawOutput: "database"
          };
        }

        if (input.role === "api") {
          return {
            role: input.role,
            summary: "Created OpenAPI contract",
            changedFiles: ["openapi.json"],
            updatedFiles: [
              {
                path: "openapi.json",
                content: `${JSON.stringify({
                  openapi: "3.0.3",
                  info: {
                    title: "agent-only-books",
                    version: "0.1.0"
                  },
                  paths: {}
                }, null, 2)}\n`
              }
            ],
            manifest: {
              createdFiles: ["openapi.json"],
              updatedFiles: [],
              validationCommands: ["cat openapi.json"]
            },
            rawOutput: "api"
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
                  projectName: "agent-only-books",
                  stack: {
                    frontend: "react-vite-typescript",
                    backend: "go-chi",
                    database: "postgresql",
                    api: "rest-openapi"
                  },
                  backendModules: ["books"],
                  frontendRoutes: ["/"],
                  databaseEntities: [{ name: "Book", fields: ["title"] }],
                  endpoints: [
                    {
                      method: "GET",
                      path: "/api/books",
                      summary: "List books",
                      authRequired: true
                    }
                  ],
                  validationCommands: ["docker compose config"]
                }, null, 2)}\n`
              }
            ],
            rawOutput: "plan"
          };
        }

        return {
          role: input.role,
          summary: "Created SPEC",
          changedFiles: ["SPEC.json"],
          updatedFiles: [
            {
              path: "SPEC.json",
              content: `${JSON.stringify({
                projectName: "agent-only-books",
                description: "Agent-only generated project",
                actors: [{ name: "user" }],
                features: [
                  {
                    id: "books-crud",
                    title: "Manage books",
                    description: "Manage books",
                    priority: "must"
                  }
                ],
                entities: [{ name: "Book", fields: ["title"] }],
                requiresAuth: true,
                requiresDatabase: true,
                constraints: [],
                acceptanceCriteria: ["Books can be listed"]
              }, null, 2)}\n`
            }
          ],
          rawOutput: "spec"
        };
      }
    };

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);

      await expect(
        orchestrator.bootstrapProjectFromPrompt(projectDir, "Создай сервис книг.", {
          noScaffold: true,
          runValidation: false
        })
      ).rejects.toThrow("required manifest");
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
      const api = await readFile(join(projectDir, "frontend/src/api.ts"), "utf8");
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const frontendTask = tasks.tasks.find((task: { id: string }) => task.id === "frontend");

      expect(main).toContain("resourceDefinitions.map");
      expect(api).toContain("\"title\": \"Учет книг\"");
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
