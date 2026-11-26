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

**Admin** (dashboard, `https://zetahub.co.uk/porters/admin.html`, name + password)
- Upload the agenda (screenshot or .xlsx/.csv) and say which building it's for: **The Tower** or **DSQ**. Each building's agenda is separate (uploading DSQ's never replaces the Tower's). Porter names in the sheet are read; jobs without porters are **assigned automatically** (can be switched off in the upload box), and anything can be changed from the dropdown in the table (several people, or **Everyone**). The upload box also lets you tap anyone who's off that day.
- **Who's in** (above the table): everyone working that day by building, with their shift and task count, then who's off and why (PTO, SIC, Holiday…). Click a name to mark someone off for the day (sick) or back in. If they had jobs, the app offers to move them: rooms they shared go to the other person on it, the rest are given out again automatically. Ticked tasks stay as they are.
- **Auto-assign**: fill the jobs without porters, or re-shuffle the automatic picks nobody has started. The rules are in [src/autoassign.js](src/autoassign.js): Tower jobs go to the people at the Tower that day, DSQ jobs to the DSQ people; nobody gets a task outside their shift (AM 06:30–15:30, PM 09:00–18:00; a room that doesn't fit one shift is split); random but fair (same number of tasks each); nobody in two rooms within 15 minutes; Davina does tea/coffee and breakfasts before 10:30 in whichever building she's in (never lunch, never Ohana floor setups); Tom gets as few tea/coffee and breakfasts as possible and never a room with breakfast and lunch.
- **Rota**: upload the weekly rota (screenshot or spreadsheet: names down the side, dates along the top). AM / PM = shift, "DSQ" = at DSQ, SIC = on Level 37, gets only the L37 jobs; PTO / Sick / Off / blank / blacked out = no tasks. Names are matched by first name ("Jeet Chand Mehay" → Jeet); anyone new is added as a porter at the building they mostly work in. Every day can be changed in the grid. Below it, **Holidays booked**: time off entered ahead, so those days start as off.
- **Lunch** (under Who's in): everyone working gets a 1-hour lunch, planned automatically when the agenda is uploaded ([src/lunch.js](src/lunch.js)). It fits inside 10:30–14:30 and their shift, never covers a task (the 30 minutes before each of their tasks stay free), and at most 2 people per building are at lunch at once (3 only when the tasks leave no other way). Early starters go early, 9am starters later. Davina has none (her shift is too short). Carlos on L37 gets one but doesn't use up a place. Click a name to move their lunch: each time shows whether it clashes or makes 3 at once. A lunch set by hand stays put. If tasks change later, automatic lunches that no longer fit are re-planned, but ones that have started (or start within 30 min) aren't moved. The porter sees "Your lunch" in their list.
- **Quick jobs**: *Add job → Quick job* for something that comes up during the day: task, location, description, building, how long it takes (15 minutes unless you change it), porter(s). It's for today and is given out straight away, with a notification. In the porter list, green = nothing in the next 30 minutes (or the whole length of the job, if it's longer); red = a task due in that time, at lunch or going within it, still on another quick job (given out less than its length ago and not ticked), or not on shift. The reason is shown under the name. Free people come first, fewest quick jobs today first. The **Quick jobs** line under Who's in counts how many each person has had today. Hosts don't see quick jobs.
- A job's porters cell warns when someone on it is off, in the other building, outside their shift, or on lunch.
- Live table: a task turns green when a porter ticks it, a row turns green when the job is finished, no refresh needed
- Add, edit, delete and tick any job
- **History**: every past day, with who ticked what and when
- **Hosts**: a permanent list of host names for the Host dropdown. New names found in an upload are offered for adding with one click.
- **Porters**: add or remove team members, set their usual building (for days without a rota) and whether they get general tasks (Carlos doesn't: he only gets the Level 37 jobs), see who has notifications on
- Several admins: `ADMIN_PIN` is `ADMIN_NAME`'s password; more people go in `ADMIN_ACCOUNTS` (`Name:password,Name2:password2`). Everyone logs in with their name, and uploads/ticks show who did them.
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
2. The admin opens the dashboard and taps **Upload agenda** (Tower or DSQ).
3. A few seconds later the jobs appear, with porters shared out among whoever the rota says is working. Give them a quick check against the screenshot.
4. Once a week: **Rota → Upload rota** with the new week's rota.
5. Someone calls in sick: click their name in **Who's in** and let the app move their jobs.

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
