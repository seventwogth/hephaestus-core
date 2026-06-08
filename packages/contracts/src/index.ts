import { z } from "zod";

const ENTITY_FIELD_TYPES = [
  "string",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "json"
] as const;

const featurePrioritySchema = z.preprocess(
  (value) => {
    if (typeof value === "number") {
      if (value <= 1) {
        return "must";
      }

      if (value === 2) {
        return "should";
      }

      return "could";
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "1") {
        return "must";
      }

      if (normalized === "2") {
        return "should";
      }

      if (normalized === "3") {
        return "could";
      }

      return normalized;
    }

    return value;
  },
  z.enum(["must", "should", "could"]).default("must")
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function normalizeNamedCollection(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.entries(value).map(([name, entry]) => {
    if (isRecord(entry)) {
      return {
        ...entry,
        name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : name
      };
    }

    if (Array.isArray(entry)) {
      return { name, fields: entry };
    }

    if (typeof entry === "string") {
      return { name, description: entry };
    }

    return { name };
  });
}

function normalizeFeatureCollection(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.entries(value).map(([id, entry]) => {
    if (isRecord(entry)) {
      return {
        ...entry,
        id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : id,
        title: typeof entry.title === "string" && entry.title.length > 0 ? entry.title : humanizeKey(id),
        description: typeof entry.description === "string" && entry.description.length > 0
          ? entry.description
          : humanizeKey(id)
      };
    }

    return {
      id,
      title: humanizeKey(id),
      description: typeof entry === "string" && entry.length > 0 ? entry : humanizeKey(id)
    };
  });
}

function normalizeFieldCollection(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return Object.entries(value).map(([name, entry]) => {
    if (isRecord(entry)) {
      return {
        ...entry,
        name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : name
      };
    }

    if (typeof entry === "string") {
      return ENTITY_FIELD_TYPES.includes(entry as (typeof ENTITY_FIELD_TYPES)[number])
        ? { name, type: entry }
        : { name, description: entry };
    }

    return { name };
  });
}

function normalizeStringList(value: unknown): unknown {
  if (value === undefined || Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return [value];
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.entries(value)
    .filter(([, entry]) => entry !== false && entry !== null && entry !== undefined)
    .map(([key, entry]) => {
      if (entry === true) {
        return humanizeKey(key);
      }

      if (typeof entry === "string") {
        return entry;
      }

      return `${humanizeKey(key)}: ${JSON.stringify(entry)}`;
    });
}

export const actorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional()
});

export const featureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: featurePrioritySchema
});

export const entityFieldTypeSchema = z.enum(ENTITY_FIELD_TYPES);

export const entityFieldReferenceSchema = z.object({
  entity: z.string().min(1),
  field: z.string().min(1).default("id"),
  onDelete: z.enum(["restrict", "cascade", "set_null"]).default("restrict")
});

export const entityFieldConfigSchema = z.object({
  name: z.string().min(1),
  type: entityFieldTypeSchema.default("string"),
  required: z.boolean().default(true),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  references: entityFieldReferenceSchema.optional(),
  description: z.string().min(1).optional()
});

export const entityFieldSchema = z
  .union([z.string().min(1), entityFieldConfigSchema])
  .transform((field) => {
    if (typeof field === "string") {
      return {
        name: field,
        type: "string" as const,
        required: true,
        unique: false,
        indexed: false
      };
    }

    return field;
  });

export const entityIndexSchema = z.object({
  name: z.string().min(1).optional(),
  fields: z.array(z.string().min(1)).min(1),
  unique: z.boolean().default(false)
});

export const entitySchema = z.object({
  name: z.string().min(1),
  fields: z.preprocess(normalizeFieldCollection, z.array(entityFieldSchema).default([])),
  indexes: z.array(entityIndexSchema).default([]),
  description: z.string().min(1).optional()
});

export const projectSpecSchema = z.object({
  projectName: z.string().min(1),
  description: z.string().min(1),
  actors: z.preprocess(normalizeNamedCollection, z.array(actorSchema).min(1)),
  features: z.preprocess(normalizeFeatureCollection, z.array(featureSchema).min(1)),
  entities: z.preprocess(normalizeNamedCollection, z.array(entitySchema).default([])),
  requiresAuth: z.boolean().default(true),
  requiresDatabase: z.boolean().default(true),
  constraints: z.preprocess(normalizeStringList, z.array(z.string().min(1)).default([])),
  acceptanceCriteria: z.preprocess(normalizeStringList, z.array(z.string().min(1)).min(1))
});

export const endpointSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  summary: z.string().min(1),
  authRequired: z.boolean().default(true)
});

export const projectPlanSchema = z.object({
  projectName: z.string().min(1),
  stack: z.object({
    frontend: z.literal("react-vite-typescript"),
    backend: z.literal("go-chi"),
    database: z.literal("postgresql"),
    api: z.literal("rest-openapi")
  }),
  backendModules: z.array(z.string().min(1)),
  frontendRoutes: z.array(z.string().startsWith("/")),
  databaseEntities: z.array(entitySchema),
  endpoints: z.array(endpointSchema),
  validationCommands: z.array(z.string().min(1))
});

export const taskSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["requirements", "architecture", "api", "database", "backend", "frontend", "integration", "testing", "fixing", "documentation"]),
  status: z.enum(["pending", "in_progress", "done", "failed"]),
  dependsOn: z.array(z.string().min(1)).default([]),
  files: z.array(z.string().min(1)).default([])
});

export const projectStatusSchema = z.object({
  stage: z.enum([
    "NEW",
    "REQUIREMENTS",
    "SPEC_APPROVAL",
    "PLANNING",
    "GENERATING",
    "TESTING",
    "FIXING",
    "DOCUMENTING",
    "READY",
    "FAILED"
  ]),
  attempts: z.record(z.number().int().nonnegative()).default({}),
  updatedAt: z.string().datetime()
});

export type ProjectSpec = z.infer<typeof projectSpecSchema>;
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export type ProjectTask = z.infer<typeof taskSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type EntityField = z.infer<typeof entityFieldSchema>;
export type EntityFieldConfig = z.infer<typeof entityFieldConfigSchema>;
export type EntityFieldReference = z.infer<typeof entityFieldReferenceSchema>;
export type EntityIndex = z.infer<typeof entityIndexSchema>;
export type ProjectEntity = z.infer<typeof entitySchema>;
