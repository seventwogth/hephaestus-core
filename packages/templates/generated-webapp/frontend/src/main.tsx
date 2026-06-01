import React from "react";
import { createRoot } from "react-dom/client";
import { apiBaseUrl } from "./config";
import "./styles.css";

function App() {
  return (
    <main className="app-shell">
      <section>
        <p className="eyebrow">Hephaestus generated app</p>
        <h1>Application scaffold is running</h1>
        <p>
          Agents will replace this starter screen with project-specific routes,
          forms, and API integration. API base URL: {apiBaseUrl}.
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
