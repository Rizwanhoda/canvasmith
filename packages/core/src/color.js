/* Colour utilities — pure functions, no DOM. */

export function hexRgb(hex) {
  let c = (hex || '#000').replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  return [parseInt(c.slice(0, 2), 16) || 0, parseInt(c.slice(2, 4), 16) || 0, parseInt(c.slice(4, 6), 16) || 0];
}

export function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function toHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/* WCAG relative luminance — lets a host pick readable ink on any accent colour. */
export function relLum([r, g, b]) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

/* HSL round-trip — the basis of lightness-preserving recolour: swap hue/saturation toward a
   target colour but KEEP each pixel's own lightness, so shading, folds and texture survive. */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

export function hexToHsl(hex) {
  return rgbToHsl(...hexRgb(hex));
}

/* Recolour RGBA pixels toward `hex`, keeping each pixel's lightness and scaling the target
   saturation by the pixel's own (so fabric/material variation survives the swap). Mutates and
   returns `data` in place — pass a copy if the caller still needs the original. Skips fully
   transparent pixels so a cutout's edge doesn't pick up a fringe of the new colour. */
export function recolorPixels(data, hex) {
  const tgt = hexToHsl(hex);
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const rgb = hslToRgb(tgt.h, tgt.s * (0.35 + 0.65 * hsl.s), hsl.l);
    data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b;
  }
  return data;
}

/* Normalizes a gradient stop list: sorts by offset, clamps each to [0,1], and guarantees at least
   2 stops exist (falls back to a default 2-color ramp) — the one piece of gradient-stop validation
   shared by both the raster paint-tool gradient (engine.js) and vector shape-fill gradients
   (shapes take a Fabric gradient object built from the same stop shape). */
export function normalizeGradientStops(stops) {
  const s = (Array.isArray(stops) && stops.length ? stops : [{ offset: 0, color: '#d4ff45' }, { offset: 1, color: '#7c3aed' }])
    .map(st => ({ offset: Math.max(0, Math.min(1, st.offset)), color: st.color }))
    .sort((a, b) => a.offset - b.offset);
  return s;
}

/* Defaults for non-destructive image adjustment (Editor#setImageFilters/getImageFilters). Human
   units: brightness/contrast/saturate are 100 = unchanged (50..150-ish range), blur is px (0 = none). */
export const FX_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, blur: 0 };

/* Pure mapping from human fx values to the Fabric Image.filters constructor args, so the mapping
   itself is testable without touching fabric. Mirrors the reference editor's setFx exactly:
   brightness/contrast/saturate are (v-100)/100, blur is v/20. Editor#setImageFilters turns this
   spec into real `new fabric.Image.filters.X(params)` instances. */
export function fxToFilterSpecs(fx) {
  const f = { ...FX_DEFAULTS, ...fx };
  return [
    { type: 'Brightness', params: { brightness: (f.brightness - 100) / 100 } },
    { type: 'Contrast', params: { contrast: (f.contrast - 100) / 100 } },
    { type: 'Saturation', params: { saturation: (f.saturate - 100) / 100 } },
    { type: 'Blur', params: { blur: f.blur / 20 } },
  ];
}
