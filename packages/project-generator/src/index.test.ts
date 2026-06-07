import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createArchitecturePlan, analyzeRequirements } from "@hephaestus/agents";
import type { ProjectPlan } from "@hephaestus/contracts";
import { materializeGeneratedWebApp } from "@hephaestus/templates";
import { generateDatabaseArtifacts, generateGoBackend, generateReactFrontend } from "./index.js";

function createTaskProjectPlan(): ProjectPlan {
  return {
    projectName: "task-manager",
    stack: {
      frontend: "react-vite-typescript",
      backend: "go-chi",
      database: "postgresql",
      api: "rest-openapi"
    },
    backendModules: ["tasks", "projects"],
    frontendRoutes: ["/tasks", "/projects"],
    databaseEntities: [
      {
        name: "Task",
        fields: [
          { name: "title", type: "string", required: true, unique: false, indexed: false },
          { name: "completed", type: "boolean", required: true, unique: false, indexed: true, defaultValue: false },
          {
            name: "projectId",
            type: "integer",
            required: true,
            unique: false,
            indexed: true,
            references: {
              entity: "Project",
              field: "id",
              onDelete: "cascade"
            }
          }
        ],
        indexes: [{ fields: ["projectId", "title"], unique: true }]
      },
      {
        name: "Project",
        fields: [
          { name: "title", type: "string", required: true, unique: true, indexed: false }
        ],
        indexes: []
      }
    ],
    endpoints: [
      { method: "GET", path: "/api/tasks", summary: "List tasks", authRequired: true },
      { method: "GET", path: "/api/projects", summary: "List projects", authRequired: true }
    ],
    validationCommands: []
  };
}

describe("generateDatabaseArtifacts", () => {
  it("writes SQL migrations for the primary resource", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const spec = analyzeRequirements({
        text: "Создай сервис учета книг. Пользователь должен добавлять книги и менять статус."
      });
      const plan = createArchitecturePlan(spec);
      const files = await generateDatabaseArtifacts({ projectDir, plan });
      const migration = await readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8");

      expect(files.map((file) => file.path)).toContain("backend/migrations/0001_generated_schema.sql");
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS books");
      expect(migration).toContain("author TEXT NOT NULL");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes multiple tables with relations, types and indexes", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const files = await generateDatabaseArtifacts({
        projectDir,
        plan: createTaskProjectPlan()
      });
      const migration = await readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8");

      expect(files.map((file) => file.path)).toContain("backend/migrations/0001_generated_schema.sql");
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS projects");
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS tasks");
      expect(migration).toContain("completed BOOLEAN NOT NULL DEFAULT FALSE");
      expect(migration).toContain("REFERENCES projects (id) ON DELETE CASCADE");
      expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_id_title_idx");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("generateGoBackend", () => {
  it("writes generated Go routes for the primary resource", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const spec = analyzeRequirements({
        text: "Создай сервис учета книг. Пользователь должен добавлять книги и менять статус."
      });
      const plan = createArchitecturePlan(spec);
      const files = await generateGoBackend({ projectDir, plan });
      const routes = await readFile(join(projectDir, "backend/internal/http/generated_routes.go"), "utf8");
      const routeTest = await readFile(join(projectDir, "backend/internal/http/generated_routes_test.go"), "utf8");
      const migration = await readFile(join(projectDir, "backend/migrations/0001_generated_schema.sql"), "utf8");

      expect(files.map((file) => file.path)).toContain("backend/internal/http/generated_routes.go");
      expect(routes).toContain('router.Route("/books"');
      expect(routes).toContain("type postgresBookStore struct");
      expect(routeTest).toContain("TestGeneratedBookResourceCRUD");
      expect(migration).toContain("CREATE TABLE IF NOT EXISTS books");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes generated Go routes and tests for multiple resources", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const files = await generateGoBackend({ projectDir, plan: createTaskProjectPlan() });
      const routes = await readFile(join(projectDir, "backend/internal/http/generated_routes.go"), "utf8");
      const routeTest = await readFile(join(projectDir, "backend/internal/http/generated_routes_test.go"), "utf8");

      expect(files.map((file) => file.path)).toContain("backend/internal/http/generated_routes.go");
      expect(routes).toContain('router.Route("/tasks"');
      expect(routes).toContain('router.Route("/projects"');
      expect(routes).toContain("type postgresTaskStore struct");
      expect(routes).toContain("type postgresProjectStore struct");
      expect(routeTest).toContain("TestGeneratedTaskResourceCRUD");
      expect(routeTest).toContain("TestGeneratedProjectResourceCRUD");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes generated React files for the primary resource", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const spec = analyzeRequirements({
        text: "Создай сервис учета книг. Пользователь должен добавлять книги и менять статус."
      });
      const plan = createArchitecturePlan(spec);
      const files = await generateReactFrontend({ projectDir, plan });
      const main = await readFile(join(projectDir, "frontend/src/main.tsx"), "utf8");
      const api = await readFile(join(projectDir, "frontend/src/api.ts"), "utf8");

      expect(files.map((file) => file.path)).toContain("frontend/src/api.ts");
      expect(main).toContain("resourceDefinitions.map");
      expect(api).toContain("\"title\": \"Учет книг\"");
      expect(api).toContain("\"resourceName\": \"books\"");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("writes generated React files for multiple resources", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "hephaestus-generator-"));

    try {
      await materializeGeneratedWebApp({ targetDir: projectDir });
      const files = await generateReactFrontend({ projectDir, plan: createTaskProjectPlan() });
      const main = await readFile(join(projectDir, "frontend/src/main.tsx"), "utf8");
      const api = await readFile(join(projectDir, "frontend/src/api.ts"), "utf8");

      expect(files.map((file) => file.path)).toContain("frontend/src/api.ts");
      expect(main).toContain("resourceDefinitions.map");
      expect(api).toContain("\"resourceName\": \"tasks\"");
      expect(api).toContain("\"resourceName\": \"projects\"");
      expect(api).toContain("\"title\": \"Задачи\"");
      expect(api).toContain("\"title\": \"Проекты\"");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
