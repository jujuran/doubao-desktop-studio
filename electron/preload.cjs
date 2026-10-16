const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    create: (label) => ipcRenderer.invoke("accounts:create", label),
    rename: (id, label) => ipcRenderer.invoke("accounts:rename", id, label),
    open: (id) => ipcRenderer.invoke("accounts:open", id),
    verify: (id) => ipcRenderer.invoke("accounts:verify", id),
    clearCache: (id) => ipcRenderer.invoke("accounts:clear-cache", id),
    remove: (id) => ipcRenderer.invoke("accounts:remove", id)
  },
  tasks: {
    list: () => ipcRenderer.invoke("tasks:list"),
    create: (input) => ipcRenderer.invoke("tasks:create", input),
    importMany: (inputs) => ipcRenderer.invoke("tasks:import-many", inputs),
    update: (id, input) => ipcRenderer.invoke("tasks:update", id, input),
    duplicate: (id) => ipcRenderer.invoke("tasks:duplicate", id),
    remove: (id) => ipcRenderer.invoke("tasks:remove", id),
    copyPrompt: (id) => ipcRenderer.invoke("tasks:copy-prompt", id),
    openImage: (id) => ipcRenderer.invoke("tasks:open-image", id),
    chooseImage: (id) => ipcRenderer.invoke("tasks:choose-image", id),
    updateImageStatus: (id, status) => ipcRenderer.invoke("tasks:update-image-status", id, status),
    autoAssign: () => ipcRenderer.invoke("tasks:auto-assign"),
    open: (id) => ipcRenderer.invoke("tasks:open", id),
    updateStatus: (id, status) => ipcRenderer.invoke("tasks:update-status", id, status)
  },
  usage: {
    listToday: () => ipcRenderer.invoke("usage:list-today"),
    adjust: (accountId, kind, value) => ipcRenderer.invoke("usage:adjust", accountId, kind, value)
  },
  projects: {
    listStyles: () => ipcRenderer.invoke("projects:list-styles"),
    saveStyle: (input) => ipcRenderer.invoke("projects:save-style", input),
    chooseReference: (kind) => ipcRenderer.invoke("projects:choose-reference", kind),
    applyLocks: (projectName) => ipcRenderer.invoke("projects:apply-locks", projectName)
  },
  imports: {
    chooseAssetFolder: () => ipcRenderer.invoke("imports:choose-asset-folder")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (input) => ipcRenderer.invoke("settings:update", input)
  },
  runtime: {
    stats: () => ipcRenderer.invoke("runtime:stats"),
    chooseDataDirectory: () => ipcRenderer.invoke("runtime:choose-data-directory"),
    exportDiagnostics: () => ipcRenderer.invoke("runtime:export-diagnostics")
  },
  onDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  }
});
