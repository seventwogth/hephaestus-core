# hephaestus-core

Local multi-agent pipeline for generating complete web application repositories.

## MVP direction

Hephaestus accepts a product request, turns it into structured project artifacts,
then runs specialized generation and validation stages. The first target is a
reproducible local repository that can be started with Docker Compose.

Generated applications use a fixed stack:

- Frontend: React, TypeScript, Vite
- Backend: Go, chi
- Database: PostgreSQL
- API: REST/OpenAPI
- Runtime: Docker Compose

## Repository layout

```text
apps/
  orchestrator/          State machine and project artifact flow
packages/
  contracts/             Zod schemas for SPEC, PLAN, TASKS, STATUS
  templates/             Fixed generated-app template
```

## Core commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

The generated application template lives at:

```text
packages/templates/generated-webapp
```

It should stay runnable with:

```bash
docker compose up --build
```
