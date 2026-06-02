#!/usr/bin/env node
import { resolve } from "node:path";
import {
  HephaestusTelegramBot,
  InMemoryTelegramSessionStore,
  LocalProjectBootstrapper,
  TelegramHttpApi,
  TelegramPollingRuntime,
  parseAvailableModels
} from "./index.js";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const projectsDir = resolve(process.env.HEPHAESTUS_PROJECTS_DIR ?? "./generated-projects");
  const models = parseAvailableModels(process.env.HEPHAESTUS_AVAILABLE_MODELS);
  const api = new TelegramHttpApi({ token });
  const bot = new HephaestusTelegramBot({
    models,
    sessionStore: new InMemoryTelegramSessionStore(),
    bootstrapper: new LocalProjectBootstrapper({ outputRoot: projectsDir })
  });
  const runtime = new TelegramPollingRuntime(api, bot);

  let offset: number | undefined;
  while (true) {
    offset = await runtime.runOnce(offset);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
