'use strict';
/*
 * GASF Print Calendar — headless-Chrome renderer
 *
 * Renders the MEC month grid to single-page landscape US-Letter PDFs — one per
 * month, for the current month plus the next N (default 6) — so the website's
 * "Print Calendar" button can link to whichever month the visitor is viewing.
 *
 * Per month it produces  calendar-YYYY-MM.pdf  (+ calendar.pdf for the current
 * month, as a no-JS fallback / default link).
 *
 * How a specific month is obtained: the live page only loads the current month;
 * MEC fetches other months via an AJAX POST to admin-ajax.php
 * (action=mec_monthly_view_load_month, mec_year/mec_month + the skin `atts`),
 * which returns {month, navigator, ...}. We replay that POST per target month
 * and inject the returned HTML — no fragile click-driven navigation.
 *
 * One-page fit: isolate the calendar element, then bisection-search a print
 * `scale` so the grid fills the page without spilling to a 2nd page — for any
 * month/density, no manual tuning. pageRanges:'1' is a hard backstop.
 *
 * Env knobs:
 *   CHROME_PATH   chromium binary (default /usr/bin/chromium-browser on Linux)
 *   CAL_URL       calendar page URL
 *   OUT_DIR       output directory for the PDFs (default this dir)
 *   MONTHS_AHEAD  how many months past the current one to render (default 6)
 *   SCALE         force a fixed scale (skip auto-fit)
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.CAL_URL || 'https://germantampabay.com/calendar-of-events/';
const OUT_DIR = process.env.OUT_DIR || __dirname;
const MONTHS_AHEAD = parseInt(process.env.MONTHS_AHEAD || '6', 10);
const FORCED_SCALE = process.env.SCALE ? parseFloat(process.env.SCALE) : null;

// US Letter, landscape. Inches. Bottom margin is larger to seat the footer.
const PAPER_W_IN = 11;
const PAPER_H_IN = 8.5;
const M_TOP = parseFloat(process.env.MARGIN_TOP || '0.3');
const M_BOT = parseFloat(process.env.MARGIN_BOTTOM || '0.45');
const M_SIDE = parseFloat(process.env.MARGIN_SIDE || '0.3');
const CSS_PX_PER_IN = 96;
const PRINT_W_IN = PAPER_W_IN - 2 * M_SIDE;
const PRINT_H_IN = PAPER_H_IN - M_TOP - M_BOT;
const PRINT_H_PX = PRINT_H_IN * CSS_PX_PER_IN;

const SCALE_MIN = 0.35;
const SCALE_MAX = 1.0; // keep layout >= ~998px so MEC never drops to mobile list
const FILL_SAFETY = 0.95;

// Footer printed in the bottom margin of every page. Gold (#ef9e26) to match the
// MEC month heading; larger + bold so it stands out on the printed sheet.
const FOOTER = `
  <div style="font-size:14px; width:100%; box-sizing:border-box; padding:0 0.45in;
              color:#ef9e26; font-family:Arial,Helvetica,sans-serif; font-weight:bold;
              display:flex; justify-content:space-between; align-items:center;">
    <span style="letter-spacing:.4px;">German-American Society</span>
    <span>germantampabay.com</span>
  </div>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// Add `delta` months to a (year, month[1-12]) pair.
function addMonths(year, month, delta) {
  const t = year * 12 + (month - 1) + delta;
  return { year: Math.floor(t / 12), month: (t % 12) + 1 };
}

// Strip the page to just the calendar and neutralize the site's print quirks
// so the grid sizes naturally and measures deterministically.
function isolateCalendar() {
  const cal =
    document.querySelector('.mec-wrap') ||
    document.querySelector('#mec_skin_mec1') ||
    document.querySelector('.mec-calendar');
  if (cal) document.body.replaceChildren(cal);

  const css = `
    /* Kill the site's print @page margin (0.4in) so ONLY page.pdf()'s margins
       apply — otherwise they stack and the grid clips. */
    @page { margin: 0; }
    html, body { margin:0 !important; padding:0 !important; background:#fff !important; }
    .mec-wrap, #mec_skin_mec1, .mec-calendar {
      width:100% !important; max-width:100% !important;
      margin:0 !important; padding:0 !important; float:none !important; background:#fff !important;
    }
    /* MEC nav / view switcher / month arrows — not wanted in print */
    .mec-totalcal-box,
    .mec-calendar-side .mec-next-month,
    .mec-calendar-side .mec-previous-month { display:none !important; }
    /* Undo the site's failed print fixed-height hacks so rows size to content */
    dl.mec-calendar-row { height:auto !important; }
    dt.mec-calendar-day { height:auto !important; line-height:1.25 !important; }
    /* Neutralize the on-screen "today" yellow for a clean monochrome print */
    .mec-calendar .mec-calendar-day.mec-selected-day { background:#fff !important; color:#000 !important; }
    .mec-calendar, .mec-calendar * { color:#000 !important; }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

// Read the currently-displayed month (YYYY, MM) from the loaded calendar.
async function readBaseMonth(page) {
  const m = await page.evaluate(() => {
    const sel =
      document.querySelector('.mec-month-container-selected') ||
      document.querySelector('[id^="mec_monthly_view_month_"]');
    if (!sel) return null;
    const mm = (sel.id.match(/(\d{6})$/) || [])[1] || sel.getAttribute('data-month-id');
    return mm && mm.length === 6 ? mm : null;
  });
  if (!m) throw new Error('could not determine current month');
  return { year: parseInt(m.slice(0, 4), 10), month: parseInt(m.slice(4, 6), 10) };
}

// Capture the exact admin-ajax POST body MEC sends to load a month (encodes the
// skin `atts`). We trigger one next-month click purely to intercept the request;
// the DOM update it would do is irrelevant — we inject months ourselves.
async function capturePostData(page) {
  let captured = null;
  const onReq = (req) => {
    try {
      if (req.method() === 'POST' && req.url().includes('admin-ajax')) {
        const pd = req.postData() || '';
        if (pd.includes('mec_monthly_view_load_month')) captured = pd;
      }
    } catch (_) {}
  };
  page.on('request', onReq);
  await page.evaluate(() => {
    if (window.jQuery) window.jQuery('.mec-next-month').first().trigger('click');
  });
  for (let i = 0; i < 60 && !captured; i++) await sleep(100);
  page.off('request', onReq);
  if (!captured) throw new Error('could not capture MEC AJAX postData');
  return captured;
}

// Replay the month-load AJAX for a target month and inject the returned HTML
// (grid + navigator/title) into the live calendar structure.
async function injectMonth(page, postData, year, month) {
  return page.evaluate(
    async (pd, y, mm) => {
      const body = pd
        .replace(/(&mec_year=)\d+/, '$1' + y)
        .replace(/(&mec_month=)\d+/, '$1' + mm);
      let j;
      try {
        const r = await fetch('/wp-admin/admin-ajax.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'same-origin',
          body,
        });
        j = await r.json();
      } catch (e) {
        return { ok: false, err: String(e) };
      }
      if (!j || !j.month) return { ok: false };
      const table = document.querySelector('.mec-calendar-table');
      const navc = document.querySelector('.mec-skin-monthly-view-month-navigator-container');
      if (table)
        table.innerHTML =
          '<div class="mec-month-container mec-month-container-selected">' + j.month + '</div>';
      if (navc) navc.innerHTML = '<div class="mec-month-navigator">' + (j.navigator || '') + '</div>';
      return { ok: true, len: j.month.length };
    },
    postData,
    String(year),
    pad2(month)
  );
}

// Largest print scale whose rendered height still fits one page.
async function autoFit(page) {
  if (FORCED_SCALE != null) return FORCED_SCALE;
  const heightAt = async (scale) => {
    const layoutW = Math.round((PRINT_W_IN * CSS_PX_PER_IN) / scale);
    await page.setViewport({ width: layoutW, height: 100, deviceScaleFactor: 1 });
    await sleep(250);
    return page.evaluate(() => {
      const el = document.body.firstElementChild;
      return Math.ceil(
        (el || document.body).getBoundingClientRect().height
      );
    });
  };
  let lo = SCALE_MIN, hi = SCALE_MAX, best = SCALE_MIN;
  for (let i = 0; i < 7; i++) {
    const s = (lo + hi) / 2;
    const h = await heightAt(s);
    if (h * s <= PRINT_H_PX * FILL_SAFETY) {
      best = s;
      lo = s;
    } else {
      hi = s;
    }
  }
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, best));
}

async function renderMonth(page, outPath) {
  await page.evaluate(isolateCalendar);
  await page.emulateMediaType('print');
  try {
    await page.evaluate(() => document.fonts && document.fonts.ready);
  } catch (_) {}
  const scale = await autoFit(page);
  await page.pdf({
    path: outPath,
    printBackground: true,
    landscape: true,
    format: 'Letter',
    scale,
    margin: { top: M_TOP + 'in', bottom: M_BOT + 'in', left: M_SIDE + 'in', right: M_SIDE + 'in' },
    pageRanges: '1',
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: FOOTER,
  });
  return scale;
}

async function gotoCalendar(page) {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.mec-calendar', { timeout: 30000 });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    // --disable-dev-shm-usage is REQUIRED on the Jabra ploop container.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--hide-scrollbars',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

    // Determine the current month and capture the AJAX template once.
    await gotoCalendar(page);
    const base = await readBaseMonth(page);
    const postData = await capturePostData(page);
    console.log(
      'Base month', base.year + '-' + pad2(base.month),
      '| MONTHS_AHEAD', MONTHS_AHEAD,
      '| postData', postData.length, 'bytes'
    );

    let okCount = 0;
    for (let off = 0; off <= MONTHS_AHEAD; off++) {
      const t = addMonths(base.year, base.month, off);
      const tag = t.year + '-' + pad2(t.month);
      const out = path.join(OUT_DIR, 'calendar-' + tag + '.pdf');
      try {
        await gotoCalendar(page); // fresh DOM per month
        const inj = await injectMonth(page, postData, t.year, t.month);
        if (!inj.ok) {
          console.log('WARN', tag, 'inject failed:', inj.err || 'no month html');
          continue;
        }
        const scale = await renderMonth(page, out);
        console.log('Wrote', path.basename(out), '(scale', scale.toFixed(3) + ')');
        if (off === 0) {
          fs.copyFileSync(out, path.join(OUT_DIR, 'calendar.pdf'));
          console.log('  also -> calendar.pdf (current-month default)');
        }
        okCount++;
      } catch (e) {
        console.log('WARN', tag, 'render failed:', e.message);
      }
    }
    console.log('Rendered', okCount, 'of', MONTHS_AHEAD + 1, 'months');
    if (okCount === 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
