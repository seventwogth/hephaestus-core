import { describe, expect, it } from "vitest";
import { projectSpecSchema } from "./index.js";

describe("projectSpecSchema", () => {
  it("accepts a minimal valid project spec", () => {
    const spec = projectSpecSchema.parse({
      projectName: "book-tracker",
      description: "Track personal books",
      actors: [{ name: "user" }],
      features: [
        {
          id: "books-crud",
          title: "Manage books",
          description: "Create, update, and delete books"
        }
      ],
      acceptanceCriteria: ["User can manage only their own books"]
    });

    expect(spec.requiresAuth).toBe(true);
    expect(spec.requiresDatabase).toBe(true);
  });
});
