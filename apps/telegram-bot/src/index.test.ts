import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
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
    expect(parseAvailableModels(undefined)).toHaveLength(3);
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
});
