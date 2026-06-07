import { z } from "zod";

export const actorSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional()
});

export const featureSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(["must", "should", "could"]).default("must")
});

export const entityFieldTypeSchema = z.enum([
  "string",
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "json"
]);

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
  fields: z.array(entityFieldSchema).default([]),
  indexes: z.array(entityIndexSchema).default([]),
  description: z.string().min(1).optional()
});

export const projectSpecSchema = z.object({
  projectName: z.string().min(1),
  description: z.string().min(1),
  actors: z.array(actorSchema).min(1),
  features: z.array(featureSchema).min(1),
  entities: z.array(entitySchema).default([]),
  requiresAuth: z.boolean().default(true),
  requiresDatabase: z.boolean().default(true),
  constraints: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1)
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
