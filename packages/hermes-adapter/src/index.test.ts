import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandModelProvider, OllamaModelProvider, StubModelProvider } from "./index.js";

describe("StubModelProvider", () => {
  it("returns a deterministic agent result", async () => {
    const provider = new StubModelProvider();

    const result = await provider.generate({
      role: "architect",
      instruction: "Create a plan",
      files: [{ path: "SPEC.json", content: "{}" }],
      writableFiles: ["PLAN.json"]
    });

    expect(result.role).toBe("architect");
    expect(result.summary).toContain("architect");
    expect(result.updatedFiles).toEqual([]);
    expect(result.rawOutput).toContain("SPEC.json");
  });
});

describe("CommandModelProvider", () => {
  it("runs an external command and parses AgentRunResult", async () => {
    const provider = new CommandModelProvider({
      command: "sh",
      args: [
        "-c",
        "printf '%s' '{\"summary\":\"Handled architect\",\"changedFiles\":[\"PLAN.json\"],\"updatedFiles\":[{\"path\":\"PLAN.json\",\"content\":\"{\\\"ok\\\":true}\\\\n\"}],\"rawOutput\":\"provider-output\"}'"
      ]
    });

    const result = await provider.generate({
      role: "architect",
      instruction: "Create a plan",
      files: [{ path: "SPEC.json", content: "{}" }],
      writableFiles: ["PLAN.json"]
    });

    expect(result.summary).toBe("Handled architect");
    expect(result.changedFiles).toEqual(["PLAN.json"]);
    expect(result.updatedFiles[0]?.path).toBe("PLAN.json");
  });
});

describe("OllamaModelProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the local Ollama API and parses AgentRunResult", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async json() {
        return {
          response: JSON.stringify({
            summary: "Generated backend",
            changedFiles: ["backend/main.go"],
            updatedFiles: [
              {
                path: "backend/main.go",
                content: "package main\n"
              }
            ]
          })
        };
      }
    });

    vi.stubGlobal("fetch", fetchMock);

    const provider = new OllamaModelProvider({
      model: "qwen2.5-coder:14b",
      baseUrl: "http://127.0.0.1:11434"
    });

    const result = await provider.generate({
      role: "backend",
      instruction: "Generate the backend",
      files: [{ path: "PLAN.json", content: "{\"projectName\":\"demo\"}" }],
      writableFiles: ["backend"]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/generate",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(result.summary).toBe("Generated backend");
    expect(result.updatedFiles[0]?.path).toBe("backend/main.go");
  });
});
