#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSandboxRunnerFromEnv } from "@hephaestus/orchestrator";
import {
  FilePollingOffsetStore,
  FileProjectJobQueue,
  FileTelegramSessionStore,
  HephaestusTelegramBot,
  LocalProjectBootstrapper,
  PostgresProjectJobStore,
  ProjectJobRunner,
  StoredProjectJobQueue,
  TelegramHttpApi,
  TelegramPollingRuntime,
  TelegramWorkerRuntime,
  createModelProviderForOption,
  parseAvailableModels,
  type ProjectJobQueue
} from "./index.js";

async function tryLoadEnvFile(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^export\s+([^=]+)="?([^"]*)"?$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Автоматически загружаем .env.hephaestus из текущей директории или корня проекта
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  await tryLoadEnvFile(resolve(process.cwd(), ".env.hephaestus"));
  await tryLoadEnvFile(resolve(rootDir, ".env.hephaestus"));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const projectsDir = resolve(process.env.HEPHAESTUS_PROJECTS_DIR ?? "./generated-projects");
  const stateDir = resolve(process.env.HEPHAESTUS_BOT_STATE_DIR ?? joinPath(projectsDir, ".hephaestus-bot"));
  const models = parseAvailableModels(process.env.HEPHAESTUS_AVAILABLE_MODELS);
  const mode = parseBotMode(process.argv.slice(2)[0] ?? process.env.HEPHAESTUS_BOT_MODE);
  const workerPollIntervalMs = parseInterval(process.env.HEPHAESTUS_JOB_POLL_INTERVAL_MS);
  const noScaffold = parseBoolean(process.env.HEPHAESTUS_NO_SCAFFOLD);
  const api = new TelegramHttpApi({
    token,
    apiBaseUrl: process.env.HEPHAESTUS_TELEGRAM_API_URL
  });
  const sessionStore = new FileTelegramSessionStore(joinPath(stateDir, "sessions.json"));
  const jobQueue = await createJobQueue(stateDir);
  const bootstrapper = new LocalProjectBootstrapper({
    outputRoot: projectsDir,
    createModelProvider: (model) => createModelProviderForOption(model),
    bootstrapOptions: {
      noScaffold,
      sandboxRunner: parseSandboxRunnerFromEnv()
    }
  });
  const bot = new HephaestusTelegramBot({
    models,
    sessionStore,
    jobQueue
  });
  const jobRunner = new ProjectJobRunner(jobQueue, bootstrapper, api);
  const pollingRuntime = new TelegramPollingRuntime(
    api,
    bot,
    undefined,
    new FilePollingOffsetStore(joinPath(stateDir, "offset.json"))
  );
  const workerRuntime = new TelegramWorkerRuntime(jobRunner, workerPollIntervalMs);

  if (mode === "poll") {
    await pollingRuntime.runForever();
  } else if (mode === "worker") {
    await workerRuntime.runForever();
  } else {
    await Promise.all([pollingRuntime.runForever(), workerRuntime.runForever()]);
  }
}

function joinPath(base: string, suffix: string): string {
  return resolve(base, suffix);
}

async function createJobQueue(stateDir: string): Promise<ProjectJobQueue> {
  const backend = parseJobStoreBackend(process.env.HEPHAESTUS_JOB_STORE, process.env.HEPHAESTUS_JOB_DATABASE_URL);
  if (backend === "file") {
    return new FileProjectJobQueue(joinPath(stateDir, "jobs.json"));
  }

  const connectionString = process.env.HEPHAESTUS_JOB_DATABASE_URL;
  if (!connectionString) {
    throw new Error("HEPHAESTUS_JOB_DATABASE_URL is required when HEPHAESTUS_JOB_STORE=postgres");
  }

  const store = new PostgresProjectJobStore({
    connectionString,
    tableName: process.env.HEPHAESTUS_JOB_TABLE
  });
  if (parseBoolean(process.env.HEPHAESTUS_JOB_RUN_MIGRATIONS, true)) {
    await store.migrate();
  }

  return new StoredProjectJobQueue(store);
}

function parseJobStoreBackend(
  rawValue: string | undefined,
  databaseUrl: string | undefined
): "file" | "postgres" {
  const value = (rawValue ?? (databaseUrl ? "postgres" : "file")).trim().toLowerCase();
  if (value === "file" || value === "postgres") {
    return value;
  }

  throw new Error(`Unsupported HEPHAESTUS_JOB_STORE value: ${rawValue}`);
}

function parseBotMode(rawValue: string | undefined): "poll" | "worker" | "all" {
  const value = (rawValue ?? "all").trim().toLowerCase();
  if (value === "poll" || value === "worker" || value === "all") {
    return value;
  }

  throw new Error(`Unsupported bot mode: ${rawValue}`);
}

function parseInterval(rawValue: string | undefined): number {
  if (!rawValue) {
    return 3_000;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid HEPHAESTUS_JOB_POLL_INTERVAL_MS value: ${rawValue}`);
  }

  return parsed;
}

function parseBoolean(rawValue: string | undefined, fallback = false): boolean {
  if (!rawValue) {
    return fallback;
  }

  const value = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${rawValue}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
