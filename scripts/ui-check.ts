// UI self-check: open the site, ask an example question, screenshot desktop and mobile.
// Usage: bun run scripts/ui-check.ts [baseUrl] [outDir]
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const out = process.argv[3] ?? '.';
const browser = await chromium.launch();
const errors: string[] = [];
for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base);
  await page.screenshot({ path: `${out}/ui-${name}-welcome.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(name, 'horizontal overflow px:', overflow);
  if (name === 'desktop') {
    await page.fill('#input', process.env.UI_QUESTION ?? 'Сколько стоят Сбербанк и Лукойл и какая у них дивдоходность?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.meta .badge', { timeout: 240_000 });
    await page.screenshot({ path: `${out}/ui-${name}-answer.png`, fullPage: true });
    console.log('answer chars:', (await page.textContent('.answer'))?.length, '| steps:', await page.locator('.step').count(), '| meta:', await page.textContent('.meta'));
  }
  await page.close();
}
await browser.close();
console.log('console errors:', errors.length ? errors : 'none');
