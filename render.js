'use strict';
/*
 * GASF Print Calendar — headless-Chrome renderer
 *
 * Renders the live MEC month grid to a single landscape US-Letter PDF that
 * fills the sheet and always lands on exactly one page.
 *
 * Why this exists: pure `@media print` CSS got the width right but could not
 * (a) drop the site footer cleanly or (b) shrink a tall 6-week grid onto one
 * page. A headless render can. We isolate the calendar element so nothing
 * below it (footer/colophon) can bleed in, then auto-fit a print `scale` so
 * the grid fills the page height without spilling to page 2 — for any month,
 * any event density, with no manual tuning.
 *
 * Usage:
 *   node render.js                      # auto-fit scale, default out path
 *   SCALE=0.7 node render.js            # force a fixed scale (skip auto-fit)
 *   CHROME_PATH=/usr/bin/chromium-browser CAL_URL=... OUT=/tmp/cal.pdf node render.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.CAL_URL || 'https://germantampabay.com/calendar-of-events/';
const OUT = process.env.OUT || path.join(__dirname, 'calendar.pdf');

// US Letter, landscape. Inches.
const PAPER_W_IN = 11;
const PAPER_H_IN = 8.5;
const MARGIN_IN = parseFloat(process.env.MARGIN_IN || '0.3');
const CSS_PX_PER_IN = 96; // CSS reference pixel
const PRINT_W_IN = PAPER_W_IN - 2 * MARGIN_IN;
const PRINT_H_IN = PAPER_H_IN - 2 * MARGIN_IN;
const PRINT_H_PX = PRINT_H_IN * CSS_PX_PER_IN;

// Keep the layout width above MEC's responsive breakpoint so the grid never
// collapses to its mobile list view. width = PRINT_W_IN*96 / scale, so a
// scale ceiling of 1.0 keeps the layout >= ~998px (desktop grid).
const SCALE_MIN = 0.35;
const SCALE_MAX = 1.0;
const FILL_SAFETY = 0.95; // headroom so sub-pixel/reflow drift never tips to page 2

const FORCED_SCALE = process.env.SCALE ? parseFloat(process.env.SCALE) : null;

// Strip the page down to just the calendar and neutralize the site's
// screen/print quirks (incl. the earlier failed fixed-height hacks) so the
// grid sizes naturally and we can measure + fit it deterministically.
function isolateCalendar() {
  const cal =
    document.querySelector('.mec-wrap') ||
    document.querySelector('#mec_skin_mec1') ||
    document.querySelector('.mec-calendar');
  if (cal) document.body.replaceChildren(cal);

  const css = `
    /* Kill the site's print @page margin (0.4in) so ONLY page.pdf()'s margins
       apply — otherwise the two stack and the real printable area shrinks,
       making the grid taller than our geometry model and clipping the last
       week row. With this at 0, page.pdf({margin}) is the single source. */
    @page { margin: 0; }
    html, body {
      margin: 0 !important; padding: 0 !important; background: #fff !important;
    }
    .mec-wrap, #mec_skin_mec1, .mec-calendar {
      width: 100% !important; max-width: 100% !important;
      margin: 0 !important; padding: 0 !important; float: none !important;
      background: #fff !important;
    }
    /* MEC nav / view switcher / month arrows — not wanted in print */
    .mec-totalcal-box,
    .mec-calendar-side .mec-next-month,
    .mec-calendar-side .mec-previous-month { display: none !important; }
    /* Undo the site's failed print fixed-height hacks so rows size to content */
    dl.mec-calendar-row { height: auto !important; }
    dt.mec-calendar-day { height: auto !important; line-height: 1.25 !important; }
    /* Neutralize the on-screen "today" yellow for a clean monochrome print */
    .mec-calendar .mec-calendar-day.mec-selected-day {
      background: #fff !important; color: #000 !important;
    }
    .mec-calendar, .mec-calendar * { color: #000 !important; }
  `;
  const s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    // --disable-dev-shm-usage is REQUIRED on the Jabra ploop/Virtuozzo
    // container (tiny /dev/shm). The rest keep the process lean on 2 GB RAM.
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

    console.log('Navigating to', URL);
    const resp = await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('HTTP', resp && resp.status());
    await page.waitForSelector('.mec-calendar', { timeout: 30000 });
    console.log('Found .mec-calendar grid');

    // Optional: advance N months via MEC's AJAX next-month nav. Lets the club
    // print a future month, and is how we stress-test the 6-week worst case.
    const monthsForward = parseInt(process.env.MONTHS_FORWARD || '0', 10);
    for (let i = 0; i < monthsForward; i++) {
      const before = await page.$eval('.mec-next-month', (el) =>
        el.getAttribute('data-mec-month')
      );
      await page.click('.mec-next-month');
      await page.waitForFunction(
        (b) => {
          const el = document.querySelector('.mec-next-month');
          return el && el.getAttribute('data-mec-month') !== b;
        },
        { timeout: 20000 },
        before
      );
      await new Promise((r) => setTimeout(r, 500)); // settle after AJAX swap
    }
    if (monthsForward > 0) console.log('Advanced', monthsForward, 'month(s)');

    await page.evaluate(isolateCalendar);
    // Print layout is what the PDF uses; measure under it.
    await page.emulateMediaType('print');
    try {
      await page.evaluate(() => document.fonts && document.fonts.ready);
    } catch (_) {}

    // Measure the calendar's natural height at a given print layout width.
    // Measure the isolated calendar ELEMENT (body's only child), not
    // documentElement.scrollHeight — the latter is clamped up to the viewport
    // height and would over-report for a short calendar. Tiny viewport height
    // keeps anything from inflating the number.
    const heightAtScale = async (scale) => {
      const layoutW = Math.round((PRINT_W_IN * CSS_PX_PER_IN) / scale);
      await page.setViewport({ width: layoutW, height: 100, deviceScaleFactor: 1 });
      await new Promise((r) => setTimeout(r, 250)); // let it reflow
      return page.evaluate(() => {
        const el = document.body.firstElementChild;
        const h = el
          ? el.getBoundingClientRect().height
          : document.body.getBoundingClientRect().height;
        return Math.ceil(h);
      });
    };

    let scale = FORCED_SCALE;
    if (scale == null) {
      // Bisection: rendered height = H(scale) * scale (px). H grows as scale
      // grows (narrower layout → more wrapping), so H*scale is monotonic —
      // find the largest scale whose rendered height still fits the page.
      let lo = SCALE_MIN;
      let hi = SCALE_MAX;
      let best = SCALE_MIN;
      for (let i = 0; i < 7; i++) {
        const s = (lo + hi) / 2;
        const h = await heightAtScale(s);
        const renderedPx = h * s;
        if (renderedPx <= PRINT_H_PX * FILL_SAFETY) {
          best = s;
          lo = s;
        } else {
          hi = s;
        }
      }
      scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, best));
      console.log('Auto-fit scale:', scale.toFixed(3));
    } else {
      console.log('Forced scale:', scale);
    }

    console.log('Page title:', await page.title());
    await page.pdf({
      path: OUT,
      printBackground: true,
      landscape: true,
      format: 'Letter', // 8.5 x 11 portrait; landscape rotates to 11 x 8.5
      scale,
      margin: {
        top: MARGIN_IN + 'in',
        bottom: MARGIN_IN + 'in',
        left: MARGIN_IN + 'in',
        right: MARGIN_IN + 'in',
      },
      pageRanges: '1', // hard backstop: never emit a second page
    });
    console.log('Wrote', OUT, '(scale', scale.toFixed ? scale.toFixed(3) : scale, ')');
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
