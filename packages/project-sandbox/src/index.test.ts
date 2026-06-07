import { access, chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

  it("does not inherit host secrets when running commands", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: ["/usr/bin/env"] });
    const previousSecret = process.env.HEPHAESTUS_TEST_SECRET;
    process.env.HEPHAESTUS_TEST_SECRET = "host-secret";

    try {
      const result = await sandbox.run("/usr/bin/env");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("HEPHAESTUS_TEST_SECRET=host-secret");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.HEPHAESTUS_TEST_SECRET;
      } else {
        process.env.HEPHAESTUS_TEST_SECRET = previousSecret;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows explicit command env overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({
      rootDir,
      allowedCommands: ["/usr/bin/env"],
      env: { HEPHAESTUS_EXPLICIT_ENV: "visible" }
    });

    try {
      const result = await sandbox.run("/usr/bin/env");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("HEPHAESTUS_EXPLICIT_ENV=visible");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects symlink reads and writes that escape the project root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-parent-"));
    const rootDir = join(parentDir, "root");
    const outsideFile = join(parentDir, "outside.txt");
    await mkdir(rootDir);
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, join(rootDir, "link.txt"));

    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: [] });

    try {
      await expect(sandbox.readText("link.txt")).rejects.toThrow("escapes");
      await expect(sandbox.writeText("link.txt", "overwrite")).rejects.toThrow("escapes");
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("rejects command cwd symlinks that escape the project root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-parent-"));
    const rootDir = join(parentDir, "root");
    const outsideDir = join(parentDir, "outside");
    await mkdir(rootDir);
    await mkdir(outsideDir);
    await symlink(outsideDir, join(rootDir, "outside-link"));

    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: [process.execPath] });

    try {
      await expect(sandbox.run(process.execPath, ["-e", ""], "outside-link")).rejects.toThrow("not a directory");
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("rejects hardlinked files", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-parent-"));
    const rootDir = join(parentDir, "root");
    const outsideFile = join(parentDir, "outside.txt");
    const hardlinkPath = join(rootDir, "hardlink.txt");
    await mkdir(rootDir);
    await writeFile(outsideFile, "secret", "utf8");
    await link(outsideFile, hardlinkPath);

    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: [] });

    try {
      await expect(sandbox.readText("hardlink.txt")).rejects.toThrow("Hardlinked");
      await expect(sandbox.writeText("hardlink.txt", "overwrite")).rejects.toThrow("Hardlinked");
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });

  it("marks runaway commands as timed out", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({
      rootDir,
      allowedCommands: [process.execPath],
      timeoutMs: 10
    });

    try {
      const result = await sandbox.run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("caps command output and reports truncation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({
      rootDir,
      allowedCommands: ["/usr/bin/printf"],
      maxOutputBytes: 5
    });

    try {
      const result = await sandbox.run("/usr/bin/printf", ["abcdefghijklmnop"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abcde");
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("cleans workspace runtime directories with read-only cache files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: ["/usr/bin/env"] });
    const readOnlyCacheFile = join(rootDir, ".hephaestus-cache", "go-mod", "readonly.txt");

    try {
      await sandbox.run("/usr/bin/env");
      await writeFile(readOnlyCacheFile, "cached", "utf8");
      await chmod(readOnlyCacheFile, 0o400);

      await sandbox.cleanupRuntimeDirs();

      await expect(access(join(rootDir, ".hephaestus-home"))).rejects.toThrow();
      await expect(access(join(rootDir, ".hephaestus-tmp"))).rejects.toThrow();
      await expect(access(join(rootDir, ".hephaestus-cache"))).rejects.toThrow();
    } finally {
      await chmod(rootDir, 0o700);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not treat shell-like command strings as allowlisted commands", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: ["npm"] });

    try {
      await expect(sandbox.run("npm && rm", [])).rejects.toThrow("not allowed");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
