/* Browser-driven tests for the Editor/PaintEngine paths the pure node:test suite can't reach
   (see core.test.mjs's header comment) — real Fabric, real Canvas2D, driven through an actual
   Chromium instance via Playwright. Each test gets a fresh Editor via test/fixtures/browser-editor.html,
   which exposes window.__ed (already wired to installKeybindings via window.__stopKeys).

   Run with `npm run test:browser` (separately from `npm test`'s fast pure-logic suite — this one
   needs a browser download, so it's opt-in for local dev and a separate CI step). */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' };

let server, browser, baseURL;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(req.url.split('?')[0]);
      const filePath = join(ROOT, path);
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

let page;
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });
  await page.goto(baseURL + '/test/fixtures/browser-editor.html');
  await page.waitForFunction(() => window.__ready === true);
});

afterEach(async () => { if (page) await page.close(); });

/* ── shapes: click-drag sizing ────────────────────────────────────────────────────────── */
test('browser: click-drag creates a shape sized to the drag, Shift constrains to square', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 90, { steps: 4 });
  await page.mouse.up();
  const rect = await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; return { type: o.type, left: o.left, top: o.top, width: o.width, height: o.height }; });
  assert.equal(rect.type, 'rect');
  assert.equal(rect.left, 50); assert.equal(rect.top, 50);
  assert.equal(rect.width, 100); assert.equal(rect.height, 40);

  await page.evaluate(() => window.__ed.setTool('ellipse'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 50);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 90, { steps: 4 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  const ell = await page.evaluate(() => { const objs = window.__ed.fc.getObjects(); const o = objs[objs.length - 1]; return { rx: o.rx, ry: o.ry }; });
  assert.equal(ell.rx, ell.ry);   // Shift forces a 1:1 (circle) constraint
});

/* ── history: undo/redo across a real Fabric scene ────────────────────────────────────── */
test('browser: undo/redo reverts and reapplies a committed transform', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; window.__ed.setNumeric.call(window.__ed, { x: 999 }); });
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 50);
  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
});

/* ── layers: duplicate, reorder, remove ───────────────────────────────────────────────── */
test('browser: duplicateLayer, moveLayer and removeLayer mutate the scene as expected', async () => {
  const id1 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 10, top: 10, width: 30, height: 30, fill: '#ff0000' });
    o.set({ id: 'r1', role: 'shape', name: 'R1' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  const id2 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 50, top: 50, width: 30, height: 30, fill: '#00ff00' });
    o.set({ id: 'r2', role: 'shape', name: 'R2' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);

  const dupId = await page.evaluate((id) => window.__ed.duplicateLayer(id), id1);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 3);
  assert.ok(dupId && dupId !== id1);

  await page.evaluate((id) => window.__ed.removeLayer(id), id2);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);
});

/* ── paint engine: brush stroke actually paints pixels ────────────────────────────────── */
test('browser: brush tool paints non-transparent pixels into the paint layer', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.evaluate(() => window.__ed.setToolOptions({ size: 40, color: '#ff0000', opacity: 1 }));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 6 });
  await page.mouse.up();
  const hasPaint = await page.evaluate(() => {
    const ed = window.__ed;
    const paintLayer = ed.fc.getObjects().find(o => o.role === 'paint');
    if (!paintLayer) return false;
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  assert.equal(hasPaint, true);
});

/* ── selection: marquee drag produces a real pixel selection ──────────────────────────── */
test('browser: marquee drag sets ed.selection and finalizeSelection accepts it', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.__ed.selection);
  assert.equal(sel.kind, 'rect');
  assert.ok(sel.w > 6 && sel.h > 6);
});

/* ── keybindings: tool-switch, undo/redo, delete, arrow-nudge (installKeybindings) ────── */
test('browser: installKeybindings wires tool-switch letters and arrow-key nudge', async () => {
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');
  await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'select');

  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const before = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  const after1 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after1, before + 1);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  const after2 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after2, after1 + 10);
});

test('browser: installKeybindings wires delete/backspace on the active layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 0);
});

/* ── auto-detect: detectObjects / selectDetectedBox (cv-only, vendored OpenCV) ────────── */
test('browser: detectObjects resolves ok/error status and selectDetectedBox commits a real selection', async () => {
  // A blank artboard still rasterizes to a flat image via captureFlat() (a white rect, not "no
  // image") — Canny finds no edges in it, so this is the 'no_match' path, not 'no_image'.
  const emptyResult = await page.evaluate(() => window.__ed.detectObjects());
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.reason, 'no_match');

  // With a shape on the canvas, cv.detect() runs (via the vendored opencv.js) and returns a status.
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  const r = await page.evaluate(() => window.__ed.detectObjects(), null, { timeout: 20000 });
  assert.ok(r.status === 'ok' || r.status === 'error');
  if (r.status === 'ok' && r.result.boxes.length) {
    await page.evaluate((box) => window.__ed.selectDetectedBox(box), r.result.boxes[0]);
    const sel = await page.evaluate(() => window.__ed.selection);
    assert.equal(sel.kind, 'rect');
  }
});

/* ── gradient tool: drag paints a live-previewed, multi-stop/radial gradient into the paint layer ── */
test('browser: dragging the gradient tool paints a multi-stop linear gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'linear', gradientStops: [
      { offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' },
    ] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 380, canvasBox.y + 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x) => { const d = ctx.getImageData(x, 150, 1, 1).data; return [d[0], d[1], d[2]]; };
    return { left: at(20), middle: at(200), right: at(370) };
  });
  // left end should read red-dominant, middle green-dominant, right blue-dominant
  assert.ok(colors.left[0] > colors.left[2]);
  assert.ok(colors.middle[1] > colors.middle[0] && colors.middle[1] > colors.middle[2]);
  assert.ok(colors.right[2] > colors.right[0]);
});

test('browser: dragging the gradient tool with gradientType radial paints a radial gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'radial', gradientStops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return d[0]; };
    return { center: at(200, 150), edge: at(200, 5) };
  });
  assert.ok(colors.center > colors.edge);   // white at center, fading to black toward the edge
});

/* ── gradient fill on vector shapes ────────────────────────────────────────────────────────── */
test('browser: setShapeGradient applies a Fabric gradient fill, no-op on an image', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setShapeGradient([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], 'linear', 45));
  const g = await page.evaluate(() => window.__ed.getShapeGradient());
  assert.equal(g.type, 'linear');
  assert.equal(g.stops.length, 2);
  assert.equal(g.stops[0].color, '#ff0000');

  const isFabricGradient = await page.evaluate(() => {
    const o = window.__ed.fc.getObjects()[0];
    return typeof o.fill === 'object' && o.fill.type === 'linear';
  });
  assert.equal(isFabricGradient, true);
});

/* ── typography: setTextProps/getTextProps act only on text objects ──────────────────────── */
/* ── layer masks: paintable, non-destructive, image/paint-role layers only ───────────────────── */
/* ── adjustment layers: non-destructive, affect everything below their z-index ───────────────── */
test('browser: an adjustment layer darkens a shape below it, and no-ops on layers above', async () => {
  // A bright rect below where the adjustment layer will sit
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const beforeAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.deepEqual(beforeAlpha.slice(0, 3), [255, 255, 255]);   // white rect, unmodified

  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));   // darken everything below
  await page.waitForTimeout(50);
  const afterAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.ok(afterAlpha[0] < 255, `expected darkened red channel, got ${afterAlpha[0]}`);

  // A second rect added ABOVE the adjustment layer must render unaffected (still pure white)
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 350, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  await page.waitForTimeout(50);
  const aboveAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(300, 100, 1, 1).data);
  });
  assert.deepEqual(aboveAlpha.slice(0, 3), [255, 255, 255]);   // untouched — it's above the adjustment layer
});

test('browser: setAdjustmentParams updates the effect live, and stacking two adjustment layers composes', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const adjId1 = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 80 }));
  await page.waitForTimeout(50);
  const oneAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);

  await page.evaluate((id) => window.__ed.setAdjustmentParams(id, { brightness: 50 }), adjId1);
  await page.waitForTimeout(50);
  const strongerAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(strongerAlpha < oneAdjAlpha, 'a lower brightness value should darken further');

  // stack a second adjustment layer on top — should darken further still (composes with the first)
  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);
  const twoAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(twoAdjAlpha < strongerAlpha, 'two stacked adjustment layers should darken more than one');
});

test('browser: an adjustment layer survives undo/redo and stays live after reordering', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  const adjId = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);

  const darkenedAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(darkenedAlpha < 255);

  await page.evaluate(() => window.__ed.undo());   // undoes addAdjustmentLayer
  await page.waitForTimeout(150);
  const afterUndoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterUndoAlpha, 255);   // adjustment layer gone, rect is full white again

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterRedoAlpha, darkenedAlpha);   // adjustment layer (and its params) restored exactly

  const params = await page.evaluate((id) => window.__ed.getAdjustmentParams(id), adjId);
  assert.equal(params.brightness, 50);
});

test('browser: addMask creates a blank mask that has no visual effect until painted', async () => {
  // A paint-role layer is the simplest maskable target to set up in this fixture (no image load).
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);

  const beforeAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
  assert.ok(beforeAlpha > 0);   // the brush stroke painted something opaque here

  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  const afterAddAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
  assert.equal(afterAddAlpha, beforeAlpha);   // a fresh mask is fully-visible: no change yet

  const hasMaskCanvas = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, paintId);
  assert.equal(hasMaskCanvas, true);
});

test('browser: painting black into a mask hides the layer under the brush, white reveals it again', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);

  // paint black (hide) over the middle of the stroke
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const hiddenAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
  assert.equal(hiddenAlpha, 0);   // fully masked out at the painted spot

  // paint white (reveal) back over the same spot
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#ffffff' }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const revealedAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
  assert.ok(revealedAlpha > 200);   // back to (near-)fully visible

  await page.evaluate(() => window.__ed.exitMaskEdit());
});

test('browser: setMaskEnabled(false) restores full visibility without discarding the painted mask', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const maskedAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(maskedAlpha, 0);

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, false), paintId);
  const disabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(disabledAlpha > 200);   // disabling shows the full layer again

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, true), paintId);
  const reenabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(reenabledAlpha, 0);   // re-enabling brings back the SAME painted mask, not a blank one
});

test('browser: removeMask restores full visibility and addMask/removeMask no-op on non-maskable layers', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectId = await page.evaluate(() => window.__ed.fc.getObjects()[0].id);
  await page.evaluate((id) => window.__ed.addMask(id), rectId);
  const rectHasMask = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, rectId);
  assert.equal(rectHasMask, false);   // a vector shape (role 'shape') is not maskable in v1

  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 360, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 330, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());
  await page.evaluate((id) => window.__ed.removeMask(id), paintId);
  const afterRemove = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return { hasMaskCanvas: !!o.maskCanvas, alpha: o._element.getContext('2d').getImageData(330, 100, 1, 1).data[3] };
  }, paintId);
  assert.equal(afterRemove.hasMaskCanvas, false);
  assert.ok(afterRemove.alpha > 200);   // removing the mask restores full visibility
});

test('browser: a painted mask survives undo/redo (Fabric filter fromObject round-trip)', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const beforeUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(beforeUndoAlpha, 0);

  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(150);   // restore()/loadFromJSON + the mask filter's own async fromObject
  const afterUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(afterUndoAlpha > 200);   // back to before the mask stroke (mask still present, just unpainted there)

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(afterRedoAlpha, 0);   // the painted-black mask stroke is back
});

test('browser: setTextProps edits a text layer and no-ops on a shape', async () => {
  await page.evaluate(() => window.__ed.setTool('type'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);
  await page.waitForTimeout(50);
  await page.keyboard.type('Hi');
  await page.evaluate(() => window.__ed.fc.getActiveObject().exitEditing());
  await page.evaluate(() => window.__ed.setTool('select'));
  await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(x => x.type === 'i-text'); window.__ed.fc.setActiveObject(o); });

  await page.evaluate(() => window.__ed.setTextProps({ fontFamily: 'Georgia, serif', fontSize: 60, fontWeight: 700, fontStyle: 'italic', textAlign: 'center', underline: true }));
  const props = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(props.fontFamily, 'Georgia, serif');
  assert.equal(props.fontSize, 60);
  assert.equal(props.fontWeight, 700);
  assert.equal(props.fontStyle, 'italic');
  assert.equal(props.textAlign, 'center');
  assert.equal(props.underline, true);

  // no-op on a non-text shape: getTextProps() returns null, setTextProps() does nothing
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 250, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectTextProps = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(rectTextProps, null);
});

/* ── cv vendoring: the OpenCV worker actually boots from the vendored asset, not a CDN ──── */
test('browser: the OpenCV worker boots from the vendored opencv.js (offline-safe)', async () => {
  const ready = await page.evaluate(async () => {
    const booted = await window.__ed.cv._boot();
    return { booted, url: window.__ed.cv._openCvUrl };
  });
  assert.equal(ready.booted, true);
  assert.ok(ready.url.includes('/packages/core/vendor/opencv/opencv.js'));
  assert.ok(ready.url.startsWith('http://'));   // resolved to an absolute URL, not left root-relative
});
