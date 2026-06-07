# Release checklist

Перед релизом или прямым пушем в `main` нужно пройти этот список.

## Базовые проверки

- Ветка обновлена относительно `origin/main`.
- `npm ci` проходит на чистом workspace.
- `npm run check:lockfile` не оставляет diff в `package.json`,
  `package-lock.json` и package manifests workspace-пакетов.
- `npm test` проходит.
- `npm run typecheck` проходит.
- `npm run build` проходит.
- Для `packages/templates/generated-webapp` проходят:
  - `docker compose config`;
  - `go test ./...` в `backend`;
  - `npm ci`, `npm test` и `npm run build` в `frontend`.

## Проверки документации

- `README.md` отражает актуальные env vars, CLI команды и способы запуска.
- `docs/STATUS.md` обновлен, если меняется реализованный capability или
  ближайший roadmap.
- `docs/RUNTIME_MATRIX.md` соответствует версиям, которые проверяются в CI.

## Release notes

- Перечислены пользовательские изменения.
- Перечислены миграции, новые env vars и breaking changes.
- Зафиксированы известные ограничения и ручные production шаги.
