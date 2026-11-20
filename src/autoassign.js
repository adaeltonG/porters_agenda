// Shares out jobs that nobody has been given yet.
//
// The house rules live in RULES below:
//  - Random but fair: every porter ends up with about the same number of tasks that day
//    (setup, tea/coffee, lunch, clear up... each count as one; jobs the sheet already gave
//    out count too). Hundreds of random shares are tried and the fairest one is kept, so a
//    re-run gives a different but equally fair answer.
//  - Nobody gets two rooms within 15 minutes of each other if it can be avoided.
//  - The morning helper (Davina, hospitality) does the tea/coffee/water and breakfasts. She
//    finishes at 10:30, so she never gets lunch or anything later, and never a furniture
//    setup on the Ohana floor. If two of hers are at the same time, a porter takes the other.
//    In a room that also has lunch etc., she does the morning part and a porter the rest.
//  - Tom gets as few tea/coffee and breakfasts as possible, and never a room that has both
//    breakfast and lunch.

export const RULES = {
  morningHelper: { name: "Davina", finishes: "10:30", noSetupAt: /ohana/i },
  fewTeaBreakfast: ["Tom"],
  noBreakfastLunchRoom: ["Tom"],
  clashMinutes: 15,
  tries: 400,
};

const SLOTS = ["setup", "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "reset"];
const ROLE = { setup: "S", teaCoffee: "TCW", breakfast: "B", lunch: "L", afternoon: "A", clearUp: "C", reset: "R" };
const ROLE_SLOT = { TCW: "teaCoffee", TC: "teaCoffee", T: "teaCoffee", B: "breakfast", L: "lunch", A: "afternoon", PM: "afternoon", S: "setup", SU: "setup", C: "clearUp", CU: "clearUp", R: "reset" };
const TEA_BREAKFAST = new Set(["teaCoffee", "breakfast"]);

const lc = (s) => String(s || "").trim().toLowerCase();
const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || "") ? Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]) : null);

/** A job's tasks as [{ key, min }]; a job with no ticked slots is one task ("done"). */
function tasksOf(job) {
  const t = SLOTS.filter((k) => job.slots?.[k]?.needed).map((k) => ({ key: k, min: toMin(job.slots[k].time) }));
  return t.length ? t : [{ key: "done", min: null }];
}

/** The tasks a porter on a job is doing: the ones their roles name ("TCW", "L"), or all of them. */
function heldTasks(job, porter) {
  const tasks = tasksOf(job);
  const slots = (porter.roles || []).map((r) => ROLE_SLOT[String(r).toUpperCase()]).filter(Boolean);
  const mine = slots.length ? tasks.filter((t) => slots.includes(t.key)) : [];
  return mine.length ? mine : tasks;
}

const unassigned = (job) => !job.everyone && !job.porters?.length;

/** Tasks per person for a day: { name: { tasks, teaBreakfast } } ("Everyone" jobs aren't counted). */
export function taskLoads(jobs) {
  const out = {};
  for (const job of jobs) {
    if (job.everyone) continue;
    for (const p of job.porters || []) {
      const held = heldTasks(job, p);
      const e = (out[p.name] ||= { tasks: 0, teaBreakfast: 0 });
      e.tasks += held.length;
      e.teaBreakfast += held.filter((t) => TEA_BREAKFAST.has(t.key)).length;
    }
  }
  return out;
}

/** The rules in plain words, for the dashboard. */
export function describeRules(rules = RULES) {
  const h = rules.morningHelper;
  return [
    "Shared out at random, but fairly: everyone ends up with about the same number of tasks for the day (jobs the sheet already gave out count too).",
    `Nobody gets two different rooms within ${rules.clashMinutes} minutes of each other, if it can be avoided.`,
    h && `${h.name} does the tea/coffee/water and breakfasts before ${h.finishes} (and that room's setup and clear-up when they're before ${h.finishes}). Never lunch, never a furniture setup on the Ohana floor. If two of hers are at the same time, a porter takes the other one.`,
    rules.fewTeaBreakfast.length && `${rules.fewTeaBreakfast.join(", ")} gets as few tea/coffee and breakfasts as possible.`,
    rules.noBreakfastLunchRoom.length && `${rules.noBreakfastLunchRoom.join(", ")} never gets a room that has both breakfast and lunch.`,
  ].filter(Boolean);
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Works out porters for the target jobs.
 * jobs: every job on the day (the others count towards how busy people are)
 * targetIds: ids of the jobs to fill
 * roster: names of who's working
 * Returns { porters: Map(jobId -> [{ name, roles }]), loads }.
 */
export function autoAssign(jobs, targetIds, roster, { rules = RULES, rand = Math.random } = {}) {
  const ids = new Set(targetIds);
  const targets = jobs.filter((j) => ids.has(j.id));
  let best = null;
  for (let i = 0; i < rules.tries; i++) {
    const r = oneTry(jobs, targets, roster, rules, rand);
    if (!best || r.score < best.score) best = r;
  }
  return best ? { porters: best.porters, loads: best.loads } : { porters: new Map(), loads: {} };
}

function oneTry(jobs, targets, roster, rules, rand) {
  const people = new Map(roster.map((n) => [lc(n), { name: n, load: 0, teaBreakfast: 0, clashes: 0, busy: [] }]));
  const few = new Set(rules.fewTeaBreakfast.map(lc));
  const noBL = new Set(rules.noBreakfastLunchRoom.map(lc));
  const gap = rules.clashMinutes;
  const targetIds = new Set(targets.map((j) => j.id));

  const free = (p, min, jobId) => min == null || !p.busy.some((b) => b.job !== jobId && Math.abs(b.min - min) < gap);
  const give = (p, jobId, tasks, count = true) => {
    for (const t of tasks) {
      if (!free(p, t.min, jobId)) p.clashes++;
      if (t.min != null) p.busy.push({ job: jobId, min: t.min });
    }
    if (!count) return;
    p.load += tasks.length;
    p.teaBreakfast += tasks.filter((t) => TEA_BREAKFAST.has(t.key)).length;
  };

  // what people already have that day
  for (const job of jobs) {
    if (targetIds.has(job.id)) continue;
    if (job.everyone) {
      // everyone's there, so it only makes them busy at that time
      for (const p of people.values()) give(p, job.id, tasksOf(job), false);
      continue;
    }
    for (const entry of job.porters || []) {
      const p = people.get(lc(entry.name));
      if (p) give(p, job.id, heldTasks(job, entry));
    }
  }

  const left = new Map(targets.map((j) => [j.id, tasksOf(j)]));
  const picks = new Map(targets.map((j) => [j.id, []]));
  const take = (job, p, tasks) => {
    give(p, job.id, tasks);
    const list = picks.get(job.id);
    const had = list.find((g) => g.name === p.name);
    if (had) had.keys.push(...tasks.map((t) => t.key));
    else list.push({ name: p.name, keys: tasks.map((t) => t.key) });
    const keys = new Set(tasks.map((t) => t.key));
    left.set(job.id, left.get(job.id).filter((t) => !keys.has(t.key)));
  };

  // 1) the morning helper: tea/coffee and breakfasts first, earliest first
  const h = rules.morningHelper;
  const helper = h && people.get(lc(h.name));
  if (helper) {
    const until = toMin(h.finishes);
    const morning = (job) => left.get(job.id).filter((t) => TEA_BREAKFAST.has(t.key) && (t.min != null ? t.min < until : t.key === "breakfast"));
    const first = (job) => Math.min(...morning(job).map((t) => t.min ?? 9999));
    const order = shuffle(targets.filter((j) => morning(j).length), rand).sort((a, b) => first(a) - first(b));
    for (const job of order) {
      const mine = morning(job).filter((t) => free(helper, t.min, job.id));
      if (mine.length) take(job, helper, mine);
    }
    // ...then the setup / clear up of her rooms, when they're before she finishes
    for (const job of order) {
      if (!picks.get(job.id).length) continue;
      const extra = left.get(job.id).filter((t) => t.min != null && t.min < until && free(helper, t.min, job.id)
        && (t.key === "clearUp" || (t.key === "setup" && !(h.noSetupAt && h.noSetupAt.test(job.location || "")))));
      if (extra.length) take(job, helper, extra);
    }
  }

  // 2) porters: one porter per room for whatever is left, bigger jobs first
  const regulars = [...people.values()].filter((p) => p !== helper);
  const units = shuffle(targets.filter((j) => left.get(j.id).length), rand)
    .sort((a, b) => left.get(b.id).length - left.get(a.id).length);
  for (const job of units) {
    const tasks = left.get(job.id);
    const tb = tasks.filter((t) => TEA_BREAKFAST.has(t.key)).length;
    const breakfastAndLunch = Boolean(job.slots?.breakfast?.needed && job.slots?.lunch?.needed);
    let pick = null, pickCost = Infinity;
    for (const p of regulars) {
      if (breakfastAndLunch && noBL.has(lc(p.name))) continue;
      const clashes = tasks.filter((t) => !free(p, t.min, job.id)).length;
      const cost = p.load + clashes * 50 + (few.has(lc(p.name)) ? tb * 4 : 0) + rand();
      if (cost < pickCost) { pick = p; pickCost = cost; }
    }
    if (pick) take(job, pick, tasks);
  }

  // score: clashes are worst, then Tom's tea/breakfasts, then how uneven the porters' loads are
  const loads = regulars.map((p) => p.load);
  const mean = loads.reduce((a, b) => a + b, 0) / (loads.length || 1);
  const spread = loads.length ? Math.max(...loads) - Math.min(...loads) : 0;
  const variance = loads.reduce((a, b) => a + (b - mean) ** 2, 0);
  const clashes = [...people.values()].reduce((a, p) => a + p.clashes, 0);
  const tomTB = [...people.values()].filter((p) => few.has(lc(p.name))).reduce((a, p) => a + p.teaBreakfast, 0);
  const score = clashes * 10000 + tomTB * 1000 + spread * 50 + variance;

  const porters = new Map();
  for (const job of targets) {
    const got = picks.get(job.id);
    if (!got.length) continue;
    const all = tasksOf(job).length;
    porters.set(job.id, got.length === 1 && got[0].keys.length === all
      ? [{ name: got[0].name, roles: [] }]
      : got.map((g) => ({ name: g.name, roles: g.keys.filter((k) => ROLE[k]).map((k) => ROLE[k]) })));
  }
  const out = Object.fromEntries([...people.values()].map((p) => [p.name, { tasks: p.load, teaBreakfast: p.teaBreakfast }]));
  return { score, porters, loads: out };
}

export { unassigned };
