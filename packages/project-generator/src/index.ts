import {
  type EntityField,
  type EntityIndex,
  type ProjectEntity,
  type ProjectPlan,
  projectPlanSchema
} from "@hephaestus/contracts";
import { ProjectSandbox } from "@hephaestus/project-sandbox";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateDatabaseOptions {
  projectDir: string;
  plan: ProjectPlan;
}

export interface GenerateBackendOptions {
  projectDir: string;
  plan: ProjectPlan;
}

export interface GenerateFrontendOptions {
  projectDir: string;
  plan: ProjectPlan;
}

export async function generateDatabaseArtifacts(
  options: GenerateDatabaseOptions
): Promise<GeneratedFile[]> {
  const plan = projectPlanSchema.parse(options.plan);
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: defaultEntityFields(["title", "description", "status"])
  };
  const resourceName = inferResourceName(plan);
  const files = [
    {
      path: "backend/migrations/0001_generated_schema.sql",
      content: renderDatabaseMigration(plan.databaseEntities.length > 0 ? plan.databaseEntities : [entity])
    }
  ];

  await writeGeneratedFiles(options.projectDir, files);
  return files;
}

export async function generateGoBackend(options: GenerateBackendOptions): Promise<GeneratedFile[]> {
  const plan = projectPlanSchema.parse(options.plan);
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: defaultEntityFields(["title", "description", "status"])
  };
  const resourceName = inferResourceName(plan);
  const files = [
    ...buildDatabaseFiles(plan),
    {
      path: "backend/internal/http/generated_routes.go",
      content: renderGeneratedRoutes(resourceName, entity.name, entity.fields)
    },
    {
      path: "backend/internal/http/generated_routes_test.go",
      content: renderGeneratedRoutesTest(resourceName, entity.name, entity.fields)
    }
  ];

  await writeGeneratedFiles(options.projectDir, files);
  return files;
}

export async function generateReactFrontend(options: GenerateFrontendOptions): Promise<GeneratedFile[]> {
  const plan = projectPlanSchema.parse(options.plan);
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: defaultEntityFields(["title", "description", "status"])
  };
  const resourceName = inferResourceName(plan);
  const files = [
    {
      path: "frontend/src/api.ts",
      content: renderApiClient(resourceName, entity.name, entity.fields)
    },
    {
      path: "frontend/src/main.tsx",
      content: renderFrontendApp(entity.name, entity.fields)
    },
    {
      path: "frontend/src/styles.css",
      content: renderFrontendStyles()
    }
  ];

  await writeGeneratedFiles(options.projectDir, files);
  return files;
}

function buildDatabaseFiles(plan: ProjectPlan): GeneratedFile[] {
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: defaultEntityFields(["title", "description", "status"])
  };

  return [
    {
      path: "backend/migrations/0001_generated_schema.sql",
      content: renderDatabaseMigration(plan.databaseEntities.length > 0 ? plan.databaseEntities : [entity])
    }
  ];
}

async function writeGeneratedFiles(projectDir: string, files: GeneratedFile[]): Promise<void> {
  const sandbox = new ProjectSandbox({ rootDir: projectDir, allowedCommands: [] });

  for (const file of files) {
    await sandbox.writeText(file.path, file.content);
  }
}

function inferResourceName(plan: ProjectPlan): string {
  const resourceEndpoint = plan.endpoints.find((endpoint) => {
    const parts = endpoint.path.split("/").filter(Boolean);
    return endpoint.method === "GET" && parts.length === 2 && parts[0] === "api";
  });

  if (resourceEndpoint) {
    return resourceEndpoint.path.split("/").filter(Boolean)[1]!;
  }

  return inferResourceNameFromEntity(plan.databaseEntities[0]?.name ?? "Item");
}

function renderDatabaseMigration(entities: ProjectEntity[]): string {
  const orderedEntities = sortEntitiesByDependencies(entities);
  const statements: string[] = [];

  for (const entity of orderedEntities) {
    const tableName = toSqlName(inferResourceNameFromEntity(entity.name));
    const fields = normalizedEntityFields(entity.fields);
    const columns = fields.map((field) => renderColumnDefinition(field));
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${tableName} (\n  id BIGSERIAL PRIMARY KEY${
        columns.length > 0 ? ",\n" : ""
      }${columns.join(",\n")}\n);`
    );

    for (const statement of renderIndexStatements(entity, tableName, fields)) {
      statements.push(statement);
    }
  }

  return `-- Generated schema for ${orderedEntities.map((entity) => entity.name).join(", ")}.\n${statements.join("\n\n")}\n`;
}

function renderGeneratedRoutes(resourceName: string, entityName: string, fields: EntityField[]): string {
  const modelName = toGoIdentifier(entityName);
  const variableName = lowerFirst(modelName);
  const routeTypeName = `generated${modelName}Routes`;
  const routeFactoryName = `newGenerated${modelName}Routes`;
  const storeTypeName = `${variableName}Store`;
  const postgresStoreTypeName = `postgres${modelName}Store`;
  const notFoundName = `err${modelName}NotFound`;
  const createInputName = `create${modelName}Input`;
  const updateInputName = `update${modelName}Input`;
  const tableName = toSqlName(resourceName);
  const entityFields = normalizedEntityFields(fields).map((field) => field.name);
  const structFields = ["id", ...entityFields].map((field) => {
    const jsonName = toJsonName(field);
    return `\t${toGoIdentifier(field)} string \`json:"${jsonName}"\``;
  });
  const createPayloadFields = entityFields.map((field) => {
    const jsonName = toJsonName(field);
    return `\t${toGoIdentifier(field)} string \`json:"${jsonName}"\``;
  });
  const updatePayloadFields = entityFields.map((field) => {
    const jsonName = toJsonName(field);
    return `\t${toGoIdentifier(field)} *string \`json:"${jsonName}"\``;
  });
  const scanArgs = ["&item.Id", ...entityFields.map((field) => `&item.${toGoIdentifier(field)}`)].join(", ");
  const persistedScanArgs = ["&persisted.Id", ...entityFields.map((field) => `&persisted.${toGoIdentifier(field)}`)].join(", ");
  const returningColumns = renderReturningColumns(entityFields);
  const insertArgs = entityFields.map((field) => `input.${toGoIdentifier(field)}`);
  const updateAssignments = entityFields.map((field, index) => {
    const columnName = toSqlName(field);
    return `\t\t${columnName} = COALESCE($${index + 2}, ${columnName})`;
  });
  const updateArgs = entityFields.map((field) => `nullableString(input.${toGoIdentifier(field)})`);
  const updateCopyLines = entityFields.map((field) => {
    const goField = toGoIdentifier(field);
    return `\tif input.${goField} != nil {\n\t\tpersisted.${goField} = *input.${goField}\n\t}`;
  });

  return `package http

import (
\t"context"
\t"database/sql"
\t"encoding/json"
\t"errors"
\t"fmt"
\t"net/http"

\t"github.com/go-chi/chi/v5"
)

type ${modelName} struct {
${structFields.join("\n")}
}

type ${createInputName} struct {
${createPayloadFields.length > 0 ? createPayloadFields.join("\n") : ""}
}

type ${updateInputName} struct {
${updatePayloadFields.length > 0 ? updatePayloadFields.join("\n") : ""}
}

type ${storeTypeName} interface {
\tList${modelName}s(ctx context.Context) ([]${modelName}, error)
\tCreate${modelName}(ctx context.Context, input ${createInputName}) (${modelName}, error)
\tUpdate${modelName}(ctx context.Context, id string, input ${updateInputName}) (${modelName}, error)
\tDelete${modelName}(ctx context.Context, id string) error
}

var ${notFoundName} = errors.New("${toJsonName(entityName)} not found")

type ${routeTypeName} struct {
\tstore ${storeTypeName}
}

type ${postgresStoreTypeName} struct {
\tdb *sql.DB
}

func NewGeneratedRouteRegistrar(db *sql.DB) GeneratedRouteRegistrar {
\tif db == nil {
\t\treturn noopGeneratedRouteRegistrar{}
\t}

\treturn ${routeFactoryName}(&${postgresStoreTypeName}{db: db})
}

func ${routeFactoryName}(store ${storeTypeName}) GeneratedRouteRegistrar {
\treturn ${routeTypeName}{store: store}
}

func (routes ${routeTypeName}) Register(router chi.Router) {
\trouter.Route("/${resourceName}", func(router chi.Router) {
\t\trouter.Get("/", routes.list${modelName}s)
\t\trouter.Post("/", routes.create${modelName})
\t\trouter.Patch("/{id}", routes.update${modelName})
\t\trouter.Delete("/{id}", routes.delete${modelName})
\t})
}

func (routes ${routeTypeName}) list${modelName}s(w http.ResponseWriter, r *http.Request) {
\titems, err := routes.store.List${modelName}s(r.Context())
\tif err != nil {
\t\twriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load records"})
\t\treturn
\t}

\twriteJSON(w, http.StatusOK, items)
}

func (routes ${routeTypeName}) create${modelName}(w http.ResponseWriter, r *http.Request) {
\tvar payload ${createInputName}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\twriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
\t\treturn
\t}

\tcreated, err := routes.store.Create${modelName}(r.Context(), payload)
\tif err != nil {
\t\twriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create record"})
\t\treturn
\t}

\twriteJSON(w, http.StatusCreated, created)
}

func (routes ${routeTypeName}) update${modelName}(w http.ResponseWriter, r *http.Request) {
\tid := chi.URLParam(r, "id")
\tvar payload ${updateInputName}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\twriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
\t\treturn
\t}

\tupdated, err := routes.store.Update${modelName}(r.Context(), id, payload)
\tif err != nil {
\t\tif errors.Is(err, ${notFoundName}) {
\t\t\twriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
\t\t\treturn
\t\t}
\n\t\twriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update record"})
\t\treturn
\t}

\twriteJSON(w, http.StatusOK, updated)
}

func (routes ${routeTypeName}) delete${modelName}(w http.ResponseWriter, r *http.Request) {
\tid := chi.URLParam(r, "id")
\tif err := routes.store.Delete${modelName}(r.Context(), id); err != nil {
\t\tif errors.Is(err, ${notFoundName}) {
\t\t\twriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
\t\t\treturn
\t\t}
\n\t\twriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete record"})
\t\treturn
\t}

\tw.WriteHeader(http.StatusNoContent)
}

func (store *${postgresStoreTypeName}) List${modelName}s(ctx context.Context) ([]${modelName}, error) {
\trows, err := store.db.QueryContext(ctx, ${quoteGoString(renderListQuery(tableName, entityFields))})
\tif err != nil {
\t\treturn nil, fmt.Errorf("list ${variableName}s: %w", err)
\t}
\tdefer rows.Close()

\titems := make([]${modelName}, 0)
\tfor rows.Next() {
\t\tvar item ${modelName}
\t\tif err := rows.Scan(${scanArgs}); err != nil {
\t\t\treturn nil, fmt.Errorf("scan ${variableName}: %w", err)
\t\t}
\t\titems = append(items, item)
\t}

\tif err := rows.Err(); err != nil {
\t\treturn nil, fmt.Errorf("iterate ${variableName}s: %w", err)
\t}

\treturn items, nil
}

func (store *${postgresStoreTypeName}) Create${modelName}(ctx context.Context, input ${createInputName}) (${modelName}, error) {
\tvar item ${modelName}
\tif err := store.db.QueryRowContext(
\t\tctx,
\t\t${quoteGoString(renderInsertQuery(tableName, entityFields))},${insertArgs.length > 0 ? `\n\t\t${insertArgs.join(",\n\t\t")},` : ""}
\t).Scan(${scanArgs}); err != nil {
\t\treturn ${modelName}{}, fmt.Errorf("create ${variableName}: %w", err)
\t}

\treturn item, nil
}

func (store *${postgresStoreTypeName}) Update${modelName}(ctx context.Context, id string, input ${updateInputName}) (${modelName}, error) {
${entityFields.length === 0 ? `\tvar persisted ${modelName}\n\tif err := store.db.QueryRowContext(\n\t\tctx,\n\t\t${quoteGoString(`SELECT ${returningColumns} FROM ${tableName} WHERE id = $1`)},\n\t\tid,\n\t).Scan(${persistedScanArgs}); err != nil {\n\t\tif errors.Is(err, sql.ErrNoRows) {\n\t\t\treturn ${modelName}{}, ${notFoundName}\n\t\t}\n\n\t\treturn ${modelName}{}, fmt.Errorf("load ${variableName}: %w", err)\n\t}\n\n\treturn persisted, nil` : `\tvar persisted ${modelName}\n\tif err := store.db.QueryRowContext(\n\t\tctx,\n\t\t${quoteGoString(`UPDATE ${tableName} SET\n${updateAssignments.join(",\n")}\n\t\tWHERE id = $1\n\t\tRETURNING ${returningColumns}`)},\n\t\tid,\n\t\t${updateArgs.join(",\n\t\t")},\n\t).Scan(${persistedScanArgs}); err != nil {\n\t\tif errors.Is(err, sql.ErrNoRows) {\n\t\t\treturn ${modelName}{}, ${notFoundName}\n\t\t}\n\n\t\treturn ${modelName}{}, fmt.Errorf("update ${variableName}: %w", err)\n\t}\n\n${updateCopyLines.join("\n")}\n\n\treturn persisted, nil`}
}

func (store *${postgresStoreTypeName}) Delete${modelName}(ctx context.Context, id string) error {
\tresult, err := store.db.ExecContext(ctx, ${quoteGoString(`DELETE FROM ${tableName} WHERE id = $1`)}, id)
\tif err != nil {
\t\treturn fmt.Errorf("delete ${variableName}: %w", err)
\t}

\tdeleted, err := result.RowsAffected()
\tif err != nil {
\t\treturn fmt.Errorf("delete ${variableName}: %w", err)
\t}
\tif deleted == 0 {
\t\treturn ${notFoundName}
\t}

\treturn nil
}

func nullableString(value *string) any {
\tif value == nil {
\t\treturn nil
\t}

\treturn *value
}
`;
}

function renderGeneratedRoutesTest(resourceName: string, entityName: string, fields: EntityField[]): string {
  const modelName = toGoIdentifier(entityName);
  const routeFactoryName = `newGenerated${modelName}Routes`;
  const storeTypeName = `stub${modelName}Store`;
  const createInputName = `create${modelName}Input`;
  const updateInputName = `update${modelName}Input`;
  const entityFields = normalizedEntityFields(fields).map((field) => field.name);
  const fieldJsonEntries = entityFields.map((field) => `"${toJsonName(field)}":"${sampleFieldValue(field)}"`);
  const updateField = entityFields[0];
  const updateJson = updateField
    ? `{"${toJsonName(updateField)}":"Updated ${toRussianFieldLabel(toJsonName(updateField)).toLowerCase()}"}`
    : "{}";
  const createAssignments = entityFields.map((field) => {
    const goField = toGoIdentifier(field);
    return `\titem.${goField} = input.${goField}`;
  });
  const updateAssignments = entityFields.map((field) => {
    const goField = toGoIdentifier(field);
    return `\tif input.${goField} != nil {\n\t\tcurrent.${goField} = *input.${goField}\n\t}`;
  });

  return `package http

import (
\t"bytes"
\t"context"
\t"net/http"
\t"net/http/httptest"
\t"strconv"
\t"testing"
)

type ${storeTypeName} struct {
\tnextID int
\titems  map[string]${modelName}
}

func new${storeTypeName}() *${storeTypeName} {
\treturn &${storeTypeName}{
\t\tnextID: 1,
\t\titems:  map[string]${modelName}{},
\t}
}

func (store *${storeTypeName}) List${modelName}s(context.Context) ([]${modelName}, error) {
\titems := make([]${modelName}, 0, len(store.items))
\tfor _, item := range store.items {
\t\titems = append(items, item)
\t}
\n\treturn items, nil
}

func (store *${storeTypeName}) Create${modelName}(ctx context.Context, input ${createInputName}) (${modelName}, error) {
\titem := ${modelName}{
\t\tId: strconv.Itoa(store.nextID),
\t}
${createAssignments.join("\n")}
\tstore.items[item.Id] = item
\tstore.nextID++
\treturn item, nil
}

func (store *${storeTypeName}) Update${modelName}(ctx context.Context, id string, input ${updateInputName}) (${modelName}, error) {
\tcurrent, ok := store.items[id]
\tif !ok {
\t\treturn ${modelName}{}, err${modelName}NotFound
\t}
${updateAssignments.join("\n")}
\tstore.items[id] = current
\treturn current, nil
}

func (store *${storeTypeName}) Delete${modelName}(ctx context.Context, id string) error {
\tif _, ok := store.items[id]; !ok {
\t\treturn err${modelName}NotFound
\t}
\n\tdelete(store.items, id)
\treturn nil
}

func TestGeneratedResourceCRUD(t *testing.T) {
\trouter := NewRouter(${routeFactoryName}(new${storeTypeName}()))

\tcreateRequest := httptest.NewRequest(http.MethodPost, "/api/${resourceName}", bytes.NewBufferString(\`${renderJSONBody(fieldJsonEntries)}\`))
\tcreateResponse := httptest.NewRecorder()
\trouter.ServeHTTP(createResponse, createRequest)
\tif createResponse.Code != http.StatusCreated {
\t\tt.Fatalf("expected 201, got %d", createResponse.Code)
\t}

\tupdateRequest := httptest.NewRequest(http.MethodPatch, "/api/${resourceName}/1", bytes.NewBufferString(\`${updateJson}\`))
\tupdateResponse := httptest.NewRecorder()
\trouter.ServeHTTP(updateResponse, updateRequest)
\tif updateResponse.Code != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", updateResponse.Code)
\t}

\tlistRequest := httptest.NewRequest(http.MethodGet, "/api/${resourceName}", nil)
\tlistResponse := httptest.NewRecorder()
\trouter.ServeHTTP(listResponse, listRequest)
\tif listResponse.Code != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", listResponse.Code)
\t}

\tdeleteRequest := httptest.NewRequest(http.MethodDelete, "/api/${resourceName}/1", nil)
\tdeleteResponse := httptest.NewRecorder()
\trouter.ServeHTTP(deleteResponse, deleteRequest)
\tif deleteResponse.Code != http.StatusNoContent {
\t\tt.Fatalf("expected 204, got %d", deleteResponse.Code)
\t}
}
`;
}

function renderApiClient(resourceName: string, entityName: string, fields: EntityField[]): string {
  const modelName = toGoIdentifier(entityName);
  const fieldNames = normalizedEntityFields(fields).map((field) => field.name);
  const typeFields = unique(["id", ...fieldNames]).map((field) => {
    return `  ${toJsonName(field)}: string;`;
  });
  const createFields = fieldNames.map((field) => {
    return `  ${toJsonName(field)}: string;`;
  });

  return `import { apiBaseUrl } from "./config";

export interface ${modelName} {
${typeFields.join("\n")}
}

export interface Create${modelName}Input {
${createFields.join("\n")}
}

export async function list${modelName}s(): Promise<${modelName}[]> {
  const response = await fetch(apiBaseUrl + "/api/${resourceName}");
  if (!response.ok) {
    throw new Error("Не удалось загрузить записи");
  }
  return response.json();
}

export async function create${modelName}(input: Create${modelName}Input): Promise<${modelName}> {
  const response = await fetch(apiBaseUrl + "/api/${resourceName}", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error("Не удалось создать запись");
  }
  return response.json();
}
`;
}

function renderFrontendApp(entityName: string, fields: EntityField[]): string {
  const modelName = toGoIdentifier(entityName);
  const title = entityName === "Book" ? "Учет книг" : `Управление ${entityName}`;
  const uniqueFields = normalizedEntityFields(fields).map((field) => field.name);
  const initialForm = uniqueFields.map((field) => `${toJsonName(field)}: ""`).join(", ");
  const formInputs = uniqueFields.map((field) => {
    const jsonName = toJsonName(field);
    return `            <label>
              <span>${toRussianFieldLabel(jsonName)}</span>
              <input
                value={form.${jsonName}}
                onChange={(event) => setForm({ ...form, ${jsonName}: event.target.value })}
              />
            </label>`;
  });
  const tableHeaders = uniqueFields.map((field) => {
    return `              <th>${toRussianFieldLabel(toJsonName(field))}</th>`;
  });
  const tableCells = uniqueFields.map((field) => {
    const jsonName = toJsonName(field);
    return `                <td>{item.${jsonName}}</td>`;
  });

  return `import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ${modelName}, create${modelName}, list${modelName}s } from "./api";
import "./styles.css";

function App() {
  const [items, setItems] = useState<${modelName}[]>([]);
  const [form, setForm] = useState({ ${initialForm} });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function loadItems() {
    setIsLoading(true);
    setError(null);
    try {
      setItems(await list${modelName}s());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Ошибка загрузки");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await create${modelName}(form);
      setForm({ ${initialForm} });
      await loadItems();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Ошибка сохранения");
    }
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">Hephaestus</p>
          <h1>${title}</h1>
        </div>
        <button type="button" onClick={() => void loadItems()}>
          Обновить
        </button>
      </header>

      <section className="workspace">
        <form className="editor" onSubmit={handleSubmit}>
          <h2>Новая запись</h2>
${formInputs.join("\n")}
          <button type="submit">Сохранить</button>
        </form>

        <div className="table-wrap">
          <div className="table-header">
            <h2>Записи</h2>
            {isLoading ? <span>Загрузка</span> : <span>{items.length}</span>}
          </div>
          {error ? <p className="error">{error}</p> : null}
          <table>
            <thead>
              <tr>
${tableHeaders.join("\n")}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
${tableCells.join("\n")}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
}

function renderFrontendStyles(): string {
  return `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  color: #17202a;
  background: #f4f6f8;
}

button,
input {
  font: inherit;
}

button {
  border: 0;
  border-radius: 6px;
  padding: 10px 14px;
  color: #ffffff;
  background: #245c4f;
  cursor: pointer;
}

.app-shell {
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 32px 20px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #587066;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

h1,
h2 {
  margin: 0;
}

h1 {
  font-size: 34px;
  line-height: 1.1;
}

h2 {
  font-size: 18px;
}

.workspace {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 20px;
}

.editor,
.table-wrap {
  border: 1px solid #d9e0e6;
  border-radius: 8px;
  background: #ffffff;
}

.editor {
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 18px;
}

label {
  display: grid;
  gap: 6px;
  color: #46515f;
  font-size: 14px;
}

input {
  width: 100%;
  border: 1px solid #c9d2da;
  border-radius: 6px;
  padding: 10px 12px;
  color: #17202a;
  background: #ffffff;
}

.table-wrap {
  overflow: hidden;
}

.table-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px;
  border-bottom: 1px solid #d9e0e6;
}

.error {
  margin: 16px 18px 0;
  color: #a33c2f;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 12px 18px;
  border-bottom: 1px solid #edf0f2;
  text-align: left;
}

th {
  color: #5b6775;
  font-size: 13px;
  font-weight: 700;
}

@media (max-width: 760px) {
  .page-header,
  .workspace {
    display: grid;
    grid-template-columns: 1fr;
  }
}
`;
}

function renderListQuery(tableName: string, fields: string[]): string {
  return `SELECT ${renderReturningColumns(fields)} FROM ${tableName} ORDER BY id`;
}

function renderInsertQuery(tableName: string, fields: string[]): string {
  if (fields.length === 0) {
    return `INSERT INTO ${tableName} DEFAULT VALUES RETURNING ${renderReturningColumns(fields)}`;
  }

  const columns = fields.map(toSqlName).join(", ");
  const values = fields.map((_, index) => `$${index + 1}`).join(", ");
  return `INSERT INTO ${tableName} (${columns}) VALUES (${values}) RETURNING ${renderReturningColumns(fields)}`;
}

function renderReturningColumns(fields: string[]): string {
  return ["id::text", ...fields.map(toSqlName)].join(", ");
}

function renderJSONBody(entries: string[]): string {
  return `{${entries.join(",")}}`;
}

function normalizedEntityFields(fields: EntityField[]): EntityField[] {
  const byName = new Map<string, EntityField>();

  for (const field of fields) {
    const normalizedName = toJsonName(field.name);
    if (normalizedName === "id" || byName.has(normalizedName)) {
      continue;
    }

    byName.set(normalizedName, field);
  }

  return Array.from(byName.values());
}

function sampleFieldValue(field: string): string {
  const values: Record<string, string> = {
    title: "Example",
    author: "Author",
    genre: "Fiction",
    status: "planned",
    reading_status: "planned",
    description: "Description",
    content: "Content",
    assignee: "User"
  };

  return values[toJsonName(field)] ?? "Value";
}

function quoteGoString(value: string): string {
  return JSON.stringify(value);
}

function toGoIdentifier(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function lowerFirst(value: string): string {
  return `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;
}

function toJsonName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toSqlName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toRussianFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: "Название",
    author: "Автор",
    genre: "Жанр",
    status: "Статус",
    reading_status: "Статус чтения",
    description: "Описание",
    content: "Содержание",
    assignee: "Ответственный"
  };

  return labels[field] ?? field;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function inferResourceNameFromEntity(entityName: string): string {
  const normalized = toSqlName(entityName);
  return normalized.endsWith("s") ? normalized : `${normalized}s`;
}

function renderColumnDefinition(field: EntityField): string {
  const parts = [`  ${toSqlName(field.name)} ${toSqlType(field)}`];

  if (field.required) {
    parts.push("NOT NULL");
  }

  if (field.unique) {
    parts.push("UNIQUE");
  }

  if (field.defaultValue !== undefined) {
    parts.push(`DEFAULT ${renderDefaultValue(field.defaultValue, field.type)}`);
  }

  if (field.references) {
    parts.push(renderReferenceClause(field.references));
  }

  return parts.join(" ");
}

function toSqlType(field: EntityField): string {
  switch (field.type) {
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "number":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "datetime":
      return "TIMESTAMPTZ";
    case "json":
      return "JSONB";
    case "string":
    default:
      return "TEXT";
  }
}

function renderDefaultValue(
  value: string | number | boolean | null,
  type: EntityField["type"]
): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  if (type === "json") {
    return `'${escapeSqlString(value)}'::jsonb`;
  }

  return `'${escapeSqlString(value)}'`;
}

function renderReferenceClause(reference: NonNullable<EntityField["references"]>): string {
  const referencedTable = toSqlName(inferResourceNameFromEntity(reference.entity));
  const onDeleteMap: Record<NonNullable<EntityField["references"]>["onDelete"], string> = {
    restrict: "RESTRICT",
    cascade: "CASCADE",
    set_null: "SET NULL"
  };

  return `REFERENCES ${referencedTable} (${toSqlName(reference.field)}) ON DELETE ${onDeleteMap[reference.onDelete]}`;
}

function renderIndexStatements(
  entity: ProjectEntity,
  tableName: string,
  fields: EntityField[]
): string[] {
  const statements: string[] = [];

  for (const field of fields) {
    if (!field.indexed) {
      continue;
    }

    const indexName = `${tableName}_${toSqlName(field.name)}_idx`;
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${toSqlName(field.name)});`
    );
  }

  for (const index of entity.indexes ?? []) {
    statements.push(renderEntityIndex(tableName, index));
  }

  return statements;
}

function renderEntityIndex(tableName: string, index: EntityIndex): string {
  const indexName = index.name ?? `${tableName}_${index.fields.map(toSqlName).join("_")}_idx`;
  const uniquePrefix = index.unique ? "UNIQUE " : "";
  const columns = index.fields.map(toSqlName).join(", ");
  return `CREATE ${uniquePrefix}INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${columns});`;
}

function sortEntitiesByDependencies(entities: ProjectEntity[]): ProjectEntity[] {
  const remaining = new Map(entities.map((entity) => [entity.name, entity]));
  const resolved = new Set<string>();
  const ordered: ProjectEntity[] = [];

  while (remaining.size > 0) {
    let progressed = false;

    for (const [name, entity] of remaining) {
      const dependencies = normalizedEntityFields(entity.fields)
        .map((field) => field.references?.entity)
        .filter((dependency): dependency is string => Boolean(dependency));

      if (dependencies.every((dependency) => dependency === name || resolved.has(dependency) || !remaining.has(dependency))) {
        ordered.push(entity);
        resolved.add(name);
        remaining.delete(name);
        progressed = true;
      }
    }

    if (!progressed) {
      ordered.push(...remaining.values());
      break;
    }
  }

  return ordered;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function defaultEntityFields(fields: string[]): EntityField[] {
  return fields.map((field) => ({
    name: field,
    type: "string",
    required: true,
    unique: false,
    indexed: false
  }));
}
