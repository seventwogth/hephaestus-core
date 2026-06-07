```text
    _  _                          _                                      _                        
   FJ  L]     ____     _ ___     FJ___      ___ _     ____      ____    FJ_     _    _     ____   
  J |__| L   F __ J   J '__ J   J  __ `.   F __` L   F __ J    F ___J  J  _|   J |  | L   F ___J  
  |  __  |  | _____J  | |--| |  | |--| |  | |--| |  | _____J  | '----_ | |-'   | |  | |  | '----_ 
  F L__J J  F L___--. F L__J J  F L  J J  F L__J J  F L___--. )-____  LF |__-. F L__J J  )-____  L
 J__L  J__LJ\______/FJ  _____/LJ__L  J__LJ\____,__LJ\______/FJ\______/F\_____/J\____,__LJ\______/F
 |__L  J__| J______F |_J_____F |__L  J__| J____,__F J______F  J______F J_____F J____,__F J______F 
                     L_J                                                                           
```

## Что это такое?

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
npm run check:lockfile
npm run typecheck
npm test
npm run build
```

Production-readiness проверки описаны здесь:

- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Supported runtime matrix](docs/RUNTIME_MATRIX.md)

## Быстрый старт через Telegram

Ниже минимальный путь для обычного пользователя. Предполагается одна машина,
которая постоянно включена и на которой будут крутиться Ollama, Hephaestus и
Telegram-бот. Управлять проектами потом можно с телефона или любого другого
устройства через Telegram.

### 1. Подготовить хост-машину

Нужно установить:

- `git`
- `node` 20+
- `npm`
- `docker` и `docker compose`
- `go` 1.22+
- `ollama`

### 2. Скачать репозиторий и установить зависимости

```bash
git clone https://github.com/seventwogth/hephaestus-core.git
cd hephaestus-core
npm install
```

Ускоренный вариант:

```bash
sh ./setup.sh
```

Или:

```bash
npm run setup-host
```

`setup.sh` делает следующее:

- проверяет базовые зависимости хост-машины
- пытается установить недостающие пакеты через доступный пакетный менеджер
- запускает `npm install`
- предлагает выбрать директории, модель и режим запуска
- просит токен Telegram-бота и пишет `.env.hephaestus`
- при желании делает `ollama pull` для выбранной модели

Важно: создание Telegram-бота полностью автоматизировать нельзя, потому что у
`@BotFather` нет публичного API для этого. Скрипт проводит пользователя через
этот шаг и просит вставить уже выданный токен.

### 3. Поднять Ollama и скачать модель

Запустить Ollama:

```bash
ollama serve
```

В отдельном терминале скачать модель:

```bash
ollama pull qwen2.5-coder:14b
```

Если машина слабее, можно взять более лёгкую модель, например
`qwen2.5-coder:7b`.

### 4. Создать Telegram-бота

В Telegram открыть `@BotFather`, создать нового бота и сохранить токен.

### 5. Настроить переменные окружения

Минимальная конфигурация:

```bash
export TELEGRAM_BOT_TOKEN="сюда-токен-бота"
export HEPHAESTUS_PROJECTS_DIR="$HOME/hephaestus-projects"
export HEPHAESTUS_BOT_STATE_DIR="$HOME/hephaestus-bot-state"
export HEPHAESTUS_AVAILABLE_MODELS="qwen2.5-coder:7b|Qwen 7B|Быстрее,qwen2.5-coder:14b|Qwen 14B|Качественнее"
```

Необязательные переменные:

- `HEPHAESTUS_OLLAMA_BASE_URL` — адрес Ollama API, по умолчанию `http://127.0.0.1:11434`
- `HEPHAESTUS_MODEL_RUNTIME_MAP` — ручное сопоставление id модели и runtime, например `quality=ollama:qwen2.5-coder:14b`
- `HEPHAESTUS_OLLAMA_TIMEOUT_MS` — таймаут одного LLM agent run
- `HEPHAESTUS_NO_SCAFFOLD=true` — agent-only режим: шаблон приложения не копируется, runnable code создаётся агентами с нуля

### 6. Запустить Telegram-бота

```bash
npm run telegram-bot
```

Раздельный запуск сервисов:

```bash
npm run telegram-bot-poll
npm run telegram-bot-worker
```

Бот начнёт:

- принимать команды из Telegram
- сохранять сессии на диск
- ставить проекты в persistent queue
- после рестарта продолжать обрабатывать pending jobs

В production-сценарии предпочтительно держать `poll` и `worker` как отдельные
фоновые процессы на одной хост-машине.

### 7. Создать первый проект через Telegram

В чате с ботом:

1. отправить `/start`
2. отправить `/new`
3. выбрать модель
4. одним сообщением отправить описание проекта
5. дождаться уведомления о старте и завершении job
6. при необходимости отправить `/status`

После успешной генерации бот пришлёт:

- id задания
- имя проекта
- модель
- абсолютный путь к директории проекта на хост-машине

### 8. Запустить сгенерированный проект

На хост-машине перейти в директорию проекта, которую прислал бот:

```bash
cd /путь/из/сообщения/бота
docker compose up --build
```

### 9. Что важно учитывать

- хост-машина должна оставаться включённой, пока идёт генерация
- Telegram управляет процессом, но весь код генерируется локально на хосте
- frontend validation может потребовать доступ к npm registry
- чем сильнее локальная модель, тем выше шанс получить рабочий проект без дополнительных fixer-проходов

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
- `--no-scaffold` — не копировать шаблон приложения; весь runnable repo создают агенты с нуля

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

По умолчанию перед агентными стадиями копируется фиксированный шаблон
`generated-webapp`, чтобы повысить шанс успешной сборки. В режиме
`--no-scaffold` шаблон не используется: Hephaestus создаёт только orchestration
artifacts (`REQUEST.md`, `SPEC.json`, `PLAN.json`, `STATUS.json`, `TASKS.json`),
а `backend`, `frontend`, `docker-compose.yml`, `.env.example`, `scripts` и
документацию должны вернуть агенты. Этот режим требует реальный `ModelProvider`;
deterministic fallback без модели в no-scaffold режиме недоступен.

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
- `HEPHAESTUS_BOT_STATE_DIR` — директория для session store, queue store и polling offset
- `HEPHAESTUS_AVAILABLE_MODELS` — список моделей в формате `id|label|description,id2|label2|description2`
- `HEPHAESTUS_MODEL_RUNTIME_MAP` — необязательное сопоставление `modelId=stub` или `modelId=ollama:model-name`
- `HEPHAESTUS_BOT_MODE` — режим `all`, `poll` или `worker`
- `HEPHAESTUS_OLLAMA_BASE_URL` — URL локального Ollama API, по умолчанию `http://127.0.0.1:11434`
- `HEPHAESTUS_OLLAMA_TIMEOUT_MS` — таймаут одного agent run для Ollama
- `HEPHAESTUS_JOB_POLL_INTERVAL_MS` — интервал опроса очереди worker в миллисекундах
- `HEPHAESTUS_NO_SCAFFOLD` — включить no-scaffold bootstrap для Telegram jobs

После выбора модели бот сохраняет её в `MODEL_SELECTION.json` внутри созданного
проекта и, если модель не `stub`, поднимает для неё реальный provider.

Это соответствует сценарию удалённого управления: Ollama и runtime живут на
одной машине, бот получает команды из Telegram, а сам проект создаётся и
валидируется локально на хосте.

Текущий LLM-first flow в боте:

1. бот сохраняет описание пользователя в `REQUEST.md`
2. бот кладёт запрос в persistent queue
3. worker на хосте берет pending job и запускает bootstrap
4. requirements-agent через Hermes/Ollama пишет `SPEC.json`
5. architect/database/backend/frontend/integrator/documentation агенты проходят pipeline
6. валидация и fixer loop выполняются локально на хосте
7. все agent runs журналируются в `AGENT_RUNS.jsonl`
8. бот присылает финальный статус и путь к проекту

Доступные локальные команды запуска:

- `npm run telegram-bot` — combined mode, один процесс для `poll + worker`
- `npm run telegram-bot-poll` — только Telegram polling UI
- `npm run telegram-bot-worker` — только queue worker

Доступные команды в Telegram:

- `/start` — инициализировать сессию
- `/new` — начать новый проект
- `/models` — показать модели
- `/status` — показать последние задания и их статусы

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
План доведения проекта до production описан в `docs/PRODUCTION_READINESS_PLAN.md`.
