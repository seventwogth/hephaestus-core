import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandResult, ProjectSandbox } from "@hephaestus/project-sandbox";

export interface ValidationCheck {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
}

export interface ValidationCheckResult {
  check: ValidationCheck;
  commandResult: CommandResult;
  passed: boolean;
}

export interface ValidationReport {
  projectDir: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  results: ValidationCheckResult[];
}

export const generatedWebAppValidationChecks: ValidationCheck[] = [
  {
    id: "compose-config",
    title: "Проверка конфигурации Docker Compose",
    command: "docker",
    args: ["compose", "config"],
    cwd: ".",
    required: true
  },
  {
    id: "backend-tests",
    title: "Тесты Go backend",
    command: "go",
    args: ["test", "./..."],
    cwd: "backend",
    required: true
  },
  {
    id: "frontend-install",
    title: "Воспроизводимая установка зависимостей frontend",
    command: "npm",
    args: ["ci"],
    cwd: "frontend",
    required: true
  },
  {
    id: "frontend-tests",
    title: "Тесты frontend",
    command: "npm",
    args: ["test"],
    cwd: "frontend",
    required: true
  },
  {
    id: "frontend-build",
    title: "Сборка frontend",
    command: "npm",
    args: ["run", "build"],
    cwd: "frontend",
    required: true
  }
];

export interface ValidateProjectOptions {
  projectDir: string;
  checks?: ValidationCheck[];
  timeoutMs?: number;
  writeReview?: boolean;
}

export async function getGeneratedWebAppValidationChecks(projectDir: string): Promise<ValidationCheck[]> {
  const hasFrontendLockfile = await fileExists(join(projectDir, "frontend", "package-lock.json"));

  return generatedWebAppValidationChecks.map((check) => {
    if (check.id !== "frontend-install" || hasFrontendLockfile) {
      return check;
    }

    return {
      ...check,
      title: "Установка зависимостей frontend",
      args: ["install"]
    };
  });
}

export async function validateGeneratedWebApp(
  options: ValidateProjectOptions
): Promise<ValidationReport> {
  const startedAt = new Date().toISOString();
  const checks = options.checks ?? await getGeneratedWebAppValidationChecks(options.projectDir);
  const sandbox = new ProjectSandbox({
    rootDir: options.projectDir,
    allowedCommands: Array.from(new Set(checks.map((check) => check.command))),
    timeoutMs: options.timeoutMs
  });

  const results: ValidationCheckResult[] = [];

  for (const check of checks) {
    const commandResult = await sandbox.run(check.command, check.args, check.cwd);
    const passed = commandResult.exitCode === 0 && !commandResult.timedOut;
    results.push({ check, commandResult, passed });

    if (!passed && check.required) {
      break;
    }
  }

  const report: ValidationReport = {
    projectDir: options.projectDir,
    passed: results.every((result) => result.passed || !result.check.required),
    startedAt,
    finishedAt: new Date().toISOString(),
    results
  };

  if (options.writeReview ?? true) {
    await writeFile(join(options.projectDir, "REVIEW.md"), renderReviewMarkdown(report), "utf8");
  }

  return report;
}

export function renderReviewMarkdown(report: ValidationReport): string {
  const lines = [
    "# Отчет проверки",
    "",
    `Статус: ${report.passed ? "успешно" : "ошибка"}`,
    `Начало: ${report.startedAt}`,
    `Завершение: ${report.finishedAt}`,
    "",
    "## Проверки",
    ""
  ];

  for (const result of report.results) {
    const status = result.passed ? "успешно" : "ошибка";
    const command = [result.check.command, ...result.check.args].join(" ");

    lines.push(`### ${result.check.title}`);
    lines.push("");
    lines.push(`- Статус: ${status}`);
    lines.push(`- Команда: \`${command}\``);
    lines.push(`- Директория: \`${result.check.cwd}\``);
    lines.push(`- Код выхода: ${result.commandResult.exitCode ?? "нет"}`);
    lines.push(`- Таймаут: ${result.commandResult.timedOut ? "да" : "нет"}`);
    appendOutput(lines, "stdout", result.commandResult.stdout);
    appendOutput(lines, "stderr", result.commandResult.stderr);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function appendOutput(lines: string[], title: string, output: string): void {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) {
    return;
  }

  lines.push("");
  lines.push(`\`${title}\`:`);
  lines.push("");
  lines.push("```text");
  lines.push(trimmedOutput);
  lines.push("```");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
