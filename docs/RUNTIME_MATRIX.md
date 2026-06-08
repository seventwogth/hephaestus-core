# Supported runtime matrix

Матрица фиксирует runtime, на котором поддерживается локальная разработка и
проверяется CI baseline.

| Runtime | Поддерживаемая версия | Для чего нужен |
| --- | --- | --- |
| Node.js | 20.x LTS; 22.x можно использовать локально | Core TypeScript packages, Telegram bot, generated frontend |
| npm | 10.x+ | Root workspace install, scripts и lockfile checks |
| Go | 1.24.x | Generated Go backend template |
| Docker Engine | 24.x+ | Generated project runtime и production smoke checks |
| Docker Compose | v2.x | `packages/templates/generated-webapp/docker-compose.yml` |
| Validation image | `hephaestus/validation:local` | Docker runner для sandbox validation commands |
| Ollama | текущая локальная stable-версия | Local model runtime для Hermes/Ollama agent stages |

## CI baseline

GitHub Actions запускает production-readiness baseline на Ubuntu:

- root workspace: `npm ci`, `npm run check:lockfile`, `npm test`,
  `npm run typecheck`, `npm run build`, `npm run build:validation-image`;
- generated webapp template: `docker compose config`, Go backend tests,
  frontend `npm ci`, frontend tests and frontend build.

## Локальные заметки

- Репозиторий использует npm scripts и `package-lock.json` как release gate.
- `pnpm-workspace.yaml` оставлен только как workspace descriptor для tooling,
  который умеет читать pnpm workspace; release checks не используют pnpm.
- Frontend сгенерированного приложения может требовать доступ к npm registry
  во время установки зависимостей.
- Docker sandbox runner включается через `HEPHAESTUS_SANDBOX_RUNNER=docker`.
  По умолчанию используется host runner, чтобы local/dev flow не требовал
  validation image.
- Docker runner принимает `HEPHAESTUS_SANDBOX_CPUS`,
  `HEPHAESTUS_SANDBOX_MEMORY`, `HEPHAESTUS_SANDBOX_PIDS_LIMIT` и
  `HEPHAESTUS_SANDBOX_STORAGE_SIZE`; storage size применяется как Docker
  `--storage-opt size=...` для writable layer контейнера.
- `HEPHAESTUS_SANDBOX_WORKSPACE_DISK_LIMIT` включает hard quota для
  исполняемого workspace: runner монтирует tmpfs указанного размера, копирует
  туда project dir перед командой и синхронизирует результат обратно после
  завершения.
- Для стандартного generated-webapp validation Docker runner использует
  per-check network policy: dependency/download checks получают `bridge`,
  остальные checks получают `none`.
- После bootstrap оркестратор чистит workspace по artifact allowlist и пишет
  результат в `ARTIFACT_RETENTION.json` и `GENERATION_REPORT.json`.
- Telegram job lifecycle работает через `ProjectJobStore`; file store остается
  local/dev backend и хранит leases, attempts, retry lineage, optional
  idempotency keys и `dead_letter` status в `jobs.json`. Production backend
  должен реализовать тот же store contract поверх Postgres/Redis.
