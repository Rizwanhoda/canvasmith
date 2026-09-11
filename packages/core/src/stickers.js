/* Decorative sticker library — self-contained, recolorable vector shapes, generated from a small
   set of base outlines × a colour palette. Each sticker is added to the canvas as a plain
   fabric.Path (or fabric.Group for multi-path shapes) via addSticker() in editor.js, so it's a
   fully editable, recolorable, resizable layer like any other shape — not a baked raster image.

   General-purpose shape set (badges, ribbons, arrows, accents) rather than ad-copy badges — this
   library has no promotional text baked in, unlike the ad-generator reference it's modeled after. */

const starPts = (cx, cy, spikes, rOut, rIn) => {
  const p = []; let a = -Math.PI / 2; const s = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) { const r = i % 2 ? rIn : rOut; p.push((cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1)); a += s; }
  return p.join(' ');
};

/* Each factory returns an SVG path/points string (no fill attr — colour is applied by the caller
   via Fabric object props, so a placed sticker recolors like any other shape). `kind` picks which
   Fabric primitive to build: 'polygon' (points string) or 'path' (d string). */
const SHAPES = {
  circle: { kind: 'circle', cx: 50, cy: 50, r: 46 },
  pill: { kind: 'rect', x: 8, y: 32, w: 84, h: 36, rx: 18 },
  rrect: { kind: 'rect', x: 12, y: 22, w: 76, h: 56, rx: 10 },
  square: { kind: 'rect', x: 16, y: 16, w: 68, h: 68, rx: 6 },
  diamond: { kind: 'polygon', points: '50,6 94,50 50,94 6,50' },
  shield: { kind: 'path', d: 'M50,8 L86,20 V50 C86,74 68,88 50,94 C32,88 14,74 14,50 V20 Z' },
  star5: { kind: 'polygon', points: starPts(50, 52, 5, 46, 19) },
  star6: { kind: 'polygon', points: starPts(50, 50, 6, 46, 24) },
  sparkle: { kind: 'path', d: 'M50,6 C54,42 58,46 94,50 C58,54 54,58 50,94 C46,58 42,54 6,50 C42,46 46,42 50,6 Z' },
  heart: { kind: 'path', d: 'M50,84 C10,54 16,20 50,40 C84,20 90,54 50,84 Z' },
  bubble: { kind: 'path', d: 'M12,16 H88 a8,8 0 0 1 8,8 V60 a8,8 0 0 1 -8,8 H44 L28,84 V68 H12 a8,8 0 0 1 -8,-8 V24 a8,8 0 0 1 8,-8 Z' },
  plus: { kind: 'path', d: 'M42,10 H58 V42 H90 V58 H58 V90 H42 V58 H10 V42 H42 Z' },
  blob: { kind: 'path', d: 'M50,10 C74,10 92,26 90,50 C88,74 72,92 48,90 C26,88 10,70 12,46 C14,24 30,10 50,10 Z' },
  banner: { kind: 'path', d: 'M10,36 H90 L80,50 L90,64 H10 L20,50 Z' },
  pennant: { kind: 'path', d: 'M16,18 H84 V58 L50,44 L16,58 Z' },
  ribbon: { kind: 'path', d: 'M30,8 H70 V70 L50,56 L30,70 Z' },
  arrow: { kind: 'path', d: 'M14,42 H58 V30 L86,50 L58,70 V58 H14 Z' },
  arrowBlock: { kind: 'path', d: 'M10,38 H62 V26 L90,50 L62,74 V62 H10 Z' },
  chevron: { kind: 'path', d: 'M30,20 L60,50 L30,80 M52,20 L82,50 L52,80', stroke: true },
  arrowDouble: { kind: 'path', d: 'M18,50 L36,34 V44 H64 V34 L82,50 L64,66 V56 H36 V66 Z' },
  ring: { kind: 'path', d: 'M50,6 a44,44 0 1 1 -0.1,0 Z M50,26 a24,24 0 1 0 0.1,0 Z', fillRule: 'evenodd' },
};

/* [fill, contrast-ink] pairs — a sticker is created with the first palette entry's fill; the
   properties panel's Fill colour swatch (same one shapes use) recolors it afterward. */
export const STICKER_PALETTE = [
  '#ef6a2d', '#111114', '#2f6df0', '#f4c95d', '#1f9d6b', '#e0607a',
  '#7c3aed', '#ffffff', '#0c0c0e', '#2dd4bf',
];

export const STICKER_GROUPS = [
  { label: 'Badges & tags', keys: ['circle', 'pill', 'rrect', 'shield', 'diamond', 'square'] },
  { label: 'Ribbons & banners', keys: ['banner', 'pennant', 'ribbon'] },
  { label: 'Arrows', keys: ['arrow', 'arrowBlock', 'chevron', 'arrowDouble'] },
  { label: 'Accents', keys: ['star5', 'star6', 'sparkle', 'heart', 'bubble', 'plus', 'blob', 'ring'] },
];

export function stickerSpec(key) { return SHAPES[key]; }
