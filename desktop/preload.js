// Gives the Ledgerbook page the same window.LBNative interface as the Android app.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("LBNative", {
  platform: "desktop",
  saveFile: (b64, name, mime) => ipcRenderer.sendSync("lb:saveFile", b64, name),
  shareFile: (b64, name, mime, text) => ipcRenderer.sendSync("lb:saveFile", b64, name),
  shareToWhatsApp: (b64, name, phone, text) => ipcRenderer.sendSync("lb:shareWA", b64, name, phone, text),
  printHtml: (html, job) => ipcRenderer.send("lb:print", html, job),
  openUrl: (url) => ipcRenderer.sendSync("lb:openUrl", url),
  appVersion: () => ipcRenderer.sendSync("lb:version"),
  waCloudSendAsync: (json) => ipcRenderer.invoke("lb:waCloud", json),
  serverStart: () => ipcRenderer.invoke("lb:serverStart"),
  serverStop: () => ipcRenderer.invoke("lb:serverStop"),
  serverInfo: () => ipcRenderer.invoke("lb:serverInfo"),
  serverAuto: (on) => ipcRenderer.invoke("lb:serverAuto", on),
});
