// Reads the weekly staff rota (a screenshot or the spreadsheet) and says who works when.
//
//   November | 23rd | 24th | ...          <- header: month + day numbers
//   Tom      | PM (9am to 6pm) | AM | ...  <- one row per person, one code per day
//
// Codes: AM = 06:30-15:30, PM = 09:00-18:00, "DSQ" after either = working at DSQ that day.
// PTO (time off), SIC (Level 37 post), SICK, OFF, a blank or a black cell = no tasks that day.
import { isSheetFile, readSheetFile } from "./sheetfile.js";
import { levenshtein } from "./table.js";

export const SHIFTS = {
  AM: { from: "06:30", to: "15:30" },
  PM: { from: "09:00", to: "18:00" },
};
export const SITES = { tower: "The Tower", dsq: "DSQ" };
/** What the dashboard offers in each rota cell. */
export const CODES = ["AM", "PM", "AM DSQ", "PM DSQ", "PTO", "SIC", "SICK", "OFF"];
const CODE_LABEL = { PTO: "PTO", SIC: "SIC", SICK: "Sick", OFF: "Off" };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Cell text (and whether it's filled black) -> a code from CODES, or other short text. */
export function normCode(text, dark = false) {
  const t = norm(text).toUpperCase();
  if (!t) return "OFF"; // blank or blacked out: not working
  if (/\bPTO\b|HOLIDAY|\bA\/?L\b|ANNUAL|LEAVE|VACATION/.test(t)) return "PTO";
  if (/\bSICK\b|\bILL\b/.test(t)) return "SICK";
  if (/^S[I1L|]C$/.test(t) || /\bSIC\b/.test(t)) return "SIC";
  if (/\bOFF\b|\bRD\b|\bREST\b/.test(t)) return "OFF";
  // "9AM" doesn't match \bAM\b, so "PM (9am to 6pm)" is a PM shift
  const shift = /\b(AM|PM)\b/.exec(t);
  if (shift) return shift[1] + (/\bD\s?[S5]\s?[QO0]\b/.test(t) ? " DSQ" : "");
  return dark ? "OFF" : t.slice(0, 24);
}

/** A code -> { in, site, from, to, label }. Only AM / PM shifts get tasks. */
export function parseCode(code) {
  const m = /^(AM|PM)( DSQ)?$/.exec(code || "");
  if (m) return { in: true, site: m[2] ? "dsq" : "tower", ...SHIFTS[m[1]], label: code };
  return { in: false, site: null, from: null, to: null, label: CODE_LABEL[code] || code || "Off" };
}

// ---------- reading the table ----------

/** "23rd" / "29tt" (OCR) / "Mon 23" / "23/11" -> { day, month? } */
function dayOf(text) {
  const t = norm(text);
  let m = /^(?:[A-Za-z]{2,9}\.?,?\s+)?(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*\d{2,4})?$/.exec(t);
  if (m && Number(m[1]) <= 31 && Number(m[2]) <= 12) return { day: Number(m[1]), month: Number(m[2]) };
  m = /^(?:[A-Za-z]{2,9}\.?,?\s+)?(\d{1,2})\s*(?:st|nd|rd|th|[a-z]{1,2})?\.?$/i.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) return { day: Number(m[1]) };
  return null;
}
const monthIn = (text) => {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(norm(text));
  return m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
};

/** The year (and month, if unknown) that puts day/month closest to today. */
function nearest(day, month, today) {
  const t = new Date(today + "T12:00:00Z");
  let best = null;
  for (let dy = -1; dy <= 1; dy++) {
    for (const mo of month ? [month] : Array.from({ length: 12 }, (_, i) => i + 1)) {
      const d = new Date(Date.UTC(t.getUTCFullYear() + dy, mo - 1, day, 12));
      if (d.getUTCDate() !== day) continue; // 31st of a short month
      const dist = Math.abs(d - t);
      if (!best || dist < best.dist) best = { dist, y: d.getUTCFullYear(), m: mo };
    }
  }
  return best;
}

/** Day columns of a header row -> Map(column index -> ISO date), or null if it isn't one. */
function headerDates(cells, above, today) {
  const days = [];
  cells.forEach((c, i) => { const d = i > 0 && dayOf(c?.text); if (d) days.push({ i, ...d }); });
  if (days.length < 3) return null;
  const month = monthIn(cells[0]?.text) || cells.map((c) => monthIn(c?.text)).find(Boolean) || above.map(monthIn).find(Boolean) || 0;
  const first = nearest(days[0].day, days[0].month || month, today);
  if (!first) return null;
  let y = first.y, m = first.m, prev = days[0].day;
  const out = new Map();
  for (const d of days) {
    if (d.month) { if (d.month < m && m === 12) y++; m = d.month; }
    else if (d.day < prev) { m++; if (m > 12) { m = 1; y++; } } // the week runs into the next month
    prev = d.day;
    out.set(d.i, iso(y, m, d.day));
  }
  return out;
}

const cleanName = (t) => norm(String(t || "").replace(/[^A-Za-z' .-]+/g, " ")).replace(/^[.'-]+|[.'-]+$/g, "");

/**
 * table: rows of cells { text, dark? }. Returns { people: [{ name, days: { date: code } }], dates, warnings }.
 * A rota can hold several weeks one under the other: each new header row starts a new block.
 */
export function interpretRota(table, today) {
  const people = new Map();
  const dates = new Set();
  const warnings = [];
  let cols = null;
  const above = [];
  for (const cells of table) {
    const head = headerDates(cells, above, today);
    if (head) { cols = head; continue; }
    if (!cols) { above.push(...cells.map((c) => c?.text || "")); continue; }
    const name = cleanName(cells[0]?.text);
    // the "M T W T F" row, or a title: not a person
    if (!name || name.length < 2 || /^([MTWFS]\s*){3,}$/i.test(name) || /^(name|staff|porters?|team)$/i.test(name)) continue;
    const key = name.toLowerCase();
    const person = people.get(key) || { name, days: {} };
    for (const [i, date] of cols) {
      const c = cells[i];
      person.days[date] = normCode(c?.text, c?.dark);
      dates.add(date);
    }
    people.set(key, person);
  }
  if (!dates.size) throw new Error("Couldn't find the rota's dates (a row like \"November | 23rd | 24th…\"). Include the top of the rota in the picture.");
  if (!people.size) throw new Error("Couldn't find anyone on the rota.");
  return { people: [...people.values()], dates: [...dates].sort(), warnings };
}

/** Files (screenshots or .xlsx/.csv) -> interpretRota's result. */
export async function readRota(files, today) {
  const tables = [];
  for (const f of files) {
    if (isSheetFile(f)) {
      for (const tab of await readSheetFile(f)) tables.push(tab.table);
    } else {
      const { readGrid } = await import("./screenshot.js");
      const grid = await readGrid(f.buffer, { merge: false, minColumns: 4 });
      tables.push(grid.rows.map((r) => {
        const cells = new Array(grid.columns.length).fill(null).map(() => ({ text: "" }));
        for (const c of r.cells) cells[c.col] = { text: c.text || "", dark: c.dark };
        return cells;
      }));
    }
  }
  let lastErr = null;
  const people = new Map(), dates = new Set(), warnings = [];
  for (const t of tables) {
    try {
      const r = interpretRota(t, today);
      for (const p of r.people) {
        const had = people.get(p.name.toLowerCase());
        people.set(p.name.toLowerCase(), had ? { ...had, days: { ...had.days, ...p.days } } : p);
      }
      r.dates.forEach((d) => dates.add(d));
      warnings.push(...r.warnings);
    } catch (e) { lastErr = e; }
  }
  if (!dates.size) throw lastErr || new Error("Couldn't read a rota from that.");
  return { people: [...people.values()], dates: [...dates].sort(), warnings };
}

/**
 * Which registered porter a rota name is: "Jeet Chand Mehay" -> Jeet, "Robinsom Ramos" -> Robinson.
 * porters: [{ name, fullName }]. Returns the porter or null (someone new).
 */
export function matchPorter(rotaName, porters) {
  const n = norm(rotaName).toLowerCase();
  const first = n.split(" ")[0];
  return porters.find((p) => p.name.toLowerCase() === n || (p.fullName && p.fullName.toLowerCase() === n))
    || porters.find((p) => p.name.toLowerCase() === first)
    || porters.find((p) => p.fullName && p.fullName.toLowerCase().split(" ")[0] === first && p.name.toLowerCase().split(" ")[0] === first)
    || porters.find((p) => p.name.length >= 4 && first.length >= 4 && levenshtein(p.name.toLowerCase(), first) <= 1)
    || null;
}

/** "carlos munera" -> "Carlos Munera" */
export const titleCase = (s) => norm(s).toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
