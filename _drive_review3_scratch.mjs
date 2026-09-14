import { chromium } from 'playwright';

const OUT = '/private/tmp/claude-502/-Users-rizwan1-Desktop-canvasmith/b867d0d9-e1a0-46df-a8b6-0eb6c2fcae07/scratchpad';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

await page.goto('http://localhost:8901/apps/demo/index.html');
await page.waitForSelector('#right-tabs', { timeout: 15000 });

const dataUrl = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 400; c.height = 400;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e0d0'; ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = '#d4645a'; ctx.beginPath(); ctx.arc(150, 150, 70, 0, 7); ctx.fill();
  ctx.fillStyle = '#2a6fdb'; ctx.fillRect(220, 200, 120, 90);
  return c.toDataURL('image/png');
});
await page.evaluate((url) => { window.postMessage({ type: 'canvasmith:open', dataURL: url }, '*'); }, dataUrl);
await page.waitForTimeout(800);

await page.click('#right-tabs button[data-tab="ai"]');
await page.waitForTimeout(200);
await page.click('#convert-manual');
await page.waitForTimeout(300);

const canvasRect = await page.locator('#cv').boundingBox();
// Scene (0..W, 0..H) -> screen, via the real fabric viewportTransform (matches sceneToScreen in-app).
async function S(sx, sy) {
  return page.evaluate(({ sx, sy, left, top }) => {
    const v = window.ed.fc.viewportTransform;
    return { x: left + sx * v[0] + v[4], y: top + sy * v[3] + v[5] };
  }, { sx, sy, left: canvasRect.x, top: canvasRect.y });
}
async function clickScene(sx, sy) { const p = await S(sx, sy); await page.mouse.click(p.x, p.y); }
async function dragScene(sx0, sy0, sx1, sy1) {
  const a = await S(sx0, sy0), b = await S(sx1, sy1);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
}

// --- Box ---
await page.click('#review-handtools button[data-mode="box"]');
await page.waitForTimeout(100);
await dragScene(80, 400, 280, 560);
await page.waitForTimeout(300);
console.log('after box, count:', await page.evaluate(() => document.getElementById('review-count').textContent));

// --- Lasso ---
await page.click('#review-handtools button[data-mode="lasso"]');
await page.waitForTimeout(100);
{
  const pts = [[350, 400], [420, 340], [480, 380], [430, 480]];
  const p0 = await S(...pts[0]);
  await page.mouse.move(p0.x, p0.y); await page.mouse.down();
  for (const [sx, sy] of pts.slice(1)) { const p = await S(sx, sy); await page.mouse.move(p.x, p.y, { steps: 3 }); }
  await page.mouse.up();
}
await page.waitForTimeout(300);
console.log('after lasso, count:', await page.evaluate(() => document.getElementById('review-count').textContent));

// --- Polygon (click to place, Enter to finish) ---
await page.click('#review-handtools button[data-mode="polylasso"]');
await page.waitForTimeout(100);
await clickScene(500, 450);
await clickScene(600, 420);
await clickScene(620, 520);
await page.waitForTimeout(100);
await page.screenshot({ path: `${OUT}/05-polygon-building.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
console.log('after polygon, count:', await page.evaluate(() => document.getElementById('review-count').textContent));
console.log('poly button still active?', await page.evaluate(() => document.querySelector('#review-handtools button[data-mode="polylasso"]').dataset.on));

// --- Magnetic (edge-snap click-to-place) ---
await page.click('#review-handtools button[data-mode="maglasso"]');
await page.waitForFunction(() => window.ed && window.ed._edgeMap, { timeout: 5000 });
await clickScene(150, 200);
await clickScene(280, 160);
await clickScene(280, 300);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
console.log('after magnetic, count:', await page.evaluate(() => document.getElementById('review-count').textContent));
console.log('last region bbox within artboard?', await page.evaluate(() => {
  const regions = window.ed.fc.getObjects().filter(o => o.role === 'region');
  const o = regions[regions.length - 1]; if (!o) return null;
  o.setCoords(); const a = o.aCoords;
  return { tl: a.tl, br: a.br, W: window.ed.W, H: window.ed.H,
    inBounds: a.tl.x >= -5 && a.tl.y >= -5 && a.br.x <= window.ed.W + 5 && a.br.y <= window.ed.H + 5 };
}));

await page.screenshot({ path: `${OUT}/06-multi-regions.png` });

// --- Type change ---
const typeBtn = await page.$('.review-type-btn[data-type="logo"]');
if (typeBtn) { await typeBtn.click(); await page.waitForTimeout(150); }
await page.screenshot({ path: `${OUT}/07-type-changed.png` });

// --- Delete ---
await page.click('#review-delete');
await page.waitForTimeout(200);
console.log('after delete, count:', await page.evaluate(() => document.getElementById('review-count').textContent));

// --- Auto-detect ---
await page.click('#review-autodetect');
await page.waitForTimeout(2500);
console.log('after autodetect, count:', await page.evaluate(() => document.getElementById('review-count').textContent));
await page.screenshot({ path: `${OUT}/08-autodetect.png` });

// --- Object select-by-hand: click on the red circle ---
await page.click('#review-handtools button[data-mode="object"]');
await page.waitForTimeout(100);
await clickScene(150, 150);
await page.waitForTimeout(1200);
console.log('after object click, count:', await page.evaluate(() => document.getElementById('review-count').textContent));
await page.screenshot({ path: `${OUT}/09-object-select.png` });

// --- Hover preview: rest cursor on a region box ---
await page.mouse.move((await S(150, 150)).x, (await S(150, 150)).y);
await page.waitForTimeout(600);
console.log('hover preview visible:', await page.evaluate(() => !document.getElementById('review-hover-preview').hidden));
await page.screenshot({ path: `${OUT}/10-hover.png` });

// --- Extract one region ---
const extractBtn = await page.$('#review-extract');
if (extractBtn && !(await extractBtn.isDisabled())) {
  await extractBtn.click();
  await page.waitForTimeout(1500);
  console.log('after extract, count:', await page.evaluate(() => document.getElementById('review-count').textContent));
  console.log('review panel still open after extract (should stay open if boxes remain):', await page.evaluate(() => !document.getElementById('review-panel').hidden));
}

// --- Cancel ---
await page.click('#review-cancel');
await page.waitForTimeout(200);
console.log('panel hidden after cancel:', await page.evaluate(() => document.getElementById('review-panel').hidden));
console.log('leftover region objects after cancel:', await page.evaluate(() => window.ed.fc.getObjects().filter(o => o.role === 'region').length));

console.log('ERRORS:', JSON.stringify(errors, null, 2));
await browser.close();
