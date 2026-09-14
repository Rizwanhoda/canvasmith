/* Promotional layout templates: percentage-of-artboard layer positioning for a headline/subhead/
   CTA/badge/brand/product composition, plus the spec -> real Fabric object builder that
   instantiates one. Generic (not tied to any single host's copy/branding) — a caller supplies its
   own headline/subhead/CTA text, palette, and product image; this module only knows the layout
   math and how to turn a layer spec into a Fabric object.

   Two layers of API:
     buildLayerFromSpec(fabric, spec, imgEl) — one spec -> one Fabric object (id/role/name set,
       ready to fc.add()). Mirrors shapes.js's makeShape/makeText contract, extended to also cover
       adtext.js's cta/badge/price/brand kinds, auto-fit text, and legibility shadows.
     buildPromoLayout(spec, W, H) — one call -> an ordered list of layer specs for a full
       hero/sale/centered composition, each ready for buildLayerFromSpec(). Pure data in, pure data
       out (no fabric touched), so the layout math is unit-testable on its own. */

import { uid } from './shapes.js';
import { relLum, hexRgb } from './color.js';
import { makeCTA, makeBadge, makePrice, makeBrandLockup, autoFitText, applyLegibilityShadow } from './adtext.js';

function gradFill(fabric, hues, w, h) {
  return new fabric.Gradient({ type: 'linear', gradientUnits: 'pixels', coords: { x1: 0, y1: 0, x2: w, y2: h }, colorStops: [{ offset: 0, color: hues[0] }, { offset: 1, color: hues[1] }] });
}
/* Vertical dark-toward-bottom scrim, the standard "legibility gradient" behind text over a photo. */
export function scrimFill(fabric, h) {
  return new fabric.Gradient({ type: 'linear', gradientUnits: 'pixels', coords: { x1: 0, y1: 0, x2: 0, y2: h }, colorStops: [{ offset: 0, color: 'rgba(0,0,0,0)' }, { offset: 0.55, color: 'rgba(0,0,0,0.05)' }, { offset: 1, color: 'rgba(0,0,0,0.6)' }] });
}

/* Builds one real Fabric object from a layer spec ({kind, left, top, width, height, ...}) — the
   generic counterpart to shapes.js's per-tool factories, covering every `kind` a layout in this
   module can emit. `spec.left/top` are always scene-space top-left unless `spec.originX/originY`
   says otherwise (matches every other factory in this package). `imgEl` is a pre-loaded <img>,
   required only for `kind: 'image'` specs that carry a `src`. */
export function buildLayerFromSpec(fabric, spec, imgEl) {
  const base = { originX: spec.originX || 'left', originY: spec.originY || 'top', angle: spec.angle || 0 };
  let obj;
  const pt = { x: spec.left, y: spec.top };
  if (spec.kind === 'text') {
    obj = new fabric.Textbox(spec.text || ' ', {
      ...base, left: spec.left, top: spec.top, width: spec.width,
      fontFamily: spec.font, fontWeight: spec.weight || 400, fontSize: spec.size,
      fill: spec.fill, textAlign: spec.align || 'left', lineHeight: spec.lineHeight || 1.08,
      splitByGrapheme: false,
    });
    if (spec.maxH) autoFitText(obj, spec.maxH);
    if (spec.shadow) applyLegibilityShadow(fabric, obj, spec.shadow);
  } else if (spec.kind === 'cta') { obj = makeCTA(fabric, pt, { ...spec, fill: spec.fill, ink: spec.ink }); obj.set(base); }
  else if (spec.kind === 'badge') { obj = makeBadge(fabric, pt, spec); obj.set(base); }
  else if (spec.kind === 'price') { obj = makePrice(fabric, pt, spec); obj.set(base); }
  else if (spec.kind === 'brand') { obj = makeBrandLockup(fabric, pt, { ...spec, color: spec.color }); obj.set(base); }
  else if (spec.kind === 'ellipse') {
    const fill = Array.isArray(spec.fill) ? gradFill(fabric, spec.fill, spec.width, spec.height) : spec.fill;
    obj = new fabric.Ellipse({ ...base, left: spec.left, top: spec.top, rx: spec.width / 2, ry: spec.height / 2, fill });
  } else if (spec.kind === 'image' && imgEl) {
    const iw = imgEl.width, ih = imgEl.height;
    const contain = spec.fit === 'contain';
    const scale = contain ? Math.min(spec.width / iw, spec.height / ih) : Math.max(spec.width / iw, spec.height / ih);
    const cxp = spec.originX === 'center' ? spec.left : spec.left + spec.width / 2;
    const cyp = spec.originY === 'center' ? spec.top : spec.top + spec.height / 2;
    obj = new fabric.Image(imgEl, { left: cxp, top: cyp, originX: 'center', originY: 'center', scaleX: scale, scaleY: scale, angle: spec.angle || 0 });
    if (!contain) {
      const circle = spec.rx && spec.rx >= spec.width / 2 * 0.95;
      obj.clipPath = circle
        ? new fabric.Ellipse({ rx: spec.width / 2 / scale, ry: spec.height / 2 / scale, originX: 'center', originY: 'center' })
        : new fabric.Rect({ width: spec.width / scale, height: spec.height / scale, rx: (spec.rx || 0) / scale, ry: (spec.rx || 0) / scale, originX: 'center', originY: 'center' });
    }
  } else { // rect (product placeholder, scrim, bg)
    const fill = spec.fill === 'scrim' ? scrimFill(fabric, spec.height) : (Array.isArray(spec.fill) ? gradFill(fabric, spec.fill, spec.width, spec.height) : spec.fill);
    obj = new fabric.Rect({ ...base, left: spec.left, top: spec.top, width: spec.width, height: spec.height, rx: spec.rx || 0, ry: spec.rx || 0, fill });
  }
  // spec is preserved on the built object (round-trips through serialization via io.js's own
  // EXTRA, which already lists 'spec') so a host can re-derive "what template slot was this" for
  // re-editing later — matches the reference editor's own makeObj, which does the same.
  obj.set({ id: spec.id || uid(), role: spec.role || 'shape', name: spec.name || 'Layer', locked: !!spec.locked, spec });
  if (spec.locked) obj.set({ selectable: false, evented: false, hasControls: false });
  return obj;
}

/* Layout groups a `layout` name folds into — mirrors the reference editor's own grouping so
   'hero'/'editorial'/'lookbook'/'split' all get the same composition, 'sale' its own, and
   everything else (including 'centered') the default centered layout. */
function layoutGroup(layout) {
  if (['hero', 'editorial', 'lookbook', 'split'].includes(layout)) return 'hero';
  if (layout === 'sale') return 'sale';
  return 'centered';
}

/* Builds an ordered list of layer specs (top of the array = bottom of the stack, matching
   fc.add()'s own append-on-top order) for a promotional composition. Pure geometry/data — no
   fabric import, no DOM — so callers turn each entry into a real object via buildLayerFromSpec()
   once (and only if) they're ready to commit it to the canvas.

   spec: { layout: 'hero'|'sale'|'centered'|..., palette: {bg,fg,accent,p1:[c1,c2]},
           head, sub, cta, badge, brand, productImg, font, uiFont } — every field optional; sane
   defaults fill in so a caller can start from an empty object and still get a valid layout. */
export function buildPromoLayout(spec = {}, W, H) {
  const pal = spec.palette || {};
  const bg = pal.bg || '#ffffff', fg = pal.fg || '#111114', accent = pal.accent || '#ef6a2d';
  const hues = pal.p1 || ['#8a8a8a', '#444444'];
  const head = spec.head || 'Your headline', sub = spec.sub || '', cta = spec.cta || 'Shop now';
  const badge = spec.badge || '', brand = spec.brand || 'Brand';
  const img = spec.productImg || null;
  const layout = spec.layout || 'centered';
  const font = spec.font || "'Bricolage Grotesque', sans-serif";
  const uiFont = spec.uiFont || "'Hanken Grotesk', sans-serif";
  const inkOnAccent = relLum(hexRgb(accent)) > 0.6 ? '#0c0c0e' : '#ffffff';
  const group = layoutGroup(layout);
  const M = Math.round(W * 0.08), cx = W / 2;
  const L = [];

  L.push({ id: 'bg', role: 'bg', kind: 'rect', name: 'Background', left: 0, top: 0, width: W, height: H, fill: bg, locked: true });

  const brandLockup = (left, top, color, originX) => ({ id: 'brand', role: 'brand', kind: 'brand', name: 'Brand mark', left, top, originX: originX || 'left', text: brand, color: color || fg, accent, ink: inkOnAccent, font, size: Math.round(W * 0.034) });
  const ctaPill = (left, top, originX) => ({ id: 'cta', role: 'cta', kind: 'cta', name: 'CTA button', left, top, originX: originX || 'left', text: cta, fill: accent, ink: inkOnAccent, font: uiFont, size: Math.round(W * 0.03) });
  const badgeChip = (left, top, originX) => (badge ? { id: 'badge', role: 'badge', kind: 'badge', name: 'Badge', left, top, originX: originX || 'left', text: badge, fill: accent, ink: inkOnAccent, font: uiFont, size: Math.round(W * 0.024) } : null);

  if (group === 'hero') {
    const ph = Math.round(H * 0.62);
    L.push({ id: 'product', role: 'product', kind: img ? 'image' : 'rect', name: 'Product', left: 0, top: 0, width: W, height: ph, fill: hues, src: img, fit: 'cover' });
    L.push({ id: 'scrim', role: 'scrim', kind: 'rect', name: 'Shade', left: 0, top: Math.round(H * 0.34), width: W, height: H - Math.round(H * 0.34), fill: 'scrim' });
    L.push(brandLockup(M, Math.round(H * 0.06), '#ffffff'));
    const b = badgeChip(W - M, Math.round(H * 0.06), 'right'); if (b) L.push(b);
    L.push({ id: 'headline', role: 'headline', kind: 'text', name: 'Headline', left: M, top: Math.round(H * 0.66), width: W - 2 * M, text: head, fill: '#ffffff', font, weight: 800, size: Math.round(W * 0.088), align: 'left', lineHeight: 0.98 });
    if (sub) L.push({ id: 'sub', role: 'sub', kind: 'text', name: 'Subhead', left: M, top: Math.round(H * 0.66 + W * 0.115), width: W - 2 * M, text: sub, fill: 'rgba(255,255,255,0.9)', font: uiFont, weight: 500, size: Math.round(W * 0.032), align: 'left' });
    L.push(ctaPill(M, Math.round(H * 0.87)));
  } else if (group === 'sale') {
    L.push({ id: 'burst', role: 'burst', kind: 'ellipse', name: 'Accent burst', left: W - Math.round(W * 0.12), top: -Math.round(W * 0.12), width: Math.round(W * 0.46), height: Math.round(W * 0.46), fill: accent, originX: 'center', originY: 'center' });
    L.push(brandLockup(M, Math.round(H * 0.07), fg));
    L.push({ id: 'headline', role: 'headline', kind: 'text', name: 'Headline', left: M, top: Math.round(H * 0.3), width: Math.round(W * 0.74), text: head, fill: fg, font, weight: 800, size: Math.round(W * 0.12), align: 'left', lineHeight: 0.92 });
    if (sub) L.push({ id: 'sub', role: 'sub', kind: 'text', name: 'Subhead', left: M, top: Math.round(H * 0.56), width: Math.round(W * 0.6), text: sub, fill: fg, font: uiFont, weight: 600, size: Math.round(W * 0.032), align: 'left' });
    L.push(ctaPill(M, Math.round(H * 0.67)));
    const ps = Math.round(W * 0.34);
    L.push({ id: 'product', role: 'product', kind: img ? 'image' : 'rect', name: 'Product', left: W - ps - Math.round(M * 0.4), top: H - ps - Math.round(M * 0.4), width: ps, height: ps, fill: hues, src: img, fit: 'cover', rx: Math.round(W * 0.03), angle: -8 });
  } else { // centered
    L.push(brandLockup(cx, Math.round(H * 0.085), fg, 'center'));
    const b = badgeChip(W - M, Math.round(H * 0.07), 'right'); if (b) L.push(b);
    L.push({ id: 'headline', role: 'headline', kind: 'text', name: 'Headline', left: cx, top: Math.round(H * 0.19), width: W - 2 * M, text: head, fill: fg, font, weight: 800, size: Math.round(W * 0.082), align: 'center', originX: 'center', lineHeight: 1.0 });
    const ps = Math.round(W * 0.42);
    L.push({ id: 'product', role: 'product', kind: img ? 'image' : 'ellipse', name: 'Product', left: cx, top: Math.round(H * 0.53), width: ps, height: ps, fill: hues, src: img, fit: 'cover', originX: 'center', originY: 'center', rx: ps / 2 });
    if (sub) L.push({ id: 'sub', role: 'sub', kind: 'text', name: 'Subhead', left: cx, top: Math.round(H * 0.78), width: Math.round(W * 0.72), text: sub, fill: fg, font: uiFont, weight: 500, size: Math.round(W * 0.03), align: 'center', originX: 'center' });
    L.push(ctaPill(cx, Math.round(H * 0.88), 'center'));
  }
  return { W, H, bg, layers: L, accent };
}
