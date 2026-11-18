# Porters Agenda

A phone-friendly version of the daily porters agenda. Someone uploads the screenshot from the group chat, Claude reads it, and every porter sees their jobs as cards they can tick off. Ticks sync between phones within about 10 seconds.

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
nano .env            # set ANTHROPIC_API_KEY and TEAM_PIN

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

The longer timeout and the larger upload size limit matter: reading a screenshot can take up to a minute.

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
2. Anyone saves the image, opens the app and taps **Upload** (or ☰ → *Upload agenda screenshot*).
3. After about 20–60 seconds the jobs appear on everyone's phone. Check them quickly against the screenshot; the app lists anything Claude wasn't sure about.

If the agenda is split across two screenshots, pick both at once, or upload the second one with **Add more rows**. If the boss posts a corrected sheet, upload it with **Replace**. Ticks stay on the jobs that didn't change.

## Costs

Each upload sends the screenshot(s) to the Claude API once (model `claude-opus-5-5`). For one screenshot a day that comes to a few pence. Ticking, filtering and viewing cost nothing. The `TEAM_PIN` stops strangers from running up the bill.

Refusal fallback is switched on (`fallbacks: "default"`). If the main model declines an image, the API retries it on another model automatically. Delete those two lines in `src/extract.js` to turn it off.

## Developing locally

```bash
npm install
# Fake mode: uses a hand-typed copy of the 18/11/2026 agenda, no API key needed
EXTRACT_MOCK=1 TEAM_PIN=1234 node server.js
# Real mode
ANTHROPIC_API_KEY=sk-ant-... TEAM_PIN=1234 node server.js
```

Open http://localhost:3000.

## Files

| Path | What it is |
|---|---|
| `server.js` | Express server: login PIN, upload, ticks, editing, saving `data/state.json` |
| `src/extract.js` | Sends the screenshot to Claude and gets the rows back as structured JSON |
| `src/mock-extraction.json` | Fake reading of the 18/11 screenshot, used when `EXTRACT_MOCK=1` |
| `public/` | The app: `index.html`, `app.css`, `app.js` (no build step) |
| `deploy/nginx-porters.conf` | nginx snippet for `/porters/` |
