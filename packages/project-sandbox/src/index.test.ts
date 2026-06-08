import { access, chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildCommandSpec, parseSandboxRunnerFromEnv, ProjectSandbox } from "./index.js";

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

  it("builds a docker command spec with mounted workspace and resource limits", () => {
    const spec = buildCommandSpec({
      runner: {
        type: "docker",
        image: "hephaestus/validation:latest",
        network: "none",
        cpus: "1.5",
        memory: "512m",
        storageSize: "2g",
        pidsLimit: 128
      },
      rootDir: "/tmp/project",
      command: "npm",
      args: ["test"],
      cwd: "frontend",
      env: {
        HOME: "/workspace/.hephaestus-home",
        PATH: "/usr/bin",
        HEPHAESTUS_EXPLICIT_ENV: "visible"
      }
    });

    expect(spec.runner).toBe("docker");
    expect(spec.runnerNetwork).toBe("none");
    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      "type=bind,src=/tmp/project,dst=/workspace",
      "-w",
      "/workspace/frontend",
      "--cpus",
      "1.5",
      "--memory",
      "512m",
      "--storage-opt",
      "size=2g",
      "--pids-limit",
      "128",
      "--env",
      "HEPHAESTUS_EXPLICIT_ENV=visible",
      "--env",
      "HOME=/workspace/.hephaestus-home",
      "--env",
      "PATH=/usr/bin",
      "hephaestus/validation:latest",
      "npm",
      "test"
    ]);
    expect(spec.hostEnv).not.toHaveProperty("HEPHAESTUS_EXPLICIT_ENV");
  });

  it("builds a docker command spec with a quota-managed tmpfs workspace", () => {
    const spec = buildCommandSpec({
      runner: {
        type: "docker",
        image: "hephaestus/validation:latest",
        network: "none",
        workspaceDiskLimit: "64m"
      },
      rootDir: "/tmp/project",
      command: "npm",
      args: ["test"],
      cwd: "frontend",
      env: {
        HOME: "/workspace/.hephaestus-home",
        PATH: "/usr/bin"
      }
    });

    expect(spec.command).toBe("docker");
    expect(spec.args).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      "type=bind,src=/tmp/project,dst=/hephaestus-host-workspace",
      "--mount",
      "type=tmpfs,dst=/workspace,tmpfs-size=64m",
      "-w",
      "/workspace",
      "--env",
      "HOME=/workspace/.hephaestus-home",
      "--env",
      "PATH=/usr/bin",
      "hephaestus/validation:latest",
      "sh",
      "-lc",
      expect.stringContaining("cp -a \"$host_workspace/.\" \"$workspace/\""),
      "hephaestus-quota-run",
      "/hephaestus-host-workspace",
      "/workspace",
      "/workspace/frontend",
      "npm",
      "test"
    ]);
  });

  it("allows per-run docker runner overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({
      rootDir,
      allowedCommands: ["/usr/bin/env"],
      runner: { type: "host" }
    });

    try {
      const result = await sandbox.run("/usr/bin/env", [], ".", {
        runner: { type: "host" }
      });

      expect(result.runner).toBe("host");
      expect(result.runnerNetwork).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("parses docker sandbox runner settings from env", () => {
    expect(
      parseSandboxRunnerFromEnv({
        HEPHAESTUS_SANDBOX_RUNNER: "docker",
        HEPHAESTUS_SANDBOX_IMAGE: "hephaestus/validation:prod",
        HEPHAESTUS_SANDBOX_NETWORK: "bridge",
        HEPHAESTUS_SANDBOX_CPUS: "2",
        HEPHAESTUS_SANDBOX_MEMORY: "1g",
        HEPHAESTUS_SANDBOX_STORAGE_SIZE: "8g",
        HEPHAESTUS_SANDBOX_WORKSPACE_DISK_LIMIT: "512m",
        HEPHAESTUS_SANDBOX_PIDS_LIMIT: "256"
      })
    ).toEqual({
      type: "docker",
      image: "hephaestus/validation:prod",
      dockerCommand: undefined,
      workspaceMount: undefined,
      network: "bridge",
      user: undefined,
      cpus: "2",
      memory: "1g",
      storageSize: "8g",
      workspaceDiskLimit: "512m",
      pidsLimit: 256
    });
  });

  it("rejects unsupported sandbox runner env values", () => {
    expect(() => parseSandboxRunnerFromEnv({ HEPHAESTUS_SANDBOX_RUNNER: "firecracker" })).toThrow("Unsupported");
    expect(() => parseSandboxRunnerFromEnv({
      HEPHAESTUS_SANDBOX_RUNNER: "docker",
      HEPHAESTUS_SANDBOX_PIDS_LIMIT: "0"
    })).toThrow("Invalid HEPHAESTUS_SANDBOX_PIDS_LIMIT");
  });

  it("prunes workspace artifacts outside the allowlist", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "hephaestus-sandbox-"));
    const sandbox = new ProjectSandbox({ rootDir, allowedCommands: [] });

    try {
      await mkdir(join(rootDir, "backend", "tmp"), { recursive: true });
      await mkdir(join(rootDir, "frontend"), { recursive: true });
      await writeFile(join(rootDir, "README.md"), "# app\n", "utf8");
      await writeFile(join(rootDir, "backend", "go.mod"), "module app\n", "utf8");
      await writeFile(join(rootDir, "backend", "tmp", "scratch.txt"), "scratch\n", "utf8");
      await writeFile(join(rootDir, "frontend", "debug.log"), "debug\n", "utf8");
      await writeFile(join(rootDir, "secret.env"), "TOKEN=secret\n", "utf8");

      const report = await sandbox.pruneArtifacts(["README.md", "backend/go.mod"]);

      await expect(readFile(join(rootDir, "README.md"), "utf8")).resolves.toContain("# app");
      await expect(readFile(join(rootDir, "backend", "go.mod"), "utf8")).resolves.toContain("module app");
      await expect(access(join(rootDir, "backend", "tmp"))).rejects.toThrow();
      await expect(access(join(rootDir, "frontend"))).rejects.toThrow();
      await expect(access(join(rootDir, "secret.env"))).rejects.toThrow();
      expect(report.keptPaths).toContain("README.md");
      expect(report.keptPaths).toContain("backend");
      expect(report.keptPaths).toContain("backend/go.mod");
      expect(report.removedPaths).toEqual(["backend/tmp", "frontend", "secret.env"]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
