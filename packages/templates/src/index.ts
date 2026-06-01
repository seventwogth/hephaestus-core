export const generatedWebAppTemplate = {
  id: "generated-webapp",
  stack: {
    frontend: "react-vite-typescript",
    backend: "go-chi",
    database: "postgresql",
    api: "rest-openapi"
  },
  path: "packages/templates/generated-webapp"
} as const;
