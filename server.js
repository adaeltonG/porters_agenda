import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRows, isSheetFile, today } from "./src/extract.js";
import { levenshtein } from "./src/table.js";
import { openDb, importOldState } from "./src/db.js";
import { initPush, notify, pushPublicKey } from "./src/push.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// `npm run mock`: uploads return a hand-typed copy of the 18/11 agenda (for UI work).
if (process.argv.includes("--mock")) {
  process.env.EXTRACT_MOCK = "1";
  process.env.TEAM_PIN ||= "1234";
  process.env.ADMIN_PIN ||= "4321";
  console.log("MOCK MODE - uploads use src/mock-extraction.json. Team PIN", process.env.TEAM_PIN, "admin PIN", process.env.ADMIN_PIN);
}
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const IMG_DIR = path.join(DATA_DIR, "images");
const TEAM_PIN = (process.env.TEAM_PIN || "").trim();
const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();
const ADMIN_NAME = (process.env.ADMIN_NAME || "").trim().slice(0, 40) || "Admin"; // shown on ticks/uploads from the dashboard

const SLOT_KEYS = ["setup", "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "reset"];
const SLOT_LABEL = { setup: "Setup", teaCoffee: "Tea/coffee", breakfast: "Breakfast", lunch: "Lunch", afternoon: "Afternoon catering", clearUp: "Clear up", reset: "Reset" };

mkdirSync(IMG_DIR, { recursive: true });
if (!TEAM_PIN) console.warn("WARNING: TEAM_PIN is not set - anyone with the link can use the app.");
if (!ADMIN_PIN) console.warn("WARNING: ADMIN_PIN is not set - the admin dashboard is switched off.");

// ---------- database ----------

const store = openDb(DATA_DIR);
if (!store.porters({ all: true }).length) {
  const seed = (process.env.PORTERS || "Tom,Jeet,Robinson,Pablo,Ricardo,Wilson").split(",").map((s) => s.trim()).filter(Boolean);
  store.tx(() => seed.forEach((n) => store.addPorter(n)));
}
initPush(store);

// ---------- normalising jobs ----------

const str = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const blankish = (v) => (/^(n|-|n\/a|none|null)$/i.test(str(v)) ? "" : str(v));
const EVERYONE_RE = /\b(everyone|everybody|all porters|all)\b/i;

function cleanTime(t) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(str(t));
  if (!m) return "";
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function cleanSlot(s) {
  const time = cleanTime(s?.time);
  const note = blankish(s?.note);
  const needed = Boolean(s?.needed) || Boolean(time);
  return needed ? { needed: true, time, note } : { needed: false, time: "", note: "" };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "TCW : Wilson L:Pablo" -> [{ name: "Wilson", roles: ["TCW"] }, { name: "Pablo", roles: ["L"] }] */
function parsePorters(raw, names) {
  const text = str(raw);
  const out = [];
  for (const name of names) {
    const re = new RegExp(`(?:\\b([A-Za-z]{1,4})\\s*:\\s*)?\\b${escapeRe(name)}\\b`, "gi");
    const roles = [];
    let found = false, m;
    while ((m = re.exec(text))) {
      found = true;
      if (m[1]) roles.push(m[1].toUpperCase());
    }
    if (found) out.push({ name, roles });
  }
  return out;
}

/** Matches a typed/OCR'd host name to the registered spelling ("niamh keenan" -> "Niamh Keenan"). */
function canonicalHost(name, known, fuzzy) {
  const n = str(name);
  if (!n) return "";
  const lower = n.toLowerCase();
  const exact = known.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  if (fuzzy && n.length >= 5) {
    let best = null, bestD = 99;
    for (const k of known) {
      const d = levenshtein(lower, k.toLowerCase());
      if (d < bestD) { best = k; bestD = d; }
    }
    if (best && bestD <= (n.length >= 9 ? 2 : 1)) return best;
  }
  return n;
}

/**
 * Builds a clean job from a sheet row or from the app's edit form.
 * opts.ocr: the row came from a screenshot, so host names may be slightly misspelt.
 */
function makeJob(row, { idCounts, ocr = false } = {}) {
  const porterNames = store.porterNames();
  const knownHosts = store.hosts().map((h) => h.name);
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = cleanSlot(row[k] ?? row.slots?.[k]);

  const portersRaw = blankish(row.portersRaw ?? (typeof row.porters === "string" ? row.porters : ""));
  let porters, everyone, porterSource;
  if (Array.isArray(row.porters)) {
    porterSource = row.porterSource || "app";
    // from the app: ["Tom", "Jeet"] or [{ name, roles }]
    const seen = new Set();
    porters = row.porters
      .map((p) => (typeof p === "string" ? { name: p, roles: [] } : { name: str(p?.name), roles: Array.isArray(p?.roles) ? p.roles.map(str) : [] }))
      .map((p) => ({ ...p, name: porterNames.find((n) => n.toLowerCase() === p.name.toLowerCase()) || p.name }))
      .filter((p) => p.name && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()));
    everyone = Boolean(row.everyone);
  } else {
    porterSource = "sheet";
    porters = parsePorters(portersRaw, porterNames);
    everyone = row.everyone != null ? Boolean(row.everyone) : EVERYONE_RE.test(portersRaw);
  }

  const hostList = Array.isArray(row.hosts) ? row.hosts : blankish(row.host).split(/\s*(?:,|&|\/|\band\b)\s*/i);
  const hosts = [...new Set(hostList.map((h) => canonicalHost(blankish(h), knownHosts, ocr)).filter(Boolean))];

  const job = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)) ? str(row.date) : "",
    owner: ["Hospitality", "Movers", "Both"].includes(str(row.owner)) ? str(row.owner) : "Other",
    requestor: blankish(row.requestor),
    eventLead: blankish(row.eventLead),
    hosts,
    host: hosts.join(", "),
    vendor: blankish(row.vendor),
    location: blankish(row.location),
    attendees: blankish(row.attendees),
    info: str(row.info),
    portersRaw,
    porters,
    everyone,
    porterSource, // "app" once someone assigns porters in the app: a re-uploaded sheet won't overwrite that
    links: {
      menu: Boolean(row.hasMenuLink ?? row.links?.menu),
      agenda: Boolean(row.hasAgendaLink ?? row.links?.agenda),
      floorPlan: Boolean(row.hasFloorPlanLink ?? row.links?.floorPlan),
    },
    slots,
  };
  if (idCounts) {
    // IDs come from the row's content, so a re-posted or overlapping screenshot maps onto
    // the same jobs (and keeps their ticks and assignments) instead of duplicating them.
    const base = crypto.createHash("sha1")
      .update([job.date, job.owner, job.host, job.location].join("|").toLowerCase())
      .digest("hex").slice(0, 10);
    const n = (idCounts[base] = (idCounts[base] || 0) + 1);
    job.id = n > 1 ? `${base}-${n}` : base;
  }
  return job;
}

// ---------- notifications ----------

/** Everyone a job is assigned to ("Everyone" = all active porters). */
function assignees(job) {
  if (!job) return [];
  return job.everyone ? store.porterNames() : (job.porters || []).map((p) => p.name);
}

function dayLabel(date) {
  if (date === today()) return "Today";
  const d = new Date(date + "T12:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function describeJob(job) {
  const tasks = SLOT_KEYS.filter((k) => job.slots?.[k]?.needed);
  const first = tasks.map((k) => job.slots[k].time).filter(Boolean).sort()[0];
  const what = tasks.length === 1 ? SLOT_LABEL[tasks[0]] : tasks.length ? `${tasks.length} tasks` : "Job";
  return `${first ? first + " " : ""}${what} · ${job.location || job.host || "see app"}${job.location && job.host ? ` (${job.host})` : ""}`;
}

/**
 * Tells each porter about jobs they've just been given (compares before/after).
 * Past days are skipped. One notification per porter, summarising if there are several.
 */
function notifyAssignments(changes, by) {
  const t = today();
  const perPorter = new Map();
  for (const { before, after } of changes) {
    if (!after || !after.date || after.date < t) continue;
    const had = new Set(assignees(before).map((n) => n.toLowerCase()));
    for (const name of assignees(after)) {
      if (had.has(name.toLowerCase()) || name.toLowerCase() === String(by).toLowerCase()) continue;
      if (!perPorter.has(name)) perPorter.set(name, []);
      perPorter.get(name).push(after);
    }
  }
  for (const [name, jobs] of perPorter) {
    const days = [...new Set(jobs.map((j) => j.date))];
    const when = days.length === 1 ? dayLabel(days[0]) : "Coming days";
    const msg = jobs.length === 1
      ? { title: `New job${when === "Today" ? "" : ` · ${when}`}`, body: describeJob(jobs[0]) }
      : { title: `${jobs.length} new jobs · ${when}`, body: jobs.slice(0, 3).map(describeJob).join("\n") + (jobs.length > 3 ? `\n+${jobs.length - 3} more` : "") };
    notify(store, [name], { ...msg, tag: `assign-${days[0]}` }).catch((e) => console.error("notify:", e));
  }
}

// ---------- views ----------

/** What a porter's phone shows: today (or the last day with jobs) plus anything ahead. */
function teamState(req) {
  const t = today();
  const from = store.jobsOn(t).length ? t : store.lastDayWithJobs(t) || t;
  const jobs = store.jobsBetween(from, "9999-12-31");
  const uploads = {};
  for (const d of new Set(jobs.map((j) => j.date))) uploads[d] = store.uploadFor(d);
  return { version: store.version, today: t, admin: Boolean(req.isAdmin), jobs, ticks: store.ticksFor(jobs.map((j) => j.id)), uploads };
}

function adminDay(date) {
  const jobs = store.jobsOn(date);
  const hostNames = new Set(store.hosts().map((h) => h.name.toLowerCase()));
  return {
    version: store.version,
    today: today(),
    date,
    jobs,
    ticks: store.ticksFor(jobs.map((j) => j.id)),
    upload: store.uploadFor(date),
    porters: store.porterNames(),
    hosts: store.hosts().map((h) => h.name),
    newHosts: [...new Set(jobs.flatMap((j) => j.hosts || []).filter((h) => !hostNames.has(h.toLowerCase())))],
  };
}

// ---------- app ----------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(here, "public"), {
  maxAge: "5m",
  // code and pages are re-checked on every load (cheap 304s), so an update shows up straight away
  setHeaders: (res, file) => { if (/\.(js|css|html|webmanifest)$/.test(file)) res.set("Cache-Control", "no-cache"); },
}));

function sameSecret(given, secret) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
const teamPinOk = (p) => !TEAM_PIN || sameSecret(p, TEAM_PIN);
const adminPinOk = (p) => Boolean(ADMIN_PIN) && sameSecret(p, ADMIN_PIN);

/** Team members (team PIN) and the admin (admin PIN) can both use the normal routes. */
function auth(req, res, next) {
  req.isAdmin = adminPinOk(req.get("x-admin-pin"));
  if (!req.isAdmin && !teamPinOk(req.get("x-team-pin"))) return res.status(401).json({ error: "Wrong PIN" });
  req.porter = str(decodeURIComponent(req.get("x-porter-name") || "")).slice(0, 40) || (req.isAdmin ? ADMIN_NAME : "Someone");
  next();
}
/** Uploading and changing jobs is for the admin; porters only tick their own jobs. */
function adminRequired(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Only the admin can change jobs." });
  next();
}
const isAssigned = (job, name) => Boolean(job.everyone) || (job.porters || []).some((p) => p.name.toLowerCase() === String(name).toLowerCase());

function adminOnly(req, res, next) {
  if (!ADMIN_PIN) return res.status(503).json({ error: "The admin dashboard is off. Set ADMIN_PIN on the server." });
  if (!adminPinOk(req.get("x-admin-pin"))) return res.status(401).json({ error: "Wrong admin PIN" });
  req.isAdmin = true;
  req.porter = ADMIN_NAME;
  next();
}

const changed = () => store.bump();

app.get("/api/config", (_req, res) => {
  res.json({ porters: store.porterNames(), pinRequired: Boolean(TEAM_PIN), pushKey: pushPublicKey() });
});

app.post("/api/login", (req, res) => {
  if (!teamPinOk(req.body?.pin)) return res.status(401).json({ error: "Wrong PIN" });
  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  if (!ADMIN_PIN) return res.status(503).json({ error: "The admin dashboard is off. Set ADMIN_PIN on the server." });
  if (!adminPinOk(req.body?.pin)) return res.status(401).json({ error: "That PIN isn't right." });
  res.json({ ok: true });
});

app.get("/api/state", auth, (req, res) => {
  res.set("Cache-Control", "no-store");
  if (Number(req.query.since) === store.version) return res.json({ unchanged: true, version: store.version });
  res.json(teamState(req));
});

app.get("/api/hosts", auth, (_req, res) => res.json({ hosts: store.hosts().map((h) => h.name) }));

app.get("/api/images/:name", auth, (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(name) || !store.imageKnown(name)) return res.sendStatus(404);
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(IMG_DIR, name));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype) || isSheetFile(file)),
});

let extracting = false;

app.post("/api/upload", auth, adminRequired, upload.array("images", 6), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Please choose a screenshot or the spreadsheet file (.xlsx / .csv)." });
  if (extracting) return res.status(409).json({ error: "Someone else is uploading right now. Try again in a minute." });
  const mode = req.body.mode === "append" ? "append" : "replace";

  extracting = true;
  try {
    const result = await extractRows(files, { porters: store.porterNames() });
    const ocr = files.some((f) => !isSheetFile(f));
    const idCounts = {};
    const fresh = result.rows.map((r) => makeJob({ ...r, date: r.date || today() }, { idCounts, ocr }));
    const dates = [...new Set(fresh.map((j) => j.date))];

    // keep the screenshots so people can compare later; a spreadsheet file isn't kept
    const names = [];
    for (const [i, f] of files.filter((f) => !isSheetFile(f)).entries()) {
      const ext = f.mimetype === "image/png" ? "png" : f.mimetype === "image/webp" ? "webp" : "jpg";
      const name = `${Date.now()}-${i}.${ext}`;
      await fs.writeFile(path.join(IMG_DIR, name), f.buffer);
      names.push(name);
    }

    const changes = [];
    store.tx(() => {
      const freshIds = new Set(fresh.map((j) => j.id));
      if (mode === "replace") {
        // jobs from an earlier upload of the same day that aren't on the new sheet go;
        // jobs someone added by hand stay
        for (const d of dates) {
          for (const old of store.jobsOn(d)) if (!freshIds.has(old.id) && !old.id.startsWith("m")) store.deleteJob(old.id);
        }
      }
      for (const job of fresh) {
        const before = store.job(job.id);
        // porters assigned in the app win over the sheet; and a sheet with no porters
        // never wipes ones that were already there
        if (before && (before.porterSource === "app" || (!job.porters.length && !job.everyone))) {
          job.porters = before.porters || [];
          job.everyone = Boolean(before.everyone);
          job.porterSource = before.porterSource;
        }
        store.saveJob(job);
        changes.push({ before, after: job });
      }
      store.addUpload({ by: req.porter, dates, images: names, warnings: result.warnings || [] });
      changed();
    });
    notifyAssignments(changes, req.porter);

    const known = new Set(store.hosts().map((h) => h.name.toLowerCase()));
    res.json({
      ok: true,
      count: fresh.length,
      dates,
      warnings: result.warnings || [],
      unassigned: fresh.filter((j) => !j.everyone && !j.porters.length).length,
      newHosts: [...new Set(fresh.flatMap((j) => j.hosts).filter((h) => !known.has(h.toLowerCase())))],
    });
  } catch (e) {
    console.error("Extraction failed:", e);
    res.status(502).json({ error: e.message || "Could not read the screenshot." });
  } finally {
    extracting = false;
  }
});

app.post("/api/tick", auth, (req, res) => {
  const { jobId, task, done } = req.body || {};
  const job = store.job(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (!req.isAdmin && !isAssigned(job, req.porter)) return res.status(403).json({ error: "You can only tick your own jobs." });
  if (![...SLOT_KEYS, "done"].includes(task)) return res.status(400).json({ error: "Unknown task" });
  if (done) store.setTick(jobId, task, req.porter); else store.clearTick(jobId, task);
  const version = changed();
  res.json({ ok: true, version, ticks: store.ticksFor([jobId])[jobId] || {} });
});

/** The admin registering a host by using it is the same as adding it to the list. */
function registerHosts(req, job) {
  if (req.isAdmin) for (const h of job.hosts) store.addHost(h);
}

app.post("/api/jobs", auth, adminRequired, (req, res) => {
  const job = makeJob(req.body || {});
  job.id = "m" + crypto.randomBytes(5).toString("hex");
  job.date ||= today();
  store.tx(() => { registerHosts(req, job); store.saveJob(job); changed(); });
  notifyAssignments([{ before: null, after: job }], req.porter);
  res.json({ ok: true, job });
});

app.put("/api/jobs/:id", auth, adminRequired, (req, res) => {
  const before = store.job(req.params.id);
  if (!before) return res.status(404).json({ error: "Job not found" });
  const body = req.body || {};
  const job = makeJob({ ...body, porters: body.porters ?? before.porters, everyone: body.everyone ?? before.everyone });
  job.id = before.id;
  job.date ||= before.date;
  // keep sheet roles ("TCW", "L") for porters who are still assigned
  job.porters = job.porters.map((p) => (p.roles.length ? p : { ...p, roles: before.porters?.find((o) => o.name === p.name)?.roles || [] }));
  store.tx(() => { registerHosts(req, job); store.saveJob(job); changed(); });
  notifyAssignments([{ before, after: job }], req.porter);
  res.json({ ok: true, job });
});

/** Just the porters (the dashboard's assign dropdown). */
app.put("/api/jobs/:id/porters", auth, adminRequired, (req, res) => {
  const before = store.job(req.params.id);
  if (!before) return res.status(404).json({ error: "Job not found" });
  const names = Array.isArray(req.body?.porters) ? req.body.porters.map(str).filter(Boolean) : [];
  const job = {
    ...before,
    porterSource: "app",
    everyone: Boolean(req.body?.everyone),
    porters: names.map((n) => before.porters?.find((p) => p.name.toLowerCase() === n.toLowerCase()) || { name: n, roles: [] }),
  };
  store.tx(() => { store.saveJob(job); changed(); });
  notifyAssignments([{ before, after: job }], req.porter);
  res.json({ ok: true, job });
});

app.delete("/api/jobs/:id", auth, adminRequired, (req, res) => {
  let ok = false;
  store.tx(() => { ok = store.deleteJob(req.params.id); if (ok) changed(); });
  if (!ok) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true });
});

// ---------- push ----------

app.post("/api/push/subscribe", auth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: "Bad subscription" });
  }
  store.saveSub(req.porter, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", auth, (req, res) => {
  if (req.body?.endpoint) store.deleteSub(String(req.body.endpoint));
  res.json({ ok: true });
});

app.post("/api/push/test", auth, async (req, res) => {
  const sent = await notify(store, [req.porter], { title: "Notifications are on", body: "You'll get a message here when you're given a new job.", tag: "test" });
  res.json({ ok: true, sent });
});

// ---------- admin ----------

app.get("/api/admin/day", adminOnly, (req, res) => {
  res.set("Cache-Control", "no-store");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : today();
  if (Number(req.query.since) === store.version && req.query.known === date) return res.json({ unchanged: true, version: store.version });
  res.json(adminDay(date));
});

app.get("/api/admin/history", adminOnly, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ today: today(), days: store.daySummaries(366) });
});

app.get("/api/admin/hosts", adminOnly, (_req, res) => {
  res.json({ hosts: store.hosts(), unlisted: store.unlistedHosts() });
});

app.post("/api/admin/hosts", adminOnly, (req, res) => {
  const names = (Array.isArray(req.body?.names) ? req.body.names : [req.body?.name]).map(str).filter((n) => n && n.length <= 80);
  if (!names.length) return res.status(400).json({ error: "Type a name" });
  store.tx(() => { names.forEach((n) => store.addHost(n)); changed(); });
  res.json({ ok: true });
});

app.put("/api/admin/hosts/:id", adminOnly, (req, res) => {
  const name = str(req.body?.name);
  if (!name) return res.status(400).json({ error: "Type a name" });
  try { store.renameHost(Number(req.params.id), name); } catch { return res.status(409).json({ error: "That host is already on the list" }); }
  changed();
  res.json({ ok: true });
});

app.delete("/api/admin/hosts/:id", adminOnly, (req, res) => {
  store.deleteHost(Number(req.params.id));
  changed();
  res.json({ ok: true });
});

app.get("/api/admin/porters", adminOnly, (_req, res) => {
  res.json({ porters: store.porters({ all: true }), notifications: store.subCounts() });
});

app.post("/api/admin/porters", adminOnly, (req, res) => {
  const name = str(req.body?.name);
  if (!name || name.length > 40 || /^everyone$/i.test(name)) return res.status(400).json({ error: "Type a name" });
  store.addPorter(name);
  changed();
  res.json({ ok: true });
});

app.put("/api/admin/porters/:id", adminOnly, (req, res) => {
  store.setPorterActive(Number(req.params.id), Boolean(req.body?.active));
  changed();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "That file is too big (max 12 MB)."
      : err.code === "LIMIT_FILE_COUNT" ? "Up to 6 screenshots at a time." : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

// bring over the agenda from before the database existed
importOldState(store, DATA_DIR, (j) => {
  const job = makeJob({ ...j, porterSource: "sheet" });
  job.id = j.id;
  return job;
});

app.listen(PORT, () => console.log(`Porters agenda on http://localhost:${PORT}`));
