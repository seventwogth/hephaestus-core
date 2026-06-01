import { type ProjectPlan, projectPlanSchema } from "@hephaestus/contracts";
import { ProjectSandbox } from "@hephaestus/project-sandbox";

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateBackendOptions {
  projectDir: string;
  plan: ProjectPlan;
}

export interface GenerateFrontendOptions {
  projectDir: string;
  plan: ProjectPlan;
}

export async function generateGoBackend(options: GenerateBackendOptions): Promise<GeneratedFile[]> {
  const plan = projectPlanSchema.parse(options.plan);
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: ["title", "description", "status"]
  };
  const resourceName = inferResourceName(plan);
  const files = [
    {
      path: "backend/internal/http/generated_routes.go",
      content: renderGeneratedRoutes(resourceName, entity.name, entity.fields)
    },
    {
      path: "backend/internal/http/generated_routes_test.go",
      content: renderGeneratedRoutesTest(resourceName)
    }
  ];
  const sandbox = new ProjectSandbox({ rootDir: options.projectDir, allowedCommands: [] });

  for (const file of files) {
    await sandbox.writeText(file.path, file.content);
  }

  return files;
}

export async function generateReactFrontend(options: GenerateFrontendOptions): Promise<GeneratedFile[]> {
  const plan = projectPlanSchema.parse(options.plan);
  const entity = plan.databaseEntities[0] ?? {
    name: "Item",
    fields: ["title", "description", "status"]
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
  const sandbox = new ProjectSandbox({ rootDir: options.projectDir, allowedCommands: [] });

  for (const file of files) {
    await sandbox.writeText(file.path, file.content);
  }

  return files;
}

function inferResourceName(plan: ProjectPlan): string {
  const resourceEndpoint = plan.endpoints.find((endpoint) => {
    const parts = endpoint.path.split("/").filter(Boolean);
    return endpoint.method === "GET" && parts.length === 2 && parts[0] === "api";
  });

  if (resourceEndpoint) {
    return resourceEndpoint.path.split("/").filter(Boolean)[1]!;
  }

  const entityName = plan.databaseEntities[0]?.name.toLowerCase() ?? "item";
  return entityName.endsWith("s") ? entityName : `${entityName}s`;
}

function renderGeneratedRoutes(resourceName: string, entityName: string, fields: string[]): string {
  const modelName = toGoIdentifier(entityName);
  const structFields = unique(["id", ...fields]).map((field) => {
    const jsonName = toJsonName(field);
    return `\t${toGoIdentifier(field)} string \`json:"${jsonName}"\``;
  });
  const updateAssignments = unique(fields).map((field) => {
    const goField = toGoIdentifier(field);
    return `\t\tif payload.${goField} != "" {\n\t\t\tcurrent.${goField} = payload.${goField}\n\t\t}`;
  });

  return `package http

import (
\t"encoding/json"
\t"net/http"
\t"strconv"
\t"sync"

\t"github.com/go-chi/chi/v5"
)

type ${modelName} struct {
${structFields.join("\n")}
}

type generated${modelName}Store struct {
\tmu     sync.Mutex
\tnextID int
\titems  map[string]${modelName}
}

var ${lowerFirst(modelName)}Store = &generated${modelName}Store{
\tnextID: 1,
\titems:  map[string]${modelName}{},
}

func registerGeneratedRoutes(router chi.Router) {
\trouter.Route("/${resourceName}", func(router chi.Router) {
\t\trouter.Get("/", list${modelName}s)
\t\trouter.Post("/", create${modelName})
\t\trouter.Patch("/{id}", update${modelName})
\t\trouter.Delete("/{id}", delete${modelName})
\t})
}

func list${modelName}s(w http.ResponseWriter, r *http.Request) {
\t${lowerFirst(modelName)}Store.mu.Lock()
\tdefer ${lowerFirst(modelName)}Store.mu.Unlock()

\titems := make([]${modelName}, 0, len(${lowerFirst(modelName)}Store.items))
\tfor _, item := range ${lowerFirst(modelName)}Store.items {
\t\titems = append(items, item)
\t}

\twriteJSON(w, http.StatusOK, items)
}

func create${modelName}(w http.ResponseWriter, r *http.Request) {
\tvar payload ${modelName}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\twriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
\t\treturn
\t}

\t${lowerFirst(modelName)}Store.mu.Lock()
\tdefer ${lowerFirst(modelName)}Store.mu.Unlock()

\tpayload.Id = strconv.Itoa(${lowerFirst(modelName)}Store.nextID)
\t${lowerFirst(modelName)}Store.nextID++
\t${lowerFirst(modelName)}Store.items[payload.Id] = payload

\twriteJSON(w, http.StatusCreated, payload)
}

func update${modelName}(w http.ResponseWriter, r *http.Request) {
\tid := chi.URLParam(r, "id")
\tvar payload ${modelName}
\tif err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
\t\twriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
\t\treturn
\t}

\t${lowerFirst(modelName)}Store.mu.Lock()
\tdefer ${lowerFirst(modelName)}Store.mu.Unlock()

\tcurrent, ok := ${lowerFirst(modelName)}Store.items[id]
\tif !ok {
\t\twriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
\t\treturn
\t}

${updateAssignments.join("\n")}
\t${lowerFirst(modelName)}Store.items[id] = current
\twriteJSON(w, http.StatusOK, current)
}

func delete${modelName}(w http.ResponseWriter, r *http.Request) {
\tid := chi.URLParam(r, "id")

\t${lowerFirst(modelName)}Store.mu.Lock()
\tdefer ${lowerFirst(modelName)}Store.mu.Unlock()

\tif _, ok := ${lowerFirst(modelName)}Store.items[id]; !ok {
\t\twriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
\t\treturn
\t}

\tdelete(${lowerFirst(modelName)}Store.items, id)
\tw.WriteHeader(http.StatusNoContent)
}
`;
}

function renderGeneratedRoutesTest(resourceName: string): string {
  return `package http

import (
\t"bytes"
\t"net/http"
\t"net/http/httptest"
\t"testing"
)

func TestGeneratedResourceCRUD(t *testing.T) {
\trouter := NewRouter()

\tcreateRequest := httptest.NewRequest(http.MethodPost, "/api/${resourceName}", bytes.NewBufferString(\`{"title":"Example","author":"Author","genre":"Fiction","status":"planned"}\`))
\tcreateResponse := httptest.NewRecorder()
\trouter.ServeHTTP(createResponse, createRequest)
\tif createResponse.Code != http.StatusCreated {
\t\tt.Fatalf("expected 201, got %d", createResponse.Code)
\t}

\tlistRequest := httptest.NewRequest(http.MethodGet, "/api/${resourceName}", nil)
\tlistResponse := httptest.NewRecorder()
\trouter.ServeHTTP(listResponse, listRequest)
\tif listResponse.Code != http.StatusOK {
\t\tt.Fatalf("expected 200, got %d", listResponse.Code)
\t}
}
`;
}

function renderApiClient(resourceName: string, entityName: string, fields: string[]): string {
  const modelName = toGoIdentifier(entityName);
  const typeFields = unique(["id", ...fields]).map((field) => {
    return `  ${toJsonName(field)}: string;`;
  });
  const createFields = unique(fields).map((field) => {
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

function renderFrontendApp(entityName: string, fields: string[]): string {
  const modelName = toGoIdentifier(entityName);
  const title = entityName === "Book" ? "Учет книг" : `Управление ${entityName}`;
  const uniqueFields = unique(fields);
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
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function toRussianFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: "Название",
    author: "Автор",
    genre: "Жанр",
    status: "Статус",
    description: "Описание",
    content: "Содержание",
    assignee: "Ответственный"
  };

  return labels[field] ?? field;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
