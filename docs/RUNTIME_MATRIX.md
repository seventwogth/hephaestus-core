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
| Ollama | текущая локальная stable-версия | Local model runtime для Hermes/Ollama agent stages |

## CI baseline

GitHub Actions запускает production-readiness baseline на Ubuntu:

- root workspace: `npm ci`, `npm run check:lockfile`, `npm test`,
  `npm run typecheck`, `npm run build`;
- generated webapp template: `docker compose config`, Go backend tests,
  frontend `npm ci`, frontend tests and frontend build.

## Локальные заметки

- Репозиторий использует npm scripts и `package-lock.json` как release gate.
- `pnpm-workspace.yaml` оставлен только как workspace descriptor для tooling,
  который умеет читать pnpm workspace; release checks не используют pnpm.
- Frontend сгенерированного приложения может требовать доступ к npm registry
  во время установки зависимостей.
