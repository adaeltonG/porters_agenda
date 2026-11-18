import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRows } from "./src/extract.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// `npm run mock`: no API key needed, uploads return a hand-typed copy of the 18/11 agenda.
if (process.argv.includes("--mock")) {
  process.env.EXTRACT_MOCK = "1";
  process.env.TEAM_PIN ||= "1234";
  console.log("MOCK MODE - uploads use src/mock-extraction.json, PIN is", process.env.TEAM_PIN);
}
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const IMG_DIR = path.join(DATA_DIR, "images");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const TEAM_PIN = (process.env.TEAM_PIN || "").trim();
const PORTERS = (process.env.PORTERS || "Tom,Jeet,Robinson,Pablo,Ricardo,Wilson")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SLOT_KEYS = ["setup", "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "reset"];

mkdirSync(IMG_DIR, { recursive: true });
if (!TEAM_PIN) console.warn("WARNING: TEAM_PIN is not set - anyone with the link can use the app.");

// ---------- state ----------

const emptyState = () => ({
  version: 1, uploadedAt: null, uploadedBy: null, jobs: [], ticks: {}, images: [], warnings: [],
});

let state = emptyState();
if (existsSync(STATE_FILE)) {
  try { state = { ...emptyState(), ...JSON.parse(await fs.readFile(STATE_FILE, "utf8")) }; }
  catch (e) { console.error("Could not read state file, starting empty:", e.message); }
}

let writing = Promise.resolve();
function save() {
  state.version += 1;
  const snapshot = JSON.stringify(state);
  writing = writing.then(async () => {
    const tmp = STATE_FILE + ".tmp";
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, STATE_FILE);
  }).catch((e) => console.error("Save failed:", e));
  return writing;
}

// ---------- normalising rows ----------

const str = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const blankish = (v) => (/^(n|-|n\/a|none|null)$/i.test(str(v)) ? "" : str(v));

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

function parsePorters(raw) {
  const text = str(raw);
  const out = [];
  for (const name of PORTERS) {
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

function makeJob(row, idCounts) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = cleanSlot(row[k] ?? row.slots?.[k]);
  const job = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(row.date)) ? str(row.date) : "",
    owner: ["Hospitality", "Movers", "Both"].includes(str(row.owner)) ? str(row.owner) : "Other",
    requestor: blankish(row.requestor),
    eventLead: blankish(row.eventLead),
    host: blankish(row.host),
    vendor: blankish(row.vendor),
    location: blankish(row.location),
    attendees: blankish(row.attendees),
    info: str(row.info),
    portersRaw: blankish(row.portersRaw ?? row.porters),
    links: {
      menu: Boolean(row.hasMenuLink ?? row.links?.menu),
      agenda: Boolean(row.hasAgendaLink ?? row.links?.agenda),
      floorPlan: Boolean(row.hasFloorPlanLink ?? row.links?.floorPlan),
    },
    slots,
  };
  job.porters = parsePorters(job.portersRaw);
  const base = crypto.createHash("sha1")
    .update([job.date, job.owner, job.host, job.location].join("|").toLowerCase())
    .digest("hex").slice(0, 10);
  if (idCounts) {
    const n = (idCounts[base] = (idCounts[base] || 0) + 1);
    job.id = n > 1 ? `${base}-${n}` : base;
  }
  return job;
}

// ---------- app ----------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(here, "public"), { maxAge: "5m" }));

function pinOk(given) {
  if (!TEAM_PIN) return true;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(TEAM_PIN).digest();
  return crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  if (!pinOk(req.get("x-team-pin"))) return res.status(401).json({ error: "Wrong PIN" });
  req.porter = str(decodeURIComponent(req.get("x-porter-name") || "")).slice(0, 40) || "Someone";
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({ porters: PORTERS, pinRequired: Boolean(TEAM_PIN) });
});

app.post("/api/login", (req, res) => {
  if (!pinOk(req.body?.pin)) return res.status(401).json({ error: "Wrong PIN" });
  res.json({ ok: true });
});

app.get("/api/state", auth, (req, res) => {
  res.set("Cache-Control", "no-store");
  if (Number(req.query.since) === state.version) return res.json({ unchanged: true, version: state.version });
  res.json(state);
});

app.get("/api/images/:name", auth, (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(name) || !state.images.includes(name)) return res.sendStatus(404);
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(IMG_DIR, name));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

let extracting = false;

app.post("/api/upload", auth, upload.array("images", 6), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Please choose at least one screenshot." });
  if (extracting) return res.status(409).json({ error: "Someone else is uploading right now. Try again in a minute." });
  const mode = req.body.mode === "append" ? "append" : "replace";

  extracting = true;
  try {
    const result = await extractRows(files);
    // IDs come from the row's content, so a re-posted or overlapping screenshot
    // maps onto the same jobs (and keeps their ticks) instead of duplicating them.
    const idCounts = {};
    const fresh = result.rows.map((r) => makeJob(r, idCounts));

    const names = [];
    for (const [i, f] of files.entries()) {
      const ext = f.mimetype === "image/png" ? "png" : f.mimetype === "image/webp" ? "webp" : "jpg";
      const name = `${Date.now()}-${i}.${ext}`;
      await fs.writeFile(path.join(IMG_DIR, name), f.buffer);
      names.push(name);
    }

    let jobs;
    if (mode === "append") {
      const byId = new Map(state.jobs.map((j) => [j.id, j]));
      for (const j of fresh) byId.set(j.id, j);
      jobs = [...byId.values()];
    } else {
      jobs = fresh;
      for (const old of state.images) fs.rm(path.join(IMG_DIR, old), { force: true }).catch(() => {});
    }

    // Keep ticks for jobs that are still on the agenda (e.g. the boss re-posted a corrected screenshot).
    const ids = new Set(jobs.map((j) => j.id));
    const ticks = {};
    for (const [id, t] of Object.entries(state.ticks)) if (ids.has(id)) ticks[id] = t;

    state = {
      ...state,
      jobs,
      ticks,
      images: mode === "append" ? [...state.images, ...names] : names,
      warnings: (mode === "append" ? state.warnings : []).concat(result.warnings || []),
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.porter,
    };
    await save();
    res.json({ ok: true, count: fresh.length, warnings: result.warnings || [] });
  } catch (e) {
    console.error("Extraction failed:", e);
    res.status(502).json({ error: e.message || "Could not read the screenshot." });
  } finally {
    extracting = false;
  }
});

app.post("/api/tick", auth, async (req, res) => {
  const { jobId, task, done } = req.body || {};
  if (!state.jobs.some((j) => j.id === jobId)) return res.status(404).json({ error: "Job not found" });
  if (![...SLOT_KEYS, "done"].includes(task)) return res.status(400).json({ error: "Unknown task" });
  const t = (state.ticks[jobId] ||= {});
  if (done) t[task] = { by: req.porter, at: new Date().toISOString() };
  else delete t[task];
  await save();
  res.json({ ok: true, version: state.version, ticks: state.ticks[jobId] });
});

app.post("/api/jobs", auth, async (req, res) => {
  const job = makeJob(req.body || {});
  job.id = "m" + crypto.randomBytes(5).toString("hex");
  state.jobs.push(job);
  await save();
  res.json({ ok: true, job });
});

app.put("/api/jobs/:id", auth, async (req, res) => {
  const i = state.jobs.findIndex((j) => j.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Job not found" });
  const job = makeJob(req.body || {});
  job.id = state.jobs[i].id;
  state.jobs[i] = job;
  await save();
  res.json({ ok: true, job });
});

app.delete("/api/jobs/:id", auth, async (req, res) => {
  const before = state.jobs.length;
  state.jobs = state.jobs.filter((j) => j.id !== req.params.id);
  delete state.ticks[req.params.id];
  if (state.jobs.length === before) return res.status(404).json({ error: "Job not found" });
  await save();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "That image is too big (max 12 MB)."
      : err.code === "LIMIT_FILE_COUNT" ? "Up to 6 screenshots at a time." : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log(`Porters agenda on http://localhost:${PORT}`));
