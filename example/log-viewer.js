import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogViewer } from "../src/log-viewer/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
app.use("/logs", createLogViewer({ directory: path.join(root, "log") }));
const port = Number(process.env.LOG_VIEWER_PORT || 3001);
app.listen(port, "127.0.0.1", () => console.log(`Visor de logs: http://127.0.0.1:${port}/logs/`));
