// Porters Agenda - admin dashboard
import { multiPicker } from "./picker.js?v=4";
import { ask, askText } from "./ask.js?v=1";
import { timeInputHTML, wireTimeInputs } from "./timeinput.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (id) => `<svg class="i"><use href="#i-${id}"/></svg>`;
const store = {
  get(k, d) { try { const v = localStorage.getItem("pa." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pa." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem("pa." + k); } catch { /* ignore */ } },
};

const SLOTS = [
  { key: "setup", label: "Setup" },
  { key: "teaCoffee", label: "Tea/coffee/water" },
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "afternoon", label: "Afternoon catering" },
  { key: "clearUp", label: "Clear up" },
  { key: "reset", label: "Reset" },
];
const SHORT = { setup: "Setup", teaCoffee: "Tea/coffee", breakfast: "Breakfast", lunch: "Lunch", afternoon: "Afternoon", clearUp: "Clear up", reset: "Reset", done: "Done" };

let adminPin = store.get("adminPin", "");
let adminUser = store.get("adminUser", "");
let tab = "agenda";
let siteFilter = store.get("siteFilter", "");   // "" = both buildings
const SITES = { tower: "The Tower", dsq: "DSQ" };
const TABS = ["agenda", "rota", "history", "hosts", "porters"];
let date = null;
let day = null;              // { jobs, ticks, upload, porters, hosts, newHosts, today, version }
let deferred = false;        // a refresh arrived while a dropdown was open
const pickers = new Map();   // jobId -> porter picker in the table

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const shiftDay = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDay = (iso, opts = { weekday: "long", day: "numeric", month: "long", year: "numeric" }) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", opts);
const fmtClock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const toMin = (t) => (/^\d{2}:\d{2}$/.test(t || "") ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

function tasksOf(job) {
  const t = SLOTS.filter((s) => job.slots?.[s.key]?.needed).map((s) => ({ key: s.key, ...job.slots[s.key] }));
  if (!t.length) t.push({ key: "done", time: "", note: "" });
  return t;
}
function times(job) {
  const m = tasksOf(job).map((t) => toMin(t.time)).filter((x) => x != null);
  return m.length ? [Math.min(...m), Math.max(...m)] : [null, null];
}
const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const unassigned = (job) => !job.everyone && !job.porters?.length;

async function api(path, opts = {}) {
  const headers = { "x-admin-pin": adminPin, "x-admin-user": encodeURIComponent(adminUser), ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  const res = await fetch(path, { ...opts, headers, body });
  if (res.status === 401) { showLogin("Please log in again."); throw new Error("Not logged in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function setSync(ok) {
  $("#syncDot").className = "dot " + (ok ? "ok" : "bad");
  $("#syncText").textContent = ok ? "Live" : "Offline – retrying";
}

// ---------- sheet (dialog) ----------
const sheet = $("#sheet");
function openSheet(title, html, wide = false) {
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  $("#sheetBody").scrollTop = 0;
  sheet.classList.toggle("wide", wide);
  if (!sheet.open) sheet.showModal();
}
const closeSheet = () => { if (sheet.open) sheet.close(); };
sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("[data-close]")) closeSheet(); });
sheet.addEventListener("close", () => { $("#sheetBody").innerHTML = ""; sheet.dataset.kind = ""; });

// ---------- agenda ----------
async function loadDay(force) {
  try {
    const d = await api(`api/admin/day?date=${date}&since=${force ? 0 : day?.version || 0}&known=${day?.date || ""}`);
    setSync(true);
    if (d.unchanged) return;
    day = d;
    // A background update waits while a porter dropdown is open, so it doesn't wipe a pick
    // in progress. After the admin's own action (delete, edit, tick...) redraw straight away.
    if (!force && pickerOpen()) { deferred = true; return; }
    renderAgenda();
  } catch (e) {
    if (e.message !== "Not logged in") setSync(false);
  }
}

function renderAgenda() {
  deferred = false;
  if (!day) return;
  $("#dateIn").value = date;
  const isToday = date === day.today;
  $("#todayBtn").classList.toggle("on", isToday);
  $("#todayBtn").title = isToday ? "You're looking at today" : "Go to today";
  document.title = `${fmtDay(date, { weekday: "short", day: "numeric", month: "short" })} · Porters Admin`;
  $("#shotBtn").hidden = !day.upload?.images?.length;

  for (const b of document.querySelectorAll("#siteSeg [data-site]")) b.setAttribute("aria-pressed", b.dataset.site === siteFilter);
  const jobs = day.jobs.filter((j) => !siteFilter || (j.site || "tower") === siteFilter).map((j) => ({ j, t: times(j) }))
    .sort((a, b) => (a.t[0] ?? 1e9) - (b.t[0] ?? 1e9) || (a.t[1] ?? 1e9) - (b.t[1] ?? 1e9))
    .map((x) => x.j);

  // stats
  let total = 0, done = 0;
  for (const j of jobs) for (const t of tasksOf(j)) { total++; if (day.ticks[j.id]?.[t.key]) done++; }
  const open = jobs.filter(unassigned).length;
  $("#stats").innerHTML = jobs.length ? `
    <span><b>${jobs.length}</b> jobs</span>
    <span><b>${done}/${total}</b> tasks done</span><span class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></span>
    ${open ? `<span style="color:var(--soon)"><b style="color:inherit">${open}</b> without porters</span>` : ""}
    ${uploadedHTML()}` : "";
  $("#who").innerHTML = whoHTML();

  // notices
  let notices = "";
  const stranded = (day.plan || []).filter((e) => !e.works).map((e) => ({ name: e.name, label: e.label, n: openTasks(e.name) })).filter((x) => x.n);
  if (stranded.length && date >= day.today) {
    notices += `<div class="notice off"><span><b>Off but still on jobs:</b> ${stranded.map((x) => `${esc(x.name)} (${esc(x.label)}, ${x.n} task${x.n > 1 ? "s" : ""})`).join(", ")}</span>
      <button class="btn small" data-act="move" data-names="${esc(JSON.stringify(stranded.map((x) => x.name)))}">${icon("shuffle")}Give them to others</button></div>`;
  }
  if (open && date >= day.today) {
    notices += `<div class="notice"><span><b>${open} job${open > 1 ? "s have" : " has"} no porters.</b> They can be shared out fairly in one go.</span>
      <button class="btn small" data-act="auto">${icon("shuffle")}Assign automatically</button></div>`;
  }
  if (day.newHosts?.length) {
    notices += `<div class="notice"><span><b>${day.newHosts.length} host${day.newHosts.length > 1 ? "s" : ""} not on your list:</b> ${day.newHosts.map(esc).join(", ")}</span>
      <button class="btn small" data-act="add-day-hosts">Add to host list</button></div>`;
  }
  if (day.upload?.warnings?.length) {
    notices += `<div class="notice"><span><b>From the upload:</b> ${day.upload.warnings.map(esc).join(" · ")}</span></div>`;
  }
  $("#notices").innerHTML = notices;

  // table
  for (const p of pickers.values()) p.close();
  pickers.clear();
  const tbody = $("#rows");
  if (!jobs.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No ${siteFilter ? SITES[siteFilter] + " " : ""}jobs on this day. ${date >= day.today ? "Upload the agenda or add a job." : ""}</td></tr>`;
    return;
  }
  const now = nowMin();
  tbody.innerHTML = jobs.map((j) => {
    const tasks = tasksOf(j);
    const ticks = day.ticks[j.id] || {};
    const nDone = tasks.filter((t) => ticks[t.key]).length;
    const cls = nDone === tasks.length ? "done" : unassigned(j) ? "need" : nDone ? "part" : "";
    const [s, e] = times(j);
    return `<tr class="${cls}" data-owner="${esc(j.owner)}" data-id="${esc(j.id)}">
      <td class="tm">${s == null ? "–" : s === e ? fmtMin(s) : `${fmtMin(s)}<br><span style="color:var(--muted);font-weight:600">– ${fmtMin(e)}</span>`}</td>
      <td class="loc">${j.task ? `<b class="task-name">${esc(j.task)}</b><br>` : ""}${esc(j.location || (j.task ? "" : "–"))}<span class="own">${j.site === "dsq" ? `<span class="site-tag">DSQ</span> ` : ""}${esc(j.owner === "Other" ? "" : j.owner)}${j.vendor ? ` · ${esc(j.vendor)}` : ""}</span>
        <div class="row-acts">
          <button class="btn small" data-act="edit" data-job="${esc(j.id)}">${icon("edit")}Edit</button>
          <button class="btn small danger" data-act="delete" data-job="${esc(j.id)}">${icon("trash")}Delete</button>
        </div></td>
      <td>${esc((j.hosts || []).join(", ") || j.host || "–")}</td>
      <td>${esc(j.attendees || "")}</td>
      <td><div class="tasks-cell">${tasks.map((t) => {
        const tk = ticks[t.key];
        const late = !tk && isToday && t.time && toMin(t.time) < now - 10;
        const title = tk ? `Ticked by ${tk.by} at ${fmtClock(tk.at)}` : `${SHORT[t.key]}${t.time ? " at " + t.time : ""}${t.note ? " – " + t.note : ""}. Click to tick.`;
        return `<button class="tk${tk ? " on" : ""}${late ? " late" : ""}" data-act="tick" data-job="${esc(j.id)}" data-task="${t.key}" title="${esc(title)}">
          <span class="bx">${icon("check")}</span>${t.time ? `${esc(t.time)} ` : ""}${SHORT[t.key]}${tk ? ` <small>${esc(tk.by)} ${fmtClock(tk.at)}</small>` : ""}</button>`;
      }).join("")}</div></td>
      <td class="porters-cell"><div class="pp" data-job="${esc(j.id)}"></div>${whoDoesWhat(j)}${porterWarnings(j)}${j.porterSource === "auto" ? `<div class="raw auto">${icon("shuffle")}Assigned automatically</div>` : ""}${j.portersRaw ? `<div class="raw">Sheet: ${esc(j.portersRaw)}</div>` : ""}</td>
      <td class="nt"><div>${esc(j.info || "")}</div></td>
    </tr>`;
  }).join("");

  // porter dropdowns: saved as soon as they change
  for (const el of tbody.querySelectorAll(".pp")) {
    const job = day.jobs.find((x) => x.id === el.dataset.job);
    let timer;
    const pk = multiPicker(el, {
      options: day.porters, selected: (job.porters || []).map((p) => p.name), everyone: true, everyoneOn: job.everyone,
      placeholder: "Assign porters", label: `Porters for ${job.task || job.location || job.host}`,
      onChange: (v) => {
        clearTimeout(timer);
        timer = setTimeout(() => savePorters(job.id, v), 700);
      },
      onClose: () => setTimeout(flushDeferred),
    });
    pickers.set(job.id, pk);
  }
}

const ROLE_SLOT = { TCW: "teaCoffee", TC: "teaCoffee", T: "teaCoffee", B: "breakfast", L: "lunch", A: "afternoon", PM: "afternoon", S: "setup", SU: "setup", C: "clearUp", CU: "clearUp", R: "reset" };

/** "Davina: Tea/coffee · Pablo: Lunch, Clear up" when a job is split between people. */
function whoDoesWhat(job) {
  if (job.everyone || !job.porters?.some((p) => p.roles?.length)) return "";
  return `<div class="raw roles">${job.porters.map((p) => `<span><b>${esc(p.name)}:</b> ${p.roles?.length ? esc(p.roles.map((r) => SHORT[ROLE_SLOT[r]] || r).join(", ")) : "the rest"}</span>`).join("")}</div>`;
}

// ---------- who's in ----------
const roleKeys = (p) => (p.roles || []).map((r) => ROLE_SLOT[String(r).toUpperCase()]).filter(Boolean);
/** The tasks a porter on a job holds: the ones their roles name, or all of them. */
function heldTasks(job, p) {
  const all = tasksOf(job);
  const keys = roleKeys(p);
  const mine = keys.length ? all.filter((t) => keys.includes(t.key)) : [];
  return mine.length ? mine : all;
}
/** Tasks someone still has to do on this day (both buildings). */
function openTasks(name) {
  let n = 0;
  for (const j of day.jobs) {
    if (j.everyone) continue;
    const p = (j.porters || []).find((x) => x.name === name);
    if (p) n += heldTasks(j, p).filter((t) => !day.ticks[j.id]?.[t.key]).length;
  }
  return n;
}
const planOf = (name) => (day.plan || []).find((e) => e.name === name);
const shiftWord = (e) => (/^(AM|PM)/.test(e.label || "") ? e.label.slice(0, 2) : "");

/** "Uploaded by Jeet at 09:13" (one per building when both have an agenda that day). */
function uploadedHTML() {
  const ups = day.upload?.sites || [];
  if (ups.length === 1) return `<span>Uploaded by ${esc(ups[0].by)} at ${fmtClock(ups[0].at)}</span>`;
  return ups.map((u) => `<span>${esc(SITES[u.site] || u.site)}: uploaded by ${esc(u.by)} at ${fmtClock(u.at)}</span>`).join("");
}

/**
 * Who's in that day, building by building, with how many tasks each has; then who's off.
 * Clicking a name marks them off for the day (or back in).
 */
function whoHTML() {
  const plan = day.plan || [];
  if (!plan.length) return "";
  const chip = (e) => {
    const n = day.loads?.[e.name]?.tasks || 0;
    const sub = e.in ? shiftWord(e) : e.label;
    const tip = e.in
      ? `${e.name}: working ${e.from ? `${e.from}–${e.to}` : "all day"}${e.why === "marked" ? " (marked in by hand)" : ""} · ${n} task${n === 1 ? "" : "s"}. Click if they're off.`
      : e.works ? `${e.name}: at work (${e.label}), never given tasks. Click if they're off.`
      : `${e.name}: ${e.label}${e.why === "marked" ? " (marked off by hand)" : ""}. Click if they're working after all.`;
    return `<button class="wchip ${e.works ? "w-in" : "w-off"}${e.why === "marked" ? " marked" : ""}" data-act="who" data-name="${esc(e.name)}" data-in="${e.works ? 1 : 0}" title="${esc(tip)}">${esc(e.name)}${sub ? `<small>${esc(sub)}</small>` : ""}${e.in || n ? `<b>${n}</b>` : ""}</button>`;
  };
  const groups = Object.entries(SITES)
    .filter(([k]) => !siteFilter || k === siteFilter)
    .map(([k, label]) => [label, plan.filter((e) => e.works && e.site === k)])
    .filter(([, list]) => list.length)
    .map(([label, list]) => `<div class="who-grp"><span class="g">${esc(label)}</span>${list.map(chip).join("")}</div>`);
  const off = plan.filter((e) => !e.works);
  if (off.length) groups.push(`<div class="who-grp offs">${off.map(chip).join("")}</div>`);
  return `<div class="a-who-head"><b>Who's in</b><span>tasks each · click a name if someone is off</span></div>${groups.join("")}`;
}

/** Problems with who's on a job: someone off that day, in the other building, or outside their shift. */
function porterWarnings(j) {
  if (j.everyone || !j.porters?.length) return "";
  const out = [];
  for (const p of j.porters) {
    const e = planOf(p.name);
    if (!e) continue;
    if (!e.in) { out.push(e.works ? `${p.name} doesn't get tasks (${e.label})` : `${p.name} is off (${e.label})`); continue; }
    if (e.site && e.site !== (j.site || "tower")) { out.push(`${p.name} is at ${SITES[e.site]} that day`); continue; }
    if (e.from && heldTasks(j, p).some((t) => t.time && (toMin(t.time) < toMin(e.from) || toMin(t.time) >= toMin(e.to)))) out.push(`${p.name} works ${e.from}–${e.to}`);
  }
  if (j.porterSource === "auto" && j.porters.every((p) => roleKeys(p).length)) {
    const held = new Set(j.porters.flatMap(roleKeys));
    const miss = tasksOf(j).filter((t) => !held.has(t.key));
    if (miss.length) out.push(`Nobody on shift for: ${miss.map((t) => SHORT[t.key]).join(", ")}`);
  }
  return out.length ? `<div class="raw warnline">${out.map(esc).join("<br>")}</div>` : "";
}

async function toggleWho(name, isIn) {
  try {
    const r = await api("api/admin/dayoff", { method: "POST", body: { date, name, off: isIn } });
    await loadDay(true);
    if (!isIn) return toast(`${name} is working that day`);
    if (r.tasks && date >= day.today && await ask({
      title: `${name} is off. Move their ${r.tasks} task${r.tasks > 1 ? "s" : ""}?`,
      text: "They go to the people working in the same building. Anything already ticked stays as it is.",
      ok: "Move them",
    })) return moveJobs([name]);
    toast(`${name} marked off for the day`);
  } catch (e) { toast(e.message); }
}

async function moveJobs(names) {
  try {
    const r = await api("api/admin/move", { method: "POST", body: { date, names } });
    await loadDay(true);
    toast(r.moved ? `Moved ${r.moved} job${r.moved > 1 ? "s" : ""}${r.left ? ` – ${r.left} still need${r.left > 1 ? "" : "s"} someone` : ""}` : "Nothing to move");
  } catch (e) { toast(e.message); }
}

/** For the Auto-assign box: who's working where. */
function planSummaryHTML() {
  const plan = day.plan || [];
  const line = (label, list, sub) => (list.length ? `<li><b>${esc(label)}:</b> ${list.map((e) => `${esc(e.name)}${sub(e) ? ` <small>${esc(sub(e))}</small>` : ""}`).join(", ")}</li>` : "");
  return `<ul class="plan-sum">${Object.entries(SITES).map(([k, l]) => line(l, plan.filter((e) => e.works && e.site === k), (e) => (e.in ? shiftWord(e) : `${e.label}, no tasks`))).join("")}${line("Off", plan.filter((e) => !e.works), (e) => e.label)}</ul>`;
}

/** Upload form: which building the agenda is for, and anyone off that the rota doesn't know about. */
function uploadPeopleHTML(site) {
  const names = day?.porters || [];
  return `<div class="f" style="margin-top:12px">Which building is this agenda for?</div>
    <div class="who-list">${Object.entries(SITES).map(([k, l]) => `<label><input type="radio" name="site" value="${k}"${(site || "tower") === k ? " checked" : ""}>${esc(l)}</label>`).join("")}</div>
    ${names.length ? `<div class="f">Anyone off that day? <span style="font-weight:500">Tap them. The rota and booked holidays already count.</span></div>
    <div class="who-list off-pick">${names.map((n) => `<label><input type="checkbox" name="off" value="${esc(n)}">${esc(n)}</label>`).join("")}</div>` : ""}`;
}


// ---------- automatic porters ----------
function showAuto() {
  if (!day) return;
  const autoJobs = day.jobs.filter((j) => j.porterSource === "auto" && !day.ticks[j.id]).length;
  const open = day.jobs.filter(unassigned).length;
  sheet.dataset.kind = "auto";
  openSheet("Assign porters automatically", `<form id="autoForm">
    <p class="a-sub" style="margin-top:12px">Working on <b>${esc(fmtDay(date, { weekday: "long", day: "numeric", month: "long" }))}</b> (from the rota):</p>
    ${planSummaryHTML()}
    <p class="hint" style="margin:0 0 10px">Someone off? Close this and tap their name in <b>Who's in</b> first.</p>
    <label class="choice"><input type="radio" name="mode" value="fill" checked><span><b>Jobs without porters${open ? ` (${open})` : ""}</b><small>Porters from the sheet, or ones you picked, stay as they are.</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="redo"${autoJobs ? "" : " disabled"}><span><b>Shuffle the automatic picks again${autoJobs ? ` (${autoJobs})` : ""}</b><small>Also re-does jobs that were assigned automatically and haven't been ticked yet.</small></span></label>
    <details class="rules"><summary>How it picks</summary><ul>${(day.autoRules || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>
    <button class="btn primary block" type="submit" style="margin-top:16px">${icon("shuffle")}Assign</button>
  </form>`);
  $("#autoForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api("api/admin/autoassign", { method: "POST", body: { date, redo: fd.get("mode") === "redo" } });
      await loadDay(true);
      const loads = Object.entries(r.loads).sort((a, b) => b[1].tasks - a[1].tasks);
      $("#sheetBody").innerHTML = `<div class="working"><div class="done-tick" style="width:52px;height:52px;margin:0 auto 14px">${icon("check")}</div>
        <b>${r.assigned ? `Assigned ${r.assigned} job${r.assigned > 1 ? "s" : ""}` : r.targets ? "Nobody could be fitted in" : "Nothing needed assigning"}</b>
        <div style="color:var(--muted);margin-top:6px">${r.assigned ? "The porters get a notification. You can still change anyone in the table." : "Every job already has porters."}</div></div>
        ${loads.length ? `<ul class="load-list">${loads.map(([n, l]) => `<li><span>${esc(n)}</span><b>${l.tasks} task${l.tasks === 1 ? "" : "s"}</b>${l.teaBreakfast ? `<small>${l.teaBreakfast} tea/coffee or breakfast</small>` : ""}</li>`).join("")}</ul>` : ""}
        <button class="btn block" data-close style="margin-top:16px">Done</button>`;
    } catch (err) { toast(err.message); }
  });
}

async function savePorters(id, v) {
  try {
    await api(`api/jobs/${encodeURIComponent(id)}/porters`, { method: "PUT", body: { porters: v.values, everyone: v.everyone } });
    toast(v.everyone ? "Assigned to everyone" : v.values.length ? `Assigned: ${v.values.join(", ")}` : "Porters removed");
    loadDay();
  } catch (e) { toast(e.message); }
}

const pickerOpen = () => [...pickers.values()].some((p) => p.isOpen());
// re-draw as soon as the dropdown that held back a live update is closed
function flushDeferred() {
  if (deferred && !pickerOpen()) renderAgenda();
}

async function tick(jobId, task) {
  const on = !day.ticks[jobId]?.[task];
  try {
    await api("api/tick", { method: "POST", body: { jobId, task, done: on } });
    await loadDay(true);
  } catch (e) { toast(e.message); }
}

async function addDayHosts() {
  try {
    await api("api/admin/hosts", { method: "POST", body: { names: day.newHosts } });
    toast(`Added ${day.newHosts.length} host${day.newHosts.length > 1 ? "s" : ""}`);
    loadDay(true);
  } catch (e) { toast(e.message); }
}

// ---------- edit / add ----------
function showEdit(id) {
  const job = id ? day.jobs.find((j) => j.id === id) : { date, owner: "Hospitality", slots: {}, links: {}, hosts: [], porters: [] };
  if (!job) return;
  const v = (k) => esc(job[k] ?? "");
  sheet.dataset.kind = "edit";
  openSheet(id ? "Edit job" : "Add a job", `<form id="editForm">
    <label class="f">Task <span style="font-weight:500">– optional, e.g. "L33 Flexroom clean"</span><input class="in" name="task" value="${v("task")}"></label>
    <div class="grid2">
      <label class="f">Location<input class="in" name="location" value="${v("location")}"></label>
      <label class="f">Guests<input class="in" name="attendees" inputmode="numeric" value="${v("attendees")}"></label>
      <label class="f">Vendor<input class="in" name="vendor" value="${v("vendor")}"></label>
      <label class="f">Team<select class="in" name="owner">${["Hospitality", "Movers", "Both", "Other"].map((o) => `<option${job.owner === o ? " selected" : ""}>${o}</option>`).join("")}</select></label>
      <label class="f">Date<input class="in" type="date" name="date" value="${v("date")}" required></label>
      <label class="f">Requestor<input class="in" name="requestor" value="${v("requestor")}"></label>
      <label class="f">Building<select class="in" name="site">${Object.entries(SITES).map(([k, l]) => `<option value="${k}"${(job.site || siteFilter || "tower") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    </div>
    <div class="f">Host(s) <span style="font-weight:500">– a new name is added to your host list</span><div id="hostPick"></div></div>
    <div class="f">Porters<div id="porterPick"></div></div>
    ${job.portersRaw ? `<div class="hint">Sheet says: ${esc(job.portersRaw)}</div>` : ""}
    <label class="f">Notes<textarea class="in" name="info">${v("info")}</textarea></label>
    <label class="f" style="margin-bottom:4px">Tasks</label>
    ${SLOTS.map((s) => {
      const sl = job.slots?.[s.key] || {};
      return `<div class="slot-row">
        <input type="checkbox" name="${s.key}.needed" ${sl.needed ? "checked" : ""} aria-label="${esc(s.label)} needed">
        <span class="lbl">${esc(s.label)}</span>
        ${timeInputHTML(`${s.key}.time`, esc(sl.time || ""), `${esc(s.label)} time`)}
        <input class="in note" name="${s.key}.note" value="${esc(sl.note || "")}" placeholder="Note (optional)" aria-label="${esc(s.label)} note">
      </div>`;
    }).join("")}
    <input type="hidden" name="eventLead" value="${v("eventLead")}">
    <div class="btn-row">
      ${id ? `<button class="btn danger" type="button" data-act="delete" data-job="${esc(id)}">Delete</button>` : ""}
      <button class="btn primary" type="submit">Save</button>
    </div>
  </form>`, true);
  const form = $("#editForm");
  wireTimeInputs(form);
  const hostPick = multiPicker($("#hostPick"), {
    options: day.hosts, selected: job.hosts || (job.host ? [job.host] : []), allowNew: true, closeOnPick: true,
    placeholder: "Choose or type a name", label: "Hosts",
  });
  const porterPick = multiPicker($("#porterPick"), {
    options: day.porters, selected: (job.porters || []).map((p) => p.name), everyone: true, everyoneOn: job.everyone,
    placeholder: "Choose porters", label: "Porters",
  });
  form.addEventListener("input", (e) => {
    const [k, f] = (e.target.name || "").split(".");
    if (f && f !== "needed" && e.target.value) form.elements[`${k}.needed`].checked = true;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { links: job.links || {}, slots: {} };
    for (const [k, val] of new FormData(form).entries()) {
      const [a, b] = k.split(".");
      if (b) (body.slots[a] ||= {})[b] = val; else body[a] = val;
    }
    for (const s of SLOTS) (body.slots[s.key] ||= {}).needed = form.elements[`${s.key}.needed`].checked;
    body.hosts = hostPick.value.values;
    body.porters = porterPick.value.values;
    body.everyone = porterPick.value.everyone;
    body.portersRaw = job.portersRaw || "";
    try {
      await api(id ? `api/jobs/${encodeURIComponent(id)}` : "api/jobs", { method: id ? "PUT" : "POST", body });
      closeSheet();
      toast("Saved");
      if (body.date && body.date !== date) { date = body.date; }
      loadDay(true);
    } catch (err) { toast(err.message); }
  });
}

async function deleteJob(id) {
  const job = day?.jobs.find((j) => j.id === id);
  const what = [job?.task, job?.location, (job?.hosts || []).join(", ")].filter(Boolean).join(" – ");
  if (!await ask({ title: "Delete this job?", name: what, text: "Its ticks are deleted too. This can't be undone.", ok: "Delete", danger: true })) return;
  try {
    await api(`api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeSheet();
    toast("Deleted");
    loadDay(true);
  } catch (e) { toast(e.message); }
}

// ---------- upload ----------
const isImage = (f) => /^image\//.test(f.type) && !/\.(xlsx|csv)$/i.test(f.name);

async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3.5e6 && /jpe?g|png|webp/.test(file.type)) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    return blob ? new File([blob], "agenda.jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

function showUpload() {
  sheet.dataset.kind = "upload";
  openSheet("Upload agenda", `<form id="upForm">
    <label class="drop slim" for="upFiles">${icon("upload")}<b>Choose screenshot or sheet file</b></label>
    <input id="upFiles" class="sr" type="file" accept="image/*,.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" multiple>
    <div class="thumbs" id="thumbs"></div>
    ${uploadPeopleHTML(siteFilter)}
    <label class="choice"><input type="radio" name="mode" value="replace" checked><span><b>Replace that day's agenda</b><small>For a new day or an updated sheet of that building. Ticks and porters you assigned are kept for jobs that haven't changed; jobs added by hand stay.</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="append"><span><b>Add more rows</b><small>When the rest of the agenda is in another screenshot.</small></span></label>
    <label class="choice"><input type="checkbox" name="auto" checked><span><b>Assign porters automatically</b><small>Jobs the sheet leaves without porters are shared out fairly among the people working in that building (from the rota). You can change any of them afterwards.</small></span></label>
    <button class="btn primary block" id="upGo" type="submit" style="margin-top:16px" disabled>Read it</button>
  </form>`);
  let files = [];
  $("#upFiles").addEventListener("change", (e) => {
    files = [...e.target.files].slice(0, 6);
    $("#thumbs").innerHTML = files.map((f) => isImage(f) ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<span class="file-tile">${esc(f.name)}</span>`).join("");
    $("#upGo").disabled = !files.length;
  });
  $("#upForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const mode = form.get("mode");
    const auto = e.target.elements.auto.checked;
    $("#sheetBody").innerHTML = `<div class="working"><div class="spinner"></div><b>Reading the agenda…</b><div style="color:var(--muted);margin-top:6px">Usually a few seconds.</div></div>`;
    try {
      const fd = new FormData();
      fd.append("mode", mode);
      fd.append("autoAssign", auto ? "1" : "0");
      fd.append("site", form.get("site") || "tower");
      fd.append("off", JSON.stringify(form.getAll("off")));
      for (const f of files) fd.append("images", isImage(f) ? await shrink(f) : f);
      const r = await api("api/upload", { method: "POST", body: fd });
      if (r.dates?.length && !r.dates.includes(date)) date = r.dates[0];
      await loadDay(true);
      $("#sheetBody").innerHTML = `<div class="working"><div class="done-tick" style="width:52px;height:52px;margin:0 auto 14px">${icon("check")}</div>
        <b>Found ${r.count} ${SITES[r.site] || ""} job${r.count === 1 ? "" : "s"}${r.dates?.length ? ` for ${r.dates.map((d) => fmtDay(d, { weekday: "short", day: "numeric", month: "short" })).join(", ")}` : ""}</b>
        <div style="color:var(--muted);margin-top:6px">${r.autoAssigned ? `${r.autoAssigned} job${r.autoAssigned > 1 ? "s" : ""} without porters ${r.autoAssigned > 1 ? "were" : "was"} assigned automatically – check the table. ` : ""}${r.unassigned ? `${r.unassigned} job${r.unassigned > 1 ? "s have" : " has"} no porters yet – assign them in the table.` : r.autoAssigned ? "" : "Every job has porters."}</div></div>
        ${r.newHosts?.length ? `<div class="unlisted"><h3>New host names</h3><p>Tick the ones to keep on your host list (untick any the screenshot misread).</p>
          <div class="names">${r.newHosts.map((h) => `<label><input type="checkbox" value="${esc(h)}" checked>${esc(h)}</label>`).join("")}</div>
          <div class="btn-row"><button class="btn primary" data-act="add-new-hosts">Add to host list</button></div></div>` : ""}
        ${r.warnings?.length ? `<div class="warn"><b>Double-check these:</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
        <button class="btn block" data-close style="margin-top:16px">Done</button>`;
    } catch (err) {
      $("#sheetBody").innerHTML = `<div class="working"><b>Couldn't read it</b><div style="color:var(--muted);margin-top:6px">${esc(err.message)}</div></div>
        <button class="btn primary block" data-act="upload" style="margin-top:16px">Try again</button>`;
    }
  });
}

async function addCheckedHosts(scope) {
  const names = [...scope.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
  if (!names.length) return toast("Nothing ticked");
  try {
    await api("api/admin/hosts", { method: "POST", body: { names } });
    toast(`Added ${names.length} host${names.length > 1 ? "s" : ""}`);
    scope.remove();
    if (tab === "hosts") loadHosts(); else loadDay(true);
  } catch (e) { toast(e.message); }
}

async function showShots(up = day?.upload, title = "Original screenshot") {
  if (!up?.images?.length) return;
  openSheet(title, `<div class="shots" id="shots">${up.images.map(() => `<div class="shot"><div class="spinner" style="margin:30px auto"></div></div>`).join("")}</div>`, true);
  const holders = [...document.querySelectorAll("#shots .shot")];
  up.images.forEach(async (name, i) => {
    try {
      const res = await fetch(`api/images/${encodeURIComponent(name)}`, { headers: { "x-admin-pin": adminPin, "x-admin-user": encodeURIComponent(adminUser) } });
      if (!res.ok) throw new Error();
      holders[i].innerHTML = `<img src="${URL.createObjectURL(await res.blob())}" alt="Agenda screenshot ${i + 1}">`;
      holders[i].addEventListener("click", () => holders[i].classList.toggle("zoom"));
    } catch { holders[i].innerHTML = `<div style="padding:20px">Could not load image.</div>`; }
  });
}

// ---------- rota ----------
let rota = null;       // the week shown in the Rota tab
let rotaWeek = null;   // its Monday

async function loadRota(week = rotaWeek || localToday()) {
  try {
    rota = await api(`api/admin/rota?week=${week}`);
    rotaWeek = rota.dates[0];
    renderRota();
  } catch (e) { toast(e.message); }
}

const shortDay = (d) => fmtDay(d, { weekday: "short", day: "numeric", month: "short" });
const codeClass = (code) => (/^(AM|PM) DSQ$/.test(code) ? "r-dsq" : /^(AM|PM|SIC)$/.test(code) ? "r-tower" : code ? "r-off" : "");

function renderRota() {
  const { dates, codes, plans, porters, codeList, today } = rota;
  $("#weekTitle").textContent = `${fmtDay(dates[0], { day: "numeric", month: "short" })} – ${fmtDay(dates[6], { day: "numeric", month: "short", year: "numeric" })}`;
  $("#rotaShotBtn").hidden = !rota.upload?.images?.length;
  $("#rotaHead").innerHTML = `<tr><th>Name</th>${dates.map((d) => `<th class="${d === today ? "today" : ""}">${esc(fmtDay(d, { weekday: "short", day: "numeric" }))}</th>`).join("")}</tr>`;
  $("#rotaRows").innerHTML = porters.length ? porters.map((p) => `<tr>
    <td class="rn" title="${esc([p.fullName, SITES[p.site], p.tasks ? "" : "never gets tasks"].filter(Boolean).join(" · "))}"><b>${esc(p.name)}</b>${p.site === "dsq" ? ` <span class="site-tag">DSQ</span>` : ""}${p.tasks ? "" : ` <small>no tasks</small>`}</td>
    ${dates.map((d) => {
      const code = codes[d]?.[p.name.toLowerCase()] || "";
      const e = plans[d]?.[p.name] || {};
      const opts = ["", ...codeList, ...(code && !codeList.includes(code) ? [code] : [])];
      const note = e.why === "away" ? "Holiday" : e.why === "marked" ? (e.in ? "Marked in" : "Marked off") : e.why === "no-tasks" && code !== "SIC" ? "No tasks" : !code ? `Not on rota – ${e.works ? SITES[e.site] : "off"}` : "";
      return `<td class="rc ${e.works ? `r-${e.site}` : "r-off"}"><select class="in" data-rota data-date="${d}" data-name="${esc(p.name)}" aria-label="${esc(p.name)}, ${esc(shortDay(d))}">${opts.map((o) => `<option value="${esc(o)}"${o === code ? " selected" : ""}>${esc(o || "—")}</option>`).join("")}</select>${note ? `<small>${esc(note)}</small>` : ""}</td>`;
    }).join("")}</tr>`).join("") : `<tr class="empty-row"><td colspan="8">No porters yet.</td></tr>`;

  const sel = $("#awayForm").elements.who;
  const keep = sel.value;
  sel.innerHTML = porters.map((p) => `<option${p.name === keep ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  $("#awayList").innerHTML = rota.away.length ? rota.away.map((a) => {
    const range = a.end !== a.start ? `${shortDay(a.start)} – ${shortDay(a.end)}` : shortDay(a.start);
    return `<li><span class="nm">${esc(a.porter)}</span><span class="meta">${esc(range)}${a.note ? ` · ${esc(a.note)}` : ""}</span>
      <button class="btn small danger" data-act="away-del" data-id="${a.id}" data-what="${esc(`${a.porter}: ${range}`)}">Cancel</button></li>`;
  }).join("") : `<li class="empty">No holidays booked. Add one above – that person gets no tasks on those days.</li>`;
}

function showRotaUpload() {
  sheet.dataset.kind = "rota";
  openSheet("Upload the rota", `<form id="rotaForm">
    <label class="drop" for="rotaFiles">${icon("upload")}<b>Choose the rota screenshot or file</b><span>A screenshot of the week (names down the side, dates along the top), or the rota spreadsheet (.xlsx / .csv).
      AM = 06:30–15:30, PM = 09:00–18:00, "DSQ" = working at DSQ. SIC = working alone on Level 37 (no tasks). PTO, Sick, Off, or a blank or blacked-out day = not working.</span></label>
    <input id="rotaFiles" class="sr" type="file" accept="image/*,.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" multiple>
    <div class="thumbs" id="rthumbs"></div>
    <p class="hint">Names are matched to your porters by first name (Jeet Chand Mehay → Jeet). Anyone new is added as a porter.</p>
    <button class="btn primary block" id="rotaGo" type="submit" style="margin-top:12px" disabled>Read the rota</button>
  </form>`);
  let files = [];
  $("#rotaFiles").addEventListener("change", (e) => {
    files = [...e.target.files].slice(0, 4);
    $("#rthumbs").innerHTML = files.map((f) => isImage(f) ? `<img src="${URL.createObjectURL(f)}" alt="">` : `<span class="file-tile">${esc(f.name)}</span>`).join("");
    $("#rotaGo").disabled = !files.length;
  });
  $("#rotaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#sheetBody").innerHTML = `<div class="working"><div class="spinner"></div><b>Reading the rota…</b><div style="color:var(--muted);margin-top:6px">Usually a few seconds.</div></div>`;
    try {
      const fd = new FormData();
      for (const f of files) fd.append("files", isImage(f) ? await shrink(f) : f);
      const r = await api("api/admin/rota", { method: "POST", body: fd });
      if (tab === "rota") loadRota(r.dates[0]); else rotaWeek = r.dates[0];
      if (tab === "agenda") loadDay(true);
      const added = r.people.filter((p) => p.added);
      $("#sheetBody").innerHTML = `<div class="working" style="padding-bottom:10px"><div class="done-tick" style="width:52px;height:52px;margin:0 auto 14px">${icon("check")}</div>
        <b>Rota saved for ${esc(shortDay(r.dates[0]))} – ${esc(shortDay(r.dates.at(-1)))}</b>
        <div style="color:var(--muted);margin-top:6px">Check it against the picture. Any day can be changed in the Rota tab.</div></div>
        <div class="a-tablewrap"><table class="a-table mini-rota"><thead><tr><th></th>${r.dates.map((d) => `<th>${esc(fmtDay(d, { weekday: "short", day: "numeric" }))}</th>`).join("")}</tr></thead>
        <tbody>${r.people.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.added ? ` <span class="new">new</span>` : ""}${p.rota !== p.name ? `<small>${esc(p.rota)}</small>` : ""}</td>${r.dates.map((d) => `<td class="${codeClass(p.days[d])}">${esc(p.days[d] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        ${added.length ? `<div class="notice ok"><span><b>New porter${added.length > 1 ? "s" : ""} added:</b> ${added.map((p) => esc(p.name)).join(", ")}. Set anyone who never gets tasks in the Porters tab.</span></div>` : ""}
        ${r.clashes.length ? `<div class="warn"><b>Off on the rota but already given jobs:</b><ul>${r.clashes.map((c) => `<li>${esc(shortDay(c.date))}: ${esc(c.name)} (${esc(c.label)}, ${c.tasks} task${c.tasks > 1 ? "s" : ""}) <button class="btn small" data-goto="${esc(c.date)}">Open that day</button></li>`).join("")}</ul></div>` : ""}
        ${r.warnings?.length ? `<div class="warn"><b>Double-check these:</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
        <button class="btn block" data-close style="margin-top:16px">Done</button>`;
    } catch (err) {
      $("#sheetBody").innerHTML = `<div class="working"><b>Couldn't read it</b><div style="color:var(--muted);margin-top:6px">${esc(err.message)}</div></div>
        <button class="btn primary block" data-act="rota-up" style="margin-top:16px">Try again</button>`;
    }
  });
}

// ---------- history ----------
async function loadHistory() {
  try {
    const { days, today } = await api("api/admin/history");
    $("#historyRows").innerHTML = days.length ? days.map((d) => `<tr class="clickable${d.tasks && d.done === d.tasks ? " done" : ""}" data-goto="${esc(d.date)}">
      <td><b>${esc(fmtDay(d.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}</b>${d.date === today ? " · today" : ""}</td>
      <td>${d.jobs}</td>
      <td><div style="display:flex;align-items:center;gap:10px"><span class="a-stats" style="margin:0"><span class="bar"><i style="width:${d.tasks ? (d.done / d.tasks) * 100 : 0}%"></i></span></span>${d.done}/${d.tasks}</div></td>
      <td>${d.unassigned || ""}</td></tr>`).join("")
      : `<tr class="empty-row"><td colspan="4">No agendas yet.</td></tr>`;
  } catch (e) { toast(e.message); }
}

// ---------- hosts ----------
let hostData = { hosts: [], unlisted: [] };
async function loadHosts() {
  try { hostData = await api("api/admin/hosts"); renderHosts(); } catch (e) { toast(e.message); }
}
function renderHosts() {
  const q = $("#hostSearch").value.trim().toLowerCase();
  const list = hostData.hosts.filter((h) => !q || h.name.toLowerCase().includes(q));
  $("#hostCount").textContent = `(${hostData.hosts.length})`;
  $("#hostList").innerHTML = list.length ? list.map((h) => `<li data-id="${h.id}">
      <span class="nm">${esc(h.name)}</span>
      <button class="btn small" data-act="host-rename" data-id="${h.id}" data-name="${esc(h.name)}">Rename</button>
      <button class="btn small danger" data-act="host-del" data-id="${h.id}" data-name="${esc(h.name)}">Remove</button></li>`).join("")
    : `<li class="empty">${q ? "No match." : "No hosts yet. Add them above, or from the names found in your agendas."}</li>`;
  $("#unlisted").innerHTML = hostData.unlisted.length ? `<div class="unlisted"><h3>Found in your agendas but not on the list</h3>
      <p>Tick the ones to add. Untick names a screenshot misread.</p>
      <div class="names">${hostData.unlisted.map((h) => `<label title="Seen ${h.count}× · last ${esc(h.last)}"><input type="checkbox" value="${esc(h.name)}" checked>${esc(h.name)}</label>`).join("")}</div>
      <div class="btn-row"><button class="btn primary" data-act="add-new-hosts">Add ticked hosts</button></div></div>` : "";
}

// ---------- porters ----------
async function loadPorters() {
  try {
    const { porters, notifications } = await api("api/admin/porters");
    $("#porterList").innerHTML = porters.map((p) => {
      const n = notifications[p.name] || 0;
      return `<li class="${p.active ? "" : "off"}"><span class="nm">${esc(p.name)}${p.fullName && p.fullName !== p.name ? `<small>${esc(p.fullName)}</small>` : ""}</span>
        ${p.active ? `<select class="in p-site" data-porter-site="${p.id}" aria-label="${esc(p.name)}'s usual building">${Object.entries(SITES).map(([k, l]) => `<option value="${k}"${p.site === k ? " selected" : ""}>${l}</option>`).join("")}</select>
        <label class="p-tasks" title="Untick for someone who is never given tasks (e.g. Carlos on Level 37)"><input type="checkbox" data-porter-tasks="${p.id}"${p.tasks ? " checked" : ""}>Gets tasks</label>` : ""}
        <span class="meta">${icon("bell")} ${n ? `${n} phone${n > 1 ? "s" : ""}` : "no notifications"}</span>
        <button class="btn small${p.active ? " danger" : ""}" data-act="porter-toggle" data-id="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? "Remove" : "Bring back"}</button></li>`;
    }).join("");
  } catch (e) { toast(e.message); }
}

// ---------- tabs & events ----------
function showTab(t) {
  tab = t;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-pressed", b.dataset.tab === t);
  for (const s of TABS) $(`#tab-${s}`).hidden = s !== t;
  history.replaceState(null, "", `#${t}${t === "agenda" && date ? "/" + date : ""}`);
  if (t === "agenda") loadDay(true);
  if (t === "history") loadHistory();
  if (t === "hosts") loadHosts();
  if (t === "porters") loadPorters();
  if (t === "rota") loadRota();
}
function goDate(d) {
  date = d;
  day = null;
  $("#rows").innerHTML = "";
  history.replaceState(null, "", `#agenda/${date}`);
  loadDay(true);
}

document.addEventListener("click", async (e) => {
  const tabBtn = e.target.closest("#tabs [data-tab]");
  if (tabBtn) return showTab(tabBtn.dataset.tab);
  const step = e.target.closest("[data-day-step]");
  if (step) return goDate(shiftDay(date, Number(step.dataset.dayStep)));
  const go = e.target.closest("[data-goto]");
  if (go) { closeSheet(); date = go.dataset.goto; return showTab("agenda"); }
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const id = el.dataset.job;
  switch (el.dataset.act) {
    case "tick": return tick(id, el.dataset.task);
    case "edit": return showEdit(id);
    case "delete": return deleteJob(id);
    case "upload": return showUpload();
    case "auto": return showAuto();
    case "who": return toggleWho(el.dataset.name, el.dataset.in === "1");
    case "move": return moveJobs(JSON.parse(el.dataset.names || "null"));
    case "site": siteFilter = el.dataset.site; store.set("siteFilter", siteFilter); return renderAgenda();
    case "week": return loadRota(shiftDay(rotaWeek || localToday(), Number(el.dataset.step)));
    case "this-week": return loadRota(localToday());
    case "rota-up": return showRotaUpload();
    case "rota-shot": return showShots(rota?.upload, "Rota");
    case "away-del":
      if (!await ask({ title: "Cancel this holiday?", name: el.dataset.what, ok: "Cancel it", danger: true })) return;
      try { await api(`api/admin/away/${el.dataset.id}`, { method: "DELETE" }); loadRota(rotaWeek); } catch (err) { toast(err.message); }
      return;
    case "add-day-hosts": return addDayHosts();
    case "add-new-hosts": return addCheckedHosts(el.closest(".unlisted"));
    case "host-del":
      if (!await ask({ title: "Remove from the host list?", name: el.dataset.name, text: "Past agendas keep the name.", ok: "Remove", danger: true })) return;
      try { await api(`api/admin/hosts/${el.dataset.id}`, { method: "DELETE" }); loadHosts(); } catch (err) { toast(err.message); }
      return;
    case "host-rename": {
      const name = await askText({ title: "Change the spelling", value: el.dataset.name, label: "Host name" });
      if (!name || name.trim() === el.dataset.name) return;
      try { await api(`api/admin/hosts/${el.dataset.id}`, { method: "PUT", body: { name } }); loadHosts(); } catch (err) { toast(err.message); }
      return;
    }
    case "porter-toggle":
      try { await api(`api/admin/porters/${el.dataset.id}`, { method: "PUT", body: { active: el.dataset.active === "1" } }); loadPorters(); } catch (err) { toast(err.message); }
      return;
  }
});
$("#dateIn").addEventListener("change", (e) => { if (e.target.value) goDate(e.target.value); });
$("#todayBtn").addEventListener("click", () => goDate(day?.today || localToday()));
$("#uploadBtn").addEventListener("click", showUpload);
$("#addBtn").addEventListener("click", () => showEdit(null));
$("#autoBtn").addEventListener("click", showAuto);
$("#shotBtn").addEventListener("click", () => showShots());
$("#hostSearch").addEventListener("input", renderHosts);
$("#hostForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  try { await api("api/admin/hosts", { method: "POST", body: { name } }); e.target.reset(); toast(`Added ${name}`); loadHosts(); } catch (err) { toast(err.message); }
});
$("#porterForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  try { await api("api/admin/porters", { method: "POST", body: { name } }); e.target.reset(); toast(`Added ${name}`); loadPorters(); } catch (err) { toast(err.message); }
});
$("#logout").addEventListener("click", () => { store.del("adminPin"); store.del("adminUser"); adminPin = ""; adminUser = ""; showLogin(); });
document.addEventListener("change", async (e) => {
  const el = e.target;
  try {
    if (el.matches("[data-rota]")) {
      await api("api/admin/rota", { method: "PUT", body: { date: el.dataset.date, name: el.dataset.name, code: el.value } });
      toast(`${el.dataset.name}: ${el.value || "not on the rota"} on ${fmtDay(el.dataset.date, { weekday: "short", day: "numeric", month: "short" })}`);
      loadRota(rotaWeek);
    } else if (el.matches("[data-porter-site]")) {
      await api(`api/admin/porters/${el.dataset.porterSite}`, { method: "PUT", body: { site: el.value } });
      toast("Saved");
    } else if (el.matches("[data-porter-tasks]")) {
      await api(`api/admin/porters/${el.dataset.porterTasks}`, { method: "PUT", body: { tasks: el.checked } });
      toast(el.checked ? "Gets tasks again" : "Won't be given tasks");
    }
  } catch (err) { toast(err.message); }
});
$("#awayForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api("api/admin/away", { method: "POST", body: { name: f.who.value, from: f.from.value, to: f.to.value || f.from.value } });
    toast(`Holiday booked for ${f.who.value}`);
    e.target.reset();
    loadRota(rotaWeek);
  } catch (err) { toast(err.message); }
});

// live updates: ticks from the porters' phones show up within a few seconds
setInterval(() => {
  if (!adminPin || tab !== "agenda" || document.visibilityState !== "visible" || sheet.open) return;
  flushDeferred();
  loadDay();
}, 4000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && adminPin && tab === "agenda") loadDay(); });

// ---------- login ----------
function showLogin(msg) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#loginErr").textContent = msg || "";
  $("#pin").value = "";
  $("#user").value = adminUser || "";
  (adminUser ? $("#pin") : $("#user")).focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("#pin").value.trim();
  const u = $("#user").value.trim();
  let data = {};
  try {
    const res = await fetch("api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: u, pin: p }) });
    data = await res.json().catch(() => ({}));
    if (!res.ok) { $("#loginErr").textContent = data.error || "That name and password don't match."; return; }
  } catch { $("#loginErr").textContent = "Can't reach the server."; return; }
  adminPin = p;
  adminUser = data.name || u;
  store.set("adminPin", p);
  store.set("adminUser", adminUser);
  start();
});

function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const [t, d] = location.hash.slice(1).split("/");
  date = /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : localToday();
  $("#me").textContent = adminUser;
  showTab(TABS.includes(t) ? t : "agenda");
}

if (adminPin) start(); else showLogin();
