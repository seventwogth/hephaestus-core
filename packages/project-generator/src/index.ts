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

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
