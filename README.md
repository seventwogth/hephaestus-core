# hephaestus-core

Локальный мультиагентный конвейер для генерации полноценных репозиториев
веб-приложений.

## Направление MVP

Hephaestus принимает описание продукта, преобразует его в структурированные
артефакты проекта, а затем запускает специализированные этапы генерации и
проверки. Первая цель — воспроизводимый локальный репозиторий, который можно
запустить через Docker Compose.

Генерируемые приложения используют фиксированный стек:

- Frontend: React, TypeScript, Vite
- Backend: Go, chi
- База данных: PostgreSQL
- API: REST/OpenAPI
- Запуск: Docker Compose

## Структура репозитория

```text
apps/
  orchestrator/          Конечный автомат и поток артефактов проекта
packages/
  contracts/             Zod-схемы для SPEC, PLAN, TASKS, STATUS
  hermes-adapter/         Контракт провайдера модели для запуска агентов
  project-sandbox/       Безопасные файловые операции и запуск команд
  project-validator/     Проверки сгенерированного проекта и REVIEW.md
  templates/             Фиксированный шаблон и механизм создания проекта
```

## Команды ядра

```bash
npm install
npm run typecheck
npm test
npm run build
```

Шаблон генерируемого приложения находится здесь:

```text
packages/templates/generated-webapp
```

Он должен оставаться запускаемым командой:

```bash
docker compose up --build
```

Оркестратор умеет создавать директорию проекта из этого шаблона и записывать
начальные артефакты `SPEC.json`, `STATUS.json` и `TASKS.json`.

## Локальное создание проекта

CLI принимает JSON-спецификацию, валидирует ее и создает проект из шаблона:

```bash
npm run scaffold -- --spec ./examples/book-tracker.spec.json --out ./generated-projects/book-tracker
```

В MVP CLI ожидает спецификацию в формате `ProjectSpec` из пакета
`@hephaestus/contracts`.

## Проверка созданного проекта

После создания проекта можно запустить проверочный этап:

```bash
npm run validate-project -- --project ./generated-projects/book-tracker
```

Валидатор выполняет базовые проверки Docker Compose, Go backend и frontend, а
результат сохраняет в `REVIEW.md` внутри директории проекта.

На первом запуске проверка frontend может потребовать доступ к npm registry,
потому что валидатор устанавливает зависимости в созданном проекте.

## Статус реализации

Сопоставление текущего состояния с `IDEA.md` ведется в `docs/STATUS.md`.
