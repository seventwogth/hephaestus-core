import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { analyzeRequirements } from "@hephaestus/agents";
import { FileProjectStateStore, Orchestrator } from "@hephaestus/orchestrator";

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageAction {
  type: "sendMessage";
  chatId: number;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

export interface AnswerCallbackQueryAction {
  type: "answerCallbackQuery";
  callbackQueryId: string;
  text?: string;
}

export type TelegramBotAction = SendMessageAction | AnswerCallbackQueryAction;

export interface TelegramSession {
  chatId: number;
  stage: "idle" | "awaiting_model" | "awaiting_description";
  selectedModelId?: string;
}

export interface TelegramSessionStore {
  read(chatId: number): Promise<TelegramSession | null>;
  write(session: TelegramSession): Promise<void>;
}

export class InMemoryTelegramSessionStore implements TelegramSessionStore {
  private readonly sessions = new Map<number, TelegramSession>();

  async read(chatId: number): Promise<TelegramSession | null> {
    return this.sessions.get(chatId) ?? null;
  }

  async write(session: TelegramSession): Promise<void> {
    this.sessions.set(session.chatId, session);
  }
}

export interface BootstrapProjectInput {
  chatId: number;
  description: string;
  selectedModel: ModelOption;
}

export interface BootstrappedProject {
  projectDir: string;
  projectName: string;
  selectedModel: ModelOption;
}

export interface ProjectBootstrapper {
  bootstrap(input: BootstrapProjectInput): Promise<BootstrappedProject>;
}

export interface LocalProjectBootstrapperOptions {
  outputRoot: string;
}

export class LocalProjectBootstrapper implements ProjectBootstrapper {
  constructor(private readonly options: LocalProjectBootstrapperOptions) {}

  async bootstrap(input: BootstrapProjectInput): Promise<BootstrappedProject> {
    const spec = analyzeRequirements({ text: input.description });
    const projectDir = resolve(
      this.options.outputRoot,
      `${spec.projectName}-${timestampLabel(new Date())}`
    );
    const orchestrator = new Orchestrator(new FileProjectStateStore());

    await mkdir(this.options.outputRoot, { recursive: true });
    await orchestrator.scaffoldProject(projectDir, spec);
    await orchestrator.planProject(projectDir);
    await orchestrator.generateDatabaseStage(projectDir);
    await orchestrator.generateBackendStage(projectDir);
    await orchestrator.generateFrontendStage(projectDir);
    await writeFile(
      join(projectDir, "MODEL_SELECTION.json"),
      `${JSON.stringify(
        {
          selectedModel: input.selectedModel,
          chatId: input.chatId,
          createdAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    return {
      projectDir,
      projectName: spec.projectName,
      selectedModel: input.selectedModel
    };
  }
}

export interface HephaestusTelegramBotOptions {
  models: ModelOption[];
  sessionStore: TelegramSessionStore;
  bootstrapper: ProjectBootstrapper;
}

export class HephaestusTelegramBot {
  constructor(private readonly options: HephaestusTelegramBotOptions) {
    if (options.models.length === 0) {
      throw new Error("At least one model must be configured");
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<TelegramBotAction[]> {
    if (update.message) {
      return this.handleMessage(update.message);
    }

    if (update.callback_query) {
      return this.handleCallbackQuery(update.callback_query);
    }

    return [];
  }

  private async handleMessage(message: TelegramMessage): Promise<TelegramBotAction[]> {
    const text = message.text?.trim();
    if (!text) {
      return [];
    }

    if (text === "/start") {
      await this.options.sessionStore.write({
        chatId: message.chat.id,
        stage: "idle"
      });
      return [
        sendMessage(
          message.chat.id,
          [
            "Hephaestus Telegram MVP.",
            "Команды:",
            "/new — начать новый проект",
            "/models — показать доступные модели"
          ].join("\n")
        )
      ];
    }

    if (text === "/models") {
      const session = await this.options.sessionStore.read(message.chat.id);
      return [sendMessage(message.chat.id, renderModels(this.options.models, session?.selectedModelId))];
    }

    if (text === "/new") {
      await this.options.sessionStore.write({
        chatId: message.chat.id,
        stage: "awaiting_model"
      });
      return [
        sendMessage(message.chat.id, "Выбери модель перед стартом проекта.", {
          inline_keyboard: this.options.models.map((model) => [
            {
              text: model.label,
              callback_data: `select_model:${model.id}`
            }
          ])
        })
      ];
    }

    const session = await this.options.sessionStore.read(message.chat.id);
    if (!session || session.stage !== "awaiting_description" || !session.selectedModelId) {
      return [sendMessage(message.chat.id, "Сначала вызови /new и выбери модель.")];
    }

    const selectedModel = requireModel(this.options.models, session.selectedModelId);
    const project = await this.options.bootstrapper.bootstrap({
      chatId: message.chat.id,
      description: text,
      selectedModel
    });

    await this.options.sessionStore.write({
      chatId: message.chat.id,
      stage: "idle",
      selectedModelId: selectedModel.id
    });

    return [
      sendMessage(
        message.chat.id,
        [
          `Проект создан: ${project.projectName}`,
          `Модель: ${project.selectedModel.label}`,
          `Директория: ${project.projectDir}`,
          "Сгенерированы SPEC, PLAN, миграции, backend и frontend."
        ].join("\n")
      )
    ];
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<TelegramBotAction[]> {
    const chatId = query.message?.chat.id;
    if (!chatId) {
      return [];
    }

    if (!query.data?.startsWith("select_model:")) {
      return [
        {
          type: "answerCallbackQuery",
          callbackQueryId: query.id,
          text: "Неизвестное действие"
        }
      ];
    }

    const modelId = query.data.slice("select_model:".length);
    const selectedModel = this.options.models.find((model) => model.id === modelId);
    if (!selectedModel) {
      return [
        {
          type: "answerCallbackQuery",
          callbackQueryId: query.id,
          text: "Модель не найдена"
        }
      ];
    }

    await this.options.sessionStore.write({
      chatId,
      stage: "awaiting_description",
      selectedModelId: selectedModel.id
    });

    return [
      {
        type: "answerCallbackQuery",
        callbackQueryId: query.id,
        text: `Выбрана модель: ${selectedModel.label}`
      },
      sendMessage(
        chatId,
        [
          `Модель выбрана: ${selectedModel.label}.`,
          "Теперь отправь текстовое описание проекта одним сообщением."
        ].join("\n")
      )
    ];
  }
}

export interface TelegramApi {
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  sendMessage(action: SendMessageAction): Promise<void>;
  answerCallbackQuery(action: AnswerCallbackQueryAction): Promise<void>;
}

export interface TelegramHttpApiOptions {
  token: string;
  apiBaseUrl?: string;
}

export class TelegramHttpApi implements TelegramApi {
  private readonly baseUrl: string;

  constructor(options: TelegramHttpApiOptions) {
    this.baseUrl = `${options.apiBaseUrl ?? "https://api.telegram.org"}/bot${options.token}`;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      })
    });
    const payload = await parseTelegramResponse(response);
    return payload.result as TelegramUpdate[];
  }

  async sendMessage(action: SendMessageAction): Promise<void> {
    await this.post("sendMessage", {
      chat_id: action.chatId,
      text: action.text,
      reply_markup: action.replyMarkup
    });
  }

  async answerCallbackQuery(action: AnswerCallbackQueryAction): Promise<void> {
    await this.post("answerCallbackQuery", {
      callback_query_id: action.callbackQueryId,
      text: action.text
    });
  }

  private async post(method: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    await parseTelegramResponse(response);
  }
}

export class TelegramPollingRuntime {
  constructor(
    private readonly api: TelegramApi,
    private readonly bot: HephaestusTelegramBot
  ) {}

  async runOnce(offset?: number): Promise<number | undefined> {
    const updates = await this.api.getUpdates(offset);
    let nextOffset = offset;

    for (const update of updates) {
      const actions = await this.bot.handleUpdate(update);
      for (const action of actions) {
        if (action.type === "sendMessage") {
          await this.api.sendMessage(action);
          continue;
        }

        await this.api.answerCallbackQuery(action);
      }

      nextOffset = update.update_id + 1;
    }

    return nextOffset;
  }
}

export function parseAvailableModels(rawValue: string | undefined): ModelOption[] {
  if (!rawValue) {
    return [
      { id: "stub", label: "Stub Model", description: "Локальный stub-провайдер" },
      { id: "fast", label: "Fast Model", description: "Быстрый профиль модели" },
      { id: "quality", label: "Quality Model", description: "Качественный профиль модели" }
    ];
  }

  return rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label, description] = entry.split("|").map((part) => part.trim());
      if (!id) {
        throw new Error(`Invalid model entry: ${entry}`);
      }

      return {
        id,
        label: label || id,
        description: description || undefined
      };
    });
}

export async function readSelectedModel(projectDir: string): Promise<ModelOption | null> {
  try {
    const raw = await readFile(join(projectDir, "MODEL_SELECTION.json"), "utf8");
    const parsed = JSON.parse(raw) as { selectedModel?: ModelOption };
    return parsed.selectedModel ?? null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function renderModels(models: ModelOption[], selectedModelId?: string): string {
  return [
    "Доступные модели:",
    ...models.map((model) => {
      const selected = model.id === selectedModelId ? " [выбрана]" : "";
      const description = model.description ? ` — ${model.description}` : "";
      return `- ${model.label} (${model.id})${selected}${description}`;
    })
  ].join("\n");
}

function requireModel(models: ModelOption[], modelId: string): ModelOption {
  const model = models.find((item) => item.id === modelId);
  if (!model) {
    throw new Error(`Unknown model: ${modelId}`);
  }

  return model;
}

function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): SendMessageAction {
  return {
    type: "sendMessage",
    chatId,
    text,
    replyMarkup
  };
}

async function parseTelegramResponse(response: Response): Promise<{ ok: boolean; result: unknown }> {
  const payload = (await response.json()) as { ok: boolean; result: unknown; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram API error: ${response.status}`);
  }

  return payload;
}

function timestampLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}
