import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createArchitecturePlan, analyzeRequirements } from "@hephaestus/agents";
import { materializeGeneratedWebApp } from "@hephaestus/templates";
import { generateGoBackend } from "./index.js";

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

      expect(files.map((file) => file.path)).toContain("backend/internal/http/generated_routes.go");
      expect(routes).toContain('router.Route("/books"');
      expect(routes).toContain("type Book struct");
      expect(routeTest).toContain("TestGeneratedResourceCRUD");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
