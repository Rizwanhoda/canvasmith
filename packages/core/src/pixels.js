/* Pixel-selection <-> layer conveniences — the Fabric-touching half of selection.js's pure geometry.
   Shared by liftSelectionToLayer/cutSelectionFromLayer/duplicateSelectionToLayer/recolorSelection:
   all of them need to (a) build a fabric clip shape from selection data and (b) render a layer's
   pixels through that clip into a tight offscreen canvas. Kept separate from editor.js so the
   render math is testable in isolation from tool dispatch. */
import { selectionBounds } from './selection.js';

/* A fabric clip object for any selection kind. multipoly becomes a multi-subpath fabric.Path
   (clips as the union of its rings) since fabric has no native multi-polygon primitive. */
export function selectionClipObject(fabric, sel) {
  if (!sel) return null;
  if (sel.kind === 'ellipse') return new fabric.Ellipse({ left: sel.x, top: sel.y, rx: Math.abs(sel.w / 2), ry: Math.abs(sel.h / 2), originX: 'left', originY: 'top' });
  if (sel.kind === 'poly') return new fabric.Polygon((sel.pts || []).map(p => ({ x: p.x, y: p.y })), {});
  if (sel.kind === 'multipoly') {
    const d = (sel.polys || []).map(pl => 'M' + pl.map((p, i) => (i ? 'L' : '') + p.x + ' ' + p.y).join(' ') + 'Z').join(' ');
    return new fabric.Path(d, { fillRule: 'nonzero' });
  }
  return new fabric.Rect({ left: sel.x, top: sel.y, width: sel.w, height: sel.h });
}

/* Render `layer`'s own pixels, clipped to `sel` (or unclipped if none), into a tight canvas sized
   to the selection's bounding box. Returns {canvas, box} or null if the selection is degenerate.
   An INVERTED selection has no meaningful "tight" bbox — "everything outside the shape" spans the
   whole artboard, not the shape's own small bounding box — so it renders at the full W×H instead;
   selectionBounds() itself is invert-agnostic (matches selectionToPath2D's own contract), so the
   full-canvas box is resolved here rather than pushed onto every caller of selectionBounds. */
export function renderSelectedPixels(fabric, layer, sel, W, H, Path2DImpl) {
  const box = (sel && sel.invert) ? { x: 0, y: 0, w: W, h: H } : selectionBounds(sel, W, H);
  if (box.w < 1 || box.h < 1) return null;
  const cw = Math.max(1, Math.round(box.w)), ch = Math.max(1, Math.round(box.h));
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(-box.x, -box.y);
  if (sel) {
    const P = Path2DImpl || (typeof Path2D !== 'undefined' ? Path2D : null);
    if (P) {
      const path = pathFromSelection(sel, P, sel.invert ? box : null);
      if (path) ctx.clip(path, sel.invert ? 'evenodd' : 'nonzero');
    }
  }
  try { layer.render(ctx); } catch (e) { /* layer not renderable (locked group edge cases) */ }
  ctx.restore();
  return { canvas: cv, box };
}

/* `outerBox`, when set, adds an outer rect spanning the render canvas's own bounds so an inverted
   selection's evenodd clip actually excludes the shape's interior instead of being a no-op — the
   render canvas is already translated to box-local coordinates, so the outer rect must cover
   (box.x, box.y, box.w, box.h) in that same local space, mirroring selectionToPath2D's use of the
   full W×H artboard rect for the equivalent on-canvas case. */
function pathFromSelection(sel, Path2DImpl, outerBox) {
  const p = new Path2DImpl();
  if (outerBox) p.rect(outerBox.x, outerBox.y, outerBox.w, outerBox.h);
  if (sel.kind === 'ellipse') p.ellipse(sel.x + sel.w / 2, sel.y + sel.h / 2, Math.abs(sel.w / 2), Math.abs(sel.h / 2), 0, 0, 7);
  else if (sel.kind === 'poly') { (sel.pts || []).forEach((pt, i) => i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)); p.closePath(); }
  else if (sel.kind === 'multipoly') { (sel.polys || []).forEach(pl => { pl.forEach((pt, i) => i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)); p.closePath(); }); }
  else p.rect(sel.x, sel.y, sel.w, sel.h);
  return p;
}
