import path from "node:path";
import { readdirSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import type {
  AppSettings,
  ImageTaskStatus,
  ProjectReferenceKind,
  ProjectStyleInput,
  TaskInput,
  TaskStatus,
  UsageKind
} from "./contracts.js";
import { initializeDataLocation, scheduleDataMigration } from "./data-location.js";
import { StudioDatabase } from "./database.js";
import { DiagnosticsLogger, type DiagnosticLevel } from "./diagnostics.js";
import { AccountSessionManager } from "./sessions.js";
import { composeDeliveryPrompt } from "../src/prompt-compose.js";
import { inferAspectRatio } from "../src/storyboard-assets.js";

const appDataPath = app.getPath("appData");
const defaultUserDataPath = app.getPath("userData");
const dataLocation = initializeDataLocation(appDataPath, defaultUserDataPath);
if (dataLocation.userDataPath !== defaultUserDataPath) {
  app.setPath("userData", dataLocation.userDataPath);
}

let mainWindow: BrowserWindow | null = null;
let database: StudioDatabase;
let diagnostics: DiagnosticsLogger;
let sessions: AccountSessionManager;
interface GenerationMonitorToken {
  cancelled: boolean;
}

const activeGenerationMonitors = new Map<string, GenerationMonitorToken>();
const activeImagePreparations = new Map<string, GenerationMonitorToken>();

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
    diagnostics.info("account_created", { accountId: shortAccountId(account.id) });
    sessions.open(account);
    notifyChanged();
    return account;
  });
  ipcMain.handle("accounts:rename", (_event, id: string, label: string) => {
    const account = database.renameAccount(id, label);
    sessions.updateWindowLabel(account);
    diagnostics.info("account_label_updated", { accountId: shortAccountId(account.id) });
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
      diagnostics.info("account_verified_manually", { accountId: shortAccountId(id) });
      notifyChanged();
      return { ok: true, account: updated, message: `已确认豆包账号 ${identity.userId}` };
    } catch (error) {
      const updated = database.setAccountStatus(id, "login_required");
      diagnostics.warn("account_manual_verification_failed", {
        accountId: shortAccountId(id),
        message: errorMessage(error)
      });
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
    diagnostics.info("account_removed", { accountId: shortAccountId(id) });
    notifyChanged();
  });

  ipcMain.handle("tasks:list", () => database.listTasks());
  ipcMain.handle("tasks:create", (_event, input: TaskInput) => {
    const task = database.createTask(input);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:import-many", (_event, inputs: TaskInput[]) => {
    const tasks = database.createTasks(inputs);
    diagnostics.info("storyboard_imported", { taskCount: tasks.length });
    notifyChanged();
    return tasks;
  });
  ipcMain.handle("tasks:update", (_event, id: string, input: TaskInput) => {
    const task = database.updateTask(id, input);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:duplicate", (_event, id: string) => {
    const task = database.duplicateTask(id);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:remove", (_event, id: string) => {
    database.deleteTask(id);
    notifyChanged();
  });
  ipcMain.handle("tasks:copy-prompt", (_event, id: string) => {
    const task = database.getTask(id);
    clipboard.writeText(composeDeliveryPrompt("video", task.prompt, database.getProjectStyle(task.projectName)));
  });
  ipcMain.handle("tasks:choose-source-image", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择分镜首帧",
      buttonLabel: "使用这张图",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    if (!selected) return null;
    const image = nativeImage.createFromPath(selected);
    const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
    return { path: selected, name: path.basename(selected), aspectRatio: inferAspectRatio(size.width, size.height) };
  });
  ipcMain.handle("tasks:open-image", async (_event, id: string) => {
    const task = database.getTask(id);
    const previousMonitor = activeGenerationMonitors.get(`${id}:image`);
    if (previousMonitor) previousMonitor.cancelled = true;
    const previousPreparation = activeImagePreparations.get(id);
    if (previousPreparation) previousPreparation.cancelled = true;
    const preparationToken: GenerationMonitorToken = { cancelled: false };
    activeImagePreparations.set(id, preparationToken);
    database.setTaskPreparation(id, "image", "running", "检查前置条件");
    notifyChanged();
    try {
      if (task.firstFrameSource !== "generated") throw new Error("这个分镜不是提示词生成首帧");
      if (!task.imagePrompt) throw new Error("这个分镜没有生图提示词");
      if (!task.imageAccountId) throw new Error("请先为分镜图选择账号，或使用自动分配");
      const account = database.getAccount(task.imageAccountId);
      const projectStyle = database.getProjectStyle(task.projectName);
      const basePrompt = composeDeliveryPrompt("image", task.imagePrompt, projectStyle);
      database.setTaskPreparation(id, "image", "running", "打开生图页");
      notifyChanged();
      const prepared = await sessions.prepare(account, "image", basePrompt, null, undefined, task.aspectRatio, (progress) => {
        database.setTaskPreparation(id, "image", progress.state, progress.step);
        notifyChanged();
      }, projectStyle?.characterReferencePaths ?? []);
      if (preparationToken.cancelled) {
        const cancelled = database.restoreLockedImageState(id, "已取消重新生图，继续使用已锁定首帧");
        notifyChanged();
        return cancelled;
      }
      clipboard.writeText(prepared.prompt);
      const autoClick = database.getSettings().autoClickGenerate;
      const updated = database.setTaskPreparation(id, "image", "ready", autoClick ? "自动点击生成" : "等待你在豆包点击生成");
      startGenerationMonitor(id, "image", account.id, prepared.prompt);
      notifyChanged();
      return updated;
    } catch (error) {
      if (preparationToken.cancelled) {
        const cancelled = database.restoreLockedImageState(id, "已取消重新生图，继续使用已锁定首帧");
        notifyChanged();
        return cancelled;
      }
      const message = errorMessage(error);
      const current = database.getTask(id);
      let updated: ReturnType<StudioDatabase["getTask"]>;
      if (task.imageStatus === "approved" && task.imagePath) {
        updated = database.restoreLockedImageState(id, "重新生图未开始，继续使用已锁定首帧");
      } else {
        if (task.firstFrameSource === "generated") database.setTaskImageStatus(id, "failed");
        updated = database.setTaskPreparation(id, "image", "failed", current.imagePrepareStep || "打开生图页", message);
      }
      notifyChanged();
      throw Object.assign(new Error(message), { task: updated });
    } finally {
      if (activeImagePreparations.get(id) === preparationToken) activeImagePreparations.delete(id);
    }
  });
  ipcMain.handle("tasks:choose-image", async (event, id: string) => {
    database.getTask(id);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择已生成的分镜图",
      buttonLabel: "使用这张图",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedPath = result.filePaths[0];
    const image = nativeImage.createFromPath(selectedPath);
    const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
    const task = database.setTaskImage(id, selectedPath, inferAspectRatio(size.width, size.height));
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:import-image-candidate", async (event, id: string) => {
    database.getTask(id);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "导入已生成的分镜图候选",
      buttonLabel: "导入候选",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const updated = database.importImageCandidate(id, result.filePaths[0]);
    notifyChanged();
    return updated;
  });
  ipcMain.handle("tasks:cancel-image-regeneration", (_event, id: string) => {
    const token = activeGenerationMonitors.get(`${id}:image`);
    if (token) token.cancelled = true;
    const preparationToken = activeImagePreparations.get(id);
    if (preparationToken) preparationToken.cancelled = true;
    const updated = database.restoreLockedImageState(id, "已取消重新生图，继续使用已锁定首帧");
    diagnostics.info("image_regeneration_cancelled", { taskId: shortTaskId(id) });
    notifyChanged();
    return updated;
  });
  ipcMain.handle("tasks:update-image-status", (_event, id: string, status: ImageTaskStatus) => {
    const task = database.setTaskImageStatus(id, status);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:approve-image-candidate", async (_event, candidateId: string) => {
    let task = database.approveImageCandidate(candidateId);
    notifyChanged();
    if (database.getSettings().autoClickGenerate) task = await prepareVideoTask(task.id);
    return task;
  });
  ipcMain.handle("tasks:review-video-candidate", (_event, candidateId: string, approved: boolean) => {
    const task = database.reviewVideoCandidate(candidateId, approved);
    notifyChanged();
    return task;
  });
  ipcMain.handle("tasks:recheck-download", async (_event, id: string) => {
    const task = database.getTask(id);
    if (!task.accountId) throw new Error("请先为任务选择账号");
    const account = database.getAccount(task.accountId);
    const target = database.generationTarget(id, "video", account.label);
    database.setTaskPreparation(id, "video", "running", "重新检查并下载");
    notifyChanged();
    try {
      const item = await sessions.downloadLatestVideo(account, target.folder, target.baseName);
      database.addTaskCandidates(id, "video", target.generationIndex, [item]);
      database.setTaskStatus(id, "review", null);
      const watermarkNote = item.hasWatermark ? "（下载地址仍标记为平台水印，请人工核对）" : "";
      const updated = database.setTaskPreparation(id, "video", "ready", `原视频已下载，等待审核${watermarkNote}`);
      notifyChanged();
      return updated;
    } catch (error) {
      const message = errorMessage(error);
      database.setTaskStatus(id, "failed", message);
      const updated = database.setTaskPreparation(id, "video", "failed", "重新检查并下载失败", message);
      notifyChanged();
      throw Object.assign(new Error(message), { task: updated });
    }
  });
  ipcMain.handle("tasks:import-video-candidate", async (event, id: string) => {
    const task = database.getTask(id);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "导入已生成的视频候选",
      buttonLabel: "导入候选",
      properties: ["openFile"],
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const accountLabel = task.accountId ? database.getAccount(task.accountId).label : "未分配账号";
    const updated = database.importVideoCandidate(id, result.filePaths[0], accountLabel);
    notifyChanged();
    return updated;
  });
  ipcMain.handle("tasks:open-candidate-folder", (_event, candidateId: string) => {
    shell.showItemInFolder(database.candidateFilePath(candidateId));
  });
  ipcMain.handle("tasks:auto-assign", () => {
    const summary = database.autoAssignTasks();
    notifyChanged();
    return summary;
  });
  ipcMain.handle("tasks:open", async (_event, id: string) => prepareVideoTask(id));
  ipcMain.handle("tasks:update-status", (_event, id: string, status: TaskStatus) => {
    let task = database.setTaskStatus(id, status);
    if (status === "running") {
      if (!task.accountId) throw new Error("请先为任务选择账号");
      const finalPrompt = composeDeliveryPrompt("video", task.prompt, database.getProjectStyle(task.projectName));
      startGenerationMonitor(id, "video", task.accountId, finalPrompt);
      task = database.setTaskPreparation(id, "video", "running", "继续监听豆包生成结果");
    }
    if (status === "succeeded") task = database.setTaskPreparation(id, "video", "ready", "已手动标记完成");
    notifyChanged();
    return task;
  });

  ipcMain.handle("usage:list-today", () => database.listTodayUsage());
  ipcMain.handle("usage:adjust", (_event, accountId: string, kind: UsageKind, value: number) => {
    const usage = database.adjustUsage(accountId, kind, value);
    notifyChanged();
    return usage;
  });

  ipcMain.handle("projects:list-styles", () => database.listProjectStyles());
  ipcMain.handle("projects:save-style", (_event, input: ProjectStyleInput) => {
    const profile = database.saveProjectStyle(input);
    notifyChanged();
    return profile;
  });
  ipcMain.handle("projects:choose-reference", async (event, kind: ProjectReferenceKind) => {
    if (!["character", "scene", "style"].includes(kind)) throw new Error("参考图类型无效");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const titles: Record<ProjectReferenceKind, string> = {
      character: "选择角色或宠物定妆图",
      scene: "选择场景参考图",
      style: "选择风格参考图"
    };
    const options: Electron.OpenDialogOptions = {
      title: titles[kind],
      buttonLabel: kind === "character" ? "使用这些参考图" : "使用这张参考图",
      properties: kind === "character" ? ["openFile", "multiSelections"] : ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("projects:choose-output-directory", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择此项目的输出目录",
      buttonLabel: "使用此目录",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("projects:apply-locks", (_event, projectName: string) => {
    const count = database.applyProjectLocks(projectName);
    notifyChanged();
    return count;
  });

  ipcMain.handle("imports:choose-asset-folder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: "选择项目首帧素材文件夹",
      buttonLabel: "使用此文件夹",
      properties: ["openDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { cancelled: true, folderPath: null, files: [] };
    const folderPath = result.filePaths[0];
    const files = readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => {
        const filePath = path.join(folderPath, entry.name);
        const image = nativeImage.createFromPath(filePath);
        const size = image.getSize();
        return {
          name: entry.name,
          path: filePath,
          width: size.width,
          height: size.height,
          thumbnailUrl: image.isEmpty() ? "" : image.resize({ width: 120 }).toDataURL()
        };
      });
    return { cancelled: false, folderPath, files };
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
      version: app.getVersion(),
      totalPrivateMb: Math.round(totalPrivateKb / 1024),
      processCount: metrics.length,
      activeAccountWindows: sessions.activeWindowCount,
      activeAccountIds: sessions.activeAccountIds,
      dataPath: app.getPath("userData"),
      logPath: diagnostics.logPath,
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
  ipcMain.handle("runtime:export-diagnostics", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
    const options: Electron.SaveDialogOptions = {
      title: "导出诊断信息",
      defaultPath: `doubao-studio-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: "文本文件", extensions: ["txt"] }]
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { cancelled: true, message: "已取消导出诊断信息" };
    }

    const accounts = database.listAccounts();
    const report = diagnostics.buildReport({
      version: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      electron: process.versions.electron,
      accountCount: accounts.length,
      accounts: accounts.map((account, index) => ({
        index: index + 1,
        status: account.status,
        hasIdentity: Boolean(account.doubaoUserId),
        lastVerifiedAt: account.lastVerifiedAt,
        windowOpen: sessions.activeAccountIds.includes(account.id)
      }))
    });
    writeFileSync(result.filePath, report, "utf8");
    diagnostics.info("diagnostics_exported");
    return { cancelled: false, filePath: result.filePath, message: `诊断信息已导出：${result.filePath}` };
  });
}

async function prepareVideoTask(id: string) {
  const task = database.getTask(id);
  database.setTaskPreparation(id, "video", "running", "检查前置条件");
  notifyChanged();
  try {
    if (!task.accountId) throw new Error("请先为任务选择账号");
    if (task.firstFrameSource !== "none" && task.imageStatus !== "approved") throw new Error("请先锁定首帧，再制作分镜视频");
    if (task.firstFrameSource !== "none" && !task.imagePath) throw new Error("首帧文件不存在，请重新选择或生成首帧");
    const account = database.getAccount(task.accountId);
    const finalPrompt = composeDeliveryPrompt("video", task.prompt, database.getProjectStyle(task.projectName));
    clipboard.writeText(finalPrompt);
    diagnostics.info("video_task_prepare_started", { taskId: shortTaskId(id), accountId: shortAccountId(account.id) });
    database.setTaskPreparation(id, "video", "running", "打开视频页");
    notifyChanged();
    await sessions.prepare(
      account,
      "video",
      finalPrompt,
      task.firstFrameSource === "none" ? null : task.imagePath,
      { model: task.model, duration: task.duration, aspectRatio: task.aspectRatio },
      undefined,
      (progress) => {
        database.setTaskPreparation(id, "video", progress.state, progress.step);
        notifyChanged();
      }
    );
    database.setTaskStatus(id, task.status === "failed" ? "queued" : task.status, null);
    const autoClick = database.getSettings().autoClickGenerate;
    const updated = database.setTaskPreparation(id, "video", "ready", autoClick ? "自动点击生成" : "等待你在豆包点击生成");
    startGenerationMonitor(id, "video", account.id, finalPrompt);
    diagnostics.info("video_task_prepare_completed", { taskId: shortTaskId(id), accountId: shortAccountId(account.id) });
    notifyChanged();
    return updated;
  } catch (error) {
    const message = errorMessage(error);
    database.setTaskStatus(id, "failed", message);
    const current = database.getTask(id);
    const updated = database.setTaskPreparation(id, "video", "failed", current.videoPrepareStep || "打开视频页", message);
    diagnostics.error("video_task_prepare_failed", { taskId: shortTaskId(id), message });
    notifyChanged();
    throw Object.assign(new Error(message), { task: updated });
  }
}

function startGenerationMonitor(taskId: string, route: "image" | "video", accountId: string, prompt: string) {
  const monitorKey = `${taskId}:${route}`;
  const previous = activeGenerationMonitors.get(monitorKey);
  if (previous) previous.cancelled = true;
  const token: GenerationMonitorToken = { cancelled: false };
  activeGenerationMonitors.set(monitorKey, token);
  const task = database.getTask(taskId);
  const account = database.getAccount(accountId);
  const target = database.generationTarget(taskId, route, account.label);
  const autoClick = database.getSettings().autoClickGenerate;
  let generationStarted = false;
  void sessions.monitorGeneration(account, {
    route,
    prompt,
    outputFolder: target.folder,
    baseName: target.baseName,
    generationIndex: target.generationIndex,
    autoClick,
    imageAspectRatio: route === "image" ? task.aspectRatio : undefined,
    videoSettings: route === "video" ? { model: task.model, duration: task.duration, aspectRatio: task.aspectRatio } : undefined,
    expectsFirstFrame: route === "video" && task.firstFrameSource !== "none",
    shouldCancel: () => token.cancelled,
    onProgress(state, step) {
      try {
        if (state === "started") generationStarted = true;
        if (state === "waiting") database.setTaskPreparation(taskId, route, "ready", step);
        if (state === "started" && route === "image") {
          database.setTaskImageStatus(taskId, "submitted");
          database.setTaskPreparation(taskId, route, "running", step);
        }
        if (state === "started" && route === "video") {
          let current = database.getTask(taskId);
          if (current.status !== "submitted" && current.status !== "running") {
            if (!["queued", "failed", "cancelled"].includes(current.status)) {
              current = database.setTaskStatus(taskId, "queued", null);
            }
            database.setTaskStatus(taskId, "submitted", null);
          }
          database.setTaskStatus(taskId, "running", null);
          database.setTaskPreparation(taskId, route, "running", step);
        }
        if (state === "completed") database.setTaskPreparation(taskId, route, "running", step);
        notifyChanged();
      } catch (error) {
        diagnostics.warn("generation_progress_update_failed", { taskId: shortTaskId(taskId), route, message: errorMessage(error) });
      }
    }
  }).then((items) => {
    database.addTaskCandidates(taskId, route, target.generationIndex, items);
    if (route === "image") {
      database.setTaskImageStatus(taskId, "ready");
      database.setTaskPreparation(taskId, route, "ready", `已下载 ${items.length} 张候选图，等待审核`);
    } else {
      database.setTaskStatus(taskId, "review", null);
      const watermarkNote = items.some((item) => item.hasWatermark) ? "（豆包当前下载文件含平台水印）" : "";
      database.setTaskPreparation(taskId, route, "ready", `原视频已下载，等待审核${watermarkNote}`);
    }
    diagnostics.info("generation_download_completed", { taskId: shortTaskId(taskId), route, candidateCount: items.length });
    notifyChanged();
  }).catch((error) => {
    const message = errorMessage(error);
    if (route === "image") {
      if (token.cancelled) {
        try { database.restoreLockedImageState(taskId, "已取消重新生图，继续使用已锁定首帧"); } catch {}
        diagnostics.info("generation_monitor_cancelled", { taskId: shortTaskId(taskId), route });
        notifyChanged();
        return;
      }
      if (!generationStarted && task.imageStatus === "approved" && task.imagePath && /窗口已关闭/.test(message)) {
        try { database.restoreLockedImageState(taskId, "重新生图未提交，继续使用已锁定首帧"); } catch {}
        diagnostics.info("image_regeneration_closed_before_submit", { taskId: shortTaskId(taskId) });
        notifyChanged();
        return;
      }
      if (task.imageStatus === "approved" && task.imagePath) {
        try { database.restoreLockedImageState(taskId, "重新生图未完成，已锁定首帧仍可用"); } catch {}
      } else {
        try { database.setTaskImageStatus(taskId, "failed"); } catch {}
      }
    } else {
      database.setTaskStatus(taskId, "failed", message);
    }
    database.setTaskPreparation(taskId, route, "failed", route === "image" ? "生图或下载失败（已锁定首帧未受影响）" : "视频生成或下载失败", message);
    diagnostics.error("generation_monitor_failed", { taskId: shortTaskId(taskId), route, message });
    notifyChanged();
  }).finally(() => {
    if (activeGenerationMonitors.get(monitorKey) === token) activeGenerationMonitors.delete(monitorKey);
  });
}

app.whenReady().then(() => {
  database = new StudioDatabase(app.getPath("userData"));
  diagnostics = new DiagnosticsLogger(app.getPath("userData"));
  sessions = new AccountSessionManager({
    onIdentity: (accountId, identity) => {
      try {
        const previous = database.getAccount(accountId);
        const changed = previous.status !== "ready"
          || previous.doubaoUserId !== identity.userId
          || previous.displayName !== identity.displayName
          || previous.avatarUrl !== identity.avatarUrl;
        database.updateIdentity(accountId, identity);
        if (changed) notifyChanged();
      } catch (error) {
        diagnostics.warn("automatic_identity_update_failed", {
          accountId: shortAccountId(accountId),
          message: errorMessage(error)
        });
      }
    },
    onLoginRequired: (accountId) => {
      try {
        const account = database.getAccount(accountId);
        if (account.status !== "login_required") {
          database.setAccountStatus(accountId, "login_required");
          notifyChanged();
        }
      } catch (error) {
        diagnostics.warn("login_status_update_failed", {
          accountId: shortAccountId(accountId),
          message: errorMessage(error)
        });
      }
    },
    onDiagnostic: (level, event, details) => logDiagnostic(level, event, details)
  });
  diagnostics.info("application_started", {
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch
  });
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
  diagnostics?.info("application_stopping");
  sessions?.closeAll();
  database?.close();
});

app.on("render-process-gone", (_event, webContents, details) => {
  diagnostics?.error("render_process_gone", {
    reason: details.reason,
    exitCode: details.exitCode,
    url: safeUrl(webContents.getURL())
  });
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function shortAccountId(accountId: string) {
  return accountId.slice(0, 8);
}

function shortTaskId(taskId: string) {
  return taskId.slice(0, 8);
}

function logDiagnostic(level: DiagnosticLevel, event: string, details?: Record<string, unknown>) {
  diagnostics[level](event, details);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return "file://local-app";
    const firstPathSegment = url.pathname.split("/").filter(Boolean)[0];
    return `${url.origin}${firstPathSegment ? `/${firstPathSegment}/` : "/"}`;
  } catch {
    return "unknown";
  }
}
