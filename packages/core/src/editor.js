/* Editor — the headless facade. One instance per artboard.

     const ed = new Editor({ fabric, canvasEl, width, height });
     ed.setTool('brush'); ed.setToolOptions({ size: 40, color: '#ff0000' });
     ed.undo(); ed.exportPNG(); ed.ai.register(new GeminiProvider());

   Everything a UI needs is events + methods — no DOM of its own, no framework, no globals.
   The React package and the vanilla demo are both thin shells over exactly this class. */

import { PaintEngine, PAINT_TOOLS } from './engine.js';
import { History } from './history.js';
import {
  startSelection, updateSelection, finalizeSelection, selectionToPath2D, selectionFillRule, wandSelect,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
} from './selection.js';
import { makeShape, resizeShapeTo, makeText, layerLabel, uid } from './shapes.js';
import { getCropHandle, dragCropRect, applyCrop } from './crop.js';
import { alignDelta, snapDelta } from './layout.js';
import { EXTRA, serialize, restore, exportImage, addImageLayer, artboardForImage, loadImageEl } from './io.js';
import { selectionClipObject, renderSelectedPixels } from './pixels.js';
import { recolorPixels, fxToFilterSpecs, FX_DEFAULTS } from './color.js';
import { AIRegistry } from './ai/registry.js';
import { CvEngine, prepImageData } from './cv/client.js';

export const SEL_TOOLS = ['marquee', 'marquee-ellipse', 'lasso', 'lasso-poly', 'lasso-mag', 'wand', 'objectselect', 'hoverselect'];
export const SHAPE_TOOLS = ['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'];
export const ALL_TOOLS = ['select', 'hand', ...PAINT_TOOLS, ...SEL_TOOLS, ...SHAPE_TOOLS, 'type', 'bucket', 'gradient', 'eyedropper', 'crop'];
const CLICK_LASSOS = ['lasso-poly', 'lasso-mag'];
const SEL_EPS = 0.0022;   // contour fidelity passed to the cv wand — smaller hugs the edge harder

export class Editor {
  constructor({ fabric, canvasEl, width = 1080, height = 1080, background = '#ffffff' } = {}) {
    if (!fabric) throw new Error('Pass fabric (v5) into the Editor — it is a peer dependency.');
    this.fabric = fabric;
    this.W = width; this.H = height;
    this._listeners = {};
    this.fc = new fabric.Canvas(canvasEl, {
      width, height, preserveObjectStacking: true, selection: true,
      backgroundColor: background, stopContextMenu: true, fireRightClick: true,
    });
    this.engine = new PaintEngine(fabric, this.fc, width, height);
    this.history = new History(60);
    this.ai = new AIRegistry();
    this.cv = new CvEngine();       // OpenCV worker RPC — boots lazily on first cv-backed call
    this.tool = 'select';
    this.toolOpts = { size: 30, opacity: 1, hardness: 0.7, color: '#d4ff45', color2: '#7c3aed', fill: '#d4ff45', tolerance: 32, fontSize: 48, aligned: true };
    this.selection = null;
    this.crop = null;               // {x,y,w,h} while the crop tool is live
    this._drag = null;
    this._snap = true;
    this._polyBuild = null;         // running lasso-poly/lasso-mag vertex list
    this._edgeMap = null;           // magnetic-lasso Sobel edge map, built lazily per artboard capture
    this._lastWandSeed = null;      // last object-select click, scene px — feeds selectSimilar()
    this._hoverSeq = 0;             // monotonic token so a stale async hover preview can't land late
    this._destroyed = false;        // set by destroy() — async continuations check this before touching this.fc
    this._bindPointer();
    this._bindModified();
    this.setSnapEnabled(true);
    this.commit('init');
  }

  /* ── events: 'change' (scene), 'tool', 'selection', 'history', 'crop', 'error' (a fire-and-forget
     async call — e.g. wandPick's add/subtract on empty space — failed with nothing else to signal it) ── */
  on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._listeners[ev] = (this._listeners[ev] || []).filter(f => f !== fn); }
  _emit(ev, data) { (this._listeners[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } }); }

  /* ── tools ────────────────────────────────────────────────────────────────────────────── */
  setTool(t) {
    if (!ALL_TOOLS.includes(t)) throw new Error('Unknown tool "' + t + '". Tools: ' + ALL_TOOLS.join(', '));
    const prev = this.tool;
    if (CLICK_LASSOS.includes(prev) && prev !== t) this._polyBuild = null;
    this.tool = t;
    const drawing = t !== 'select';
    this.fc.selection = !drawing;
    this.fc.defaultCursor = t === 'hand' ? 'grab' : drawing ? 'crosshair' : 'default';
    this.fc.getObjects().forEach(o => { o.selectable = !drawing && !o.locked; o.evented = !drawing && !o.locked; });
    if (t === 'crop') this.crop = { x: this.W * 0.1, y: this.H * 0.1, w: this.W * 0.8, h: this.H * 0.8 };
    else this.crop = null;
    if (t === 'lasso-mag' && !this._edgeMap) this.buildMagneticEdgeMap();
    if ((t === 'objectselect' || t === 'hoverselect') && !this._hoverCache) this._hoverCache = new HoverCache(400);
    if (drawing) this.fc.discardActiveObject();
    this.fc.renderAll();
    this._emit('tool', t);
    this._emit('crop', this.crop);
  }

  setToolOptions(patch) { this.toolOpts = { ...this.toolOpts, ...patch }; this._emit('tooloptions', this.toolOpts); }

  /* ── pointer plumbing (scene coordinates come from fabric's own transform) ─────────────── */
  _pt(opt) { return this.fc.getPointer(opt.e); }

  _bindPointer() {
    const fc = this.fc;
    fc.on('mouse:down', (opt) => this._down(opt));
    fc.on('mouse:move', (opt) => this._move(opt));
    fc.on('mouse:up', () => this._up());
    // wheel zoom around the cursor
    fc.on('mouse:wheel', (opt) => {
      const delta = opt.e.deltaY;
      let z = fc.getZoom() * Math.pow(0.999, delta);
      z = Math.min(5, Math.max(0.1, z));
      fc.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, z);
      opt.e.preventDefault(); opt.e.stopPropagation();
      this._emit('zoom', z);
    });
  }

  _applySelClip() {
    this.engine.setClip(selectionToPath2D(this.selection, this.W, this.H), selectionFillRule(this.selection));
  }

  _down(opt) {
    const t = this.tool, pt = this._pt(opt), e = opt.e || {};
    const o = { ...this.toolOpts, alt: e.altKey, shift: e.shiftKey };
    if (t === 'hand' || e.spaceKey) { this._drag = { kind: 'pan', x: e.clientX, y: e.clientY }; return; }
    if (PAINT_TOOLS.includes(t)) {
      this._applySelClip();
      const r = this.engine.down(t, pt, o);
      this._drag = { kind: 'paint' };
      if (r === 'src-set') this._emit('clonesource', pt);
      return;
    }
    if (t === 'marquee' || t === 'marquee-ellipse' || t === 'lasso') {
      this.selection = startSelection(t, pt);
      this._drag = { kind: 'sel' };
      return;
    }
    if (CLICK_LASSOS.includes(t)) {
      const p = t === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      if (!this._polyBuild) this._polyBuild = startPolyBuild();
      const next = polyBuildAdd(this._polyBuild, p);
      if (next.closed) { this.finishPolyLasso(); return; }
      this._polyBuild = next;
      this.selection = { kind: 'poly', pts: next.pts.slice(), building: true };
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return;
    }
    if (t === 'wand') {
      this.wandPick(pt, { add: e.shiftKey, subtract: e.altKey });
      return;
    }
    if (t === 'objectselect' || t === 'hoverselect') {
      const cached = this._hoverCache && this._hoverCache.get(this._hoverCellKey(pt));
      if (cached) this._commitPoly(cached, { add: e.shiftKey, subtract: e.altKey });
      else this.wandPick(pt, { add: e.shiftKey, subtract: e.altKey });
      return;
    }
    if (SHAPE_TOOLS.includes(t)) {
      const obj = makeShape(this.fabric, t, pt, this.toolOpts);
      if (obj) {
        this.fc.add(obj); this.fc.setActiveObject(obj);
        this._drag = { kind: 'shape', tool: t, obj, from: pt };
      }
      return;
    }
    if (t === 'type') {
      const txt = makeText(this.fabric, pt, this.toolOpts);
      this.fc.add(txt); this.fc.setActiveObject(txt); txt.enterEditing && txt.enterEditing();
      this.commit('text');
      return;
    }
    if (t === 'bucket') {
      this._applySelClip();
      this.engine.fill(this.toolOpts.color);
      this.commit('bucket');
      return;
    }
    if (t === 'gradient') { this._drag = { kind: 'gradient', from: pt }; return; }
    if (t === 'eyedropper') {
      const hex = this.engine.sample(pt);
      if (hex) { this.setToolOptions({ color: hex }); this._emit('eyedropper', hex); }
      return;
    }
    if (t === 'crop' && this.crop) {
      const handle = getCropHandle(this.crop, pt, this.fc.getZoom());
      if (handle) this._drag = { kind: 'crop', handle, last: pt };
      return;
    }
  }

  _move(opt) {
    const pt = this._pt(opt), e = opt.e || {};
    if (CLICK_LASSOS.includes(this.tool) && this._polyBuild) {
      const p = this.tool === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      this.selection = polyBuildPreview(this._polyBuild, p);
      this.fc.renderAll();
      return;
    }
    if (this.tool === 'hoverselect' || this.tool === 'objectselect') { this._hoverMove(pt); return; }
    const d = this._drag;
    if (!d) return;
    if (d.kind === 'pan') {
      const vpt = this.fc.viewportTransform;
      vpt[4] += e.clientX - d.x; vpt[5] += e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      this.fc.requestRenderAll();
      return;
    }
    if (d.kind === 'paint') { this.engine.move(this.tool, pt, { ...this.toolOpts }); return; }
    if (d.kind === 'sel') { updateSelection(this.selection, pt, { square: e.shiftKey }); this.fc.renderAll(); this._emit('selection', this.selection); return; }
    if (d.kind === 'shape') { resizeShapeTo(d.obj, d.tool, d.from, pt); this.fc.renderAll(); return; }
    if (d.kind === 'crop') {
      this.crop = dragCropRect(this.crop, d.handle, pt.x - d.last.x, pt.y - d.last.y, this.toolOpts.cropRatio || 0);
      d.last = pt;
      this._emit('crop', this.crop);
      this.fc.renderAll();
      return;
    }
  }

  _up() {
    const d = this._drag; this._drag = null;
    if (!d) return;
    if (d.kind === 'paint') { this.engine.up(); this.engine.setClip(null); this.commit('stroke'); }
    if (d.kind === 'sel') { this.selection = finalizeSelection(this.selection); this._emit('selection', this.selection); }
    if (d.kind === 'gradient' && this.engine._curPt !== null) { /* released without move: ignore */ }
    if (d.kind === 'shape') { this.commit('shape'); this.setTool('select'); this.fc.setActiveObject(d.obj); }
  }

  /* Gradient is click-drag-release across two points. */
  dragGradient(from, to) {
    this._applySelClip();
    this.engine.paintGradient(from.x, from.y, to.x, to.y, this.toolOpts.color, this.toolOpts.color2);
    this.engine.setClip(null);
    this.commit('gradient');
  }

  clearSelection() { this.selection = null; this._polyBuild = null; this._emit('selection', null); this.fc.renderAll(); }
  invertSelection() {
    if (!this.selection) { this.selection = { kind: 'rect', x: 0, y: 0, w: this.W, h: this.H }; }
    else this.selection.invert = !this.selection.invert;
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }

  /* ── polygon / magnetic lasso: click-to-place vertices, Enter/Escape to finish ──────────── */
  finishPolyLasso() {
    const sel = finishPolyBuild(this._polyBuild, false);
    this._polyBuild = null;
    this.selection = sel;
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }
  cancelPolyLasso() {
    this._polyBuild = null;
    this.selection = null;
    this._emit('selection', null);
    this.fc.renderAll();
  }

  /* Magnetic lasso needs an edge map of the flattened scene before it can snap — build it once
     when the tool is picked (or lazily on first use) rather than per mouse-move. */
  async buildMagneticEdgeMap() {
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) { this._edgeMap = null; return; }
    try {
      const data = prepImageData(flat, 700);
      this._edgeMap = buildEdgeMapFromImageData(data, this.W, this.H);
    } catch (e) { this._edgeMap = null; }
  }

  /* ── magic wand / object select: cv-backed hybrid flood+grabCut, falling back to plain flood ──
     `add`/`subtract` implement shift-click-add / alt-click-subtract composition; when the cv
     worker is ready they run a true polygon union/subtract, otherwise they fall back to the
     always-available accumulate-into-multipoly (add) or are reported unavailable (subtract, which
     has no meaningful non-boolean fallback). */
  async wandPick(pt, { add = false, subtract = false } = {}) {
    this._lastWandSeed = pt;
    this.engine.captureFlat();
    const flat = this.engine._flat;
    let poly = null;
    if (flat && this.cv && typeof Worker !== 'undefined') {
      try {
        const imgd = prepImageData(flat, 768);
        const kx = imgd.width / this.W, ky = imgd.height / this.H;
        const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(pt.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(pt.y * ky))) };
        const pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance, SEL_EPS);
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        if (pts && pts.length >= 3) poly = pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
      } catch (e) { poly = null; }
    }
    if (!poly && flat) {
      const sel = wandSelect(flat, pt, this.toolOpts.tolerance);
      poly = sel ? (sel.pts || selectionPolys(sel)[0]) : null;
    }
    if (!poly) {
      const result = { status: 'error', reason: 'no_match' };
      if (!add && !subtract) { this.selection = null; this._emit('selection', null); this.fc.renderAll(); }
      /* add/subtract on empty space is otherwise a silent no-op: nothing changes, no event fires,
         and _down() doesn't await this call — so a host UI has no way to know the click did
         nothing unless it listens for this. */
      else this._emit('error', result);
      return result;
    }
    if (subtract) return this.subtractFromSelection(poly);
    if (add) return this.addToSelection(poly);
    this.selection = { kind: 'poly', pts: poly };
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  _commitPoly(poly, { add, subtract } = {}) {
    if (subtract) return this.subtractFromSelection(poly);
    if (add) return this.addToSelection(poly);
    this.selection = { kind: 'poly', pts: poly };
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  /* Shift-click add: true union via the cv worker when it's ready (clean merged outline),
     otherwise the always-available multipoly accumulate. */
  async addToSelection(poly) {
    const cur = selectionPolys(this.selection);
    if (cur && cur.length) {
      try {
        const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
        const S = pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }));
        const merged = await this.cv.union(Math.round(this.W * sc), Math.round(this.H * sc), cur.concat([poly]).map(S));
        if (this._destroyed) return { status: 'error', reason: 'destroyed' };
        if (merged && merged.length) {
          this.selection = polysToSelection(merged.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc }))));
          this._emit('selection', this.selection);
          this.fc.renderAll();
          return { status: 'ok' };
        }
      } catch (e) { /* fall through to the plain accumulate */ }
    }
    this.selection = addPolyToSelection(this.selection, poly);
    this._emit('selection', this.selection);
    this.fc.renderAll();
    return { status: 'ok' };
  }

  /* Alt-click subtract: punches `poly` out of the current selection via the cv worker's boolean
     subtract. No cv, no meaningful subtract — reported unavailable rather than guessing. */
  async subtractFromSelection(poly) {
    const base = selectionPolys(this.selection);
    if (!base) return { status: 'error', reason: 'no_selection' };
    try {
      const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
      const S = pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }));
      const res = await this.cv.subtract(Math.round(this.W * sc), Math.round(this.H * sc), base.map(S), [S(poly)]);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (res == null) return { status: 'error', reason: 'cv_unavailable' };
      this.selection = polysToSelection(res.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc }))));
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Select → Modify → Expand/Contract: grow (px>0) or shrink (px<0) the selection outline.
     cv-only — there's no accurate plain-JS polygon offset, so this reports unavailable rather
     than faking it with a bounding-box nudge. */
  async expandSelection(px) { return this._morphSelection(Math.abs(px)); }
  async contractSelection(px) { return this._morphSelection(-Math.abs(px)); }
  async _morphSelection(delta) {
    const polys = selectionPolys(this.selection);
    if (!polys) return { status: 'error', reason: 'no_selection' };
    try {
      const sc = Math.min(1, 1600 / Math.max(this.W, this.H));
      const res = await this.cv.morph(Math.round(this.W * sc), Math.round(this.H * sc),
        polys.map(pl => pl.map(p => ({ x: p.x * sc, y: p.y * sc }))), Math.max(1, Math.abs(delta) * sc) * Math.sign(delta));
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (res == null) return { status: 'error', reason: 'cv_unavailable' };
      this.selection = polysToSelection(res.map(pl => pl.map(p => ({ x: p.x / sc, y: p.y / sc }))));
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Select → Similar: every region in the whole image matching the last wand/object-select
     seed's colour, within the current tolerance. cv-only. */
  async selectSimilar() {
    if (!this._lastWandSeed) return { status: 'error', reason: 'no_seed' };
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return { status: 'error', reason: 'no_image' };
    try {
      const imgd = prepImageData(flat, 768);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(this._lastWandSeed.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(this._lastWandSeed.y * ky))) };
      const polys = await this.cv.similar({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance);
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (polys == null) return { status: 'error', reason: 'cv_unavailable' };
      if (!polys.length) return { status: 'error', reason: 'no_match' };
      this.selection = polysToSelection(polys.map(pl => pl.map(p => ({ x: p.x / kx, y: p.y / ky }))));
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return { status: 'ok' };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* ── hover-preview object select: debounced, cancellable, grid-cell cached ───────────────
     Shows, on hover, the polygon that a click WOULD select — same hybrid wand the click uses —
     so the user can confirm before committing. Single-flight: a fast-moving cursor replaces the
     pending point instead of queueing worker jobs. Cached by a coarse cell keyed on zoom and the
     current tolerance, so moving within one object is instant and changing tolerance can't serve
     a stale mask. */
  _hoverCellKey(pt) {
    const z = this.fc.getZoom() || 1;
    const cell = Math.max(3, 12 / z);
    return Math.round(pt.x / cell) + '_' + Math.round(pt.y / cell) + '_t' + this.toolOpts.tolerance;
  }
  _hoverMove(pt) {
    if (!this._hoverCache) this._hoverCache = new HoverCache(400);
    const key = this._hoverCellKey(pt);
    const cached = this._hoverCache.get(key);
    if (cached) { this._emit('hover', { pt, pts: cached }); return; }
    this._hoverPt = pt;
    if (this._hoverBusy) { this._hoverPending = pt; return; }
    this._runHover(pt);
  }
  async _runHover(pt) {
    this._hoverBusy = true;
    const seq = ++this._hoverSeq;
    try {
      this.engine.captureFlat();
      const flat = this.engine._flat;
      if (flat) {
        const imgd = prepImageData(flat, 520);
        const kx = imgd.width / this.W, ky = imgd.height / this.H;
        const seed = { cx: Math.max(1, Math.min(imgd.width - 2, Math.round(pt.x * kx))), cy: Math.max(1, Math.min(imgd.height - 2, Math.round(pt.y * ky))) };
        const pts = await this.cv.wand({ data: imgd.data, width: imgd.width, height: imgd.height }, seed, this.toolOpts.tolerance, SEL_EPS);
        if (this._destroyed) return;   // editor torn down mid-RPC — drop the result, don't recurse
        if (pts && pts.length >= 3 && seq === this._hoverSeq) {
          const scene = pts.map(p => ({ x: p.x / kx, y: p.y / ky }));
          this._hoverCache.put(this._hoverCellKey(pt), scene);
          if (this._hoverPt && this._hoverCellKey(this._hoverPt) === this._hoverCellKey(pt)) this._emit('hover', { pt, pts: scene });
        }
      }
    } catch (e) { /* no preview for this spot */ }
    this._hoverBusy = false;
    const next = this._hoverPending; this._hoverPending = null;
    if (next && !this._destroyed) this._runHover(next);
  }

  /* ── history ──────────────────────────────────────────────────────────────────────────── */
  _bindModified() {
    this.fc.on('object:modified', () => this.commit('transform'));
    this.fc.on('text:changed', () => this._soon());
  }
  _soon() { clearTimeout(this._st); this._st = setTimeout(() => this.commit('text-edit'), 350); }

  commit(label) {
    if (this.history.push(serialize(this.fc))) {
      this._emit('history', this.history.depth());
      this._emit('change', { label });
    }
  }
  undo() {
    const s = this.history.undo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: () => { this._emit('history', this.history.depth()); this._emit('change', { label: 'undo' }); } });
  }
  redo() {
    const s = this.history.redo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: () => { this._emit('history', this.history.depth()); this._emit('change', { label: 'redo' }); } });
  }

  /* ── layers ───────────────────────────────────────────────────────────────────────────── */
  layers() {
    return this.fc.getObjects().map((o, i) => ({
      id: o.id || (o.id = uid()), index: i, name: layerLabel(o), role: o.role || 'shape',
      visible: o.visible !== false, locked: !!o.locked, opacity: o.opacity != null ? o.opacity : 1,
      blend: o.globalCompositeOperation || 'source-over',
      active: this.fc.getActiveObject() === o,
    })).reverse();   // panel order: topmost first
  }
  _byId(id) { return this.fc.getObjects().find(o => o.id === id); }
  setLayer(id, patch) {
    const o = this._byId(id); if (!o) return;
    if ('visible' in patch) o.visible = patch.visible;
    if ('opacity' in patch) o.opacity = patch.opacity;
    if ('locked' in patch) { o.locked = patch.locked; o.selectable = !patch.locked; o.evented = !patch.locked; }
    if ('blend' in patch) o.globalCompositeOperation = patch.blend;
    if ('name' in patch) { o.name = patch.name; o.renamed = true; }
    this.fc.renderAll(); this.commit('layer');
  }
  moveLayer(id, dir) {
    const o = this._byId(id); if (!o) return;
    if (dir === 'up') this.fc.bringForward(o); else if (dir === 'down') this.fc.sendBackwards(o);
    else if (dir === 'top') this.fc.bringToFront(o); else if (dir === 'bottom') this.fc.sendToBack(o);
    this.fc.renderAll(); this.commit('reorder');
  }
  removeLayer(id) { const o = this._byId(id); if (o) { this.fc.remove(o); this.commit('remove'); } }
  activate(id) {
    const o = this._byId(id);
    if (o) {
      if (this.tool !== 'select') this.setTool('select');
      this.fc.setActiveObject(o);
      this.fc.renderAll();
      this._emit('change', { label: 'activate' });
    }
  }

  duplicateLayer(id, offset = 12) {
    const o = this._byId(id); if (!o) return;
    return new Promise(resolve => {
      o.clone(clone => {
        clone.set({ id: uid(), name: (o.renamed ? o.name : layerLabel(o)) + ' copy', renamed: true,
          left: (clone.left || 0) + offset, top: (clone.top || 0) + offset });
        this.fc.add(clone);
        this.fc.setActiveObject(clone);
        this.commit('duplicate');
        resolve(clone.id);
      }, EXTRA);
    });
  }

  /* Aligns a layer to the artboard bounds. edge: 'left'|'center'|'right'|'top'|'middle'|'bottom'. */
  alignLayer(id, edge) {
    const o = this._byId(id); if (!o) return;
    o.setCoords();
    const b = o.getBoundingRect(true);
    const { dx, dy } = alignDelta(b, this.W, this.H, edge);
    o.left = (o.left || 0) + dx;
    o.top = (o.top || 0) + dy;
    o.setCoords();
    this.fc.renderAll();
    this.commit('align');
  }

  /* Aligns the current selection: a single layer aligns to the artboard (alignLayer above); two or
     more (a fabric activeSelection) align to each other's combined bounds instead, Figma-style —
     each member moves independently to line up on the shared edge/axis, the group shape unchanged. */
  alignActiveSelection(edge) {
    const a = this.fc.getActiveObject();
    if (!a) return;
    if (a.type !== 'activeSelection') { if (a.id) this.alignLayer(a.id, edge); return; }
    const members = a.getObjects();
    if (!members.length) return;
    a.setCoords();
    /* A fabric ActiveSelection positions its members relative to its own center, not the canvas —
       member.left/top and member.getBoundingRect(true) already live in that shifted space. Adding
       half the selection's own size re-origins that space to the selection's top-left corner, which
       is what alignDelta expects (a box measured from a 0,0 reference). */
    const selW = a.width * (a.scaleX || 1), selH = a.height * (a.scaleY || 1);
    members.forEach(o => {
      o.setCoords();
      const b = o.getBoundingRect(true);
      const local = { left: b.left + selW / 2, top: b.top + selH / 2, width: b.width, height: b.height };
      const { dx, dy } = alignDelta(local, selW, selH, edge);
      o.left = (o.left || 0) + dx;
      o.top = (o.top || 0) + dy;
      o.setCoords();
    });
    a.setCoords();
    this.fc.renderAll();
    this.commit('align');
  }

  /* ── snap-while-dragging: object edges/centers snap to the artboard and to other layers ──── */
  setSnapEnabled(on) {
    this._snap = !!on;
    if (on && !this._snapBound) {
      this._snapBound = true;
      this.fc.on('object:moving', (opt) => this._snapMove(opt.target));
    }
  }
  _snapMove(o) {
    if (!this._snap) return;
    o.setCoords();
    const b = o.getBoundingRect(true);
    const others = this.fc.getObjects().filter(x => x !== o).map(x => x.getBoundingRect(true));
    const { dx, dy, snappedX, snappedY } = snapDelta(b, this.W, this.H, others);
    if (snappedX) o.left += dx;
    if (snappedY) o.top += dy;
    if (snappedX || snappedY) o.setCoords();
    this._emit('snap', { x: snappedX, y: snappedY });
  }

  /* Active layer, or null — the shared "what does a selection-pixel op act on" resolver. Prefers
     the active object; falls back to the topmost image/paint layer so a marquee drawn with nothing
     selected still has an obvious target (mirrors how the wand/marquee tools work without forcing
     a click on the layer first). */
  _pixelSourceLayer() {
    const a = this.fc.getActiveObject();
    if (a && a.type !== 'activeSelection') return a;
    const objs = this.fc.getObjects();
    for (let i = objs.length - 1; i >= 0; i--) { if (objs[i].type === 'image' || objs[i].role === 'paint') return objs[i]; }
    return null;
  }

  /* Cmd+J: copy the selected pixels of the active layer into a new layer, non-destructively
     (the source is untouched). Photoshop's "Layer via Copy". */
  duplicateSelectionToLayer() {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const img = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top', selectable: true, evented: true });
    img.set({ id: uid(), role: 'paint', name: (src.name || src.role || 'Layer') + ' copy' });
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('copy-selection');
    return img.id;
  }

  /* Turn a pixel selection into a real floating layer, Photoshop-style: lift renders the selected
     pixels into a tight new layer AND cuts them from the source (leaving a hole, like a real
     move); cut just clears the selected pixels from the active layer without creating anything
     (Backspace/Delete with an active selection). Both clear the selection afterward. */
  liftSelectionToLayer() {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const floatImg = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top', selectable: true, evented: true });
    floatImg.set({ id: uid(), role: 'paint', name: (src.name || src.role || 'Layer') + ' (moved)' });
    const clip = selectionClipObject(this.fabric, this.selection);
    if (clip) { clip.absolutePositioned = true; clip.inverted = !this.selection.invert; src.clipPath = clip; src.dirty = true; }
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(floatImg);
    if (idx !== -1) { this.fc.remove(floatImg); this.fc.insertAt(floatImg, idx + 1, false); }
    this.clearSelection();
    this.fc.setActiveObject(floatImg);
    this.fc.renderAll();
    this.commit('lift-selection');
    return floatImg.id;
  }

  cutSelectionFromLayer() {
    const o = this.fc.getActiveObject();
    if (!o) return;
    if (!this.selection) { this.fc.remove(o); this.fc.discardActiveObject(); this.commit('remove'); return; }
    const clip = selectionClipObject(this.fabric, this.selection);
    if (clip) { clip.absolutePositioned = true; clip.inverted = !this.selection.invert; o.clipPath = clip; o.dirty = true; }
    this.fc.renderAll();
    this.commit('cut-selection');
  }

  /* Token-free recolour: copies the selected pixels to a new layer and swaps hue/saturation
     toward `hex` while KEEPING each pixel's lightness, so shadows/folds/texture survive. Non-
     destructive — deleting the new layer reverts it. */
  recolorSelection(hex) {
    const src = this._pixelSourceLayer();
    if (!src || !this.selection) return null;
    const r = renderSelectedPixels(this.fabric, src, this.selection, this.W, this.H);
    if (!r) return null;
    const ctx = r.canvas.getContext('2d');
    const idata = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height);
    recolorPixels(idata.data, hex);
    ctx.putImageData(idata, 0, 0);
    const img = new this.fabric.Image(r.canvas, { left: r.box.x, top: r.box.y, originX: 'left', originY: 'top' });
    img.set({ id: uid(), role: 'paint', name: 'Recolor' });
    const idx = this.fc.getObjects().indexOf(src);
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this.clearSelection();
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('recolor');
    return img.id;
  }

  /* Drop shadow on the active layer. patch: {color, blur, offsetX, offsetY}; clearing every
     field (all falsy) removes the shadow. */
  setShadow(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const cur = o.shadow ? { color: o.shadow.color, blur: o.shadow.blur, offsetX: o.shadow.offsetX, offsetY: o.shadow.offsetY } : { color: '#000000', blur: 0, offsetX: 0, offsetY: 0 };
    const s = { ...cur, ...patch };
    o.set('shadow', (s.blur || s.offsetX || s.offsetY) ? new this.fabric.Shadow(s) : null);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('shadow');
  }

  /* ── image adjustment: non-destructive brightness/contrast/saturation/blur ─────────────────
     Mirrors the reference editor's setFx: human values live on a custom `o.fx`, the real Fabric
     `filters` array is rebuilt from it every call via the pure fxToFilterSpecs() mapping, then
     applyFilters() bakes them into the image's cached render. No-op on anything but an image. */
  setImageFilters(patch) {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image') return;
    const fx = { ...FX_DEFAULTS, ...(o.fx || {}), ...patch };
    o.fx = fx;
    o.filters = fxToFilterSpecs(fx).map(({ type, params }) => new this.fabric.Image.filters[type](params));
    o.applyFilters();
    this.fc.renderAll();
    this.commit('filters');
  }
  getImageFilters() {
    const o = this.fc.getActiveObject();
    return { ...FX_DEFAULTS, ...((o && o.fx) || {}) };
  }

  /* ── group / ungroup active multi-selection ──────────────────────────────────────────────
     Status-reporting, same pattern as wandPick/expandSelection — this library reports what
     happened, a host UI decides how (if at all) to surface it. */
  groupSelection() {
    const a = this.fc.getActiveObject();
    if (!a || a.type !== 'activeSelection') return { status: 'error', reason: 'need_multi_selection' };
    const g = a.toGroup();
    g.set({ id: uid(), role: 'group', name: 'Group' });
    this.fc.requestRenderAll();
    this.commit('group');
    return { status: 'ok' };
  }
  ungroupSelection() {
    const a = this.fc.getActiveObject();
    if (!a || a.type !== 'group') return { status: 'error', reason: 'need_group' };
    a.toActiveSelection();
    this.fc.requestRenderAll();
    this.commit('ungroup');
    return { status: 'ok' };
  }

  /* ── flip / numeric transform on the active object ──────────────────────────────────────
     Centering-on-axis is already covered by alignLayer(id,'center'|'middle') — no separate
     centerLayer method here, callers should use that instead. */
  flipLayer(axis) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if (axis === 'x') o.set('flipX', !o.flipX); else if (axis === 'y') o.set('flipY', !o.flipY);
    o.setCoords();
    this.fc.renderAll();
    this.commit('flip');
  }
  /* patch keys: any of x, y, w, h, angle, skewX, skewY — mirrors the reference's setNumeric. */
  setNumeric(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if ('x' in patch) o.left = patch.x;
    if ('y' in patch) o.top = patch.y;
    if ('w' in patch && o.width) o.scaleX = Math.max(1, patch.w) / o.width;
    if ('h' in patch && o.height) o.scaleY = Math.max(1, patch.h) / o.height;
    if ('angle' in patch) o.angle = patch.angle;
    if ('skewX' in patch) o.skewX = patch.skewX;
    if ('skewY' in patch) o.skewY = patch.skewY;
    o.setCoords();
    this.fc.renderAll();
    this.commit('transform');
  }

  /* ── crop ─────────────────────────────────────────────────────────────────────────────── */
  applyCrop() {
    if (!this.crop) return;
    const dim = applyCrop(this.fc, this.crop, this.engine);
    this.W = dim.width; this.H = dim.height;
    this.fc.setDimensions(dim);
    this.crop = null;
    this.setTool('select');
    this.commit('crop');
    this._emit('resize', dim);
  }

  /* ── io ───────────────────────────────────────────────────────────────────────────────── */
  async openImage(src, { fitArtboard = true } = {}) {
    if (fitArtboard) {
      const dim = await artboardForImage(src);
      if (this._destroyed) return null;
      this.W = dim.width; this.H = dim.height;
      this.fc.setDimensions(dim);
      this.engine.W = dim.width; this.engine.H = dim.height;
      this._emit('resize', dim);
    }
    const img = await addImageLayer(this.fabric, this.fc, src, { W: this.W, H: this.H });
    if (this._destroyed) return img;
    this.commit('open');
    return img;
  }
  addImage(src, opts = {}) { return addImageLayer(this.fabric, this.fc, src, { W: this.W, H: this.H, ...opts }).then(i => { if (!this._destroyed) this.commit('image'); return i; }); }
  exportPNG(mult = 1) { return exportImage(this.fc, this.W, this.H, { format: 'png', multiplier: mult }); }
  exportJPEG(quality = 0.92) { return exportImage(this.fc, this.W, this.H, { format: 'jpeg', quality }); }
  /* Vector export via Fabric's own toSVG — returns an SVG string (wrap in a Blob to download). */
  exportSVG() {
    this.fc.discardActiveObject();
    this.fc.renderAll();
    return this.fc.toSVG({ width: this.W, height: this.H, viewBox: { x: 0, y: 0, width: this.W, height: this.H } });
  }
  toJSON() { return serialize(this.fc); }
  loadJSON(json) { restore(this.fc, json, { engine: this.engine, history: this.history, onDone: () => this.commit('load') }); }

  /* ── AI conveniences (thin sugar over the registry) ───────────────────────────────────── */
  async aiEdit(instruction) {
    const r = await this.ai.run('magicEdit', this.exportPNG(), instruction);
    if (r.status === 'ok') { await this.openImageResult(r.result); }
    return r;
  }
  async aiInsert(prompt) {
    const r = await this.ai.run('generateImage', prompt);
    if (r.status === 'ok') await this.addImage(r.result, { name: prompt.slice(0, 24) });
    return r;
  }
  async openImageResult(dataURL) {
    if (this._destroyed) return;
    /* An AI edit replaces the composition: keep history (undo returns to the original). */
    this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
    await this.addImage(dataURL, { name: 'AI edit', fit: 'cover' });
    if (this._destroyed) return;
    this.commit('ai');
  }

  /* AI background replacement: magicEdit the flattened artboard, optionally masked so any active
     selection's subject is protected (black = keep, white = the AI may repaint) — without a
     selection the instruction alone asks the model to keep the main subject. Swaps the result
     back in as a single new layer, same as aiEdit. */
  async aiBgSwap(instruction) {
    const flat = this.exportPNG();
    if (!this.selection) return this.ai.run('magicEdit', flat, instruction).then(async r => { if (r.status === 'ok') await this.openImageResult(r.result); return r; });
    /* Selection present but magicEdit's contract here is single-image-in/out — no separate mask
       channel — so fold the protected-subject framing into the instruction text; a host wanting
       true mask-based inpainting should call ai.run('magicEdit', ...) directly with its own
       provider extension. */
    const r = await this.ai.run('magicEdit', flat, instruction + ' Keep the selected subject pixel-identical; only change the background.');
    if (r.status === 'ok') await this.openImageResult(r.result);
    return r;
  }

  /* AI-generate-an-image-at-a-point: inserts centered at `pt`, or — with an active selection —
     fills the selection's bounds, clipped to its shape so it reads as "filled the selection". */
  async aiInsertAt(prompt, pt) {
    const r = await this.ai.run('generateImage', prompt);
    if (this._destroyed) return r;
    if (r.status !== 'ok') return r;
    if (this.selection) {
      const box = selectionBounds(this.selection, this.W, this.H);
      const clip = selectionClipObject(this.fabric, this.selection);
      await new Promise(resolve => {
        this.fabric.Image.fromURL(r.result, img => {
          if (this._destroyed) return resolve();
          const sc = Math.max(box.w / (img.width || 1), box.h / (img.height || 1));
          img.set({ originX: 'center', originY: 'center', left: box.x + box.w / 2, top: box.y + box.h / 2, scaleX: sc, scaleY: sc, id: uid(), role: 'image', name: 'AI fill: ' + prompt.slice(0, 20) });
          if (clip) { clip.absolutePositioned = true; img.clipPath = clip; }
          this.fc.add(img); this.fc.setActiveObject(img);
          resolve();
        }, { crossOrigin: 'anonymous' });
      });
      if (this._destroyed) return r;
      this.clearSelection();
      this.commit('ai-insert');
      return r;
    }
    await new Promise(resolve => {
      this.fabric.Image.fromURL(r.result, img => {
        if (this._destroyed) return resolve();
        const sc = Math.min(1, (this.W * 0.34) / (img.width || this.W));
        img.set({ left: pt ? pt.x : this.W / 2, top: pt ? pt.y : this.H / 2, originX: 'center', originY: 'center', scaleX: sc, scaleY: sc, id: uid(), role: 'image', name: 'AI: ' + prompt.slice(0, 24) });
        this.fc.add(img); this.fc.setActiveObject(img);
        resolve();
      }, { crossOrigin: 'anonymous' });
    });
    if (this._destroyed) return r;
    this.commit('ai-insert');
    return r;
  }

  /* Flatten -> AI detectRegions -> explode into real editable layers. The one net-new AI-consuming
     feature here: canvasmith otherwise has no "take a flat photo apart into layers" flow. Each
     region ({type, bbox:{x,y,width,height in %}, content?}) becomes either a text layer (type
     'text', using `content` as the string) or an image layer cropped from the source at that bbox.
     Replaces the current composition, same history contract as openImageResult. */
  async detectRegionsToLayers() {
    const flat = this.exportPNG();
    const r = await this.ai.run('detectRegions', flat);
    if (this._destroyed) return r;
    if (r.status !== 'ok') return r;
    const regions = Array.isArray(r.result) ? r.result : [];
    if (!regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions detected.' };
    const src = await loadImageEl(flat);
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
    const bg = await addImageLayer(this.fabric, this.fc, flat, { W: this.W, H: this.H, name: 'Background', role: 'bg', fit: 'cover' });
    if (this._destroyed) return { status: 'error', reason: 'destroyed' };
    bg.set({ selectable: false, evented: false, locked: true });
    for (const rg of regions) {
      const bbox = rg.bbox || {};
      const x = (bbox.x || 0) / 100 * this.W, y = (bbox.y || 0) / 100 * this.H;
      const w = (bbox.width || 0) / 100 * this.W, h = (bbox.height || 0) / 100 * this.H;
      if (w < 1 || h < 1) continue;
      if (rg.type === 'text') {
        const txt = makeText(this.fabric, { x, y }, { text: rg.content || 'Text', fontSize: Math.max(12, Math.round(h * 0.6)) });
        txt.set({ name: (rg.content || 'Text').slice(0, 24) });
        this.fc.add(txt);
      } else {
        const sx = src.naturalWidth / this.W, sy = src.naturalHeight / this.H;
        const cw = Math.max(1, Math.round(w * sx)), ch = Math.max(1, Math.round(h * sy));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(src, Math.round(x * sx), Math.round(y * sy), cw, ch, 0, 0, cw, ch);
        const img = new this.fabric.Image(c, { left: x, top: y, originX: 'left', originY: 'top' });
        img.set({ id: uid(), role: rg.type || 'image', name: (rg.type || 'Layer')[0].toUpperCase() + (rg.type || 'layer').slice(1) });
        this.fc.add(img);
      }
    }
    this.fc.discardActiveObject();
    this.fc.renderAll();
    this.commit('regions-to-layers');
    return { status: 'ok', result: regions.length };
  }

  destroy() { this._destroyed = true; this.fc.dispose(); this._listeners = {}; if (this.cv) this.cv.destroy(); }
}
