# Статус реализации относительно IDEA.md

## Уже сделано

- Зафиксирован MVP-стек генерируемых приложений: React, TypeScript, Vite, Go, chi, PostgreSQL, REST и Docker Compose.
- Создан базовый монорепозиторий ядра Hephaestus.
- Добавлен CI baseline для `main` и PR: root workspace проходит `npm ci`, lockfile consistency check, tests, typecheck и build, а шаблон generated-webapp отдельно проверяет Docker Compose config, Go tests и frontend build.
- Добавлены release checklist и supported runtime matrix для production-readiness baseline.
- Усилен `project-sandbox`: команды запускаются с минимальным env без host secrets, workspace-local HOME/cache/tmp, timeout telemetry, kill escalation, output limit, realpath-проверками symlink escape и запретом hardlinked files; sandbox failure modes попадают в `GENERATION_REPORT.json`; добавлен опциональный Docker runner interface с validation image, базовыми resource параметрами, quota-managed tmpfs workspace, per-check network policy и post-bootstrap artifact allowlist.
- Добавлены контракты артефактов `SPEC`, `PLAN`, `TASKS` и `STATUS`.
- Добавлен шаблон генерируемого приложения с frontend, backend, Docker Compose и тестами.
- Добавлен механизм создания проекта из шаблона.
- Добавлен sandbox для безопасных файловых операций и запуска allowlist-команд.
- Добавлен adapter-контракт для запуска агентных ролей через модельный провайдер.
- Добавлен CLI для создания проекта из JSON-спецификации.
- Добавлен агент аналитики требований, который превращает текстовое описание в `ProjectSpec`.
- Добавлен агент-архитектор, который формирует `ProjectPlan` и сохраняет `PLAN.json`.
- Добавлен генератор Go backend-маршрутов поверх шаблона по `PLAN.json`.
- Добавлен генератор frontend-страницы и API-клиента поверх шаблона по `PLAN.json`.
- Добавлен постоянный слой БД для Go backend: встроенные SQL-миграции, `database/sql` и PostgreSQL-backed CRUD.
- Генерация БД расширена: `SPEC/PLAN` поддерживают типизированные поля, индексы и связи между несколькими сущностями, а SQL-миграции строятся с учётом зависимостей таблиц.
- Добавлен валидатор проекта, который выполняет проверки и пишет `REVIEW.md`.
- Валидатор встроен в оркестратор как этап, который переводит проект в `TESTING`, а затем в `READY` или `FAILED`.
- Добавлен ограниченный цикл исправлений: fixer-агент получает `REVIEW.md`, может вернуть правки файлов в разрешённые пути, после чего оркестратор повторяет проверку до заданного лимита попыток.
- Добавлен Telegram-бот MVP как отдельный app: polling через Telegram Bot API, выбор модели до старта проекта и bootstrap проекта через orchestrator.
- Добавлен command-based `ModelProvider`: агентный этап можно подключать к внешнему модельному рантайму через JSON по stdin/stdout, а не только через stub-реализацию.
- Добавлен прямой `OllamaModelProvider`: Hermes теперь может вызывать локальную Ollama-модель без внешнего wrapper-процесса.
- Оркестратор получил LLM-first bootstrap flow: `REQUEST.md -> SPEC.json -> PLAN.json -> database -> backend -> frontend` через агентные роли, если сконфигурирован `ModelProvider`.
- Telegram bootstrap теперь умеет сопоставлять выбранную модель с реальным runtime и поднимать Ollama-backed provider, а не только сохранять выбор в `MODEL_SELECTION.json`.
- В основной bootstrap flow встроены `integrator` и `documentation` agent stages, а также автоматический `validate -> fixer -> revalidate` цикл после генерации кода.
- Добавлен локальный CLI entrypoint для того же LLM-first потока: проект можно запускать напрямую на машине с Ollama/Hermes без Telegram.
- Telegram-бот теперь хранит сессии, очередь заданий и polling offset на диске, а долгие генерации выполняет через persistent job queue с уведомлениями о старте, успехе и ошибке.
- Job queue lifecycle отделен от storage backend через `ProjectJobStore` и `StoredProjectJobQueue`; добавлен Postgres durable backend с миграцией, idempotency index и transactional `FOR UPDATE SKIP LOCKED` claim; file queue остается local/dev backend с теми же Phase 2 lifecycle primitives.
- Telegram polling UI и queue worker теперь можно запускать раздельно как отдельные процессы/сервисы на хост-машине.
- Добавлен интерактивный `setup.sh`, который помогает подготовить хост-машину, установить зависимости, сгенерировать `.env.hephaestus` и быстро поднять Telegram runtime.
- Документация и пользовательские тексты шаблона переведены на русский.

## Частично сделано

- Phase 1 sandbox hardening закрывает ключевые execution boundary риски: file/path boundary, command env isolation, runtime cache cleanup, timeout escalation, output limit, generation report failure summary, Docker runner command interface, validation image, env-based worker/CLI wiring, per-check network policy, Docker storage limit option, hard workspace disk quota и post-bootstrap artifact allowlist покрыты тестами/smoke checks.
- Phase 2 durable queue начата с Postgres-backed `ProjectJobStore`, общего job lifecycle и усиленного local/dev file backend, но ещё нет integration smoke с живым Postgres, ownership fields и retention policy.
- Оркестратор теперь умеет проходить основные этапы через LLM, но детерминированные генераторы всё ещё остаются fallback-путём и частью legacy-команд `requirements/plan/generate-*`.
- Telegram-бот теперь переживает рестарты по session/queue state и умеет работать в разделенном `poll/worker` режиме, но ещё нет готовых service units для systemd/launchd/Windows Service.
- Промпты agent stages уже охватывают full-stack flow, но качество результата всё ещё зависит от силы локальной модели и пока не разделено на более узкие под-агенты по доменам.
- Backend/frontend генераторы по-прежнему ориентированы на CRUD вокруг одной основной сущности, даже если БД-план уже содержит несколько связанных таблиц.

## Следующие крупные шаги

1. Продолжить Phase 2 production roadmap: добавить Postgres integration smoke, ownership fields и retention policy для jobs/artifacts.
2. Добавить готовые service templates для `systemd`, `launchd` и Windows Service, чтобы `poll` и `worker` поднимались как фоновые сервисы.
3. Добавить команды управления заданиями из Telegram: повторный запуск, отмена pending job, просмотр детального лога и путь к последнему проекту.
4. Расширить backend/frontend генераторы и агентные промпты с одной основной сущности до нескольких связанных ресурсов поверх уже расширенного DB-плана.
5. Добавить специализированные под-агенты для API contracts, frontend state/data layer и deployment wiring вместо больших общих промптов на этап.

## Важные расхождения

- В `IDEA.md` первоначально упоминается Node.js backend, но для генерируемых приложений принят backend на Go по текущему продуктовому решению.
- Prisma из первоначального варианта стека не используется вместе с Go backend. Для MVP выбран фиксированный вариант: `database/sql` + драйвер `pgx` + встроенные SQL-миграции внутри backend-бинаря, а схема БД формируется напрямую из `PLAN`.
- Автохостинг остается вне MVP, как и описано в `IDEA.md`.
