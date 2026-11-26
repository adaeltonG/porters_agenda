// Lunch breaks: one hour each, fitted around the day's agenda.
//
//  - The hour fits inside 10:30–14:30 and inside the person's shift.
//  - It never covers a task: a task at 12:00 keeps 11:30–12:00 free (30 min before it, nothing
//    after), so lunch can be 10:30–11:30 or from 12:15, but not 11:00–12:00.
//  - At most 2 people from the same building at lunch at once. 3 only when the tasks leave no
//    other way. Whoever is on Level 37 (SIC) gets an hour too, but doesn't use up a place.
//  - Early starters (AM, 06:30) go early, 9am starters later.
//  - The morning helper (Davina) has no lunch: her shift is too short.
// The caller keeps lunches the admin set by hand, and ones that have already started.

import { heldTasks } from "./autoassign.js";

export const LUNCH = { from: "10:30", to: "14:30", length: 60, step: 15, maxAtOnce: 2, before: 30 };

const LABEL = { setup: "Setup", teaCoffee: "Tea/coffee", breakfast: "Breakfast", lunch: "Lunch", afternoon: "Afternoon", clearUp: "Clear up", reset: "Reset", done: "Job" };
const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || "") ? Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) : null);
export const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const lc = (s) => String(s || "").trim().toLowerCase();

const W_FROM = toMin(LUNCH.from), W_TO = toMin(LUNCH.to), LEN = LUNCH.length, STEP = LUNCH.step;

/** Every timed task each person holds on the day: Map(lowercase name -> [{ min, what }]). "Everyone" jobs count for all. */
export function taskTimes(jobs, names) {
  const out = new Map(names.map((n) => [lc(n), []]));
  for (const job of jobs) {
    const holders = job.everyone ? names.map((n) => ({ name: n, roles: [] })) : job.porters || [];
    for (const p of holders) {
      const list = out.get(lc(p.name));
      if (!list) continue;
      for (const t of heldTasks(job, p)) {
        if (t.min == null) continue;
        list.push({ min: t.min, what: `${LABEL[t.key] || t.key} ${fmtMin(t.min)}${job.location || job.task ? ` · ${job.location || job.task}` : ""}` });
      }
    }
  }
  return out;
}

/** The tasks a lunch starting at `s` would get in the way of. */
export const clashesAt = (tasks, s) => (tasks || []).filter((t) => t.min >= s && t.min < s + LEN + LUNCH.before);

/** Possible start times for someone, every 15 minutes. */
export function startsFor(p) {
  const lo = Math.max(W_FROM, toMin(p.from) ?? 0);
  const hi = Math.min(W_TO, toMin(p.to) ?? 24 * 60) - LEN;
  const out = [];
  for (let s = Math.ceil(lo / STEP) * STEP; s <= hi; s += STEP) out.push(s);
  return out;
}

/** Halfway through the shift: 06:30 starters at 10:30, 9am starters at 13:00. */
function preferred(p) {
  const f = toMin(p.from), t = toMin(p.to);
  const mid = f != null && t != null ? (f + t) / 2 : 12 * 60 + 30;
  return Math.min(W_TO - LEN, Math.max(W_FROM, Math.round((mid - LEN / 2) / STEP) * STEP));
}

/** How many people (counting this one) are at lunch at the busiest moment of the hour from `s`. */
export function crowdAt(s, others) {
  let most = 0;
  for (let t = s; t < s + LEN; t += STEP) most = Math.max(most, others.filter((o) => o <= t && t < o + LEN).length);
  return most + 1;
}

function cost(p, s, tasks, others) {
  const clash = clashesAt(tasks, s).length;
  const over = p.l37 ? 0 : Math.max(0, crowdAt(s, others) - LUNCH.maxAtOnce);
  return clash * 10000 + over * over * 100 + Math.abs(s - preferred(p)) / STEP;
}

/**
 * Lunches for one building's people. people: [{ name, from, to, l37 }]; tasks: from taskTimes();
 * fixed: Map(name -> start minute) that stay where they are; notBefore: earliest start (on the
 * day itself, lunches aren't put in the past). Returns Map(name -> start minute) for everyone
 * it could fit (fixed ones included).
 */
export function planLunches(people, tasks, fixed = new Map(), { notBefore = 0, tries = 300 } = {}) {
  const starts = (p) => startsFor(p).filter((s) => s >= notBefore);
  const free = people.filter((p) => !fixed.has(p.name) && starts(p).length);
  const l37 = new Set(people.filter((p) => p.l37).map((p) => p.name));
  const options = new Map(free.map((p) => [p.name, starts(p).filter((s) => !clashesAt(tasks.get(lc(p.name)), s).length).length]));
  // the most tied-up people choose first; then random orders, keeping the best
  const base = [...free].sort((a, b) => options.get(a.name) - options.get(b.name) || preferred(a) - preferred(b));
  let best = null;
  for (let i = 0; i < (free.length > 1 ? tries : 1); i++) {
    const order = i === 0 ? base : shuffle([...free]);
    const placed = new Map(fixed);
    let total = 0;
    for (const p of order) {
      const others = [...placed].filter(([n]) => !l37.has(n)).map(([, s]) => s);
      let pick = null, pickCost = Infinity;
      for (const s of starts(p)) {
        const c = cost(p, s, tasks.get(lc(p.name)), others);
        if (c < pickCost) { pick = s; pickCost = c; }
      }
      placed.set(p.name, pick);
      total += pickCost;
    }
    if (!best || total < best.total) best = { total, placed };
  }
  return best ? best.placed : new Map(fixed);
}

/** How bad a set of lunches is: task clashes count far more than a 3rd person at lunch. 0 = all fine. */
export function lunchProblems(people, tasks, placed) {
  const l37 = new Set(people.filter((p) => p.l37).map((p) => p.name));
  let total = 0;
  for (const p of people) {
    const s = placed.get(p.name);
    if (s == null) continue;
    const others = [...placed].filter(([n]) => n !== p.name && !l37.has(n)).map(([, x]) => x);
    total += clashesAt(tasks.get(lc(p.name)), s).length * 10000;
    if (!p.l37) total += Math.max(0, crowdAt(s, others) - LUNCH.maxAtOnce) * 100;
  }
  return total;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Plain-English rules, for the dashboard. */
export function describeLunchRules(helper) {
  return [
    `Everyone working gets one hour between ${LUNCH.from} and ${LUNCH.to}, inside their shift${helper ? `, except ${helper} (shift too short)` : ""}.`,
    `Lunch never covers a task: the ${LUNCH.before} minutes before each of their tasks stay free.`,
    `At most ${LUNCH.maxAtOnce} people from the same building at lunch at once (${LUNCH.maxAtOnce + 1} only if the tasks leave no other way). Level 37 (SIC) doesn't use up a place.`,
    "Early starters go early, 9am starters later.",
    "A lunch you change by hand stays put. Lunches that have started, or start within 30 minutes, aren't moved.",
  ];
}
