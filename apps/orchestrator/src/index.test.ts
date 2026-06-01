import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { StubModelProvider } from "@hephaestus/hermes-adapter";
import { FileProjectStateStore, Orchestrator } from "./index.js";

describe("Orchestrator", () => {
  it("initializes project artifacts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));

      expect(status.stage).toBe("SPEC_APPROVAL");
      expect(tasks.tasks).toHaveLength(8);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("scaffolds the generated application template with project artifacts", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.scaffoldProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      await expect(readFile(join(projectDir, "backend/go.mod"), "utf8")).resolves.toContain("module");
      await expect(readFile(join(projectDir, "frontend/package.json"), "utf8")).resolves.toContain("vite");
      await expect(readFile(join(projectDir, "SPEC.json"), "utf8")).resolves.toContain("book-tracker");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("runs an agent stage with scoped file context", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(
        new FileProjectStateStore(),
        new StubModelProvider()
      );

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const result = await orchestrator.runAgentStage(projectDir, {
        role: "architect",
        instruction: "Create a project plan",
        contextFiles: ["SPEC.json"],
        writableFiles: ["PLAN.json"],
        validationCommand: "npm test"
      });

      const log = await readFile(join(projectDir, "AGENT_RUNS.jsonl"), "utf8");

      expect(result.summary).toContain("architect");
      expect(log).toContain("SPEC.json");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("creates architecture plan from stored spec", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [{ name: "Book", fields: ["title", "author"] }],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const plan = await orchestrator.planProject(projectDir);
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const architectureTask = tasks.tasks.find((task: { id: string }) => task.id === "architecture");

      expect(plan.backendModules).toContain("books");
      expect(status.stage).toBe("GENERATING");
      expect(architectureTask.status).toBe("done");
      await expect(readFile(join(projectDir, "PLAN.json"), "utf8")).resolves.toContain("/api/books");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("moves project to READY after successful validation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.validateProjectStage(projectDir, {
        checks: [
          {
            id: "npm-version",
            title: "Проверка npm",
            command: "npm",
            args: ["--version"],
            cwd: ".",
            required: true
          }
        ]
      });
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const testingTask = tasks.tasks.find((task: { id: string }) => task.id === "testing");

      expect(report.passed).toBe(true);
      expect(status.stage).toBe("READY");
      expect(testingTask.status).toBe("done");
      await expect(readFile(join(projectDir, "REVIEW.md"), "utf8")).resolves.toContain("Отчет проверки");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("moves project to FAILED after unsuccessful validation", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-project-"));

    try {
      const orchestrator = new Orchestrator(new FileProjectStateStore());

      await orchestrator.initializeProject(projectDir, {
        projectName: "book-tracker",
        description: "Track personal books",
        actors: [{ name: "user" }],
        features: [
          {
            id: "books-crud",
            title: "Manage books",
            description: "Create, update, and delete books",
            priority: "must"
          }
        ],
        entities: [],
        requiresAuth: true,
        requiresDatabase: true,
        constraints: [],
        acceptanceCriteria: ["User can manage only their own books"]
      });

      const report = await orchestrator.validateProjectStage(projectDir, {
        checks: [
          {
            id: "missing-script",
            title: "Отсутствующий npm-скрипт",
            command: "npm",
            args: ["run", "missing"],
            cwd: ".",
            required: true
          }
        ]
      });
      const status = JSON.parse(await readFile(join(projectDir, "STATUS.json"), "utf8"));
      const tasks = JSON.parse(await readFile(join(projectDir, "TASKS.json"), "utf8"));
      const testingTask = tasks.tasks.find((task: { id: string }) => task.id === "testing");

      expect(report.passed).toBe(false);
      expect(status.stage).toBe("FAILED");
      expect(testingTask.status).toBe("failed");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
