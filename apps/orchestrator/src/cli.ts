#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeRequirements, createArchitecturePlan } from "@hephaestus/agents";
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

export interface RequirementsCliOptions {
  text?: string;
  inputPath?: string;
  outPath: string;
  projectName?: string;
}

export interface PlanCliOptions {
  specPath: string;
  outPath: string;
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

export function parseRequirementsArgs(args: string[]): RequirementsCliOptions {
  const text = readOption(args, "--text") ?? undefined;
  const inputPath = readOption(args, "--input") ?? undefined;
  const outPath = readOption(args, "--out");
  const projectName = readOption(args, "--name") ?? undefined;

  if ((!text && !inputPath) || !outPath) {
    throw new Error(
      "Использование: hephaestus-scaffold requirements --text \"описание\" --out ./SPEC.json"
    );
  }

  return {
    text,
    inputPath,
    outPath,
    projectName
  };
}

export function parsePlanArgs(args: string[]): PlanCliOptions {
  const specPath = readOption(args, "--spec");
  const outPath = readOption(args, "--out");

  if (!specPath || !outPath) {
    throw new Error("Использование: hephaestus-scaffold plan --spec ./SPEC.json --out ./PLAN.json");
  }

  return { specPath, outPath };
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

export async function saveRequirementsSpec(options: RequirementsCliOptions): Promise<string> {
  const text = options.text ?? await readFile(resolve(options.inputPath!), "utf8");
  const spec = analyzeRequirements({
    text,
    projectName: options.projectName
  });
  const outPath = resolve(options.outPath);

  await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  return outPath;
}

export async function saveArchitecturePlan(options: PlanCliOptions): Promise<string> {
  const specPath = resolve(options.specPath);
  const outPath = resolve(options.outPath);
  const rawSpec = await readFile(specPath, "utf8");
  const spec = projectSpecSchema.parse(JSON.parse(rawSpec));
  const plan = createArchitecturePlan(spec);

  await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return outPath;
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

  if (args[0] === "requirements") {
    const outPath = await saveRequirementsSpec(parseRequirementsArgs(args.slice(1)));
    console.log(`Спецификация сохранена: ${outPath}`);
    return;
  }

  if (args[0] === "plan") {
    const outPath = await saveArchitecturePlan(parsePlanArgs(args.slice(1)));
    console.log(`Технический план сохранен: ${outPath}`);
    return;
  }

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
