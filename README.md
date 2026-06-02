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

Сначала можно превратить свободное текстовое описание в `SPEC.json`:

```bash
npm run requirements -- --text "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти, добавлять книги и менять статус прочтения." --out ./generated-projects/book-tracker/SPEC.json
```

После этого CLI принимает JSON-спецификацию, валидирует ее и создает проект из
шаблона:

```bash
npm run scaffold -- --spec ./examples/book-tracker.spec.json --out ./generated-projects/book-tracker
```

В MVP CLI ожидает спецификацию в формате `ProjectSpec` из пакета
`@hephaestus/contracts`.

Из `SPEC.json` можно сформировать технический план `PLAN.json`:

```bash
npm run scaffold -- plan --spec ./generated-projects/book-tracker/SPEC.json --out ./generated-projects/book-tracker/PLAN.json
```

После формирования плана можно сгенерировать SQL-миграции для backend:

```bash
npm run scaffold -- generate-database --project ./generated-projects/book-tracker
```

Затем можно сгенерировать Go backend-маршруты и SQL-доступ:

```bash
npm run scaffold -- generate-backend --project ./generated-projects/book-tracker
```

Затем можно сгенерировать frontend-страницу и API-клиент:

```bash
npm run scaffold -- generate-frontend --project ./generated-projects/book-tracker
```

## Проверка созданного проекта

После создания проекта можно запустить проверочный этап:

```bash
npm run validate-project -- --project ./generated-projects/book-tracker
```

Валидатор выполняет базовые проверки Docker Compose, Go backend и frontend, а
результат сохраняет в `REVIEW.md` внутри директории проекта.

Сгенерированный backend использует `database/sql` c драйвером `pgx`, применяет
встроенные SQL-миграции на старте и хранит CRUD-данные в PostgreSQL, а не в
in-memory store.

На уровне оркестратора теперь доступен ограниченный цикл исправлений: после
неуспешной проверки fixer-агент получает `REVIEW.md`, может вернуть правки
файлов в разрешённые пути и затем оркестратор повторяет валидацию до заданного
лимита попыток.

На первом запуске проверка frontend может потребовать доступ к npm registry,
потому что валидатор устанавливает зависимости в созданном проекте.

## Статус реализации

Сопоставление текущего состояния с `IDEA.md` ведется в `docs/STATUS.md`.
