/* Layout — pure geometry helpers for aligning a layer to the artboard and snapping while dragging.
   Both take plain {left,top,width,height} bounding boxes so they're testable without fabric. */

/* Delta to align a box to one artboard edge/axis. edge: 'left'|'center'|'right'|'top'|'middle'|'bottom'. */
export function alignDelta(box, W, H, edge) {
  const dx = { left: -box.left, center: (W - box.width) / 2 - box.left, right: W - box.width - box.left }[edge];
  const dy = { top: -box.top, middle: (H - box.height) / 2 - box.top, bottom: H - box.height - box.top }[edge];
  return { dx: dx ?? 0, dy: dy ?? 0 };
}

/* Snap a moving box's edges/center to the artboard bounds and to other boxes' edges/centers.
   Returns the {dx,dy} nudge to apply (0 on an axis with no snap within `threshold`), plus a
   `guideX`/`guideY` line descriptor per snapped axis — the coordinate snapped to, and the span
   (in the *other* axis) a "smart guide" should be drawn across: the moving box extended to cover
   whichever matched target box is bigger, so the line reaches both aligned edges like Figma's. */
export function snapDelta(box, W, H, others, threshold = 8) {
  const targetsX = [{ v: 0 }, { v: W / 2 }, { v: W }];
  const targetsY = [{ v: 0 }, { v: H / 2 }, { v: H }];
  for (const ob of others) {
    targetsX.push({ v: ob.left, box: ob }, { v: ob.left + ob.width / 2, box: ob }, { v: ob.left + ob.width, box: ob });
    targetsY.push({ v: ob.top, box: ob }, { v: ob.top + ob.height / 2, box: ob }, { v: ob.top + ob.height, box: ob });
  }
  const edgesX = [box.left, box.left + box.width / 2, box.left + box.width];
  const edgesY = [box.top, box.top + box.height / 2, box.top + box.height];
  let dx = null, dy = null, hitX = null, hitY = null;
  for (const e of edgesX) for (const t of targetsX) { const d = t.v - e; if (Math.abs(d) <= threshold && (dx == null || Math.abs(d) < Math.abs(dx))) { dx = d; hitX = t; } }
  for (const e of edgesY) for (const t of targetsY) { const d = t.v - e; if (Math.abs(d) <= threshold && (dy == null || Math.abs(d) < Math.abs(dy))) { dy = d; hitY = t; } }
  const span = (a0, a1, b) => b ? [Math.min(a0, b.top), Math.max(a1, b.top + b.height)] : [0, H];
  const spanH = (a0, a1, b) => b ? [Math.min(a0, b.left), Math.max(a1, b.left + b.width)] : [0, W];
  const guideX = hitX ? { x: hitX.v, y0: span(box.top, box.top + box.height, hitX.box)[0], y1: span(box.top, box.top + box.height, hitX.box)[1] } : null;
  const guideY = hitY ? { y: hitY.v, x0: spanH(box.left, box.left + box.width, hitY.box)[0], x1: spanH(box.left, box.left + box.width, hitY.box)[1] } : null;
  return { dx: dx ?? 0, dy: dy ?? 0, snappedX: dx != null, snappedY: dy != null, guideX, guideY };
}
