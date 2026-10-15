import { BrowserWindow, session } from "electron";
import type { Account } from "./contracts.js";
import { extractDoubaoIdentity } from "./identity.js";

const DOUBAO_HOME = "https://www.doubao.com/";
const DOUBAO_CHAT = "https://www.doubao.com/chat/";

export class AccountSessionManager {
  private readonly windows = new Map<string, BrowserWindow>();

  get activeWindowCount() {
    return this.windows.size;
  }

  open(account: Account, route: "home" | "chat" = "home", visible = true) {
    const existing = this.windows.get(account.id);
    if (existing && !existing.isDestroyed()) {
      if (visible) {
        existing.show();
        existing.focus();
      }
      if (route === "chat") void existing.loadURL(DOUBAO_CHAT);
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
    win.on("closed", () => this.windows.delete(account.id));
    this.windows.set(account.id, win);
    void win.loadURL(route === "chat" ? DOUBAO_CHAT : DOUBAO_HOME);
    return win;
  }

  async verify(account: Account) {
    let win = this.windows.get(account.id);
    const temporary = !win || win.isDestroyed();
    if (temporary) {
      win = this.open(account, "home", false);
    }
    try {
      await waitForLoad(win!);
      const payload = await win!.webContents.executeJavaScript(`
        fetch('/passport/web/account/info/', { credentials: 'include' })
          .then(async response => ({ status: response.status, body: await response.json() }))
      `, true) as { status: number; body: unknown };
      if (payload.status !== 200) throw new Error(`账号接口返回 HTTP ${payload.status}`);
      const identity = extractDoubaoIdentity(payload.body);
      if (!identity) throw new Error("尚未检测到已登录账号，请在账号窗口中完成登录");
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
    await session.fromPartition(account.partition).clearStorageData();
  }

  closeAll() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }
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
