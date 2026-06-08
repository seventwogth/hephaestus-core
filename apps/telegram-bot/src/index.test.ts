import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  createModelProviderForOption,
  FilePollingOffsetStore,
  FileProjectJobStore,
  FileProjectJobQueue,
  FileTelegramSessionStore,
  HephaestusTelegramBot,
  InMemoryProjectJobStore,
  InMemoryProjectJobQueue,
  InMemoryTelegramSessionStore,
  LocalProjectBootstrapper,
  parseAvailableModels,
  PostgresProjectJobStore,
  ProjectJobRunner,
  readSelectedModel,
  StoredProjectJobQueue,
  TelegramPollingRuntime,
  TelegramWorkerRuntime,
  type ModelOption,
  type PostgresProjectJobClient,
  type PostgresProjectJobPool,
  type ProjectBootstrapper,
  type ProjectJob,
  type ProjectJobQueue,
  type TelegramApi
} from "./index.js";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

interface RecordedResult {
  match: string;
  rows: Record<string, unknown>[];
}

class RecordingPostgresClient implements PostgresProjectJobClient {
  readonly queries: RecordedQuery[] = [];
  released = false;

  constructor(private readonly results: RecordedResult[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    return recordedQueryResult(this.results.find((result) => text.includes(result.match))?.rows ?? []);
  }

  release(): void {
    this.released = true;
  }
}

class RecordingPostgresPool implements PostgresProjectJobPool {
  readonly queries: RecordedQuery[] = [];
  readonly client: RecordingPostgresClient;

  constructor(private readonly results: RecordedResult[] = []) {
    this.client = new RecordingPostgresClient(results);
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    this.queries.push({ text, values });
    return recordedQueryResult(this.results.find((result) => text.includes(result.match))?.rows ?? []);
  }

  async connect(): Promise<PostgresProjectJobClient> {
    return this.client;
  }
}

function projectJob(overrides: Partial<ProjectJob> = {}): ProjectJob {
  return {
    id: "job-1",
    chatId: 100,
    description: "Создай сервис книг",
    selectedModel: { id: "quality", label: "Quality" },
    status: "pending",
    queuedAt: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    maxAttempts: 3,
    rootJobId: "job-1",
    ...overrides
  };
}

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    chat_id: 100,
    description: "Создай сервис книг",
    selected_model: { id: "quality", label: "Quality" } satisfies ModelOption,
    status: "pending",
    queued_at: "2026-01-01T00:00:00.000Z",
    attempt: 1,
    max_attempts: 3,
    root_job_id: "job-1",
    started_at: null,
    finished_at: null,
    lease_expires_at: null,
    cancelled_at: null,
    dead_letter_at: null,
    retry_of_job_id: null,
    idempotency_key: null,
    project_dir: null,
    project_name: null,
    error: null,
    ...overrides
  };
}

function recordedQueryResult<R extends QueryResultRow>(rows: Record<string, unknown>[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: rows as R[]
  };
}

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
    const jobQueue = new InMemoryProjectJobQueue();
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("stub|Stub,quality|Quality"),
      sessionStore,
      jobQueue
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
    const jobQueue = new InMemoryProjectJobQueue();
    let selectedModelId: string | null = null;
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("stub|Stub,quality|Quality"),
      sessionStore,
      jobQueue
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
    const jobs = await jobQueue.listByChat(100);
    selectedModelId = jobs[0]?.selectedModel.id ?? null;
    expect(jobs[0]?.status).toBe("pending");
    expect(messageActions[0]).toMatchObject({
      type: "sendMessage",
      chatId: 100
    });
    expect(messageActions[0]?.text).toContain("Модель: Quality");
    expect(messageActions[0]?.text).toContain("поставлен в очередь");
  });

  it("renders job details and the latest completed project", async () => {
    const sessionStore = new InMemoryTelegramSessionStore();
    const jobQueue = new InMemoryProjectJobQueue();
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("quality|Quality"),
      sessionStore,
      jobQueue
    });
    const job = await jobQueue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" }
    });
    await jobQueue.complete(job.id, {
      projectDir: "/tmp/book-tracker",
      projectName: "book-tracker",
      selectedModel: { id: "quality", label: "Quality" }
    });

    const detailActions = await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 12,
        chat: { id: 100 },
        text: `/job ${job.id}`
      }
    });
    const lastActions = await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 13,
        chat: { id: 100 },
        text: "/last"
      }
    });

    expect(detailActions[0]?.text).toContain(`Задание: ${job.id}`);
    expect(detailActions[0]?.text).toContain("Директория: /tmp/book-tracker");
    expect(lastActions[0]?.text).toContain("Последний готовый проект: book-tracker");
    expect(lastActions[0]?.text).toContain("Директория: /tmp/book-tracker");
  });

  it("cancels and retries queued jobs from Telegram commands", async () => {
    const sessionStore = new InMemoryTelegramSessionStore();
    const jobQueue = new InMemoryProjectJobQueue();
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("quality|Quality"),
      sessionStore,
      jobQueue
    });
    const job = await jobQueue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" }
    });

    const cancelActions = await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 14,
        chat: { id: 100 },
        text: `/cancel ${job.id}`
      }
    });
    const retryActions = await bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 15,
        chat: { id: 100 },
        text: `/retry ${job.id}`
      }
    });
    const jobs = await jobQueue.listByChat(100);

    expect(cancelActions[0]?.text).toContain(`Задание отменено: ${job.id}`);
    expect(retryActions[0]?.text).toContain("Повтор поставлен в очередь");
    expect(jobs.some((item) => item.id === job.id && item.status === "cancelled")).toBe(true);
    const retriedJob = jobs.find((item) => item.id !== job.id && item.status === "pending");
    expect(retriedJob).toBeDefined();
    expect(retriedJob).toMatchObject({
      attempt: 2,
      rootJobId: job.id,
      retryOfJobId: job.id
    });
  });
});

describe("persistent Telegram bot state", () => {
  it("persists sessions to a file store", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));

    try {
      const filePath = join(rootDir, "sessions.json");
      const store = new FileTelegramSessionStore(filePath);
      await store.write({
        chatId: 100,
        stage: "awaiting_description",
        selectedModelId: "quality"
      });

      const reloadedStore = new FileTelegramSessionStore(filePath);
      await expect(reloadedStore.read(100)).resolves.toEqual({
        chatId: 100,
        stage: "awaiting_description",
        selectedModelId: "quality"
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("persists queued jobs and polling offset to disk", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));

    try {
      const queue = new FileProjectJobQueue(join(rootDir, "jobs.json"));
      const job = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });
      const offsetStore = new FilePollingOffsetStore(join(rootDir, "offset.json"));
      await offsetStore.write(42);

      const reloadedQueue = new FileProjectJobQueue(join(rootDir, "jobs.json"));
      await expect(reloadedQueue.listByChat(100)).resolves.toEqual([
        expect.objectContaining({ id: job.id, status: "pending", attempt: 1, maxAttempts: 3, rootJobId: job.id })
      ]);
      await expect(new FilePollingOffsetStore(join(rootDir, "offset.json")).read()).resolves.toBe(42);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deduplicates file queue enqueue calls with the same idempotency key", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));

    try {
      const queue = new FileProjectJobQueue(join(rootDir, "jobs.json"));
      const firstJob = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" },
        idempotencyKey: "chat-100-message-42"
      });
      const secondJob = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" },
        idempotencyKey: "chat-100-message-42"
      });
      const jobs = await queue.listByChat(100);

      expect(secondJob.id).toBe(firstJob.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        idempotencyKey: "chat-100-message-42"
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("supports a reusable job store contract for queue backends", async () => {
    const store = new InMemoryProjectJobStore();
    const queue = new StoredProjectJobQueue(store, {
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const job = await queue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" }
    });
    const claimed = await queue.claimNext();

    expect(claimed).toMatchObject({
      id: job.id,
      status: "running"
    });
    await expect(store.getByChat(100, job.id)).resolves.toMatchObject({
      id: job.id,
      status: "running"
    });
  });

  it("can compose the file store with the generic queue lifecycle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));

    try {
      const filePath = join(rootDir, "jobs.json");
      const queue = new StoredProjectJobQueue(
        new FileProjectJobStore(filePath),
        {
          now: () => new Date("2026-01-01T00:00:00.000Z")
        }
      );

      const job = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });

      await expect(new FileProjectJobStore(filePath).getByChat(100, job.id)).resolves.toMatchObject({
        id: job.id,
        status: "pending"
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("creates the Postgres job table and lifecycle indexes", async () => {
    const pool = new RecordingPostgresPool();
    const store = new PostgresProjectJobStore({
      pool,
      tableName: "telegram.project_jobs"
    });

    await store.migrate();

    expect(pool.queries[0]?.text).toContain("CREATE TABLE IF NOT EXISTS \"telegram\".\"project_jobs\"");
    expect(pool.queries[0]?.text).toContain("CREATE UNIQUE INDEX IF NOT EXISTS hephaestus_project_jobs_idempotency_key_idx");
    expect(pool.queries[0]?.text).toContain("WHERE idempotency_key IS NOT NULL");
    expect(pool.queries[0]?.text).toContain("hephaestus_project_jobs_lease_idx");
  });

  it("rejects unsafe Postgres table names", () => {
    expect(() => new PostgresProjectJobStore({
      pool: new RecordingPostgresPool(),
      tableName: "project_jobs; drop table project_jobs"
    })).toThrow("Invalid SQL identifier");
  });

  it("inserts Postgres jobs through an idempotent key conflict target", async () => {
    const selectedModel = { id: "quality", label: "Quality" };
    const pool = new RecordingPostgresPool([
      {
        match: "INSERT INTO",
        rows: [jobRow({
          id: "job-1",
          selected_model: selectedModel,
          idempotency_key: "chat-100-message-42"
        })]
      }
    ]);
    const store = new PostgresProjectJobStore({ pool });

    const inserted = await store.insert(projectJob({
      id: "job-1",
      selectedModel,
      idempotencyKey: "chat-100-message-42"
    }));

    expect(inserted).toMatchObject({
      id: "job-1",
      selectedModel,
      idempotencyKey: "chat-100-message-42"
    });
    expect(pool.queries[0]?.text).toContain("ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL");
    expect(pool.queries[0]?.values?.[3]).toBe(JSON.stringify(selectedModel));
  });

  it("claims Postgres jobs transactionally with lease recovery and skip-locked selection", async () => {
    const pool = new RecordingPostgresPool([
      {
        match: "RETURNING jobs.*",
        rows: [jobRow({
          id: "job-1",
          status: "running",
          started_at: "2026-01-01T00:00:00.000Z",
          lease_expires_at: "2026-01-01T00:10:00.000Z"
        })]
      }
    ]);
    const store = new PostgresProjectJobStore({ pool });

    const claimed = await store.claimNext(new Date("2026-01-01T00:00:00.000Z"), 600_000);

    expect(claimed).toMatchObject({
      id: "job-1",
      status: "running",
      leaseExpiresAt: "2026-01-01T00:10:00.000Z"
    });
    expect(pool.client.queries.map((query) => query.text.trim())).toEqual([
      "BEGIN",
      expect.stringContaining("status = 'dead_letter'"),
      expect.stringContaining("attempt = attempt + 1"),
      expect.stringContaining("FOR UPDATE SKIP LOCKED"),
      "COMMIT"
    ]);
  });

  it("recovers expired running jobs from the file queue", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));
    let currentTime = new Date("2026-01-01T00:00:00.000Z");

    try {
      const filePath = join(rootDir, "jobs.json");
      const queue = new FileProjectJobQueue(filePath, {
        jobLeaseMs: 1_000,
        maxAttempts: 2,
        now: () => currentTime
      });
      const job = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });
      const claimed = await queue.claimNext();

      expect(claimed).toMatchObject({
        id: job.id,
        status: "running",
        attempt: 1,
        leaseExpiresAt: "2026-01-01T00:00:01.000Z"
      });

      currentTime = new Date("2026-01-01T00:00:02.000Z");

      const reloadedQueue = new FileProjectJobQueue(filePath, {
        jobLeaseMs: 1_000,
        maxAttempts: 2,
        now: () => currentTime
      });
      const recovered = await reloadedQueue.claimNext();

      expect(recovered).toMatchObject({
        id: job.id,
        status: "running",
        attempt: 2,
        startedAt: "2026-01-01T00:00:02.000Z",
        leaseExpiresAt: "2026-01-01T00:00:03.000Z"
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("moves repeatedly expired running jobs to dead-letter", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));
    let currentTime = new Date("2026-01-01T00:00:00.000Z");

    try {
      const filePath = join(rootDir, "jobs.json");
      const queue = new FileProjectJobQueue(filePath, {
        jobLeaseMs: 1_000,
        maxAttempts: 1,
        now: () => currentTime
      });
      const job = await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });
      await queue.claimNext();
      currentTime = new Date("2026-01-01T00:00:02.000Z");

      await expect(queue.claimNext()).resolves.toBeNull();
      const jobs = await queue.listByChat(100);

      expect(jobs[0]).toMatchObject({
        id: job.id,
        status: "dead_letter",
        deadLetterAt: "2026-01-01T00:00:02.000Z",
        error: "Job lease expired after 1 attempt(s)"
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent file queue claims", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-telegram-state-"));

    try {
      const filePath = join(rootDir, "jobs.json");
      const queue = new FileProjectJobQueue(filePath);
      await queue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });

      const [leftClaim, rightClaim] = await Promise.all([
        new FileProjectJobQueue(filePath).claimNext(),
        new FileProjectJobQueue(filePath).claimNext()
      ]);

      expect([leftClaim, rightClaim].filter(Boolean)).toHaveLength(1);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("ProjectJobRunner", () => {
  it("runs queued jobs and notifies Telegram on success", async () => {
    const jobQueue = new InMemoryProjectJobQueue();
    const messages: string[] = [];
    const api: TelegramApi = {
      async getUpdates() {
        return [];
      },
      async sendMessage(action) {
        messages.push(action.text);
      },
      async answerCallbackQuery() {}
    };
    const bootstrapper: ProjectBootstrapper = {
      async bootstrap(input) {
        return {
          projectDir: "/tmp/project",
          projectName: "book-tracker",
          selectedModel: input.selectedModel
        };
      }
    };
    await jobQueue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" }
    });

    const runner = new ProjectJobRunner(jobQueue, bootstrapper, api);
    const job = await runner.runNext();

    expect(job?.status).toBe("completed");
    expect(messages.some((message) => message.includes("Запущена генерация проекта"))).toBe(true);
    expect(messages.some((message) => message.includes("Проект создан"))).toBe(true);
  });

  it("does not overwrite a running job cancelled during bootstrap", async () => {
    const jobQueue = new InMemoryProjectJobQueue();
    const messages: string[] = [];
    let finishBootstrap: (() => void) | null = null;
    const api: TelegramApi = {
      async getUpdates() {
        return [];
      },
      async sendMessage(action) {
        messages.push(action.text);
      },
      async answerCallbackQuery() {}
    };
    const bootstrapper: ProjectBootstrapper = {
      async bootstrap(input) {
        await new Promise<void>((resolve) => {
          finishBootstrap = resolve;
        });
        return {
          projectDir: "/tmp/project",
          projectName: "book-tracker",
          selectedModel: input.selectedModel
        };
      }
    };
    const originalJob = await jobQueue.enqueue({
      chatId: 100,
      description: "Создай сервис книг",
      selectedModel: { id: "quality", label: "Quality" }
    });

    const runner = new ProjectJobRunner(jobQueue, bootstrapper, api);
    const runPromise = runner.runNext();
    while (!finishBootstrap) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await jobQueue.cancel(originalJob.id, 100);
    const resolveBootstrap: () => void = finishBootstrap;
    resolveBootstrap();
    const job = await runPromise;

    expect(job?.status).toBe("cancelled");
    expect(messages.some((message) => message.includes("Задание отменено"))).toBe(true);
    expect(messages.some((message) => message.includes("Проект создан"))).toBe(false);
  });
});

describe("TelegramPollingRuntime", () => {
  it("processes updates, stores offset and drains one queued job", async () => {
    const offsetRoot = await mkdtemp(join(tmpdir(), "hephaestus-telegram-offset-"));
    const sessionStore = new InMemoryTelegramSessionStore();
    const jobQueue = new InMemoryProjectJobQueue();
    const messages: string[] = [];
    try {
      const api: TelegramApi = {
        async getUpdates() {
          return [
            {
              update_id: 10,
              message: {
                message_id: 1,
                chat: { id: 100 },
                text: "/status"
              }
            }
          ];
        },
        async sendMessage(action) {
          messages.push(action.text);
        },
        async answerCallbackQuery() {}
      };
      const bot = new HephaestusTelegramBot({
        models: parseAvailableModels("quality|Quality"),
        sessionStore,
        jobQueue
      });
      await jobQueue.enqueue({
        chatId: 100,
        description: "Создай сервис книг",
        selectedModel: { id: "quality", label: "Quality" }
      });
      const runtime = new TelegramPollingRuntime(
        api,
        bot,
        new ProjectJobRunner(
          jobQueue,
          {
            async bootstrap(input) {
              return {
                projectDir: "/tmp/project",
                projectName: "book-tracker",
                selectedModel: input.selectedModel
              };
            }
          },
          api
        ),
        new FilePollingOffsetStore(join(offsetRoot, "offset.json"))
      );

      const nextOffset = await runtime.runOnce();

      expect(nextOffset).toBe(11);
      expect(messages.some((message) => message.includes("Последние задания"))).toBe(true);
      expect(messages.some((message) => message.includes("Проект создан"))).toBe(true);
      await expect(new FilePollingOffsetStore(join(offsetRoot, "offset.json")).read()).resolves.toBe(11);
    } finally {
      await rm(offsetRoot, { recursive: true, force: true });
    }
  });

  it("continues polling after a failed iteration", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const api: TelegramApi = {
      async getUpdates() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary Telegram outage");
        }

        return [];
      },
      async sendMessage() {},
      async answerCallbackQuery() {}
    };
    const bot = new HephaestusTelegramBot({
      models: parseAvailableModels("quality|Quality"),
      sessionStore: new InMemoryTelegramSessionStore(),
      jobQueue: new InMemoryProjectJobQueue()
    });
    const runtime = new TelegramPollingRuntime(api, bot);

    await runtime.runForever(undefined, {
      errorDelayMs: 1,
      logger: {
        error(message) {
          errors.push(String(message));
        }
      },
      async sleep() {},
      shouldStop: () => attempts >= 2
    });

    expect(attempts).toBe(2);
    expect(errors[0]).toContain("temporary Telegram outage");
  });
});

describe("TelegramWorkerRuntime", () => {
  it("continues worker loop after a failed iteration", async () => {
    let attempts = 0;
    const errors: string[] = [];
    const queue: ProjectJobQueue = {
      async enqueue() {
        throw new Error("unused");
      },
      async listByChat() {
        return [];
      },
      async getByChat() {
        return null;
      },
      async claimNext() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary queue outage");
        }

        return null;
      },
      async complete() {
        throw new Error("unused");
      },
      async retry() {
        throw new Error("unused");
      },
      async cancel() {
        throw new Error("unused");
      },
      async fail() {
        throw new Error("unused");
      }
    };
    const api: TelegramApi = {
      async getUpdates() {
        return [];
      },
      async sendMessage() {},
      async answerCallbackQuery() {}
    };
    const runner = new ProjectJobRunner(
      queue,
      {
        async bootstrap() {
          throw new Error("unused");
        }
      },
      api
    );
    const runtime = new TelegramWorkerRuntime(runner, 1);

    await runtime.runForever({
      errorDelayMs: 1,
      logger: {
        error(message) {
          errors.push(String(message));
        }
      },
      async sleep() {},
      shouldStop: () => attempts >= 2
    });

    expect(attempts).toBe(2);
    expect(errors[0]).toContain("temporary queue outage");
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
