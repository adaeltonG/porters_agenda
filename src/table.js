// Turns a table of cell texts (from a screenshot or a spreadsheet file) into agenda rows.
// Shared by both readers so they understand the sheet exactly the same way.

// The sheet's usual column order, used to fill in any header we couldn't read.
export const STD_COLUMNS = [
  "owner", "requestor", "eventLead", "date", "host", "vendor",
  "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp",
  "location", "attendees", "info", "porters", "setup", "reset", "agenda", "floorPlan",
];

// Checked in this order: the specific time columns first ("Lunch - Time to be served"
// must not match "served"/"time" of another column), "info/menu" last.
const HEADER_PATTERNS = [
  ["teaCoffee", /tea|coffee|water/],
  ["breakfast", /breakfast/],
  ["lunch", /lunch/],
  ["afternoon", /afternoon/],
  ["clearUp", /clear/],
  ["owner", /owner/],
  ["requestor", /request/],
  ["eventLead", /lead/],
  ["date", /date/],
  ["host", /host/],
  ["vendor", /vendor/],
  ["location", /locat/],
  ["attendees", /attend|no\W*of/],
  ["porters", /porter|assigned/],
  ["setup", /set\s*up/],
  ["reset", /reset/],
  ["agenda", /agenda/],
  ["floorPlan", /floor/],
  ["info", /info|menu/],
];

const SLOTS = ["teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "setup", "reset"];
const WEEKDAY = /^(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b/i;

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function matchHeader(text) {
  const t = norm(text).toLowerCase();
  if (!t) return null;
  for (const [key, re] of HEADER_PATTERNS) if (re.test(t)) return key;
  return null;
}

/** If this row looks like the header, returns column index -> field name. */
function headerMap(cells) {
  const found = cells.map((c) => matchHeader(c?.text));
  const hits = found.filter(Boolean);
  if (new Set(hits).size < 5) return null;
  const map = new Array(cells.length).fill(null);
  const used = new Set();
  found.forEach((k, i) => { if (k && !used.has(k)) { map[i] = k; used.add(k); } });
  // Fill unread headers from the nearest read one, assuming the usual order.
  for (let i = 0; i < map.length; i++) {
    if (map[i]) continue;
    for (let d = 1; d < map.length; d++) {
      for (const j of [i - d, i + d]) {
        if (map[j] && found[j] === map[j]) {
          const k = STD_COLUMNS[STD_COLUMNS.indexOf(map[j]) + (i - j)];
          if (k && !used.has(k)) { map[i] = k; used.add(k); }
          d = map.length; break;
        }
      }
    }
  }
  return map;
}

// ---------- value parsing ----------

function toHHMM(h, m, mer) {
  h = Number(h); m = Number(m || 0);
  mer = (mer || "").toLowerCase().replace(/\./g, "");
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (!mer && h >= 1 && h <= 6) h += 12; // "2:30" on an agenda means the afternoon
  if (h > 23 || m > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// 12:30 · 8:00am · 13:15:00 · 13.00 · 3pm  (a bare number is not a time)
const TIME_RE = /(?<![\d/])(\d{1,2})\s*(?:[:.]\s*(\d{2})(?:[:.]\d{2})?\s*(a\.?m\.?|p\.?m\.?)?|\s*(a\.?m\.?|p\.?m\.?))(?![\d/])/gi;

function findTimes(text) {
  const out = [];
  for (const m of text.matchAll(TIME_RE)) {
    const t = toHHMM(m[1], m[2], m[3] || m[4]);
    if (t) out.push({ time: t, index: m.index, length: m[0].length });
  }
  return out;
}

/** "N" / "-" / blank = not needed. Otherwise the first time, plus any other text as a note. */
export function parseSlot(raw) {
  const text = norm(raw);
  if (!text || /^(n|no|-+|n\/a|none|x)$/i.test(text)) return { needed: false, time: "", note: "" };
  if (/^(y|yes|tbc)$/i.test(text)) return { needed: true, time: "", note: /tbc/i.test(text) ? "TBC" : "" };
  const times = findTimes(text);
  if (!times.length) return { needed: true, time: "", note: text };
  const first = times[0];
  // "8:00 - 9:00" / "2:30 to 3pm" (optionally followed by a note)
  if (times.length >= 2 && !norm(text.slice(0, first.index))) {
    const between = text.slice(first.index + first.length, times[1].index);
    const after = norm(text.slice(times[1].index + times[1].length)).replace(/^[\s,.;:-]+/, "");
    if (/^\s*(-|–|—|to|till|until)\s*$/i.test(between)) {
      return { needed: true, time: first.time, note: `until ${times[1].time}${after ? `. ${after}` : ""}` };
    }
  }
  const before = norm(text.slice(0, first.index));
  const rest = norm(text.slice(0, first.index) + " " + text.slice(first.index + first.length));
  // keep the full text when the time is labelled ("B: 9:30 L: 1:30") or there are several times
  const note = /^[A-Za-z0-9]{1,3}\s*:$/.test(before) ? text : rest.replace(/^[\s,.;:-]+/, "");
  return { needed: true, time: first.time, note };
}

export function parseDate(raw) {
  const m = /(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/.exec(norm(raw));
  if (!m) return "";
  let [, d, mo, y] = m.map(Number);
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseOwner(raw) {
  const t = norm(raw).toLowerCase();
  if (/hosp/.test(t)) return "Hospitality";
  if (/mov/.test(t)) return "Movers";
  if (/both|^b?oth/.test(t)) return "Both";
  return "Other";
}

// ---------- OCR clean-up (screenshots only) ----------

export function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** "Robinsom" -> "Robinson", "Jeat" -> "Jeet" */
function fixPorterNames(text, porters) {
  return text.replace(/[A-Za-z]{3,}/g, (w) => {
    let best = null, bestD = 99;
    for (const p of porters) {
      const d = levenshtein(w.toLowerCase(), p.toLowerCase());
      if (d < bestD) { best = p; bestD = d; }
    }
    return best && bestD <= (best.length >= 6 ? 2 : 1) ? best : w;
  });
}

/** "32-Co8" -> "32-C08", "28C19" -> "28-C19" */
function fixRoom(text) {
  return text.replace(/\b(L?\d{2})\s*[-.]?\s*[cC]\s*([0-9oOlI]{2})\b/g, (_, a, b) =>
    `${a}-C${b.replace(/[oO]/g, "0").replace(/[lI]/g, "1")}`);
}

function fixOcrWords(text) {
  return text
    .replace(/\bMen[uyv]\b/g, "Menu")
    .replace(/\bMEN[UYV]\b/g, "MENU")
    .replace(/\b([Aa])(?:il|li|i1|1l|l1|ii|11)ergen\b/g, "$1llergen");
}

/** In a time like "12:1¢" or "l3:OO", letters that look like digits are digits. */
export function fixOcrTimes(text) {
  const digit = { O: "0", o: "0", D: "0", l: "1", I: "1", "|": "1", S: "5", s: "5", "¢": "5", B: "8", Z: "2" };
  return text.replace(/\b([\dOolI]{1,2})\s*([:.])\s*([\dOoDlIS¢B|Z]{2})(?![A-Za-z])/g, (m, h, sep, mm) => {
    const fix = (s) => s.replace(/./g, (c) => digit[c] ?? c);
    const out = `${fix(h)}${sep}${fix(mm)}`;
    return /^\d{1,2}[:.]\d{2}$/.test(out) ? out : m;
  });
}

/** File chips show as an icon + "MENU - ..." etc.; the icon reads as a stray symbol. */
function cleanChipLine(line) {
  return line
    .replace(/^[^A-Za-z0-9"“(]+/, "")
    .replace(/^(?:[0-9A-Za-z]{1,2}\s+|[0-9](?=AM\b))(?=(AM|MENU|Menu|Allergen)\b)/, "")
    .replace(/^["“]/, "")
    .trim();
}

// ---------- rows ----------

/**
 * table: array of rows, each an array of cells { text, link?, span? } indexed by column.
 * Returns { rows, warnings, map } in the shape extract.js / server.js expect.
 */
export function interpretTable(table, { ocr = false, porters = [], map: givenMap = null, label = "" } = {}) {
  let map = givenMap;
  const rows = [];
  const warnings = [];
  let lastDate = "";

  for (const cells of table) {
    const nonEmpty = cells.filter((c) => norm(c?.text));
    if (!nonEmpty.length) continue;

    const hm = headerMap(cells);
    if (hm) { map = hm; continue; }

    // day headings like "THURSDAY" (one wide merged cell, or a weekday on its own)
    const first = norm(nonEmpty[0].text);
    if (nonEmpty.length === 1 && (WEEKDAY.test(first) || (nonEmpty[0].span || 1) >= cells.length / 2)) continue;
    if (!map) continue; // rows above the header (titles, notes)

    const f = {};
    const links = {};
    cells.forEach((c, i) => {
      const key = map[i];
      if (!key || !c) return;
      const text = String(c.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      f[key] = text;
      if (c.link) links[key] = true;
    });
    const get = (k, sep = " ") => norm((f[k] || []).join(sep));

    const row = {
      date: "",
      owner: parseOwner(get("owner")),
      requestor: get("requestor"),
      eventLead: get("eventLead"),
      host: get("host"),
      vendor: get("vendor"),
      location: get("location", ", ").replace(/,\s*,/g, ",").replace(/([:-])\s*,/g, "$1"),
      attendees: get("attendees"),
      info: "",
      porters: get("porters").replace(/(,\s*){2,}/g, ", ").replace(/^[,\s]+|[,\s]+$/g, ""),
      hasMenuLink: false,
      hasAgendaLink: false,
      hasFloorPlanLink: false,
    };
    for (const s of SLOTS) row[s] = parseSlot(ocr ? fixOcrTimes(get(s)) : get(s));

    let infoLines = f.info || [];
    if (ocr) {
      infoLines = infoLines.map((l) => fixOcrWords(cleanChipLine(l))).filter(Boolean);
      row.location = fixRoom(row.location);
      row.porters = fixPorterNames(row.porters, porters);
      row.vendor = fixOcrWords(row.vendor);
    }
    // wrapped lines of one sentence are rejoined; separate chips/notes get ". " between them
    row.info = norm(infoLines.reduce((acc, line) => {
      if (!acc) return line;
      const join = /([.!?,:;&-]|\b(and|or|with|for|of|the|to|a|at|in))$/i.test(acc) || /^[a-z0-9(]/.test(line) ? " " : ". ";
      return acc + join + line;
    }, ""));
    row.hasMenuLink = Boolean(links.info) || /menu|allergen|matrix|\bAM\b|\.\.\./i.test(row.info);
    if (/^n$/i.test(row.info)) { row.info = ""; row.hasMenuLink = false; }

    for (const [key, flag] of [["agenda", "hasAgendaLink"], ["floorPlan", "hasFloorPlanLink"]]) {
      const t = get(key);
      if (links[key] || /^(link\s*)?h[ea]re?\b|\blink\b|http|www\.|\.pdf/i.test(t)) row[flag] = true;
      else if (t && !/^(n|-)$/i.test(t)) row.info = norm(`${row.info}${row.info ? ". " : ""}${t}`);
    }

    const attendees = /\d+/.exec(row.attendees);
    if (attendees && row.attendees.length <= 6) row.attendees = attendees[0];

    row.date = parseDate(get("date")) || lastDate;
    if (row.date) lastDate = row.date;

    // a row needs something to act on
    const anySlot = SLOTS.some((s) => row[s].needed);
    if (!row.host && !row.location && !row.porters && !anySlot) continue;

    const name = [row.host, row.location].filter(Boolean).join(" · ") || "a row";
    if (!row.date) warnings.push(`${label}Couldn't read a date for ${name}.`);
    if (!row.location) warnings.push(`${label}Couldn't read a location for ${name}.`);
    rows.push(row);
  }

  // rows before the first dated one get the first date we saw
  const firstDate = rows.find((r) => r.date)?.date || "";
  for (const r of rows) r.date ||= firstDate;
  return { rows, warnings, map };
}

/** Same job seen twice (overlapping screenshots, or two sheet tabs) -> keep the first. */
export function dedupe(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = [r.date, r.owner, r.host, r.location].join("|").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * A spreadsheet can hold a whole week. Keep today's rows; if there are none, the next day
 * that has rows; failing that, the latest day.
 */
export function pickDay(rows, today) {
  const dates = [...new Set(rows.map((r) => r.date).filter(Boolean))].sort();
  if (dates.length <= 1) return { rows, note: "" };
  const day = dates.includes(today) ? today : dates.find((d) => d > today) || dates.at(-1);
  const kept = rows.filter((r) => r.date === day);
  return { rows: kept, note: `The file has ${dates.length} days; showing ${day.split("-").reverse().join("/")} (${kept.length} jobs).` };
}
