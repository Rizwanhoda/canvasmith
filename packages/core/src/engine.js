/* PaintEngine — the raster heart of the editor.
   A single offscreen canvas (artboard resolution) is wrapped as a Fabric image layer; every pixel
   tool draws onto it in scene coordinates, so zoom/pan come free from Fabric's viewport transform.

   Tools implemented here: brush, pencil, eraser, dodge, burn, sponge, red-eye, clone, heal,
   bucket-style fill, linear gradient, eyedropper sampling. Selections clip strokes via setClip().

   Headless: `fabric` is injected — nothing here reads globals. */

import { hexRgb, rgba, toHex, normalizeGradientStops } from './color.js';

export const PAINT_TOOLS = ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'redeye'];

/* Renders exactly `objects` (an arbitrary subset/order of the canvas's own objects — NOT
   necessarily fc.getObjects()) to a fresh artboard-resolution offscreen canvas, at scene scale
   (viewport transform reset to identity, cropped to 0,0,W,H) — the same "flatten to a plain
   canvas" primitive captureFlat() already used for the whole scene, generalized so
   Editor#_recomputeAdjustmentLayers can flatten just "everything below this adjustment layer's
   z-index" instead. Uses fc.renderCanvas(ctx, objects) directly (Fabric's own object-list-scoped
   render, which fc.toCanvasElement() itself calls internally with the full list) rather than
   toggling every other object's `visible` off and back on around a toCanvasElement() call — no
   risk of a re-entrant render or a stray event firing off half-hidden state. Doesn't touch fc's
   own live width/height/viewportTransform at all, so no save/restore dance is needed around it. */
export function renderObjectsFlat(fc, W, H, objects) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = W; canvasEl.height = H;
  const ctx = canvasEl.getContext('2d');
  const savedVpt = fc.viewportTransform;
  fc.viewportTransform = [1, 0, 0, 1, 0, 0];
  fc.calcViewportBoundaries();
  try { fc.renderCanvas(ctx, objects); }
  finally { fc.viewportTransform = savedVpt; fc.calcViewportBoundaries(); }
  return canvasEl;
}

/* Builds a real CanvasGradient from the shared {offset,color} stop shape — 'radial' treats
   (x1,y1) as the center and the distance to (x2,y2) as the radius (Canvas2D's own radial
   gradient convention: an inner radius of 0 at the center, growing out to that distance). */
export function buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type = 'linear') {
  const norm = normalizeGradientStops(stops);
  const g = type === 'radial'
    ? ctx.createRadialGradient(x1, y1, 0, x1, y1, Math.max(1, Math.hypot(x2 - x1, y2 - y1)))
    : ctx.createLinearGradient(x1, y1, x2, y2);
  norm.forEach(s => g.addColorStop(s.offset, s.color));
  return g;
}

export class PaintEngine {
  constructor(fabric, fc, W, H) {
    this.fabric = fabric; this.fc = fc; this.W = W; this.H = H;
    this.cv = document.createElement('canvas'); this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d');
    this.layer = null; this._clip = null; this._flat = null; this._src = null; this._off = null; this._last = null;
    this._lastStrokeEnd = null; this._curPt = null; this._newSourceSet = false;
  }

  /* The engine's Fabric layer, created on first use and re-created if the host deleted it. */
  ensure() {
    if (this.layer && this.fc.getObjects().includes(this.layer)) return this.layer;
    this.cv = document.createElement('canvas');
    this.cv.width = this.W;
    this.cv.height = this.H;
    this.ctx = this.cv.getContext('2d');
    const img = new this.fabric.Image(this.cv, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: true, evented: true });
    img.set({
      id: 'o' + Math.random().toString(36).slice(2, 7),
      role: 'paint',
      name: 'Paint ' + (this.fc.getObjects().filter(o => o.role === 'paint').length + 1),
    });
    this.layer = img; this.fc.add(img); return img;
  }

  commit() { if (this.layer) this.layer.dirty = true; this.fc.renderAll(); }

  /* Selection clipping: strokes land only inside `path2d` (evenodd supports inverted selections). */
  setClip(path2d, rule) { this._clip = path2d || null; this._clipRule = rule || 'nonzero'; }

  /* Flatten the whole scene at artboard resolution — clone/heal sample from this, and the
     eyedropper reads it, so both see COMPOSITED pixels, not just the paint layer. */
  captureFlat() {
    this._flat = renderObjectsFlat(this.fc, this.W, this.H, this.fc.getObjects());
  }

  _softStamp(x, y, o, color, comp, alphaMul) {
    const ctx = this.ctx, r = Math.max(1, o.size / 2);
    // Clamped shy of 1: Canvas2D's radial gradient degenerates to fully transparent everywhere
    // when the inner/outer radii are exactly equal, so a hardness-1 (fully hard) brush would
    // otherwise paint nothing instead of a crisp hard edge. See mask.js's maskStamp for the same fix.
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);
    ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
    ctx.globalCompositeOperation = comp || 'source-over';
    ctx.globalAlpha = (o.opacity != null ? o.opacity : 1) * (alphaMul || 1);
    const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
    g.addColorStop(0, rgba(color, 1)); g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.restore();
  }

  _hardStamp(x, y, o, color) {
    const ctx = this.ctx, r = Math.max(0.5, o.size / 2);
    ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
    ctx.globalAlpha = o.opacity != null ? o.opacity : 1; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore();
  }

  /* Clone/heal: copy pixels from the flattened scene at a source offset; heal adds a blur pass so
     the patch melts into its surroundings. Soft edges come from a destination-in radial mask. */
  _cloneStamp(x, y, o, blur) {
    if (!this._flat || !this._off) return;
    const ctx = this.ctx, r = Math.max(1, o.size / 2);
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);   // see _softStamp's comment
    const tempCanvas = document.createElement('canvas');
    const size = Math.ceil(r * 2);
    tempCanvas.width = size;
    tempCanvas.height = size;
    const tempCtx = tempCanvas.getContext('2d');
    const sx = x - this._off.x - r;
    const sy = y - this._off.y - r;
    try { tempCtx.drawImage(this._flat, sx, sy, r * 2, r * 2, 0, 0, r * 2, r * 2); } catch (e) { /* out of bounds */ }
    tempCtx.globalCompositeOperation = 'destination-in';
    const g = tempCtx.createRadialGradient(r, r, r * hard, r, r, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tempCtx.fillStyle = g;
    tempCtx.beginPath();
    tempCtx.arc(r, r, r, 0, 2 * Math.PI);
    tempCtx.fill();
    ctx.save();
    if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
    ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
    if (blur) ctx.filter = 'blur(' + Math.max(2, r * 0.35) + 'px)';
    ctx.drawImage(tempCanvas, x - r, y - r);
    ctx.restore();
  }

  /* Red-eye: detect red-dominant pixels under the brush and pull them to the G/B average. */
  _redEyeCorrection(x, y, o) {
    const ctx = this.ctx;
    const r = Math.max(1, o.size / 2);
    const left = Math.max(0, Math.floor(x - r));
    const top = Math.max(0, Math.floor(y - r));
    const width = Math.min(this.W - left, Math.ceil(r * 2));
    const height = Math.min(this.H - top, Math.ceil(r * 2));
    if (width <= 0 || height <= 0) return;
    let imgData;
    try { imgData = ctx.getImageData(left, top, width, height); } catch (e) { return; }
    const data = imgData.data;
    const brushOpacity = o.opacity != null ? o.opacity : 1;
    let changed = false;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = (py * width + px) << 2;
        const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2], aVal = data[idx + 3];
        if (aVal > 0) {
          const dx = (left + px) - x, dy = (top + py) - y;
          const dist = Math.hypot(dx, dy);
          if (dist <= r && rVal > 80 && rVal > gVal * 1.3 && rVal > bVal * 1.3) {
            const falloff = 1 - (dist / r);
            const factor = Math.max(0, Math.min(1, falloff)) * brushOpacity;
            const targetRed = (gVal + bVal) / 2;
            data[idx] = Math.round(rVal * (1 - factor) + targetRed * factor);
            data[idx + 1] = Math.round(gVal * (1 - 0.25 * factor));
            data[idx + 2] = Math.round(bVal * (1 - 0.25 * factor));
            changed = true;
          }
        }
      }
    }
    if (changed) {
      if (this._clip) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext('2d').putImageData(imgData, 0, 0);
        ctx.save();
        ctx.clip(this._clip, this._clipRule || 'nonzero');
        ctx.drawImage(tempCanvas, left, top);
        ctx.restore();
      } else {
        ctx.putImageData(imgData, left, top);
      }
    }
  }

  /* Interpolate dabs between points so fast strokes stay continuous. */
  _line(tool, from, to, o) {
    const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
    const step = Math.max(1, (o.size || 20) * 0.18);
    const n = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i <= n; i++) { const x = from.x + dx * (i / n), y = from.y + dy * (i / n); this._dab(tool, x, y, o); }
  }

  _dab(tool, x, y, o) {
    switch (tool) {
      case 'brush': this._softStamp(x, y, o, o.color, 'source-over'); break;
      case 'pencil': this._hardStamp(x, y, o, o.color); break;
      case 'eraser': this._softStamp(x, y, o, '#000000', 'destination-out'); break;
      case 'dodge': this._softStamp(x, y, o, '#ffffff', 'color-dodge', 0.25); break;
      case 'burn': this._softStamp(x, y, o, '#000000', 'color-burn', 0.25); break;
      case 'sponge': {
        const spongeColor = (o.spongeMode === 'saturate') ? '#ff0000' : '#808080';
        this._softStamp(x, y, o, spongeColor, 'saturation', 0.7);
        break;
      }
      case 'redeye': this._redEyeCorrection(x, y, o); break;
      case 'clone': this._cloneStamp(x, y, o, false); break;
      case 'heal': this._cloneStamp(x, y, o, true); break;
      default: this._softStamp(x, y, o, o.color, 'source-over');
    }
  }

  /* Pointer protocol: down/move/up in scene coordinates.
     clone/heal: alt-click sets the source ('src-set' is returned so the UI can show it);
     shift-click joins strokes with a straight line, Photoshop-style. */
  down(tool, pt, o) {
    this.ensure();
    this._curPt = pt;
    if (tool === 'clone' || tool === 'heal') {
      if (o.alt || !this._src) {
        this._src = { x: pt.x, y: pt.y };
        this._newSourceSet = true;
        return 'src-set';
      }
      if (o.aligned === false) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
      } else if (!this._off || this._newSourceSet) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
        this._newSourceSet = false;
      }
      this.captureFlat();
    }
    if (o.shift && this._lastStrokeEnd && !['clone', 'heal'].includes(tool)) {
      this._line(tool, this._lastStrokeEnd, pt, o);
      this._last = pt;
      this._lastStrokeEnd = pt;
      this.commit();
      return true;
    }
    this._last = pt;
    this._lastStrokeEnd = pt;
    this._dab(tool, pt.x, pt.y, o);
    this.commit();
    return true;
  }

  move(tool, pt, o) {
    if (!this._last) return;
    this._curPt = pt;
    this._line(tool, this._last, pt, o);
    this._last = pt;
    this._lastStrokeEnd = pt;
    this.commit();
  }

  up() {
    this._last = null;
    this._curPt = null;
  }

  /* Fill the (clipped) artboard with a colour — the bucket tool over a selection.
     ensure() MUST run before drawing: it swaps in a fresh canvas when no paint layer exists, so
     drawing first meant the pixels landed on a canvas that was about to be thrown away. down()
     always had the right order; fill/gradient did not — caught by the demo screenshot session. */
  fill(color) {
    this.ensure();
    const ctx = this.ctx; ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.W, this.H); ctx.restore(); this.commit();
  }

  /* Fills the (clipped) paint layer with a gradient from (x1,y1) to (x2,y2) — Photoshop's
     Gradient tool. `stops` is [{offset: 0..1, color}, ...] (2+ stops; unsorted input is sorted by
     offset). `type` is 'linear' (the two points are the axis) or 'radial' (x1,y1 is the center,
     the distance to x2,y2 is the radius — Fabric/Canvas2D's radial gradient convention).
     Called on every mousemove while dragging for a live preview, and once more on mouseup to
     commit — repeated calls simply overwrite the same rect, so no extra bookkeeping is needed for
     "redo this preview frame" the way stroke-based tools require. */
  paintGradient(x1, y1, x2, y2, stops, type = 'linear') {
    this.ensure();
    const ctx = this.ctx; ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type);
    ctx.fillRect(0, 0, this.W, this.H); ctx.restore(); this.commit();
  }

  /* Eyedropper: composited colour at a point, as hex. */
  sample(pt) {
    this.captureFlat();
    try {
      const d = this._flat.getContext('2d').getImageData(Math.round(pt.x), Math.round(pt.y), 1, 1).data;
      return toHex(d[0], d[1], d[2]);
    } catch (e) { return null; }
  }

  /* After undo/redo reloads the scene from JSON, paint layers come back as <img> elements —
     re-wrap them as canvases so the engine can keep drawing on them. */
  adopt() {
    const paintLayers = this.fc.getObjects().filter(x => x.role === 'paint');
    paintLayers.forEach(o => {
      if (o && o._element && !(o._element instanceof HTMLCanvasElement)) {
        const cv = document.createElement('canvas');
        cv.width = this.W;
        cv.height = this.H;
        const ctx = cv.getContext('2d');
        try { ctx.drawImage(o._element, 0, 0, this.W, this.H); } catch (e) { console.error(e); }
        o._element = cv;
        o.dirty = true;
      }
    });
    // Layer masks: only the MaskFilter instance itself gets its maskCanvas rehydrated by Fabric's
    // own filter fromObject (see mask.js) — o.maskCanvas is this engine/editor's own bookkeeping
    // pointer to that same canvas (so addMask/removeMask/_refreshMaskFilter don't have to search
    // o.filters every time), and needs re-linking here after every restore.
    this.fc.getObjects().forEach(o => {
      const f = (o.filters || []).find(x => x.type === 'MaskFilter');
      o.maskCanvas = f ? f.maskCanvas : null;
    });
    let activePaint = this.fc.getActiveObject();
    if (!activePaint || activePaint.role !== 'paint') activePaint = paintLayers[0];
    if (activePaint) {
      this.layer = activePaint;
      this.cv = activePaint._element;
      this.ctx = activePaint._element.getContext('2d');
    } else {
      // undo removed every paint layer: drop the orphaned canvas too, or the next fill/gradient
      // would draw into pixels that no fabric layer displays
      this.layer = null;
      this.cv = document.createElement('canvas');
      this.cv.width = this.W; this.cv.height = this.H;
      this.ctx = this.cv.getContext('2d');
    }
  }
}
