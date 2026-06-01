import { describe, expect, it } from "vitest";
import { analyzeRequirements, createArchitecturePlan } from "./index.js";

describe("analyzeRequirements", () => {
  it("turns a Russian book tracker request into a ProjectSpec", () => {
    const spec = analyzeRequirements({
      text: "Создай сервис учёта книг. Пользователь должен зарегистрироваться, войти в систему, добавлять книги, указывать автора и жанр, менять статус прочтения, редактировать и удалять записи. Данные разных пользователей не должны смешиваться."
    });

    expect(spec.projectName).toBe("book-tracker");
    expect(spec.requiresAuth).toBe(true);
    expect(spec.entities[0]?.name).toBe("Book");
    expect(spec.features.map((feature) => feature.id)).toContain("registration");
    expect(spec.features.map((feature) => feature.id)).toContain("status-management");
    expect(spec.constraints).toContain("Данные разных пользователей не должны смешиваться");
  });

  it("supports explicit project name override", () => {
    const spec = analyzeRequirements({
      projectName: "custom-crm",
      text: "Нужно приложение для управления задачами команды"
    });

    expect(spec.projectName).toBe("custom-crm");
    expect(spec.entities[0]?.name).toBe("Task");
  });

  it("rejects empty descriptions", () => {
    expect(() => analyzeRequirements({ text: " " })).toThrow("не должно быть пустым");
  });

  it("creates an architecture plan from ProjectSpec", () => {
    const spec = analyzeRequirements({
      text: "Создай сервис учета книг. Пользователь должен зарегистрироваться, войти, добавлять книги, редактировать и удалять записи."
    });
    const plan = createArchitecturePlan(spec);

    expect(plan.stack.backend).toBe("go-chi");
    expect(plan.backendModules).toContain("auth");
    expect(plan.backendModules).toContain("books");
    expect(plan.frontendRoutes).toContain("/books");
    expect(plan.endpoints.map((endpoint) => endpoint.path)).toContain("/api/books");
    expect(plan.validationCommands).toContain("cd backend && go test ./...");
  });
});
