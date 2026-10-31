import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  shell,
  Tray,
} from "electron";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { brand } from "../../brand.ts";
import { desktopController } from "./controller.ts";
import { readDesktopRequest } from "./contracts.ts";

const directory = join(app.getAppPath(), ".dist");
function directoryOption(flag: string, fallback: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const path = process.argv[index + 1];
  if (!path || path.startsWith("--")) throw new Error(`Choose a directory for ${flag}.`);
  return resolve(path);
}
app.setPath("userData", directoryOption("--user-data-dir", app.getPath("userData")));
const configHome = directoryOption("--config-home", homedir());
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let controller: ReturnType<typeof desktopController> | undefined;
const show = () => {
  window?.show();
  window?.focus();
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName(brand.name);
  app.on("second-instance", show);
  app.on("activate", show);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (controller?.close() ?? Promise.resolve()).finally(() => {
      tray?.destroy();
      app.quit();
    });
  });
  void app
    .whenReady()
    .then(async () => {
      const web = session.fromPartition("signalbox-client");
      web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      web.setPermissionCheckHandler(() => false);
      controller = desktopController({
        home: join(app.getPath("userData"), "connection"),
        configHome,
        env: process.env,
        executable: process.execPath,
        connectionEntry: app.isPackaged
          ? join(process.resourcesPath, "app.asar.unpacked", ".dist", "connection.mjs")
          : join(directory, "connection.mjs"),
        openBrowser: (url) => shell.openExternal(url),
        chooseDirectFile: async () => {
          const result = await dialog.showOpenDialog({
            title: "Import direct credentials",
            properties: ["openFile"],
            filters: [{ name: "Private credentials", extensions: ["json"] }],
          });
          return result.canceled ? undefined : result.filePaths[0];
        },
      });
      const page = join(directory, "index.html");
      window = new BrowserWindow({
        width: 560,
        height: 740,
        minWidth: 420,
        minHeight: 560,
        title: brand.name,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
        webPreferences: {
          preload: join(directory, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          session: web,
        },
      });
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window?.hide();
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      ipcMain.handle("client:request", async (event, raw: unknown) => {
        const contents = window?.webContents;
        if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame)
          throw new Error("This window cannot control the connection.");
        return controller?.request(readDesktopRequest(raw));
      });
      const menu = Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [
              {
                label: brand.name,
                submenu: [
                  { label: `About ${brand.name}`, role: "about" as const },
                  { type: "separator" as const },
                  { role: "hide" as const },
                  { label: `Quit ${brand.name}`, role: "quit" as const },
                ],
              },
            ]
          : []),
        {
          label: "File",
          submenu: [
            { label: "Show connection", click: show },
            { label: `Quit ${brand.name}`, role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
      ]);
      Menu.setApplicationMenu(menu);
      const icon = nativeImage
        .createFromPath(join(directory, "icon.png"))
        .resize({ width: process.platform === "darwin" ? 18 : 24 });
      tray = new Tray(icon);
      tray.setToolTip(brand.name);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Show connection", click: show },
          { type: "separator" },
          { label: `Quit ${brand.name}`, role: "quit" },
        ]),
      );
      tray.on("click", show);
      await window.loadFile(page);
      await controller.initialize();
    })
    .catch(() => {
      quitting = true;
      void (controller?.close() ?? Promise.resolve()).finally(() => app.quit());
    });
}
