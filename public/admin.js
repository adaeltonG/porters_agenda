// Porters Agenda - admin dashboard
import { multiPicker } from "./picker.js";

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
let tab = "agenda";
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
  const headers = { "x-admin-pin": adminPin, ...(opts.headers || {}) };
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
    if ([...pickers.values()].some((p) => p.isOpen())) { deferred = true; return; }
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
  $("#dayTitle").textContent = (isToday ? "Today · " : "") + fmtDay(date);
  $("#shotBtn").hidden = !day.upload?.images?.length;

  const jobs = [...day.jobs].map((j) => ({ j, t: times(j) }))
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
    ${day.upload ? `<span>Uploaded by ${esc(day.upload.by)} at ${fmtClock(day.upload.at)}</span>` : ""}` : "";

  // notices
  let notices = "";
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No jobs on this day. ${date >= day.today ? "Upload the agenda or add a job." : ""}</td></tr>`;
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
      <td class="loc">${esc(j.location || "–")}<span class="own">${esc(j.owner === "Other" ? "" : j.owner)}${j.vendor ? ` · ${esc(j.vendor)}` : ""}</span></td>
      <td>${esc((j.hosts || []).join(", ") || j.host || "–")}</td>
      <td>${esc(j.attendees || "")}</td>
      <td><div class="tasks-cell">${tasks.map((t) => {
        const tk = ticks[t.key];
        const late = !tk && isToday && t.time && toMin(t.time) < now - 10;
        const title = tk ? `Ticked by ${tk.by} at ${fmtClock(tk.at)}` : `${SHORT[t.key]}${t.time ? " at " + t.time : ""}${t.note ? " – " + t.note : ""}. Click to tick.`;
        return `<button class="tk${tk ? " on" : ""}${late ? " late" : ""}" data-act="tick" data-job="${esc(j.id)}" data-task="${t.key}" title="${esc(title)}">
          <span class="bx">${icon("check")}</span>${t.time ? `${esc(t.time)} ` : ""}${SHORT[t.key]}${tk ? ` <small>${esc(tk.by)} ${fmtClock(tk.at)}</small>` : ""}</button>`;
      }).join("")}</div></td>
      <td class="porters-cell"><div class="pp" data-job="${esc(j.id)}"></div>${j.portersRaw ? `<div class="raw">Sheet: ${esc(j.portersRaw)}</div>` : ""}</td>
      <td class="nt"><div>${esc(j.info || "")}</div></td>
      <td><button class="icon-btn" data-act="edit" data-job="${esc(j.id)}" aria-label="Edit job">${icon("edit")}</button></td>
    </tr>`;
  }).join("");

  // porter dropdowns: saved as soon as they change
  for (const el of tbody.querySelectorAll(".pp")) {
    const job = day.jobs.find((x) => x.id === el.dataset.job);
    let timer;
    const pk = multiPicker(el, {
      options: day.porters, selected: (job.porters || []).map((p) => p.name), everyone: true, everyoneOn: job.everyone,
      placeholder: "Assign porters", label: `Porters for ${job.location || job.host}`,
      onChange: (v) => {
        clearTimeout(timer);
        timer = setTimeout(() => savePorters(job.id, v), 700);
      },
    });
    pickers.set(job.id, pk);
  }
}

async function savePorters(id, v) {
  try {
    await api(`api/jobs/${encodeURIComponent(id)}/porters`, { method: "PUT", body: { porters: v.values, everyone: v.everyone } });
    toast(v.everyone ? "Assigned to everyone" : v.values.length ? `Assigned: ${v.values.join(", ")}` : "Porters removed");
    loadDay();
  } catch (e) { toast(e.message); }
}

// re-draw once the dropdown that blocked a live update is closed
document.addEventListener("pointerup", () => setTimeout(() => {
  if (deferred && ![...pickers.values()].some((p) => p.isOpen())) renderAgenda();
}, 800));

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
    <div class="grid2">
      <label class="f">Location<input class="in" name="location" value="${v("location")}" required></label>
      <label class="f">Guests<input class="in" name="attendees" inputmode="numeric" value="${v("attendees")}"></label>
      <label class="f">Vendor<input class="in" name="vendor" value="${v("vendor")}"></label>
      <label class="f">Team<select class="in" name="owner">${["Hospitality", "Movers", "Both", "Other"].map((o) => `<option${job.owner === o ? " selected" : ""}>${o}</option>`).join("")}</select></label>
      <label class="f">Date<input class="in" type="date" name="date" value="${v("date")}" required></label>
      <label class="f">Requestor<input class="in" name="requestor" value="${v("requestor")}"></label>
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
        <input class="in" type="time" name="${s.key}.time" value="${esc(sl.time || "")}" aria-label="${esc(s.label)} time">
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
  const hostPick = multiPicker($("#hostPick"), {
    options: day.hosts, selected: job.hosts || (job.host ? [job.host] : []), allowNew: true,
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
  if (!confirm("Delete this job? Its ticks are deleted too.")) return;
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
    <label class="drop" for="upFiles">${icon("upload")}<b>Choose screenshot or sheet file</b><span>A screenshot of the sheet (several are fine), or the spreadsheet itself (.xlsx / .csv) for an exact copy. Porter names in the sheet are read; anything without porters can be assigned here afterwards.</span></label>
    <input id="upFiles" class="sr" type="file" accept="image/*,.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" multiple>
    <div class="thumbs" id="thumbs"></div>
    <label class="choice"><input type="radio" name="mode" value="replace" checked><span><b>Replace that day's agenda</b><small>For a new day or an updated sheet. Ticks and porters you assigned are kept for jobs that haven't changed; jobs added by hand stay.</small></span></label>
    <label class="choice"><input type="radio" name="mode" value="append"><span><b>Add more rows</b><small>When the rest of the agenda is in another screenshot.</small></span></label>
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
    const mode = new FormData(e.target).get("mode");
    $("#sheetBody").innerHTML = `<div class="working"><div class="spinner"></div><b>Reading the agenda…</b><div style="color:var(--muted);margin-top:6px">Usually a few seconds.</div></div>`;
    try {
      const fd = new FormData();
      fd.append("mode", mode);
      for (const f of files) fd.append("images", isImage(f) ? await shrink(f) : f);
      const r = await api("api/upload", { method: "POST", body: fd });
      if (r.dates?.length && !r.dates.includes(date)) date = r.dates[0];
      await loadDay(true);
      $("#sheetBody").innerHTML = `<div class="working"><div class="done-tick" style="width:52px;height:52px;margin:0 auto 14px">${icon("check")}</div>
        <b>Found ${r.count} job${r.count === 1 ? "" : "s"}${r.dates?.length ? ` for ${r.dates.map((d) => fmtDay(d, { weekday: "short", day: "numeric", month: "short" })).join(", ")}` : ""}</b>
        <div style="color:var(--muted);margin-top:6px">${r.unassigned ? `${r.unassigned} job${r.unassigned > 1 ? "s have" : " has"} no porters yet – assign them in the table.` : "Every job has porters."}</div></div>
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

async function showShots() {
  const up = day?.upload;
  if (!up?.images?.length) return;
  openSheet("Original screenshot", `<div class="shots" id="shots">${up.images.map(() => `<div class="shot"><div class="spinner" style="margin:30px auto"></div></div>`).join("")}</div>`, true);
  const holders = [...document.querySelectorAll("#shots .shot")];
  up.images.forEach(async (name, i) => {
    try {
      const res = await fetch(`api/images/${encodeURIComponent(name)}`, { headers: { "x-admin-pin": adminPin } });
      if (!res.ok) throw new Error();
      holders[i].innerHTML = `<img src="${URL.createObjectURL(await res.blob())}" alt="Agenda screenshot ${i + 1}">`;
      holders[i].addEventListener("click", () => holders[i].classList.toggle("zoom"));
    } catch { holders[i].innerHTML = `<div style="padding:20px">Could not load image.</div>`; }
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
      return `<li class="${p.active ? "" : "off"}"><span class="nm">${esc(p.name)}</span>
        <span class="meta">${icon("bell")} ${n ? `${n} phone${n > 1 ? "s" : ""}` : "no notifications"}</span>
        <button class="btn small${p.active ? " danger" : ""}" data-act="porter-toggle" data-id="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? "Remove" : "Bring back"}</button></li>`;
    }).join("");
  } catch (e) { toast(e.message); }
}

// ---------- tabs & events ----------
function showTab(t) {
  tab = t;
  for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-pressed", b.dataset.tab === t);
  for (const s of ["agenda", "history", "hosts", "porters"]) $(`#tab-${s}`).hidden = s !== t;
  history.replaceState(null, "", `#${t}${t === "agenda" && date ? "/" + date : ""}`);
  if (t === "agenda") loadDay(true);
  if (t === "history") loadHistory();
  if (t === "hosts") loadHosts();
  if (t === "porters") loadPorters();
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
  if (go) { date = go.dataset.goto; return showTab("agenda"); }
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const id = el.dataset.job;
  switch (el.dataset.act) {
    case "tick": return tick(id, el.dataset.task);
    case "edit": return showEdit(id);
    case "delete": return deleteJob(id);
    case "upload": return showUpload();
    case "add-day-hosts": return addDayHosts();
    case "add-new-hosts": return addCheckedHosts(el.closest(".unlisted"));
    case "host-del":
      if (!confirm(`Remove ${el.dataset.name} from the host list? Past agendas keep the name.`)) return;
      try { await api(`api/admin/hosts/${el.dataset.id}`, { method: "DELETE" }); loadHosts(); } catch (err) { toast(err.message); }
      return;
    case "host-rename": {
      const name = prompt("New spelling", el.dataset.name);
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
$("#shotBtn").addEventListener("click", showShots);
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
$("#logout").addEventListener("click", () => { store.del("adminPin"); adminPin = ""; showLogin(); });

// live updates: ticks from the porters' phones show up within a few seconds
setInterval(() => { if (adminPin && tab === "agenda" && document.visibilityState === "visible" && !sheet.open) loadDay(); }, 4000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && adminPin && tab === "agenda") loadDay(); });

// ---------- login ----------
function showLogin(msg) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#loginErr").textContent = msg || "";
  $("#pin").value = "";
  $("#pin").focus();
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("#pin").value.trim();
  try {
    const res = await fetch("api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: p }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { $("#loginErr").textContent = data.error || "That PIN isn't right."; return; }
  } catch { $("#loginErr").textContent = "Can't reach the server."; return; }
  adminPin = p;
  store.set("adminPin", p);
  start();
});

function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const [t, d] = location.hash.slice(1).split("/");
  date = /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : localToday();
  showTab(["agenda", "history", "hosts", "porters"].includes(t) ? t : "agenda");
}

if (adminPin) start(); else showLogin();
