import { BrowserWindow, session } from "electron";
import type { Account } from "./contracts.js";
import { extractDoubaoIdentity, type DoubaoIdentity } from "./identity.js";

const DOUBAO_HOME = "https://www.doubao.com/";
const DOUBAO_CHAT = "https://www.doubao.com/chat/";
const DOUBAO_IMAGE = "https://www.doubao.com/chat/create-image";
const DOUBAO_VIDEO = "https://www.doubao.com/chat/create-video";
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

  async prepare(account: Account, route: "image" | "video", prompt: string) {
    const win = this.open(account, route, true);
    await waitForLoad(win);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await fillComposer(win, prompt)) return win;
      await delay(400);
    }
    throw new Error("已打开豆包页面，但没有找到提示词输入框；请手动粘贴，或等待页面加载后重试");
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

function routeUrl(route: "home" | "chat" | "image" | "video") {
  if (route === "chat") return DOUBAO_CHAT;
  if (route === "image") return DOUBAO_IMAGE;
  if (route === "video") return DOUBAO_VIDEO;
  return DOUBAO_HOME;
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
