// Porters Agenda - client
import { multiPicker } from "./picker.js?v=4";
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
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [s.key, s.label]));
const ROLE_SLOT = { TCW: "teaCoffee", TC: "teaCoffee", T: "teaCoffee", B: "breakfast", L: "lunch", A: "afternoon", PM: "afternoon", S: "setup", SU: "setup", C: "clearUp", CU: "clearUp", R: "reset" };
const ROLE_SHORT = { teaCoffee: "Tea/coffee", breakfast: "Breakfast", lunch: "Lunch", afternoon: "Afternoon", setup: "Setup", clearUp: "Clear up", reset: "Reset" };
const COLORS = ["#2f7fd1", "#d0573a", "#2f9e6e", "#9b59b6", "#c98a12", "#16a0a8", "#c2417e", "#5b6ad0"];

let cfg = { porters: [], pinRequired: true, pushKey: "" };
let me = store.get("me", null);
let pin = store.get("pin", "");
let filter = store.get("filter", null);
let hideDone = store.get("hideDone", false);
let state = null;
let selectedDay = null;
let pending = 0;
let lastChipFilter;
const expanded = new Set();

const colorOf = (name) => {
  const i = cfg.porters.findIndex((p) => p.toLowerCase() === String(name).toLowerCase());
  return COLORS[(i < 0 ? 7 : i) % COLORS.length];
};
const initial = (name) => esc(String(name).trim().charAt(0).toUpperCase());

// ---------- time helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const toMin = (t) => (/^\d{2}:\d{2}$/.test(t || "") ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const fmtDay = (iso, long) => {
  if (!iso) return "Agenda";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-GB", long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" });
};
const fmtClock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : fmtDay(iso.slice(0, 10));
};

// ---------- api ----------
async function api(path, opts = {}) {
  const headers = { "x-team-pin": pin, "x-porter-name": encodeURIComponent(me || ""), ...(opts.headers || {}) };
  const adminPin = store.get("adminPin", "");
  if (adminPin) headers["x-admin-pin"] = adminPin;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  const res = await fetch(path, { ...opts, headers, body });
  if (res.status === 401) { showLogin("Your PIN has changed. Please log in again."); throw new Error("Not logged in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

// ---------- jobs ----------
function tasksOf(job) {
  const t = SLOTS.filter((s) => job.slots?.[s.key]?.needed).map((s) => ({ key: s.key, label: s.label, ...job.slots[s.key] }));
  if (!t.length) t.push({ key: "done", label: "Mark as done", time: "", note: "" });
  return t;
}
function jobTimes(job) {
  const mins = tasksOf(job).map((t) => toMin(t.time)).filter((m) => m != null);
  return mins.length ? { start: Math.min(...mins), end: Math.max(...mins) } : { start: null, end: null };
}
const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isTicked = (job, key) => Boolean(state.ticks?.[job.id]?.[key]);
const isAdmin = () => Boolean(state?.admin);
/** Porters tick their own jobs (or "Everyone" jobs); other people's are read-only. */
const canTick = (job) => isAdmin() || job.everyone || Boolean(job.porters?.some((p) => p.name === me));
const jobDone = (job) => tasksOf(job).every((t) => isTicked(job, t.key));

const unassigned = (job) => !job.everyone && !job.porters?.length;
function matchesFilter(job, f = filter) {
  if (!f) return true;
  if (f === "__none") return unassigned(job);
  return job.everyone || job.porters?.some((p) => p.name === f);
}
function mySlots(job, name) {
  const p = job.porters?.find((x) => x.name === name);
  if (!p || !p.roles?.length) return null; // null = all tasks
  return new Set(p.roles.map((r) => ROLE_SLOT[r]).filter(Boolean));
}
const dayUpload = () => state?.uploads?.[selectedDay] || null;
function daysOf() {
  return [...new Set((state?.jobs || []).map((j) => j.date || ""))].sort();
}

// ---------- render ----------
function render() {
  if (!state) return;
  const days = daysOf();
  const today = todayStr();
  if (!selectedDay || !days.includes(selectedDay)) {
    selectedDay = days.includes(today) ? today : days.find((d) => d > today) || days[days.length - 1] || null;
  }
  const isToday = selectedDay === today;
  $("#dayTitle").textContent = selectedDay ? (isToday ? "Today · " : "") + fmtDay(selectedDay) : "Porters Agenda";
  document.title = selectedDay ? `${fmtDay(selectedDay)} · Porters` : "Porters Agenda";
  $("#shotBtn").hidden = !dayUpload()?.images?.length;
  $("#fab").hidden = !isAdmin() || days.includes(today);

  // day tabs (only when the upload had more than one day)
  const daysEl = $("#days");
  daysEl.hidden = days.length < 2;
  daysEl.innerHTML = days.map((d) => `<button class="day" data-day="${esc(d)}" aria-pressed="${d === selectedDay}">${esc(d ? fmtDay(d) : "No date")}</button>`).join("");

  const dayJobs = state.jobs.filter((j) => (j.date || "") === (selectedDay || ""));

  // filter chips with counts
  const opts = [[null, "Everyone"], ...cfg.porters.map((p) => [p, p === me ? `${p} (me)` : p]), ["__none", "Unassigned"]];
  $("#chips").innerHTML = opts.map(([v, label]) => {
    const n = dayJobs.filter((j) => matchesFilter(j, v)).length;
    if (v === "__none" && !n) return "";
    return `<button class="chip" data-filter="${esc(v ?? "")}" aria-pressed="${filter === v}">${esc(label)}<span class="n">${n}</span></button>`;
  }).join("");
  if (lastChipFilter !== filter) {
    lastChipFilter = filter;
    $("#chips [aria-pressed=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // stale / warnings banner
  let banner = "";
  if (state.jobs.length && selectedDay && selectedDay < today && !days.some((d) => d >= today)) {
    banner = isAdmin()
      ? `<div class="banner"><div><b>This is the agenda for ${esc(fmtDay(selectedDay, true))}</b>Upload today's screenshot when it's posted.</div><button class="act" data-act="upload">Upload</button></div>`
      : `<div class="banner"><div><b>This is the agenda for ${esc(fmtDay(selectedDay, true))}</b>Today's agenda hasn't been put up yet.</div></div>`;
  }
  if (!banner) banner = pushPromptHTML();
  $("#banner").innerHTML = banner;

  const jobs = dayJobs.filter((j) => matchesFilter(j));
  const list = $("#list");

  if (!state.jobs.length) {
    $("#summary").hidden = true;
    list.innerHTML = isAdmin()
      ? `<div class="empty">${icon("image")}<h2>No agenda yet</h2><div>Upload the screenshot from the group chat and the jobs will appear here.</div>
      <button class="btn primary big" data-act="upload">${icon("upload")} Upload screenshot</button></div>`
      : `<div class="empty">${icon("image")}<h2>No agenda yet</h2><div>The jobs will appear here as soon as the admin puts up the agenda.</div></div>`;
    return;
  }

  // progress
  let total = 0, done = 0;
  for (const j of jobs) for (const t of tasksOf(j)) { total++; if (isTicked(j, t.key)) done++; }
  $("#summary").hidden = !jobs.length;
  $("#progBar").style.width = total ? `${(done / total) * 100}%` : "0";
  $("#progTxt").textContent = `${done}/${total} done`;
  $("#hideDoneBtn").textContent = hideDone ? "Show finished" : "Hide finished";

  if (!jobs.length) {
    list.innerHTML = `<div class="empty"><h2>Nothing for ${esc(filter === "__none" ? "unassigned" : filter)}</h2><div>No jobs ${filter === "__none" ? "without a porter" : "assigned"} on this day.</div>
      <button class="btn big" data-filter="">Show everyone</button></div>`;
    return;
  }

  const sorted = jobs
    .map((j) => ({ j, ...jobTimes(j), done: jobDone(j) }))
    .sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9) || (a.end ?? 1e9) - (b.end ?? 1e9));

  const now = nowMin();
  let html = "", nowPlaced = !isToday, hiddenCount = 0, untimedLabel = false;
  for (const it of sorted) {
    if (hideDone && it.done) { hiddenCount++; continue; }
    if (!nowPlaced && it.start != null && it.start > now) {
      html += `<div class="now">Now · ${fmtMin(now)}</div>`;
      nowPlaced = true;
    }
    if (it.start == null && !untimedLabel) {
      if (!nowPlaced) { html += `<div class="now">Now · ${fmtMin(now)}</div>`; nowPlaced = true; }
      html += `<div class="group-label">No set time</div>`;
      untimedLabel = true;
    }
    html += cardHTML(it.j, it);
  }
  if (!nowPlaced) html += `<div class="now">Now · ${fmtMin(now)}</div>`;
  if (hiddenCount) html += `<button class="btn block" id="showHidden">${hiddenCount} finished job${hiddenCount > 1 ? "s" : ""} hidden · Show</button>`;
  list.innerHTML = html;
}

function porterChips(job, highlight) {
  if (job.everyone) {
    return `<span class="p all${highlight ? " me" : ""}"><span class="av">${icon("people")}</span>Everyone</span>`;
  }
  if (!job.porters?.length) {
    return job.portersRaw
      ? `<span class="p none">${esc(job.portersRaw)}</span>`
      : `<span class="p none">No porter assigned</span>`;
  }
  return job.porters.map((p) => {
    const roles = (p.roles || []).map((r) => ROLE_SHORT[ROLE_SLOT[r]] || r).join(", ");
    return `<span class="p${p.name === highlight ? " me" : ""}" style="--c:${colorOf(p.name)}"><span class="av">${initial(p.name)}</span>${esc(p.name)}${roles ? `<span class="role">· ${esc(roles)}</span>` : ""}</span>`;
  }).join("");
}

function taskHTML(job, t, focus) {
  const tick = state.ticks?.[job.id]?.[t.key];
  const isToday = (job.date || "") === todayStr();
  let badge = "";
  if (!tick && isToday && t.time) {
    const diff = toMin(t.time) - nowMin();
    if (diff >= 0 && diff <= 45) badge = `<span class="badge soon">in ${diff} min</span>`;
    else if (diff < -10 && diff > -360) badge = `<span class="badge late">${-diff < 60 ? `${-diff}m` : `${Math.floor(-diff / 60)}h ${pad(-diff % 60)}m`} ago</span>`;
  }
  const mine = focus && focus.has(t.key);
  if (!badge && mine) badge = `<span class="badge mine">Yours</span>`;
  const inner = `<span class="box">${icon("check")}</span>
    <span class="tl">${t.time ? `<span class="tm">${esc(t.time)}</span>` : ""}<span class="name">${esc(t.label)}</span>${t.note ? `<small>${esc(t.note)}</small>` : ""}</span>
    ${tick ? `<span class="tby">${esc(tick.by)}<br>${fmtClock(tick.at)}</span>` : badge}`;
  const cls = `task${tick ? " ticked" : ""}${focus && !mine ? " dim" : ""}`;
  if (!canTick(job)) return `<li><div class="${cls} readonly" role="checkbox" aria-checked="${Boolean(tick)}" aria-disabled="true">${inner}</div></li>`;
  return `<li><button class="${cls}" data-act="tick" data-job="${esc(job.id)}" data-task="${t.key}" aria-pressed="${Boolean(tick)}">${inner}</button></li>`;
}

function cardHTML(job, { start, end, done }) {
  const title = job.location || job.host || "Job";
  if (done && !expanded.has(job.id)) {
    return `<article class="card compact" data-owner="${esc(job.owner)}">
      <button class="head" data-act="expand" data-job="${esc(job.id)}">
        <span class="done-tick">${icon("check")}</span>
        <span class="where">${esc(title)}</span>
        <span class="when">${start != null ? fmtMin(start) : ""}</span>
      </button></article>`;
  }
  const highlight = filter && filter !== "__none" ? filter : null;
  const focus = highlight ? mySlots(job, highlight) : null;
  const sub = [job.location ? job.host : "", job.vendor].filter(Boolean).join(" · ");
  const when = start == null ? "" : start === end ? `<b>${fmtMin(start)}</b>` : `<b>${fmtMin(start)}</b> – ${fmtMin(end)}`;
  return `<article class="card" data-owner="${esc(job.owner)}">
    <button class="head" data-act="detail" data-job="${esc(job.id)}">
      <div class="row1"><span class="when">${when}</span><span class="owner-tag">${esc(job.owner === "Other" ? "" : job.owner)}</span>
        ${job.attendees ? `<span class="pax">${icon("people")}${esc(job.attendees)}</span>` : ""}</div>
      <div class="where">${esc(title)}</div>
      ${sub ? `<div class="who">${esc(sub)}</div>` : ""}
    </button>
    <div class="porters">${porterChips(job, highlight)}</div>
    <ul class="tasks">${tasksOf(job).map((t) => taskHTML(job, t, focus)).join("")}</ul>
    ${job.info ? `<p class="info" data-act="detail" data-job="${esc(job.id)}"><b>Notes:</b> ${esc(job.info)}</p>` : ""}
  </article>`;
}

// ---------- sheets ----------
const sheet = $("#sheet");
function openSheet(title, html) {
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = html;
  $("#sheetBody").scrollTop = 0;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener("click", (e) => {
  if (e.target === sheet || e.target.closest("[data-close]")) closeSheet();
});
sheet.addEventListener("close", () => { sheet.dataset.kind = ""; $("#sheetBody").innerHTML = ""; });

function showDetail(id) {
  const job = state.jobs.find((j) => j.id === id);
  if (!job) return closeSheet();
  const { start, end } = jobTimes(job);
  const rows = [
    ["Time", start == null ? "" : start === end ? fmtMin(start) : `${fmtMin(start)} – ${fmtMin(end)}`],
    ["Host", job.host], ["Vendor", job.vendor], ["Guests", job.attendees], ["Team", job.owner === "Other" ? "" : job.owner],
    ["Requestor", job.requestor], ["Event lead", job.eventLead], ["Sheet says", job.portersRaw],
  ].filter(([, v]) => v);
  const links = [job.links?.menu && "Menu / allergen matrix", job.links?.agenda && "Agenda", job.links?.floorPlan && "Floor plan"].filter(Boolean);
  const highlight = filter && filter !== "__none" ? filter : null;
  sheet.dataset.kind = "detail";
  sheet.dataset.job = id;
  openSheet(job.host || "Job details", `<div class="detail">
    <div class="detail-where">${esc(job.location || job.host)}</div>
    <div class="porters" style="padding:6px 0 4px">${porterChips(job, highlight)}</div>
    <ul class="tasks">${tasksOf(job).map((t) => taskHTML(job, t, highlight ? mySlots(job, highlight) : null)).join("")}</ul>
    ${canTick(job) ? "" : `<div class="hint">Only the porters on this job can tick it.</div>`}
    ${job.info ? `<div class="notes">${esc(job.info)}</div>` : ""}
    <dl>${rows.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${links.length ? `<div class="links">${links.map((l) => `<span>${esc(l)}: link in spreadsheet</span>`).join("")}</div>` : ""}
    <div class="btn-row">
      ${dayUpload()?.images?.length ? `<button class="btn" data-act="shots">${icon("image")} Screenshot</button>` : ""}
      ${isAdmin() ? `<button class="btn" data-act="edit" data-job="${esc(id)}">${icon("edit")} Edit</button>
      <button class="btn danger" data-act="delete" data-job="${esc(id)}">${icon("trash")} Delete</button>` : ""}
    </div></div>`);
}

function showEdit(id) {
  const job = id ? state.jobs.find((j) => j.id === id) : {
    date: selectedDay || todayStr(), owner: "Hospitality", slots: {}, links: {},
  };
  if (!job) return;
  const v = (k) => esc(job[k] ?? "");
  sheet.dataset.kind = "edit";
  openSheet(id ? "Edit job" : "Add a job", `<form id="editForm">
    <div class="grid2">
      <label class="f">Location<input class="in" name="location" value="${v("location")}" required></label>
      <label class="f">Guests<input class="in" name="attendees" inputmode="numeric" value="${v("attendees")}"></label>
      <label class="f">Vendor<input class="in" name="vendor" value="${v("vendor")}"></label>
      <label class="f">Team<select class="in" name="owner">${["Hospitality", "Movers", "Both", "Other"].map((o) => `<option${job.owner === o ? " selected" : ""}>${o}</option>`).join("")}</select></label>
      <label class="f">Date<input class="in" type="date" name="date" value="${v("date")}"></label>
    </div>
    <div class="f">Host(s)<div id="hostPick"></div></div>
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
    <input type="hidden" name="requestor" value="${v("requestor")}"><input type="hidden" name="eventLead" value="${v("eventLead")}">
    <div class="btn-row">
      ${id ? `<button class="btn danger" type="button" data-act="delete" data-job="${esc(id)}">Delete</button>` : ""}
      <button class="btn primary" type="submit">Save</button>
    </div>
  </form>`);
  const form = $("#editForm");
  wireTimeInputs(form);
  const hostPick = multiPicker($("#hostPick"), {
    options: hostList, selected: job.hosts || (job.host ? [job.host] : []), allowNew: true, closeOnPick: true,
    placeholder: "Choose or type a name", label: "Hosts",
  });
  const porterPick = multiPicker($("#porterPick"), {
    options: cfg.porters, selected: (job.porters || []).map((p) => p.name), everyone: true, everyoneOn: job.everyone,
    placeholder: "Choose porters", label: "Porters",
  });
  loadHosts().then((h) => hostPick.setOptions(h));
  // ticking "needed" when a time is typed
  form.addEventListener("input", (e) => {
    const [k, f] = (e.target.name || "").split(".");
    if (f && f !== "needed" && e.target.value) form.elements[`${k}.needed`].checked = true;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { links: job.links || {}, slots: {} };
    for (const [k, val] of fd.entries()) {
      const [a, b] = k.split(".");
      if (b) (body.slots[a] ||= {})[b] = val;
      else body[a] = val;
    }
    for (const s of SLOTS) {
      const sl = (body.slots[s.key] ||= {});
      sl.needed = Boolean(form.elements[`${s.key}.needed`].checked);
    }
    body.hosts = hostPick.value.values;
    body.porters = porterPick.value.values;
    body.everyone = porterPick.value.everyone;
    body.portersRaw = job.portersRaw || "";
    try {
      const r = await api(id ? `api/jobs/${encodeURIComponent(id)}` : "api/jobs", { method: id ? "PUT" : "POST", body });
      toast("Saved");
      await refresh(true);
      showDetail(r.job.id);
    } catch (err) { toast(err.message); }
  });
}

let hostList = [];
async function loadHosts() {
  try { hostList = (await api("api/hosts")).hosts; } catch { /* keep the last list */ }
  return hostList;
}

async function deleteJob(id) {
  const job = state.jobs.find((j) => j.id === id);
  const what = [job?.location, (job?.hosts || []).join(", ")].filter(Boolean).join(" – ") || "this job";
  if (!confirm(`Delete ${what}? Its ticks are deleted too. This can't be undone.`)) return;
  try {
    await api(`api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeSheet();
    toast("Deleted");
    refresh(true);
  } catch (e) { toast(e.message); }
}

async function showShots() {
  const up = dayUpload();
  if (!up?.images?.length) return;
  sheet.dataset.kind = "shots";
  openSheet("Original screenshot", `<div style="color:var(--muted);font-size:14px;padding-top:12px">Tap to zoom. Uploaded by ${esc(up.by || "someone")} ${up.at ? ago(up.at) : ""}.</div><div class="shots" id="shots">${up.images.map(() => `<div class="shot"><div class="spinner" style="margin:30px auto"></div></div>`).join("")}</div>`);
  const holders = [...document.querySelectorAll("#shots .shot")];
  up.images.forEach(async (name, i) => {
    try {
      const res = await fetch(`api/images/${encodeURIComponent(name)}`, { headers: { "x-team-pin": pin } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      holders[i].innerHTML = `<img src="${url}" alt="Agenda screenshot ${i + 1}">`;
      holders[i].addEventListener("click", () => holders[i].classList.toggle("zoom"));
    } catch { holders[i].innerHTML = `<div style="padding:20px">Could not load image.</div>`; }
  });
}

function showMenu() {
  sheet.dataset.kind = "menu";
  openSheet("Menu", `<ul class="menu-list">
    ${isAdmin() ? `<li><button data-act="upload">${icon("upload")}<span>Upload agenda<small>Screenshot from the group chat, or the sheet file</small></span></button></li>
    <li><button data-act="add">${icon("plus")}<span>Add a job by hand</span></button></li>
    <li><a href="admin.html">${icon("table")}<span>Admin dashboard</span></a></li>` : ""}
    ${dayUpload()?.images?.length ? `<li><button data-act="shots">${icon("image")}<span>View original screenshot</span></button></li>` : ""}
    ${pushMenuItem()}
    <li><button data-act="refresh">${icon("refresh")}<span>Refresh</span></button></li>
    <li><button data-act="switch">${icon("user")}<span>Switch person<small>Signed in as ${esc(me)}</small></span></button></li>
  </ul>
  ${dayUpload()?.at ? `<p style="color:var(--muted);font-size:13px;margin-top:16px">Agenda uploaded by ${esc(dayUpload().by || "someone")} ${ago(dayUpload().at)}.</p>` : ""}`);
}

// ---------- upload ----------
const isImage = (f) => /^image\//.test(f.type) && !/\.(xlsx|csv)$/i.test(f.name);

async function shrink(file) {
  // Phones produce huge photos; keep the long edge readable but under the API's size limit.
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 2400;
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3.5e6 && /jpe?g|png|webp/.test(file.type)) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    return blob ? new File([blob], "agenda.jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

function showUpload() {
  sheet.dataset.kind = "upload";
  const hasJobs = state?.jobs?.length;
  openSheet("Upload agenda", `<form id="upForm">
    <label class="drop" for="upFiles">${icon("upload")}<b>Choose screenshot or sheet file</b><span>Save the image from WhatsApp and pick it here (several are fine if the agenda is long), or pick the spreadsheet itself (.xlsx / .csv) for an exact copy.</span></label>
    <input id="upFiles" class="sr" type="file" accept="image/*,.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" multiple>
    <div class="thumbs" id="thumbs"></div>
    ${hasJobs ? `
    <label class="choice"><input type="radio" name="mode" value="replace" checked><span><b>Replace the agenda</b><small>Use for a new day or an updated sheet. Ticks and assigned porters are kept for jobs that haven't changed.</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="append"><span><b>Add more rows</b><small>Use when the rest of the agenda is in another screenshot.</small></span></label>` : `<input type="hidden" name="mode" value="replace">`}
    <button class="btn primary block" id="upGo" type="submit" style="margin-top:16px" disabled>Read screenshot</button>
  </form>`);
  let files = [];
  $("#upFiles").addEventListener("change", (e) => {
    files = [...e.target.files].slice(0, 6);
    $("#thumbs").innerHTML = files.map((f) => isImage(f)
      ? `<img src="${URL.createObjectURL(f)}" alt="">`
      : `<span class="file-tile">${esc(f.name)}</span>`).join("");
    $("#upGo").disabled = !files.length;
    $("#upGo").textContent = !files.every(isImage) ? "Read file"
      : files.length > 1 ? `Read ${files.length} screenshots` : "Read screenshot";
  });
  $("#upForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const mode = new FormData(e.target).get("mode");
    $("#sheetBody").innerHTML = `<div class="working"><div class="spinner"></div><b>Reading the agenda…</b><div style="color:var(--muted);margin-top:6px">This usually takes a few seconds. Keep this screen open.</div></div>`;
    try {
      const fd = new FormData();
      fd.append("mode", mode);
      for (const f of files) fd.append("images", isImage(f) ? await shrink(f) : f);
      const r = await api("api/upload", { method: "POST", body: fd });
      await refresh(true);
      $("#sheetBody").innerHTML = `<div class="working"><div class="done-tick" style="width:52px;height:52px;margin:0 auto 14px">${icon("check")}</div>
        <b>Found ${r.count} job${r.count === 1 ? "" : "s"}</b><div style="color:var(--muted);margin-top:6px">Everyone's phone will update in a few seconds.<br>Give the cards a quick check against the screenshot.</div></div>
        ${r.warnings?.length ? `<div class="warn"><b>Double-check these:</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
        <button class="btn primary block" data-close style="margin-top:16px">Done</button>`;
    } catch (err) {
      $("#sheetBody").innerHTML = `<div class="working"><b>Couldn't read it</b><div style="color:var(--muted);margin-top:6px">${esc(err.message)}</div></div>
        <button class="btn primary block" data-act="upload" style="margin-top:16px">Try again</button>`;
    }
  });
}

// ---------- actions ----------
async function toggleTick(jobId, task) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || !canTick(job)) return toast("You can only tick your own jobs");
  const t = (state.ticks[jobId] ||= {});
  const done = !t[task];
  if (done) t[task] = { by: me, at: new Date().toISOString() }; else delete t[task];
  navigator.vibrate?.(done ? 12 : 6);
  rerenderAll();
  pending++;
  const before = state.version;
  try {
    const r = await api("api/tick", { method: "POST", body: { jobId, task, done } });
    state.ticks[jobId] = r.ticks;
    if (r.version === before + 1) state.version = r.version; else await refresh(true);
  } catch (e) {
    toast(/own jobs/.test(e.message) ? e.message : "Couldn't save – check your signal");
    await refresh(true);
  } finally {
    pending--;
    rerenderAll();
  }
}

function rerenderAll() {
  render();
  if (sheet.open && sheet.dataset.kind === "detail") {
    const y = $("#sheetBody").scrollTop;
    showDetail(sheet.dataset.job);
    $("#sheetBody").scrollTop = y;
  }
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act],[data-filter],[data-day],#showHidden");
  if (!el) return;
  if (el.id === "showHidden") { hideDone = false; store.set("hideDone", false); return render(); }
  if (el.dataset.filter !== undefined && !el.dataset.act) {
    filter = el.dataset.filter || null;
    store.set("filter", filter);
    render();
    window.scrollTo({ top: 0 });
    return;
  }
  if (el.dataset.day !== undefined) { selectedDay = el.dataset.day; return render(); }
  const id = el.dataset.job;
  switch (el.dataset.act) {
    case "tick": return toggleTick(id, el.dataset.task);
    case "detail": return showDetail(id);
    case "expand": expanded.add(id); return render();
    case "edit": return showEdit(id);
    case "add": return showEdit(null);
    case "delete": return deleteJob(id);
    case "upload": return showUpload();
    case "shots": return showShots();
    case "refresh": closeSheet(); return refresh(true).then(() => toast("Up to date"));
    case "switch": closeSheet(); return showLogin();
    case "push-on": return enablePush();
    case "push-off": return disablePush();
    case "push-later": store.set("pushLater", Date.now()); closeSheet(); return render();
  }
});
$("#menuBtn").addEventListener("click", showMenu);
$("#shotBtn").addEventListener("click", showShots);
$("#fab").addEventListener("click", showUpload);
$("#hideDoneBtn").addEventListener("click", () => { hideDone = !hideDone; store.set("hideDone", hideDone); render(); });

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------- sync ----------
function setSync(ok) {
  $("#syncDot").className = "dot " + (ok ? "ok" : "bad");
  $("#syncText").textContent = ok
    ? (dayUpload()?.at ? `Live · updated ${ago(dayUpload().at)}` : "Live")
    : "Offline – showing last copy";
}
async function refresh(force) {
  try {
    const d = await api(`api/state?since=${force ? 0 : state?.version || 0}`);
    if (!d.unchanged) { state = d; store.set("cache", d); rerenderAll(); alertNewJobs(); }
    setSync(true);
  } catch (e) {
    if (e.message !== "Not logged in") setSync(false);
  }
}
setInterval(() => { if (document.visibilityState === "visible" && !pending && me) refresh(); }, 10000);
// The "Now" line, "in 20 min" and "late" badges follow the clock: redraw exactly when the
// minute changes, and straight away when the app comes back on screen (phones pause timers
// while the app is in the background).
let clockTimer;
function clockTick() {
  clearTimeout(clockTimer);
  if (document.visibilityState === "visible" && me && state && !pending && !$("#app").hidden) {
    rerenderAll();
    setSync(!$("#syncDot").classList.contains("bad"));
  }
  const now = new Date();
  clockTimer = setTimeout(clockTick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 250);
}
clockTick();
function backOnScreen() {
  if (document.visibilityState !== "visible" || !me) return;
  clockTick();
  refresh();
}
document.addEventListener("visibilitychange", backOnScreen);
window.addEventListener("pageshow", backOnScreen);
window.addEventListener("focus", backOnScreen);
// tapping a notification while the app is open
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "refresh" && me) refresh(true); });

// ---------- login ----------
let pickName = null;
function showLogin(msg) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  closeSheet();
  pickName = me;
  $("#pinWrap").hidden = !cfg.pinRequired;
  $("#loginErr").textContent = msg || "";
  const draw = () => {
    $("#loginNames").innerHTML = cfg.porters.map((p) => `<button type="button" data-name="${esc(p)}" aria-pressed="${p === pickName}" style="--c:${colorOf(p)}"><span class="av">${initial(p)}</span>${esc(p)}</button>`).join("");
    $("#loginBtn").disabled = !pickName;
  };
  $("#loginNames").onclick = (e) => {
    const b = e.target.closest("[data-name]");
    if (!b) return;
    pickName = b.dataset.name;
    draw();
    if (cfg.pinRequired && !$("#pin").value) $("#pin").focus();
  };
  draw();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("#pin").value.trim();
  try {
    const res = await fetch("api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: p }) });
    if (!res.ok) { $("#loginErr").textContent = "That PIN isn't right."; return; }
  } catch { $("#loginErr").textContent = "Can't reach the server. Check your signal."; return; }
  const switched = me !== pickName;
  me = pickName; pin = p;
  store.set("me", me); store.set("pin", pin);
  if (switched) syncPush();
  if (switched) { filter = me; store.set("filter", filter); }
  startApp();
});

function startApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const cached = store.get("cache", null);
  if (cached && !state) { state = cached; render(); }
  refresh(true);
}

(async function boot() {
  try {
    cfg = await (await fetch("api/config")).json();
  } catch { /* offline: fall back to defaults */ cfg.porters = ["Tom", "Jeet", "Robinson", "Pablo", "Ricardo", "Wilson"]; }
  if (filter && filter !== "__none" && !cfg.porters.includes(filter)) filter = null;
  if (me && (pin || !cfg.pinRequired)) { startApp(); syncPush(); } else showLogin();
})();

// ---------- new-job alerts (in the app) ----------
// While the app is open: buzz and show a message when a job is newly given to me.
function alertNewJobs() {
  if (!me || !state) return;
  const key = `seen.${me}`;
  const mine = state.jobs.filter((j) => (j.date || "") >= state.today && (j.everyone || j.porters?.some((p) => p.name === me)));
  const ids = mine.map((j) => j.id);
  const seen = store.get(key, null);
  store.set(key, ids);
  if (!seen) return; // first time on this phone: nothing is "new"
  const fresh = mine.filter((j) => !seen.includes(j.id));
  if (!fresh.length) return;
  navigator.vibrate?.([120, 60, 120]);
  const j = fresh[0];
  const t = jobTimes(j).start;
  toast(fresh.length === 1
    ? `New job for you: ${t != null ? fmtMin(t) + " · " : ""}${j.location || j.host || ""}`
    : `${fresh.length} new jobs for you`);
}

// ---------- push notifications ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && Boolean(cfg.pushKey);
const pushOn = () => pushSupported() && Notification.permission === "granted" && store.get("pushOn", false);

function pushPromptHTML() {
  if (pushOn() || Date.now() - store.get("pushLater", 0) < 3 * 86400000) return "";
  if (pushSupported() && Notification.permission === "denied") return "";
  if (isIOS && !standalone) {
    return `<div class="banner tip"><div><b>Get notified about new jobs</b>On iPhone: tap Share, then <i>Add to Home Screen</i>. Open Porters from the new icon and turn notifications on.</div><button class="act" data-act="push-later">Later</button></div>`;
  }
  if (!pushSupported()) return "";
  return `<div class="banner tip"><div><b>Get notified about new jobs</b>Your phone will buzz when you're given a job, even with the app closed.</div><div class="acts"><button class="act" data-act="push-on">Turn on</button><button class="act muted" data-act="push-later">Later</button></div></div>`;
}

function pushMenuItem() {
  if (isIOS && !standalone) return `<li><button data-act="push-later">${icon("bell")}<span>Notifications<small>Add this app to your Home Screen first (Share → Add to Home Screen)</small></span></button></li>`;
  if (!pushSupported()) return "";
  if (Notification.permission === "denied") return `<li><button>${icon("bell")}<span>Notifications are blocked<small>Allow them for this site in your phone's settings</small></span></button></li>`;
  return pushOn()
    ? `<li><button data-act="push-off">${icon("bell")}<span>Notifications are on<small>Tap to turn off on this phone</small></span></button></li>`
    : `<li><button data-act="push-on">${icon("bell")}<span>Turn on notifications<small>Get a message when you're given a job</small></span></button></li>`;
}

function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscription(create) {
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.pushKey) });
  return sub;
}

async function enablePush() {
  closeSheet();
  if (!pushSupported()) return toast(isIOS ? "Add the app to your Home Screen first" : "This browser can't do notifications");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications weren't allowed"); return render(); }
    const sub = await subscription(true);
    await api("api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    store.set("pushOn", true);
    render();
    await api("api/push/test", { method: "POST" });
    toast("Notifications are on");
  } catch (e) {
    console.error(e);
    toast("Couldn't turn on notifications");
  }
}

async function disablePush() {
  closeSheet();
  try {
    const sub = await subscription(false);
    if (sub) {
      await api("api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* already off */ }
  store.set("pushOn", false);
  toast("Notifications are off on this phone");
  render();
}

/** Keeps the server's record of "this phone belongs to <me>" up to date. */
async function syncPush() {
  if (!pushOn() || !me) return;
  try {
    const sub = await subscription(false);
    if (sub) await api("api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    else store.set("pushOn", false);
  } catch { /* try again next time */ }
}
