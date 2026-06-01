import React from "react";
import { createRoot } from "react-dom/client";
import { apiBaseUrl } from "./config";
import "./styles.css";

function App() {
  return (
    <main className="app-shell">
      <section>
        <p className="eyebrow">Приложение, созданное Hephaestus</p>
        <h1>Каркас приложения запущен</h1>
        <p>
          Агенты заменят этот стартовый экран маршрутами, формами и интеграцией
          с API для конкретного проекта. Базовый URL API: {apiBaseUrl}.
        </p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
