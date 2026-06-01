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
});
