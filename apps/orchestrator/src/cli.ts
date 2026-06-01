#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectSpecSchema } from "@hephaestus/contracts";
import { FileProjectStateStore, Orchestrator } from "./index.js";

export interface ScaffoldCliOptions {
  specPath: string;
  outDir: string;
}

export function parseScaffoldArgs(args: string[]): ScaffoldCliOptions {
  const specPath = readOption(args, "--spec");
  const outDir = readOption(args, "--out");

  if (!specPath || !outDir) {
    throw new Error(
      "Использование: hephaestus-scaffold --spec ./SPEC.json --out ./generated-projects/my-app"
    );
  }

  return {
    specPath,
    outDir
  };
}

export async function scaffoldFromSpecFile(options: ScaffoldCliOptions): Promise<string> {
  const specPath = resolve(options.specPath);
  const outDir = resolve(options.outDir);
  const rawSpec = await readFile(specPath, "utf8");
  const spec = projectSpecSchema.parse(JSON.parse(rawSpec));
  const orchestrator = new Orchestrator(new FileProjectStateStore());

  await orchestrator.scaffoldProject(outDir, spec);
  return outDir;
}

async function main(): Promise<void> {
  const options = parseScaffoldArgs(process.argv.slice(2));
  const outDir = await scaffoldFromSpecFile(options);
  console.log(`Проект создан: ${outDir}`);
}

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    return null;
  }

  return args[index + 1] ?? null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
