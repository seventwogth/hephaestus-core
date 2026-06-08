# План доведения Hephaestus до production

Документ фиксирует путь от текущего internal beta состояния к production-ready
платформе для agent-first генерации сайтов и веб-приложений.

## Текущая оценка

Состояние на текущий момент:

- internal beta: 65-70%;
- внешний production: 40-50%;
- зрелость agent-first ядра: около 70%.

Уже есть рабочее ядро: agent stages, no-scaffold режим, mandatory manifests,
OpenAPI stage, retry stage failures, artifact completeness checks,
generation reports, Telegram queue и validation/fixer loop.

Главный разрыв до production не в базовой генерации, а в эксплуатационных
гарантиях: изоляция выполнения кода, durable queue, observability, security
boundary, реальные E2E с моделью и deploy story.

## Definition of Prod Ready

Проект считается production-ready, когда одновременно выполнены условия:

- сгенерированный код выполняется только в изолированной среде с лимитами CPU,
  memory, disk, timeout и network policy;
- jobs переживают рестарты процессов и хоста без потери состояния и без
  двойного выполнения;
- есть понятные user/project boundaries: allowlist/RBAC, ownership, quotas,
  rate limits и audit log;
- все agent runs, validations, retries, costs и failures наблюдаемы через logs,
  metrics и reports;
- есть repeatable deploy: Docker images, env validation, service definitions,
  healthchecks и backup/restore state;
- nightly E2E на реальном model provider стабильно генерирует и валидирует
  набор типовых приложений;
- release pipeline не пропускает изменения, которые ломают core contracts,
  sandbox, queue recovery, no-scaffold flow или generated app validation.

## Фаза 0. Baseline и release hygiene

Цель: зафиксировать текущую точку и исключить случайные регрессии.

Статус: baseline реализован в GitHub Actions и документации. Следующий
инженерный фокус — Фаза 1, execution sandbox hardening.

Работы:

- добавить CI pipeline для `npm ci`, `npm test`, `npm run typecheck`,
  `npm run build`;
- добавить отдельный CI job для шаблонного generated-webapp:
  `docker compose config`, Go tests, frontend build;
- включить проверку dirty lockfile и workspace consistency;
- добавить release checklist в репозиторий;
- описать supported runtime matrix: Node, npm, Go, Docker, Ollama.

Acceptance gate:

- любой PR/commit в `main` проходит полный test/typecheck/build;
- release нельзя собрать при рассинхронизированном lockfile;
- README и setup docs соответствуют фактическим env vars и CLI flags.

## Фаза 1. Execution sandbox hardening

Цель: сделать выполнение generated code безопасным для production worker.

Статус: начато. `project-sandbox` теперь изолирует command env от host secrets,
использует workspace-local HOME/cache/tmp, проверяет realpath для symlink
escape, запрещает hardlinked files, ограничивает размер stdout/stderr,
эскалирует timeout до SIGKILL и чистит runtime cache dirs после validation.
Sandbox validation summary записывается в `GENERATION_REPORT.json`, включая
failed checks, timeouts, signals и output truncation. Поведение покрыто тестами
на path traversal, symlink, hardlink, timeout, output limit, cleanup, command
allowlist edge cases, generation report failure summary и Docker runner command
interface. Docker runner уже умеет формировать запуск с bind-mounted workspace,
controlled env, network mode, CPU/memory/pids параметрами и storage limit для
container writable layer. Для production validation runner доступен
quota-managed tmpfs workspace: проект копируется внутрь workspace с hard disk
limit, команда выполняется там, а результат синхронизируется обратно в project
dir после завершения. Добавлен validation image `hephaestus/validation:local`,
CI проверяет его сборку, а CLI/Telegram worker могут включать Docker runner
через `HEPHAESTUS_SANDBOX_*`.
Для generated-webapp validation добавлена per-check network policy: dependency
шаги получают `bridge`, остальные validation checks получают `none`. После
bootstrap workspace чистится по artifact allowlist, а результат retention
попадает в `ARTIFACT_RETENTION.json` и `GENERATION_REPORT.json`. Следующий
инженерный фокус — Фаза 2, durable queue и job lifecycle.

Работы:

- запускать каждый job в отдельном workspace container;
- задать лимиты CPU, memory, disk, process count и wall-clock timeout;
- ограничить network access по стадиям:
  - model access разрешен только orchestrator/Hermes;
  - generated app validation получает минимум нужного network;
  - произвольный outbound запрещен по умолчанию;
- запретить доступ generated code к host secrets и runtime env;
- добавить cleanup policy для workspace, build cache и временных файлов;
- сохранять только разрешенные артефакты проекта после завершения job;
- расширить `project-sandbox` тестами на symlink, hardlink, path traversal,
  nested archive/extract и command allowlist edge cases.

Acceptance gate:

- malicious generated project не может прочитать env/secrets хоста;
- malicious generated project не может писать вне workspace;
- runaway build завершается по timeout/limit и помечает job как failed;
- все sandbox failure modes отражаются в job log и generation report.

## Фаза 2. Durable queue и job lifecycle

Цель: заменить single-node file queue на production-grade lifecycle.

Статус: начато. Существующий file queue оставлен как local/dev backend за
общим `ProjectJobQueue` интерфейсом и усилен production lifecycle полями:
lease recovery increments attempts, retry сохраняет lineage через `rootJobId`
и `retryOfJobId`, enqueue поддерживает `idempotencyKey`, а repeated lease
expiration переводит job в terminal `dead_letter` с диагностикой. Не закрыто:
выбор и реализация durable backend уровня Postgres/Redis, а также полноценные
ownership/retention policies.

Работы:

- выбрать durable backend: Postgres как основной вариант, Redis как возможный
  lightweight вариант;
- добавить leases, renewals, idempotency keys и dead-letter jobs;
- хранить job state machine: pending, claimed, running, cancelling, cancelled,
  failed, completed, expired;
- сделать cancel/retry идемпотентными;
- добавить per-user/project ownership;
- добавить retention policy для completed/failed jobs и generated artifacts;
- оставить file queue как local/dev backend за общим интерфейсом.

Acceptance gate:

- worker restart не теряет running job и корректно восстанавливает lease;
- два worker процесса не выполняют один job одновременно;
- cancel работает для pending и running jobs;
- retry создает новый job attempt с ссылкой на исходную попытку;
- dead-letter содержит достаточно данных для диагностики.

## Фаза 3. Observability и операционная диагностика

Цель: сделать поведение системы измеримым и отлаживаемым без чтения локальных
файлов руками.

Работы:

- ввести structured logs с `jobId`, `projectId`, `userId`, `stage`, `attempt`;
- добавить метрики:
  - job duration by stage;
  - success/failure rate;
  - retry count;
  - validation failure taxonomy;
  - generated file count;
  - agent-authored file percentage;
  - model latency/timeouts;
- расширить `GENERATION_REPORT.json`:
  - stage durations;
  - model/runtime;
  - token/cost fields, если provider поддерживает;
  - validation summary;
  - sandbox limits and violations;
- добавить health endpoints или health commands для poll/worker;
- добавить алерты для stuck jobs, high failure rate, queue backlog,
  repeated model timeouts.

Acceptance gate:

- по одному `jobId` можно восстановить весь путь генерации;
- operator видит backlog, stuck jobs и причины failures;
- reports достаточно полные для сравнения качества моделей и no-scaffold
  улучшений.

## Фаза 4. Security и multi-user boundary

Цель: безопасно пустить ограниченное число реальных пользователей.

Работы:

- добавить Telegram allowlist/RBAC;
- добавить quotas: jobs per user, concurrent jobs, disk usage, model runtime;
- добавить rate limits на команды и создание jobs;
- добавить project ownership и запрет доступа к чужим артефактам;
- редактировать logs/reports так, чтобы secrets не попадали в Telegram,
  JSONL и README сгенерированного проекта;
- добавить audit log для user commands, job actions и admin actions;
- добавить безопасную выдачу артефактов: path disclosure policy, архивирование,
  подпись или временные ссылки при необходимости.

Acceptance gate:

- неизвестный пользователь не может создать job;
- пользователь не может увидеть чужой проект;
- секреты из env и model provider config не попадают в пользовательские ответы;
- quota exhaustion дает понятную ошибку и не ломает worker.

## Фаза 5. Real-agent E2E quality gate

Цель: доказать, что agent-first генерация стабильно создает runnable apps.

Работы:

- собрать набор эталонных prompts:
  - простой CRUD;
  - несколько связанных сущностей;
  - auth-required приложение;
  - dashboard/reporting app;
  - приложение с внешним API stub;
- запускать nightly no-scaffold E2E на реальном Ollama/Hermes provider;
- сохранять generated projects, reports и validation outputs как artifacts;
- считать quality metrics:
  - first-pass validation success;
  - success after fixer;
  - number of agent retries;
  - artifact completeness failures;
  - agent-authored percentage;
- добавить compatibility matrix по моделям.

Acceptance gate:

- nightly suite проходит заданный порог качества, например:
  - 80% prompts проходят после fixer;
  - 60% prompts проходят без fixer;
  - 0 sandbox violations;
  - 0 missing required artifacts после successful bootstrap;
- деградация метрик блокирует release.

## Фаза 6. Deploy story

Цель: сделать установку и эксплуатацию повторяемой.

Работы:

- собрать Docker images для bot poller, worker и shared CLI runtime;
- добавить `docker-compose.prod.yml` для single-node deployment;
- добавить systemd service templates для poller/worker/Ollama;
- добавить env validation на старте;
- добавить backup/restore для queue DB, bot state и generated artifacts;
- описать upgrade path между версиями;
- добавить smoke-test command для production host.

Acceptance gate:

- новый host поднимается по documented runbook;
- restart host не теряет jobs;
- operator может сделать backup и restore;
- healthchecks отражают реальное состояние poller, worker, queue и model runtime.

## Рекомендуемый порядок внедрения

1. Фаза 0: CI/release baseline.
2. Фаза 1: execution sandbox hardening.
3. Фаза 2: durable queue.
4. Фаза 3: observability.
5. Фаза 4: security boundary.
6. Фаза 5: real-agent E2E.
7. Фаза 6: deploy story.

Порядок важен: публичный доступ без sandbox и durable lifecycle создает больше
риска, чем пользы. Real-agent E2E лучше запускать после observability, иначе
результаты сложно интерпретировать.

## Ближайший production milestone

Минимальный milestone для закрытой beta с несколькими пользователями:

- CI baseline включен;
- job execution изолирован в container workspace;
- Telegram allowlist включен;
- jobs имеют durable leases или, минимум, усиленный file queue с явным
  recovery/lock telemetry;
- generation report содержит stage durations и failure taxonomy;
- nightly no-scaffold E2E запускается хотя бы на 3 prompts.

После этого проект можно давать ограниченной группе пользователей на отдельной
машине без доступа к чувствительным секретам и с ручным operator supervision.

## Production blockers

До устранения этих пунктов публичный production не рекомендуется:

- generated code выполняется без жесткой container isolation;
- очередь зависит только от локального JSON-файла;
- нет per-user quotas и allowlist/RBAC;
- нет метрик stuck jobs, queue backlog и model timeouts;
- нет регулярного real-agent E2E quality gate;
- нет repeatable deployment и backup/restore runbook.

## Non-goals ближайшего production этапа

- автохостинг созданных приложений для конечных пользователей;
- marketplace шаблонов;
- произвольный стек backend/frontend;
- multi-region deployment;
- billing.

Эти направления стоит возвращать в roadmap только после стабилизации sandbox,
job lifecycle и качества agent-first генерации.
