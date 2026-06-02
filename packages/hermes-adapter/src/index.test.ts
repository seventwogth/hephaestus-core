import { describe, expect, it } from "vitest";
import { StubModelProvider } from "./index.js";

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
