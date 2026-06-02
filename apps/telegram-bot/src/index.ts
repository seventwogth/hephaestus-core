import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { analyzeRequirements } from "@hephaestus/agents";
import {
  createLocalModelProvider,
  type ModelProvider,
  resolveLocalModelRuntime
} from "@hephaestus/hermes-adapter";
import {
  type BootstrapProjectOptions,
  FileProjectStateStore,
  Orchestrator
} from "@hephaestus/orchestrator";

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

export class FileTelegramSessionStore implements TelegramSessionStore {
  constructor(private readonly filePath: string) {}

  async read(chatId: number): Promise<TelegramSession | null> {
    const sessions = await this.readAll();
    return sessions[String(chatId)] ?? null;
  }

  async write(session: TelegramSession): Promise<void> {
    const sessions = await this.readAll();
    sessions[String(session.chatId)] = session;
    await writeJsonFile(this.filePath, sessions);
  }

  private async readAll(): Promise<Record<string, TelegramSession>> {
    return readJsonFile(this.filePath, {});
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

export type ProjectJobStatus = "pending" | "running" | "completed" | "failed";

export interface ProjectJob {
  id: string;
  chatId: number;
  description: string;
  selectedModel: ModelOption;
  status: ProjectJobStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  projectDir?: string;
  projectName?: string;
  error?: string;
}

export interface ProjectJobQueue {
  enqueue(input: BootstrapProjectInput): Promise<ProjectJob>;
  listByChat(chatId: number): Promise<ProjectJob[]>;
  claimNext(): Promise<ProjectJob | null>;
  complete(jobId: string, project: BootstrappedProject): Promise<ProjectJob>;
  fail(jobId: string, error: string): Promise<ProjectJob>;
}

export class InMemoryProjectJobQueue implements ProjectJobQueue {
  private readonly jobs: ProjectJob[] = [];

  async enqueue(input: BootstrapProjectInput): Promise<ProjectJob> {
    const job = createProjectJob(input);
    this.jobs.push(job);
    return job;
  }

  async listByChat(chatId: number): Promise<ProjectJob[]> {
    return this.jobs
      .filter((job) => job.chatId === chatId)
      .slice()
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }

  async claimNext(): Promise<ProjectJob | null> {
    const index = this.jobs.findIndex((job) => job.status === "pending");
    if (index === -1) {
      return null;
    }

    const claimed = {
      ...this.jobs[index],
      status: "running" as const,
      startedAt: new Date().toISOString(),
      error: undefined
    };
    this.jobs[index] = claimed;
    return claimed;
  }

  async complete(jobId: string, project: BootstrappedProject): Promise<ProjectJob> {
    return this.update(jobId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      projectDir: project.projectDir,
      projectName: project.projectName,
      error: undefined
    });
  }

  async fail(jobId: string, error: string): Promise<ProjectJob> {
    return this.update(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error
    });
  }

  private async update(jobId: string, patch: Partial<ProjectJob>): Promise<ProjectJob> {
    const index = this.jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Unknown project job: ${jobId}`);
    }

    const updated = { ...this.jobs[index], ...patch };
    this.jobs[index] = updated;
    return updated;
  }
}

export class FileProjectJobQueue implements ProjectJobQueue {
  constructor(private readonly filePath: string) {}

  async enqueue(input: BootstrapProjectInput): Promise<ProjectJob> {
    const job = createProjectJob(input);
    const jobs = await this.readAll();
    jobs.push(job);
    await this.writeAll(jobs);
    return job;
  }

  async listByChat(chatId: number): Promise<ProjectJob[]> {
    const jobs = await this.readAll();
    return jobs
      .filter((job) => job.chatId === chatId)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }

  async claimNext(): Promise<ProjectJob | null> {
    const jobs = await this.readAll();
    const index = jobs.findIndex((job) => job.status === "pending");
    if (index === -1) {
      return null;
    }

    const claimed = {
      ...jobs[index],
      status: "running" as const,
      startedAt: new Date().toISOString(),
      error: undefined
    };
    jobs[index] = claimed;
    await this.writeAll(jobs);
    return claimed;
  }

  async complete(jobId: string, project: BootstrappedProject): Promise<ProjectJob> {
    return this.update(jobId, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      projectDir: project.projectDir,
      projectName: project.projectName,
      error: undefined
    });
  }

  async fail(jobId: string, error: string): Promise<ProjectJob> {
    return this.update(jobId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error
    });
  }

  private async update(jobId: string, patch: Partial<ProjectJob>): Promise<ProjectJob> {
    const jobs = await this.readAll();
    const index = jobs.findIndex((job) => job.id === jobId);
    if (index === -1) {
      throw new Error(`Unknown project job: ${jobId}`);
    }

    const updated = { ...jobs[index], ...patch };
    jobs[index] = updated;
    await this.writeAll(jobs);
    return updated;
  }

  private async readAll(): Promise<ProjectJob[]> {
    return readJsonFile(this.filePath, [] as ProjectJob[]);
  }

  private async writeAll(jobs: ProjectJob[]): Promise<void> {
    await writeJsonFile(this.filePath, jobs);
  }
}

export interface PollingOffsetStore {
  read(): Promise<number | undefined>;
  write(offset: number): Promise<void>;
}

export class InMemoryPollingOffsetStore implements PollingOffsetStore {
  private offset: number | undefined;

  async read(): Promise<number | undefined> {
    return this.offset;
  }

  async write(offset: number): Promise<void> {
    this.offset = offset;
  }
}

export class FilePollingOffsetStore implements PollingOffsetStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<number | undefined> {
    const payload = await readJsonFile<{ offset?: number }>(this.filePath, {});
    return payload.offset;
  }

  async write(offset: number): Promise<void> {
    await writeJsonFile(this.filePath, { offset });
  }
}

export interface LocalProjectBootstrapperOptions {
  outputRoot: string;
  createModelProvider?: (selectedModel: ModelOption) => ModelProvider;
  bootstrapOptions?: BootstrapProjectOptions;
}

export class LocalProjectBootstrapper implements ProjectBootstrapper {
  constructor(private readonly options: LocalProjectBootstrapperOptions) {}

  async bootstrap(input: BootstrapProjectInput): Promise<BootstrappedProject> {
    await mkdir(this.options.outputRoot, { recursive: true });
    const provider = this.options.createModelProvider?.(input.selectedModel);
    const speculativeSpec = analyzeRequirements({ text: input.description });
    const projectDir = resolve(
      this.options.outputRoot,
      `${speculativeSpec.projectName}-${timestampLabel(new Date())}`
    );
    const orchestrator = new Orchestrator(new FileProjectStateStore(), provider);
    const result = provider
      ? await orchestrator.bootstrapProjectFromPrompt(
          projectDir,
          input.description,
          this.options.bootstrapOptions
        )
      : await bootstrapDeterministicProject(orchestrator, projectDir, input.description);
    const spec = "spec" in result ? result.spec : result;

    await writeFile(
      join(projectDir, "MODEL_SELECTION.json"),
      `${JSON.stringify(
        {
          selectedModel: input.selectedModel,
          chatId: input.chatId,
          runtime: resolveModelRuntime(input.selectedModel),
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
  jobQueue: ProjectJobQueue;
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
            "Hephaestus Telegram control bot.",
            "Команды:",
            "/new — начать новый проект",
            "/models — показать доступные модели",
            "/status — показать последние задания"
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

    if (text === "/status") {
      const jobs = await this.options.jobQueue.listByChat(message.chat.id);
      return [sendMessage(message.chat.id, renderJobStatus(jobs))];
    }

    const session = await this.options.sessionStore.read(message.chat.id);
    if (!session || session.stage !== "awaiting_description" || !session.selectedModelId) {
      return [sendMessage(message.chat.id, "Сначала вызови /new и выбери модель.")];
    }

    const selectedModel = requireModel(this.options.models, session.selectedModelId);
    const job = await this.options.jobQueue.enqueue({
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
          `Проект поставлен в очередь: ${job.id}`,
          `Модель: ${selectedModel.label}`,
          "Когда генерация завершится, бот пришлет отдельное сообщение со статусом и директорией проекта."
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
    private readonly bot: HephaestusTelegramBot,
    private readonly jobRunner?: ProjectJobRunner,
    private readonly offsetStore: PollingOffsetStore = new InMemoryPollingOffsetStore()
  ) {}

  async runOnce(offset?: number): Promise<number | undefined> {
    const currentOffset = offset ?? await this.offsetStore.read();
    const updates = await this.api.getUpdates(currentOffset);
    let nextOffset = currentOffset;

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
      await this.offsetStore.write(nextOffset);
    }

    if (this.jobRunner) {
      await this.jobRunner.runNext();
    }

    return nextOffset;
  }
}

export class ProjectJobRunner {
  constructor(
    private readonly queue: ProjectJobQueue,
    private readonly bootstrapper: ProjectBootstrapper,
    private readonly api: TelegramApi
  ) {}

  async runNext(): Promise<ProjectJob | null> {
    const job = await this.queue.claimNext();
    if (!job) {
      return null;
    }

    await this.api.sendMessage(
      sendMessage(
        job.chatId,
        [`Запущена генерация проекта: ${job.id}`, `Модель: ${job.selectedModel.label}`].join("\n")
      )
    );

    try {
      const project = await this.bootstrapper.bootstrap({
        chatId: job.chatId,
        description: job.description,
        selectedModel: job.selectedModel
      });
      const completedJob = await this.queue.complete(job.id, project);

      await this.api.sendMessage(
        sendMessage(
          job.chatId,
          [
            `Проект создан: ${project.projectName}`,
            `Задание: ${completedJob.id}`,
            `Модель: ${project.selectedModel.label}`,
            `Директория: ${project.projectDir}`
          ].join("\n")
        )
      );

      return completedJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedJob = await this.queue.fail(job.id, message);

      await this.api.sendMessage(
        sendMessage(
          job.chatId,
          [`Генерация проекта завершилась ошибкой: ${failedJob.id}`, message].join("\n")
        )
      );

      return failedJob;
    }
  }
}

export function parseAvailableModels(rawValue: string | undefined): ModelOption[] {
  if (!rawValue) {
    return [
      { id: "stub", label: "Stub Model", description: "Локальный stub-провайдер" },
      { id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B", description: "Локальная Ollama-модель" },
      { id: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", description: "Локальная Ollama-модель" }
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

export function createModelProviderForOption(
  model: ModelOption,
  env: Record<string, string | undefined> = process.env
): ModelProvider {
  return createLocalModelProvider(model.id, env);
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

function renderJobStatus(jobs: ProjectJob[]): string {
  if (jobs.length === 0) {
    return "Заданий пока нет.";
  }

  return [
    "Последние задания:",
    ...jobs.slice(0, 5).map((job) => {
      const details = job.projectDir ? ` — ${job.projectDir}` : job.error ? ` — ${job.error}` : "";
      return `- ${job.id}: ${translateJobStatus(job.status)} (${job.selectedModel.label})${details}`;
    })
  ].join("\n");
}

function resolveModelRuntime(
  model: ModelOption,
  env: Record<string, string | undefined> = process.env
): { provider: "stub" | "ollama"; target: string } {
  return resolveLocalModelRuntime(model.id, env);
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

function createProjectJob(input: BootstrapProjectInput): ProjectJob {
  const now = new Date().toISOString();
  return {
    id: `job-${now.replaceAll(/[:.]/g, "").replace("T", "-").replace("Z", "")}`,
    chatId: input.chatId,
    description: input.description,
    selectedModel: input.selectedModel,
    status: "pending",
    queuedAt: now
  };
}

function translateJobStatus(status: ProjectJobStatus): string {
  switch (status) {
    case "pending":
      return "в очереди";
    case "running":
      return "в работе";
    case "completed":
      return "завершено";
    case "failed":
      return "ошибка";
  }
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

async function bootstrapDeterministicProject(
  orchestrator: Orchestrator,
  projectDir: string,
  description: string
): Promise<ReturnType<typeof analyzeRequirements>> {
  const spec = analyzeRequirements({ text: description });
  await orchestrator.scaffoldProject(projectDir, spec);
  await orchestrator.planProject(projectDir);
  await orchestrator.generateDatabaseStage(projectDir);
  await orchestrator.generateBackendStage(projectDir);
  await orchestrator.generateFrontendStage(projectDir);
  return spec;
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
