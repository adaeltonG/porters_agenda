// Reads one or more screenshots of the porters' Google Sheet with Claude (vision)
// and returns structured rows.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const here = path.dirname(fileURLToPath(import.meta.url));

const slot = {
  type: "object",
  additionalProperties: false,
  required: ["needed", "time", "note"],
  properties: {
    needed: { type: "boolean" },
    time: { type: "string" },
    note: { type: "string" },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rows", "warnings"],
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "date", "owner", "requestor", "eventLead", "host", "vendor",
          "teaCoffee", "breakfast", "lunch", "afternoon", "clearUp", "setup", "reset",
          "location", "attendees", "info", "porters",
          "hasMenuLink", "hasAgendaLink", "hasFloorPlanLink",
        ],
        properties: {
          date: { type: "string" },
          owner: { type: "string", enum: ["Hospitality", "Movers", "Both", "Other"] },
          requestor: { type: "string" },
          eventLead: { type: "string" },
          host: { type: "string" },
          vendor: { type: "string" },
          teaCoffee: slot,
          breakfast: slot,
          lunch: slot,
          afternoon: slot,
          clearUp: slot,
          setup: slot,
          reset: slot,
          location: { type: "string" },
          attendees: { type: "string" },
          info: { type: "string" },
          porters: { type: "string" },
          hasMenuLink: { type: "boolean" },
          hasAgendaLink: { type: "boolean" },
          hasFloorPlanLink: { type: "boolean" },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
};

const PROMPT = `These images are screenshots of a porters team's daily agenda (a Google Sheet). If there are several images they are parts of the same sheet; they may overlap, so include each row only once.

Columns, left to right: Owner (Hospitality / Movers / Both), Requestor, Event Lead, Activity Date, Host Name, Vendor, Tea/Coffee/Water time, Breakfast time, Lunch time, Afternoon Catering time, Clear up Time, Location, No. of attendees, Info/Menu, Assigned Porter, Setup Time, Reset Time, Agenda, Floor Plan. Rows such as "WEDNESDAY" are day headings, not jobs.

Return one entry per job row, top to bottom. Rules:
- date: the Activity Date as YYYY-MM-DD (the sheet uses DD/MM/YYYY). If a row has no date, use the date of the rows around it.
- Time columns (teaCoffee, breakfast, lunch, afternoon, clearUp, setup, reset): "N", "-" or empty means needed=false, time="", note="". Otherwise needed=true, time = the first time as 24-hour HH:MM (8:00am -> 08:00, 2:30 in an afternoon range -> 14:30), and note = any other text in the cell, for example "Refill at lunch. Clear with lunch", "until 07:30", "Barista team", "Put back plexi glass and chairs". "Y" means needed=true with no time. A time printed small in a corner of a cell still belongs to that cell.
- clearUp and reset with a time are needed=true. A Movers row with nothing but a reset or setup still counts.
- info: all readable text from the Info/Menu cell, joined with ". ". Truncated chip labels like "Allergen..." or "MENU - ..." can be summarised as "Menu", "Allergen matrix" or "AM" files; keep any free-text instructions word for word.
- porters: the Assigned Porter cell exactly as written, e.g. "TCW : Wilson L:Pablo" or "Tom, Pablo, Robinson, Jeet". "-" means "".
- hasMenuLink / hasAgendaLink / hasFloorPlanLink: true if that cell shows a link or file chip ("LINK HERE", "Menu and Matrix", a menu chip).
- Merged cells: when one value spans several columns, put it in the column where it belongs by meaning (for example a long note about removing plexi glass goes in info).
- Copy names, rooms (e.g. 31-C09, L26-C18) and numbers exactly. Do not invent anything; leave a field empty if it is blank or unreadable.
- warnings: short notes about anything you could not read or were unsure about, naming the row by host and location. Empty array if everything was clear.`;

function mediaTypeOf(file) {
  const t = (file.mimetype || "").toLowerCase();
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(t)) return t;
  return "image/jpeg";
}

let client;

export async function extractRows(files) {
  if (process.env.EXTRACT_MOCK === "1") {
    const raw = await fs.readFile(path.join(here, "mock-extraction.json"), "utf8");
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.parse(raw);
  }

  client ??= new Anthropic();

  const content = [];
  files.forEach((f, i) => {
    if (files.length > 1) content.push({ type: "text", text: `Image ${i + 1} of ${files.length}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaTypeOf(f), data: f.buffer.toString("base64") },
    });
  });
  content.push({ type: "text", text: PROMPT });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEMA },
    },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to read this image. Try a clearer screenshot.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The agenda was too long to read in one go. Try uploading it in two parts.");
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Could not understand the reply from Claude. Please try again.");
  }
  if (!Array.isArray(data.rows)) throw new Error("No rows found in the screenshot.");
  return data;
}
