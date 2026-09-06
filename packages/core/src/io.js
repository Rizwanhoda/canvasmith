/* Serialization and import/export.

   EXTRA lists the library's own layer metadata that must survive fabric.toJSON round-trips —
   drop one of these and undo/redo silently strips it from every layer. */

export const EXTRA = ['id', 'role', 'name', 'locked', 'spec', 'fx', 'regionType', 'rcontent', 'rstyle', 'renamed', 'isFreehand', 'maskEnabled', 'adj'];

/* fc.toJSON() doesn't carry the canvas's own width/height (only its objects/background), so a
   canvas-size change (Editor#resizeCanvas) would otherwise be invisible to undo/redo — every
   snapshot embeds the artboard dimensions alongside the fabric JSON to round-trip that too. */
export function serialize(fc) {
  return JSON.stringify({ w: fc.getWidth(), h: fc.getHeight(), scene: fc.toJSON(EXTRA) });
}

export function restore(fc, json, { engine, history, onDone } = {}) {
  if (history) history.lock = true;
  const { w, h, scene } = JSON.parse(json);
  fc.setDimensions({ width: w, height: h });
  if (engine) { engine.W = w; engine.H = h; }
  fc.loadFromJSON(scene, () => {
    if (engine) engine.adopt();
    fc.renderAll();
    if (history) history.lock = false;
    if (onDone) onDone(w, h);
  });
}

/* Export the artboard as an image, independent of the current zoom/pan. */
export function exportImage(fc, W, H, { format = 'png', quality = 0.92, multiplier = 1 } = {}) {
  const vpt = fc.viewportTransform.slice();
  const w = fc.getWidth(), h = fc.getHeight();
  fc.setViewportTransform([1, 0, 0, 1, 0, 0]);
  fc.setDimensions({ width: W, height: H });
  const url = fc.toDataURL({ format, quality, multiplier, left: 0, top: 0, width: W, height: H });
  fc.setDimensions({ width: w, height: h });
  fc.setViewportTransform(vpt);
  fc.renderAll();
  return url;
}

/* Load a URL/dataURL as an image layer, scaled to fit the artboard. */
export function addImageLayer(fabric, fc, src, { W, H, name = 'Image', role = 'image', fit = 'contain' } = {}) {
  return new Promise((resolve, reject) => {
    fabric.Image.fromURL(src, img => {
      if (!img || !img.width) return reject(new Error('Could not load that image.'));
      const scale = fit === 'cover'
        ? Math.max(W / img.width, H / img.height)
        : Math.min(1, Math.min(W / img.width, H / img.height));
      img.set({
        left: (W - img.width * scale) / 2, top: (H - img.height * scale) / 2,
        scaleX: scale, scaleY: scale,
        id: 'o' + Math.random().toString(36).slice(2, 8), role, name,
      });
      fc.add(img);
      fc.setActiveObject(img);
      fc.renderAll();
      resolve(img);
    }, { crossOrigin: 'anonymous' });
  });
}

/* Artboard dimensions matched to an image's own pixels (capped so huge photos stay workable) —
   opening a 9:16 photo must NOT crop it into a square. */
export function artboardForImage(src, cap = 1600) {
  return new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth || 1080, h = im.naturalHeight || 1080;
      const sc = Math.min(1, cap / Math.max(w, h));
      resolve({ width: Math.max(1, Math.round(w * sc)), height: Math.max(1, Math.round(h * sc)) });
    };
    im.onerror = () => resolve({ width: 1080, height: 1080 });
    im.src = src;
  });
}

/* Plain <img> load (no fabric wrapping) — for callers that need raw pixel access, e.g. cropping
   per-region canvases out of a flattened source in detectRegionsToLayers(). */
export function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not load that image.'));
    im.crossOrigin = 'anonymous';
    im.src = src;
  });
}
