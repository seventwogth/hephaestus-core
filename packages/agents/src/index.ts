import { type ProjectSpec, projectSpecSchema } from "@hephaestus/contracts";

export interface RequirementsAnalysisInput {
  text: string;
  projectName?: string;
}

export function analyzeRequirements(input: RequirementsAnalysisInput): ProjectSpec {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Описание проекта не должно быть пустым");
  }

  const normalizedText = text.toLowerCase();
  const requiresAuth = hasAny(normalizedText, [
    "зарегистр",
    "регистрац",
    "войти",
    "логин",
    "авторизац",
    "пользователь"
  ]);
  const projectName = input.projectName ?? inferProjectName(normalizedText);

  return projectSpecSchema.parse({
    projectName,
    description: text,
    actors: inferActors(normalizedText),
    features: inferFeatures(normalizedText),
    entities: inferEntities(normalizedText),
    requiresAuth,
    requiresDatabase: true,
    constraints: inferConstraints(normalizedText),
    acceptanceCriteria: inferAcceptanceCriteria(normalizedText, requiresAuth)
  });
}

function inferActors(text: string): ProjectSpec["actors"] {
  const actors: ProjectSpec["actors"] = [
    {
      name: "user",
      description: "Основной пользователь приложения"
    }
  ];

  if (hasAny(text, ["админ", "administrator", "admin"])) {
    actors.push({
      name: "admin",
      description: "Администратор приложения"
    });
  }

  return actors;
}

function inferFeatures(text: string): ProjectSpec["features"] {
  const features: ProjectSpec["features"] = [];

  if (hasAny(text, ["зарегистр", "регистрац"])) {
    features.push({
      id: "registration",
      title: "Регистрация",
      description: "Пользователь может создать учетную запись",
      priority: "must"
    });
  }

  if (hasAny(text, ["войти", "логин", "авторизац"])) {
    features.push({
      id: "login",
      title: "Вход в систему",
      description: "Пользователь может войти в систему",
      priority: "must"
    });
  }

  if (hasAny(text, ["добав", "созда"])) {
    features.push({
      id: "create-items",
      title: "Создание записей",
      description: "Пользователь может создавать записи предметной области",
      priority: "must"
    });
  }

  if (hasAny(text, ["редакт", "измен"])) {
    features.push({
      id: "update-items",
      title: "Редактирование записей",
      description: "Пользователь может изменять созданные записи",
      priority: "must"
    });
  }

  if (hasAny(text, ["удал"])) {
    features.push({
      id: "delete-items",
      title: "Удаление записей",
      description: "Пользователь может удалять созданные записи",
      priority: "must"
    });
  }

  if (hasAny(text, ["статус"])) {
    features.push({
      id: "status-management",
      title: "Управление статусом",
      description: "Пользователь может менять статус записи",
      priority: "must"
    });
  }

  if (hasAny(text, ["фильтр", "поиск", "искать"])) {
    features.push({
      id: "filter-items",
      title: "Фильтрация и поиск",
      description: "Пользователь может находить и фильтровать записи",
      priority: "should"
    });
  }

  if (features.length === 0) {
    features.push({
      id: "crud",
      title: "Управление данными",
      description: "Пользователь может создавать, просматривать, изменять и удалять записи",
      priority: "must"
    });
  }

  return features;
}

function inferEntities(text: string): ProjectSpec["entities"] {
  if (hasAny(text, ["книг", "book"])) {
    return [
      {
        name: "Book",
        fields: ["title", "author", "genre", "status"],
        description: "Книга в пользовательской библиотеке"
      }
    ];
  }

  if (hasAny(text, ["задач", "task"])) {
    return [
      {
        name: "Task",
        fields: ["title", "description", "status", "assignee"],
        description: "Задача пользователя или команды"
      }
    ];
  }

  if (hasAny(text, ["замет", "note"])) {
    return [
      {
        name: "Note",
        fields: ["title", "content"],
        description: "Пользовательская заметка"
      }
    ];
  }

  return [
    {
      name: "Item",
      fields: ["title", "description", "status"],
      description: "Основная сущность приложения"
    }
  ];
}

function inferConstraints(text: string): string[] {
  const constraints = ["Проект должен запускаться локально через Docker Compose"];

  if (hasAny(text, ["не должны смешиваться", "разных пользователей", "свои"])) {
    constraints.push("Данные разных пользователей не должны смешиваться");
  }

  return constraints;
}

function inferAcceptanceCriteria(text: string, requiresAuth: boolean): string[] {
  const criteria = ["Приложение запускается командой docker compose up --build"];

  if (requiresAuth) {
    criteria.push("Пользователь может зарегистрироваться и войти в систему");
  }

  criteria.push("Пользователь может управлять данными через веб-интерфейс");

  if (hasAny(text, ["не должны смешиваться", "разных пользователей", "свои"])) {
    criteria.push("Пользователь видит и изменяет только свои данные");
  }

  return criteria;
}

function inferProjectName(text: string): string {
  if (hasAny(text, ["книг", "book"])) {
    return "book-tracker";
  }

  if (hasAny(text, ["задач", "task"])) {
    return "task-tracker";
  }

  if (hasAny(text, ["замет", "note"])) {
    return "notes-service";
  }

  return "generated-web-app";
}

function hasAny(text: string, markers: string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
