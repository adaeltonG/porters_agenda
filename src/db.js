// SQLite database (one file: data/porters.db). Uses Node's built-in node:sqlite, so there is
// no database server to run. Keeps every day's agenda, ticks and uploads for the history.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "porters.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS porters (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_date ON jobs(date);
    CREATE TABLE IF NOT EXISTS ticks (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      task TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (job_id, task)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, by TEXT NOT NULL,
      dates TEXT NOT NULL, images TEXT NOT NULL, warnings TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, porter TEXT NOT NULL, sub TEXT NOT NULL, created_at TEXT NOT NULL
    );
    -- the weekly rota: one code per person per day ("AM", "PM DSQ", "PTO", "SIC", "OFF")
    CREATE TABLE IF NOT EXISTS rota (
      date TEXT NOT NULL, porter TEXT NOT NULL COLLATE NOCASE, code TEXT NOT NULL,
      PRIMARY KEY (date, porter)
    );
    -- the admin marking someone off (1) or back in (0) for one day
    CREATE TABLE IF NOT EXISTS day_off (
      date TEXT NOT NULL, porter TEXT NOT NULL COLLATE NOCASE, off INTEGER NOT NULL,
      PRIMARY KEY (date, porter)
    );
    -- lunch breaks: one per person per day; manual = set by the admin, never moved automatically
    CREATE TABLE IF NOT EXISTS lunch (
      date TEXT NOT NULL, porter TEXT NOT NULL COLLATE NOCASE, start TEXT NOT NULL, manual INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, porter)
    );
    -- booked time off (holidays)
    CREATE TABLE IF NOT EXISTS away (
      id INTEGER PRIMARY KEY, porter TEXT NOT NULL COLLATE NOCASE, date_from TEXT NOT NULL, date_to TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
    );
  `);
  // columns added after the first release
  const addColumn = (table, sql) => {
    const name = sql.split(" ")[0];
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
  };
  addColumn("porters", "site TEXT NOT NULL DEFAULT 'tower'");   // home building: tower / dsq
  addColumn("porters", "tasks INTEGER NOT NULL DEFAULT 1");     // 0 = never given tasks automatically
  addColumn("porters", "full_name TEXT NOT NULL DEFAULT ''");   // as written on the rota
  addColumn("uploads", "site TEXT NOT NULL DEFAULT 'tower'");   // tower / dsq / rota
  return new Store(db);
}

const now = () => new Date().toISOString();

class Store {
  constructor(db) {
    this.db = db;
    this.version = Number(this.getMeta("version") || 1);
  }

  tx(fn) {
    if (this.inTx) return fn(); // already inside one: just join it
    this.db.exec("BEGIN");
    this.inTx = true;
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    finally { this.inTx = false; }
  }

  /** Every change bumps the version so phones/dashboards know to reload. */
  bump() {
    this.version += 1;
    this.setMeta("version", String(this.version));
    return this.version;
  }

  getMeta(key) { return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); }
  metaLike(prefix) { return this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(prefix + "%"); }
  deleteMeta(key) { this.db.prepare("DELETE FROM meta WHERE key = ?").run(key); }

  // ---------- porters ----------
  porters({ all = false } = {}) {
    return this.db.prepare(`SELECT id, name, active, site, tasks, full_name FROM porters ${all ? "" : "WHERE active = 1"} ORDER BY sort, id`).all()
      .map(({ full_name, ...r }) => ({ ...r, active: Boolean(r.active), tasks: Boolean(r.tasks), fullName: full_name || "" }));
  }
  porterNames() { return this.porters().map((p) => p.name); }
  addPorter(name) {
    const existing = this.db.prepare("SELECT id FROM porters WHERE name = ?").get(name);
    if (existing) { this.db.prepare("UPDATE porters SET active = 1 WHERE id = ?").run(existing.id); return; }
    const sort = this.db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM porters").get().s;
    this.db.prepare("INSERT INTO porters (name, sort) VALUES (?, ?)").run(name, sort);
  }
  setPorterActive(id, active) { this.db.prepare("UPDATE porters SET active = ? WHERE id = ?").run(active ? 1 : 0, id); }
  /** fields: { site, tasks, fullName } (any of them) */
  updatePorter(id, fields) {
    if (fields.site != null) this.db.prepare("UPDATE porters SET site = ? WHERE id = ?").run(fields.site, id);
    if (fields.tasks != null) this.db.prepare("UPDATE porters SET tasks = ? WHERE id = ?").run(fields.tasks ? 1 : 0, id);
    if (fields.fullName != null) this.db.prepare("UPDATE porters SET full_name = ? WHERE id = ?").run(fields.fullName, id);
  }
  porterByName(name) { return this.porters({ all: true }).find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || null; }

  // ---------- rota, days off, holidays ----------
  rotaBetween(from, to) { return this.db.prepare("SELECT date, porter, code FROM rota WHERE date >= ? AND date <= ? ORDER BY date").all(from, to); }
  setRota(date, porter, code) {
    if (!code) return this.db.prepare("DELETE FROM rota WHERE date = ? AND porter = ?").run(date, porter);
    this.db.prepare("INSERT INTO rota (date, porter, code) VALUES (?, ?, ?) ON CONFLICT(date, porter) DO UPDATE SET code = excluded.code").run(date, porter, code);
  }
  dayOffs(from, to = from) { return this.db.prepare("SELECT date, porter, off FROM day_off WHERE date >= ? AND date <= ?").all(from, to).map((r) => ({ ...r, off: Boolean(r.off) })); }
  setDayOff(date, porter, off) {
    if (off == null) return this.db.prepare("DELETE FROM day_off WHERE date = ? AND porter = ?").run(date, porter);
    this.db.prepare("INSERT INTO day_off (date, porter, off) VALUES (?, ?, ?) ON CONFLICT(date, porter) DO UPDATE SET off = excluded.off").run(date, porter, off ? 1 : 0);
  }
  lunches(date) { return this.db.prepare("SELECT porter, start, manual FROM lunch WHERE date = ?").all(date).map((r) => ({ ...r, manual: Boolean(r.manual) })); }
  setLunch(date, porter, start, manual) {
    this.db.prepare("INSERT INTO lunch (date, porter, start, manual) VALUES (?, ?, ?, ?) ON CONFLICT(date, porter) DO UPDATE SET start = excluded.start, manual = excluded.manual")
      .run(date, porter, start, manual ? 1 : 0);
  }
  deleteLunch(date, porter) { this.db.prepare("DELETE FROM lunch WHERE date = ? AND porter = ?").run(date, porter); }
  awayList(from = "0000-00-00") { return this.db.prepare("SELECT id, porter, date_from AS start, date_to AS end, note FROM away WHERE date_to >= ? ORDER BY date_from, porter").all(from); }
  awayOverlapping(from, to) { return this.db.prepare("SELECT id, porter, date_from AS start, date_to AS end, note FROM away WHERE date_from <= ? AND date_to >= ?").all(to, from); }
  addAway(porter, start, end, note = "") { this.db.prepare("INSERT INTO away (porter, date_from, date_to, note) VALUES (?, ?, ?, ?)").run(porter, start, end, note); }
  deleteAway(id) { return this.db.prepare("DELETE FROM away WHERE id = ?").run(id).changes > 0; }
  renamePorter(id, name) { this.db.prepare("UPDATE porters SET name = ? WHERE id = ?").run(name, id); }

  // ---------- hosts ----------
  hosts() { return this.db.prepare("SELECT id, name FROM hosts ORDER BY name COLLATE NOCASE").all(); }
  addHost(name) { this.db.prepare("INSERT OR IGNORE INTO hosts (name, created_at) VALUES (?, ?)").run(name, now()); }
  deleteHost(id) { this.db.prepare("DELETE FROM hosts WHERE id = ?").run(id); }
  renameHost(id, name) { this.db.prepare("UPDATE hosts SET name = ? WHERE id = ?").run(name, id); }

  /** Host names used in agendas that aren't on the list yet (with how often / last date). */
  unlistedHosts() {
    const known = new Set(this.hosts().map((h) => h.name.toLowerCase()));
    const seen = new Map();
    for (const r of this.db.prepare("SELECT date, data FROM jobs ORDER BY date").iterate()) {
      for (const h of JSON.parse(r.data).hosts || []) {
        if (!h || known.has(h.toLowerCase())) continue;
        const k = h.toLowerCase();
        const e = seen.get(k) || { name: h, count: 0, last: "" };
        e.count++; e.last = r.date;
        seen.set(k, e);
      }
    }
    return [...seen.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name));
  }

  // ---------- jobs ----------
  jobsBetween(from, to) {
    return this.db.prepare("SELECT data FROM jobs WHERE date >= ? AND date <= ? ORDER BY date, created_at, id").all(from, to)
      .map((r) => JSON.parse(r.data));
  }
  jobsOn(date) { return this.jobsBetween(date, date); }
  job(id) { const r = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id); return r ? JSON.parse(r.data) : null; }
  saveJob(job) {
    const t = now();
    this.db.prepare(`INSERT INTO jobs (id, date, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data, updated_at = excluded.updated_at`)
      .run(job.id, job.date || "", JSON.stringify(job), t, t);
  }
  deleteJob(id) { return this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0; }
  /** Latest day that has jobs, on or before the given day. */
  lastDayWithJobs(onOrBefore) {
    return this.db.prepare("SELECT MAX(date) AS d FROM jobs WHERE date <= ? AND date != ''").get(onOrBefore)?.d || null;
  }

  // ---------- ticks ----------
  ticksFor(jobIds) {
    const out = {};
    if (!jobIds.length) return out;
    const rows = this.db.prepare(`SELECT job_id, task, by, at FROM ticks WHERE job_id IN (${jobIds.map(() => "?").join(",")})`).all(...jobIds);
    for (const r of rows) (out[r.job_id] ||= {})[r.task] = { by: r.by, at: r.at };
    return out;
  }
  setTick(jobId, task, by) {
    this.db.prepare("INSERT INTO ticks (job_id, task, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, task) DO UPDATE SET by = excluded.by, at = excluded.at")
      .run(jobId, task, by, now());
  }
  clearTick(jobId, task) { this.db.prepare("DELETE FROM ticks WHERE job_id = ? AND task = ?").run(jobId, task); }

  // ---------- uploads ----------
  addUpload({ by, dates, images, warnings, site = "tower" }) {
    this.db.prepare("INSERT INTO uploads (at, by, dates, images, warnings, site) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now(), by, JSON.stringify(dates), JSON.stringify(images), JSON.stringify(warnings), site);
  }
  /** The most recent upload that covered this day (of one building's agenda, or the rota). */
  uploadFor(date, site = "tower") {
    const r = this.db.prepare("SELECT at, by, images, warnings, site FROM uploads WHERE site = ? AND EXISTS (SELECT 1 FROM json_each(uploads.dates) WHERE value = ?) ORDER BY id DESC LIMIT 1").get(site, date);
    return r ? { at: r.at, by: r.by, images: JSON.parse(r.images), warnings: JSON.parse(r.warnings), site: r.site } : null;
  }
  imageKnown(name) {
    return Boolean(this.db.prepare("SELECT 1 FROM uploads, json_each(uploads.images) WHERE json_each.value = ? LIMIT 1").get(name));
  }

  // ---------- history ----------
  daySummaries(limit = 120) {
    const days = this.db.prepare("SELECT date, COUNT(*) AS jobs FROM jobs WHERE date != '' GROUP BY date ORDER BY date DESC LIMIT ?").all(limit);
    return days.map((d) => {
      const jobs = this.jobsOn(d.date);
      const ticks = this.ticksFor(jobs.map((j) => j.id));
      let total = 0, done = 0, unassigned = 0;
      for (const j of jobs) {
        const tasks = Object.entries(j.slots || {}).filter(([, s]) => s.needed).map(([k]) => k);
        if (!tasks.length) tasks.push("done");
        total += tasks.length;
        done += tasks.filter((t) => ticks[j.id]?.[t]).length;
        if (!j.everyone && !j.porters?.length) unassigned++;
      }
      return { date: d.date, jobs: d.jobs, tasks: total, done, unassigned };
    });
  }

  // ---------- push subscriptions ----------
  saveSub(porter, sub) {
    this.db.prepare(`INSERT INTO push_subs (endpoint, porter, sub, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET porter = excluded.porter, sub = excluded.sub`)
      .run(sub.endpoint, porter, JSON.stringify(sub), now());
  }
  deleteSub(endpoint) { this.db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint); }
  subsFor(porters) {
    if (!porters.length) return [];
    return this.db.prepare(`SELECT endpoint, porter, sub FROM push_subs WHERE porter COLLATE NOCASE IN (${porters.map(() => "?").join(",")})`).all(...porters)
      .map((r) => ({ porter: r.porter, sub: JSON.parse(r.sub) }));
  }
  subCounts() {
    return Object.fromEntries(this.db.prepare("SELECT porter, COUNT(*) AS n FROM push_subs GROUP BY porter").all().map((r) => [r.porter, r.n]));
  }
}

/** One-off: bring the old data/state.json (pre-database) into the database. */
export function importOldState(store, dataDir, normaliseJob) {
  const file = path.join(dataDir, "state.json");
  if (!fs.existsSync(file) || store.getMeta("imported_state_json")) return;
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    store.tx(() => {
      for (const j of old.jobs || []) store.saveJob(normaliseJob(j));
      for (const [jobId, tasks] of Object.entries(old.ticks || {})) {
        for (const [task, t] of Object.entries(tasks)) {
          if (store.job(jobId)) store.db.prepare("INSERT OR REPLACE INTO ticks (job_id, task, by, at) VALUES (?, ?, ?, ?)").run(jobId, task, t.by, t.at);
        }
      }
      const dates = [...new Set((old.jobs || []).map((j) => j.date).filter(Boolean))];
      if (old.uploadedAt && dates.length) {
        store.db.prepare("INSERT INTO uploads (at, by, dates, images, warnings) VALUES (?, ?, ?, ?, ?)")
          .run(old.uploadedAt, old.uploadedBy || "Someone", JSON.stringify(dates), JSON.stringify(old.images || []), JSON.stringify(old.warnings || []));
      }
      store.setMeta("imported_state_json", new Date().toISOString());
    });
    fs.renameSync(file, file + ".imported");
    console.log(`Imported ${old.jobs?.length || 0} jobs from state.json`);
  } catch (e) {
    console.error("Could not import state.json:", e.message);
  }
}
