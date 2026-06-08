import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  idempotencyKey?: string;
}

export interface BootstrappedProject {
  projectDir: string;
  projectName: string;
  selectedModel: ModelOption;
}

export interface ProjectBootstrapper {
  bootstrap(input: BootstrapProjectInput): Promise<BootstrappedProject>;
}

export type ProjectJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export interface ProjectJob {
  id: string;
  chatId: number;
  description: string;
  selectedModel: ModelOption;
  status: ProjectJobStatus;
  queuedAt: string;
  attempt: number;
  maxAttempts: number;
  rootJobId: string;
  startedAt?: string;
  finishedAt?: string;
  leaseExpiresAt?: string;
  cancelledAt?: string;
  deadLetterAt?: string;
  retryOfJobId?: string;
  idempotencyKey?: string;
  projectDir?: string;
  projectName?: string;
  error?: string;
}

export interface ProjectJobQueue {
  enqueue(input: BootstrapProjectInput): Promise<ProjectJob>;
  listByChat(chatId: number): Promise<ProjectJob[]>;
  getByChat(chatId: number, jobId: string): Promise<ProjectJob | null>;
  claimNext(): Promise<ProjectJob | null>;
  renew?(jobId: string): Promise<ProjectJob>;
  retry(jobId: string, chatId: number): Promise<ProjectJob>;
  cancel(jobId: string, chatId: number): Promise<ProjectJob>;
  complete(jobId: string, project: BootstrappedProject): Promise<ProjectJob>;
  fail(jobId: string, error: string): Promise<ProjectJob>;
}

export interface ProjectJobStore {
  insert(job: ProjectJob): Promise<ProjectJob>;
  listByChat(chatId: number): Promise<ProjectJob[]>;
  getByChat(chatId: number, jobId: string): Promise<ProjectJob | null>;
  claimNext(now: Date, leaseMs: number): Promise<ProjectJob | null>;
  renew(jobId: string, leaseExpiresAt: string): Promise<ProjectJob>;
  retry(jobId: string, chatId: number, createRetryJob: (job: ProjectJob) => ProjectJob): Promise<ProjectJob>;
  cancel(jobId: string, chatId: number, finishedAt: string): Promise<ProjectJob>;
  update(jobId: string, patch: Partial<ProjectJob>): Promise<ProjectJob>;
}

export class StoredProjectJobQueue implements ProjectJobQueue {
  private readonly jobLeaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: ProjectJobStore,
    options: {
      jobLeaseMs?: number;
      maxAttempts?: number;
      now?: () => Date;
    } = {}
  ) {
    this.jobLeaseMs = options.jobLeaseMs ?? 600_000;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: BootstrapProjectInput): Promise<ProjectJob> {
    return this.store.insert(createProjectJob(input, this.now(), {
      maxAttempts: this.maxAttempts
    }));
  }

  async listByChat(chatId: number): Promise<ProjectJob[]> {
    return this.store.listByChat(chatId);
  }

  async getByChat(chatId: number, jobId: string): Promise<ProjectJob | null> {
    return this.store.getByChat(chatId, jobId);
  }

  async claimNext(): Promise<ProjectJob | null> {
    return this.store.claimNext(this.now(), this.jobLeaseMs);
  }

  async renew(jobId: string): Promise<ProjectJob> {
    return this.store.renew(jobId, leaseDeadline(this.now(), this.jobLeaseMs).toISOString());
  }

  async complete(jobId: string, project: BootstrappedProject): Promise<ProjectJob> {
    return this.store.update(jobId, {
      status: "completed",
      finishedAt: this.now().toISOString(),
      leaseExpiresAt: undefined,
      projectDir: project.projectDir,
      projectName: project.projectName,
      error: undefined
    });
  }

  async fail(jobId: string, error: string): Promise<ProjectJob> {
    return this.store.update(jobId, {
      status: "failed",
      finishedAt: this.now().toISOString(),
      leaseExpiresAt: undefined,
      error
    });
  }

  async retry(jobId: string, chatId: number): Promise<ProjectJob> {
    return this.store.retry(jobId, chatId, (job) => createProjectJob(
      {
        chatId,
        description: job.description,
        selectedModel: job.selectedModel
      },
      this.now(),
      {
        attempt: job.attempt + 1,
        maxAttempts: job.maxAttempts,
        rootJobId: job.rootJobId,
        retryOfJobId: job.id
      }
    ));
  }

  async cancel(jobId: string, chatId: number): Promise<ProjectJob> {
    return this.store.cancel(jobId, chatId, this.now().toISOString());
  }
}

type ProjectJobMutation<T> = (jobs: ProjectJob[]) => Promise<{
  jobs: ProjectJob[];
  result: T;
}>;

abstract class ArrayProjectJobStore implements ProjectJobStore {
  protected abstract snapshot(): Promise<ProjectJob[]>;
  protected abstract mutate<T>(operation: ProjectJobMutation<T>): Promise<T>;

  async insert(job: ProjectJob): Promise<ProjectJob> {
    return this.mutate(async (jobs) => {
      const existingJob = findIdempotentJob(jobs, job.idempotencyKey);
      if (existingJob) {
        return { jobs, result: existingJob };
      }

      return {
        jobs: [...jobs, job],
        result: job
      };
    });
  }

  async listByChat(chatId: number): Promise<ProjectJob[]> {
    return (await this.snapshot())
      .filter((job) => job.chatId === chatId)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  }

  async getByChat(chatId: number, jobId: string): Promise<ProjectJob | null> {
    const jobs = await this.snapshot();
    return jobs.find((job) => job.chatId === chatId && job.id === jobId) ?? null;
  }

  async claimNext(now: Date, leaseMs: number): Promise<ProjectJob | null> {
    return this.mutate(async (storedJobs) => {
      const jobs = recoverExpiredRunningJobs(storedJobs, now);
      const index = jobs.findIndex((job) => job.status === "pending");
      if (index === -1) {
        return { jobs, result: null };
      }

      const claimed = {
        ...jobs[index],
        status: "running" as const,
        startedAt: now.toISOString(),
        leaseExpiresAt: leaseDeadline(now, leaseMs).toISOString(),
        deadLetterAt: undefined,
        error: undefined
      };
      jobs[index] = claimed;

      return { jobs, result: claimed };
    });
  }

  async renew(jobId: string, leaseExpiresAt: string): Promise<ProjectJob> {
    return this.mutate(async (jobs) => {
      const index = findJobIndex(jobs, jobId);
      const current = jobs[index];
      if (current.status !== "running") {
        return { jobs, result: current };
      }

      const updated = {
        ...current,
        leaseExpiresAt
      };
      jobs[index] = updated;
      return { jobs, result: updated };
    });
  }

  async retry(jobId: string, chatId: number, createRetryJob: (job: ProjectJob) => ProjectJob): Promise<ProjectJob> {
    return this.mutate(async (jobs) => {
      const job = jobs.find((item) => item.chatId === chatId && item.id === jobId);
      if (!job) {
        throw new Error(`Unknown project job: ${jobId}`);
      }

      if (!isTerminalJobStatus(job.status)) {
        throw new Error(`Job is not finished yet: ${jobId}`);
      }

      const retriedJob = createRetryJob(job);
      return {
        jobs: [...jobs, retriedJob],
        result: retriedJob
      };
    });
  }

  async cancel(jobId: string, chatId: number, finishedAt: string): Promise<ProjectJob> {
    return this.mutate(async (jobs) => {
      const index = jobs.findIndex((job) => job.chatId === chatId && job.id === jobId);
      if (index === -1) {
        throw new Error(`Unknown project job: ${jobId}`);
      }

      const current = jobs[index];
      if (isTerminalJobStatus(current.status)) {
        return { jobs, result: current };
      }

      const cancelled = {
        ...current,
        status: "cancelled" as const,
        finishedAt,
        leaseExpiresAt: undefined,
        cancelledAt: finishedAt,
        error: undefined
      };
      jobs[index] = cancelled;
      return { jobs, result: cancelled };
    });
  }

  async update(jobId: string, patch: Partial<ProjectJob>): Promise<ProjectJob> {
    return this.mutate(async (jobs) => {
      const index = findJobIndex(jobs, jobId);

      if (isProtectedTerminalStatus(jobs[index].status) && isTerminalPatch(patch)) {
        return { jobs, result: jobs[index] };
      }

      const updated = { ...jobs[index], ...patch };
      jobs[index] = updated;
      return { jobs, result: updated };
    });
  }
}

export class InMemoryProjectJobStore extends ArrayProjectJobStore {
  private jobs: ProjectJob[] = [];

  protected async snapshot(): Promise<ProjectJob[]> {
    return this.jobs.map(normalizeProjectJob);
  }

  protected async mutate<T>(operation: ProjectJobMutation<T>): Promise<T> {
    const output = await operation(this.jobs.map(normalizeProjectJob));
    this.jobs = output.jobs;
    return output.result;
  }
}

export class InMemoryProjectJobQueue extends StoredProjectJobQueue {
  constructor(options: { jobLeaseMs?: number; maxAttempts?: number; now?: () => Date } = {}) {
    super(new InMemoryProjectJobStore(), options);
  }
}

export class FileProjectJobStore extends ArrayProjectJobStore {
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly filePath: string,
    options: {
      lockTimeoutMs?: number;
      lockStaleMs?: number;
      now?: () => Date;
    } = {}
  ) {
    super();
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockStaleMs = options.lockStaleMs ?? 300_000;
    this.now = options.now ?? (() => new Date());
  }

  protected async snapshot(): Promise<ProjectJob[]> {
    return this.readAll();
  }

  protected async mutate<T>(operation: ProjectJobMutation<T>): Promise<T> {
    return this.withLock(async () => {
      const jobs = await this.readAll();
      const output = await operation(jobs);
      await this.writeAll(output.jobs);
      return output.result;
    });
  }

  private async readAll(): Promise<ProjectJob[]> {
    return (await readJsonFile(this.filePath, [] as ProjectJob[])).map(normalizeProjectJob);
  }

  private async writeAll(jobs: ProjectJob[]): Promise<void> {
    await writeJsonFile(this.filePath, jobs);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const release = await acquireFileLock(`${this.filePath}.lock`, {
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.lockStaleMs,
      now: this.now
    });

    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

export class FileProjectJobQueue extends StoredProjectJobQueue {
  constructor(
    filePath: string,
    options: {
      lockTimeoutMs?: number;
      lockStaleMs?: number;
      jobLeaseMs?: number;
      maxAttempts?: number;
      now?: () => Date;
    } = {}
  ) {
    super(
      new FileProjectJobStore(filePath, {
        lockTimeoutMs: options.lockTimeoutMs,
        lockStaleMs: options.lockStaleMs,
        now: options.now
      }),
      {
        jobLeaseMs: options.jobLeaseMs,
        maxAttempts: options.maxAttempts,
        now: options.now
      }
    );
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
            "/status — показать последние задания",
            "/job <id> — детали задания",
            "/last — путь к последнему готовому проекту",
            "/cancel <id> — отменить задание",
            "/retry <id> — повторить завершенное задание"
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

    if (text === "/last") {
      const jobs = await this.options.jobQueue.listByChat(message.chat.id);
      return [sendMessage(message.chat.id, renderLastProject(jobs))];
    }

    const jobCommand = parseJobCommand(text);
    if (jobCommand) {
      if (jobCommand.command === "/job") {
        const job = await this.options.jobQueue.getByChat(message.chat.id, jobCommand.jobId);
        return [sendMessage(message.chat.id, job ? renderJobDetails(job) : `Задание не найдено: ${jobCommand.jobId}`)];
      }

      if (jobCommand.command === "/cancel") {
        try {
          const job = await this.options.jobQueue.cancel(jobCommand.jobId, message.chat.id);
          return [sendMessage(message.chat.id, renderCancelResult(job))];
        } catch (error) {
          return [sendMessage(message.chat.id, formatCommandError(error))];
        }
      }

      try {
        const job = await this.options.jobQueue.retry(jobCommand.jobId, message.chat.id);
        return [
          sendMessage(
            message.chat.id,
            [`Повтор поставлен в очередь: ${job.id}`, `Модель: ${job.selectedModel.label}`].join("\n")
          )
        ];
      } catch (error) {
        return [sendMessage(message.chat.id, formatCommandError(error))];
      }
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

export interface RuntimeLoopOptions {
  errorDelayMs?: number;
  logger?: Pick<Console, "error">;
  sleep?: (timeoutMs: number) => Promise<void>;
  shouldStop?: () => boolean;
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

  async runForever(initialOffset?: number, options: RuntimeLoopOptions = {}): Promise<void> {
    let offset = initialOffset;
    while (!options.shouldStop?.()) {
      try {
        offset = await this.runOnce(offset);
      } catch (error) {
        logRuntimeError(options.logger, "Telegram polling iteration failed", error);
        await delay(options.errorDelayMs ?? 3_000, options.sleep);
      }
    }
  }
}

export class ProjectJobRunner {
  constructor(
    private readonly queue: ProjectJobQueue,
    private readonly bootstrapper: ProjectBootstrapper,
    private readonly api: TelegramApi,
    private readonly options: { leaseRenewIntervalMs?: number } = {}
  ) {}

  async runNext(): Promise<ProjectJob | null> {
    const job = await this.queue.claimNext();
    if (!job) {
      return null;
    }

    const stopRenewal = startJobLeaseRenewal(
      this.queue,
      job.id,
      this.options.leaseRenewIntervalMs ?? 60_000
    );

    try {
      await this.api.sendMessage(
        sendMessage(
          job.chatId,
          [`Запущена генерация проекта: ${job.id}`, `Модель: ${job.selectedModel.label}`].join("\n")
        )
      );

      const project = await this.bootstrapper.bootstrap({
        chatId: job.chatId,
        description: job.description,
        selectedModel: job.selectedModel
      });
      const completedJob = await this.queue.complete(job.id, project);
      if (completedJob.status === "cancelled") {
        await this.api.sendMessage(
          sendMessage(
            job.chatId,
            [
              `Задание отменено: ${completedJob.id}`,
              "Генерация уже могла завершиться на диске, но статус задания сохранен как отмененный."
            ].join("\n")
          )
        );
        return completedJob;
      }

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
      if (failedJob.status === "cancelled") {
        await this.api.sendMessage(
          sendMessage(
            job.chatId,
            [
              `Задание отменено: ${failedJob.id}`,
              "Генерация остановилась с ошибкой после отмены, статус задания сохранен как отмененный."
            ].join("\n")
          )
        );
        return failedJob;
      }

      await this.api.sendMessage(
        sendMessage(
          job.chatId,
          [`Генерация проекта завершилась ошибкой: ${failedJob.id}`, message].join("\n")
        )
      );

      return failedJob;
    } finally {
      stopRenewal();
    }
  }
}

export class TelegramWorkerRuntime {
  constructor(
    private readonly runner: ProjectJobRunner,
    private readonly idleDelayMs = 3_000
  ) {}

  async runOnce(): Promise<ProjectJob | null> {
    return this.runner.runNext();
  }

  async runForever(options: RuntimeLoopOptions = {}): Promise<void> {
    while (!options.shouldStop?.()) {
      try {
        const job = await this.runOnce();
        if (job) {
          continue;
        }

        await delay(this.idleDelayMs, options.sleep);
      } catch (error) {
        logRuntimeError(options.logger, "Telegram worker iteration failed", error);
        await delay(options.errorDelayMs ?? this.idleDelayMs, options.sleep);
      }
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
    }),
    "",
    "Команды: /job <id>, /last, /cancel <id>, /retry <id>"
  ].join("\n");
}

function renderJobDetails(job: ProjectJob): string {
  return [
    `Задание: ${job.id}`,
    `Статус: ${translateJobStatus(job.status)}`,
    `Модель: ${job.selectedModel.label}`,
    `Попытка: ${job.attempt}/${job.maxAttempts}`,
    `Создано: ${job.queuedAt}`,
    job.rootJobId !== job.id ? `Корневое задание: ${job.rootJobId}` : null,
    job.retryOfJobId ? `Повтор задания: ${job.retryOfJobId}` : null,
    job.idempotencyKey ? `Idempotency key: ${job.idempotencyKey}` : null,
    job.startedAt ? `Запущено: ${job.startedAt}` : null,
    job.finishedAt ? `Завершено: ${job.finishedAt}` : null,
    job.cancelledAt ? `Отменено: ${job.cancelledAt}` : null,
    job.deadLetterAt ? `Dead-letter: ${job.deadLetterAt}` : null,
    job.projectName ? `Проект: ${job.projectName}` : null,
    job.projectDir ? `Директория: ${job.projectDir}` : null,
    job.error ? `Ошибка: ${job.error}` : null
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function renderLastProject(jobs: ProjectJob[]): string {
  const completedJob = jobs.find((job) => job.status === "completed" && job.projectDir);
  if (!completedJob) {
    return "Готовых проектов пока нет.";
  }

  return [
    `Последний готовый проект: ${completedJob.projectName ?? completedJob.id}`,
    `Задание: ${completedJob.id}`,
    `Модель: ${completedJob.selectedModel.label}`,
    `Директория: ${completedJob.projectDir}`
  ].join("\n");
}

function renderCancelResult(job: ProjectJob): string {
  if (job.status === "cancelled") {
    return [
      `Задание отменено: ${job.id}`,
      job.startedAt
        ? "Если генерация уже выполнялась, процесс может дописать файлы на диск, но статус задания останется отмененным."
        : null
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  return `Задание уже завершено: ${job.id} (${translateJobStatus(job.status)})`;
}

function parseJobCommand(text: string): { command: "/job" | "/cancel" | "/retry"; jobId: string } | null {
  const [rawCommand, jobId] = text.split(/\s+/, 2);
  const command = rawCommand?.split("@", 1)[0];
  if (command !== "/job" && command !== "/cancel" && command !== "/retry") {
    return null;
  }

  return {
    command,
    jobId: jobId ?? ""
  };
}

function formatCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown project job")) {
    return "Задание не найдено.";
  }

  if (message.startsWith("Job is not finished yet")) {
    return "Повторить можно только завершенное, ошибочное или отмененное задание.";
  }

  return message;
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

const DEFAULT_JOB_MAX_ATTEMPTS = 3;

interface CreateProjectJobOptions {
  attempt?: number;
  maxAttempts?: number;
  rootJobId?: string;
  retryOfJobId?: string;
}

function createProjectJob(
  input: BootstrapProjectInput,
  date = new Date(),
  options: CreateProjectJobOptions = {}
): ProjectJob {
  const now = date.toISOString();
  const id = `job-${now.replaceAll(/[:.]/g, "").replace("T", "-").replace("Z", "")}-${randomUUID().slice(0, 8)}`;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS);
  return {
    id,
    chatId: input.chatId,
    description: input.description,
    selectedModel: input.selectedModel,
    status: "pending",
    queuedAt: now,
    attempt: Math.max(1, options.attempt ?? 1),
    maxAttempts,
    rootJobId: options.rootJobId ?? id,
    retryOfJobId: options.retryOfJobId,
    idempotencyKey: input.idempotencyKey
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
    case "cancelled":
      return "отменено";
    case "dead_letter":
      return "dead-letter";
  }
}

function isTerminalJobStatus(status: ProjectJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_letter";
}

function isTerminalPatch(patch: Partial<ProjectJob>): boolean {
  return patch.status === "completed" || patch.status === "failed" || patch.status === "dead_letter";
}

function isProtectedTerminalStatus(status: ProjectJobStatus): boolean {
  return status === "cancelled" || status === "dead_letter";
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
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function delay(timeoutMs: number, customSleep?: (timeoutMs: number) => Promise<void>): Promise<void> {
  return customSleep ? customSleep(timeoutMs) : sleep(timeoutMs);
}

function logRuntimeError(
  logger: Pick<Console, "error"> | undefined,
  message: string,
  error: unknown
): void {
  const targetLogger = logger ?? console;
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  targetLogger.error(`${message}: ${details}`);
}

function recoverExpiredRunningJobs(jobs: ProjectJob[], now: Date): ProjectJob[] {
  return jobs.map((job) => {
    if (job.status !== "running" || !job.leaseExpiresAt) {
      return job;
    }

    if (Date.parse(job.leaseExpiresAt) > now.getTime()) {
      return job;
    }

    if (job.attempt >= job.maxAttempts) {
      const nowIso = now.toISOString();
      return {
        ...job,
        status: "dead_letter",
        finishedAt: nowIso,
        deadLetterAt: nowIso,
        leaseExpiresAt: undefined,
        error: `Job lease expired after ${job.attempt} attempt(s)`
      };
    }

    return {
      ...job,
      status: "pending",
      attempt: job.attempt + 1,
      startedAt: undefined,
      leaseExpiresAt: undefined,
      error: `Recovered from expired lease at ${now.toISOString()}`
    };
  });
}

function findIdempotentJob(jobs: ProjectJob[], idempotencyKey: string | undefined): ProjectJob | null {
  if (!idempotencyKey) {
    return null;
  }

  return jobs.find((job) => job.idempotencyKey === idempotencyKey) ?? null;
}

function findJobIndex(jobs: ProjectJob[], jobId: string): number {
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) {
    throw new Error(`Unknown project job: ${jobId}`);
  }

  return index;
}

function normalizeProjectJob(job: ProjectJob): ProjectJob {
  const maxAttempts = normalizePositiveInteger(job.maxAttempts, DEFAULT_JOB_MAX_ATTEMPTS);
  return {
    ...job,
    attempt: normalizePositiveInteger(job.attempt, 1),
    maxAttempts,
    rootJobId: job.rootJobId ?? job.id
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function leaseDeadline(now: Date, leaseMs: number): Date {
  return new Date(now.getTime() + leaseMs);
}

function startJobLeaseRenewal(
  queue: ProjectJobQueue,
  jobId: string,
  intervalMs: number
): () => void {
  if (!queue.renew) {
    return () => {};
  }

  const timer = setInterval(() => {
    queue.renew?.(jobId).catch(() => {});
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

async function acquireFileLock(
  lockPath: string,
  options: {
    timeoutMs: number;
    staleMs: number;
    now: () => Date;
  }
): Promise<() => Promise<void>> {
  const deadline = options.now().getTime() + options.timeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      await removeStaleLock(lockPath, options);

      if (options.now().getTime() >= deadline) {
        throw new Error(`Timed out waiting for queue lock: ${lockPath}`);
      }

      await sleep(50);
    }
  }
}

async function removeStaleLock(
  lockPath: string,
  options: {
    staleMs: number;
    now: () => Date;
  }
): Promise<void> {
  try {
    const metadata = await stat(lockPath);
    if (options.now().getTime() - metadata.mtimeMs < options.staleMs) {
      return;
    }

    await rm(lockPath, { force: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
