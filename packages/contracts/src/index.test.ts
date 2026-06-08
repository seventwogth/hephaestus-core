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

  it("normalizes legacy string fields into typed field configs", () => {
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
      entities: [
        {
          name: "Book",
          fields: ["title", "author"]
        }
      ],
      acceptanceCriteria: ["User can manage only their own books"]
    });

    expect(spec.entities[0]?.fields[0]).toMatchObject({
      name: "title",
      type: "string",
      required: true
    });
  });

  it("normalizes common model-shaped object collections", () => {
    const spec = projectSpecSchema.parse({
      projectName: "book-tracker",
      description: "Track personal books",
      actors: {
        user: "Primary user"
      },
      features: [
        {
          id: "books-crud",
          title: "Manage books",
          description: "Create, update, and delete books",
          priority: 1
        }
      ],
      entities: {
        Book: {
          fields: {
            title: "string",
            summary: "Short public description"
          }
        }
      },
      constraints: {
        offlineFirst: true,
        locale: "Russian UI"
      },
      acceptanceCriteria: {
        manageOwnBooks: "User can manage only their own books"
      }
    });

    expect(spec.features[0]?.priority).toBe("must");
    expect(spec.entities[0]?.name).toBe("Book");
    expect(spec.entities[0]?.fields[0]).toMatchObject({
      name: "title",
      type: "string"
    });
    expect(spec.entities[0]?.fields[1]).toMatchObject({
      name: "summary",
      type: "string",
      description: "Short public description"
    });
    expect(spec.constraints).toEqual(["OfflineFirst", "Russian UI"]);
    expect(spec.acceptanceCriteria).toEqual(["User can manage only their own books"]);
  });

  it("accepts typed fields, indexes and references", () => {
    const spec = projectSpecSchema.parse({
      projectName: "task-manager",
      description: "Track tasks",
      actors: [{ name: "user" }],
      features: [
        {
          id: "tasks",
          title: "Manage tasks",
          description: "Create and update tasks"
        }
      ],
      entities: [
        {
          name: "Project",
          fields: [
            { name: "title", type: "string", unique: true }
          ]
        },
        {
          name: "Task",
          fields: [
            { name: "title", type: "string" },
            { name: "estimateHours", type: "number", required: false, defaultValue: 0 },
            {
              name: "projectId",
              type: "integer",
              indexed: true,
              references: {
                entity: "Project",
                field: "id",
                onDelete: "cascade"
              }
            }
          ],
          indexes: [
            {
              fields: ["projectId", "title"],
              unique: true
            }
          ]
        }
      ],
      acceptanceCriteria: ["User can manage tasks"]
    });

    expect(spec.entities[1]?.fields[1]).toMatchObject({
      name: "estimateHours",
      type: "number",
      defaultValue: 0
    });
    expect(spec.entities[1]?.indexes[0]?.fields).toEqual(["projectId", "title"]);
  });
});
