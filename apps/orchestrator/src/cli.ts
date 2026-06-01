#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectSpecSchema } from "@hephaestus/contracts";
import { type ValidationCheck, validateGeneratedWebApp } from "@hephaestus/project-validator";
import { FileProjectStateStore, Orchestrator } from "./index.js";

export interface ScaffoldCliOptions {
  specPath: string;
  outDir: string;
}

export interface ValidateCliOptions {
  projectDir: string;
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

export function parseValidateArgs(args: string[]): ValidateCliOptions {
  const projectDir = readOption(args, "--project");

  if (!projectDir) {
    throw new Error("Использование: hephaestus-scaffold validate --project ./generated-projects/my-app");
  }

  return { projectDir };
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

export async function validateProjectDirectory(
  options: ValidateCliOptions,
  checks?: ValidationCheck[]
): Promise<boolean> {
  const projectDir = resolve(options.projectDir);
  const report = await validateGeneratedWebApp({ projectDir, checks });
  return report.passed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "validate") {
    const passed = await validateProjectDirectory(parseValidateArgs(args.slice(1)));
    console.log(passed ? "Проверка проекта успешна" : "Проверка проекта завершилась ошибкой");
    process.exitCode = passed ? 0 : 1;
    return;
  }

  const options = parseScaffoldArgs(args);
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
