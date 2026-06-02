import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  listGeneratedWebAppTemplateFiles,
  materializeGeneratedWebApp
} from "./index.js";

describe("generated web app template", () => {
  it("lists source files without local build artifacts", async () => {
    const files = await listGeneratedWebAppTemplateFiles();

    expect(files).toContain("backend/go.mod");
    expect(files).toContain("backend/migrations/migrations.go");
    expect(files).toContain("frontend/package.json");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
    expect(files.some((file) => file.includes("dist/"))).toBe(false);
    expect(files.some((file) => file.endsWith(".tsbuildinfo"))).toBe(false);
  });

  it("materializes the generated web app template", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "hephaestus-template-"));

    try {
      await materializeGeneratedWebApp({ targetDir });

      await expect(access(join(targetDir, "backend/go.mod"))).resolves.toBeUndefined();
      await expect(access(join(targetDir, "backend/migrations/0001_generated_schema.sql"))).resolves.toBeUndefined();
      await expect(access(join(targetDir, "frontend/package.json"))).resolves.toBeUndefined();
      await expect(access(join(targetDir, "docker-compose.yml"))).resolves.toBeUndefined();
      await expect(access(join(targetDir, "frontend/node_modules"))).rejects.toThrow();
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
