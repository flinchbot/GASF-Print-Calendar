'use strict';
/*
 * GASF Print Calendar — headless-Chrome renderer (proof-of-concept stage)
 *
 * Renders the live MEC calendar page to a single landscape US-Letter PDF.
 * The site's existing `@media print` CSS already hides the header/footer/
 * sidebar and forces the grid full-width; page.pdf() emulates print media,
 * so those rules apply automatically. The only thing CSS could not do —
 * shrink the too-tall grid onto one page — is handled here by `scale`.
 *
 * Usage:
 *   node render.js [scale]
 *   SCALE=0.6 ONE_PAGE=1 OUT=calendar.pdf node render.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.CAL_URL || 'https://germantampabay.com/calendar-of-events/';
const SCALE = parseFloat(process.env.SCALE || process.argv[2] || '0.6');
const ONE_PAGE = process.env.ONE_PAGE === '1';
const OUT = process.env.OUT || path.join(__dirname, `calendar-scale-${SCALE}.pdf`);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    // --disable-dev-shm-usage is REQUIRED on the Jabra ploop/Virtuozzo container
    // (its /dev/shm is tiny; without this Chrome crashes mid-render). The rest
    // keep the process lean on the 2 GB box. All are harmless on Windows too.
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
    // Present as a normal desktop Chrome so Cloudflare serves the real page
    // and MEC renders the desktop month grid (not the mobile list view).
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

    console.log('Navigating to', URL);
    const resp = await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('HTTP', resp && resp.status());

    try {
      await page.waitForSelector('.mec-calendar', { timeout: 30000 });
      console.log('Found .mec-calendar grid');
    } catch (e) {
      console.log('WARN: .mec-calendar not found within timeout');
    }
    // Let late fonts/assets settle before printing.
    await new Promise((r) => setTimeout(r, 2500));
    console.log('Page title:', await page.title());

    const pdfOpts = {
      path: OUT,
      printBackground: true,
      landscape: true,
      format: 'Letter', // 8.5 x 11 portrait; landscape rotates to 11 x 8.5
      scale: SCALE,
      margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' },
    };
    if (ONE_PAGE) pdfOpts.pageRanges = '1';

    await page.pdf(pdfOpts);
    console.log('Wrote', OUT, '(scale', SCALE + (ONE_PAGE ? ', pageRanges=1)' : ')'));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
