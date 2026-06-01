import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseScaffoldArgs,
  parseValidateArgs,
  scaffoldFromSpecFile,
  validateProjectDirectory
} from "./cli.js";

describe("scaffold CLI", () => {
  it("parses required arguments", () => {
    expect(parseScaffoldArgs(["--spec", "spec.json", "--out", "app"])).toEqual({
      specPath: "spec.json",
      outDir: "app"
    });
  });

  it("requires spec and output arguments", () => {
    expect(() => parseScaffoldArgs(["--spec", "spec.json"])).toThrow("Использование");
  });

  it("parses validation arguments", () => {
    expect(parseValidateArgs(["--project", "app"])).toEqual({
      projectDir: "app"
    });
  });

  it("scaffolds a project from a spec file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const specPath = join(rootDir, "book-tracker.spec.json");
    const outDir = join(rootDir, "book-tracker");

    try {
      await writeFile(
        specPath,
        JSON.stringify({
          projectName: "book-tracker",
          description: "Сервис учета книг",
          actors: [{ name: "user" }],
          features: [
            {
              id: "books-crud",
              title: "Управление книгами",
              description: "Создание, редактирование и удаление книг"
            }
          ],
          acceptanceCriteria: ["Пользователь видит только свои книги"]
        }),
        "utf8"
      );

      await expect(scaffoldFromSpecFile({ specPath, outDir })).resolves.toBe(outDir);
      await expect(readFile(join(outDir, "SPEC.json"), "utf8")).resolves.toContain("book-tracker");
      await expect(readFile(join(outDir, "README.md"), "utf8")).resolves.toContain("Шаблон");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates a scaffolded project with an injected lightweight check set", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-cli-"));
    const outDir = join(rootDir, "book-tracker");

    try {
      await writeFile(
        join(rootDir, "book-tracker.spec.json"),
        JSON.stringify({
          projectName: "book-tracker",
          description: "Сервис учета книг",
          actors: [{ name: "user" }],
          features: [
            {
              id: "books-crud",
              title: "Управление книгами",
              description: "Создание, редактирование и удаление книг"
            }
          ],
          acceptanceCriteria: ["Пользователь видит только свои книги"]
        }),
        "utf8"
      );

      await scaffoldFromSpecFile({
        specPath: join(rootDir, "book-tracker.spec.json"),
        outDir
      });

      await expect(
        validateProjectDirectory(
          { projectDir: outDir },
          [
            {
              id: "npm-version",
              title: "Проверка npm",
              command: "npm",
              args: ["--version"],
              cwd: ".",
              required: true
            }
          ]
        )
      ).resolves.toBe(true);
      await expect(readFile(join(outDir, "REVIEW.md"), "utf8")).resolves.toContain("Отчет проверки");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 120_000);
});
