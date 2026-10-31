import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./contracts.ts";

const api: DesktopApi = { request: (value) => ipcRenderer.invoke("client:request", value) };
contextBridge.exposeInMainWorld("signalboxClient", api);
