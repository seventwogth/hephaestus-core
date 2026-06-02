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
  telegram-bot/          Telegram Bot API polling UI для запуска проектов
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

`SPEC.json` и `PLAN.json` теперь поддерживают более богатое описание БД:
- несколько сущностей в одном проекте;
- типизированные поля (`string`, `text`, `integer`, `number`, `boolean`, `date`, `datetime`, `json`);
- внешние ключи между таблицами;
- уникальные и обычные индексы.

Генератор SQL-миграций учитывает зависимости между таблицами и строит schema
в корректном порядке даже при наличии ссылок между сущностями.

На уровне оркестратора теперь доступен ограниченный цикл исправлений: после
неуспешной проверки fixer-агент получает `REVIEW.md`, может вернуть правки
файлов в разрешённые пути и затем оркестратор повторяет валидацию до заданного
лимита попыток.

На первом запуске проверка frontend может потребовать доступ к npm registry,
потому что валидатор устанавливает зависимости в созданном проекте.

## Локальный LLM-first запуск

Если Ollama и Hermes/Hephaestus runtime стоят на одной машине, проект можно
запускать напрямую с этой машины без Telegram:

```bash
npm run bootstrap-project -- --text "Создай сервис учета книг" --out ./generated-projects/book-tracker --model qwen2.5-coder:14b
```

Доступные флаги:

- `--text` или `--input` — описание проекта
- `--out` — директория проекта
- `--model` — id локальной модели, по умолчанию это Ollama model id
- `--no-validate` — пропустить validation stage
- `--no-fix` — не запускать fixer loop после неуспешной проверки

LLM-first bootstrap теперь идёт по цепочке:

1. `REQUEST.md`
2. `SPEC.json`
3. `PLAN.json`
4. `database`
5. `backend`
6. `frontend`
7. `integrator`
8. `validate -> fixer -> revalidate`
9. `documentation`

## Telegram-бот MVP

Telegram-бот находится в `apps/telegram-bot`. Он работает через polling Telegram
Bot API, предлагает выбрать модель до старта проекта, затем принимает текстовое
описание и создаёт проект через agent-driven orchestrator flow.

Запуск:

```bash
TELEGRAM_BOT_TOKEN=... npm run telegram-bot
```

Переменные окружения:

- `TELEGRAM_BOT_TOKEN` — токен Telegram-бота
- `HEPHAESTUS_PROJECTS_DIR` — директория для создаваемых проектов, по умолчанию `./generated-projects`
- `HEPHAESTUS_AVAILABLE_MODELS` — список моделей в формате `id|label|description,id2|label2|description2`
- `HEPHAESTUS_MODEL_RUNTIME_MAP` — необязательное сопоставление `modelId=stub` или `modelId=ollama:model-name`
- `HEPHAESTUS_OLLAMA_BASE_URL` — URL локального Ollama API, по умолчанию `http://127.0.0.1:11434`
- `HEPHAESTUS_OLLAMA_TIMEOUT_MS` — таймаут одного agent run для Ollama

После выбора модели бот сохраняет её в `MODEL_SELECTION.json` внутри созданного
проекта и, если модель не `stub`, поднимает для неё реальный provider.

Это соответствует сценарию удалённого управления: Ollama и runtime живут на
одной машине, бот получает команды из Telegram, а сам проект создаётся и
валидируется локально на хосте.

Текущий LLM-first flow в боте:

1. бот сохраняет описание пользователя в `REQUEST.md`
2. requirements-agent через Hermes/Ollama пишет `SPEC.json`
3. architect-agent пишет `PLAN.json`
4. database/backend/frontend агенты последовательно переписывают scaffold проекта
5. все agent runs журналируются в `AGENT_RUNS.jsonl`

## ModelProvider

Пакет `@hephaestus/hermes-adapter` теперь поддерживает два режима:

- `StubModelProvider` для детерминированных тестов;
- `CommandModelProvider` для подключения внешнего модельного рантайма через JSON
  по `stdin/stdout`.
- `OllamaModelProvider` для прямого вызова локального Ollama HTTP API.

Контракт простой: внешний процесс получает `AgentRunInput` в `stdin` и должен
вернуть JSON с полями `summary`, `changedFiles`, `updatedFiles` и `rawOutput`.
`updatedFiles` затем применяются оркестратором только в разрешённые пути этапа.

Для прямого Ollama-режима Hermes формирует prompt из роли агента, инструкции,
контекстных файлов и списка разрешённых путей записи, а затем ожидает JSON-ответ
с тем же контрактом `updatedFiles`.

## Статус реализации

Сопоставление текущего состояния с `IDEA.md` ведется в `docs/STATUS.md`.
