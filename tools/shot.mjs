// Screenshot harness: node tools/shot.mjs <outdir> <route...>  (demo mode, mobile + desktop). Prints console errors.
import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const [outDir, ...routes] = process.argv.slice(2);
const base = process.env.BASE || 'http://localhost:8123/forge/';
const demo = process.env.DEMO !== '0'; // DEMO=0 → no demo, DEMO=empty → fresh-vault demo (seeds only)
const demoQuery = process.env.DEMO === 'empty' ? '?demo=empty' : '?demo=1';
const sizes = (process.env.SIZES || 'mobile').split(',');
const VIEW = { mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { width: 1360, height: 900 } };
const browser = await chromium.launch();
let failures = 0;
for (const size of sizes) {
  const ctx = await browser.newContext({ viewport: { width: VIEW[size].width, height: VIEW[size].height }, deviceScaleFactor: VIEW[size].deviceScaleFactor || 1, isMobile: !!VIEW[size].isMobile, hasTouch: !!VIEW[size].hasTouch, colorScheme: process.env.SCHEME || 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  for (const r of routes) {
    errors.length = 0;
    await page.goto(base + (demo ? demoQuery : '') + '#/' + r, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(Number(process.env.WAIT || 1800));
    const file = `${outDir}/${size}${process.env.SCHEME === 'light' ? '-light' : ''}${process.env.DEMO === 'empty' ? '-empty' : ''}-${r.replace(/[\/?=&]/g, '_') || 'root'}.png`;
    await page.screenshot({ path: file, fullPage: process.env.FULL !== '0' });
    const crash = await page.locator('text=This screen hit an error').count();
    console.log(`${size} ${r}: ${errors.length ? 'ERRORS ' + JSON.stringify(errors.slice(0, 3)) : 'ok'}${crash ? ' SCREEN-CRASH' : ''} -> ${file}`);
    if (errors.length || crash) failures++;
  }
  await ctx.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
