import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  bootstrapProjectFromDescription,
  parseScaffoldArgs,
  parseBootstrapArgs,
  parseRequirementsArgs,
  parsePlanArgs,
  parseGenerateBackendArgs,
  parseGenerateDatabaseArgs,
  parseGenerateFrontendArgs,
  parseValidateArgs,
  generateBackendFromProject,
  generateDatabaseFromProject,
  generateFrontendFromProject,
  saveArchitecturePlan,
  saveRequirementsSpec,
  scaffoldFromSpecFile,
  validateProjectDirectory
} from "./cli.js";

describe("scaffold CLI", () => {
  it("parses required arguments", () => {
    expect(parseScaffoldArgs(["--spec", "spec.json", "--out", "app"])).toEqual({
      specPath: "spec.json",
      outDir: "app"
    });
  });

  it("requires spec and output arguments", () => {
    expect(() => parseScaffoldArgs(["--spec", "spec.json"])).toThrow("Использование");
  });

  it("parses validation arguments", () => {
    expect(parseValidateArgs(["--project", "app"])).toEqual({
      projectDir: "app"
    });
  });

  it("parses requirements arguments", () => {
    expect(parseRequirementsArgs(["--text", "Создай сервис книг", "--out", "SPEC.json"])).toEqual({
      text: "Создай сервис книг",
      inputPath: undefined,
      outPath: "SPEC.json",
      projectName: undefined
    });
  });

  it("parses plan arguments", () => {
    expect(parsePlanArgs(["--spec", "SPEC.json", "--out", "PLAN.json"])).toEqual({
      specPath: "SPEC.json",
      outPath: "PLAN.json"
    });
  });

  it("parses backend generation arguments", () => {
    expect(parseGenerateBackendArgs(["--project", "app"])).toEqual({
      projectDir: "app"
    });
  });

  it("parses database generation arguments", () => {
    expect(parseGenerateDatabaseArgs(["--project", "app"])).toEqual({
      projectDir: "app"
    });
  });

  it("parses frontend generation arguments", () => {
    expect(parseGenerateFrontendArgs(["--project", "app"])).toEqual({
      projectDir: "app"
    });
  });

  it("parses bootstrap arguments", () => {
    expect(
      parseBootstrapArgs(["--text", "Создай сервис книг", "--out", "app", "--model", "qwen2.5-coder:14b"])
    ).toEqual({
      text: "Создай сервис книг",
      inputPath: undefined,
      outDir: "app",
      model: "qwen2.5-coder:14b",
      runValidation: true,
      autoFix: true,
      noScaffold: false
    });
  });

  it("parses no-scaffold bootstrap arguments", () => {
    expect(
      parseBootstrapArgs([
        "--text",
        "Создай сервис книг",
        "--out",
        "app",
        "--model",
        "qwen2.5-coder:14b",
        "--no-scaffold"
      ])
    ).toMatchObject({
      noScaffold: true
    });
  });

  it("saves ProjectSpec from free-form requirements", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const outPath = join(rootDir, "SPEC.json");

    try {
      await saveRequirementsSpec({
        text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти, добавлять книги и менять статус прочтения.",
        outPath
      });

      const spec = JSON.parse(await readFile(outPath, "utf8"));

      expect(spec.projectName).toBe("book-tracker");
      expect(spec.entities[0].name).toBe("Book");
      expect(spec.features.map((feature: { id: string }) => feature.id)).toContain("registration");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("saves architecture plan from ProjectSpec", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "SPEC.json");
    const planPath = join(rootDir, "PLAN.json");

    try {
      await saveRequirementsSpec({
        text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти, добавлять книги, редактировать и удалять записи.",
        outPath: specPath
      });
      await saveArchitecturePlan({ specPath, outPath: planPath });

      const plan = JSON.parse(await readFile(planPath, "utf8"));

      expect(plan.stack.backend).toBe("go-chi");
      expect(plan.backendModules).toContain("books");
      expect(plan.endpoints.map((endpoint: { path: string }) => endpoint.path)).toContain("/api/books");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("generates backend files for a scaffolded project", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "SPEC.json");
    const outDir = join(rootDir, "book-tracker");

    try {
      await saveRequirementsSpec({
        text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти и добавлять книги.",
        outPath: specPath
      });
      await scaffoldFromSpecFile({ specPath, outDir });
      await saveArchitecturePlan({
        specPath: join(outDir, "SPEC.json"),
        outPath: join(outDir, "PLAN.json")
      });

      const files = await generateBackendFromProject({ projectDir: outDir });

      expect(files).toContain("backend/internal/http/generated_routes.go");
      await expect(readFile(join(outDir, "backend/internal/http/generated_routes.go"), "utf8")).resolves.toContain("/books");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("generates database files for a scaffolded project", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "SPEC.json");
    const outDir = join(rootDir, "book-tracker");

    try {
      await saveRequirementsSpec({
        text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти и добавлять книги.",
        outPath: specPath
      });
      await scaffoldFromSpecFile({ specPath, outDir });
      await saveArchitecturePlan({
        specPath: join(outDir, "SPEC.json"),
        outPath: join(outDir, "PLAN.json")
      });

      const files = await generateDatabaseFromProject({ projectDir: outDir });

      expect(files).toContain("backend/migrations/0001_generated_schema.sql");
      await expect(readFile(join(outDir, "backend/migrations/0001_generated_schema.sql"), "utf8")).resolves.toContain(
        "CREATE TABLE IF NOT EXISTS books"
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("generates frontend files for a scaffolded project", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "SPEC.json");
    const outDir = join(rootDir, "book-tracker");

    try {
      await saveRequirementsSpec({
        text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти и добавлять книги.",
        outPath: specPath
      });
      await scaffoldFromSpecFile({ specPath, outDir });
      await saveArchitecturePlan({
        specPath: join(outDir, "SPEC.json"),
        outPath: join(outDir, "PLAN.json")
      });

      const files = await generateFrontendFromProject({ projectDir: outDir });

      expect(files).toContain("frontend/src/api.ts");
      await expect(readFile(join(outDir, "frontend/src/main.tsx"), "utf8")).resolves.toContain("resourceDefinitions.map");
      await expect(readFile(join(outDir, "frontend/src/api.ts"), "utf8")).resolves.toContain("\"title\": \"Учет книг\"");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("scaffolds a project from a spec file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "book-tracker.spec.json");
    const outDir = join(rootDir, "book-tracker");

    try {
      await writeFile(
        specPath,
        JSON.stringify({
          projectName: "book-tracker",
          description: "Сервис учета книг",
          actors: [{ name: "user" }],
          features: [
            {
              id: "books-crud",
              title: "Управление книгами",
              description: "Создание, редактирование и удаление книг"
            }
          ],
          acceptanceCriteria: ["Пользователь видит только свои книги"]
        }),
        "utf8"
      );

      await expect(scaffoldFromSpecFile({ specPath, outDir })).resolves.toBe(outDir);
      await expect(readFile(join(outDir, "SPEC.json"), "utf8")).resolves.toContain("book-tracker");
      await expect(readFile(join(outDir, "README.md"), "utf8")).resolves.toContain("Шаблон");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("bootstraps a project through the LLM-first CLI flow with the stub model", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const outDir = join(rootDir, "agent-project");

    try {
      await expect(
        bootstrapProjectFromDescription(
          {
            text: "Создай сервис учета книг.",
            outDir,
            model: "qwen2.5-coder:14b",
            runValidation: false,
            autoFix: false,
            noScaffold: false
          },
          {
            runIntegration: false,
            runDocumentation: false
          },
          {
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
                        projectName: "agent-project",
                        description: "Agent project",
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
                        projectName: "agent-project",
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
                        validationCommands: ["npm run build"]
                      }, null, 2)}\n`
                    }
                  ],
                  rawOutput: "plan"
                };
              }

              if (input.role === "database") {
                return {
                  role: input.role,
                  summary: "Created DB",
                  changedFiles: ["backend/migrations/0001_generated_schema.sql"],
                  updatedFiles: [
                    {
                      path: "backend/migrations/0001_generated_schema.sql",
                      content: "CREATE TABLE IF NOT EXISTS books (id uuid primary key);\n"
                    }
                  ],
                  rawOutput: "database"
                };
              }

              if (input.role === "backend") {
                return {
                  role: input.role,
                  summary: "Created backend",
                  changedFiles: ["backend/internal/http/generated_routes.go"],
                  updatedFiles: [
                    {
                      path: "backend/internal/http/generated_routes.go",
                      content: "package http\n"
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
                      content: 'console.log("agent-project")\n'
                    }
                  ],
                  rawOutput: "frontend"
                };
              }

              throw new Error(`unexpected role: ${input.role}`);
            }
          }
        )
      ).resolves.toBe(outDir);

      await expect(readFile(join(outDir, "REQUEST.md"), "utf8")).resolves.toContain("учета книг");
      await expect(readFile(join(outDir, "SPEC.json"), "utf8")).resolves.toContain("agent-project");
      await expect(readFile(join(outDir, "AGENT_RUNS.jsonl"), "utf8")).resolves.toContain("\"role\":\"requirements\"");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates a scaffolded project with an injected lightweight check set", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const outDir = join(rootDir, "book-tracker");

    try {
      await writeFile(
        join(rootDir, "book-tracker.spec.json"),
        JSON.stringify({
          projectName: "book-tracker",
          description: "Сервис учета книг",
          actors: [{ name: "user" }],
          features: [
            {
              id: "books-crud",
              title: "Управление книгами",
              description: "Создание, редактирование и удаление книг"
            }
          ],
          acceptanceCriteria: ["Пользователь видит только свои книги"]
        }),
        "utf8"
      );

      await scaffoldFromSpecFile({
        specPath: join(rootDir, "book-tracker.spec.json"),
        outDir
      });

      await expect(
        validateProjectDirectory(
          { projectDir: outDir },
          [
            {
              id: "npm-version",
              title: "Проверка npm",
              command: "npm",
              args: ["--version"],
              cwd: ".",
              required: true
            }
          ]
        )
      ).resolves.toBe(true);
      await expect(readFile(join(outDir, "REVIEW.md"), "utf8")).resolves.toContain("Отчет проверки");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 120_000);
});
