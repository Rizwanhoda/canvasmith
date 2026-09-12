/* Editor — the headless facade. One instance per artboard.

     const ed = new Editor({ fabric, canvasEl, width, height });
     ed.setTool('brush'); ed.setToolOptions({ size: 40, color: '#ff0000' });
     ed.undo(); ed.exportPNG(); ed.ai.register(new GeminiProvider());

   Everything a UI needs is events + methods — no DOM of its own, no framework, no globals.
   The React package and the vanilla demo are both thin shells over exactly this class. */

import { PaintEngine, PAINT_TOOLS, renderObjectsFlat } from './engine.js';
import { History } from './history.js';
import {
  startSelection, updateSelection, finalizeSelection, selectionToPath2D, selectionFillRule, wandSelect,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
  getSelectionHandle, dragSelectionRect,
} from './selection.js';
import { makeShape, resizeShapeTo, makeText, layerLabel, uid } from './shapes.js';
import { getCropHandle, dragCropRect, applyCrop } from './crop.js';
import { alignDelta, snapDelta } from './layout.js';
import { EXTRA, serialize, restore, exportImage, addImageLayer, artboardForImage, loadImageEl } from './io.js';
import { selectionClipObject, renderSelectedPixels } from './pixels.js';
import { recolorPixels, fxToFilterSpecs, FX_DEFAULTS, normalizeGradientStops, splitGradientStopColor } from './color.js';
import { AIRegistry } from './ai/registry.js';
import { CvEngine, prepImageData } from './cv/client.js';
import { makeMaskFilterClass, createMaskCanvas, maskStamp, maskLine, serializeMask, deserializeMask, invertMaskCanvas } from './mask.js';
import { stickerSpec, STICKER_PALETTE } from './stickers.js';
import { makeCTA, makeBadge, makePrice, makeBrandLockup } from './adtext.js';
import { buildPromoLayout, buildLayerFromSpec } from './templates.js';

export const SEL_TOOLS = ['marquee', 'marquee-ellipse', 'lasso', 'lasso-poly', 'lasso-mag', 'wand', 'objectselect-bbox', 'magicwand', 'objectselect', 'hoverselect'];
export const SHAPE_TOOLS = ['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'];
export const ALL_TOOLS = ['select', 'hand', ...PAINT_TOOLS, ...SEL_TOOLS, ...SHAPE_TOOLS, 'type', 'bucket', 'gradient', 'eyedropper', 'crop', 'pen', 'aiinsert'];
const CLICK_LASSOS = ['lasso-poly', 'lasso-mag'];

/* AI region-detection vocabulary (detectRegions/commitRegions) — the type strings a provider's
   detectRegions() returns, mapped to the LAYER ROLE a committed region becomes ('text' regions
   read as headline copy, 'sticker' regions as a decorative shape; product/logo/decorative already
   match their own final role so they pass through) and, for a host UI drawing region-review
   overlays (draft boxes during a guided convert step), a distinct accent color per type so a user
   can tell region types apart at a glance before committing them. */
export const REGION_ROLE = { product: 'product', logo: 'logo', text: 'headline', sticker: 'decorative', decorative: 'decorative' };
export const REGION_COLOR = { product: '#d4ff45', logo: '#7cc4ff', text: '#ffd166', sticker: '#ff8fab', decorative: '#b794f6' };
const SEL_EPS = 0.0022;   // contour fidelity passed to the cv wand — smaller hugs the edge harder

export class Editor {
  constructor({ fabric, canvasEl, width = 1080, height = 1080, background = '#ffffff', openCvUrl } = {}) {
    if (!fabric) throw new Error('Pass fabric (v5) into the Editor — it is a peer dependency.');
    this.fabric = fabric;
    // MaskFilter (see mask.js) only implements Fabric's Canvas2D filter path (applyTo2d), not a
    // WebGL shader — Fabric defaults to WebGL filtering whenever the browser supports it, which
    // would silently no-op a mask (and any other future custom filter) with no error. Forcing
    // Canvas2D keeps every filter (including the built-in brightness/contrast/saturation/blur,
    // which have real GLSL shaders and would otherwise run on the GPU) on one predictable,
    // correctness-first path — images here are already capped to 1600px on import, so the perf
    // cost of Canvas2D over WebGL is small in practice.
    fabric.enableGLFiltering = false;
    this.W = width; this.H = height;
    this._listeners = {};
    this.fc = new fabric.Canvas(canvasEl, {
      width, height, preserveObjectStacking: true, selection: true,
      backgroundColor: background, stopContextMenu: true, fireRightClick: true,
      // Figma-style marquee: a thin solid border over a barely-there fill, instead of Fabric's
      // default heavy blue wash — kept independent of the app's lime accent, since a selection
      // indicator needs to read clearly over content of any colour.
      selectionColor: 'rgba(13,153,255,0.08)',
      selectionBorderColor: '#0d99ff',
      selectionLineWidth: 1,
      // Fabric's own default binds Shift+drag on a side handle (ml/mr/mt/mb) to skew — the
      // classic Illustrator/Photoshop convention puts skew on Alt/Option instead, freeing Shift
      // for the proportional-resize behaviour _bindProportionalSideScale implements below.
      altActionKey: 'altKey',
    });
    // Themed selection handles: circular accent-colored corners instead of Fabric's stock plain
    // white squares + light-blue border — applied per-object on 'object:added' rather than
    // mutating the shared fabric.Object.prototype globally, so multiple Editor instances on one
    // page (or other Fabric usage outside this library) never fight over one theme. `accent`
    // defaults to the toolOpts fill color set below (this.toolOpts isn't assigned yet at this
    // point in the constructor, so the literal is duplicated here rather than referenced).
    const handleAccent = '#ef6a2d';
    this.fc.on('object:added', (opt) => {
      if (opt.target) opt.target.set({
        transparentCorners: false, cornerColor: handleAccent, cornerStrokeColor: '#0c0c0e',
        borderColor: handleAccent, cornerSize: 11, cornerStyle: 'circle', borderScaleFactor: 1.5, padding: 2,
      });
    });
    this.engine = new PaintEngine(fabric, this.fc, width, height);
    // Registers fabric.Image.filters.MaskFilter (see mask.js) — must happen before any scene
    // JSON containing a mask filter is ever restored (undo/redo, loadJSON), since Fabric's own
    // enlivenObjects() resolves a filter's class by its serialized `type` string against exactly
    // that registry.
    makeMaskFilterClass(fabric);
    this.history = new History(60);
    this.ai = new AIRegistry();
    // OpenCV worker RPC — boots lazily on first cv-backed call. openCvUrl overrides
    // DEFAULT_OPENCV_URL (a root-relative path — see cv/worker.js) for hosts that serve the
    // vendored opencv.js from somewhere else, or want to point at a CDN mirror instead.
    this.cv = new CvEngine(openCvUrl ? { openCvUrl } : undefined);
    this.tool = 'select';
    this.toolOpts = {
      size: 30, opacity: 1, hardness: 0.7, color: '#ef6a2d', fill: '#ef6a2d', tolerance: 32, fontSize: 48, aligned: true,
      gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }],
      addMode: false,   // sticky "keep adding every click to the selection" toggle for wand/objectselect/hoverselect
    };
    this.selection = null;
    this.crop = null;               // {x,y,w,h} while the crop tool is live
    this._drag = null;
    this._snap = true;
    this._polyBuild = null;         // running lasso-poly/lasso-mag vertex list
    this._edgeMap = null;           // magnetic-lasso Sobel edge map, built lazily per artboard capture
    this._lastWandSeed = null;      // last object-select click, scene px — feeds selectSimilar()
    this._hoverSeq = 0;             // monotonic token so a stale async hover preview can't land late
    this._wandSeq = 0;              // monotonic token so an out-of-order wandPick RPC can't land late
    this._edgeMapSeq = 0;           // monotonic token so an in-flight buildMagneticEdgeMap can't land after a resize/crop
    this._destroyed = false;        // set by destroy() — async continuations check this before touching this.fc
    this._maskEdit = null;           // {layerId} while a mask is being painted — see enterMaskEdit()
    this._maskDrag = null;
    this._lastActiveId = null;      // last non-bg object the user selected/moved — see selectActiveOrCenter()
    this._spaceDown = false;        // true while the spacebar is held — see _bindSpacePan()
    this._bindPointer();
    this._bindModified();
    this._bindLastActive();
    this._bindSpacePan();
    this._bindProportionalSideScale();
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
    // Switching away from Pen mid-path must tell listeners the in-progress path is gone too —
    // _down/_move emit 'pen' on every point placed, so a host overlay (see the demo's `penBuild`)
    // that only updates from that event would otherwise keep drawing the abandoned path forever.
    if (prev === 'pen' && t !== 'pen' && this._penBuild) { this._penBuild = null; this._emit('pen', null); }
    // Switching TO the Select/Move tool with a live pixel selection lifts it into a movable layer
    // first — Select is move-only (drawing a marquee is what the marquee/lasso/wand tools are for),
    // so without this a selection made with any other tool would be stranded: nothing to drag it
    // with. Runs before the rest of this method's own state changes so liftSelectionToLayer sees
    // the pre-switch tool/selection and leaves its own setActiveObject as the final word.
    if (t === 'select' && prev !== 'select' && this.selection) this.liftSelectionToLayer();
    this.tool = t;
    const drawing = t !== 'select';
    this.fc.selection = !drawing;
    this.fc.defaultCursor = t === 'hand' ? 'grab' : t === 'type' ? 'text' : drawing ? 'crosshair' : 'default';
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
    if (this._maskEdit && (t === 'brush' || t === 'pencil' || t === 'eraser')) {
      const layer = this._byId(this._maskEdit.layerId);
      if (layer && layer.maskCanvas) {
        maskStamp(layer.maskCanvas.getContext('2d'), pt.x, pt.y, o, t === 'eraser');
        this._refreshMaskFilter(layer);
        this._maskDrag = pt;
        this.fc.requestRenderAll();
      }
      return;
    }
    if (t === 'hand' || this._spaceDown) {
      this._drag = { kind: 'pan', x: e.clientX, y: e.clientY };
      this.fc.setCursor('grabbing');
      return;
    }
    if (t === 'select' && e.altKey) {
      const target = this.fc.findTarget(e);
      if (target && target.selectable && !target.locked) {
        // Left behind at the drag's start position once the drag actually completes — see
        // object:modified below. We don't clone up front: Fabric has already latched its own
        // transform onto `target` by the time this handler runs, so the object visibly dragged
        // is always the original; the copy is inserted where it started, once movement is real.
        this._altDup = { id: target.id, left: target.left, top: target.top };
      }
    }
    if (PAINT_TOOLS.includes(t)) {
      this._applySelClip();
      const r = this.engine.down(t, pt, o);
      this._drag = { kind: 'paint' };
      if (r === 'src-set') this._emit('clonesource', pt);
      return;
    }
    if (t === 'marquee' || t === 'marquee-ellipse' || t === 'lasso') {
      // A rect/ellipse marquee's own selection is grabbable, crop-style: clicking one of its 8
      // handles (or its interior) resizes/moves it instead of starting a brand-new selection —
      // otherwise every click-drag on top of an existing marquee would just replace it, and the
      // only way to nudge a selection's edge would be to redraw the whole thing from scratch.
      if (t !== 'lasso' && this.selection && (this.selection.kind === 'rect' || this.selection.kind === 'ellipse')) {
        const handle = getSelectionHandle(this.selection, pt, this.fc.getZoom());
        if (handle) { this._drag = { kind: 'resize-sel', handle, last: pt }; return; }
      }
      this.selection = startSelection(t, pt);
      this._drag = { kind: 'sel' };
      return;
    }
    if (CLICK_LASSOS.includes(t)) {
      const p = t === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      if (!this._polyBuild) this._polyBuild = startPolyBuild();
      // closeDist (how near the first vertex a click must land to close the loop) is scene px, so
      // without dividing by zoom it's a fixed on-CANVAS distance that becomes a tiny, easy-to-miss
      // target on screen once zoomed out (or an oversized hair-trigger zone once zoomed in) — same
      // zoom-independence bug getCropHandle/getSelectionHandle's own `12 / z` tolerance avoids.
      const next = polyBuildAdd(this._polyBuild, p, 12 / (this.fc.getZoom() || 1));
      this._polyBuild = next;
      if (next.closed) { this.finishPolyLasso(); return; }
      this.selection = { kind: 'poly', pts: next.pts.slice(), building: true };
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return;
    }
    if (t === 'wand') {
      this.wandPick(pt, { add: e.shiftKey || this.toolOpts.addMode, subtract: e.altKey });
      return;
    }
    if (t === 'objectselect-bbox') {
      this.selectActiveOrCenter();
      return;
    }
    if (t === 'aiinsert') {
      // Clicking INSIDE an active selection opens region mode: the AI result fills exactly that
      // shape (see aiInsertAt). Otherwise it's a plain insert-at-point. No drag/up handling — the
      // host UI owns the prompt popover and calls aiInsertAt() itself once the user submits.
      const box = this.selection ? selectionBounds(this.selection, this.W, this.H) : null;
      const region = !!(box && pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h);
      this._emit('aiinsert', { pt, region });
      return;
    }
    if (t === 'objectselect' || t === 'hoverselect' || t === 'magicwand') {
      const add = e.shiftKey || this.toolOpts.addMode;
      // magicwand has no hover-preview cache (only objectselect/hoverselect populate one in
      // setTool) — this.wandPick's own CV hybrid flood+GrabCut is the click-to-grab behavior
      // either way, cache or not, so magicwand naturally falls through to the same call.
      const cached = this._hoverCache && this._hoverCache.get(this._hoverCellKey(pt));
      if (cached) this._commitPoly(cached, { add, subtract: e.altKey });
      else this.wandPick(pt, { add, subtract: e.altKey });
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
      this.fc.add(txt); this.fc.setActiveObject(txt);
      if (txt.enterEditing) {
        txt.enterEditing();
        txt.selectAll();   // placeholder text starts selected, so typing replaces it immediately
      }
      this.commit('text');
      // Back to select: like every other creation tool (see SHAPE_TOOLS' _up), so the next click
      // hits the canvas normally — Fabric's own double-click-to-edit, not "place another text".
      this.setTool('select');
      return;
    }
    if (t === 'bucket') {
      this._applySelClip();
      this.engine.fill(this.toolOpts.color);
      this.commit('bucket');
      return;
    }
    if (t === 'gradient') {
      // Dragging onto an active vector object with no pixel selection applies the gradient
      // directly as that object's own fill (scales/rotates with it, Fabric's native gradient)
      // instead of painting a raster stripe into the paint layer — same "object gradient" mode
      // the reference editor's own gradient tool has, just generalized to Canvasmith's multi-stop
      // gradientStops instead of a hardcoded 2-color pair. bg is excluded unless it's a plain
      // rect (a bg IMAGE shouldn't silently lose its pixels to a gradient fill), matching the
      // reference editor's own `o.role !== 'bg' || o.type === 'rect'` condition exactly.
      // Same _lastActiveId fallback as selectActiveOrCenter() (objectselect-bbox) — setTool()
      // already discarded Fabric's own active object by the time this click lands, since
      // 'gradient' is a drawing tool like any other.
      const active = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
      const objTarget = active && active.type !== 'activeSelection' && (active.role !== 'bg' || active.type === 'rect') && !this.selection ? active : null;
      if (objTarget) { this._drag = { kind: 'gradient-obj', from: pt, obj: objTarget }; return; }
      this._applySelClip(); this._drag = { kind: 'gradient', from: pt }; return;
    }
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
    if (t === 'pen') {
      if (!this._penBuild) this._penBuild = startPolyBuild();
      const next = polyBuildAdd(this._penBuild, pt, 12 / (this.fc.getZoom() || 1));
      this._penBuild = next;
      if (next.closed) { this.finishPen(); return; }
      this._emit('pen', { pts: next.pts.slice() });
      this.fc.renderAll();
      return;
    }
  }

  _move(opt) {
    const pt = this._pt(opt), e = opt.e || {};
    if (this._maskEdit && this._maskDrag && (this.tool === 'brush' || this.tool === 'pencil' || this.tool === 'eraser')) {
      const layer = this._byId(this._maskEdit.layerId);
      if (layer && layer.maskCanvas) {
        maskLine(layer.maskCanvas.getContext('2d'), this._maskDrag, pt, { ...this.toolOpts }, this.tool === 'eraser');
        this._refreshMaskFilter(layer);
        this.fc.requestRenderAll();
      }
      this._maskDrag = pt;
      return;
    }
    if (CLICK_LASSOS.includes(this.tool) && this._polyBuild) {
      const p = this.tool === 'lasso-mag' ? snapToEdge(this._edgeMap, pt) : pt;
      this.selection = polyBuildPreview(this._polyBuild, p);
      this.fc.renderAll();
      return;
    }
    if (this.tool === 'pen' && this._penBuild) {
      this._emit('pen', polyBuildPreview(this._penBuild, pt));
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
    if (d.kind === 'resize-sel') {
      this.selection = dragSelectionRect(this.selection, d.handle, pt.x - d.last.x, pt.y - d.last.y);
      d.last = pt;
      this._emit('selection', this.selection);
      this.fc.renderAll();
      return;
    }
    if (d.kind === 'shape') { resizeShapeTo(d.obj, d.tool, d.from, pt, { square: e.shiftKey }); this.fc.renderAll(); return; }
    if (d.kind === 'gradient') {
      this.engine.paintGradient(d.from.x, d.from.y, pt.x, pt.y, this.toolOpts.gradientStops, this.toolOpts.gradientType);
      return;
    }
    if (d.kind === 'gradient-obj') {
      this._applyObjectGradient(d.obj, d.from, pt);
      return;
    }
    if (d.kind === 'crop') {
      this.crop = dragCropRect(this.crop, d.handle, pt.x - d.last.x, pt.y - d.last.y, this.toolOpts.cropRatio || 0);
      d.last = pt;
      this._emit('crop', this.crop);
      this.fc.renderAll();
      return;
    }
  }

  _up() {
    if (this._maskEdit && this._maskDrag) { this._maskDrag = null; this._flushFrameJob('mask'); this.commit('mask-paint'); return; }
    const d = this._drag; this._drag = null;
    if (!d) return;
    if (d.kind === 'paint') { this.engine.up(); this.engine.setClip(null); this.commit('stroke'); }
    if (d.kind === 'sel' || d.kind === 'resize-sel') { this.selection = finalizeSelection(this.selection); this._emit('selection', this.selection); }
    if (d.kind === 'gradient') { this.engine.setClip(null); this.commit('gradient'); }
    if (d.kind === 'gradient-obj') { this.commit('gradient-fill'); }
    if (d.kind === 'shape') { this.commit('shape'); this.setTool('select'); this.fc.setActiveObject(d.obj); }
    if (d.kind === 'pan' && (this.tool === 'hand' || this._spaceDown)) this.fc.setCursor('grab');
  }

  clearSelection() { this.selection = null; this._polyBuild = null; this._emit('selection', null); this.fc.renderAll(); }
  /* Whole-artboard pixel selection (⌘A) — the same full-canvas rect invertSelection() falls back
     to when nothing is selected yet, but as its own explicit entry point rather than a side effect
     of inverting. */
  selectAll() {
    this.selection = { kind: 'rect', x: 0, y: 0, w: this.W, h: this.H };
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }
  invertSelection() {
    if (!this.selection) { this.selection = { kind: 'rect', x: 0, y: 0, w: this.W, h: this.H }; }
    else this.selection.invert = !this.selection.invert;
    this._emit('selection', this.selection);
    this.fc.renderAll();
  }

  /* The 'objectselect-bbox' tool (reference editor: "Object / magic select", key W) — a trivial,
     non-CV click: select the active object's own bounding box as a rect selection, or (nothing
     active) a fixed center region of the artboard. No pixel analysis at all — this is deliberately
     the lightweight sibling of `magicwand`/`objectselect`'s real CV-backed picking, matching the
     reference editor's own near-stub behavior for this exact tool/key.
     Reads getActiveObject() first, but falls back to _lastActiveId — setTool() has already
     discarded the live Fabric selection by the time any drawing-tool click reaches here (this
     tool is not 'select'), so getActiveObject() alone would see nothing on every click and always
     fall through to the center region. Mirrors the reference editor's own active()/lastUpdatedRef. */
  selectActiveOrCenter() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (o && o.type !== 'activeSelection') {
      o.setCoords();
      const b = o.getBoundingRect(true);
      this.selection = { kind: 'rect', x: b.left, y: b.top, w: b.width, h: b.height };
    } else {
      this.selection = { kind: 'rect', x: this.W * 0.18, y: this.H * 0.18, w: this.W * 0.64, h: this.H * 0.64 };
    }
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

  /* ── pen tool: click-to-place vertices into a real filled fabric.Polygon layer (not a
     selection) — Enter/double-click-near-start finishes, Escape cancels. Reuses the same
     poly-build accumulator as the polygonal lasso (startPolyBuild/polyBuildAdd), since "click to
     place points, snap-close near the start" is identical geometry either way. */
  finishPen() {
    const build = finishPolyBuild(this._penBuild, false);
    this._penBuild = null;
    this._emit('pen', null);
    if (!build) { this.fc.renderAll(); return null; }
    const pts = build.pts;
    const minX = Math.min(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y));
    const obj = new this.fabric.Polygon(pts.map(p => ({ x: p.x - minX, y: p.y - minY })), {
      left: minX, top: minY, originX: 'left', originY: 'top',
      fill: this.toolOpts.fill || this.toolOpts.color || '#ef6a2d',
      stroke: this.toolOpts.stroke || null, strokeWidth: this.toolOpts.strokeWidth || 0,
    });
    obj.set({ id: uid(), role: 'shape', name: 'Path' });
    this.fc.add(obj);
    this.fc.setActiveObject(obj);
    this.commit('pen');
    this.setTool('select');
    return obj.id;
  }
  cancelPen() {
    this._penBuild = null;
    this._emit('pen', null);
    this.fc.renderAll();
  }

  /* Magnetic lasso needs an edge map of the flattened scene before it can snap — build it once
     when the tool is picked (or lazily on first use) rather than per mouse-move. Guarded by a
     monotonic token (same pattern as _wandSeq/_hoverSeq): resizeCanvas()/applyCrop() bump it when
     they invalidate _edgeMap, so a build that was already in flight when the artboard changed
     size/origin can't land afterward and overwrite the (correct) null with stale pre-resize
     geometry. */
  async buildMagneticEdgeMap() {
    const seq = ++this._edgeMapSeq;
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) { if (seq === this._edgeMapSeq) this._edgeMap = null; return; }
    try {
      const data = prepImageData(flat, 700);
      const edgeMap = buildEdgeMapFromImageData(data, this.W, this.H);
      if (seq === this._edgeMapSeq) this._edgeMap = edgeMap;
    } catch (e) { if (seq === this._edgeMapSeq) this._edgeMap = null; }
  }

  /* ── magic wand / object select: cv-backed hybrid flood+grabCut, falling back to plain flood ──
     `add`/`subtract` implement shift-click-add / alt-click-subtract composition; when the cv
     worker is ready they run a true polygon union/subtract, otherwise they fall back to the
     always-available accumulate-into-multipoly (add) or are reported unavailable (subtract, which
     has no meaningful non-boolean fallback). */
  async wandPick(pt, { add = false, subtract = false } = {}) {
    this._lastWandSeed = pt;
    // Monotonic token guarding against out-of-order resolution: _down() fires this fire-and-forget
    // (never awaited), so a rapid double-click can have two wandPick calls in flight at once — if
    // the first click's cv RPC resolves AFTER the second click's, it must not clobber the second
    // click's (later, more current) selection. Mirrors _runHover's seq === this._hoverSeq guard.
    const seq = ++this._wandSeq;
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
    if (seq !== this._wandSeq) return { status: 'error', reason: 'superseded' };
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

  /* Auto-detect: Canny-edge object boxes (and, with {text:true}, a separate text-region pass)
     over the whole flattened scene — cv-only, coarser than the wand's precise contour (a
     rectangle per candidate, not a traced outline), meant for "here's what's in this image"
     at a glance rather than a one-click final selection. Returns scene-space boxes for a host UI
     to render as clickable candidates; selectDetectedBox() turns one into a real selection. */
  async detectObjects({ text = false } = {}) {
    this.engine.captureFlat();
    const flat = this.engine._flat;
    if (!flat) return { status: 'error', reason: 'no_image' };
    try {
      const imgd = prepImageData(flat, 900);
      const kx = imgd.width / this.W, ky = imgd.height / this.H;
      const r = await this.cv.detect({ data: imgd.data, width: imgd.width, height: imgd.height }, { text });
      if (this._destroyed) return { status: 'error', reason: 'destroyed' };
      if (r == null) return { status: 'error', reason: 'cv_unavailable' };
      const toScene = (b) => ({ x: b.x / kx, y: b.y / ky, w: b.w / kx, h: b.h / ky });
      const boxes = (r.boxes || []).map(toScene);
      const textBoxes = r.textBoxes ? r.textBoxes.map(toScene) : null;
      if (!boxes.length && !(textBoxes && textBoxes.length)) return { status: 'error', reason: 'no_match' };
      return { status: 'ok', result: { boxes, textBoxes } };
    } catch (e) { return { status: 'error', reason: 'cv_failed', message: String(e && e.message || e) }; }
  }

  /* Commits one detectObjects() box as a real rectangular pixel selection — the same selection
     marquee/lasso/wand all populate, so expand/contract/select-similar/recolor etc. all work on
     it unchanged. */
  selectDetectedBox(box) {
    const sel = startSelection('marquee', { x: box.x, y: box.y });
    updateSelection(sel, { x: box.x + box.w, y: box.y + box.h });
    this.selection = finalizeSelection(sel);
    this._emit('selection', this.selection);
    this.fc.renderAll();
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
    this.fc.on('object:modified', (opt) => this._onModified(opt));
    this.fc.on('text:changed', () => this._soon());
  }

  /* Tracks the last non-bg object the user selected or moved, independent of Fabric's own
     getActiveObject() — which setTool() discards the instant a drawing tool (anything but
     'select') is picked (see setTool's `if (drawing) this.fc.discardActiveObject()`), so by the
     time a drawing-tool click actually lands there is normally no active object left to read.
     Mirrors the reference editor's own lastUpdatedRef/active() fallback pattern; currently the
     sole consumer is selectActiveOrCenter() (the 'objectselect-bbox' tool). */
  _bindLastActive() {
    // selection:created/selection:updated carry the newly-active object(s) in `selected` (an
    // array), NOT `target` — object:modified is the opposite (`target`, no `selected`) — so this
    // needs both read shapes rather than one shared `opt.target` read.
    const trackSelected = (opt) => { const t = opt && opt.selected && opt.selected[0]; if (t && t.role !== 'bg' && t.id) this._lastActiveId = t.id; };
    const trackTarget = (opt) => { const t = opt && opt.target; if (t && t.role !== 'bg' && t.id) this._lastActiveId = t.id; };
    this.fc.on('selection:created', trackSelected);
    this.fc.on('selection:updated', trackSelected);
    this.fc.on('object:modified', trackTarget);
  }

  /* Spacebar-hold pan (Photoshop/Figma convention): held while any tool is active, drag-panning
     works the same as the Hand tool without switching away from — and back to — whatever tool was
     selected. Tracked as real keydown/keyup state on document (there is no such thing as a
     MouseEvent.spaceKey; _down's own `t === 'hand' || e.spaceKey` check further down is reading a
     property that literally does not exist on a mouse event, so this state is what actually makes
     that condition true). Skips the same isTypingTarget-style targets keybindings.js guards, so
     holding Space to type an actual space character in a text field or a layer-rename input never
     gets hijacked into a pan gesture. */
  _bindSpacePan() {
    if (typeof document === 'undefined') return;
    const isTyping = () => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      const active = this.fc.getActiveObject();
      return !!(active && active.isEditing);
    };
    this._onSpaceDown = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTyping()) return;
      if (!this._spaceDown) { this._spaceDown = true; if (this.tool !== 'hand') this.fc.defaultCursor = 'grab'; }
      e.preventDefault();
    };
    this._onSpaceUp = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      this._spaceDown = false;
      if (this.tool !== 'hand') this.fc.defaultCursor = this.tool === 'select' ? 'default' : 'crosshair';
    };
    document.addEventListener('keydown', this._onSpaceDown);
    document.addEventListener('keyup', this._onSpaceUp);
  }

  /* Option/Alt+drag duplicate: mirrors the delta the object actually moved onto a fresh clone
     left at the drag's start position, so the object under the cursor stays "the one you grabbed"
     while a copy is dropped where it began — the usual Figma/design-tool convention. Only fires
     for a genuine drag (not a resize/rotate) on the same single object that was armed in _down. */
  _onModified(opt) {
    const armed = this._altDup; this._altDup = null;
    const target = opt && opt.target;
    if (armed && target && target.id === armed.id && opt.transform && opt.transform.action === 'drag'
        && (target.left !== armed.left || target.top !== armed.top)) {
      target.clone(clone => {
        clone.set({ id: uid(), name: (target.renamed ? target.name : layerLabel(target)) + ' copy', renamed: true,
          left: armed.left, top: armed.top });
        this.fc.add(clone);
        this.fc.moveTo(clone, this.fc.getObjects().indexOf(target));
        this.fc.renderAll();
        this.commit('duplicate-drag');
      }, EXTRA);
      return;
    }
    this.commit('transform');
  }
  _soon() { clearTimeout(this._st); this._st = setTimeout(() => this.commit('text-edit'), 350); }

  commit(label) {
    this._recomputeAdjustmentLayers();
    if (this.history.push(serialize(this.fc))) {
      this._emit('history', this.history.depth());
      this._emit('change', { label });
    }
  }
  undo() {
    const s = this.history.undo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'undo' }); } });
  }
  redo() {
    const s = this.history.redo();
    if (s) restore(this.fc, s, { engine: this.engine, history: this.history, onDone: (w, h) => { this._afterRestore(w, h); this._recomputeAdjustmentLayers(); this.fc.renderAll(); this._emit('history', this.history.depth()); this._emit('change', { label: 'redo' }); } });
  }
  _afterRestore(w, h) {
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this._emit('resize', { width: w, height: h });
  }

  /* ── layers ───────────────────────────────────────────────────────────────────────────── */
  layers() {
    return this.fc.getObjects().map((o, i) => ({
      id: o.id || (o.id = uid()), index: i, name: layerLabel(o), role: o.role || 'shape',
      visible: o.visible !== false, locked: !!o.locked, opacity: o.opacity != null ? o.opacity : 1,
      blend: o.globalCompositeOperation || 'source-over',
      active: this.fc.getActiveObject() === o,
      maskable: this._maskable(o), hasMask: !!o.maskCanvas, maskEnabled: o.maskEnabled !== false,
      editingMask: !!this._maskEdit && this._maskEdit.layerId === o.id,
      isAdjustment: o.role === 'adjustment', adj: o.role === 'adjustment' ? { ...FX_DEFAULTS, ...o.adj } : null,
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
  /* Drag-to-reorder: move layer `id` to sit directly in front of (default) or behind layer
     `targetId` in stacking order — "in front of" is the natural drop semantic for a layers panel
     that lists topmost-first (fc.getObjects() index order is bottom-to-top, the OPPOSITE of the
     panel's display order, so "in front of target" means one PAST target's fc index, not before
     it). No-op if either id is missing or they're the same object. */
  reorderLayerTo(id, targetId, { after = false } = {}) {
    if (id === targetId) return;
    const o = this._byId(id), target = this._byId(targetId); if (!o || !target) return;
    const objs = this.fc.getObjects();
    let idx = objs.indexOf(target);
    if (idx < 0) return;
    if (!after) idx += 1;   // "in front of" target = just past it in fc's bottom-to-top order
    if (objs.indexOf(o) < idx) idx -= 1;   // account for o's own removal shifting later indices down
    this.fc.moveTo(o, Math.max(0, idx));
    this.fc.renderAll(); this.commit('reorder');
  }
  removeLayer(id) {
    const o = this._byId(id); if (!o) return;
    // Deleting the layer currently being mask-painted must drop the in-flight mask-edit state and
    // cancel (not flush) any pending rAF refresh — the refresh's target is about to be removed
    // from the canvas, so there's nothing left to apply it to (see removeMask's identical guard).
    if (this._maskEdit && this._maskEdit.layerId === id) { this._cancelFrameJob('mask'); this._maskEdit = null; this._maskDrag = null; this._emit('maskedit', null); }
    this.fc.remove(o);
    this.commit('remove');
  }
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

  /* Copy/paste — clipboard lives in memory on the Editor (not the OS clipboard), so it works the
     same across the vanilla demo and the React shell without a Clipboard API permission dance.
     copySelection() clones the active object/activeSelection now, so later edits to the source
     don't leak into what gets pasted. Each paste offsets a little further, so repeated Cmd/Ctrl+V
     fans copies out instead of stacking them exactly on top of each other. */
  copySelection() {
    const a = this.fc.getActiveObject();
    if (!a) return false;
    return new Promise(resolve => {
      a.clone(clone => { this._clipboard = clone; this._pasteCount = 0; resolve(true); }, EXTRA);
    });
  }

  pasteClipboard(offset = 12) {
    const src = this._clipboard;
    if (!src) return;
    this._pasteCount = (this._pasteCount || 0) + 1;
    const d = offset * this._pasteCount;
    return new Promise(resolve => {
      src.clone(clone => {
        this.fc.discardActiveObject();
        if (clone.type === 'activeSelection') {
          clone.canvas = this.fc;
          clone.forEachObject(o => {
            o.set({ id: uid(), name: (o.renamed ? o.name : layerLabel(o)) + ' copy', renamed: true,
              left: (o.left || 0) + d, top: (o.top || 0) + d });
            this.fc.add(o);
          });
          clone.setCoords();
          this.fc.setActiveObject(clone);
        } else {
          clone.set({ id: uid(), name: (clone.renamed ? clone.name : layerLabel(clone)) + ' copy', renamed: true,
            left: (clone.left || 0) + d, top: (clone.top || 0) + d });
          this.fc.add(clone);
          this.fc.setActiveObject(clone);
        }
        this.fc.renderAll();
        this.commit('paste');
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

  /* ── snap-while-dragging: object edges/centers snap to the artboard and to other layers, and
     emit "smart guide" lines (Figma's dragged-alignment indicators) for a host UI to draw ──── */
  setSnapEnabled(on) {
    this._snap = !!on;
    if (on && !this._snapBound) {
      this._snapBound = true;
      this.fc.on('object:moving', (opt) => { this._snapMove(opt.target); this._liveAdjustmentPreview(); });
      this.fc.on('object:scaling', () => this._liveAdjustmentPreview());
      this.fc.on('object:rotating', () => this._liveAdjustmentPreview());
      this.fc.on('object:modified', () => { this._flushFrameJob('adjustment'); this._emit('guides', null); });
      this.fc.on('mouse:up', () => this._emit('guides', null));
    }
  }
  _snapMove(o) {
    if (!this._snap) { this._emit('guides', null); return; }
    o.setCoords();
    const b = o.getBoundingRect(true);
    const others = this.fc.getObjects().filter(x => x !== o).map(x => x.getBoundingRect(true));
    const { dx, dy, snappedX, snappedY, guideX, guideY } = snapDelta(b, this.W, this.H, others);
    if (snappedX) o.left += dx;
    if (snappedY) o.top += dy;
    if (snappedX || snappedY) o.setCoords();
    this._emit('snap', { x: snappedX, y: snappedY });
    this._emit('guides', (guideX || guideY) ? { x: guideX, y: guideY } : null);
  }

  /* Adjustment layers only recompute their captured bitmap in commit() (mouseup) — without this,
     transforming (move/scale/rotate) a layer that sits below an adjustment layer shows a stale,
     un-adjusted preview of it mid-gesture that only snaps to the correct filtered composite once
     the gesture ends. Skipped entirely when there are no adjustment layers in the scene, so the
     common case (no adjustment layers at all) pays no extra per-frame cost while dragging.
     _recomputeAdjustmentLayers() is a full re-flatten + per-pixel filter pass per adjustment
     layer, too expensive to run on every raw pointermove/scaling tick (those can fire faster than
     the display refreshes) — coalesced to the shared per-animation-frame scheduler below, same
     pattern as _refreshMaskFilter's mask-paint throttling. */
  _liveAdjustmentPreview() {
    if (this.fc.getObjects().some(o => o.role === 'adjustment')) this._coalesceToFrame('adjustment');
  }

  /* Shared "run this at most once per animation frame" scheduler — later calls with the same key
     before the frame fires just replace which job runs, so a burst of raw pointer events during a
     drag/scale/rotate collapses to a single recompute per frame instead of one per event. `flush`
     runs the job synchronously right now (used at a gesture's end, so a commit()/serialize() right
     after never captures a scene whose last-tick recompute hasn't actually run yet). */
  _coalesceToFrame(key, job) {
    this._frameJobs = this._frameJobs || {};
    this._frameHandles = this._frameHandles || {};
    if (job) this._frameJobs[key] = job;
    if (this._frameHandles[key]) return;
    this._frameHandles[key] = requestAnimationFrame(() => { this._frameHandles[key] = null; this._flushFrameJob(key); });
  }
  _flushFrameJob(key) {
    if (this._frameHandles && this._frameHandles[key]) { cancelAnimationFrame(this._frameHandles[key]); this._frameHandles[key] = null; }
    const job = this._frameJobs && this._frameJobs[key]; if (this._frameJobs) this._frameJobs[key] = null;
    if (key === 'adjustment') { this._recomputeAdjustmentLayers(); this.fc.requestRenderAll(); }
    else if (key === 'mask') {
      const target = this._pendingMaskTarget; this._pendingMaskTarget = null;
      if (!target) return;
      const f = (target.filters || []).find(x => x.type === 'MaskFilter');
      if (f) { f.maskCanvas = target.maskEnabled !== false ? target.maskCanvas : null; target.applyFilters(); this.fc.requestRenderAll(); }
    }
    else if (typeof job === 'function') job();
  }
  /* Cancels a scheduled frame job without running it — used when the target it would have acted
     on is gone (layer deleted, editor destroyed) so the deferred work has nothing left to do. */
  _cancelFrameJob(key) {
    if (this._frameHandles && this._frameHandles[key]) { cancelAnimationFrame(this._frameHandles[key]); this._frameHandles[key] = null; }
    if (this._frameJobs) this._frameJobs[key] = null;
    if (key === 'mask') this._pendingMaskTarget = null;
  }

  /* Shift+drag a side handle (mr/ml/mt/mb — normally single-axis) keeps the object's aspect
     ratio, mirroring the corner handles' own uniform-scale-on-Shift behaviour. Fabric only wires
     that convention to the corners natively, so side handles need it applied by hand here: on
     every scaling tick, if a side handle is active and Shift is currently held, the axis that
     handle doesn't drive is recomputed from the one it does, using the ratio the object had when
     the drag started (not a hardcoded 1:1), so a non-square shape keeps its own proportions. */
  _bindProportionalSideScale() {
    this.fc.on('object:scaling', (opt) => {
      const corner = opt.transform && opt.transform.corner;
      const sideX = corner === 'ml' || corner === 'mr';   // drives scaleX only
      const sideY = corner === 'mt' || corner === 'mb';   // drives scaleY only
      if (!opt.e || !opt.e.shiftKey || (!sideX && !sideY)) return;
      const t = opt.transform.target;
      const orig = opt.transform.original;
      const ratio = (orig.scaleY || 1) / (orig.scaleX || 1);
      if (sideX) t.scaleY = t.scaleX * ratio;
      else t.scaleX = t.scaleY / ratio;
      t.setCoords();
    });
  }

  /* Active layer, or null — the shared "what does a selection-pixel op act on" resolver. Prefers
     the active object; falls back to the topmost image/paint layer so a marquee drawn with nothing
     selected still has an obvious target (mirrors how the wand/marquee tools work without forcing
     a click on the layer first). */
  _pixelSourceLayer() {
    const a = this.fc.getActiveObject();
    if (a && a.type !== 'activeSelection') return a;
    // No live Fabric active object — most commonly because a drawing tool (marquee/lasso/wand,
    // any non-'select' tool) already discarded it via setTool()'s own discardActiveObject() call,
    // exactly when a pixel-selection op like this is actually invoked. _lastActiveId (tracked
    // independently of Fabric's own selection state — see _bindLastActive) recovers "the layer
    // the user was last working on" the same way selectActiveOrCenter/the gradient tool's
    // object-local mode already do, rather than only ever falling back to the topmost image/paint
    // layer regardless of what the user actually had selected.
    const last = this._lastActiveId && this._byId(this._lastActiveId);
    if (last) return last;
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

  /* Same _lastActiveId fallback as _pixelSourceLayer/selectActiveOrCenter/the gradient tool's
     object-local mode: this is invoked from Delete/Backspace (see keybindings.js) while a
     marquee/lasso/wand drawing tool is active, at which point setTool() has already discarded
     Fabric's own active object even though the user very much still has a layer "active" in the
     sense that matters here. */
  cutSelectionFromLayer() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o) return;
    if (!this.selection) { this.fc.remove(o); this.fc.discardActiveObject(); this.commit('remove'); return; }
    const clip = selectionClipObject(this.fabric, this.selection);
    if (clip) { clip.absolutePositioned = true; clip.inverted = !this.selection.invert; o.clipPath = clip; o.dirty = true; }
    this.fc.renderAll();
    this.commit('cut-selection');
  }

  /* Non-destructive "crop to selection": hides the active layer's pixels OUTSIDE the current
     marquee/lasso/wand selection by setting a clipPath, same mechanism as cutSelectionFromLayer
     (its exact mirror — inverted there, not-inverted here) but without touching the layer's own
     pixel data, position, or size — clearLayerClip() (or drawing a new selection and re-clipping)
     fully reverses it. Unlike the Crop tool, this doesn't resize the artboard or re-origin every
     other layer; it only affects the one layer currently selected. */
  /* Same _lastActiveId fallback as cutSelectionFromLayer/_pixelSourceLayer/selectActiveOrCenter
     and the gradient tool's object-local mode: a pixel selection normally exists while a drawing
     tool (marquee/lasso/wand) is active, and setTool() has already discarded Fabric's own active
     object by the time a host UI's "Clip layer to selection" button gets clicked — without this
     fallback, that click would always hit the "nothing active" branch below and silently no-op. */
  clipLayerToSelection() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o || !this.selection) return;
    const clip = selectionClipObject(this.fabric, this.selection);
    if (!clip) return;
    clip.absolutePositioned = true; clip.inverted = !!this.selection.invert;
    o.clipPath = clip; o.dirty = true;
    this.fc.renderAll();
    this.commit('clip-to-selection');
  }

  /* Removes whatever clipPath is on the active layer — undoes clipLayerToSelection (or any other
     clip) without needing to remember what the clip shape was. Same _lastActiveId fallback as
     clipLayerToSelection above, for the same reason. */
  clearLayerClip() {
    const o = this.fc.getActiveObject() || (this._lastActiveId && this._byId(this._lastActiveId));
    if (!o || !o.clipPath) return;
    o.clipPath = null; o.dirty = true;
    this.fc.renderAll();
    this.commit('clear-clip');
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
     applyFilters() bakes them into the image's cached render. No-op on anything but an image.
     Preserves a mask filter (see addMask) at the front of the array if one is present — the two
     filter families are independent (fx patches shouldn't drop a mask, and mask edits shouldn't
     drop fx) but both ultimately live on the one `o.filters` array Fabric's applyFilters() reads. */
  setImageFilters(patch) {
    const o = this.fc.getActiveObject();
    if (!o || o.type !== 'image') return;
    const fx = { ...FX_DEFAULTS, ...(o.fx || {}), ...patch };
    o.fx = fx;
    const maskFilter = (o.filters || []).find(f => f.type === 'MaskFilter');
    o.filters = [
      ...(maskFilter ? [maskFilter] : []),
      ...fxToFilterSpecs(fx).map(({ type, params }) => new this.fabric.Image.filters[type](params)),
    ];
    o.applyFilters();
    this.fc.renderAll();
    this.commit('filters');
  }
  getImageFilters() {
    const o = this.fc.getActiveObject();
    return { ...FX_DEFAULTS, ...((o && o.fx) || {}) };
  }

  /* ── adjustment layers: non-destructive, affect everything BELOW them in the stack ────────
     Unlike setImageFilters (which bakes onto one image object's own pixels), an adjustment layer
     is a real, reorderable, deletable Fabric object of its own (role: 'adjustment') whose
     displayed bitmap is a captured-and-filtered composite of every layer below its z-index —
     recomputed via _recomputeAdjustmentLayers() on every commit(), so moving it, editing a layer
     below it, or adding a new layer underneath all keep it live without any special-casing at the
     call site. params is the same partial-fx shape setImageFilters takes (brightness/contrast/
     saturate/blur), so one adjustment layer can combine several effects like Photoshop's own
     "Brightness/Contrast" dialog, rather than needing a separate layer per effect. */
  addAdjustmentLayer(params = {}) {
    const img = new this.fabric.Image(document.createElement('canvas'), {
      left: 0, top: 0, originX: 'left', originY: 'top', selectable: true, evented: true,
    });
    img.set({ id: uid(), role: 'adjustment', name: 'Adjustments', adj: { ...FX_DEFAULTS, ...params } });
    const active = this.fc.getActiveObject();
    const idx = (active && active.type !== 'activeSelection') ? this.fc.getObjects().indexOf(active) : -1;
    this.fc.add(img);
    if (idx !== -1) { this.fc.remove(img); this.fc.insertAt(img, idx + 1, false); }
    this._recomputeAdjustmentLayers();
    this.fc.setActiveObject(img);
    this.fc.renderAll();
    this.commit('add-adjustment');
    return img.id;
  }
  /* Decorative sticker: a recolorable vector shape from the built-in library (stickers.js), added
     centered at `pt` (default: artboard center) at a fixed 160px nominal size — same size/role
     convention as makeShape(), so it behaves exactly like any other vector shape layer (Fill
     colour swatch recolors it, Transform resizes/rotates it, etc.) once placed. */
  addSticker(key, pt, size = 160) {
    const spec = stickerSpec(key); if (!spec) return null;
    const center = pt || { x: this.W / 2, y: this.H / 2 };
    const fill = STICKER_PALETTE[0];
    const common = { originX: 'center', originY: 'center', left: center.x, top: center.y, scaleX: size / 100, scaleY: size / 100 };
    let obj = null;
    if (spec.kind === 'circle') obj = new this.fabric.Circle({ ...common, radius: spec.r, fill });
    else if (spec.kind === 'rect') obj = new this.fabric.Rect({ ...common, width: spec.w, height: spec.h, rx: spec.rx, ry: spec.rx, fill });
    else if (spec.kind === 'polygon') obj = new this.fabric.Polygon(spec.points.split(' ').map(p => { const [x, y] = p.split(',').map(Number); return { x, y }; }), { ...common, fill });
    else if (spec.kind === 'path') obj = new this.fabric.Path(spec.d, { ...common, fill: spec.stroke ? null : fill, stroke: spec.stroke ? fill : null, strokeWidth: spec.stroke ? 10 : 0, fillRule: spec.fillRule || 'nonzero' });
    if (!obj) return null;
    obj.set({ id: uid(), role: 'shape', name: 'Sticker' });
    this.fc.add(obj);
    this.fc.setActiveObject(obj);
    this.commit('sticker');
    return obj.id;
  }

  /* ── ad-copy layers (adtext.js): CTA pill, badge chip, price group, brand lockup ───────────
     Same click-to-place/default-to-center convention as addSticker() above — `pt` defaults to the
     artboard center, `opts` is the same shape toolOpts already carries (size/fill/color) plus each
     factory's own fields (text/current/original/save/accent/font/ink). Each returns the new
     object's id, or null if the factory itself declined (none currently do, but this mirrors
     addSticker's own null-on-failure contract for a host that checks the return value). */
  addCTA(pt, opts = {}) { return this._addAdText(makeCTA, pt, opts, 'cta'); }
  addBadge(pt, opts = {}) { return this._addAdText(makeBadge, pt, opts, 'badge'); }
  addPrice(pt, opts = {}) { return this._addAdText(makePrice, pt, opts, 'price'); }
  addBrandLockup(pt, opts = {}) { return this._addAdText(makeBrandLockup, pt, opts, 'brand'); }
  _addAdText(factory, pt, opts, label) {
    const center = pt || { x: this.W / 2, y: this.H / 2 };
    const o = factory(this.fabric, center, { ...this.toolOpts, ...opts });
    if (!o) return null;
    this.fc.add(o);
    this.fc.setActiveObject(o);
    this.commit(label);
    return o.id;
  }

  /* Replaces the whole composition with a hero/sale/centered promotional layout (templates.js) —
     background + brand lockup + headline/subhead + CTA + optional badge + a product image or
     placeholder. Same "replace the composition, keep history" contract as openImageResult/
     commitRegions: undo returns to whatever was on the canvas before. `spec` is
     buildPromoLayout()'s own input shape (layout/palette/head/sub/cta/badge/brand/productImg/
     font/uiFont), every field optional. Loads spec.productImg (if given) once up front so every
     'image'-kind layer spec in the layout can synchronously build off the same decoded element. */
  async applyPromoLayout(spec = {}) {
    const layout = buildPromoLayout(spec, this.W, this.H);
    const imgEl = spec.productImg ? await loadImageEl(spec.productImg) : null;
    if (this._destroyed) return null;
    this.fc.getObjects().slice().forEach(o => this.fc.remove(o));
    layout.layers.forEach(ls => {
      const obj = buildLayerFromSpec(this.fabric, ls, ls.kind === 'image' ? imgEl : null);
      this.fc.add(obj);
    });
    this.fc.discardActiveObject();
    this.fc.renderAll();
    this.commit('promo-layout');
    return layout;
  }

  setAdjustmentParams(id, patch) {
    const o = this._byId(id); if (!o || o.role !== 'adjustment') return;
    o.adj = { ...FX_DEFAULTS, ...o.adj, ...patch };
    this._recomputeAdjustmentLayers();
    this.fc.renderAll();
    this.commit('adjustment');
  }
  getAdjustmentParams(id) {
    const o = this._byId(id);
    return (o && o.role === 'adjustment') ? { ...FX_DEFAULTS, ...o.adj } : null;
  }

  /* Rebuilds every adjustment layer's displayed bitmap from the layers currently below it,
     bottom-up (so a stack of adjustment layers composes: the second one sees the first one's
     effect already baked into what it captures). Called from commit() itself — mutates each
     adjustment layer's own image element directly rather than going through applyFilters()'s
     fx/filters bookkeeping (that pipeline is for a single image's OWN pixels; here the "source
     pixels" are a fresh capture of other objects entirely, so there's no persistent
     _originalElement to re-filter from — each recompute captures fresh below-layers pixels and
     filters those). Guarded re-entrantly: recomputing must never itself call commit() (that would
     recurse through here again) — it only mutates bitmaps and calls fc.renderAll(). */
  _recomputeAdjustmentLayers() {
    const objs = this.fc.getObjects();
    objs.forEach((o, i) => {
      if (o.role !== 'adjustment') return;
      const below = objs.slice(0, i);
      const flat = renderObjectsFlat(this.fc, this.W, this.H, below);
      const filters = fxToFilterSpecs(o.adj || FX_DEFAULTS).map(({ type, params }) => new this.fabric.Image.filters[type](params));
      const filtered = document.createElement('canvas');
      filtered.width = this.W; filtered.height = this.H;
      const fctx = filtered.getContext('2d');
      fctx.drawImage(flat, 0, 0);
      const nonNeutral = filters.filter(f => !f.isNeutralState());
      if (nonNeutral.length) {
        const imgd = fctx.getImageData(0, 0, this.W, this.H);
        nonNeutral.forEach(f => f.applyTo2d({ imageData: imgd }));
        fctx.putImageData(imgd, 0, 0);
      }
      // setElement (not a raw o._element assignment) — it also sets _originalElement, so a later
      // scale/resize-filter pass (applyResizeFilters, which reads _filteredEl || _originalElement)
      // can't silently revert the layer back to its blank construction-time canvas. o.filters is
      // deliberately left empty: the fx chain was already applied by hand above (against a fresh
      // per-recompute capture, not a persistent original this object owns), so letting Fabric's
      // own applyFilters() run too would double-apply it.
      o.setElement(filtered);
      o.dirty = true;
    });
  }

  /* ── layer masks: paintable, non-destructive, image/paint-role layers only (see mask.js's
     header comment for why vector shapes/text aren't supported) ───────────────────────────────
     addMask() creates a blank (fully-visible) mask and pushes a MaskFilter onto the layer's own
     `o.filters`, ahead of any brightness/contrast/etc. filters (see setImageFilters above) so a
     disabled/deleted mask never disturbs those. enterMaskEdit() redirects brush/pencil/eraser
     strokes (via _down/_move/_up) into painting the mask canvas instead of the pixel layer
     itself — exitMaskEdit() (or picking any other tool) ends that redirect. */
  _maskable(o) { return !!o && (o.type === 'image' || o.role === 'paint'); }
  addMask(id) {
    const o = this._byId(id); if (!this._maskable(o) || o.maskCanvas) return;
    o.maskCanvas = createMaskCanvas(this.W, this.H);
    o.maskEnabled = true;
    const MaskFilter = makeMaskFilterClass(this.fabric);
    o.filters = [new MaskFilter({ maskCanvas: o.maskCanvas }), ...(o.filters || [])];
    o.applyFilters();
    this.fc.renderAll();
    this.commit('add-mask');
  }
  removeMask(id) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    if (this._maskEdit && this._maskEdit.layerId === id) this.exitMaskEdit();
    o.maskCanvas = null; o.maskEnabled = false;
    o.filters = (o.filters || []).filter(f => f.type !== 'MaskFilter');
    o.applyFilters();
    this.fc.renderAll();
    this.commit('remove-mask');
  }
  /* Enabled/disabled toggle (Photoshop's shift-click-the-mask-thumbnail) — the mask canvas and
     paint strokes on it are kept either way, only its visual effect is switched on/off. */
  setMaskEnabled(id, enabled) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    o.maskEnabled = !!enabled;
    const f = (o.filters || []).find(x => x.type === 'MaskFilter');
    if (f) f.maskCanvas = enabled ? o.maskCanvas : null;
    o.applyFilters();
    this.fc.renderAll();
    this.commit('mask-enabled');
  }
  /* Cmd/Ctrl+I on a mask (Photoshop) — swaps hidden<->visible across the WHOLE mask in one step,
     the single most-reached-for mask edit after "paint it": flip a mask that hid the wrong region
     instead of repainting it by hand. A no-op re-paint of the enable/apply plumbing every other
     mask edit already goes through, so undo/redo and the enabled-toggle keep working unchanged. */
  invertMask(id) {
    const o = this._byId(id); if (!o || !o.maskCanvas) return;
    invertMaskCanvas(o.maskCanvas);
    o.applyFilters();
    this.fc.renderAll();
    this.commit('invert-mask');
  }
  enterMaskEdit(id) {
    const o = this._byId(id); if (!this._maskable(o) || !o.maskCanvas) return;
    this._maskEdit = { layerId: id };
    // Mask strokes only ever come from brush/pencil/eraser (see _down/_move) — auto-switching to
    // brush means a host UI's "Add mask" / "Edit mask" action can paint immediately, rather than
    // silently doing nothing until the caller separately remembers to also pick a paint tool.
    if (!['brush', 'pencil', 'eraser'].includes(this.tool)) this.setTool('brush');
    this._emit('maskedit', this._maskEdit);
  }
  /* Ending mask edit outside the normal mouseup path (a host UI switching layers mid-stroke, or
     picking another tool) must still flush any pending rAF-coalesced refresh — otherwise a stale
     callback fires a frame later against whatever state the editor has moved on to. */
  exitMaskEdit() {
    if (!this._maskEdit) return;
    this._flushFrameJob('mask');
    this._maskEdit = null;
    this._maskDrag = null;
    this._emit('maskedit', null);
  }
  /* applyFilters() re-runs the WHOLE filter chain from the pristine source (including MaskFilter's
     own full getImageData + per-pixel loop over the artboard) — expensive enough that calling it
     once per mousemove tick while painting a mask is visibly janky on a large artboard. mousemove
     can fire faster than the display refreshes, so coalesce to at most one actual refresh per
     animation frame via the shared _coalesceToFrame scheduler (same one _liveAdjustmentPreview
     uses) — later calls within the same frame just replace which layer's refresh will run. */
  _refreshMaskFilter(o) {
    this._pendingMaskTarget = o;
    this._coalesceToFrame('mask');
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
  /* patch keys: any of x, y, w, h, angle, skewX, skewY, rx — mirrors the reference's setNumeric.
     w/h are read off the same getScaledWidth()/getScaledHeight() the properties panel displays
     (readProps in @canvasmith/react), which factor in stroke width and skew — not just
     `width * scaleX` — so the new scale is derived from the CURRENT scaled size rather than
     assumed to be `patch.w / o.width`, which drifted for any object with a stroke or a nonzero
     skew (the field would resize by the wrong factor). rx sets a rect's corner radius uniformly
     (both rx and ry together — the properties panel exposes one "corner radius" field, not
     independent x/y radii); no-op on anything but a rect, same silent-no-op contract as
     setFill/setShapeGradient for a property that doesn't apply to the active object's type. */
  setNumeric(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if ('x' in patch) o.left = patch.x;
    if ('y' in patch) o.top = patch.y;
    if ('w' in patch) {
      const curW = o.getScaledWidth ? o.getScaledWidth() : o.width * (o.scaleX || 1);
      if (curW) o.scaleX = (o.scaleX || 1) * (Math.max(1, patch.w) / curW);
    }
    if ('h' in patch) {
      const curH = o.getScaledHeight ? o.getScaledHeight() : o.height * (o.scaleY || 1);
      if (curH) o.scaleY = (o.scaleY || 1) * (Math.max(1, patch.h) / curH);
    }
    if ('angle' in patch) o.angle = patch.angle;
    if ('skewX' in patch) o.skewX = patch.skewX;
    if ('skewY' in patch) o.skewY = patch.skewY;
    if ('rx' in patch && o.type === 'rect') {
      const r = Math.max(0, patch.rx);
      o.set({ rx: r, ry: r });
      o.dirty = true;
    }
    o.setCoords();
    this.fc.renderAll();
    this.commit('transform');
  }

  /* Recolors the active object (shape fill or text colour) — an activeSelection applies the same
     colour to every member, matching how alignActiveSelection/setLayer treat a multi-selection. */
  setFill(color) {
    const o = this.fc.getActiveObject(); if (!o) return;
    if (o.type === 'activeSelection') o.forEachObject(m => m.set('fill', color));
    else o.set('fill', color);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('fill');
  }

  /* Border/stroke — patch keys: color, width. Setting a width with no color yet defaults to black
     (mirrors the reference: picking up the width slider from 0 should show a visible border right
     away, not an invisible one). No-op with nothing selected, same silent-no-op contract as
     setFill/setNumeric for a property that may not apply to every member of a multi-selection —
     Fabric ignores stroke/strokeWidth on object types that don't render one (e.g. images). */
  setStroke(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (m) => {
      if ('width' in patch) { if (patch.width > 0 && !m.stroke) m.set('stroke', '#000000'); m.set('strokeWidth', Math.max(0, patch.width)); }
      if ('color' in patch) m.set('stroke', patch.color);
    };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('stroke-style');
  }

  /* Object-local gradient mode's shared apply step (called live on every drag tick from _move,
     and once more implicitly via the same drag state on _up) — maps the scene-space drag line
     (from, to) into `obj`'s own local coordinate space via toLocalPoint(...,'center','center')
     then divides by scale (fabric.Gradient's gradientUnits:'pixels' coords are unscaled
     object-space, so a scaled object needs the drag line un-scaled back into that space first,
     exactly like the reference editor's own applyCustomGradient). Always linear (a drag defines a
     two-point AXIS, which a radial gradient — center + radius, no axis — has no use for; radial
     object gradients go through setShapeGradient's angle-based mode instead). */
  _applyObjectGradient(obj, from, to) {
    const p1 = obj.toLocalPoint(new this.fabric.Point(from.x, from.y), 'center', 'center');
    const p2 = obj.toLocalPoint(new this.fabric.Point(to.x, to.y), 'center', 'center');
    const sx = obj.scaleX || 1, sy = obj.scaleY || 1;
    const norm = normalizeGradientStops(this.toolOpts.gradientStops);
    const colorStops = norm.map(s => ({ offset: s.offset, color: s.color }));
    obj.set('fill', new this.fabric.Gradient({
      type: 'linear', gradientUnits: 'pixels',
      coords: { x1: p1.x / sx, y1: p1.y / sy, x2: p2.x / sx, y2: p2.y / sy },
      colorStops,
    }));
    obj.dirty = true;
    this.fc.renderAll();
  }

  /* Gradient fill for a vector shape (rect/ellipse/triangle/polygon/star/text) — Fabric's own
     fabric.Gradient, so it scales/rotates with the object for free (coords are in the OBJECT's own
     bounding-box space, not scene space, per Fabric's convention: 0,0 is the object's top-left).
     `type`: 'linear' (angle in degrees, 0 = left-to-right) or 'radial' (centered, edge-to-edge).
     No-op on anything without a fill (images, lines, paint layers) — same contract as setFill. */
  setShapeGradient(stops, type = 'linear', angle = 0) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const apply = (obj) => {
      const w = obj.width || 1, h = obj.height || 1;
      const norm = normalizeGradientStops(stops);
      const colorStops = norm.map(s => ({ offset: s.offset, color: s.color }));
      let coords;
      if (type === 'radial') {
        coords = { x1: w / 2, y1: h / 2, r1: 0, x2: w / 2, y2: h / 2, r2: Math.max(w, h) / 2 };
      } else {
        const rad = (angle * Math.PI) / 180;
        const dx = Math.cos(rad) * w / 2, dy = Math.sin(rad) * h / 2;
        coords = { x1: w / 2 - dx, y1: h / 2 - dy, x2: w / 2 + dx, y2: h / 2 + dy };
      }
      obj.set('fill', new this.fabric.Gradient({ type, coords, colorStops }));
    };
    if (o.type === 'activeSelection') o.forEachObject(apply); else apply(o);
    o.dirty = true;
    this.fc.renderAll();
    this.commit('gradient-fill');
  }
  /* Null if the active object has no gradient fill (flat color, or non-fillable like an image). */
  getShapeGradient() {
    const o = this.fc.getActiveObject();
    const t = o && o.type === 'activeSelection' ? o.getObjects()[0] : o;
    const g = t && t.fill && typeof t.fill === 'object' && t.fill.type ? t.fill : null;
    if (!g) return null;
    return { type: g.type, stops: (g.colorStops || []).map(s => ({ offset: s.offset, ...splitGradientStopColor(s.color) })) };
  }

  /* Typography — patch keys: any of fontFamily, fontSize, fontWeight, fontStyle ('normal'|'italic'),
     textAlign ('left'|'center'|'right'|'justify'), lineHeight, charSpacing (Fabric's letter-spacing,
     in 1/1000-em units), underline, linethrough. No-op on anything but a text object (or an
     activeSelection whose every member is text) — same silent-no-op contract as setFill/setNumeric. */
  setTextProps(patch) {
    const o = this.fc.getActiveObject(); if (!o) return;
    const isText = (t) => t.type === 'i-text' || t.type === 'text' || t.type === 'textbox';
    if (o.type === 'activeSelection') { if (!o.getObjects().every(isText)) return; o.forEachObject(m => m.set(patch)); }
    else { if (!isText(o)) return; o.set(patch); }
    o.dirty = true;
    this.fc.renderAll();
    this.commit('text-props');
  }
  getTextProps() {
    const o = this.fc.getActiveObject();
    const t = o && o.type === 'activeSelection' ? o.getObjects()[0] : o;
    if (!t || (t.type !== 'i-text' && t.type !== 'text' && t.type !== 'textbox')) return null;
    return {
      fontFamily: t.fontFamily || 'system-ui, sans-serif', fontSize: t.fontSize || 48,
      fontWeight: t.fontWeight || 400, fontStyle: t.fontStyle || 'normal',
      textAlign: t.textAlign || 'left', lineHeight: t.lineHeight != null ? t.lineHeight : 1.16,
      charSpacing: t.charSpacing || 0, underline: !!t.underline, linethrough: !!t.linethrough,
    };
  }

  /* Resizes the artboard boundary itself (Photoshop's "Canvas Size", not "Image Size") — existing
     layers keep their absolute position and scale, so growing the canvas adds blank space and
     shrinking it can clip content rather than rescaling everything to fit. */
  resizeCanvas(width, height) {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h;
    this.fc.setDimensions({ width: w, height: h });
    this.engine.W = w; this.engine.H = h;
    // The magnetic-lasso edge map, the last wand seed, and every cached hover-preview polygon are
    // all scene-space coordinates measured against the OLD artboard size/origin — stale (and
    // potentially out of bounds) once W/H change, so drop them rather than let the next magnetic-
    // lasso/select-similar/hover-confirm call snap against or commit pre-resize geometry.
    this._edgeMap = null;
    this._lastWandSeed = null;
    this._edgeMapSeq++;
    if (this._hoverCache) this._hoverCache.clear();
    this.fc.renderAll();
    this.commit('resize-canvas');
    this._emit('resize', { width: w, height: h });
  }

  /* ── crop ─────────────────────────────────────────────────────────────────────────────── */
  applyCrop() {
    if (!this.crop) return;
    const dim = applyCrop(this.fc, this.crop, this.engine);
    this.W = dim.width; this.H = dim.height;
    this.fc.setDimensions(dim);
    this.crop = null;
    // Same reasoning as resizeCanvas(): the artboard origin just shifted (every object was
    // re-based by -x,-y) so any cached scene-space geometry from before the crop is stale.
    this._edgeMap = null;
    this._lastWandSeed = null;
    this._edgeMapSeq++;
    if (this._hoverCache) this._hoverCache.clear();
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

  /* Resolves "the background layer" the same priority order the reference editor's own bgGapInfo/
     submitBgSwap use: an explicit role:'bg' image first, else the bottom-most image layer (an
     opened photo with no separate bg layer) — excluding paint layers, which are never a
     background swap's target. Returns null if there's no image at all to operate on. */
  _bgLayer() {
    const objs = this.fc.getObjects();
    return objs.find(o => o.role === 'bg' && o.type === 'image') || objs.find(o => o.type === 'image' && o.role !== 'paint') || null;
  }

  /* Renders `layer` alone (not the flattened scene) to an artboard-size canvas via its own
     render(ctx) — the same "one layer's own pixels, ignoring everything above/below it in the
     stack" primitive pixels.js's renderSelectedPixels uses for a pixel-selection lift/copy. */
  _renderLayerAlone(layer) {
    const c = document.createElement('canvas'); c.width = this.W; c.height = this.H;
    try { layer.render(c.getContext('2d')); } catch (e) { /* not renderable — caller sees a blank canvas */ }
    return c;
  }

  /* White-where-transparent alpha mask of `layer` alone — the reference editor's bgGapInfo mask,
     used by aiExtendBackground to tell magicEdit exactly which pixels are still empty canvas
     (white = the model may fill it in, black = real pixels to leave alone). Returns
     {canvas, maskCanvas, gapFraction} or null if the layer isn't renderable. */
  _gapMaskFromLayer(layer) {
    const canvas = this._renderLayerAlone(layer);
    const ctx = canvas.getContext('2d');
    let data;
    try { data = ctx.getImageData(0, 0, this.W, this.H).data; } catch (e) { return null; }
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = this.W; maskCanvas.height = this.H;
    const mctx = maskCanvas.getContext('2d');
    const md = mctx.createImageData(this.W, this.H);
    let gap = 0;
    for (let i = 0; i < data.length; i += 4) {
      const empty = data[i + 3] < 8;
      if (empty) gap++;
      md.data[i] = md.data[i + 1] = md.data[i + 2] = empty ? 255 : 0;
      md.data[i + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    return { canvas, maskCanvas, gapFraction: gap / (this.W * this.H) };
  }

  /* Selection-derived protect mask: white = the current pixel selection's shape (the AI may
     repaint it), black = everywhere else (kept pixel-identical) — the inverse of a normal
     selection clip, since here white means "editable" rather than "selected region to act on".
     Returns a full-artboard canvas (never null; a null/absent selection just means an
     all-white — everything editable — mask, matching aiBgSwap's own contract of "no selection ⇒
     the model may repaint the whole background"). */
  _selectionEditMask() {
    const c = document.createElement('canvas'); c.width = this.W; c.height = this.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, this.W, this.H);
    if (this.selection) {
      const path = selectionToPath2D(this.selection, this.W, this.H);
      if (path) { ctx.fillStyle = '#000000'; ctx.fill(path, selectionFillRule(this.selection)); }
    }
    return c;
  }

  /* Swaps `oldLayer`'s pixels for a freshly-loaded image, in place: same id/role/name/locked
     identity, same z-index, full-bleed at the artboard's own W×H — everything else in the stack
     is untouched. This is what makes aiExtendBackground/aiBgSwap non-destructive (unlike
     openImageResult, which replaces the WHOLE composition) — undo still returns to the exact
     prior pixels, but every other layer survives an AI background edit unchanged. */
  async _swapLayerImage(oldLayer, dataURL) {
    const img = await new Promise((resolve, reject) => {
      this.fabric.Image.fromURL(dataURL, (im) => { im && im.width ? resolve(im) : reject(new Error('Could not load the AI result image.')); }, { crossOrigin: 'anonymous' });
    });
    if (this._destroyed) return null;
    const idx = this.fc.getObjects().indexOf(oldLayer);
    img.set({
      id: oldLayer.id || uid(), role: oldLayer.role || 'bg', name: oldLayer.name || 'Background', locked: !!oldLayer.locked,
      left: 0, top: 0, originX: 'left', originY: 'top', angle: 0,
      scaleX: this.W / img.width, scaleY: this.H / img.height,
    });
    if (oldLayer.locked) img.set({ selectable: false, evented: false, hasControls: false });
    this.fc.remove(oldLayer);
    this.fc.add(img);
    if (idx >= 0) { this.fc.remove(img); this.fc.insertAt(img, idx, false); }
    if (img.role === 'bg') this.fc.sendToBack(img);
    return img;
  }

  /* AI background replacement: targets the background layer specifically (see _bgLayer) and
     swaps only its pixels — every other layer in the composition survives untouched, unlike
     openImageResult's whole-composition replacement. With an active pixel selection, builds a
     real mask (white = background the model may repaint, black = the selected subject, kept
     pixel-identical) and passes it to magicEdit's optional 3rd argument when the registered
     provider reads it (AIRegistry#run forwards whatever args are given; a provider that ignores
     the mask still gets a usable result via the instruction text alone, same as before). Falls
     back to the old whole-scene openImageResult behavior when there's no image layer to target at
     all (nothing to swap in place). */
  async aiBgSwap(instruction) {
    const bg = this._bgLayer();
    if (!bg) {
      const flat = this.exportPNG();
      const r = await this.ai.run('magicEdit', flat, instruction + (this.selection ? ' Keep the selected subject pixel-identical; only change the background.' : ''));
      if (r.status === 'ok') await this.openImageResult(r.result);
      return r;
    }
    const flat = this._renderLayerAlone(bg).toDataURL('image/png');
    const hasSel = !!this.selection;
    const maskURL = hasSel ? this._selectionEditMask().toDataURL('image/png') : null;
    const text = hasSel
      ? instruction + ' Replace the background (the white regions of the mask) with this. Keep every black-masked subject pixel EXACTLY unchanged — same colours, edges and position. Blend the new background\'s lighting and shadows naturally around the subject.'
      : instruction + ' Keep the main subject exactly as it is — same position, scale, colours and details. Integrate lighting and shadows naturally.';
    const r = maskURL ? await this.ai.run('magicEdit', flat, text, maskURL) : await this.ai.run('magicEdit', flat, text);
    if (this._destroyed) return r;
    if (r.status === 'ok') {
      await this._swapLayerImage(bg, r.result);
      if (this._destroyed) return r;
      this.clearSelection();
      this.fc.renderAll();
      this.commit('ai-bg-swap');
    }
    return r;
  }

  /* Fraction (0..1) of the artboard that is still fully transparent once everything is flattened —
     used to decide whether an "extend background" affordance is worth showing. Samples on a coarse
     grid rather than every pixel; good enough for a UI nudge, not meant to be exact. */
  backgroundGapFraction() {
    const flat = this.exportPNG();
    return loadImageEl(flat).then(img => {
      if (this._destroyed) return 0;
      const c = document.createElement('canvas');
      const gw = 48, gh = Math.max(1, Math.round(gw * (this.H / this.W)));
      c.width = gw; c.height = gh;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, gw, gh);
      const data = ctx.getImageData(0, 0, gw, gh).data;
      let transparent = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 8) transparent++;
      return transparent / (gw * gh);
    }).catch(() => 0);
  }

  /* AI outpaint: targets the background layer specifically (see _bgLayer) and asks magicEdit to
     fill exactly its transparent gap, guided by a real white-where-empty mask (_gapMaskFromLayer)
     — pixel-precise, not just an instruction hoping the model infers the gap shape from the flat
     PNG. Swaps only that layer's pixels in place; every other layer survives untouched, same
     non-destructive contract as aiBgSwap. Falls back to the old whole-scene instruction-only
     behavior when there's no image layer to target (nothing to build a per-layer mask from). */
  async aiExtendBackground() {
    const bg = this._bgLayer();
    if (!bg) {
      const flat = this.exportPNG();
      const r = await this.ai.run('magicEdit', flat,
        'Extend and continue this image to fill the entire canvas — fill in any transparent or empty areas by naturally continuing the existing background, lighting, and style. Do not add new subjects.');
      if (r.status === 'ok') await this.openImageResult(r.result);
      return r;
    }
    const info = this._gapMaskFromLayer(bg);
    if (!info) return { status: 'error', reason: 'no_image' };
    if (!info.gapFraction) return { status: 'error', reason: 'no_gap', message: 'Background already fills the canvas.' };
    const r = await this.ai.run('magicEdit', info.canvas.toDataURL('image/png'),
      'Extend the background to fill the empty areas. Do not generate any text, letters, numbers or logos in the extended areas.',
      info.maskCanvas.toDataURL('image/png'));
    if (this._destroyed) return r;
    if (r.status === 'ok') {
      await this._swapLayerImage(bg, r.result);
      if (this._destroyed) return r;
      this.fc.renderAll();
      this.commit('ai-extend-bg');
    }
    return r;
  }

  /* Pure-geometry background fill (no AI call): scales the background image up to cover the whole
     artboard, same "cover" convention addImageLayer uses elsewhere. Prefers an explicit
     role:'bg' image; falls back to the bottom-most image layer (an opened photo with no separate
     bg layer). Returns false if there's no image to extend. */
  extendBackgroundToCanvas() {
    const objs = this.fc.getObjects();
    const bg = objs.find(o => o.role === 'bg' && o.type === 'image') || objs.find(o => o.type === 'image');
    if (!bg) return false;
    const w = bg.width * (bg.scaleX || 1), h = bg.height * (bg.scaleY || 1);
    if (w <= 0 || h <= 0) return false;
    const sc = Math.max(this.W / bg.width, this.H / bg.height);
    bg.clipPath = null;
    bg.set({ originX: 'center', originY: 'center', left: this.W / 2, top: this.H / 2, scaleX: sc, scaleY: sc, angle: 0 });
    bg.setCoords();
    this.fc.renderAll();
    this.commit('extend-bg');
    return true;
  }

  /* Fill the active selection (or the whole canvas, with none) with a flat colour — the Bucket
     tool's own fill, exposed as a direct call so a UI button can trigger it without a canvas
     click. Paints into the shared paint-engine layer, same as the bucket tool. */
  fillWithColor(color) {
    this._applySelClip();
    this.engine.fill(color);
    this.commit('bucket');
  }

  /* Fill the active selection (or the whole canvas) with an image, cropped/scaled to cover the
     fill region — same clip mechanism as fillWithColor, but stamps a bitmap instead of a flat
     colour into the paint-engine layer. */
  async fillWithImage(src) {
    const img = await loadImageEl(src);
    if (this._destroyed) return;
    this.engine.ensure();
    this._applySelClip();
    const ctx = this.engine.ctx;
    const box = this.selection ? selectionBounds(this.selection, this.W, this.H) : { x: 0, y: 0, w: this.W, h: this.H };
    const sc = Math.max(box.w / img.width, box.h / img.height);
    const dw = img.width * sc, dh = img.height * sc;
    const dx = box.x + (box.w - dw) / 2, dy = box.y + (box.h - dh) / 2;
    ctx.save();
    if (this.engine._clip) ctx.clip(this.engine._clip, this.engine._clipRule || 'nonzero');
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
    this.engine.commit();
    this.commit('fill-image');
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

  /* Flatten -> AI detectRegions, WITHOUT committing anything — returns the raw region list
     ({type, bbox:{x,y,width,height in %}, content?}) plus the flattened source image a host UI can
     show as a review step (adjust/delete/add boxes, retype a region) before calling
     commitRegions() with the (possibly edited) array. detectRegionsToLayers() below is the
     one-shot convenience that skips review entirely. */
  async detectRegions() {
    const flat = this.exportPNG();
    const r = await this.ai.run('detectRegions', flat);
    if (this._destroyed) return r;
    if (r.status !== 'ok') return r;
    const regions = Array.isArray(r.result) ? r.result : [];
    if (!regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions detected.' };
    return { status: 'ok', result: { flat, regions } };
  }

  /* Explode `regions` (same shape as detectRegions()' result.regions, in percent-of-canvas bbox
     coordinates) into real editable layers over a background image built from `flat` — a text
     region becomes a text layer (using `content` as the string), everything else an image layer
     cropped from `flat` at that bbox. Replaces the current composition, same history contract as
     openImageResult. Pure layer-building — no AI call of its own, so a review UI can call this
     however many times the user wants after adjusting boxes returned by detectRegions(). */
  async commitRegions(flat, regions) {
    if (!Array.isArray(regions) || !regions.length) return { status: 'error', reason: 'no_regions', message: 'No regions to commit.' };
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
      const role = REGION_ROLE[rg.type] || rg.type || 'image';
      if (rg.type === 'text') {
        const txt = makeText(this.fabric, { x, y }, { text: rg.content || 'Text', fontSize: Math.max(12, Math.round(h * 0.6)) });
        txt.set({ role, regionType: rg.type, name: (rg.content || 'Text').slice(0, 24) });
        this.fc.add(txt);
      } else {
        const sx = src.naturalWidth / this.W, sy = src.naturalHeight / this.H;
        const cw = Math.max(1, Math.round(w * sx)), ch = Math.max(1, Math.round(h * sy));
        const c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(src, Math.round(x * sx), Math.round(y * sy), cw, ch, 0, 0, cw, ch);
        const img = new this.fabric.Image(c, { left: x, top: y, originX: 'left', originY: 'top' });
        img.set({ id: uid(), role, regionType: rg.type, name: (rg.type || 'Layer')[0].toUpperCase() + (rg.type || 'layer').slice(1) });
        this.fc.add(img);
      }
    }
    this.fc.discardActiveObject();
    this.fc.renderAll();
    this.commit('regions-to-layers');
    return { status: 'ok', result: regions.length };
  }

  /* One-shot convenience: detect + commit immediately with no review step (what the AI panel's
     original "Detect regions → layers" button already did before commitRegions() existed). */
  async detectRegionsToLayers() {
    const r = await this.detectRegions();
    if (r.status !== 'ok') return r;
    return this.commitRegions(r.result.flat, r.result.regions);
  }

  destroy() {
    this._destroyed = true;
    if (this._frameHandles) Object.keys(this._frameHandles).forEach(key => this._cancelFrameJob(key));
    if (typeof document !== 'undefined') {
      if (this._onSpaceDown) document.removeEventListener('keydown', this._onSpaceDown);
      if (this._onSpaceUp) document.removeEventListener('keyup', this._onSpaceUp);
    }
    this.fc.dispose();
    this._listeners = {};
    if (this.cv) this.cv.destroy();
  }
}
