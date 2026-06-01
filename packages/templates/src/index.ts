import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const generatedWebAppTemplate = {
  id: "generated-webapp",
  stack: {
    frontend: "react-vite-typescript",
    backend: "go-chi",
    database: "postgresql",
    api: "rest-openapi"
  },
  path: "packages/templates/generated-webapp"
} as const;

export type TemplateId = typeof generatedWebAppTemplate.id;

export interface MaterializeTemplateOptions {
  targetDir: string;
  templateId?: TemplateId;
}

const excludedPathSegments = new Set(["node_modules", "dist", ".git"]);
const excludedFileEndings = [".tsbuildinfo"];

export async function materializeGeneratedWebApp(
  options: MaterializeTemplateOptions
): Promise<void> {
  if (options.templateId && options.templateId !== generatedWebAppTemplate.id) {
    throw new Error(`Unsupported template: ${options.templateId}`);
  }

  const sourceDir = getGeneratedWebAppTemplateDir();
  const targetDir = resolve(options.targetDir);

  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => shouldCopy(sourceDir, source)
  });
}

export async function listGeneratedWebAppTemplateFiles(): Promise<string[]> {
  const sourceDir = getGeneratedWebAppTemplateDir();
  const files: string[] = [];
  await collectFiles(sourceDir, sourceDir, files);
  return files.sort();
}

function getGeneratedWebAppTemplateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "generated-webapp");
}

function shouldCopy(sourceDir: string, source: string): boolean {
  const path = relative(sourceDir, source);
  if (path === "") {
    return true;
  }

  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => excludedPathSegments.has(segment))) {
    return false;
  }

  return !excludedFileEndings.some((ending) => path.endsWith(ending));
}

async function collectFiles(rootDir: string, currentDir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const absolutePath = join(currentDir, entry.name);
    if (!shouldCopy(rootDir, absolutePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectFiles(rootDir, absolutePath, files);
      continue;
    }

    if (entry.isFile() || (await stat(absolutePath)).isFile()) {
      files.push(relative(rootDir, absolutePath));
    }
  }
}
