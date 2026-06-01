import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ProjectSandbox } from "./index.js";

describe("ProjectSandbox", () => {
  it("reads and writes only inside the project root", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: [] });

    try {
      await sandbox.writeText("nested/file.txt", "ok");
      await expect(sandbox.readText("nested/file.txt")).resolves.toBe("ok");
      expect(() => sandbox.resolveInsideRoot("../outside.txt")).toThrow("escapes");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects commands outside the allowlist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: ["npm"] });

    try {
      await expect(sandbox.run("rm", ["-rf", "."])).rejects.toThrow("not allowed");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
