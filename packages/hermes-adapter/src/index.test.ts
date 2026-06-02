import { describe, expect, it } from "vitest";
import { CommandModelProvider, StubModelProvider } from "./index.js";

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
