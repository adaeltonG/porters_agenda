// Reads a screenshot of the agenda sheet without any AI service:
// 1. find the table's cell borders (dark thin lines) to get a grid,
// 2. read each cell with Tesseract OCR (runs locally, free),
// 3. return the table as rows of cells, ready for table.js to interpret.
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engData = require("@tesseract.js-data/eng");

// ---------- OCR worker (created once, reused) ----------

let workerPromise;
let queue = Promise.resolve();

function getWorker() {
  workerPromise ??= (async () => {
    const w = await createWorker(engData.code, 1, {
      langPath: engData.langPath,
      gzip: engData.gzip,
      cacheMethod: "none",
    });
    await w.setParameters({ tessedit_pageseg_mode: "6", user_defined_dpi: "300" });
    return w;
  })().catch((e) => { workerPromise = undefined; throw e; });
  return workerPromise;
}

// ---------- grid detection ----------

const D = 3;       // how far either side a line must be darker than
const DROP = 25;   // how much darker than its surroundings a line pixel is

/** Fraction of each column / row made of thin dark line pixels. */
function lineScores(g, W, H) {
  const at = (x, y) => g[y * W + x];
  const v = new Float32Array(W), h = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = D; x < W - D; x++) {
      const p = at(x, y);
      if (p < 200 && p < at(x - D, y) - DROP && p < at(x + D, y) - DROP) v[x]++;
    }
  }
  for (let y = D; y < H - D; y++) {
    for (let x = 0; x < W; x++) {
      const p = at(x, y);
      if (p < 200 && p < at(x, y - D) - DROP && p < at(x, y + D) - DROP) h[y]++;
    }
  }
  for (let x = 0; x < W; x++) v[x] /= H;
  for (let y = 0; y < H; y++) h[y] /= W;
  return { v, h };
}

/** Group neighbouring positions over the threshold into single line positions. */
function peaks(scores, threshold) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= scores.length; i++) {
    const on = i < scores.length && scores[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push({ from: start, to: i - 1 }); start = -1; }
  }
  return out;
}

/** Bands between lines (including the image edges), skipping slivers. */
function bands(lines, size, minGap) {
  const out = [];
  let prev = 0;
  for (const l of [...lines, { from: size, to: size }]) {
    if (l.from - prev >= minGap) out.push({ a: prev, b: l.from });
    prev = l.to + 1;
  }
  return out;
}

/** Is there a vertical border at x between rows y0..y1 (to detect merged cells)? */
function hasVBorder(g, W, x, y0, y1) {
  let on = 0;
  const n = y1 - y0;
  if (n <= 0) return true;
  for (let y = y0; y < y1; y++) {
    let best = 255;
    for (let dx = -1; dx <= 1; dx++) best = Math.min(best, g[y * W + x + dx]);
    const side = Math.min(g[y * W + x - D - 1], g[y * W + x + D + 1]);
    if (best < 200 && best < side - DROP) on++;
  }
  return on / n > 0.5;
}

/**
 * Looks inside a cell for "ink" (pixels clearly different from the cell's background).
 * Returns null for an empty cell, otherwise the tight box around the ink and whether the
 * text is light on a dark background (e.g. the blue header row).
 */
/**
 * From a row/column ink profile, the span that holds the text: drops thin strips that touch
 * the cell edge (left-over borders, shading) and lines that are almost solid.
 */
function textSpan(profile, across) {
  const runs = [];
  for (let i = 0; i < profile.length; i++) {
    const on = profile[i] > 0 && profile[i] < across * 0.6;
    if (on && (!runs.length || runs.at(-1).end !== i - 1)) runs.push({ start: i, end: i });
    else if (on) runs.at(-1).end = i;
  }
  const keep = runs.filter((r) => !((r.start === 0 || r.end === profile.length - 1) && r.end - r.start < 4));
  if (!keep.length) return null;
  return [keep[0].start, keep.at(-1).end];
}

const INK = 45; // grey levels away from the background that count as text

function findInk(g, W, x0, y0, x1, y1) {
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const hist = new Uint32Array(256);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[g[y * W + x]]++;
  const total = (x1 - x0) * (y1 - y0);
  let acc = 0, bg = 0;
  for (; bg < 256; bg++) { acc += hist[bg]; if (acc >= total / 2) break; }
  const cw = x1 - x0, ch = y1 - y0;
  const rowInk = new Uint32Array(ch), colInk = new Uint32Array(cw);
  let dark = 0, light = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = g[y * W + x] - bg;
      if (d < -INK) dark++; else if (d > INK) light++; else continue;
      rowInk[y - y0]++; colInk[x - x0]++;
    }
  }
  const ys = textSpan(rowInk, cw), xs = textSpan(colInk, ch);
  if (!ys || !xs) return null;
  if (dark + light < 6) return null;
  return { x0: x0 + xs[0], y0: y0 + ys[0], x1: x0 + xs[1] + 1, y1: y0 + ys[1] + 1, invert: light > dark, bg };
}

// ---------- OCR ----------

async function ocrCell(img, W, H, ink) {
  const m = 4;
  const left = Math.max(0, ink.x0 - m), top = Math.max(0, ink.y0 - m);
  const width = Math.min(W, ink.x1 + m) - left, height = Math.min(H, ink.y1 + m) - top;
  // small text is scaled up more: Tesseract likes letters ~30px tall
  const scale = Math.min(6, Math.max(3, Math.round(40 / Math.min(height, 14))));
  const { data, info } = await sharp(img)
    .extract({ left, top, width, height })
    .greyscale()
    .resize({ width: width * scale, height: height * scale, kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Turn any colour scheme (dark on white, white on blue...) into dark text on white:
  // each pixel becomes "how far is it from the background colour".
  const bg = ink.bg;
  let maxDiff = 1;
  for (const p of data) maxDiff = Math.max(maxDiff, Math.abs(p - bg));
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = 255 - Math.min(255, Math.round((Math.abs(data[i] - bg) * 255) / maxDiff));
  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: "#ffffff" })
    .png()
    .toBuffer();
  // one line of text reads better as a "single line" than as a block
  let text = cleanOcr(await recognize(png, height < 26 ? "7" : "6"));
  // a lone letter like "N" or "Y" is often missed; retry as a single character
  if (!text && width < 24 && height < 26) text = cleanOcr(await recognize(png, "10"));
  return text;
}

async function recognize(png, psm) {
  const worker = await getWorker();
  const job = queue.then(async () => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    return worker.recognize(png);
  });
  queue = job.catch(() => {});
  const { data } = await job;
  return data.text;
}

function cleanOcr(t) {
  return String(t || "")
    .split("\n")
    .map((l) => l.replace(/[|_~—]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l && /[A-Za-z0-9]/.test(l))
    .join("\n");
}

/**
 * Reads a screenshot into a table: an array of rows, each an array of cells indexed by
 * column ({ text, span }; a merged cell sits in its first column). Also says whether the
 * last row looks cut off by the bottom of the image.
 */
export async function readScreenshot(buffer) {
  const grid = await readGrid(buffer);
  const table = grid.rows.map((r) => {
    const cells = new Array(grid.columns.length).fill(null).map(() => ({ text: "" }));
    for (const c of r.cells) cells[c.col] = { text: c.text || "", span: c.span };
    return cells;
  });
  return { table, lastRowCut: grid.lastRowCut };
}

export async function readGrid(buffer) {
  const img = await sharp(buffer).rotate().toBuffer();
  const { data: g, info } = await sharp(img).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  if (W < 300 || H < 60) throw new Error("This image is too small to read.");

  const { v, h } = lineScores(g, W, H);
  const vLines = peaks(v, 0.3);
  const hLines = peaks(h, 0.3);
  const columns = bands(vLines, W, 12);
  const rowBands = bands(hLines, H, 12);
  if (columns.length < 8 || rowBands.length < 2) {
    throw new Error("Couldn't find the table grid in this image. Make sure the screenshot shows the sheet with its cell borders.");
  }

  const rows = [];
  for (const rb of rowBands) {
    // merge neighbouring columns where this row has no border between them
    const cells = [];
    let cur = { c0: 0, c1: 0 };
    for (let c = 1; c < columns.length; c++) {
      const x = Math.round((columns[c - 1].b + columns[c].a) / 2);
      if (hasVBorder(g, W, x, rb.a + 2, rb.b - 2)) { cells.push(cur); cur = { c0: c, c1: c }; }
      else cur.c1 = c;
    }
    cells.push(cur);

    const out = [];
    for (const cell of cells) {
      const box = { x0: columns[cell.c0].a, x1: columns[cell.c1].b, y0: rb.a, y1: rb.b };
      const ink = findInk(g, W, box.x0 + 3, box.y0 + 3, box.x1 - 3, box.y1 - 3);
      out.push({ col: cell.c0, span: cell.c1 - cell.c0 + 1, box, ink, text: ink ? null : "" });
    }
    rows.push({ band: rb, cells: out });
  }

  // OCR all non-empty cells (sequentially on one worker: keeps memory low)
  await Promise.all(rows.flatMap((r) => r.cells.filter((c) => c.text === null)
    .map(async (c) => { c.text = await ocrCell(img, W, H, c.ink); })));

  const lastRowCut = H - rowBands.at(-1).b < 3 && hLines.length && hLines.at(-1).to < H - 4;
  return { columns, rows, width: W, height: H, lastRowCut };
}
