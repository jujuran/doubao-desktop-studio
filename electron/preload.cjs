const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    create: (label) => ipcRenderer.invoke("accounts:create", label),
    open: (id) => ipcRenderer.invoke("accounts:open", id),
    verify: (id) => ipcRenderer.invoke("accounts:verify", id),
    clearCache: (id) => ipcRenderer.invoke("accounts:clear-cache", id),
    remove: (id) => ipcRenderer.invoke("accounts:remove", id)
  },
  tasks: {
    list: () => ipcRenderer.invoke("tasks:list"),
    create: (input) => ipcRenderer.invoke("tasks:create", input),
    open: (id) => ipcRenderer.invoke("tasks:open", id),
    updateStatus: (id, status) => ipcRenderer.invoke("tasks:update-status", id, status)
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (input) => ipcRenderer.invoke("settings:update", input)
  },
  runtime: {
    stats: () => ipcRenderer.invoke("runtime:stats")
  },
  onDataChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  }
});
