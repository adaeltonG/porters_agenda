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
import { autoAssign, taskLoads, describeRules, tasksOf, heldTasks, RULES } from "./src/autoassign.js";
import { readRota, parseCode, normCode, matchPorter, titleCase, SHIFTS, SITES, CODES } from "./src/rota.js";

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
// PIN for the hosts' read-only view. Without one, hosts use the team PIN.
const HOST_PIN = (process.env.HOST_PIN || "").trim();
const ADMIN_NAME = (process.env.ADMIN_NAME || "").trim().slice(0, 40) || "Admin"; // shown on ticks/uploads from the dashboard
// Admin logins: ADMIN_PIN belongs to ADMIN_NAME; more people in ADMIN_ACCOUNTS="Name:password,Name2:password2".
const ADMINS = [
  ...(ADMIN_PIN ? [{ name: ADMIN_NAME, pin: ADMIN_PIN }] : []),
  ...String(process.env.ADMIN_ACCOUNTS || "").split(",").map((s) => {
    const i = s.indexOf(":");
    return i > 0 ? { name: s.slice(0, i).trim().slice(0, 40), pin: s.slice(i + 1).trim() } : null;
  }).filter((a) => a?.name && a.pin),
];

const SLOT_KEYS = ["setup", "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "reset"];
const SLOT_LABEL = { setup: "Setup", teaCoffee: "Tea/coffee", breakfast: "Breakfast", lunch: "Lunch", afternoon: "Afternoon catering", clearUp: "Clear up", reset: "Reset" };

mkdirSync(IMG_DIR, { recursive: true });
if (!TEAM_PIN) console.warn("WARNING: TEAM_PIN is not set - anyone with the link can use the app.");
if (!ADMINS.length) console.warn("WARNING: no ADMIN_PIN / ADMIN_ACCOUNTS - the admin dashboard is switched off.");

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

  const site = str(row.site).toLowerCase();
  const job = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)) ? str(row.date) : "",
    site: SITES[site] ? site : "tower", // which building: the Tower or DSQ
    owner: ["Hospitality", "Movers", "Both"].includes(str(row.owner)) ? str(row.owner) : "Other",
    requestor: blankish(row.requestor),
    eventLead: blankish(row.eventLead),
    hosts,
    host: hosts.join(", "),
    vendor: blankish(row.vendor),
    location: blankish(row.location),
    task: blankish(row.task), // what to do, when the sheet says it in words ("L33 Flexroom Clean")
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
      .update([job.date, job.owner, job.host, job.location, ...(job.task ? [job.task] : []), ...(job.site !== "tower" ? [job.site] : [])].join("|").toLowerCase())
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
  if (!tasks.length && job.task) return `${job.task}${job.location && !job.task.includes(job.location) ? ` · ${job.location}` : ""}`;
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

// ---------- automatic porters ----------

const unassignedJob = (j) => !j.everyone && !j.porters?.length;

/**
 * Who's working on a day, and where. One entry per active porter:
 * { name, in, site, from, to, label, why, rota, base }. What decides it, strongest first:
 * the admin marking them off / back in on the dashboard > a booked holiday > the rota
 * (AM / PM / DSQ / PTO...) > their usual building, all day. `base` is the answer without
 * the admin's mark, so a mark that agrees with the rota can be dropped.
 */
function planFor(date) {
  const rota = new Map(store.rotaBetween(date, date).map((r) => [r.porter.toLowerCase(), r.code]));
  const marks = new Map(store.dayOffs(date).map((r) => [r.porter.toLowerCase(), r.off]));
  const away = new Set(store.awayOverlapping(date, date).map((a) => a.porter.toLowerCase()));
  return store.porters().map((p) => {
    const k = p.name.toLowerCase();
    let e = { in: true, site: p.site, from: null, to: null, label: "", why: "usual" };
    if (rota.has(k)) e = { ...parseCode(rota.get(k)), why: "rota" };
    if (e.in && !p.tasks) e = { ...e, in: false, label: "No tasks", why: "no-tasks" };
    if (away.has(k)) e = { ...e, in: false, label: "Holiday", why: "away" };
    const base = { in: e.in, label: e.label };
    if (marks.has(k)) {
      e = marks.get(k)
        ? { ...e, in: false, label: "Off", why: "marked" }
        : { ...e, in: true, site: e.site || p.site, label: e.in ? e.label : "In", why: "marked" };
    }
    return { name: p.name, ...e, rota: rota.get(k) || "", base };
  });
}

/** Tasks a person still has to do on a day (not ticked yet). */
function openTasks(jobs, ticks, name) {
  let n = 0;
  for (const j of jobs) {
    if (j.everyone) continue;
    const p = (j.porters || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (p) n += heldTasks(j, p).filter((t) => !ticks[j.id]?.[t.key]).length;
  }
  return n;
}

/**
 * Gives porters to the target jobs (changes the job objects), building by building: Tower
 * jobs to the people at the Tower that day, DSQ jobs to the DSQ people. Returns how many got someone.
 */
function fillPorters(dayJobs, targetIds, date, plan = planFor(date)) {
  let n = 0;
  for (const site of Object.keys(SITES)) {
    const siteJobs = dayJobs.filter((j) => (j.site || "tower") === site);
    const ids = siteJobs.filter((j) => targetIds.has(j.id)).map((j) => j.id);
    const roster = plan.filter((e) => e.in && e.site === site);
    if (!ids.length || !roster.length) continue;
    const { porters } = autoAssign(siteJobs, ids, roster);
    for (const job of siteJobs) {
      const picked = targetIds.has(job.id) && porters.get(job.id);
      if (!picked?.length) continue;
      job.porters = picked;
      job.everyone = false;
      job.porterSource = "auto"; // like the sheet's: porters in a re-uploaded sheet win, and so do the admin's picks
      n++;
    }
  }
  return n;
}

/** A day's agenda uploads (Tower and DSQ) as one: latest time, all screenshots, all warnings. */
function dayUpload(date) {
  const ups = Object.keys(SITES).map((s) => store.uploadFor(date, s)).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
  if (!ups.length) return null;
  const last = ups.at(-1);
  const both = ups.length > 1;
  return {
    at: last.at, by: last.by,
    images: ups.flatMap((u) => u.images),
    warnings: ups.flatMap((u) => u.warnings.map((w) => (both ? `${SITES[u.site]}: ${w}` : w))),
    sites: ups.map((u) => ({ site: u.site, at: u.at, by: u.by })),
  };
}

/** Before the rota: "Auto-assign" saved who was working as roster:<date>. Those become day-off marks. */
function migrateRosters() {
  const old = store.metaLike("roster:");
  if (!old.length) return;
  store.tx(() => {
    for (const { key, value } of old) {
      try {
        const keep = new Set(JSON.parse(value).map((n) => String(n).toLowerCase()));
        for (const p of store.porters()) if (!keep.has(p.name.toLowerCase())) store.setDayOff(key.slice(7), p.name, true);
      } catch { /* ignore a broken one */ }
      store.deleteMeta(key);
    }
  });
}
migrateRosters();

// ---------- views ----------

/** What a porter's phone shows: today (or the last day with jobs) plus anything ahead. */
function teamState(req) {
  const t = today();
  const from = store.jobsOn(t).length ? t : store.lastDayWithJobs(t) || t;
  const jobs = store.jobsBetween(from, "9999-12-31");
  const uploads = {}, plans = {};
  for (const d of new Set(jobs.map((j) => j.date))) {
    uploads[d] = dayUpload(d);
    plans[d] = Object.fromEntries(planFor(d).map((e) => [e.name, { in: e.in, site: e.site, label: e.label, from: e.from, to: e.to }]));
  }
  return { version: store.version, today: t, admin: Boolean(req.isAdmin), jobs, ticks: store.ticksFor(jobs.map((j) => j.id)), uploads, plans };
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
    upload: dayUpload(date),
    porters: store.porterNames(),
    plan: planFor(date),
    sites: SITES,
    loads: taskLoads(jobs),
    autoRules: describeRules(RULES, SHIFTS),
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
const decode = (v) => { try { return decodeURIComponent(v || ""); } catch { return ""; } };

/**
 * Which admin this is (their name), or null. With no name given (dashboards logged in before
 * there were several admins) the password alone decides. Upper/lower case doesn't matter.
 */
function adminFor(user, pin) {
  if (!pin) return null;
  const u = str(decode(user)).toLowerCase();
  const p = String(pin).trim().toUpperCase();
  let found = null;
  for (const a of ADMINS) if (!found && (!u || a.name.toLowerCase() === u) && sameSecret(p, a.pin.toUpperCase())) found = a.name;
  return found;
}
const adminOf = (req) => adminFor(req.get("x-admin-user"), req.get("x-admin-pin"));

/** Team members (team PIN) and the admins can both use the normal routes. */
function auth(req, res, next) {
  const admin = adminOf(req);
  req.isAdmin = Boolean(admin);
  if (!req.isAdmin && !teamPinOk(req.get("x-team-pin"))) return res.status(401).json({ error: "Wrong PIN" });
  req.porter = str(decode(req.get("x-porter-name"))).slice(0, 40) || admin || "Someone";
  next();
}
/** Uploading and changing jobs is for the admin; porters only tick their own jobs. */
function adminRequired(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: "Only the admin can change jobs." });
  next();
}
const isAssigned = (job, name) => Boolean(job.everyone) || (job.porters || []).some((p) => p.name.toLowerCase() === String(name).toLowerCase());

function adminOnly(req, res, next) {
  if (!ADMINS.length) return res.status(503).json({ error: "The admin dashboard is off. Set ADMIN_PIN on the server." });
  const admin = adminOf(req);
  if (!admin) return res.status(401).json({ error: "Wrong admin login" });
  req.isAdmin = true;
  req.porter = admin;
  next();
}

const changed = () => store.bump();

app.get("/api/config", (_req, res) => {
  res.json({ porters: store.porterNames(), pinRequired: Boolean(TEAM_PIN), hostPinRequired: Boolean(HOST_PIN || TEAM_PIN), pushKey: pushPublicKey() });
});

// ---------- hosts (read-only: which of their events have been delivered / cleared) ----------

/** The host PIN, or the team PIN (porters can look too). Open when neither is set. */
function hostPinOk(p) {
  if (!HOST_PIN && !TEAM_PIN) return true;
  return Boolean((HOST_PIN && sameSecret(String(p || "").trim().toUpperCase(), HOST_PIN.toUpperCase())) || (TEAM_PIN && sameSecret(p, TEAM_PIN)) || adminFor(null, p));
}
function hostAuth(req, res, next) {
  if (!hostPinOk(req.get("x-team-pin")) && !adminOf(req)) return res.status(401).json({ error: "Wrong PIN" });
  next();
}
const hostNames = () => store.hosts().map((h) => h.name);

app.post("/api/host/login", (req, res) => {
  if (!hostPinOk(req.body?.pin)) return res.status(401).json({ error: "That PIN isn't right." });
  res.json({ ok: true, hosts: hostNames() });
});

app.get("/api/host/names", hostAuth, (_req, res) => res.json({ hosts: hostNames() }));

app.get("/api/host/state", hostAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  if (Number(req.query.since) === store.version) return res.json({ unchanged: true, version: store.version });
  const { uploads, plans: _plans, ...rest } = teamState({ isAdmin: false });
  // no screenshots for hosts, just when the agenda went up
  res.json({ ...rest, host: true, uploads: Object.fromEntries(Object.entries(uploads).map(([d, u]) => [d, u && { at: u.at, by: u.by }])) });
});

app.post("/api/login", (req, res) => {
  if (!teamPinOk(req.body?.pin)) return res.status(401).json({ error: "Wrong PIN" });
  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  if (!ADMINS.length) return res.status(503).json({ error: "The admin dashboard is off. Set ADMIN_PIN on the server." });
  const name = adminFor(encodeURIComponent(str(req.body?.user)), req.body?.pin);
  if (!name) return res.status(401).json({ error: "That name and password don't match." });
  res.json({ ok: true, name });
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
  const auto = req.body.autoAssign !== "0";
  const site = SITES[req.body.site] ? req.body.site : "tower";
  // people the admin tapped as off for the day(s) on this sheet
  let offNames = [];
  try { offNames = JSON.parse(req.body.off || "[]").map(str).filter(Boolean); } catch { /* none */ }

  extracting = true;
  try {
    const result = await extractRows(files, { porters: store.porterNames() });
    const ocr = files.some((f) => !isSheetFile(f));
    const idCounts = {};
    const fresh = result.rows.map((r) => makeJob({ ...r, date: r.date || today(), site }, { idCounts, ocr }));
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
    let autoAssigned = 0;
    store.tx(() => {
      const freshIds = new Set(fresh.map((j) => j.id));
      if (mode === "replace") {
        // jobs from an earlier upload of the same day (and building) that aren't on the new
        // sheet go; jobs someone added by hand stay, and so does the other building's agenda
        for (const d of dates) {
          for (const old of store.jobsOn(d)) if (!freshIds.has(old.id) && !old.id.startsWith("m") && (old.site || "tower") === site) store.deleteJob(old.id);
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
        changes.push({ before, after: job });
      }
      for (const d of dates) {
        for (const n of offNames) { const p = store.porterByName(n); if (p) store.setDayOff(d, p.name, true); }
      }
      // whatever still has nobody is shared out among that day's porters
      if (auto) {
        for (const d of dates) {
          const dayFresh = fresh.filter((j) => j.date === d);
          const others = store.jobsOn(d).filter((j) => !freshIds.has(j.id));
          autoAssigned += fillPorters([...dayFresh, ...others], new Set(dayFresh.filter(unassignedJob).map((j) => j.id)), d);
        }
      }
      for (const job of fresh) store.saveJob(job);
      store.addUpload({ by: req.porter, dates, images: names, warnings: result.warnings || [], site });
      changed();
    });
    notifyAssignments(changes, req.porter);

    const known = new Set(store.hosts().map((h) => h.name.toLowerCase()));
    res.json({
      ok: true,
      count: fresh.length,
      dates,
      warnings: result.warnings || [],
      autoAssigned,
      site,
      unassigned: fresh.filter(unassignedJob).length,
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
  const job = makeJob({ ...body, site: body.site ?? before.site, porters: body.porters ?? before.porters, everyone: body.everyone ?? before.everyone });
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
  res.json({ ...adminDay(date), me: req.porter });
});

/** "Auto-assign" on the dashboard: who's working that day, then fill (or re-shuffle) the jobs. */
app.post("/api/admin/autoassign", adminOnly, (req, res) => {
  const date = String(req.body?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Pick a day" });
  const plan = planFor(date);
  if (!plan.some((e) => e.in)) return res.status(400).json({ error: "Nobody is working that day" });
  const redo = Boolean(req.body?.redo);

  const jobs = store.jobsOn(date);
  const ticks = store.ticksFor(jobs.map((j) => j.id));
  // re-shuffling only touches automatic picks nobody has started on
  const targets = new Set(jobs.filter((j) => unassignedJob(j) || (redo && j.porterSource === "auto" && !ticks[j.id])).map((j) => j.id));
  const befores = new Map(jobs.map((j) => [j.id, structuredClone(j)]));
  let assigned = 0;
  store.tx(() => {
    // a job being re-shuffled starts empty, so its old porter doesn't count as busy
    for (const j of jobs) if (targets.has(j.id)) { j.porters = []; j.everyone = false; }
    assigned = fillPorters(jobs, targets, date, plan);
    for (const j of jobs) {
      if (!targets.has(j.id)) continue;
      const before = befores.get(j.id);
      if (!j.porters.length) Object.assign(j, { porters: before.porters || [], everyone: Boolean(before.everyone) }); // nobody fitted: leave it
      store.saveJob(j);
    }
    changed();
  });
  notifyAssignments(jobs.filter((j) => targets.has(j.id)).map((j) => ({ before: befores.get(j.id), after: j })), req.porter);
  res.json({ ok: true, assigned, targets: targets.size, loads: taskLoads(jobs) });
});

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

/** Tapping a name in "Who's in": off for the day, or back in. Says how many of their tasks are still to do. */
app.post("/api/admin/dayoff", adminOnly, (req, res) => {
  const date = String(req.body?.date || "");
  if (!isDate(date)) return res.status(400).json({ error: "Pick a day" });
  const e = planFor(date).find((x) => x.name.toLowerCase() === str(req.body?.name).toLowerCase());
  if (!e) return res.status(404).json({ error: "No porter by that name" });
  const off = Boolean(req.body?.off);
  // a mark that only repeats what the rota / holidays say anyway isn't kept
  store.tx(() => { store.setDayOff(date, e.name, e.base.in === !off ? null : off); changed(); });
  const jobs = store.jobsOn(date);
  res.json({ ok: true, name: e.name, tasks: off ? openTasks(jobs, store.ticksFor(jobs.map((j) => j.id)), e.name) : 0 });
});

/**
 * Hands the jobs of people who are off that day to others. Where someone else is also on
 * the room, they take over that part; otherwise the room is given out again automatically.
 * Tasks already ticked stay with whoever ticked them; finished jobs aren't touched.
 */
app.post("/api/admin/move", adminOnly, (req, res) => {
  const date = String(req.body?.date || "");
  if (!isDate(date)) return res.status(400).json({ error: "Pick a day" });
  const plan = planFor(date);
  const only = Array.isArray(req.body?.names) ? new Set(req.body.names.map((n) => str(n).toLowerCase())) : null;
  const off = new Set(plan.filter((e) => !e.in && (!only || only.has(e.name.toLowerCase()))).map((e) => e.name.toLowerCase()));
  const jobs = store.jobsOn(date);
  const ticks = store.ticksFor(jobs.map((j) => j.id));
  const befores = new Map(), targets = new Set();
  for (const j of jobs) {
    if (j.everyone) continue;
    const gone = (j.porters || []).filter((p) => off.has(p.name.toLowerCase()));
    if (!gone.length || tasksOf(j).every((t) => ticks[j.id]?.[t.key])) continue;
    befores.set(j.id, structuredClone(j));
    const stay = j.porters.filter((p) => !gone.includes(p));
    if (!stay.length) { j.porters = []; targets.add(j.id); continue; }
    if (stay.length === 1) stay[0] = { ...stay[0], roles: [] }; // the one left does the whole room
    else if (stay[0].roles.length) stay[0] = { ...stay[0], roles: gone.some((g) => !g.roles.length) ? [] : [...new Set([...stay[0].roles, ...gone.flatMap((g) => g.roles)])] };
    j.porters = stay;
  }
  let assigned = 0;
  store.tx(() => {
    assigned = fillPorters(jobs, targets, date, plan);
    for (const j of jobs) if (befores.has(j.id)) store.saveJob(j);
    if (befores.size) changed();
  });
  notifyAssignments([...befores.keys()].map((id) => ({ before: befores.get(id), after: jobs.find((j) => j.id === id) })), req.porter);
  const left = [...targets].filter((id) => !jobs.find((j) => j.id === id).porters.length).length;
  res.json({ ok: true, moved: befores.size, assigned, left, loads: taskLoads(jobs) });
});

// ---------- rota ----------

const mondayOf = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** The week's rota (Monday to Sunday) plus who's in on each day once holidays and marks count. */
app.get("/api/admin/rota", adminOnly, (req, res) => {
  res.set("Cache-Control", "no-store");
  const from = mondayOf(isDate(req.query.week) ? req.query.week : today());
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const codes = {};
  for (const r of store.rotaBetween(dates[0], dates[6])) (codes[r.date] ||= {})[r.porter.toLowerCase()] = r.code;
  const plans = Object.fromEntries(dates.map((d) => [d, Object.fromEntries(planFor(d).map((e) => [e.name, { in: e.in, site: e.site, label: e.label, why: e.why }]))]));
  const ups = dates.map((d) => store.uploadFor(d, "rota")).filter(Boolean).sort((a, b) => a.at.localeCompare(b.at));
  res.json({
    today: today(), dates, codes, plans, codeList: CODES, shifts: SHIFTS, sites: SITES,
    porters: store.porters().map(({ id, name, site, tasks, fullName }) => ({ id, name, site, tasks, fullName })),
    away: store.awayList(addDays(today(), -1)),
    upload: ups.at(-1) || null,
  });
});

/** Changing one rota cell by hand. An empty code clears it. */
app.put("/api/admin/rota", adminOnly, (req, res) => {
  const { date, name } = req.body || {};
  const p = store.porterByName(str(name));
  if (!isDate(date) || !p) return res.status(400).json({ error: "Pick a person and a day" });
  const code = str(req.body?.code) ? normCode(req.body.code) : "";
  store.tx(() => { store.setRota(date, p.name, code); changed(); });
  res.json({ ok: true, code });
});

const rotaFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 4 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype) || isSheetFile(file)),
});

/** Uploading the rota: read it, match the names to porters (adding anyone new), save it. */
app.post("/api/admin/rota", adminOnly, rotaFiles.array("files", 4), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Choose a screenshot or the rota spreadsheet." });
  if (extracting) return res.status(409).json({ error: "Someone else is uploading right now. Try again in a minute." });
  extracting = true;
  try {
    const r = await readRota(files, today());
    const names = [];
    for (const [i, f] of files.filter((f) => !isSheetFile(f)).entries()) {
      const name = `${Date.now()}-rota-${i}.${f.mimetype === "image/png" ? "png" : "jpg"}`;
      await fs.writeFile(path.join(IMG_DIR, name), f.buffer);
      names.push(name);
    }
    const people = [];
    store.tx(() => {
      const porters = store.porters({ all: true });
      for (const person of r.people) {
        let p = matchPorter(person.name, porters);
        let added = false;
        if (!p) {
          // someone new: registered by first name (full name if that's taken), at the building they mostly work in
          let name = titleCase(person.name.split(" ")[0]);
          if (porters.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = titleCase(person.name);
          const shifts = Object.values(person.days).map(parseCode).filter((c) => c.in);
          const site = shifts.length && shifts.filter((c) => c.site === "dsq").length * 2 > shifts.length ? "dsq" : "tower";
          store.addPorter(name);
          p = store.porterByName(name);
          store.updatePorter(p.id, { site });
          porters.push(p);
          added = true;
        } else if (!p.active) store.setPorterActive(p.id, true);
        if (!p.fullName && person.name.includes(" ")) store.updatePorter(p.id, { fullName: titleCase(person.name) });
        for (const [d, code] of Object.entries(person.days)) store.setRota(d, p.name, code);
        people.push({ rota: titleCase(person.name), name: p.name, added, days: person.days });
      }
      store.addUpload({ by: req.porter, dates: r.dates, images: names, warnings: r.warnings, site: "rota" });
      changed();
    });
    // jobs already given to people the rota now says are off
    const clashes = [];
    for (const d of r.dates) {
      const jobs = store.jobsOn(d);
      if (!jobs.length) continue;
      const ticks = store.ticksFor(jobs.map((j) => j.id));
      for (const e of planFor(d)) {
        const n = !e.in ? openTasks(jobs, ticks, e.name) : 0;
        if (n) clashes.push({ date: d, name: e.name, tasks: n, label: e.label });
      }
    }
    res.json({ ok: true, dates: r.dates, people, warnings: r.warnings, clashes });
  } catch (e) {
    console.error("Rota failed:", e);
    res.status(502).json({ error: e.message || "Could not read the rota." });
  } finally {
    extracting = false;
  }
});

/** Booked time off. */
app.post("/api/admin/away", adminOnly, (req, res) => {
  const p = store.porterByName(str(req.body?.name));
  const { from, to } = req.body || {};
  if (!p || !isDate(from) || !isDate(to || from)) return res.status(400).json({ error: "Pick a person and the dates" });
  const [a, b] = [from, to || from].sort();
  store.tx(() => { store.addAway(p.name, a, b, str(req.body?.note).slice(0, 80)); changed(); });
  res.json({ ok: true });
});
app.delete("/api/admin/away/:id", adminOnly, (req, res) => {
  store.tx(() => { store.deleteAway(Number(req.params.id)); changed(); });
  res.json({ ok: true });
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
  const b = req.body || {};
  const id = Number(req.params.id);
  store.tx(() => {
    if ("active" in b) store.setPorterActive(id, Boolean(b.active));
    store.updatePorter(id, { site: SITES[b.site] ? b.site : null, tasks: typeof b.tasks === "boolean" ? b.tasks : null });
    changed();
  });
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
