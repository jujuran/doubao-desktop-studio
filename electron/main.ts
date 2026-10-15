import path from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import type { AppSettings, TaskRecord, TaskStatus } from "./contracts.js";
import { initializeDataLocation, scheduleDataMigration } from "./data-location.js";
import { StudioDatabase } from "./database.js";
import { AccountSessionManager } from "./sessions.js";

const appDataPath = app.getPath("appData");
const defaultUserDataPath = app.getPath("userData");
const dataLocation = initializeDataLocation(appDataPath, defaultUserDataPath);
if (dataLocation.userDataPath !== defaultUserDataPath) {
  app.setPath("userData", dataLocation.userDataPath);
}

let mainWindow: BrowserWindow | null = null;
let database: StudioDatabase;
const sessions = new AccountSessionManager();

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: "Doubao Desktop Studio",
    backgroundColor: "#f4f4ef",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void win.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
}

function notifyChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("data:changed");
}

function registerIpc() {
  ipcMain.handle("accounts:list", () => database.listAccounts());
  ipcMain.handle("accounts:create", (_event, label: string) => {
    const account = database.createAccount(label);
    sessions.open(account);
    notifyChanged();
    return account;
  });
  ipcMain.handle("accounts:open", (_event, id: string) => {
    sessions.open(database.getAccount(id));
  });
  ipcMain.handle("accounts:verify", async (_event, id: string) => {
    const account = database.getAccount(id);
    try {
      const identity = await sessions.verify(account);
      const updated = database.updateIdentity(id, identity);
      notifyChanged();
      return { ok: true, account: updated, message: `已确认豆包账号 ${identity.userId}` };
    } catch (error) {
      const updated = database.setAccountStatus(id, "login_required");
      notifyChanged();
      return { ok: false, account: updated, message: errorMessage(error) };
    }
  });
  ipcMain.handle("accounts:clear-cache", async (_event, id: string) => {
    await sessions.clearCache(database.getAccount(id));
    notifyChanged();
  });
  ipcMain.handle("accounts:remove", async (_event, id: string) => {
    const account = database.getAccount(id);
    await sessions.remove(account);
    database.deleteAccount(id);
    notifyChanged();
  });

  ipcMain.handle("tasks:list", () => database.listTasks());
  ipcMain.handle("tasks:create", (_event, input: Pick<TaskRecord, "accountId" | "prompt" | "model" | "duration" | "aspectRatio">) => {
    const task = database.createTask(input);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:open", (_event, id: string) => {
    const task = database.getTask(id);
    if (!task.accountId) throw new Error("请先为任务选择账号");
    const account = database.getAccount(task.accountId);
    clipboard.writeText(task.prompt);
    sessions.open(account, "chat");
    const updated = database.setTaskStatus(id, "running");
    notifyChanged();
    return updated;
  });
  ipcMain.handle("tasks:update-status", (_event, id: string, status: TaskStatus) => {
    const task = database.setTaskStatus(id, status);
    notifyChanged();
    return task;
  });

  ipcMain.handle("settings:get", () => database.getSettings());
  ipcMain.handle("settings:update", (_event, input: Partial<AppSettings>) => {
    const settings = database.updateSettings(input);
    notifyChanged();
    return settings;
  });
  ipcMain.handle("runtime:stats", () => {
    const metrics = app.getAppMetrics();
    const totalPrivateKb = metrics.reduce((sum, metric) => sum + (metric.memory?.privateBytes || 0), 0);
    return {
      totalPrivateMb: Math.round(totalPrivateKb / 1024),
      processCount: metrics.length,
      activeAccountWindows: sessions.activeWindowCount,
      dataPath: app.getPath("userData"),
      dataPathNotice: dataLocation.notice
    };
  });
  ipcMain.handle("runtime:choose-data-directory", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择豆包工作台数据存放位置",
      buttonLabel: "选择此位置",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return { cancelled: true, restartScheduled: false, message: "已取消更改数据目录" };
    }

    const targetPath = scheduleDataMigration(appDataPath, app.getPath("userData"), result.filePaths[0]);
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 800);
    return {
      cancelled: false,
      restartScheduled: true,
      targetPath,
      message: `数据将在重启时迁移到：${targetPath}`
    };
  });
}

app.whenReady().then(() => {
  database = new StudioDatabase(app.getPath("userData"));
  registerIpc();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessions.closeAll();
  database?.close();
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
