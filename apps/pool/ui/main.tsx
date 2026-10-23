import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pool } from "./api.ts";
import { App } from "./app.tsx";
import "./style.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <App api={pool} />
  </StrictMode>,
);
