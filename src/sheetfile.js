// Reads the agenda from the real spreadsheet: .xlsx (Google Sheets: File > Download >
// Microsoft Excel) or .csv. Exact - no guessing - and links come through as links.
import ExcelJS from "exceljs";

const pad = (n) => String(n).padStart(2, "0");

/** Excel stores times as a fraction of a day and dates as days since 1899-12-30. */
function fromSerial(n, fmt) {
  const isTime = /h/i.test(fmt) && !/[dy]/i.test(fmt);
  const isDate = /[dy]/i.test(fmt);
  if (isTime || (!isDate && n > 0 && n < 1)) {
    const mins = Math.round((n % 1) * 1440);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  if (isDate) return fromDate(new Date(Math.round((n - 25569) * 86400000)), fmt);
  return String(n);
}

function fromDate(d, fmt = "") {
  if (Number.isNaN(d.getTime())) return "";
  const timeOnly = d.getUTCFullYear() < 1901 || (/h/i.test(fmt) && !/[dy]/i.test(fmt));
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (timeOnly) return hhmm;
  const date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return /h/i.test(fmt) ? `${date} ${hhmm}` : date;
}

function valueText(v, fmt) {
  if (v == null) return { text: "" };
  if (v instanceof Date) return { text: fromDate(v, fmt) };
  if (typeof v === "number") return { text: fromSerial(v, fmt) };
  if (typeof v === "boolean") return { text: v ? "Y" : "N" };
  if (typeof v === "string") return { text: v };
  if (Array.isArray(v.richText)) return { text: v.richText.map((r) => r.text).join("") };
  if (v.hyperlink) return { text: valueText(v.text, fmt).text || "Link", link: true };
  if ("result" in v) return valueText(v.result, fmt);
  if (v.error) return { text: "" };
  return { text: String(v.text ?? "") };
}

function cellOf(cell) {
  // the hidden half of a merged cell repeats the main cell's value; count it once
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return { text: "" };
  const out = valueText(cell.value, cell.numFmt || "");
  if (cell.hyperlink) out.link = true;
  out.text = out.text.replace(/\r/g, "");
  return out;
}

function sheetToTable(ws) {
  const width = Math.min(ws.columnCount || ws.actualColumnCount || 0, 60);
  const table = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    for (let c = 1; c <= width; c++) cells.push(cellOf(row.getCell(c)));
    table.push(cells);
  });
  return table;
}

// ---------- CSV ----------

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const delim = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((t) => ({ text: t, link: /^https?:\/\//i.test(t.trim()) })));
}

export function isSheetFile(file) {
  const name = (file.originalname || "").toLowerCase();
  return /\.(xlsx|xlsm|xls|csv)$/.test(name) ||
    /spreadsheetml|ms-excel|text\/csv|application\/csv/.test(file.mimetype || "");
}

/** Returns a list of { name, table } - one per sheet tab. */
export async function readSheetFile(file) {
  const name = (file.originalname || "").toLowerCase();
  if (name.endsWith(".csv") || /csv/.test(file.mimetype || "")) {
    return [{ name: file.originalname || "CSV", table: parseCsv(file.buffer.toString("utf8")) }];
  }
  if (name.endsWith(".xls")) throw new Error("Old .xls files aren't supported. Save it as .xlsx or .csv.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file.buffer);
  } catch {
    throw new Error("Couldn't open that spreadsheet. Download it from Google Sheets as .xlsx or .csv and try again.");
  }
  return wb.worksheets
    .filter((ws) => ws.state !== "hidden" && ws.state !== "veryHidden")
    .map((ws) => ({ name: ws.name, table: sheetToTable(ws) }));
}
