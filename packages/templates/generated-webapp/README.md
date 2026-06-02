# Шаблон генерируемого веб-приложения

Это фиксированная MVP-цель для приложений, которые генерирует Hephaestus.

## Стек

- Frontend: React, TypeScript, Vite
- Backend: Go, chi
- База данных: PostgreSQL
- API: REST
- Запуск: Docker Compose

## Команды

```bash
docker compose up --build
```

```bash
./scripts/test.sh
```

Backend поднимает PostgreSQL-подключение по `DATABASE_URL`, применяет
встроенные миграции из `backend/migrations` и затем запускает HTTP API.
