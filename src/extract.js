// Turns uploaded files into agenda rows. No paid service needed:
//  - .xlsx / .csv  -> read exactly (sheetfile.js)
//  - screenshots   -> grid detection + free Tesseract OCR (screenshot.js)
// Optional: EXTRACT_ENGINE=claude (with ANTHROPIC_API_KEY) reads screenshots with Claude instead.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interpretTable, dedupe, pickDay } from "./table.js";
import { isSheetFile, readSheetFile } from "./sheetfile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TIME_ZONE = process.env.TIME_ZONE || "Europe/London";

const defaultPorters = () => (process.env.PORTERS || "Tom,Jeet,Robinson,Pablo,Ricardo,Wilson")
  .split(",").map((s) => s.trim()).filter(Boolean);

export function today() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

export { isSheetFile };

/** opts.porters: the team's names, used to fix OCR misspellings like "Robinsom". */
export async function extractRows(files, opts = {}) {
  const porters = opts.porters?.length ? opts.porters : defaultPorters();
  if (process.env.EXTRACT_MOCK === "1") {
    const raw = await fs.readFile(path.join(here, "mock-extraction.json"), "utf8");
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.parse(raw);
  }

  const sheets = files.filter(isSheetFile);
  const images = files.filter((f) => !isSheetFile(f));
  if (sheets.length && images.length) {
    throw new Error("Upload either the spreadsheet file or screenshots, not both at once.");
  }

  if (sheets.length) return fromSheets(sheets, porters);

  if (process.env.EXTRACT_ENGINE === "claude" && process.env.ANTHROPIC_API_KEY) {
    const { extractWithClaude } = await import("./claude.js");
    return extractWithClaude(images);
  }
  return fromScreenshots(images, porters);
}

async function fromSheets(files, porters) {
  let rows = [];
  const warnings = [];
  let tabsWithHeader = 0;
  for (const file of files) {
    for (const tab of await readSheetFile(file)) {
      const r = interpretTable(tab.table, { porters });
      if (!r.map) continue;
      tabsWithHeader++;
      rows.push(...r.rows);
    }
  }
  if (!tabsWithHeader) {
    throw new Error("Couldn't find the agenda's header row (Owner, Host Name, Location…) in that file.");
  }
  rows = dedupe(rows);
  const day = pickDay(rows, today());
  if (day.note) warnings.push(day.note);
  if (!day.rows.length) throw new Error("No jobs found in that file.");
  return { rows: day.rows, warnings };
}

async function fromScreenshots(files, porters) {
  const { readScreenshot } = await import("./screenshot.js");
  let rows = [];
  const warnings = [];
  let map = null;
  for (const [i, file] of files.entries()) {
    const label = files.length > 1 ? `Image ${i + 1}: ` : "";
    const { table, lastRowCut } = await readScreenshot(file.buffer);
    // a follow-on screenshot without the header row reuses the first one's columns
    const usable = map && table[0]?.length === map.length ? map : null;
    const r = interpretTable(table, { ocr: true, porters, map: usable, label });
    if (!r.map) {
      throw new Error(`${label}Couldn't find the header row (Owner, Requestor, Activity Date…). Include it in the screenshot.`);
    }
    map = r.map;
    rows.push(...r.rows);
    warnings.push(...r.warnings);
    if (lastRowCut && r.rows.length) {
      const last = r.rows.at(-1);
      warnings.push(`${label}The last row (${last.task || last.host || last.location}) is cut off at the bottom – check it, or add the next screenshot.`);
    }
  }
  rows = dedupe(rows);
  if (!rows.length) throw new Error("Couldn't find any jobs in the screenshot.");
  warnings.push("Read automatically from the picture – give times and rooms a quick check.");
  return { rows, warnings };
}
