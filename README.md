# GASF Print Calendar

Prints the German-American Society "Calendar of Events" month grid to a **single
landscape US-Letter page** — clean, readable, no site chrome.

The live page <https://germantampabay.com/calendar-of-events/> uses the Modern
Events Calendar (MEC) plugin. A **"🖨 Print Calendar"** button on that page links
to a cached PDF that is pre-sized to exactly one page, so printing is reliable
every time.

## Why a render job instead of CSS `@media print`

Pure `@media print` CSS got the width right but could not (a) drop the site
footer cleanly or (b) shrink a tall 6-week grid onto one page — browser print
engines won't shrink-to-fit from CSS, and MEC's grid is a `display:table`
definition list (`<dl>`/`<dt>`), not a real `<table>`, so height rules on
`table/tr/td` did nothing. Bluehost is PHP-only (no Chromium/Node), so it can't
render server-side either.

Solution: a scheduled **headless-Chrome render** on a machine that *does* have
Chrome (the always-on Jabra Linux box), producing a one-page landscape PDF that
is uploaded to the WordPress server. Chrome's print engine *can* scale-to-fit,
which is the one thing CSS could not do.

## Flow

```
cron (hourly, Eastern)
  └─ run.sh                         /opt/gasf-print-calendar  (Jabra box, AlmaLinux 8)
       ├─ render.js  ──► headless Chromium ──► https://germantampabay.com/calendar-of-events/
       │                  for the current month + the next 6:
       │                  · fetch the month via MEC's load-month AJAX (replayed, then injected)
       │                  · isolate the calendar element (drop header/footer/sidebar)
       │                  · auto-fit a print `scale` so it fills one landscape page
       │                  · stamp a footer (org name / website) in the page margin
       │                  · write calendar-YYYY-MM.pdf  (+ calendar.pdf for the current month)
       └─ scp ──► germanta@box5763.bluehost.com:2222
                    └─ /home4/germanta/public_html/wp-content/uploads/calendar-*.pdf
                         └─ served at .../wp-content/uploads/calendar-YYYY-MM.pdf
                              └─ WP snippet #22's "🖨 Print Calendar" button links to the
                                 month the visitor is viewing (updates on AJAX nav)
```

## How it renders (`render.js`)

Renders the **current month plus the next `MONTHS_AHEAD` (default 6)**, each to
`calendar-YYYY-MM.pdf` (current month also → `calendar.pdf`, a no-JS fallback).
The live page only serves the current month; other months are fetched by
**replaying MEC's `mec_monthly_view_load_month` AJAX** (the captured skin `atts`
with the target `mec_year`/`mec_month`) and injecting the returned grid + title —
no fragile click-driven navigation. A footer (org name + website) is stamped in
the bottom page margin via `displayHeaderFooter`.

Each month is fit to one page:

1. Load the calendar; if not the current month, AJAX-fetch + inject the target.
2. **Isolate** — replace `<body>` with just the `.mec-wrap` calendar element, so
   nothing below the grid (footer/colophon) can bleed into the PDF. Inject CSS to
   reset margins, force white background, hide MEC nav, neutralize the on-screen
   "today" highlight, and undo the site's failed fixed-height print hacks.
3. **Auto-fit** — under print emulation, bisection-search the print `scale`: the
   rendered height grows monotonically with scale (narrower layout → more text
   wrapping), so we find the largest scale whose rendered height still fits the
   page (× `FILL_SAFETY` headroom). This adapts to any month — 5 or 6 weeks,
   sparse or dense — with no manual tuning.
4. Render with `page.pdf({ landscape, format:'Letter', scale, pageRanges:'1' })`.
   `pageRanges:'1'` is a hard backstop so a second page can never be emitted.

Validated on the live 5-week month (June 2026, scale ≈ 0.89) and a forced 6-week
grid (scale ≈ 0.77) — both fill one page with every event readable.

### Environment knobs (render.js)

| Var | Default | Purpose |
|---|---|---|
| `CHROME_PATH` | `/usr/bin/chromium-browser` | Chrome/Chromium binary |
| `CAL_URL` | the live calendar page | Page to render |
| `OUT_DIR` | this directory | Where the `calendar-YYYY-MM.pdf` files are written |
| `MONTHS_AHEAD` | `6` | Months past the current one to render (total = N+1) |
| `SCALE` | *(unset → auto-fit)* | Force a fixed print scale, skipping auto-fit |
| `MARGIN_TOP` / `_BOTTOM` / `_SIDE` | `0.3` / `0.45` / `0.3` | Page margins (in); bottom is larger to seat the footer |

## Deployment (the Jabra box)

This runs on the **production Jabra Demos box** (`cloud.flinchbot.com` /
`162.244.253.96`) but is fully isolated from the `jabra-dashboard` pm2 processes
— it lives in `/opt/gasf-print-calendar`, has its own cron, and only reads its
own files + scps out.

- **Code**: `git clone` via a **read-only deploy key** (`~/.ssh/gasf_deploy`,
  SSH host alias `github-gasf`). Deploy = `git -C /opt/gasf-print-calendar pull`.
- **Browser**: EPEL Chromium (`dnf install chromium`), reversible via
  `dnf remove chromium`.
- **Node**: system `node` v22 (`/usr/bin/node`), `npm install` for puppeteer-core.
- **Schedule**: root crontab — `0 * * * *` (hourly, on the hour, Eastern). A full
  run (current month + 6) renders + uploads in ~40s. The box is on Eastern time,
  matching the Tampa calendar.

### Production-safety guard

The box is a 2 GB container also running the Jabra dashboard (~1 GB). A render
peaks at **~237 MB** for a few seconds, well within headroom (+2 GB swap). As
defense in depth, `run.sh` sets its own process tree to `oom_score_adj=800`, so
if memory ever ran out the kernel would kill *the render*, never the dashboard.
`--disable-dev-shm-usage` is required on this ploop container (tiny `/dev/shm`).
`flock` prevents overlapping renders.

## Upload (Jabra box → Bluehost)

The box pushes the PDF with a **dedicated** key (`~/.ssh/gasf_bluehost`, SSH
alias `gasf-bluehost`) whose public half is in Bluehost's `authorized_keys`.
Bluehost SSH is on **port 2222**. No password is stored anywhere.

## WordPress button

Code Snippets plugin, snippet **#22** "Calendar Print Button (page 8647)"
(`_4UX_snippets`, scope front-end). Source of truth:
[`wp/snippet-22-print-button.php`](wp/snippet-22-print-button.php). It appends to
`the_content` on page 8647 a button defaulting to the current month's PDF:

```html
<a class="gasf-print-calendar-btn" href="/wp-content/uploads/calendar.pdf" target="_blank" rel="noopener">🖨 Print Calendar</a>
```

plus a `data-cfasync="false"` script that **points the button at whichever month
the visitor is viewing**: it reads MEC's selected-month container
(`.mec-month-container-selected`, id ending `YYYYMM`), sets the href to
`calendar-YYYY-MM.pdf`, and re-applies via a `MutationObserver` as the visitor
uses MEC's AJAX month nav. The default link works with no JS; a month outside the
rendered window would 404 — raise `MONTHS_AHEAD` if that matters.

Styling is unchanged — the existing `.gasf-print-calendar-btn` CSS (in the
SiteOrigin stylesheet `so-css-hoot-du-premium.css`) already uses
`display:inline-flex; text-decoration:none` with explicit colors, so the anchor
renders identically to the old `<button>`. An `<a href>` (not an inline `onclick`)
and `data-cfasync="false"` both sidestep Cloudflare Rocket Loader.

## Operations

```bash
# Manual render + upload (same as cron)
bash /opt/gasf-print-calendar/run.sh

# Watch the log
tail -n 40 /opt/gasf-print-calendar/render.log

# Render to a scratch dir without uploading (e.g. current month + 2)
CHROME_PATH=/usr/bin/chromium-browser MONTHS_AHEAD=2 OUT_DIR=/tmp node /opt/gasf-print-calendar/render.js
```

**Tuning the size**: the calendar fills ~92% of the page by default. To leave
more/less margin, change `FILL_SAFETY` in `render.js` (lower = smaller). To pin a
fixed size regardless of month, set `SCALE=`.

**Changing the schedule**: edit root's crontab (`crontab -e`) on the box.

**Changing the button label**: edit `wp/snippet-22-print-button.php`, then sync
it into `_4UX_snippets` id 22 (the deploy note is in that file's header).

## Repo layout

| Path | Purpose |
|---|---|
| `render.js` | Headless-Chrome renderer (isolate + auto-fit → one-page PDF) |
| `run.sh` | Cron wrapper: OOM guard, flock, render, size-check, scp upload, logging |
| `wp/snippet-22-print-button.php` | Source of truth for the WordPress button (Code Snippets #22) |
| `package.json` | puppeteer-core dependency |
| `.gitattributes` | Forces LF on `.sh`/`.js` so a Windows edit can't break the Linux scripts |
