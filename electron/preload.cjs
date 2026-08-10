const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jiraSheetsApp", {
  loadState: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  loginJira: () => ipcRenderer.invoke("jira:login"),
  startSync: (settings) => ipcRenderer.invoke("sync:start", settings),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  chooseOutputDirectory: (currentPath) =>
    ipcRenderer.invoke("output:choose", currentPath),
  openOutput: (outputDirectory) =>
    ipcRenderer.invoke("output:open", outputDirectory),
  openSheet: (url) => ipcRenderer.invoke("sheet:open", url),
  copyText: (text) => ipcRenderer.invoke("clipboard:copy", text),
  onJobEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job:event", listener);
    return () => ipcRenderer.removeListener("job:event", listener);
  }
});
