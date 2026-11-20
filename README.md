# Porters Agenda

A phone-friendly version of the daily porters agenda. The admin uploads the screenshot from the group chat (or the sheet file itself), the app reads it, and every porter sees their jobs as cards they can tick off. Ticks show up on the other phones and on the admin dashboard within a few seconds.

**Porters** (team app, `https://zetahub.co.uk/porters/`)
- See everyone's jobs, filter by porter, "Everyone" or "Unassigned"
- Tick off their own tasks (setup, tea/coffee/water, breakfast, lunch, afternoon, clear up, reset). Other people's jobs are read-only.
- Shows how far away each task is ("in 20 min") and which are overdue
- Push notification when they're given a job (after turning notifications on once)

**Hosts** (same link, *Host* tab on the login screen)
- Read-only: hosts pick their name and see their events for the day, with each part marked *Delivered* / *Cleared* (time and porter) as soon as a porter ticks it. "All events" shows everything.
- While the app is open the phone buzzes when one of their events is ticked off.
- On iPhone: Safari → Share → *Add to Home Screen*, then open it from the icon and pick the name once more.
- They log in with `HOST_PIN` if it's set, otherwise with the team PIN. The host PIN only opens this read-only view.

**Admin** (dashboard, `https://zetahub.co.uk/porters/admin.html`, own PIN)
- Upload the agenda (screenshot or .xlsx/.csv). Porter names in the sheet are read; jobs without porters are **assigned automatically** (can be switched off in the upload box), and anything can be changed from the dropdown in the table (several people, or **Everyone**).
- **Auto-assign**: tick who's working that day, then fill the jobs without porters, or re-shuffle the automatic picks nobody has started. The rules are in [src/autoassign.js](src/autoassign.js): random but fair (same number of tasks each), nobody in two rooms within 15 minutes, Davina does tea/coffee and breakfasts before 10:30 (never lunch, never Ohana floor setups), Tom gets as few tea/coffee and breakfasts as possible and never a room with breakfast and lunch. "Tasks each" above the table shows the share.
- Live table: a task turns green when a porter ticks it, a row turns green when the job is finished, no refresh needed
- Add, edit, delete and tick any job
- **History**: every past day, with who ticked what and when
- **Hosts**: a permanent list of host names for the Host dropdown. New names found in an upload are offered for adding with one click.
- **Porters**: add or remove team members, see who has notifications on
- If the admin has logged into the dashboard on a phone, the team app on that phone can edit too.

## Data

Everything is kept in one SQLite file, `data/porters.db` (Node's built-in `node:sqlite`, no database server). Screenshots are kept in `data/images/`. To back up, copy the `data` folder. On first start an older `data/state.json` is imported automatically and renamed to `state.json.imported`.

## Notifications

Web Push, free, through the phones' own push services. The keys are created on first start and stored in the database.
- **Android (Chrome):** menu ☰ → *Turn on notifications*, works straight away.
- **iPhone (iOS 16.4+):** only for the app added to the Home Screen: Safari → Share → *Add to Home Screen*, open it from the icon, then ☰ → *Turn on notifications*. A normal Safari tab can't get notifications.

While the app is open it also buzzes and shows a message when a new job is assigned.

Note: porters log in with the shared team PIN and pick their name, so "only tick your own jobs" prevents mistakes, not deliberate misuse.

## Run it on the server (Docker)

```bash
cd /opt/porters-agenda              # a git checkout of this repo
cp .env.example .env && nano .env   # set TEAM_PIN and ADMIN_PIN
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
docker compose up -d --build
docker compose logs -f              # should print: Porters agenda on http://localhost:3000
```

The app listens only on `127.0.0.1:3010`. nginx makes it public at `https://zetahub.co.uk/porters/` using [deploy/nginx-porters.conf](deploy/nginx-porters.conf).

### Updating

```bash
cd /opt/porters-agenda && git pull && docker compose up -d --build porters
```

## Daily use

1. The boss posts the screenshot in the group chat.
2. The admin opens the dashboard and taps **Upload agenda**.
3. A few seconds later the jobs appear. Assign porters where the sheet has none; give the rest a quick check against the screenshot.

Even better, if you have the sheet: in Google Sheets choose *File → Download → Microsoft Excel (.xlsx)* (or *.csv*) and upload that file. It's read exactly, and if the file has several days the app takes today's (or the next day with jobs).

Uploading a corrected sheet with **Replace** keeps ticks, porters assigned in the app, and jobs added by hand.

## How the reading works (free, no AI service)

- **Sheet file (.xlsx / .csv)** – read cell by cell with `exceljs`. Exact.
- **Screenshot** – `sharp` finds the table's cell borders, then each cell is read with Tesseract OCR (`tesseract.js`, runs on the server). The header row tells it which column is which. Merged cells, day headings ("THURSDAY") and multi-line cells are handled. About 3 seconds. OCR can still slip on a letter or a digit, so check it. Host names are matched to the host list, which corrects small misreadings.
  The screenshot must include the header row (Owner, Requestor…) and the cell borders. A second screenshot without the header is fine when uploaded together with the first.

Optional: set `EXTRACT_ENGINE=claude` and `ANTHROPIC_API_KEY` to read screenshots with Claude instead (a few pence per upload, see `src/claude.js`).

## Developing locally

```bash
npm install
TEAM_PIN=1234 ADMIN_PIN=4321 npm start
# Fake mode for UI work: every upload returns a hand-typed copy of the 18/11/2026 agenda
npm run mock
```

Open http://localhost:3000 (team) and http://localhost:3000/admin.html (admin). Needs Node 22.13 or newer.

## Files

| Path | What it is |
|---|---|
| `server.js` | Express server: PINs, permissions, upload, ticks, jobs, admin routes, notifications |
| `src/db.js` | SQLite tables and queries (porters, hosts, jobs, ticks, uploads, push subscriptions) |
| `src/push.js` | Web Push sending |
| `src/extract.js` | Picks the reader for the uploaded files and returns the rows |
| `src/screenshot.js` | Screenshot → table: grid detection + Tesseract OCR |
| `src/sheetfile.js` | .xlsx / .csv → table |
| `src/table.js` | Table → agenda rows (columns, times, dates, OCR clean-up). Shared by both readers |
| `src/claude.js` | Optional Claude reader (`EXTRACT_ENGINE=claude`) |
| `src/mock-extraction.json` | Fake reading of the 18/11 screenshot, used by `npm run mock` |
| `public/index.html`, `app.js`, `app.css` | Team app |
| `public/admin.html`, `admin.js`, `admin.css` | Admin dashboard |
| `public/picker.js` | The multi-select dropdown (hosts, porters) |
| `public/sw.js` | Service worker that shows push notifications |
| `deploy/nginx-porters.conf` | nginx snippet for `/porters/` |
