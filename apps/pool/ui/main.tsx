import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { productName } from "../deployment.ts";
import { pool } from "./api.ts";
import { App } from "./app.tsx";
import "./style.css";

document.title = `Pool · ${productName}`;
const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <App api={pool} />
  </StrictMode>,
);
