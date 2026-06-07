#!/usr/bin/env node
import { resolve } from "node:path";
import {
  FilePollingOffsetStore,
  FileProjectJobQueue,
  FileTelegramSessionStore,
  HephaestusTelegramBot,
  LocalProjectBootstrapper,
  ProjectJobRunner,
  TelegramHttpApi,
  TelegramPollingRuntime,
  TelegramWorkerRuntime,
  createModelProviderForOption,
  parseAvailableModels
} from "./index.js";

async function main(): Promise<void> {
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
  const api = new TelegramHttpApi({ token });
  const sessionStore = new FileTelegramSessionStore(joinPath(stateDir, "sessions.json"));
  const jobQueue = new FileProjectJobQueue(joinPath(stateDir, "jobs.json"));
  const bootstrapper = new LocalProjectBootstrapper({
    outputRoot: projectsDir,
    createModelProvider: (model) => createModelProviderForOption(model),
    bootstrapOptions: {
      noScaffold
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

function parseBoolean(rawValue: string | undefined): boolean {
  if (!rawValue) {
    return false;
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
