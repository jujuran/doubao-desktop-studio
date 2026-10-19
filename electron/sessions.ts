import { BrowserWindow, clipboard, session } from "electron";
import type { DownloadItem, Event } from "electron";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Account } from "./contracts.js";
import { extractDoubaoIdentity, type DoubaoIdentity } from "./identity.js";
import {
  compareDoubaoVideoSettings,
  concreteDuration,
  doubaoAspectRatio,
  durationToSliderValue,
  isDoubaoVideoModeActive,
  normalizeComposerText,
  normalizedModelName,
  parseDoubaoImageAspectText,
  parseDoubaoVideoParameterText,
  videoSourceHasWatermark,
  type DoubaoVideoModeSnapshot,
  type DoubaoVideoSettings
} from "../src/doubao-video.js";

const DOUBAO_HOME = "https://www.doubao.com/";
const DOUBAO_CHAT = "https://www.doubao.com/chat/";
const DOUBAO_IMAGE = "https://www.doubao.com/chat/create-image";
const DOUBAO_ACCOUNT_INFO = "/passport/account/info/v2/?aid=497858&account_sdk_source=web&sdk_version=2.2.11-doubao.0&device_platform=web";
const LOGIN_CHECK_INTERVAL = 10_000;
const HEALTH_CHECK_INTERVAL = 5 * 60_000;

interface AccountSessionEvents {
  onIdentity(accountId: string, identity: DoubaoIdentity): void;
  onLoginRequired(accountId: string): void;
  onDiagnostic(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>): void;
}

interface MonitorState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  hasIdentity: boolean;
  loginRequiredReported: boolean;
  consecutiveMissing: number;
}

export interface PreparationProgress {
  stage: "image" | "video";
  state: "running";
  step: string;
}

export interface GenerationMonitorOptions {
  route: "image" | "video";
  prompt: string;
  outputFolder: string;
  baseName: string;
  generationIndex: number;
  autoClick: boolean;
  imageAspectRatio?: string;
  videoSettings?: DoubaoVideoSettings;
  expectsFirstFrame?: boolean;
  onProgress?: (state: "waiting" | "started" | "completed", step: string) => void;
}

export interface DownloadedGenerationCandidate {
  sourceUrl: string;
  filePath: string;
  hasWatermark: boolean;
}

export class AccountSessionManager {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly monitors = new Map<string, MonitorState>();

  constructor(private readonly events: AccountSessionEvents) {}

  get activeWindowCount() {
    return this.windows.size;
  }

  get activeAccountIds() {
    return [...this.windows.keys()];
  }

  open(account: Account, route: "home" | "chat" | "image" | "video" = "home", visible = true) {
    const existing = this.windows.get(account.id);
    if (existing && !existing.isDestroyed()) {
      if (visible) {
        existing.show();
        existing.focus();
      }
      if (route !== "home") void existing.loadURL(routeUrl(route));
      this.scheduleMonitor(account, existing, 250);
      return existing;
    }

    const accountSession = session.fromPartition(account.partition, { cache: true });
    accountSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 640,
      title: `豆包 · ${account.label}`,
      show: visible,
      backgroundColor: "#f7f7f3",
      autoHideMenuBar: true,
      webPreferences: {
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
        spellcheck: false
      }
    });

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault();
    });
    win.webContents.on("did-finish-load", () => this.scheduleMonitor(account, win, 1_500));
    win.on("closed", () => {
      this.stopMonitor(account.id);
      this.windows.delete(account.id);
      this.events.onDiagnostic("info", "account_window_closed", { accountId: shortAccountId(account.id) });
    });
    this.windows.set(account.id, win);
    this.monitors.set(account.id, {
      timer: null,
      running: false,
      hasIdentity: account.status === "ready",
      loginRequiredReported: account.status === "login_required",
      consecutiveMissing: 0
    });
    this.events.onDiagnostic("info", "account_window_opened", {
      accountId: shortAccountId(account.id),
      route,
      visible
    });
    void win.loadURL(routeUrl(route));
    return win;
  }

  async prepare(
    account: Account,
    route: "image" | "video",
    prompt: string,
    attachmentPath: string | null = null,
    videoSettings?: DoubaoVideoSettings,
    imageAspectRatio?: string,
    onProgress?: (progress: PreparationProgress) => void
  ) {
    onProgress?.({ stage: route, state: "running", step: route === "video" ? "打开视频页" : "打开生图页" });
    const win = this.open(account, route, true);
    await waitForLoad(win);
    if (route === "video") {
      if (!videoSettings) throw new Error("缺少视频模型、比例和时长设置");
      const run = <T>(step: string, operation: () => Promise<T>) => runVideoStep(
        step, prompt, operation, (level, event, details) => this.events.onDiagnostic(level, event, {
          accountId: shortAccountId(account.id), step, ...details
        })
      );
      const runWithProgress = <T>(step: string, operation: () => Promise<T>) => {
        onProgress?.({ stage: "video", state: "running", step });
        return run(step, operation);
      };
      await runWithProgress("进入视频生成", () => enterVideoGeneration(win));
      await runWithProgress("设置模型、比例和时长", () => applyVideoSettings(win, videoSettings));
      if (attachmentPath) {
        const previousThumbnailCount = await runWithProgress("上传首帧", () => attachFirstFrame(win, attachmentPath));
        await runWithProgress("等待首帧缩略图", async () => {
          if (!await waitForUploadedThumbnail(win, previousThumbnailCount)) {
            throw new Error("上传后没有检测到首帧缩略图");
          }
        });
      }
      await runWithProgress("填写提示词", async () => {
        if (!await fillAndConfirmComposer(win, prompt)) throw new Error("豆包输入框没有保留完整提示词");
      });
      await runWithProgress("回读并核对模型、比例和时长", async () => {
        const actual = await readVideoSettings(win);
        const mismatches = compareDoubaoVideoSettings(videoSettings, actual);
        if (mismatches.length) {
          throw new Error(`${mismatches.join("；")}。已停止在生成前`);
        }
      });
    } else {
      if (!imageAspectRatio) throw new Error("缺少生图画幅设置");
      onProgress?.({ stage: "image", state: "running", step: "进入图像生成" });
      await runImageStep("进入图像生成", prompt, () => enterImageGeneration(win), (level, event, details) => {
        this.events.onDiagnostic(level, event, { accountId: shortAccountId(account.id), step: "进入图像生成", ...details });
      });
      onProgress?.({ stage: "image", state: "running", step: "设置图片比例" });
      await runImageStep("设置图片比例", prompt, () => applyImageAspectRatio(win, imageAspectRatio), (level, event, details) => {
        this.events.onDiagnostic(level, event, { accountId: shortAccountId(account.id), step: "设置图片比例", ...details });
      });
      if (attachmentPath) await attachFirstFrame(win, attachmentPath);
      onProgress?.({ stage: "image", state: "running", step: "填写提示词" });
      await runImageStep("填写提示词", prompt, async () => {
        if (!await fillAndConfirmComposer(win, prompt)) throw new Error("豆包输入框未能保留提示词");
      }, (level, event, details) => {
        this.events.onDiagnostic(level, event, { accountId: shortAccountId(account.id), step: "填写提示词", ...details });
      });
    }
    return win;
  }

  async monitorGeneration(account: Account, options: GenerationMonitorOptions): Promise<DownloadedGenerationCandidate[]> {
    const win = this.windows.get(account.id);
    if (!win || win.isDestroyed()) throw new Error("豆包窗口已关闭，无法监测生成结果");
    const baseline = await readGenerationSnapshot(win, options.route);
    if (options.autoClick) {
      await verifyBeforeSubmit(win, options);
      if (!await clickGenerateButton(win)) throw new Error("生成前核对已通过，但没有找到可点击的生成按钮");
    } else {
      options.onProgress?.("waiting", "等待你在豆包点击生成");
    }
    const started = options.route === "video"
      ? await waitForVideoGenerationStart(win, baseline, options.autoClick, options.onProgress)
      : await waitForGenerationStart(win, baseline, options.route, 30 * 60_000);
    if (!started) throw new Error("等待手动点击生成超时，请重新打开任务");
    options.onProgress?.("started", options.route === "image" ? "生图中" : "视频生成中");
    const completed = await waitForGenerationCompletion(win, baseline, options.route, options.onProgress);
    options.onProgress?.("completed", options.route === "image" ? "下载分镜图候选" : "下载原视频");
    mkdirSync(options.outputFolder, { recursive: true });
    if (options.route === "image") {
      const results: DownloadedGenerationCandidate[] = [];
      for (let index = 0; index < completed.imageUrls.length; index += 1) {
        const sourceUrl = completed.imageUrls[index];
        const response = await win.webContents.session.fetch(sourceUrl);
        if (!response.ok) throw new Error(`候选图下载失败：HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") || "";
        const extension = contentType.includes("png") || /\.png(?:\?|$)/i.test(sourceUrl) ? ".png" : ".jpg";
        const filePath = uniqueDownloadPath(path.join(options.outputFolder, `${options.baseName}_候选${index + 1}${extension}`));
        writeFileSync(filePath, Buffer.from(await response.arrayBuffer()));
        results.push({ sourceUrl, filePath, hasWatermark: false });
      }
      return results;
    }
    return [await downloadOfficialOriginal(win, options.outputFolder, options.baseName)];
  }

  async downloadLatestVideo(account: Account, outputFolder: string, baseName: string) {
    const win = this.windows.get(account.id);
    if (!win || win.isDestroyed()) throw new Error("请先打开账号对应的豆包对话，再重新检查下载");
    return downloadOfficialOriginal(win, outputFolder, baseName);
  }

  async verify(account: Account) {
    let win = this.windows.get(account.id);
    const temporary = !win || win.isDestroyed();
    if (temporary) {
      win = this.open(account, "home", false);
    }
    try {
      await waitForLoad(win!);
      const identity = await readIdentity(win!);
      if (!identity) throw new Error("尚未检测到已登录账号，请在账号窗口中完成登录");
      const monitor = this.monitors.get(account.id);
      if (monitor) {
        monitor.hasIdentity = true;
        monitor.loginRequiredReported = false;
        monitor.consecutiveMissing = 0;
      }
      return identity;
    } finally {
      if (temporary && win && !win.isDestroyed()) win.destroy();
    }
  }

  async clearCache(account: Account) {
    await session.fromPartition(account.partition).clearCache();
  }

  async remove(account: Account) {
    const win = this.windows.get(account.id);
    if (win && !win.isDestroyed()) win.destroy();
    this.stopMonitor(account.id);
    await session.fromPartition(account.partition).clearStorageData();
  }

  updateWindowLabel(account: Account) {
    const win = this.windows.get(account.id);
    if (win && !win.isDestroyed()) win.setTitle(`豆包 · ${account.label}`);
  }

  closeAll() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    for (const accountId of this.monitors.keys()) this.stopMonitor(accountId);
    this.windows.clear();
  }

  private scheduleMonitor(account: Account, win: BrowserWindow, delay: number) {
    const state = this.monitors.get(account.id);
    if (!state || win.isDestroyed()) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.runMonitor(account, win), delay);
  }

  private async runMonitor(account: Account, win: BrowserWindow) {
    const state = this.monitors.get(account.id);
    if (!state || state.running || win.isDestroyed()) return;
    state.timer = null;
    state.running = true;
    let nextDelay = state.hasIdentity ? HEALTH_CHECK_INTERVAL : LOGIN_CHECK_INTERVAL;
    try {
      await waitForLoad(win);
      const identity = await readIdentity(win);
      if (identity) {
        const newlyDetected = !state.hasIdentity;
        state.hasIdentity = true;
        state.loginRequiredReported = false;
        state.consecutiveMissing = 0;
        this.events.onIdentity(account.id, identity);
        if (newlyDetected) {
          this.events.onDiagnostic("info", "account_login_detected", { accountId: shortAccountId(account.id) });
        }
        nextDelay = HEALTH_CHECK_INTERVAL;
      } else {
        state.consecutiveMissing += 1;
        nextDelay = LOGIN_CHECK_INTERVAL;
        if (state.consecutiveMissing >= 2 && !state.loginRequiredReported && (state.hasIdentity || account.doubaoUserId)) {
          state.hasIdentity = false;
          state.loginRequiredReported = true;
          this.events.onLoginRequired(account.id);
          this.events.onDiagnostic("warn", "account_login_expired", { accountId: shortAccountId(account.id) });
        }
      }
    } catch (error) {
      this.events.onDiagnostic("warn", "account_identity_check_failed", {
        accountId: shortAccountId(account.id),
        message: errorMessage(error)
      });
    } finally {
      state.running = false;
      if (!win.isDestroyed() && this.monitors.has(account.id)) {
        this.scheduleMonitor(account, win, nextDelay);
      }
    }
  }

  private stopMonitor(accountId: string) {
    const state = this.monitors.get(accountId);
    if (state?.timer) clearTimeout(state.timer);
    this.monitors.delete(accountId);
  }
}

async function runImageStep<T>(
  step: string,
  prompt: string,
  operation: () => Promise<T>,
  onDiagnostic?: (level: "info" | "error", event: string, details?: Record<string, unknown>) => void
) {
  onDiagnostic?.("info", "image_prepare_step_started");
  try {
    const result = await operation();
    onDiagnostic?.("info", "image_prepare_step_completed");
    return result;
  } catch (error) {
    clipboard.writeText(prompt);
    onDiagnostic?.("error", "image_prepare_step_failed", { message: errorMessage(error) });
    throw new Error(`生图准备停在【${step}】步骤：${errorMessage(error)}。提示词已复制到剪贴板`);
  }
}

async function enterImageGeneration(win: BrowserWindow) {
  const active = async () => {
    const snapshot = await win.webContents.executeJavaScript(`
      (() => {
        const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const texts = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [tabindex], [class*="select" i], [class*="trigger" i]')).filter(visible).map(element => (element.textContent || '').replace(/\\s+/g, ' ').trim());
        const selectedImageTab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"], [data-testid="creation-skill-switch-tab-image"][data-state="active"]')).filter(visible).some(element => (element.textContent || '').replace(/\\s+/g, '').trim() === '图像');
        return { texts, selectedImageTab };
      })()
    `, true) as { texts: string[]; selectedImageTab: boolean };
    const hasMode = snapshot.selectedImageTab || snapshot.texts.some((value) => /^图像生成(?:[×✕✖xX])?$/.test(value.replace(/\s+/g, "")));
    const hasModel = snapshot.texts.some((value) => /Seedream/i.test(value));
    const hasAspect = snapshot.texts.some((value) => parseDoubaoImageAspectText(value) !== null);
    return hasMode && hasModel && hasAspect;
  };
  if (await active()) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissDesktopDownloadPrompt(win);
    if (!await clickVisibleText(win, ["图像生成"], true)) {
      if (await clickVisibleText(win, ["AI 创作"], true)) {
        await delay(700);
        await clickVisibleText(win, ["图像"], true);
      }
    }
    if (await waitUntil(active, 5_000, 350)) return;
    await delay(500);
  }
  throw new Error("没有确认豆包已切换到图像生成技能");
}

async function applyImageAspectRatio(win: BrowserWindow, aspectRatio: string) {
  const expected = doubaoAspectRatio(aspectRatio);
  const controlReady = await waitUntil(async () => Boolean(await findImageAspectControl(win)), 12_000, 350);
  if (!controlReady) {
    const candidates = await readImageAspectCandidates(win);
    throw new Error(`等待图片比例选择器超时（页面候选：${candidates.join("/") || "未识别"}）`);
  }
  const initial = await readImageAspectRatio(win);
  if (doubaoAspectRatio(initial) === expected) return;
  const control = await findImageAspectControl(win);
  if (!control) throw new Error(`没有找到图片比例选择器；当前回读为 ${initial || "未识别"}`);
  await clickPoint(win, control.x, control.y);
  const optionReady = await waitUntil(() => hasVisibleText(win, [expected], true), 4_000, 250);
  if (!optionReady) throw new Error(`图片比例菜单未打开，或没有找到 ${expected}`);
  if (!await clickVisibleText(win, [expected], true)) throw new Error(`图片比例 ${expected} 点击失败`);
  const applied = await waitUntil(async () => doubaoAspectRatio(await readImageAspectRatio(win)) === expected, 4_000, 250);
  if (!applied) {
    const actual = await readImageAspectRatio(win);
    throw new Error(`图片比例设置后仍为 ${actual || "未识别"}，应为 ${expected}`);
  }
}

async function findImageAspectControl(win: BrowserWindow) {
  const candidates = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('body *'))
        .filter(element => visible(element) && (element.textContent || '').includes('比例'))
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { text: (element.textContent || '').trim(), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), area: rect.width * rect.height };
        });
    })()
  `, true) as Array<{ text: string; x: number; y: number; area: number }>;
  return candidates
    .filter((candidate) => parseDoubaoImageAspectText(candidate.text) !== null)
    .sort((a, b) => a.area - b.area)[0] || null;
}

async function readImageAspectRatio(win: BrowserWindow) {
  const texts = await readImageAspectCandidates(win);
  return texts.map(parseDoubaoImageAspectText).find((value) => value !== null) || "";
}

async function readImageAspectCandidates(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('body *'))
        .filter(element => visible(element) && (element.textContent || '').includes('比例'))
        .map(element => (element.textContent || '').trim())
        .filter((value, index, values) => value.length <= 40 && values.indexOf(value) === index)
        .slice(0, 12);
    })()
  `, true) as Promise<string[]>;
}

function routeUrl(route: "home" | "chat" | "image" | "video") {
  if (route === "chat") return DOUBAO_CHAT;
  if (route === "image") return DOUBAO_IMAGE;
  if (route === "video") return DOUBAO_HOME;
  return DOUBAO_HOME;
}

async function runVideoStep<T>(
  step: string,
  prompt: string,
  operation: () => Promise<T>,
  onDiagnostic?: (level: "info" | "error", event: string, details?: Record<string, unknown>) => void
) {
  onDiagnostic?.("info", "video_prepare_step_started");
  try {
    const result = await operation();
    onDiagnostic?.("info", "video_prepare_step_completed");
    return result;
  } catch (error) {
    clipboard.writeText(prompt);
    onDiagnostic?.("error", "video_prepare_step_failed", { message: errorMessage(error) });
    throw new Error(`视频准备停在【${step}】步骤：${errorMessage(error)}。提示词已复制到剪贴板`);
  }
}

async function attachFirstFrame(win: BrowserWindow, filePath: string) {
  if (win.isDestroyed()) throw new Error("豆包窗口已关闭");
  const deadline = Date.now() + 12_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await revealImageInput(win);
      const previousThumbnailCount = await countUploadedThumbnails(win);
      if (await setFileInput(win, filePath)) return previousThumbnailCount;
    } catch (error) {
      lastError = error;
    }
    await delay(400);
  }
  throw new Error(`没有找到可用的首帧图片上传控件${lastError ? `：${errorMessage(lastError)}` : ""}`);
}

async function enterVideoGeneration(win: BrowserWindow) {
  if (await isVideoGenerationActive(win)) return;
  const ready = await waitUntil(() => isVideoHomeReady(win), 15_000, 400);
  if (!ready) throw new Error("豆包新对话页加载超时，没有出现技能入口或输入框");
  await dismissDesktopDownloadPrompt(win);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await isVideoGenerationActive(win)) return;
    let clicked = await clickVisibleText(win, ["视频生成"], true)
      || await clickVisibleText(win, ["视频生成"], false);
    if (!clicked) {
      await clickVisibleText(win, ["更多技能", "更多"], true)
        || await clickVisibleText(win, ["更多技能", "更多"], false);
      await delay(500);
      clicked = await clickVisibleText(win, ["视频生成"], true)
        || await clickVisibleText(win, ["视频生成"], false);
    }
    if (clicked && await waitUntil(() => isVideoGenerationActive(win), 5_000, 350)) return;
    if (await enterAiCreationVideo(win)) return;
    await delay(700);
  }
  const snapshot = await readVideoGenerationSnapshot(win);
  throw new Error(`已重试 3 次，但没有确认视频生成激活状态（标签：${snapshot.modeLabels.join("/") || "未识别"}；输入提示：${snapshot.composerPlaceholders.join("/") || "未识别"}；控件：${snapshot.controlTexts.filter((value) => /Seedance|自动|\d+:\d+/.test(value)).slice(0, 4).join("/") || "未识别"}）`);
}

async function dismissDesktopDownloadPrompt(win: BrowserWindow) {
  if (await clickVisibleText(win, ["下次提醒我"], true)) await delay(300);
}

async function enterAiCreationVideo(win: BrowserWindow) {
  await dismissDesktopDownloadPrompt(win);
  if (!await clickVisibleText(win, ["AI 创作"], true)) return false;
  await delay(900);
  if (await isVideoGenerationActive(win)) return true;
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const tabs = Array.from(document.querySelectorAll('[data-testid="creation-skill-switch-tab-video"], [role="tab"]')).filter(visible);
      const target = tabs.find(element => (element.textContent || '').replace(/\s+/g, '').trim() === '视频');
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) return false;
  await clickPoint(win, point.x, point.y);
  return waitUntil(() => isVideoGenerationActive(win), 5_000, 350);
}

async function isVideoGenerationActive(win: BrowserWindow) {
  return isDoubaoVideoModeActive(await readVideoGenerationSnapshot(win));
}

async function readVideoGenerationSnapshot(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`
    (() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const text = element => (element.textContent || element.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
      const modeLabels = Array.from(document.querySelectorAll('body *')).filter(element => {
        if (!visible(element)) return false;
        const normalized = text(element).replace(/\s+/g, '');
        const selectedVideoTab = normalized === '视频' && element.matches('[role="tab"][aria-selected="true"], [data-testid="creation-skill-switch-tab-video"][data-state="active"]');
        if (!/^视频生成(?:[×✕✖xX])?$/.test(normalized) && !selectedVideoTab) return false;
        return !Array.from(element.children).some(child => text(child).replace(/\s+/g, '') === normalized);
      }).map(text);
      const composerPlaceholders = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        .filter(visible).map(element => element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || '');
      const controlTexts = Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [class*="select" i], [class*="trigger" i]'))
        .filter(visible).map(text);
      return { modeLabels, composerPlaceholders, controlTexts };
    })()
  `, true) as Promise<DoubaoVideoModeSnapshot>;
}

async function isVideoHomeReady(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`
    (() => {
      if (document.readyState !== 'complete' && document.readyState !== 'interactive') return false;
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('button, [role="button"]')).some(element => visible(element) && /视频生成|更多技能/.test(element.textContent || ''))
        || Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).some(visible);
    })()
  `, true) as Promise<boolean>;
}

async function applyVideoSettings(win: BrowserWindow, settings: DoubaoVideoSettings) {
  const initial = await readVideoSettings(win);
  if (normalizedModelName(initial.model) !== normalizedModelName(settings.model)) {
    if (!await clickVideoModelControl(win)) throw new Error("已进入视频生成，但没有找到模型选择器");
    await delay(450);
    if (!await clickVisibleText(win, [settings.model], false)) {
      throw new Error(`豆包当前账号无法选择 ${settings.model}；如模型带“升级”标记，请先确认会员权限`);
    }
    await delay(600);
    const selectedModel = await readVideoSettings(win);
    if (normalizedModelName(selectedModel.model) !== normalizedModelName(settings.model)) {
      throw new Error(`模型选择后回读失败：应为 ${settings.model}，页面为 ${selectedModel.model || "未识别"}`);
    }
  }

  const parameterControl = await clickVideoParameterControl(win);
  if (!parameterControl.clicked) {
    throw new Error(`已进入视频生成，但没有找到“比例 · 时长”按钮（候选控件：${parameterControl.candidates.join("/") || "未识别"}）`);
  }
  await delay(500);
  const ratio = doubaoAspectRatio(settings.aspectRatio);
  const ratioReady = await waitUntil(() => hasVisibleText(win, [ratio], true), 4_000, 250);
  if (!ratioReady) throw new Error(`“比例 · 时长”弹层未打开，或没有找到比例 ${ratio}`);
  if (!await clickVisibleText(win, [ratio], true)) throw new Error(`比例 ${ratio} 点击失败`);
  await delay(400);
  const duration = concreteDuration(settings.duration);
  const durationResult = await setVideoDuration(win, duration);
  const settingsApplied = durationResult.applied || await waitUntil(async () => {
    const actual = await readVideoSettings(win);
    return doubaoAspectRatio(actual.aspectRatio) === ratio && actual.duration === duration;
  }, 4_000, 250);
  if (!settingsApplied) {
    const actual = await readVideoSettings(win);
    throw new Error(`参数操作后页面仍为 ${actual.aspectRatio || "未识别"} · ${actual.duration || "未识别"}s，应为 ${ratio} · ${duration}s（时长控件：${durationResult.diagnostic}）`);
  }
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await delay(500);
  const actual = await readVideoSettings(win);
  const mismatches = compareDoubaoVideoSettings(settings, actual);
  if (mismatches.length) throw new Error(`设置后回读不一致：${mismatches.join("；")}`);
}

async function clickVideoModelControl(win: BrowserWindow) {
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const target = Array.from(document.querySelectorAll('button, [role="button"], [tabindex]'))
        .filter(element => visible(element) && /Seedance/i.test(element.textContent || ''))
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) return false;
  await clickPoint(win, point.x, point.y);
  return true;
}

async function clickVideoParameterControl(win: BrowserWindow) {
  const candidates = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [class*="select" i], [class*="trigger" i]'))
        .filter(visible)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return {
            text: (element.textContent || '').trim(),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            area: rect.width * rect.height
          };
        });
    })()
  `, true) as Array<{ text: string; x: number; y: number; area: number }>;
  const point = candidates
    .filter((candidate) => parseDoubaoVideoParameterText(candidate.text) !== null)
    .sort((a, b) => a.area - b.area)[0];
  if (!point) {
    return {
      clicked: false,
      candidates: candidates
        .map((candidate) => candidate.text.replace(/\s+/g, " ").trim())
        .filter((text) => /自动|\d+:\d+|\d+\s*s/i.test(text))
        .slice(0, 8)
    };
  }
  await clickPoint(win, point.x, point.y);
  return { clicked: true, candidates: [point.text.replace(/\s+/g, " ").trim()] };
}

async function setVideoDuration(win: BrowserWindow, desired: number) {
  const exactLabels = [`${desired}s`, `${desired}秒`];
  if (await clickVisibleText(win, exactLabels, true)) {
    await delay(450);
    if ((await readVideoSettings(win)).duration === desired) {
      return { applied: true, diagnostic: `精确选项 ${exactLabels.join("/")}` };
    }
  }

  const currentDuration = (await readVideoSettings(win)).duration;
  const control = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const selectors = 'input[type="range"], [role="slider"], [aria-valuemin][aria-valuemax], [class*="slider" i] [tabindex]';
      const slider = Array.from(document.querySelectorAll(selectors)).find(visible);
      if (!slider) return null;
      const min = Number(slider.getAttribute('min') || slider.getAttribute('aria-valuemin') || 0);
      const max = Number(slider.getAttribute('max') || slider.getAttribute('aria-valuemax') || 30);
      const currentValue = Number(slider instanceof HTMLInputElement ? slider.value : (slider.getAttribute('aria-valuenow') || min));
      const rect = slider.getBoundingClientRect();
      slider.focus();
      const track = slider.closest('[class*="slider" i]') || slider.parentElement || slider;
      const trackRect = track.getBoundingClientRect();
      return {
        min,
        max,
        currentValue,
        tag: slider.tagName,
        role: slider.getAttribute('role') || '',
        value: slider instanceof HTMLInputElement ? slider.value : (slider.getAttribute('aria-valuenow') || ''),
        isNative: slider instanceof HTMLInputElement && slider.type === 'range',
        trackLeft: trackRect.left,
        trackWidth: trackRect.width,
        y: Math.round(trackRect.top + trackRect.height / 2)
      };
    })()
  `, true) as {
    min: number;
    max: number;
    currentValue: number;
    tag: string;
    role: string;
    value: string;
    isNative: boolean;
    trackLeft: number;
    trackWidth: number;
    y: number;
  } | null;

  if (!control) return { applied: false, diagnostic: "未识别到滑块或目标秒数超出范围" };
  const sliderValue = durationToSliderValue(desired, currentDuration, control.currentValue, control.min, control.max);
  if (sliderValue === null) {
    return { applied: false, diagnostic: describeDurationControl(control, "目标秒数无法映射到滑块档位", currentDuration, null) };
  }

  if (control.isNative) {
    await win.webContents.executeJavaScript(`
      (() => {
        const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const slider = Array.from(document.querySelectorAll('input[type="range"]')).find(visible);
        if (!slider) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(slider, ${JSON.stringify(String(sliderValue))});
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `, true);
  }
  await delay(350);
  if ((await readVideoSettings(win)).duration === desired) {
    return { applied: true, diagnostic: describeDurationControl(control, "原生赋值", currentDuration, sliderValue) };
  }

  await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const selectors = 'input[type="range"], [role="slider"], [aria-valuemin][aria-valuemax], [class*="slider" i] [tabindex]';
      Array.from(document.querySelectorAll(selectors)).find(visible)?.focus();
    })()
  `, true);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
  await delay(100);
  for (let value = control.min; value < sliderValue; value += 1) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    await delay(45);
  }
  await delay(350);
  if ((await readVideoSettings(win)).duration === desired) {
    return { applied: true, diagnostic: describeDurationControl(control, "键盘", currentDuration, sliderValue) };
  }

  const x = Math.round(control.trackLeft + Math.max(0, Math.min(1, (sliderValue - control.min) / Math.max(1, control.max - control.min))) * control.trackWidth);
  await clickPoint(win, x, control.y);
  await delay(500);
  return {
    applied: (await readVideoSettings(win)).duration === desired,
    diagnostic: describeDurationControl(control, "原生赋值/键盘/滑轨点击均已尝试", currentDuration, sliderValue)
  };
}

function describeDurationControl(
  control: { min: number; max: number; tag: string; role: string; value: string; isNative: boolean },
  method: string,
  currentDuration: number,
  targetSliderValue: number | null
) {
  return `${control.tag}${control.role ? `[role=${control.role}]` : ""}，范围 ${control.min}-${control.max}，当前 ${currentDuration}s/档位 ${control.value || "未知"}，目标档位 ${targetSliderValue ?? "无法映射"}，原生滑块 ${control.isNative ? "是" : "否"}，方式 ${method}`;
}

async function readVideoSettings(win: BrowserWindow): Promise<DoubaoVideoSettings> {
  const controls = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('button, [role="button"], [tabindex], [class*="select" i], [class*="trigger" i]')).filter(visible).map(element => ({
        text: (element.textContent || '').trim(),
        area: element.getBoundingClientRect().width * element.getBoundingClientRect().height
      }));
    })()
  `, true) as Array<{ text: string; area: number }>;
  const model = controls
    .filter((item) => /Seedance/i.test(item.text))
    .sort((a, b) => a.text.length - b.text.length || a.area - b.area)[0]?.text || "";
  const parameter = controls
    .map((item) => ({ ...item, parsed: parseDoubaoVideoParameterText(item.text) }))
    .filter((item) => item.parsed !== null)
    .sort((a, b) => a.area - b.area)[0]?.parsed;
  return {
    model,
    aspectRatio: parameter?.aspectRatio || "",
    duration: parameter?.duration || 0
  };
}

async function clickVisibleText(win: BrowserWindow, labels: string[], exact: boolean) {
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const labels = ${JSON.stringify(labels)}.map(value => value.toLowerCase());
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], [role="option"], [role="menuitem"], li, [tabindex]')).filter(visible);
      const matches = elements.filter(element => {
        const text = (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return labels.some(label => ${exact} ? text === label : text.includes(label));
      }).sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
      if (!matches[0]) return null;
      const rect = matches[0].getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) return false;
  await clickPoint(win, point.x, point.y);
  return true;
}

async function hasVisibleText(win: BrowserWindow, labels: string[], exact: boolean) {
  return win.webContents.executeJavaScript(`
    (() => {
      const labels = ${JSON.stringify(labels)}.map(value => value.toLowerCase());
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('button, a, [role="button"], [role="option"], [role="menuitem"], li, [tabindex]')).filter(visible).some(element => {
        const text = (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return labels.some(label => ${exact} ? text === label : text.includes(label));
      });
    })()
  `, true) as Promise<boolean>;
}

async function clickPoint(win: BrowserWindow, x: number, y: number) {
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  await delay(120);
}

async function countUploadedThumbnails(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`
    (() => {
      const composer = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(element => {
        const r = element.getBoundingClientRect(); return r.width > 120 && r.height > 20;
      });
      if (!composer) return 0;
      const composerRect = composer.getBoundingClientRect();
      return Array.from(document.querySelectorAll('img, [style*="background-image"]')).filter(element => {
        const r = element.getBoundingClientRect();
        return r.width >= 32 && r.height >= 32 && r.top < composerRect.bottom && r.bottom > composerRect.top - 260;
      }).length;
    })()
  `, true) as Promise<number>;
}

async function waitForUploadedThumbnail(win: BrowserWindow, previousCount: number) {
  return waitUntil(async () => await countUploadedThumbnails(win) > previousCount, 15_000, 500);
}

async function fillAndConfirmComposer(win: BrowserWindow, prompt: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await fillComposer(win, prompt)) {
      await delay(450);
      if (await composerContains(win, prompt)) return true;
      await delay(500);
      if (await fillComposer(win, prompt)) {
        await delay(450);
        return composerContains(win, prompt);
      }
    }
    await delay(400);
  }
  return false;
}

async function composerContains(win: BrowserWindow, prompt: string) {
  const values = await win.webContents.executeJavaScript(`
    (() => {
      return Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(element => {
        const r = element.getBoundingClientRect();
        const s = getComputedStyle(element);
        return r.width > 120 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
      }).map(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : (element.innerText || element.textContent || ''));
    })()
  `, true) as string[];
  const expected = normalizeComposerText(prompt);
  return values.some((value) => normalizeComposerText(value) === expected);
}

async function waitUntil(check: () => Promise<boolean>, timeout: number, interval = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(interval);
  }
  return false;
}

async function revealImageInput(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelectorAll('[data-doubao-studio-upload]').forEach(element => element.removeAttribute('data-doubao-studio-upload'));
      const markInput = () => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const target = inputs.filter(input => /image|png|jpe?g|webp/i.test(input.accept || '')).pop() || inputs.pop();
        target?.setAttribute('data-doubao-studio-upload', 'true');
        return Boolean(target);
      };
      if (markInput()) return true;
      const labels = ['首帧', '上传图片', '上传', '参考图', '添加图片'];
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], label'));
      const target = candidates.find(element => {
        const text = (element.textContent || element.getAttribute('aria-label') || '').trim();
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && labels.some(label => text.includes(label));
      });
      target?.click();
      return markInput() || Boolean(target);
    })()
  `, true);
  await delay(300);
  await win.webContents.executeJavaScript(`
    (() => {
      if (document.querySelector('input[data-doubao-studio-upload="true"]')) return true;
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const target = inputs.filter(input => /image|png|jpe?g|webp/i.test(input.accept || '')).pop() || inputs.pop();
      target?.setAttribute('data-doubao-studio-upload', 'true');
      return Boolean(target);
    })()
  `, true);
}

async function setFileInput(win: BrowserWindow, filePath: string) {
  const debuggerApi = win.webContents.debugger;
  const alreadyAttached = debuggerApi.isAttached();
  if (!alreadyAttached) debuggerApi.attach("1.3");
  try {
    const documentResult = await debuggerApi.sendCommand("DOM.getDocument", { depth: -1, pierce: true }) as { root: { nodeId: number } };
    const selectors = ['input[data-doubao-studio-upload="true"]'];
    for (const selector of selectors) {
      const result = await debuggerApi.sendCommand("DOM.querySelector", {
        nodeId: documentResult.root.nodeId,
        selector
      }) as { nodeId: number };
      if (!result.nodeId) continue;
      await debuggerApi.sendCommand("DOM.setFileInputFiles", { files: [filePath], nodeId: result.nodeId });
      return true;
    }
    return false;
  } finally {
    if (!alreadyAttached && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

async function fillComposer(win: BrowserWindow, prompt: string) {
  if (win.isDestroyed()) return false;
  return win.webContents.executeJavaScript(`
    (() => {
      const selectors = [
        '[contenteditable="true"][class*="editor"]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]',
        'textarea'
      ];
      const candidates = selectors
        .flatMap(selector => Array.from(document.querySelectorAll(selector)))
        .filter(element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 120 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        });
      const element = candidates[0];
      if (!element) return false;
      const value = ${JSON.stringify(prompt)};
      element.focus();
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!document.execCommand('insertText', false, value)) element.textContent = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      return true;
    })()
  `, true) as Promise<boolean>;
}

interface GenerationSnapshot {
  url: string;
  bodyText: string;
  composerText: string;
  imageUrls: string[];
  videoCardCount: number;
}

async function readGenerationSnapshot(win: BrowserWindow, route: "image" | "video"): Promise<GenerationSnapshot> {
  return win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const composer = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(visible).sort((a, b) => {
        const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
        return br.width * br.height - ar.width * ar.height;
      })[0];
      const composerText = composer ? (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : (composer.innerText || composer.textContent || '')) : '';
      const imageUrls = Array.from(document.images).filter(image => {
        const src = image.currentSrc || image.src || '';
        return image.naturalWidth >= 512 && image.naturalHeight >= 512 && /rc_gen_image|cgen_wm0|imagex-sign/i.test(src) && !/avatar|emoji|icon|video_dsz/i.test(src);
      }).map(image => image.currentSrc || image.src).filter((value, index, values) => value && values.indexOf(value) === index);
      return {
        url: location.href,
        bodyText: document.body.innerText || '',
        composerText,
        imageUrls,
        videoCardCount: document.querySelectorAll('[class*="block-video"]').length
      };
    })()
  `, true) as Promise<GenerationSnapshot>;
}

async function verifyBeforeSubmit(win: BrowserWindow, options: GenerationMonitorOptions) {
  if (!await composerContains(win, options.prompt)) throw new Error("自动生成已拦截：提示词回读不一致");
  if (options.route === "image") {
    const expected = doubaoAspectRatio(options.imageAspectRatio || "");
    const actual = doubaoAspectRatio(await readImageAspectRatio(win));
    if (!expected || actual !== expected) throw new Error(`自动生成已拦截：图片比例为 ${actual || "未识别"}，应为 ${expected || "未设置"}`);
    return;
  }
  if (!options.videoSettings) throw new Error("自动生成已拦截：缺少视频参数");
  const mismatches = compareDoubaoVideoSettings(options.videoSettings, await readVideoSettings(win));
  if (mismatches.length) throw new Error(`自动生成已拦截：${mismatches.join("；")}`);
  if (options.expectsFirstFrame && await countUploadedThumbnails(win) < 1) {
    throw new Error("自动生成已拦截：没有回读到首帧缩略图");
  }
}

async function clickGenerateButton(win: BrowserWindow) {
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const selectors = '.send-btn-wrapper button, button[data-testid*="send" i], button[aria-label*="生成"], button[aria-label*="发送"]';
      const candidates = Array.from(document.querySelectorAll(selectors)).filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true');
      const element = candidates[candidates.length - 1];
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) return false;
  await clickPoint(win, point.x, point.y);
  return true;
}

async function waitForGenerationStart(
  win: BrowserWindow,
  baseline: GenerationSnapshot,
  route: "image" | "video",
  timeout: number
) {
  return waitUntil(async () => {
    if (win.isDestroyed()) throw new Error("豆包窗口已关闭");
    const current = await readGenerationSnapshot(win, route);
    const failure = generationFailure(current.bodyText);
    if (failure) throw new Error(failure);
    const composerCleared = normalizeComposerText(current.composerText) === "" && normalizeComposerText(baseline.composerText) !== "";
    const progress = route === "image"
      ? /正在生成图片|图片生成中|已生成图片/.test(current.bodyText)
      : /大约需要\s*\d+\s*[-–—至]\s*\d+\s*分钟|视频生成好后|视频生成中|你的视频生成好了/.test(current.bodyText);
    return current.url !== baseline.url || composerCleared || progress;
  }, timeout, 1_000);
}

async function waitForVideoGenerationStart(
  win: BrowserWindow,
  baseline: GenerationSnapshot,
  autoClick: boolean,
  onProgress?: GenerationMonitorOptions["onProgress"]
) {
  let confirmationSent = false;
  let lastNotice = "";
  const startedAt = Date.now();
  while (true) {
    if (win.isDestroyed()) throw new Error("豆包窗口已关闭");
    const current = await readGenerationSnapshot(win, "video");
    const recentText = current.bodyText.slice(-6_000);
    const safetyConfirmation = /安全确认|上传素材.{0,30}(?:已获|获得).{0,12}授权|确认.{0,20}(?:拥有|获得).{0,12}授权/.test(recentText);
    const confirmationRequested = /确认后我再开始生成视频|确认后(?:再)?开始生成|请确认(?:后)?(?:我再)?开始生成/.test(recentText);
    const generationStarted = /视频生成好后|视频生成中|预计等待\s*\d+\s*分钟|大约需要\s*\d+\s*[-–—至]\s*\d+\s*分钟|你的视频生成好了/.test(recentText);
    if (generationStarted || current.videoCardCount > baseline.videoCardCount) return true;

    if (safetyConfirmation) {
      if (lastNotice !== "请在豆包完成安全确认") {
        onProgress?.("waiting", "请在豆包完成安全确认");
        lastNotice = "请在豆包完成安全确认";
      }
      await delay(1_000);
      continue;
    }

    if (confirmationRequested) {
      if (lastNotice !== "等待在豆包确认") {
        onProgress?.("waiting", "等待在豆包确认");
        lastNotice = "等待在豆包确认";
      }
      if (autoClick && !confirmationSent) {
        await clearComposerAttachments(win);
        if (!await fillAndConfirmComposer(win, "确认")) throw new Error("豆包要求二次确认，但工作台未能填入纯文字“确认”");
        if (!await clickGenerateButton(win)) throw new Error("豆包要求二次确认，但工作台没有找到确认消息发送按钮");
        confirmationSent = true;
        await delay(600);
        await clearComposerAttachments(win);
      }
      await delay(800);
      continue;
    }

    const elapsedMinutes = Math.floor((Date.now() - startedAt) / 60_000);
    if (elapsedMinutes >= 30 && lastNotice !== "尚未确认开始，继续监听") {
      onProgress?.("waiting", "尚未确认开始，继续监听");
      lastNotice = "尚未确认开始，继续监听";
    }
    await delay(1_000);
  }
}

async function clearComposerAttachments(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const composer = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(visible).sort((a, b) => {
        const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect(); return br.width * br.height - ar.width * ar.height;
      })[0];
      if (!composer) return 0;
      const composerRect = composer.getBoundingClientRect();
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(button => {
        if (!visible(button)) return false;
        const rect = button.getBoundingClientRect();
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').replace(/\\s+/g, '').trim();
        return rect.bottom >= composerRect.top - 240 && rect.top <= composerRect.bottom && /^(删除|移除|清除|关闭)(附件|图片)?$/.test(label);
      });
      buttons.forEach(button => button.click());
      Array.from(document.querySelectorAll('input[type="file"]')).forEach(input => { try { input.value = ''; } catch {} });
      return buttons.length;
    })()
  `, true);
  await delay(250);
}

async function waitForGenerationCompletion(
  win: BrowserWindow,
  baseline: GenerationSnapshot,
  route: "image" | "video",
  onProgress?: GenerationMonitorOptions["onProgress"]
) {
  const deadline = Date.now() + 8 * 60_000;
  const startedAt = Date.now();
  let expectedMinutes = 0;
  let lastProgressMinute = -1;
  let overdueReported = false;
  const beforeImages = new Set(baseline.imageUrls);
  while (route === "video" || Date.now() < deadline) {
    if (win.isDestroyed()) throw new Error("豆包窗口已关闭");
    const current = await readGenerationSnapshot(win, route);
    const failure = generationFailure(current.bodyText);
    if (failure && route === "image") throw new Error(failure);
    const imageUrls = current.imageUrls.filter((url) => !beforeImages.has(url));
    if (route === "image" && imageUrls.length && /已生成图片|生成的图片|图片已生成/.test(current.bodyText)) {
      await delay(2_000);
      const stable = await readGenerationSnapshot(win, route);
      const stableUrls = stable.imageUrls.filter((url) => !beforeImages.has(url));
      if (stableUrls.length) return { ...stable, imageUrls: stableUrls };
    }
    if (route === "video" && current.videoCardCount > baseline.videoCardCount && /视频生成好了|视频已生成/.test(current.bodyText)) {
      return current;
    }
    if (route === "video") {
      expectedMinutes = parseExpectedWaitMinutes(current.bodyText) || expectedMinutes;
      const elapsedMinutes = Math.floor((Date.now() - startedAt) / 60_000);
      if (failure) onProgress?.("waiting", `${failure.replace("豆包报告生成失败：", "豆包提示：")} · 仍在继续监听`);
      else if (elapsedMinutes !== lastProgressMinute) {
        const estimate = expectedMinutes ? `预计 ${expectedMinutes} 分钟 · ` : "";
        onProgress?.("started", `${estimate}已等 ${elapsedMinutes} 分钟`);
        lastProgressMinute = elapsedMinutes;
      }
      const overdueMinutes = Math.max(30, expectedMinutes * 2);
      if (elapsedMinutes >= overdueMinutes && !overdueReported) {
        onProgress?.("waiting", "可能仍在生成，请去豆包查看 · 工作台继续监听");
        overdueReported = true;
      }
    }
    await delay(route === "image" ? 1_500 : 3_000);
  }
  throw new Error("等待分镜图生成完成超时");
}

function parseExpectedWaitMinutes(bodyText: string) {
  const recent = bodyText.slice(-6_000);
  const exact = /预计等待\s*(\d+)\s*分钟/.exec(recent);
  if (exact) return Number(exact[1]);
  const range = /大约需要\s*(\d+)\s*[-–—至]\s*(\d+)\s*分钟/.exec(recent);
  return range ? Math.max(Number(range[1]), Number(range[2])) : 0;
}

function generationFailure(bodyText: string) {
  const match = /(视频|图片)?(?:生成)?(?:失败|未通过审核|审核未通过|涉嫌违规|内容违规|请求失败|出错了)/.exec(bodyText.slice(-6_000));
  return match ? `豆包报告生成失败：${match[0]}` : "";
}

async function openLatestVideoPreview(win: BrowserWindow) {
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const cards = Array.from(document.querySelectorAll('[class*="block-video"]'));
      const element = cards[cards.length - 1];
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) throw new Error("已检测到视频完成，但没有找到最新视频卡片");
  await clickPoint(win, point.x, point.y);
  await waitUntil(async () => {
    await pauseAndMuteVideos(win);
    return hasDownloadControl(win);
  }, 15_000, 400);
}

async function pauseAndMuteVideos(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelectorAll('video').forEach(video => {
        video.muted = true;
        video.pause();
        video.removeAttribute('autoplay');
        video.loop = false;
      });
    })()
  `, true);
}

async function hasDownloadControl(win: BrowserWindow) {
  return win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      return Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]')).filter(visible).some(element => /下载/.test((element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\\s+/g, '')));
    })()
  `, true) as Promise<boolean>;
}

async function clickOfficialDownloadControl(win: BrowserWindow, onStarted: () => boolean) {
  if (await clickVisibleText(win, ["下载原片"], true)) return true;
  const point = await win.webContents.executeJavaScript(`
    (() => {
      const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]')).filter(visible).map(element => {
        const text = (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\\s+/g, '').trim();
        const rect = element.getBoundingClientRect();
        return { text, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), area: rect.width * rect.height };
      }).filter(item => /^下载(?:原片|视频)?$/.test(item.text)).sort((a, b) => a.area - b.area);
      return candidates[0] || null;
    })()
  `, true) as { x: number; y: number } | null;
  if (!point) return false;
  await clickPoint(win, point.x, point.y);
  await delay(500);
  if (!onStarted() && await hasVisibleText(win, ["下载原片"], true)) await clickVisibleText(win, ["下载原片"], true);
  return true;
}

async function downloadOfficialOriginal(win: BrowserWindow, outputFolder: string, baseName: string): Promise<DownloadedGenerationCandidate> {
  mkdirSync(outputFolder, { recursive: true });
  const finalPath = uniqueDownloadPath(path.join(outputFolder, `${baseName}.mp4`));
  await openLatestVideoPreview(win);
  const first = await runOfficialDownloadAttempt(win, `${finalPath}.attempt1.mp4`);
  let selected = first;
  if (videoSourceHasWatermark(first.sourceUrl)) {
    const second = await runOfficialDownloadAttempt(win, `${finalPath}.attempt2.mp4`);
    if (!videoSourceHasWatermark(second.sourceUrl)) selected = second;
    else selected = second;
  }
  for (const attempt of [first, selected]) {
    if (attempt.filePath !== selected.filePath && existsSync(attempt.filePath)) unlinkSync(attempt.filePath);
  }
  if (!existsSync(selected.filePath) || statSync(selected.filePath).size <= 0) throw new Error("官方下载完成但文件校验失败，下载页已保留");
  renameSync(selected.filePath, finalPath);
  await pauseAndMuteVideos(win);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await delay(250);
  return { sourceUrl: selected.sourceUrl, filePath: finalPath, hasWatermark: videoSourceHasWatermark(selected.sourceUrl) };
}

async function runOfficialDownloadAttempt(win: BrowserWindow, savePath: string) {
  if (existsSync(savePath)) unlinkSync(savePath);
  const downloadSession = win.webContents.session;
  let started = false;
  let listener: ((_event: Event, item: DownloadItem) => void) | null = null;
  const download = new Promise<{ sourceUrl: string; filePath: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (listener) downloadSession.removeListener("will-download", listener);
      reject(new Error("点击官方下载入口后 30 秒内没有收到下载任务，下载页已保留"));
    }, 30_000);
    listener = (_event, item) => {
      started = true;
      clearTimeout(timeout);
      item.setSavePath(savePath);
      item.once("done", (_doneEvent, state) => {
        if (state !== "completed") reject(new Error(`官方下载失败（${state}），下载页已保留`));
        else resolve({ sourceUrl: item.getURL(), filePath: savePath });
      });
    };
    downloadSession.once("will-download", listener);
  });
  if (!await clickOfficialDownloadControl(win, () => started)) {
    if (listener) downloadSession.removeListener("will-download", listener);
    throw new Error("下载页没有找到官方“下载原片”入口，页面已保留");
  }
  return download;
}

function uniqueDownloadPath(target: string) {
  if (!existsSync(target)) return target;
  const extension = path.extname(target);
  const stem = target.slice(0, -extension.length);
  let index = 2;
  while (existsSync(`${stem}_${index}${extension}`)) index += 1;
  return `${stem}_${index}${extension}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readIdentity(win: BrowserWindow) {
  const payload = await win.webContents.executeJavaScript(`
    fetch(${JSON.stringify(DOUBAO_ACCOUNT_INFO)}, {
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' }
    })
      .then(async response => ({ status: response.status, body: await response.json() }))
  `, true) as { status: number; body: unknown };
  if (payload.status !== 200) throw new Error(`账号接口返回 HTTP ${payload.status}`);
  return extractDoubaoIdentity(payload.body);
}

function isAllowedNavigation(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (
      parsed.hostname === "doubao.com"
      || parsed.hostname.endsWith(".doubao.com")
      || parsed.hostname === "doubao.cn"
      || parsed.hostname.endsWith(".doubao.cn")
    );
  } catch {
    return false;
  }
}

function waitForLoad(win: BrowserWindow) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("豆包页面加载超时")), 30_000);
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
    win.webContents.once("did-fail-load", (_event, code, description) => {
      clearTimeout(timer);
      reject(new Error(`豆包页面加载失败：${code} ${description}`));
    });
  });
}

function shortAccountId(accountId: string) {
  return accountId.slice(0, 8);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
