/* Paintable, non-destructive layer masks — image/paint-role layers only (see editor.js's
   addMask doc comment for why vector shapes/text are out of scope for v1).

   A mask is a full-artboard-resolution grayscale canvas stored on the fabric object as
   `o.maskCanvas` (white = fully visible, black = fully hidden, gray = partial) plus
   `o.maskEnabled` (bool — a disabled mask is kept but has no visual effect, Photoshop's
   shift-click-thumbnail toggle). It's applied through Fabric's own filter pipeline as a custom
   `MaskFilter` pushed onto `o.filters` alongside the brightness/contrast/etc. filters
   Editor#setImageFilters already manages — applyFilters() re-runs the whole chain from the
   pristine source on every call, so a mask edit is just "repaint maskCanvas, call
   o.applyFilters() again", the same non-destructive contract adjustment filters already have.

   MaskFilter itself needs `fabric` injected (it's built as a fabric.util.createClass subclass,
   which doesn't exist until a real fabric is loaded), so this module exports a factory instead of
   a class — call makeMaskFilterClass(fabric) once and reuse the constructor it returns. */

let _MaskFilterClass = null;
let _builtForFabric = null;

export function makeMaskFilterClass(fabric) {
  if (_MaskFilterClass && _builtForFabric === fabric) return _MaskFilterClass;
  _MaskFilterClass = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'MaskFilter',
    maskCanvas: null,
    mainParameter: 'maskCanvas',

    /* Reads maskCanvas's grayscale value at each source pixel (nearest-neighbor sampled up from
       artboard resolution to whatever resolution Fabric is filtering at — its own internal
       scaling, not something this filter needs to know about beyond width/height) and multiplies
       the pixel's alpha by it. No maskCanvas (or a zero-size one) is a no-op — same "adding a
       mask a host UI never painted into shouldn't blow anything up" contract as an empty selection
       elsewhere in this codebase. */
    applyTo2d(options) {
      const { imageData } = options;
      const mc = this.maskCanvas;
      if (!mc || !mc.width || !mc.height) return;
      const data = imageData.data, w = imageData.width, h = imageData.height;
      const mctx = mc.getContext('2d');
      let mdata;
      try { mdata = mctx.getImageData(0, 0, mc.width, mc.height).data; } catch (e) { return; }
      const sx = mc.width / w, sy = mc.height / h;
      for (let y = 0; y < h; y++) {
        const my = Math.min(mc.height - 1, Math.floor(y * sy));
        for (let x = 0; x < w; x++) {
          const mx = Math.min(mc.width - 1, Math.floor(x * sx));
          const mi = (my * mc.width + mx) * 4;
          // Grayscale value read off the red channel (the mask is painted achromatically, so
          // R/G/B are equal) scaled by the mask pixel's own alpha — an untouched (transparent)
          // area of the mask canvas defaults to fully-visible (mask value 1), matching a
          // freshly-added mask that hasn't been painted on yet.
          const maskAlpha = mdata[mi + 3] / 255;
          const gray = mdata[mi] / 255;
          const value = maskAlpha > 0 ? gray : 1;
          const i = (y * w + x) * 4;
          data[i + 3] = Math.round(data[i + 3] * value);
        }
      }
    },

    isNeutralState() { return !this.maskCanvas; },

    /* maskCanvas is a raw HTMLCanvasElement — JSON.stringify can't touch it, so toObject swaps it
       for a dataURL (mirrors how paint-layer canvases already round-trip through <img> src on
       restore) and fromObject decodes it back. Fabric's own filter fromObject supports this
       asynchronously via its callback param (see BaseFilter.fromObject) — the filter object
       itself is returned/constructed immediately with maskCanvas still null, then patched in and
       callback(filter) fires again once decoding finishes, which is what makes
       Editor#loadJSON/restore's overall "wait for loadFromJSON's callback" flow correctly wait for
       mask pixels too (io.js's restore() defers engine.adopt()/onDone to fc.loadFromJSON's own
       callback, and Fabric doesn't call ITS callback until every object — filters included — is
       through its own fromObject). */
    toObject() {
      return { type: this.type, maskDataURL: this.maskCanvas ? this.maskCanvas.toDataURL('image/png') : null };
    },
  });
  _MaskFilterClass.fromObject = function (object, callback) {
    const filter = new _MaskFilterClass({});
    if (!object.maskDataURL) { callback && callback(filter); return filter; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
      c.getContext('2d').drawImage(img, 0, 0);
      filter.maskCanvas = c;
      callback && callback(filter);
    };
    img.onerror = () => { callback && callback(filter); };
    img.src = object.maskDataURL;
    return filter;
  };
  // Registered under fabric's own filters namespace so its generic enlivenObjects() dispatch
  // (used when restoring a whole scene from JSON — see io.js's restore()) can find this class by
  // its serialized `type: 'MaskFilter'` string, the same way every built-in filter is registered.
  fabric.Image.filters.MaskFilter = _MaskFilterClass;
  _builtForFabric = fabric;
  return _MaskFilterClass;
}

/* Fresh artboard-resolution mask canvas, fully transparent (== fully visible, per applyTo2d's
   "untouched = visible" default) so adding a mask never hides anything until the user paints it. */
export function createMaskCanvas(W, H) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W));
  c.height = Math.max(1, Math.round(H));
  return c;
}

/* Soft round brush stamp onto a mask canvas — deliberately just brush+eraser (paint
   black/white/gray to hide/reveal, Shift-drag for a straight line handled by the caller like the
   main PaintEngine does), not the full paint-tool set: dodge/burn/clone/heal/etc. have no
   coherent meaning painting onto a grayscale visibility channel. `color` is white/black/gray hex;
   `erase` resets that stamp's area back to "untouched" (transparent) instead of painting black,
   so erasing a mask stroke truly undoes it rather than painting a second, opposite stroke on top. */
export function maskStamp(ctx, x, y, o, erase) {
  const r = Math.max(1, o.size / 2);
  // Canvas2D's own radial gradient degenerates to fully transparent everywhere when the inner and
  // outer radii are exactly equal — hardness 1 (a fully hard, no-falloff brush) would otherwise
  // paint nothing at all instead of a crisp hard-edged disc. Clamping just shy of 1 keeps an
  // imperceptibly thin falloff band instead, which reads as a hard edge but never degenerates.
  const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);
  ctx.save();
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
  const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
  const c = o.color || '#ffffff';
  g.addColorStop(0, erase ? 'rgba(0,0,0,1)' : hexToOpaqueRgba(c, 1));
  g.addColorStop(1, erase ? 'rgba(0,0,0,0)' : hexToOpaqueRgba(c, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function hexToOpaqueRgba(hex, a) {
  const c = (hex || '#ffffff').replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  const r = parseInt(n.slice(0, 2), 16) || 0, g = parseInt(n.slice(2, 4), 16) || 0, b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

/* Straight line between two points (Shift-drag), same radial-stamp density approach the main
   engine's _line() uses — stamp spacing scaled to brush size so a fast drag doesn't leave gaps. */
export function maskLine(ctx, from, to, o, erase) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, (o.size || 20) * 0.2);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    maskStamp(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, o, erase);
  }
}

/* Serialize a mask canvas to a dataURL for history/save (mirrors how paint layers round-trip
   through <img> src on restore) — null if the layer has no mask. */
export function serializeMask(o) {
  if (!o.maskCanvas) return null;
  try { return { dataURL: o.maskCanvas.toDataURL('image/png'), enabled: o.maskEnabled !== false }; }
  catch (e) { return null; }
}

/* Rehydrate a mask canvas from serializeMask()'s output — resolves once the mask image has
   loaded (drawn into a fresh same-size canvas), or immediately with null for no mask / a failed
   decode, so a caller can always `await` this uniformly. */
export function deserializeMask(spec, W, H) {
  if (!spec || !spec.dataURL) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = createMaskCanvas(W, H);
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      resolve({ canvas: c, enabled: spec.enabled !== false });
    };
    img.onerror = () => resolve(null);
    img.src = spec.dataURL;
  });
}
