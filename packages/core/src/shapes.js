/* Vector layers: shapes and text. Fabric is injected; every creator returns the new object with
   the library's layer metadata (id/role/name) already set, so hosts can list and manage layers
   without knowing Fabric internals. */

let _uid = 0;
export const uid = () => 'o' + (Date.now().toString(36)) + (_uid++).toString(36);

export function starPoints(cx, cy, outer, inner, n) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / n) * i - Math.PI / 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

const BASE = { originX: 'left', originY: 'top' };

export function makeShape(fabric, tool, pt, o = {}) {
  const size = o.size || 160;
  const fill = o.fill || '#d4ff45';
  const stroke = o.stroke || null;
  const strokeWidth = o.strokeWidth || 0;
  const common = { ...BASE, left: pt.x - size / 2, top: pt.y - size / 2, fill, stroke, strokeWidth };
  let obj = null;
  if (tool === 'rect') obj = new fabric.Rect({ ...common, width: size, height: size, rx: o.rx || 0, ry: o.rx || 0 });
  else if (tool === 'ellipse') obj = new fabric.Ellipse({ ...common, rx: size / 2, ry: size / 2 });
  else if (tool === 'triangle') obj = new fabric.Triangle({ ...common, width: size, height: size });
  else if (tool === 'line') obj = new fabric.Line([pt.x - size / 2, pt.y, pt.x + size / 2, pt.y], { stroke: stroke || fill, strokeWidth: strokeWidth || 4 });
  else if (tool === 'polygon') obj = new fabric.Polygon(starPoints(pt.x, pt.y, size / 2, size / 2, 6).filter((_, i) => i % 2 === 0), { fill, stroke, strokeWidth });
  else if (tool === 'star') obj = new fabric.Polygon(starPoints(pt.x, pt.y, size / 2, size / 4, 5), { fill, stroke, strokeWidth });
  if (!obj) return null;
  obj.set({ id: uid(), role: 'shape', name: tool[0].toUpperCase() + tool.slice(1) });
  return obj;
}

/* Resize a shape made by makeShape() to span two drag points, keeping it live during mouse:move.
   Mirrors makeShape's own per-type geometry so a click-drag ends up exactly where a click-release
   would place a shape of that size. */
export function resizeShapeTo(obj, tool, from, to) {
  const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
  const w = Math.max(1, Math.abs(to.x - from.x)), h = Math.max(1, Math.abs(to.y - from.y));
  if (tool === 'rect' || tool === 'triangle') {
    obj.set({ left: x, top: y, width: w, height: h });
  } else if (tool === 'ellipse') {
    obj.set({ left: x, top: y, rx: w / 2, ry: h / 2 });
  } else if (tool === 'line') {
    obj.set({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  } else if (tool === 'polygon' || tool === 'star') {
    const cx = x + w / 2, cy = y + h / 2;
    const pts = tool === 'polygon'
      ? starPoints(cx, cy, w / 2, h / 2, 6).filter((_, i) => i % 2 === 0)
      : starPoints(cx, cy, w / 2, h / 4, 5);
    obj.set({ points: pts, left: x, top: y, width: w, height: h });
    obj.setCoords();
  }
  obj.setCoords();
}

export function makeText(fabric, pt, o = {}) {
  const t = new fabric.IText(o.text || 'Double-click to edit', {
    ...BASE, left: pt.x, top: pt.y,
    fontFamily: o.fontFamily || 'system-ui, sans-serif',
    fontSize: o.fontSize || 48,
    fontWeight: o.fontWeight || 700,
    fill: o.fill || '#111111',
  });
  t.set({ id: uid(), role: 'text', name: 'Text' });
  return t;
}

/* Human name for a layer, mirroring what a layers panel wants to show. */
export function layerLabel(o) {
  if (o.renamed && o.name) return o.name;
  if (o.role === 'paint') return o.name || 'Paint';
  if (o.role === 'bg') return 'Background';
  if (o.type === 'i-text' || o.type === 'text' || o.type === 'textbox') return (o.text || 'Text').slice(0, 24);
  if (o.type === 'image') return o.name || 'Image';
  if (o.type === 'group') return (o._objects ? o._objects.length : '?') + ' layers';
  return o.name || o.type || 'Layer';
}
