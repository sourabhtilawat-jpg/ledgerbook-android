// Ledgerbook for Windows: developed by Sourabh Tilawat.
// Hosts the same offline page as the Android app (www/) and provides saving, printing and WhatsApp hand-off.
const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const GRAPH = "https://graph.facebook.com/v23.0/";
let win;

if (!app.requestSingleInstanceLock()) app.quit();

const downloadsDir = () => {
  const d = path.join(app.getPath("downloads"), "Ledgerbook");
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const safeName = (n) => String(n || "file").replace(/[\\/:*?"<>|]/g, "-").trim() || "file";
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 1; ; i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}
const isExternal = (url) => /^(https?|mailto|tel|whatsapp):/i.test(url);

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 900, minHeight: 600,
    title: "Ledgerbook", backgroundColor: "#EDF2F1", autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  win.loadFile(path.join(__dirname, "www", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (isExternal(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) { e.preventDefault(); if (isExternal(url)) shell.openExternal(url); } });
  win.webContents.session.on("will-download", (e, item) => { item.setSavePath(uniquePath(downloadsDir(), safeName(item.getFilename()))); });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5") win.webContents.reload();
    if (input.control && (input.key === "=" || input.key === "+")) win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    if (input.control && input.key === "-") win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    if (input.control && input.key === "0") win.webContents.setZoomLevel(0);
  });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

ipcMain.on("lb:saveFile", (e, b64, name) => {
  try {
    const p = uniquePath(downloadsDir(), safeName(name));
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    shell.showItemInFolder(p);
    e.returnValue = p;
  } catch (err) { e.returnValue = "error:" + err.message; }
});

// WhatsApp Desktop cannot accept an attachment from another app, so: save the PDF, show it in its folder,
// and open the customer's chat with the message typed. The user drags the PDF into the chat.
ipcMain.on("lb:shareWA", (e, b64, name, phone, text) => {
  try {
    const p = path.join(downloadsDir(), safeName(name));
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    shell.showItemInFolder(p);
    shell.openExternal(`https://wa.me/${encodeURIComponent(phone || "")}?text=${encodeURIComponent(text || "")}`);
    e.returnValue = "desktop";
  } catch (err) { e.returnValue = "error:" + err.message; }
});

ipcMain.on("lb:openUrl", (e, url) => { if (isExternal(url)) shell.openExternal(url); e.returnValue = true; });
ipcMain.on("lb:version", (e) => { e.returnValue = app.getVersion(); });

ipcMain.on("lb:print", (e, html) => {
  const tmp = path.join(os.tmpdir(), `ledgerbook-print-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, "utf8");
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  pw.loadFile(tmp).then(() => {
    pw.webContents.print({ silent: false, printBackground: true }, () => {
      pw.close();
      fs.rm(tmp, () => {});
    });
  }).catch(() => { pw.close(); fs.rm(tmp, () => {}); });
});

async function graphError(res) {
  try { const j = await res.json(); return (j.error && j.error.message) || `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
}

ipcMain.handle("lb:waCloud", async (e, json) => {
  try {
    const req = JSON.parse(json);
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([Buffer.from(req.pdf, "base64")], { type: "application/pdf" }), req.filename || "invoice.pdf");
    const up = await fetch(`${GRAPH}${req.phoneId}/media`, { method: "POST", headers: { Authorization: `Bearer ${req.token}` }, body: form });
    if (!up.ok) throw new Error(await graphError(up));
    const mediaId = (await up.json()).id;
    const components = [{ type: "header", parameters: [{ type: "document", document: { id: mediaId, filename: req.filename } }] }];
    if (Array.isArray(req.bodyParams) && req.bodyParams.length)
      components.push({ type: "body", parameters: req.bodyParams.map((t) => ({ type: "text", text: String(t) })) });
    const msg = { messaging_product: "whatsapp", to: req.to, type: "template",
      template: { name: req.template, language: { code: req.lang || "en" }, components } };
    const res = await fetch(`${GRAPH}${req.phoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${req.token}`, "Content-Type": "application/json" }, body: JSON.stringify(msg) });
    if (!res.ok) throw new Error(await graphError(res));
    const r = await res.json();
    return JSON.stringify({ ok: true, messageId: r.messages && r.messages[0] && r.messages[0].id });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message });
  }
});
