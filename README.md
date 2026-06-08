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
cron (4x/day, Eastern)
  └─ run.sh                         /opt/gasf-print-calendar  (Jabra box, AlmaLinux 8)
       ├─ render.js  ──► headless Chromium ──► https://germantampabay.com/calendar-of-events/
       │                  · isolate the .mec-wrap calendar element (drop header/footer/sidebar)
       │                  · auto-fit a print `scale` so it fills one landscape page
       │                  · write calendar.pdf
       └─ scp ──► germanta@box5763.bluehost.com:2222
                    └─ /home4/germanta/public_html/wp-content/uploads/calendar.pdf
                         └─ served at https://germantampabay.com/wp-content/uploads/calendar.pdf
                              └─ linked by WP snippet #22's "🖨 Print Calendar" button (page 8647)
```

## How the render fits one page (`render.js`)

1. Load the live calendar, wait for `.mec-calendar`.
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
| `OUT` | `./calendar.pdf` | Output path |
| `SCALE` | *(unset → auto-fit)* | Force a fixed print scale, skipping auto-fit |
| `MARGIN_IN` | `0.3` | Page margin (inches) |
| `DEBUG_EXTRA_ROWS` | `0` | Test hook: clone N week rows to simulate a taller month |

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
- **Schedule**: root crontab — `15 6,12,17,22 * * *` (6:15a / 12:15p / 5:15p /
  10:15p Eastern). The box is on Eastern time, matching the Tampa calendar.

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
`the_content` on page 8647:

```html
<a class="gasf-print-calendar-btn" href="/wp-content/uploads/calendar.pdf" target="_blank" rel="noopener">🖨 Print Calendar</a>
```

Styling is unchanged — the existing `.gasf-print-calendar-btn` CSS (in the
SiteOrigin stylesheet `so-css-hoot-du-premium.css`) already uses
`display:inline-flex; text-decoration:none` with explicit colors, so the anchor
renders identically to the old `<button>`. An `<a href>` is used rather than an
inline `onclick` because Cloudflare Rocket Loader rewrites inline handlers.

## Operations

```bash
# Manual render + upload (same as cron)
bash /opt/gasf-print-calendar/run.sh

# Watch the log
tail -n 40 /opt/gasf-print-calendar/render.log

# Render only, to a scratch file (no upload)
CHROME_PATH=/usr/bin/chromium-browser OUT=/tmp/test.pdf node /opt/gasf-print-calendar/render.js

# Stress-test a 6-week month
DEBUG_EXTRA_ROWS=1 OUT=/tmp/6wk.pdf node /opt/gasf-print-calendar/render.js
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
