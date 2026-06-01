import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  renderReviewMarkdown,
  validateGeneratedWebApp,
  type ValidationCheck,
  type ValidationReport
} from "./index.js";

describe("project validator", () => {
  it("renders a Russian REVIEW.md report", () => {
    const report: ValidationReport = {
      projectDir: "/tmp/project",
      passed: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      results: [
        {
          passed: true,
          check: {
            id: "fake",
            title: "Проверка",
            command: "node",
            args: ["--version"],
            cwd: ".",
            required: true
          },
          commandResult: {
            command: "node",
            args: ["--version"],
            cwd: "/tmp/project",
            exitCode: 0,
            stdout: "v1\n",
            stderr: "",
            timedOut: false
          }
        }
      ]
    };

    expect(renderReviewMarkdown(report)).toContain("# Отчет проверки");
    expect(renderReviewMarkdown(report)).toContain("Статус: успешно");
  });

  it("runs checks and writes REVIEW.md", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-validation-"));
    const checks: ValidationCheck[] = [
      {
        id: "npm-version",
        title: "Проверка npm",
        command: "npm",
        args: ["--version"],
        cwd: ".",
        required: true
      }
    ];

    try {
      const report = await validateGeneratedWebApp({ projectDir, checks });
      const review = await readFile(join(projectDir, "REVIEW.md"), "utf8");

      expect(report.passed).toBe(true);
      expect(review).toContain("Проверка npm");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("stops after a required failed check", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-validation-"));
    const scriptPath = join(projectDir, "package.json");
    const checks: ValidationCheck[] = [
      {
        id: "missing-script",
        title: "Отсутствующий npm-скрипт",
        command: "npm",
        args: ["run", "missing"],
        cwd: ".",
        required: true
      },
      {
        id: "not-run",
        title: "Не должна запускаться",
        command: "npm",
        args: ["--version"],
        cwd: ".",
        required: true
      }
    ];

    try {
      await writeFile(scriptPath, "{\"scripts\":{}}\n", "utf8");
      const report = await validateGeneratedWebApp({ projectDir, checks });

      expect(report.passed).toBe(false);
      expect(report.results).toHaveLength(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
