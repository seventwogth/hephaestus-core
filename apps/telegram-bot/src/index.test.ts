import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createModelProviderForOption,
  HephaestusTelegramBot,
  InMemoryTelegramSessionStore,
  LocalProjectBootstrapper,
  parseAvailableModels,
  readSelectedModel,
  type ProjectBootstrapper
} from "./index.js";

describe("parseAvailableModels", () => {
  it("parses configured model list", () => {
    expect(parseAvailableModels("stub|Stub|Локально,quality|Quality|Точно")).toEqual([
      { id: "stub", label: "Stub", description: "Локально" },
      { id: "quality", label: "Quality", description: "Точно" }
    ]);
  });

  it("returns default models when env is empty", () => {
    expect(parseAvailableModels(undefined).map((model) => model.id)).toEqual([
      "stub",
      "qwen2.5-coder:7b",
      "qwen2.5-coder:14b"
    ]);
  });
});

describe("createModelProviderForOption", () => {
  it("creates a stub provider for the stub model", async () => {
    const provider = createModelProviderForOption({ id: "stub", label: "Stub" });
    const result = await provider.generate({
      role: "architect",
      instruction: "Create PLAN.json",
      files: [],
      writableFiles: ["PLAN.json"]
    });

    expect(result.summary).toContain("architect");
  });

  it("maps model ids to explicit Ollama runtime entries", async () => {
    const provider = createModelProviderForOption(
      { id: "quality", label: "Quality" },
      {
        HEPHAESTUS_MODEL_RUNTIME_MAP: "quality=ollama:qwen2.5-coder:32b"
      }
    );

    expect(provider.constructor.name).toBe("OllamaModelProvider");
  });
});

describe("HephaestusTelegramBot", () => {
  it("requests model selection before project description", async () => {
    const sessionStore = new InMemoryTelegramSessionStore();
    const bootstrapper: ProjectBootstrapper = {
      async bootstrap() {
        throw new Error("should not be called");
      }
    };
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("stub|Stub,quality|Quality"),
      sessionStore,
      bootstrapper
    });

    const actions = await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 100 },
        text: "/new"
      }
    });

    expect(actions[0]).toMatchObject({
      type: "sendMessage",
      chatId: 100,
      text: "Выбери модель перед стартом проекта."
    });
  });

  it("stores selected model and bootstraps a project from next message", async () => {
    const sessionStore = new InMemoryTelegramSessionStore();
    let selectedModelId: string | null = null;
    const bootstrapper: ProjectBootstrapper = {
      async bootstrap(input) {
        selectedModelId = input.selectedModel.id;
        return {
          projectDir: "/tmp/project",
          projectName: "book-tracker",
          selectedModel: input.selectedModel
        };
      }
    };
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("stub|Stub,quality|Quality"),
      sessionStore,
      bootstrapper
    });

    const callbackActions = await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        data: "select_model:quality",
        message: {
          message_id: 10,
          chat: { id: 100 },
          text: "/new"
        }
      }
    });
    const messageActions = await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 100 },
        text: "Создай сервис учета книг"
      }
    });

    expect(callbackActions[0]).toMatchObject({
      type: "answerCallbackQuery",
      callbackQueryId: "cb-1"
    });
    expect(selectedModelId).toBe("quality");
    expect(messageActions[0]).toMatchObject({
      type: "sendMessage",
      chatId: 100
    });
    expect(messageActions[0]?.text).toContain("Модель: Quality");
  });
});

describe("LocalProjectBootstrapper", () => {
  it("creates a project and stores selected model metadata", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "hephaestus-telegram-"));

    try {
      const bootstrapper = new LocalProjectBootstrapper({ outputRoot });
      const project = await bootstrapper.bootstrap({
        chatId: 77,
        description: "Создай сервис учета книг. Пользователь должен добавлять книги и менять статус.",
        selectedModel: { id: "quality", label: "Quality" }
      });
      const modelFile = await readFile(join(project.projectDir, "MODEL_SELECTION.json"), "utf8");
      const selectedModel = await readSelectedModel(project.projectDir);

      expect(project.projectName).toBe("book-tracker");
      expect(modelFile).toContain("quality");
      expect(selectedModel?.id).toBe("quality");
      await expect(readFile(join(project.projectDir, "PLAN.json"), "utf8")).resolves.toContain("/api/books");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs provider-backed bootstrap when model provider factory is configured", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "hephaestus-telegram-"));

    try {
      const bootstrapper = new LocalProjectBootstrapper({
        outputRoot,
        bootstrapOptions: {
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
        },
        createModelProvider() {
          return {
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
                        projectName: "agent-books",
                        description: "Agent generated project",
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
                        projectName: "agent-books",
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
                      content: 'console.log("agent-books")\n'
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
                      content: "services:\n  api:\n    image: agent-books\n"
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
                      content: "# agent-books\n\nRun with docker compose.\n"
                    }
                  ],
                  rawOutput: "documentation"
                };
              }

              throw new Error(`unexpected role: ${input.role}`);
            }
          };
        }
      });

      const project = await bootstrapper.bootstrap({
        chatId: 77,
        description: "Создай сервис учета книг через LLM pipeline.",
        selectedModel: { id: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B" }
      });
      const modelFile = await readFile(join(project.projectDir, "MODEL_SELECTION.json"), "utf8");

      expect(project.projectName).toBe("agent-books");
      expect(modelFile).toContain("\"provider\": \"ollama\"");
      await expect(readFile(join(project.projectDir, "AGENT_RUNS.jsonl"), "utf8")).resolves.toContain("\"role\":\"requirements\"");
      await expect(readFile(join(project.projectDir, "frontend/src/main.tsx"), "utf8")).resolves.toContain("agent-books");
      await expect(readFile(join(project.projectDir, "README.md"), "utf8")).resolves.toContain("Run with docker compose");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
