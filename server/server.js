/*
 * Ledgerbook Server: shared books for every device of one business.
 * Developed by Sourabh Tilawat.
 *
 * - No dependencies: Node.js 18+ only. Runs inside the Windows app (LAN mode) or on any cloud host.
 * - Data: dataDir/data.json (snapshot) + journal.jsonl (changes since snapshot) + audit.jsonl (append-only, hash-chained).
 * - Users with scrypt-hashed passwords, per-user rights enforced on every write.
 * - Live updates to all devices over Server-Sent Events; invoice numbers allocated atomically here.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const VERSION = "1.4.0";
const COLLS = ["items", "customers", "vendors", "purchases", "sales", "tds", "ledgers", "vouchers"];
const RIGHTS = [
  ["sales.view", "Sales: view invoices"], ["sales.create", "Sales: create invoices"], ["sales.payment", "Sales: collect payments"],
  ["sales.edit", "Sales: edit invoices"], ["sales.cancel", "Sales: cancel invoices"],
  ["purchases.view", "Purchases: view"], ["purchases.edit", "Purchases: create, edit, mark paid"],
  ["items.view", "Items & stock: view"], ["items.edit", "Items: create and edit"],
  ["parties.view", "Customers & vendors: view"], ["parties.edit", "Customers & vendors: create and edit"],
  ["reports.view", "Reports & GST returns: view"], ["taxes.edit", "TDS entries: create and edit"],
  ["accounts.view", "Accounts: ledgers, P&L, balance sheet"], ["accounts.edit", "Accounts: ledgers and vouchers"],
  ["export", "Export PDF / Excel / CSV"], ["settings.edit", "Business settings"], ["backup", "Backup and restore"],
  ["users.manage", "Manage users and rights"], ["audit.view", "View audit trail"],
];
const ALL = RIGHTS.map((r) => r[0]);
const ROLES = {
  admin: { name: "Admin", rights: ALL },
  accountant: { name: "Accountant", rights: ALL.filter((r) => !["users.manage", "settings.edit"].includes(r)) },
  cashier: { name: "Cashier / Salesperson", rights: ["sales.view", "sales.create", "sales.payment", "items.view", "parties.view", "parties.edit"] },
  store: { name: "Store manager", rights: ["sales.view", "purchases.view", "purchases.edit", "items.view", "items.edit", "parties.view", "parties.edit", "reports.view"] },
  viewer: { name: "Viewer (read only)", rights: ["sales.view", "purchases.view", "items.view", "parties.view", "reports.view", "accounts.view"] },
};
const PAY_FIELDS = new Set(["payMode", "payStatus", "payRef", "payment", "paidAt", "cashGiven", "cashChange", "waSentAt"]);
const META = new Set(["_rev", "_at", "_by"]);

function createLedgerbookServer(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), "ledgerbook-data");
  const wwwDir = opts.wwwDir || null;
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  fs.mkdirSync(dataDir, { recursive: true });
  const F = { snap: path.join(dataDir, "data.json"), journal: path.join(dataDir, "journal.jsonl"), audit: path.join(dataDir, "audit.jsonl"), sessions: path.join(dataDir, "sessions.json") };

  /* ---------- storage ---------- */
  let db = { colls: Object.fromEntries(COLLS.map((c) => [c, {}])), settings: {}, counters: {}, users: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(F.snap, "utf8"))); } catch (e) { /* first run */ }
  for (const c of COLLS) db.colls[c] = db.colls[c] || {};
  const apply = (op) => {
    if (op.t === "put") db.colls[op.c][op.id] = op.doc;
    else if (op.t === "del") delete db.colls[op.c][op.id];
    else if (op.t === "settings") db.settings = op.doc;
    else if (op.t === "counter") db.counters[op.fy] = op.n;
    else if (op.t === "counters") db.counters = op.map;
    else if (op.t === "user") db.users[op.user.id] = op.user;
  };
  try { for (const line of fs.readFileSync(F.journal, "utf8").split("\n")) if (line.trim()) { try { apply(JSON.parse(line)); } catch (e) { /* torn last line */ } } } catch (e) { /* none */ }
  let jfd = fs.openSync(F.journal, "a"), ops = 0;
  function snapshot() {
    const tmp = F.snap + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, F.snap);
    fs.closeSync(jfd); fs.writeFileSync(F.journal, ""); jfd = fs.openSync(F.journal, "a"); ops = 0;
  }
  function commit(op) {
    apply(op);
    fs.writeSync(jfd, JSON.stringify(op) + "\n"); fs.fsyncSync(jfd);
    if (++ops >= 400) snapshot();
  }
  snapshot();

  /* ---------- audit trail (append-only, hash-chained) ---------- */
  let lastHash = "GENESIS", auditCount = 0;
  try {
    const lines = fs.readFileSync(F.audit, "utf8").split("\n").filter(Boolean);
    auditCount = lines.length;
    if (lines.length) lastHash = JSON.parse(lines[lines.length - 1]).hash;
  } catch (e) { /* none */ }
  const afd = fs.openSync(F.audit, "a");
  function audit(entry) {
    const e = Object.assign({ id: crypto.randomBytes(8).toString("hex"), ts: new Date().toISOString() }, entry, { prev: lastHash });
    e.hash = crypto.createHash("sha256").update(lastHash + JSON.stringify(Object.assign({}, e, { hash: undefined }))).digest("hex");
    fs.writeSync(afd, JSON.stringify(e) + "\n"); fs.fsyncSync(afd);
    lastHash = e.hash; auditCount++;
    broadcast({ type: "audit" }, (s) => has(s.user, "audit.view"));
    return e;
  }
  function readAudit() {
    try { return fs.readFileSync(F.audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
  }
  function verifyAudit() {
    let prev = "GENESIS", n = 0;
    for (const e of readAudit()) {
      const h = crypto.createHash("sha256").update(prev + JSON.stringify(Object.assign({}, e, { hash: undefined }))).digest("hex");
      if (e.prev !== prev || e.hash !== h) return { ok: false, brokenAt: n, ts: e.ts };
      prev = e.hash; n++;
    }
    return { ok: true, entries: n };
  }
  const label = (c, d) => {
    if (!d) return "";
    switch (c) {
      case "sales": return `${d.no || ""} · ${(d.party && d.party.name) || ""}${d.grand ? " · ₹" + d.grand : ""}`;
      case "purchases": return `Bill ${d.billNo || ""} · ${(d.party && d.party.name) || ""}`;
      case "items": return `${d.sku || ""} · ${d.name || ""}`;
      case "vouchers": return `${d.type || ""} ${d.no || ""}`;
      case "tds": return `TDS · ${d.payee || ""}`;
      default: return d.name || d.id || "";
    }
  };
  const short = (v) => { if (v === undefined) return undefined; let s = typeof v === "string" ? v : JSON.stringify(v); if (s && s.length > 140) s = s.slice(0, 137) + "…"; return s; };
  function diff(a, b) {
    const out = [], keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      if (META.has(k)) continue;
      const x = a ? a[k] : undefined, y = b ? b[k] : undefined;
      if (JSON.stringify(x) === JSON.stringify(y) || ((x === undefined || x === "" || x === null) && (y === undefined || y === "" || y === null))) continue;
      if (k === "upiQr") { out.push({ f: k, from: x ? "(image)" : "", to: y ? "(new image)" : "" }); continue; }
      if (Array.isArray(x) || Array.isArray(y)) { out.push({ f: k, from: Array.isArray(x) ? `${x.length} lines` : short(x), to: Array.isArray(y) ? `${y.length} lines` : short(y), detail: true }); continue; }
      out.push({ f: k, from: short(x), to: short(y) });
    }
    return out;
  }

  /* ---------- users & sessions ---------- */
  const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
  const pub = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role, rights: u.role === "admin" ? ALL : u.rights || [], active: u.active !== false, createdAt: u.createdAt, lastLogin: u.lastLogin };
  const has = (u, r) => !!u && u.active !== false && (u.role === "admin" || (u.rights || []).includes(r));
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(F.sessions, "utf8")); } catch (e) { /* none */ }
  const saveSessions = () => { try { fs.writeFileSync(F.sessions, JSON.stringify(sessions)); } catch (e) { /* ignore */ } };
  const tokenKey = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  function userFor(req, urlObj) {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : urlObj.searchParams.get("token");
    if (!t) return null;
    const s = sessions[tokenKey(t)];
    if (!s) return null;
    if (Date.now() - s.lastSeen > 30 * 864e5) { delete sessions[tokenKey(t)]; saveSessions(); return null; }
    const u = db.users[s.userId];
    if (!u || u.active === false) return null;
    if (Date.now() - s.lastSeen > 6e4) { s.lastSeen = Date.now(); saveSessions(); }
    return { user: u, key: tokenKey(t), session: s };
  }
  const fails = {};
  const lockout = (k) => { const f = fails[k]; return f && f.n >= 5 && Date.now() - f.at < 5 * 6e4; };

  /* ---------- realtime ---------- */
  const clients = new Set();
  function broadcast(msg, filter) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of clients) { if (!filter || filter(c)) { try { c.res.write(data); } catch (e) { /* closed */ } } }
  }
  setInterval(() => { for (const c of clients) { try { c.res.write(": ping\n\n"); } catch (e) { /* closed */ } } }, 25000).unref();
  const canReadColl = (u, c) => (c === "ledgers" || c === "vouchers" ? has(u, "accounts.view") || has(u, "accounts.edit") : true);

  /* ---------- rights per write ---------- */
  function rightFor(c, before, after) {
    switch (c) {
      case "sales": {
        if (!before) return ["sales.create"];
        if (after && before.status !== "cancelled" && after.status === "cancelled") return ["sales.cancel"];
        const changed = Object.keys(Object.assign({}, before, after)).filter((k) => !META.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after && after[k]));
        if (changed.length && changed.every((k) => PAY_FIELDS.has(k))) return ["sales.payment", "sales.create", "sales.edit"];
        return ["sales.edit"];
      }
      case "purchases": return ["purchases.edit"];
      case "items": return ["items.edit"];
      case "customers": return ["parties.edit", "sales.create"];
      case "vendors": return ["parties.edit", "purchases.edit"];
      case "tds": return ["taxes.edit", "purchases.edit"];
      case "ledgers": case "vouchers": return ["accounts.edit"];
      default: return ["__none__"];
    }
  }

  /* ---------- http ---------- */
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };
  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 8 * 1024 * 1024) { reject(Object.assign(new Error("Request too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("Bad JSON"), { code: 400 })); } });
      req.on("error", reject);
    });
  }
  const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim().replace(/^::ffff:/, "");
  const devOf = (req) => String(req.headers["x-lb-device"] || "").slice(0, 60) || String(req.headers["user-agent"] || "").slice(0, 60);
  const who = (u) => u ? { id: u.id, username: u.username, name: u.name } : null;

  async function handle(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-LB-Device");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (!p.startsWith("/api/")) return serveStatic(p, res);
    try {
      if (p === "/api/health") return send(res, 200, { ok: true, name: "Ledgerbook Server", version: VERSION, setup: Object.keys(db.users).length === 0, business: db.settings.name || "" });

      if (p === "/api/setup" && req.method === "POST") {
        if (Object.keys(db.users).length) return send(res, 409, { error: "Already set up. Sign in instead." });
        const b = await readBody(req);
        const username = String(b.username || "").trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(username)) return send(res, 400, { error: "Username: 3–32 letters, digits, dot, dash or underscore." });
        if (String(b.password || "").length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
        const salt = crypto.randomBytes(16).toString("hex");
        const user = { id: "u" + crypto.randomBytes(6).toString("hex"), username, name: String(b.name || username).slice(0, 60), role: "admin", rights: ALL, active: true, salt, hash: hashPw(b.password, salt), createdAt: new Date().toISOString() };
        commit({ t: "user", user });
        audit({ user: who(user), ip: ipOf(req), device: devOf(req), action: "setup", coll: "users", docId: user.id, label: `Admin ${username} created` });
        return login(user, req, res);
      }
      if (p === "/api/login" && req.method === "POST") {
        const b = await readBody(req);
        const username = String(b.username || "").trim().toLowerCase(), key = username + "|" + ipOf(req);
        if (lockout(key)) return send(res, 429, { error: "Too many wrong attempts. Wait 5 minutes and try again." });
        const user = Object.values(db.users).find((x) => x.username === username);
        if (!user || user.active === false || hashPw(b.password || "", user.salt) !== user.hash) {
          fails[key] = { n: ((fails[key] && Date.now() - fails[key].at < 5 * 6e4) ? fails[key].n : 0) + 1, at: Date.now() };
          audit({ user: user ? who(user) : { username }, ip: ipOf(req), device: devOf(req), action: "login-failed", coll: "users", label: user && user.active === false ? "Account disabled" : "Wrong username or password" });
          return send(res, 401, { error: "Wrong username or password." });
        }
        delete fails[key];
        return login(user, req, res);
      }

      const auth = userFor(req, u);
      if (!auth) return send(res, 401, { error: "Please sign in again." });
      const me = auth.user;

      if (p === "/api/me") return send(res, 200, { user: pub(me), rights: RIGHTS, roles: ROLES, version: VERSION });
      if (p === "/api/logout" && req.method === "POST") { delete sessions[auth.key]; saveSessions(); audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "logout", coll: "users" }); return send(res, 200, { ok: true }); }
      if (p === "/api/password" && req.method === "POST") {
        const b = await readBody(req);
        if (hashPw(b.old || "", me.salt) !== me.hash) return send(res, 400, { error: "Current password is wrong." });
        if (String(b.new || "").length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
        const salt = crypto.randomBytes(16).toString("hex");
        commit({ t: "user", user: Object.assign({}, me, { salt, hash: hashPw(b.new, salt) }) });
        audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "password-changed", coll: "users", docId: me.id, label: me.username });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/data") {
        const out = { settings: db.settings, counters: db.counters, colls: {} };
        for (const c of COLLS) out.colls[c] = canReadColl(me, c) ? Object.values(db.colls[c]) : [];
        return send(res, 200, out);
      }
      if (p === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write(`retry: 3000\ndata: ${JSON.stringify({ type: "hello" })}\n\n`);
        const c = { res, user: me, key: auth.key };
        clients.add(c);
        req.on("close", () => clients.delete(c));
        return;
      }
      let m;
      if ((m = p.match(/^\/api\/doc\/([a-z]+)\/([A-Za-z0-9_\-.~:@+]{1,200})$/))) {
        const c = m[1], id = decodeURIComponent(m[2]);
        if (!COLLS.includes(c)) return send(res, 404, { error: "Unknown record type." });
        const before = db.colls[c][id] || null;
        if (req.method === "PUT") {
          const b = await readBody(req), doc = Object.assign({}, b.doc || {}, { id });
          const need = rightFor(c, before, doc);
          if (!need.some((r) => has(me, r))) { audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "denied", coll: c, docId: id, label: label(c, doc) || label(c, before) }); return send(res, 403, { error: "You don't have permission for this.", need }); }
          if (before && (b.baseRev || 0) !== (before._rev || 0)) return send(res, 409, { error: "Someone else changed this record.", current: before });
          if (!before && b.baseRev) return send(res, 409, { error: "This record was deleted by someone else.", current: null });
          if (c === "sales" && before && before.no && doc.no !== before.no) return send(res, 400, { error: "Invoice numbers can't be changed." });
          const saved = Object.assign({}, doc, { id, _rev: (before ? before._rev || 0 : 0) + 1, _at: new Date().toISOString(), _by: me.username });
          commit({ t: "put", c, id, doc: saved });
          const action = !before ? "create" : c === "sales" && before.status !== "cancelled" && saved.status === "cancelled" ? "cancel" : "update";
          audit({ user: who(me), ip: ipOf(req), device: devOf(req), action, coll: c, docId: id, label: label(c, saved), changes: diff(before, saved), before, after: saved });
          broadcast({ type: "put", coll: c, doc: saved }, (s) => canReadColl(s.user, c));
          return send(res, 200, { doc: saved });
        }
        if (req.method === "DELETE") {
          if (!before) return send(res, 200, { ok: true });
          if (c === "sales") return send(res, 400, { error: "Invoices can't be deleted. Cancel them instead." });
          const need = rightFor(c, before, null);
          if (!need.some((r) => has(me, r))) { audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "denied", coll: c, docId: id, label: label(c, before) }); return send(res, 403, { error: "You don't have permission for this.", need }); }
          const baseRev = +u.searchParams.get("baseRev") || 0;
          if (baseRev && baseRev !== (before._rev || 0)) return send(res, 409, { error: "Someone else changed this record.", current: before });
          commit({ t: "del", c, id });
          audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "delete", coll: c, docId: id, label: label(c, before), changes: diff(before, null), before });
          broadcast({ type: "del", coll: c, id }, (s) => canReadColl(s.user, c));
          return send(res, 200, { ok: true });
        }
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = await readBody(req), doc = b.doc || {}, before = db.settings || {};
        const onlyLedgerPrefs = Object.keys(Object.assign({}, before, doc)).filter((k) => !META.has(k) && JSON.stringify(before[k]) !== JSON.stringify(doc[k])).every((k) => k === "upiLedger" || k === "cardLedger");
        if (!has(me, "settings.edit") && !(onlyLedgerPrefs && has(me, "accounts.edit"))) return send(res, 403, { error: "You don't have permission to change settings." });
        if ((b.baseRev || 0) !== (before._rev || 0)) return send(res, 409, { error: "Someone else changed the settings.", current: before });
        const saved = Object.assign({}, doc, { _rev: (before._rev || 0) + 1, _at: new Date().toISOString(), _by: me.username });
        commit({ t: "settings", doc: saved });
        audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "update", coll: "settings", docId: "settings", label: "Business settings", changes: diff(before, saved) });
        broadcast({ type: "settings", doc: saved });
        return send(res, 200, { doc: saved });
      }
      if (p === "/api/seq" && req.method === "POST") {
        if (!has(me, "sales.create")) return send(res, 403, { error: "You don't have permission to create invoices." });
        const b = await readBody(req), fy = String(b.fy || "").slice(0, 10);
        const n = Math.max(+db.counters[fy] || 0, +b.floor || 0) + 1;
        commit({ t: "counter", fy, n });
        broadcast({ type: "counters", counters: db.counters });
        return send(res, 200, { n });
      }
      if (p === "/api/counters" && req.method === "POST") {
        if (!has(me, "settings.edit")) return send(res, 403, { error: "Only an admin can reset numbering." });
        const b = await readBody(req);
        commit({ t: "counters", map: b.map || {} });
        audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "update", coll: "settings", label: "Invoice numbering reset", changes: [{ f: "counters", to: short(b.map) }] });
        broadcast({ type: "counters", counters: db.counters });
        return send(res, 200, { ok: true });
      }
      if (p === "/api/import" && req.method === "POST") {
        if (!has(me, "backup")) return send(res, 403, { error: "You don't have permission to import data." });
        const b = await readBody(req), d = b.data || {};
        const existing = COLLS.reduce((a, c) => a + Object.keys(db.colls[c]).length, 0);
        if (existing && !b.merge) return send(res, 409, { error: "The server already has records.", existing });
        let n = 0;
        for (const c of COLLS) for (const doc of d[c] || []) { if (!doc || !doc.id) continue; const before = db.colls[c][doc.id]; commit({ t: "put", c, id: doc.id, doc: Object.assign({}, doc, { _rev: (before ? before._rev || 0 : 0) + 1, _at: new Date().toISOString(), _by: me.username }) }); n++; }
        if (d.settings && Object.keys(d.settings).length) commit({ t: "settings", doc: Object.assign({}, d.settings, { _rev: (db.settings._rev || 0) + 1 }) });
        if (d.counters) for (const [fy, v] of Object.entries(d.counters)) commit({ t: "counter", fy, n: Math.max(+db.counters[fy] || 0, +v || 0) });
        audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "import", coll: "data", label: `${n} records imported${b.merge ? " (merge)" : ""}` });
        broadcast({ type: "reload" });
        return send(res, 200, { ok: true, imported: n });
      }
      if (p === "/api/users") {
        if (!has(me, "users.manage")) return send(res, 403, { error: "Only an admin can manage users." });
        if (req.method === "GET") return send(res, 200, { users: Object.values(db.users).map(pub), rights: RIGHTS, roles: ROLES });
        if (req.method === "POST") {
          const b = await readBody(req), username = String(b.username || "").trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,32}$/.test(username)) return send(res, 400, { error: "Username: 3–32 letters, digits, dot, dash or underscore." });
          if (Object.values(db.users).some((x) => x.username === username)) return send(res, 400, { error: "That username is taken." });
          if (String(b.password || "").length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
          const role = ROLES[b.role] ? b.role : "viewer";
          const salt = crypto.randomBytes(16).toString("hex");
          const user = { id: "u" + crypto.randomBytes(6).toString("hex"), username, name: String(b.name || username).slice(0, 60), role, rights: role === "admin" ? ALL : (Array.isArray(b.rights) ? b.rights.filter((r) => ALL.includes(r)) : ROLES[role].rights), active: true, salt, hash: hashPw(b.password, salt), createdAt: new Date().toISOString() };
          commit({ t: "user", user });
          audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "create", coll: "users", docId: user.id, label: `${user.name} (${username})`, changes: [{ f: "role", to: ROLES[role].name }, { f: "rights", to: user.rights.join(", ") }] });
          broadcast({ type: "users" }, (s) => has(s.user, "users.manage"));
          return send(res, 200, { user: pub(user) });
        }
      }
      if ((m = p.match(/^\/api\/users\/([a-z0-9]+)$/)) && req.method === "PUT") {
        if (!has(me, "users.manage")) return send(res, 403, { error: "Only an admin can manage users." });
        const target = db.users[m[1]]; if (!target) return send(res, 404, { error: "User not found." });
        const b = await readBody(req), next = Object.assign({}, target);
        if (b.name !== undefined) next.name = String(b.name).slice(0, 60);
        if (b.role !== undefined && ROLES[b.role]) next.role = b.role;
        if (Array.isArray(b.rights)) next.rights = b.rights.filter((r) => ALL.includes(r));
        if (next.role === "admin") next.rights = ALL;
        if (b.active !== undefined) next.active = !!b.active;
        if (b.password) { if (String(b.password).length < 6) return send(res, 400, { error: "Password must be at least 6 characters." }); next.salt = crypto.randomBytes(16).toString("hex"); next.hash = hashPw(b.password, next.salt); }
        const admins = Object.values(db.users).filter((x) => x.role === "admin" && x.active !== false && x.id !== target.id);
        if (!admins.length && (next.role !== "admin" || next.active === false)) return send(res, 400, { error: "Keep at least one active admin." });
        commit({ t: "user", user: next });
        if (next.active === false || b.password) for (const [k, s] of Object.entries(sessions)) if (s.userId === next.id && k !== auth.key) delete sessions[k];
        saveSessions();
        const ch = diff(pub(target), pub(next)).filter((x) => x.f !== "lastLogin"); if (b.password) ch.push({ f: "password", to: "reset" });
        audit({ user: who(me), ip: ipOf(req), device: devOf(req), action: "update", coll: "users", docId: next.id, label: `${next.name} (${next.username})`, changes: ch });
        broadcast({ type: "users" });
        return send(res, 200, { user: pub(next) });
      }
      if (p === "/api/audit") {
        if (!has(me, "audit.view")) return send(res, 403, { error: "You don't have permission to view the audit trail." });
        const from = u.searchParams.get("from") || "", to = u.searchParams.get("to") || "", usr = u.searchParams.get("user") || "", coll = u.searchParams.get("coll") || "", act = u.searchParams.get("action") || "";
        const lim = Math.min(+u.searchParams.get("limit") || 2000, 10000);
        let rows = readAudit().filter((e) => (!from || e.ts.slice(0, 10) >= from) && (!to || e.ts.slice(0, 10) <= to) && (!usr || (e.user && e.user.username) === usr) && (!coll || e.coll === coll) && (!act || e.action === act));
        rows = rows.reverse().slice(0, lim);
        return send(res, 200, { entries: rows, total: auditCount });
      }
      if (p === "/api/audit/verify") {
        if (!has(me, "audit.view")) return send(res, 403, { error: "You don't have permission to view the audit trail." });
        return send(res, 200, verifyAudit());
      }
      return send(res, 404, { error: "Not found." });
    } catch (e) {
      log("error", e && e.stack || e);
      return send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message || "Server error" });
    }
  }
  function login(user, req, res) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions[tokenKey(token)] = { userId: user.id, created: Date.now(), lastSeen: Date.now(), device: devOf(req), ip: ipOf(req) };
    saveSessions();
    const upd = Object.assign({}, user, { lastLogin: new Date().toISOString() });
    commit({ t: "user", user: upd });
    audit({ user: who(user), ip: ipOf(req), device: devOf(req), action: "login", coll: "users", docId: user.id, label: user.username });
    return send(res, 200, { token, user: pub(upd), rights: RIGHTS, roles: ROLES });
  }
  function serveStatic(p, res) {
    if (!wwwDir) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("Ledgerbook Server " + VERSION + " is running."); }
    let rel = decodeURIComponent(p === "/" ? "/index.html" : p);
    const file = path.normalize(path.join(wwwDir, rel));
    if (!file.startsWith(path.normalize(wwwDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(buf);
    });
  }

  let server = null, port = opts.port || 8787;
  return {
    start(p2) {
      return new Promise((resolve, reject) => {
        if (server) return resolve(this.info());
        port = p2 || port;
        server = http.createServer((q, r) => { handle(q, r).catch((e) => { try { send(r, 500, { error: e.message }); } catch (x) { /* ignore */ } }); });
        server.on("error", (e) => { server = null; reject(e); });
        server.listen(port, opts.host || "0.0.0.0", () => { log(`Ledgerbook Server ${VERSION} on port ${port}, data in ${dataDir}`); resolve(this.info()); });
      });
    },
    stop() { return new Promise((resolve) => { if (!server) return resolve(); for (const c of clients) { try { c.res.end(); } catch (e) { /* ignore */ } } clients.clear(); server.close(() => { server = null; try { snapshot(); } catch (e) { /* ignore */ } resolve(); }); }); },
    info() {
      const ips = [];
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
      return { running: !!server, port, dataDir, urls: ips.map((ip) => `http://${ip}:${port}`), local: `http://localhost:${port}`, users: Object.keys(db.users).length, version: VERSION };
    },
    snapshot,
  };
}

module.exports = { createLedgerbookServer, RIGHTS, ROLES, VERSION };

if (require.main === module) {
  const port = +process.env.PORT || 8787;
  const srv = createLedgerbookServer({ dataDir: process.env.LEDGERBOOK_DATA || path.join(process.cwd(), "ledgerbook-data"), wwwDir: process.env.LEDGERBOOK_WWW || (fs.existsSync(path.join(__dirname, "www")) ? path.join(__dirname, "www") : null), port });
  srv.start().then((i) => { console.log("Open on this computer:", i.local); for (const x of i.urls) console.log("Open on your network:", x); });
  const bye = () => srv.stop().then(() => process.exit(0));
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
