# Porters Agenda

A phone-friendly version of the daily porters agenda. Someone uploads the screenshot from the group chat (or the sheet file itself), the app reads it, and every porter sees their jobs as cards they can tick off. Ticks sync between phones within about 10 seconds.

- Filter by porter (Tom, Jeet, Robinson, Pablo, Ricardo, Wilson), or "Unassigned"
- Tick off each task (setup, tea/coffee/water, breakfast, lunch, afternoon, clear up, reset). The app records who ticked it and when.
- Shows how far away each task is ("in 20 min") and which ones are overdue, with a "Now" line in the list
- The original screenshot can always be opened in the app if something looks wrong
- Any job can be edited, added or deleted by hand
- No database. Today's agenda lives in `data/state.json` and is replaced by the next upload.

## Run it on the server (Docker)

```bash
# 1. Copy this folder to the server, e.g. /opt/porters-agenda (leave node_modules out)
cd /opt/porters-agenda

# 2. Settings
cp .env.example .env
nano .env            # set TEAM_PIN

# 3. Data folder the container can write to (the container runs as uid 1000)
mkdir -p data && sudo chown 1000:1000 data

# 4. Start
docker compose up -d --build
docker compose logs -f       # should print: Porters agenda on http://localhost:3000
```

The app listens only on `127.0.0.1:3010`. nginx makes it public at `https://zetahub.co.uk/porters/`.

### nginx

Paste the two `location` blocks from [deploy/nginx-porters.conf](deploy/nginx-porters.conf) into the existing HTTPS `server { }` block for zetahub.co.uk, then run:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The larger upload size limit matters for phone photos.

### Updating

```bash
docker compose up -d --build
```

## Getting the team on it

1. Send them `https://zetahub.co.uk/porters/` and the PIN.
2. Each person taps their name and enters the PIN once. Their phone remembers both.
3. Add it to the home screen: Safari → Share → *Add to Home Screen*, or Chrome → ⋮ → *Add to Home screen*. After that it opens full screen like an app.

## Daily use

1. The boss posts the screenshot in the group chat.
2. Anyone saves the image, opens the app and taps **Upload** (or ☰ → *Upload agenda*).
3. A few seconds later the jobs appear on everyone's phone. Check them quickly against the screenshot; the app lists anything it wasn't sure about.

Even better, if you have the sheet: in Google Sheets choose *File → Download → Microsoft Excel (.xlsx)* (or *.csv*) and upload that file. It's read exactly, links come through, and if the file has several days the app shows today's (or the next day with jobs).

If the agenda is split across two screenshots, pick both at once, or upload the second one with **Add more rows**. If the boss posts a corrected sheet, upload it with **Replace**. Ticks stay on the jobs that didn't change.

## How the reading works (free, no AI service)

- **Sheet file (.xlsx / .csv)** – read cell by cell with `exceljs`. Exact.
- **Screenshot** – `sharp` finds the table's cell borders, then each cell is read with Tesseract OCR (`tesseract.js`, runs on the server). The header row tells it which column is which, so the sheet's column widths can change. Merged cells, day headings ("THURSDAY") and multi-line cells are handled. It takes about 3 seconds. OCR can still slip on a letter or a digit, so the app asks for a quick check.
  The screenshot must include the header row (Owner, Requestor…) and the cell borders. A second screenshot without the header is fine when uploaded together with the first.

Optional: set `EXTRACT_ENGINE=claude` and `ANTHROPIC_API_KEY` to read screenshots with Claude instead (a few pence per upload, see `src/claude.js`).

## Developing locally

```bash
npm install
TEAM_PIN=1234 node server.js
# Fake mode for UI work: every upload returns a hand-typed copy of the 18/11/2026 agenda
EXTRACT_MOCK=1 TEAM_PIN=1234 node server.js
```

Open http://localhost:3000.

## Files

| Path | What it is |
|---|---|
| `server.js` | Express server: login PIN, upload, ticks, editing, saving `data/state.json` |
| `src/extract.js` | Picks the reader for the uploaded files and returns the rows |
| `src/screenshot.js` | Screenshot → table: grid detection + Tesseract OCR |
| `src/sheetfile.js` | .xlsx / .csv → table |
| `src/table.js` | Table → agenda rows (columns, times, dates, OCR clean-up). Shared by both readers |
| `src/claude.js` | Optional Claude reader (`EXTRACT_ENGINE=claude`) |
| `src/mock-extraction.json` | Fake reading of the 18/11 screenshot, used when `EXTRACT_MOCK=1` |
| `public/` | The app: `index.html`, `app.css`, `app.js` (no build step) |
| `deploy/nginx-porters.conf` | nginx snippet for `/porters/` |
