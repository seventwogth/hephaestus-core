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
  const api = new TelegramHttpApi({ token });
  const sessionStore = new FileTelegramSessionStore(joinPath(stateDir, "sessions.json"));
  const jobQueue = new FileProjectJobQueue(joinPath(stateDir, "jobs.json"));
  const bootstrapper = new LocalProjectBootstrapper({
    outputRoot: projectsDir,
    createModelProvider: (model) => createModelProviderForOption(model)
  });
  const bot = new HephaestusTelegramBot({
    models,
    sessionStore,
    jobQueue
  });
  const runtime = new TelegramPollingRuntime(
    api,
    bot,
    new ProjectJobRunner(jobQueue, bootstrapper, api),
    new FilePollingOffsetStore(joinPath(stateDir, "offset.json"))
  );

  let offset: number | undefined;
  while (true) {
    offset = await runtime.runOnce(offset);
  }
}

function joinPath(base: string, suffix: string): string {
  return resolve(base, suffix);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
