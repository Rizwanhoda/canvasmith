/* <CanvasmithEditor/> — the batteries-included UI over @canvasmith/core.
   Everything it does goes through the public Editor API, so anything you see here you can also
   build yourself against the core. Theme via the `theme` prop (CSS custom properties) layers on
   top of the built-in light/dark palettes, which the toolbar toggle switches between. */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Editor, ALL_TOOLS, PAINT_TOOLS, SEL_TOOLS, SHAPE_TOOLS, GeminiProvider, installBridge, installDropImport, installKeybindings, selectionPolys, selectionToPath2D, FONT_GROUPS, FONT_STYLESHEET_URL, STICKER_GROUPS, STICKER_PALETTE, stickerSpec, REGION_COLOR } from '@canvasmith/core';

const REGION_TYPE_LABELS = { product: 'Product', logo: 'Logo', text: 'Text', sticker: 'Sticker', decorative: 'Decorative' };
const CROP_RATIOS = [['Free', 0], ['Original', 'orig'], ['1:1', 1], ['4:5', 4 / 5], ['3:2', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16]];
/* Standard canvas-size presets, grouped by use-case — width/height in px at a nominal
   72-96dpi-ish "design pixel" scale (matches how every web design tool treats these, not
   print-accurate 300dpi). Ported verbatim from the vanilla demo's CANVAS_PRESETS. */
const CANVAS_PRESETS = [
  ['Social', [
    ['Instagram post (1:1)', 1080, 1080],
    ['Instagram story (9:16)', 1080, 1920],
    ['Facebook cover', 820, 312],
    ['Twitter/X post', 1200, 675],
    ['YouTube thumbnail', 1280, 720],
    ['LinkedIn banner', 1584, 396],
  ]],
  ['Print', [
    ['A4 portrait', 2480, 3508],
    ['A4 landscape', 3508, 2480],
    ['US Letter portrait', 2550, 3300],
    ['US Letter landscape', 3300, 2550],
  ]],
  ['Screen', [
    ['HD (720p)', 1280, 720],
    ['Full HD (1080p)', 1920, 1080],
    ['4K UHD', 3840, 2160],
  ]],
];

// Compact SVG glyphs for the tool rail — avoids pulling in an icon-font/library dependency.
const ICONS = {
  select: <path d="M4 3l7 16 2-6 6-2z" />,
  hand: <path d="M8 12V5a1.5 1.5 0 0 1 3 0v5m0-4a1.5 1.5 0 0 1 3 0v4m0-2a1.5 1.5 0 0 1 3 0v6m0-3a1.5 1.5 0 0 1 3 0v5c0 4-2 7-6 7h-2c-3 0-4-1-6-4l-2.5-4c-.6-1 .2-2.2 1.4-1.8L8 12" />,
  crop: <path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" />,
  brush: <path d="M9 15a3 3 0 1 0 4 4c1-1 1-2 0-3l6-6a2 2 0 0 0-3-3l-6 6c-1-1-2-1-3 0Z" />,
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />,
  eraser: <path d="M20 20H8l-5-5a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-8 8" />,
  clone: <path d="M8 8h11v11H8zM4 4h11v11" />,
  heal: <path d="M12 4v6m0 4v6M4 12h6m4 0h6" />,
  dodge: <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m14.4-6.4-1.4 1.4M7 17l-1.4 1.4M17 17l1.4 1.4M7 7 5.6 5.6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />,
  burn: <path d="M12 2c1 4-2 4-2 7a3 3 0 0 0 6 0c0-1-.5-2-1-3 2 1 4 4 4 7a7 7 0 1 1-14 0c0-5 4-7 7-11Z" />,
  sponge: <circle cx="12" cy="12" r="8" />,
  redeye: <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
  marquee: <rect x="3" y="5" width="18" height="14" rx="1" strokeDasharray="3 3" />,
  'marquee-ellipse': <ellipse cx="12" cy="12" rx="9" ry="7" strokeDasharray="3 3" />,
  lasso: <path d="M12 3c5 0 9 3 9 6 0 2.5-2.5 4.5-6 5.3.5 1 .3 2.2-.6 3a2.5 2.5 0 0 1-3.8-3.2C6 13.4 3 11.2 3 9c0-3 4-6 9-6Z" />,
  'lasso-poly': <path d="M12 3l8 6-3 9H7L4 9z" />,
  'lasso-mag': <path d="M6 18L16 8M14 4l1.5 1.5M19 7l1.5-1.5M18 12l2 .5M9 3l.5 2M20 17l-1.5 1.5" />,
  wand: <path d="m15 4 1.5 3L20 8.5 16.5 10 15 13l-1.5-3L10 8.5 13.5 7Z M5 21l8-8" />,
  spark: <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z" />,
  'objectselect-bbox': <path d="m15 4 1.5 3L20 8.5 16.5 10 15 13l-1.5-3L10 8.5 13.5 7Z M5 21l8-8" />,
  magicwand: <><path d="m15 4 1.5 3L20 8.5 16.5 10 15 13l-1.5-3L10 8.5 13.5 7Z M5 21l8-8" /><circle cx="5.5" cy="18.5" r="1" fill="currentColor" stroke="none" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.2c2.4 0 4.3-1.9 4.3-4.3C21.5 6.1 17.2 3 12 3Z" /><circle cx="7.5" cy="10.5" r="1.3" fill="currentColor" stroke="none" /><circle cx="11" cy="7" r="1.3" fill="currentColor" stroke="none" /><circle cx="15.5" cy="8" r="1.3" fill="currentColor" stroke="none" /></>,
  objectselect: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />,
  hoverselect: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  rect: <rect x="3" y="5" width="18" height="14" rx="2" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="7" />,
  line: <path d="M4 20 20 4" />,
  triangle: <path d="M12 3 22 20H2Z" />,
  polygon: <path d="m12 2 9 6.5-3.4 10.5H6.4L3 8.5Z" />,
  star: <path d="m12 2 3 6.5 7 .9-5 4.9 1.2 7-6.2-3.4-6.2 3.4L7 14.3l-5-4.9 7-.9Z" />,
  type: <path d="M5 5h14M12 5v14m-3 0h6" />,
  bucket: <path d="m10 3 9 9-8 8a3 3 0 0 1-4 0l-5-5a3 3 0 0 1 0-4Zm-6 10 9 9M17 4l3 3" />,
  gradient: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 4h18v16H3z" fill="url(#cm-grad-icon)" stroke="none" /></>,
  eyedropper: <path d="m11 8-6.5 6.5a2 2 0 0 0 0 2.8l.2.2a2 2 0 0 0 2.8 0L14 11m3-7 4 4-2.5 2.5-4-4Z" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-1" />,
  redo: <path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h1" />,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M6.5 6.7C4 8.3 2 12 2 12s4 7 10 7c2 0 3.7-.6 5-1.4M9.9 5.1A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a15.3 15.3 0 0 1-2.2 3" />,
  up: <path d="M18 15 12 9l-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />,
  duplicate: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V6a2 2 0 0 1 2-2h10" /></>,
  chevron: <path d="M15 18 9 12l6-6" />,
  tool: <path d="M4 21v-6M4 9V3M12 21v-8M12 9V3M20 21v-4M20 13V3M2 15h4M8 9h8M18 17h4" />,
  layers: <><path d="m12 2 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  box: <path d="M3 8l9-5 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8" />,
  grid: <><path d="M4 4h7v7H4z" /><path d="M13 4h7v7h-7z" /><path d="M13 13h7v7h-7z" /><path d="M4 13h7v7H4z" /></>,
  flip: <path d="M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4" />,
  move: <path d="M12 4v16M4 12h16M9 7l3-3 3 3M9 17l3 3 3-3M7 9l-3 3 3 3M17 9l3 3-3 3" />,
  contrast: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /></>,
  mask: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /></>,
  droplet: <path d="M12 3s6 5.7 6 10a6 6 0 0 1-12 0c0-4.3 6-10 6-10z" />,
  blurfilter: <path d="M4 5h16l-6 8v5l-4 2v-7L4 5z" />,
  chevronD: <path d="M6 9l6 6 6-6" />,
  expand: <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />,
  contract: <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />,
  similar: <><circle cx="7" cy="7" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="7" cy="17" r="3" /><circle cx="17" cy="17" r="3" /></>,
  hue: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" /></>,
  vibrance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3m0 14v3m10-9h-3M5 12H2m15.5-6.5-2.1 2.1M8.6 15.4l-2.1 2.1m11 0-2.1-2.1M8.6 8.6 6.5 6.5" /></>,
  invert: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none" /></>,
  'align-left': <><path d="M3 2v20" /><rect x="6" y="6" width="7" height="4" rx="1" fill="currentColor" stroke="none" /><rect x="6" y="14" width="12" height="4" rx="1" fill="currentColor" stroke="none" /></>,
  'align-h-center': <><path d="M12 2v20" /><rect x="8.5" y="6" width="7" height="4" rx="1" fill="currentColor" stroke="none" /><rect x="6" y="14" width="12" height="4" rx="1" fill="currentColor" stroke="none" /></>,
  'align-right': <><path d="M21 2v20" /><rect x="11" y="6" width="7" height="4" rx="1" fill="currentColor" stroke="none" /><rect x="6" y="14" width="12" height="4" rx="1" fill="currentColor" stroke="none" /></>,
  'align-top': <><path d="M2 3h20" /><rect x="6" y="6" width="4" height="7" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="6" width="4" height="12" rx="1" fill="currentColor" stroke="none" /></>,
  'align-v-center': <><path d="M2 12h20" /><rect x="6" y="8.5" width="4" height="7" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="6" width="4" height="12" rx="1" fill="currentColor" stroke="none" /></>,
  'align-bottom': <><path d="M2 21h20" /><rect x="6" y="11" width="4" height="7" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="6" width="4" height="12" rx="1" fill="currentColor" stroke="none" /></>,
  pen: <path d="M12 3l7 7-9 9-5 1 1-5 6-6 2 2M11 6l4 4" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></>,
};

function Icon({ name, size = 15, style }) {
  const glyph = ICONS[name];
  if (!glyph) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      {glyph}
    </svg>
  );
}

/* Renders a stickers.js shape spec (same 0-100 coordinate space addSticker() builds from) as a
   small preview SVG for the Stickers grid — one rendering path shared with the real Fabric object
   addSticker() places, so the preview always matches what clicking it actually adds. */
function StickerPreview({ shapeKey, size = 28 }) {
  const spec = stickerSpec(shapeKey);
  if (!spec) return null;
  const fill = STICKER_PALETTE[0];
  let shape = null;
  if (spec.kind === 'circle') shape = <circle cx={spec.cx} cy={spec.cy} r={spec.r} fill={fill} />;
  else if (spec.kind === 'rect') shape = <rect x={spec.x} y={spec.y} width={spec.w} height={spec.h} rx={spec.rx} fill={fill} />;
  else if (spec.kind === 'polygon') shape = <polygon points={spec.points} fill={fill} />;
  else if (spec.kind === 'path') shape = <path d={spec.d} fill={spec.stroke ? 'none' : fill} stroke={spec.stroke ? fill : 'none'} strokeWidth={spec.stroke ? 10 : 0} fillRule={spec.fillRule || 'nonzero'} />;
  return <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">{shape}</svg>;
}

const GROUPS = [
  { label: 'Move', tools: [['select', 'Select'], ['hand', 'Pan'], ['crop', 'Crop']] },
  { label: 'Paint', tools: [['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser'], ['clone', 'Clone'], ['heal', 'Heal'], ['dodge', 'Dodge'], ['burn', 'Burn'], ['sponge', 'Sponge'], ['redeye', 'Red-eye']] },
  { label: 'Select', tools: [['marquee', 'Marquee'], ['marquee-ellipse', 'Ellipse'], ['lasso', 'Lasso'], ['lasso-poly', 'Polygon lasso'], ['lasso-mag', 'Magnetic lasso'], ['wand', 'Wand'], ['objectselect-bbox', 'Object / magic select'], ['magicwand', 'Magic wand'], ['objectselect', 'Object select'], ['hoverselect', 'Hover select']] },
  { label: 'AI', tools: [['aiinsert', 'AI insert']] },
  { label: 'Draw', tools: [['rect', 'Rect'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['triangle', 'Triangle'], ['polygon', 'Polygon'], ['star', 'Star'], ['pen', 'Pen'], ['type', 'Text'], ['bucket', 'Fill'], ['gradient', 'Gradient'], ['eyedropper', 'Pick']] },
];

const BLEND_MODES = [
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Dodge'], ['color-burn', 'Burn'],
  ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'],
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];

const SEL_REASON_MSG = {
  cv_unavailable: 'Needs the OpenCV worker (no internet / blocked CDN).',
  no_selection: 'Make a selection first.',
  no_seed: 'Use the wand or object-select tool first, then Select similar.',
  no_match: 'No matching region found.',
  need_multi_selection: 'Shift-click 2+ layers on the canvas to group them.',
  need_group: 'Select a group to ungroup.',
};

const AI_REASON_MSG = {
  no_provider: 'No AI provider is registered.',
  rate_limited: 'Free daily quota hit — try again later, or add billing to your key.',
  no_regions: 'Nothing detected — try "Select one object manually" instead.',
  destroyed: '',
};

const EMPTY_PROPS = {
  active: false, title: 'Properties', isImage: false, isAdjustment: false, fx: { brightness: 100, contrast: 100, saturate: 100, blur: 0, hue: 0, vibrance: 0, invert: false },
  text: null,
  hasFill: false, fill: '#ef6a2d', shapeGradient: null, blend: 'source-over', opacity: 1,
  hasBorder: false, strokeWidth: 0, stroke: '#000000',
  angle: 0, x: '', y: '', w: '', h: '', skewX: 0, skewY: 0, isRect: false, rx: 0,
  shadow: { color: '#000000', blur: 0, offsetX: 0, offsetY: 0 },
  canGroup: false, canUngroup: false, hasSelectionPixels: false,
};

/* Reads every field the Properties panel shows off the current fabric active object — the React
   mirror of the vanilla demo's refreshPropsPanel(), so both UIs present the exact same state.
   hasSelectionPixels tracks ed.selection (a marquee/lasso/wand pixel selection), which is an
   entirely separate concept from the fabric active OBJECT the rest of this function reads — a
   pixel selection has no active object at all, so it must be read before the early return below,
   not folded into the object-only branch (an object-selection UI can be "nothing selected" while
   a pixel selection is very much active, and vice versa). */
function readProps(ed) {
  const o = ed.fc.getActiveObject();
  if (!o) return { ...EMPTY_PROPS, hasSelectionPixels: !!ed.selection };
  const isImage = o.type === 'image';
  const isAdjustment = o.role === 'adjustment';
  const fillTarget = o.type === 'activeSelection' ? o.getObjects()[0] : o;
  const solidFill = !!fillTarget && typeof fillTarget.fill === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(fillTarget.fill);
  const shapeGradient = ed.getShapeGradient();
  const hasFill = !!fillTarget && !isImage && fillTarget.type !== 'line' && fillTarget.role !== 'paint' && (solidFill || !!shapeGradient);
  const fill = solidFill ? (fillTarget.fill.length === 4 ? '#' + [...fillTarget.fill.slice(1)].map(c => c + c).join('') : fillTarget.fill) : '#ef6a2d';
  // Border (stroke) applies to any fillable/strokeable vector shape or line — not images or paint
  // strokes — same hasBorder condition as the vanilla demo's refreshPropsPanel.
  const hasBorder = !!fillTarget && !isImage && fillTarget.role !== 'paint';
  const strokeColor = fillTarget && typeof fillTarget.stroke === 'string'
    ? (fillTarget.stroke.length === 4 ? '#' + [...fillTarget.stroke.slice(1)].map(c => c + c).join('') : fillTarget.stroke)
    : '#000000';
  return {
    active: true,
    title: o.type === 'activeSelection' ? (o._objects ? o._objects.length + ' layers' : 'Selection') : (ed.layers().find(l => l.active)?.name || o.type || 'Layer'),
    isImage, isAdjustment,
    fx: isAdjustment ? ed.getAdjustmentParams(o.id) : isImage ? ed.getImageFilters() : EMPTY_PROPS.fx,
    text: ed.getTextProps(),
    hasFill, fill, shapeGradient,
    hasBorder, strokeWidth: Math.round((fillTarget && fillTarget.strokeWidth) || 0), stroke: strokeColor,
    blend: o.globalCompositeOperation || 'source-over',
    opacity: o.opacity != null ? o.opacity : 1,
    angle: Math.round(o.angle || 0),
    x: Math.round(o.left || 0), y: Math.round(o.top || 0),
    w: Math.round(o.getScaledWidth ? o.getScaledWidth() : (o.width || 0)),
    h: Math.round(o.getScaledHeight ? o.getScaledHeight() : (o.height || 0)),
    skewX: Math.round(o.skewX || 0), skewY: Math.round(o.skewY || 0),
    isRect: o.type === 'rect', rx: Math.round(o.rx || 0),
    shadow: {
      color: (o.shadow && o.shadow.color) || '#000000',
      blur: (o.shadow && o.shadow.blur) || 0,
      offsetX: (o.shadow && o.shadow.offsetX) || 0,
      offsetY: (o.shadow && o.shadow.offsetY) || 0,
    },
    canGroup: o.type === 'activeSelection',
    canUngroup: o.type === 'group',
    hasSelectionPixels: !!ed.selection,
  };
}

const THEMES = {
  dark: { bg: '#0b0b0d', panel: '#141417', line: 'rgba(255,255,255,.07)', ink: '#f5f3ee', dim: '#aeaca4', accent: '#ef6a2d', accentInk: '#fff', stage: '#0a0a0c' },
  light: { bg: '#f3efe7', panel: '#ffffff', line: 'rgba(30,26,18,.09)', ink: '#1c1913', dim: '#5e594f', accent: '#c85a24', accentInk: '#fff', stage: '#ece7dd' },
};

const CSS = `
.cm-root{--cm-bg:#0b0b0d;--cm-panel:#141417;--cm-line:rgba(255,255,255,.07);--cm-ink:#f5f3ee;--cm-dim:#aeaca4;--cm-accent:#ef6a2d;--cm-accent-ink:#fff;--cm-stage:#0a0a0c;
  display:grid;grid-template-columns:52px 220px 1fr 290px;grid-template-rows:44px 1fr;height:100%;min-height:480px;
  background:var(--cm-bg);color:var(--cm-ink);font:13px/1.45 "Hanken Grotesk",system-ui,sans-serif;position:relative}
.cm-root[data-left-collapsed=true]{grid-template-columns:52px 0px 1fr 290px}
.cm-root[data-side-collapsed=true]{grid-template-columns:52px 220px 1fr 0px}
.cm-root[data-left-collapsed=true][data-side-collapsed=true]{grid-template-columns:52px 0px 1fr 0px}
.cm-top{grid-column:1/5;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--cm-line);background:var(--cm-panel)}
.cm-rail{display:flex;flex-direction:column;gap:2px;padding:6px 4px;border-right:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto}
.cm-rail button{all:unset;cursor:pointer;text-align:center;display:flex;align-items:center;justify-content:center;padding:9px 0;border-radius:7px;color:var(--cm-dim)}
.cm-rail button:hover{background:var(--cm-bg);color:var(--cm-ink)}
.cm-rail button[data-on=true]{background:var(--cm-accent);color:var(--cm-accent-ink)}
.cm-rail .cm-grp{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--cm-dim);text-align:center;margin-top:8px}
.cm-stage{position:relative;overflow:hidden;display:grid;place-items:center;background:var(--cm-stage)}
.cm-left{border-right:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto;overflow-x:hidden;padding:18px;transition:padding .15s}
.cm-root[data-left-collapsed=true] .cm-left{padding:0;width:0}
.cm-side{border-left:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto;overflow-x:hidden;padding:18px;transition:padding .15s}
.cm-root[data-side-collapsed=true] .cm-side{padding:0;width:0}
.cm-left h4, .cm-side h4{margin:8px 0 6px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cm-dim)}
.cm-tabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px}
.cm-tabs button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:8px;font-size:12px;font-weight:600;color:var(--cm-dim);white-space:nowrap}
.cm-tabs button:hover{background:var(--cm-bg)}
.cm-tabs button[data-on=true]{background:var(--cm-bg);color:var(--cm-ink)}
.cm-collapse-left{position:absolute;top:50%;left:272px;transform:translateY(-50%);width:22px;height:36px;border-radius:8px;
  border:1px solid var(--cm-line);background:var(--cm-panel);color:var(--cm-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;transition:left .15s}
.cm-root[data-left-collapsed=true] .cm-collapse-left{left:52px}
.cm-collapse-left:hover{color:var(--cm-ink);border-color:var(--cm-accent)}
.cm-collapse-left[data-flip=true] svg{transform:rotate(180deg)}
.cm-collapse{position:absolute;top:50%;right:289px;transform:translateY(-50%);width:22px;height:36px;border-radius:8px;
  border:1px solid var(--cm-line);background:var(--cm-panel);color:var(--cm-dim);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;transition:right .15s}
.cm-root[data-side-collapsed=true] .cm-collapse{right:0}
.cm-collapse:hover{color:var(--cm-ink);border-color:var(--cm-accent)}
.cm-collapse[data-flip=true] svg{transform:rotate(180deg)}
.cm-align{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:10px 0}
.cm-align button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;height:28px;border-radius:7px;border:1px solid var(--cm-line);font-size:11px;color:var(--cm-ink)}
.cm-align button:hover{border-color:var(--cm-accent)}
.cm-toggle{all:unset;cursor:pointer;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--cm-line);color:var(--cm-dim)}
.cm-toggle[data-on=true]{background:var(--cm-ink);color:var(--cm-panel);border-color:var(--cm-ink)}
.cm-layer{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:12px}
.cm-layer:hover{background:var(--cm-bg)}.cm-layer[data-on=true]{outline:1px solid var(--cm-accent)}
.cm-layer[data-dragover=true]{background:color-mix(in srgb,var(--cm-accent) 16%,var(--cm-panel));box-shadow:inset 0 0 0 1px dashed var(--cm-accent),inset 0 0 0 1px var(--cm-accent)}
.cm-layer[data-dragging=true]{opacity:.4}
.cm-layer .cm-eye{cursor:pointer;opacity:.7;display:flex}
.cm-layer-thumb{flex:none;width:28px;height:28px;border-radius:6px;overflow:hidden;display:grid;place-items:center;background:var(--cm-bg);border:1px solid var(--cm-line)}
.cm-layer[data-on=true] .cm-layer-thumb{border-color:color-mix(in srgb,var(--cm-accent) 60%,var(--cm-line))}
.cm-layer-thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block;pointer-events:none}
.cm-layer-thumb svg{color:var(--cm-dim)}
.cm-layer-rename{all:unset;box-sizing:border-box;width:100%;font-size:12px;font-weight:600;padding:2px 5px;border-radius:5px;background:var(--cm-bg);border:1px solid var(--cm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 22%,transparent);color:var(--cm-ink)}
.cm-asset-thumb{flex:none;width:56px;cursor:pointer;text-align:center}
.cm-asset-thumb img{width:56px;height:56px;object-fit:cover;border-radius:9px;border:1px solid var(--cm-line);display:block;transition:border-color .1s;pointer-events:none}
.cm-asset-thumb span{display:block;font-size:10px;color:var(--cm-dim);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-asset-thumb:hover img{border-color:var(--cm-dim)}
.cm-btn{all:unset;cursor:pointer;padding:8px 12px;border-radius:9px;border:1px solid var(--cm-line);font-size:13px;display:inline-flex;align-items:center;gap:7px}
.cm-btn:hover{border-color:var(--cm-accent)}.cm-btn:disabled{opacity:.4;cursor:default}
.cm-icon-btn{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid var(--cm-line);color:var(--cm-ink)}
.cm-icon-btn:hover{border-color:var(--cm-accent)}
.cm-icon-btn[data-active=true]{background:var(--cm-accent);color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-top input[type=range]{width:90px}.cm-top input[type=color]{width:26px;height:26px;border:none;background:none;cursor:pointer}
.cm-zoom-pill{display:flex;align-items:center;gap:2px;padding:2px;border-radius:999px;background:var(--cm-bg);border:1px solid var(--cm-line)}
.cm-cmdk-backdrop{position:fixed;inset:0;z-index:200;background:rgba(8,8,12,.5);display:flex;align-items:flex-start;justify-content:center;padding-top:14vh}
.cm-cmdk-box{width:min(560px,92vw);max-height:min(60vh,420px);background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column}
.cm-cmdk-search-row{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--cm-line);flex:none;color:var(--cm-dim)}
.cm-cmdk-input{all:unset;box-sizing:border-box;flex:1;font-size:14px;color:var(--cm-ink)}
.cm-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:6px;background:var(--cm-bg);color:var(--cm-dim);font-size:10px;font-weight:600}
.cm-tag.mono{font-family:"JetBrains Mono",ui-monospace,monospace}
.cm-cmdk-list{overflow-y:auto;padding:6px;flex:1}
.cm-cmdk-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;color:var(--cm-dim)}
.cm-cmdk-item[data-on=true]{background:var(--cm-bg);color:var(--cm-accent)}
.cm-cmdk-item .lbl{flex:1;color:var(--cm-ink)}
.cm-cmdk-item[data-on=true] .lbl{color:var(--cm-ink)}
.cm-cmdk-item .grp{font-size:10.5px;color:var(--cm-dim)}
.cm-cmdk-empty{padding:16px;text-align:center;font-size:12.5px;color:var(--cm-dim)}
.cm-compare-backdrop{position:fixed;inset:0;z-index:200;background:rgba(12,12,14,.95);backdrop-filter:blur(10px);display:flex;flex-direction:column}
.cm-compare-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 28px;flex:none}
.cm-compare-header strong{font-size:16px;color:var(--cm-ink)}
.cm-compare-header p{font-size:13px;color:var(--cm-dim);margin:4px 0 0}
.cm-compare-panes{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 28px 28px;min-height:0}
.cm-compare-pane{position:relative;display:grid;place-items:center;background:var(--cm-stage);border:1px solid var(--cm-line);border-radius:12px;overflow:hidden;min-height:0}
.cm-compare-pane img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
.cm-compare-label{position:absolute;top:14px;left:14px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:999px;padding:4px 11px;font-size:11px;font-weight:600;color:var(--cm-dim)}
@media (max-width:640px){.cm-compare-panes{grid-template-columns:1fr;overflow-y:auto}}
.cm-extend-banner{all:unset;position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:16;display:flex;align-items:center;gap:7px;background:var(--cm-accent);color:var(--cm-accent-ink);border-radius:999px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.cm-extend-banner:hover{filter:brightness(1.06)}
.cm-ai{display:flex;gap:6px;margin-top:6px}.cm-ai input{flex:1;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;color:var(--cm-ink);padding:5px 8px;font-size:12px}
.cm-note{font-size:11px;color:var(--cm-dim);margin-top:6px;line-height:1.5}
.cm-ai-card{padding:14px;border-radius:16px;border:1px solid var(--cm-line);background:linear-gradient(160deg,color-mix(in srgb,var(--cm-accent) 16%,transparent),var(--cm-bg));margin-bottom:14px}
.cm-ai-card-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;margin-bottom:8px}
.cm-ai-card p{margin:0;font-size:11.5px;color:var(--cm-dim);line-height:1.5}
.cm-ai-textarea{width:100%;box-sizing:border-box;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:12px;color:var(--cm-ink);padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical}
.cm-btn-accent{background:var(--cm-accent);color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-btn-accent:hover{opacity:.92;border-color:var(--cm-accent)}
.cm-ai-suggestions{display:flex;flex-direction:column;gap:6px}
.cm-chip{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;border:1px solid var(--cm-line);font-size:12.5px;font-weight:500;color:var(--cm-ink)}
.cm-chip:hover{border-color:var(--cm-accent)}
.cm-chip[data-on=true]{background:var(--cm-accent);color:var(--cm-accent-ink);border-color:var(--cm-accent);font-weight:600}
.cm-review-overlay{position:absolute;inset:0;z-index:5}
/* Per-type border/fill color comes from REGION_COLOR (editor.js) via an inline style on each box
   below — not a CSS[data-type=] rule — so the 5 region types share one color source with
   commitRegions' own REGION_ROLE mapping instead of duplicating the palette here. */
.cm-review-box{position:absolute;border:2px dashed;border-radius:5px;cursor:move;box-sizing:border-box}
.cm-review-tag{position:absolute;top:-24px;left:-2px;display:flex;align-items:center;gap:4px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:6px;padding:2px 4px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.cm-review-tag select{all:unset;font-size:10.5px;font-weight:600;color:var(--cm-ink);cursor:pointer;padding:1px 3px}
.cm-review-tag button{all:unset;box-sizing:border-box;cursor:pointer;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--cm-dim)}
.cm-review-tag button:hover{background:var(--cm-bg);color:#e0607a}
.cm-review-handle{position:absolute;width:9px;height:9px;background:var(--cm-accent);border:1.5px solid var(--cm-panel);border-radius:50%;right:-5px;bottom:-5px;cursor:nwse-resize}
.cm-review-toolbar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:8px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:12px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.cm-review-sep{width:1px;height:20px;background:var(--cm-line)}
.cm-grp{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--cm-dim);margin:16px 0 6px;padding-top:12px;border-top:1px solid var(--cm-line)}
.cm-grp:first-child{margin-top:0;padding-top:0;border-top:none}
.cm-field-grid{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.cm-field{flex:1;min-width:60px;display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--cm-dim)}
.cm-field input{width:100%;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;color:var(--cm-ink);padding:6px 8px;font-size:12px;font-family:inherit;box-sizing:border-box}
.cm-slider-row{display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--cm-dim);margin-top:6px}
.cm-slider-row input[type=range]{flex:1;width:auto}
.cm-select{width:100%;background:var(--cm-bg);color:var(--cm-ink);border:1px solid var(--cm-line);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit}
.cm-row{display:flex;gap:6px}
.cm-row .cm-btn{flex:1;justify-content:center}
.cm-btn:disabled, .cm-icon-btn:disabled{opacity:.4;cursor:default;pointer-events:none}
input[type=range]:disabled{accent-color:var(--cm-dim)}
`;

export function CanvasmithEditor({ fabric, width = 1080, height = 1080, image = null, ai = 'gemini', theme = {}, mode, bridge = true, openCvUrl, onReady, onExport }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const edRef = useRef(null);
  const [tool, setTool] = useState('select');
  const [opts, setOpts] = useState({ size: 30, opacity: 1, color: '#ef6a2d', tolerance: 32, addMode: false, gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }], cropRatio: 0 });
  const [layers, setLayers] = useState([]);
  // Layer-panel thumbnails: generated on demand from the fabric object itself (toDataURL at a
  // small multiplier), cached per layer id and invalidated on every scene change — same
  // version-keyed cache contract as the vanilla demo's layerThumb/_thumbVer, since the headless
  // Editor's layers() API is deliberately thumbnail-free (DOM/canvas rendering is a host concern).
  const thumbCacheRef = useRef(new Map());
  const thumbVerRef = useRef(0);
  const [renamingId, setRenamingId] = useState(null);
  const [dragLayerId, setDragLayerId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const lastLayerClickRef = useRef(null);
  // Compare: snapshot the canvas the first time it's ever committed to (i.e. right after the
  // first image/element lands), then let the user flip back to that snapshot vs. the live render
  // at any point — canvasmith has no fixed "original ad template" the way the reference does, so
  // "first meaningful state" is the closest general equivalent. Ports the vanilla demo's Compare
  // view exactly. The snapshot lives in a ref (not state) so capturing it inside the 'change'
  // handler below doesn't itself trigger a re-render loop.
  const compareSnapshotRef = useRef(null);
  const [compareReady, setCompareReady] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareAfter, setCompareAfter] = useState(null);
  // Asset tray: every image source successfully added to the document this session (opened,
  // dropped/pasted, picked via the file input, or handed in via the bridge/postMessage import) —
  // click or drag one back onto the canvas to insert it again. Session-only by design (no
  // localStorage persistence): a generic library has no "generated ad" / "product photo" asset
  // taxonomy of its own the way a specific ad-generation product would, so this tracks exactly
  // what the user has actually brought into THIS document rather than inventing categories.
  // Deduped by src so re-adding the same image doesn't grow the tray forever.
  const [assets, setAssets] = useState([]);
  const trackAsset = useCallback((src, name) => {
    setAssets(prev => prev.some(a => a.src === src) ? prev : [...prev, { id: 'asset' + Date.now() + Math.random().toString(36).slice(2, 6), src, name: name || 'Image' }]);
  }, []);
  // Only intercept our own asset drag payload — an unrelated drag (a real OS file, which
  // installDropImport already handles) must fall through untouched, same guard the vanilla
  // demo's onStageDragOver uses.
  const onStageDragOver = (e) => { if (e.dataTransfer.types.includes('text/x-canvasmith-asset')) e.preventDefault(); };
  const onStageDrop = (e) => {
    const src = e.dataTransfer.getData('text/x-canvasmith-asset');
    if (!src) return;
    e.preventDefault();
    // fc.getPointer reads clientX/clientY straight off the event and maps them through fabric's
    // own upper-canvas offset + viewport transform — same conversion _pt(opt) uses in editor.js,
    // so this lands exactly where a real click at this screen position would.
    const scenePt = ed().fc.getPointer(e);
    ed().addImage(src, { name: 'Image' }).then(img => {
      if (!img) return;
      img.set({ left: scenePt.x, top: scenePt.y, originX: 'center', originY: 'center' });
      img.setCoords();
      ed().fc.renderAll();
      ed().commit('image');
    });
  };
  const [maskEdit, setMaskEdit] = useState(null);
  const [hist, setHist] = useState({ past: 1, future: 0 });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [needKey, setNeedKey] = useState(false);
  const [mode_, setMode] = useState(mode || 'dark');
  const [sideTab, setSideTab] = useState('layer');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [leftTab, setLeftTab] = useState('tool');
  const [snapOn, setSnapOn] = useState(true);
  const [props, setProps] = useState(EMPTY_PROPS);
  const [selMsg, setSelMsg] = useState('');
  // AI insert-at-point: {pt (scene px), region, prompt, busy, msg} | null — opened by the
  // aiinsert tool's click (see Editor#_down's 'aiinsert' emit), closed on submit/cancel/tool-switch.
  const [aiInsert, setAiInsert] = useState(null);
  // Object/hover-select live status: how many polygons are in ed.selection right now (0/1/2+,
  // matching ditto's multiCount), plus a rough busy flag for the async wand/grabCut round-trip —
  // wandPick/_hoverMove don't emit their own busy/idle event, so this approximates it the same way
  // the vanilla demo does: busy from mouse:down until the next selection/hover/error settles it.
  const [selCount, setSelCount] = useState(0);
  const [objselectBusy, setObjselectBusy] = useState(false);

  useEffect(() => {
    // Google Fonts stylesheet for the typography panel's non-system fonts — added once even if
    // several <CanvasmithEditor/> instances mount on the same page (a data attribute marks it,
    // since two <link>s pointed at the same href would just be redundant, not harmful, but there's
    // no reason to fetch it twice). Never removed on unmount — a loaded @font-face should stay
    // available for any other editor instance still on the page.
    if (typeof document !== 'undefined' && !document.querySelector('link[data-cm-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = FONT_STYLESHEET_URL; link.dataset.cmFonts = 'true';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    const f = fabric || (typeof window !== 'undefined' && window.fabric);
    const ed = new Editor({ fabric: f, canvasEl: canvasRef.current, width, height, openCvUrl });
    edRef.current = ed;
    // Overlay chrome: marching-ants selection outline, crop scrim/thirds/handles/dimension
    // readout, hover-select preview, pen in-progress path, and Figma-style smart guides while
    // dragging — all drawn on fabric's shared top context, so this must redraw fabric's own top
    // layer (marquee box / control handles) first, since clearContext wipes contextTop wholesale.
    // Ports the vanilla demo's drawOverlays exactly (its own header comment calls it "the
    // reference implementation other UIs can copy") — kept pixel-for-pixel identical rather than
    // reinvented, so the two shells read as the same editor.
    let dragGuides = null, hoverPreview = null, penBuild = null;
    let antsOffset = 0, antsRunning = false;
    const startAntsLoopIfNeeded = () => {
      if (antsRunning || !ed.selection) return;
      antsRunning = true;
      const step = () => {
        if (!ed.selection) { antsRunning = false; return; }
        antsOffset = (antsOffset + 0.4) % 12;
        ed.fc.requestRenderAll();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const drawOverlays = () => {
      const ctx = ed.fc.contextTop; if (!ctx) return;
      ed.fc.clearContext(ctx);
      ed.fc.renderTopLayer(ctx);
      const v = ed.fc.viewportTransform;
      ctx.save(); ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
      if (ed.selection) {
        const p = selectionToPath2D(ed.selection, ed.W, ed.H);
        ctx.lineWidth = 1.6 / v[0];
        ctx.setLineDash([7 / v[0], 5 / v[0]]);
        ctx.lineDashOffset = -antsOffset / v[0];
        ctx.strokeStyle = '#ef6a2d'; ctx.stroke(p);
        ctx.lineDashOffset = (6 - antsOffset) / v[0]; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke(p);
        ctx.setLineDash([]);
        const s = ed.selection;
        if ((s.kind === 'rect' || s.kind === 'ellipse') && (ed.tool === 'marquee' || ed.tool === 'marquee-ellipse')) {
          const hs = 4.5 / v[0]; ctx.fillStyle = '#ef6a2d'; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 1 / v[0];
          for (const [hx, hy] of [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h],
                                  [s.x + s.w / 2, s.y], [s.x + s.w / 2, s.y + s.h], [s.x, s.y + s.h / 2], [s.x + s.w, s.y + s.h / 2]]) {
            ctx.beginPath(); ctx.arc(hx, hy, hs, 0, 7); ctx.fill(); ctx.stroke();
          }
        }
      }
      if (hoverPreview) {
        const p = selectionToPath2D({ kind: 'poly', pts: hoverPreview.pts }, ed.W, ed.H);
        ctx.lineWidth = 1.2 / v[0];
        ctx.setLineDash([4 / v[0], 3 / v[0]]);
        ctx.strokeStyle = 'rgba(239,106,45,.65)'; ctx.stroke(p);
        ctx.setLineDash([]);
      }
      if (ed.crop) {
        const c = ed.crop;
        ctx.fillStyle = 'rgba(0,0,0,0.48)';
        ctx.beginPath(); ctx.rect(0, 0, ed.W, ed.H); ctx.rect(c.x, c.y, c.w, c.h); ctx.fill('evenodd');
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4 / v[0]; ctx.strokeRect(c.x, c.y, c.w, c.h);
        ctx.lineWidth = 0.7 / v[0]; ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        for (let i = 1; i < 3; i++) {
          ctx.beginPath(); ctx.moveTo(c.x + c.w * i / 3, c.y); ctx.lineTo(c.x + c.w * i / 3, c.y + c.h); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c.x, c.y + c.h * i / 3); ctx.lineTo(c.x + c.w, c.y + c.h * i / 3); ctx.stroke();
        }
        const hs = 5.5 / v[0]; ctx.fillStyle = '#ef6a2d';
        for (const [hx, hy] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h],
                                [c.x + c.w / 2, c.y], [c.x + c.w / 2, c.y + c.h], [c.x, c.y + c.h / 2], [c.x + c.w, c.y + c.h / 2]])
          ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        const label = Math.round(c.w) + ' × ' + Math.round(c.h);
        const fs = 12 / v[0], pad = 6 / v[0];
        ctx.font = fs + 'px "JetBrains Mono", ui-monospace, monospace';
        const tw = ctx.measureText(label).width;
        const lx = c.x + c.w / 2, ly = c.y - pad * 2 - fs / 2;
        ctx.fillStyle = 'rgba(20,20,23,.92)';
        ctx.beginPath(); ctx.roundRect(lx - tw / 2 - pad, ly - fs / 2 - pad * 0.6, tw + pad * 2, fs + pad * 1.2, pad);
        ctx.fill();
        ctx.fillStyle = '#f1efe9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, lx, ly);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      if (dragGuides) {
        ctx.strokeStyle = '#ff2fc0'; ctx.lineWidth = 1 / v[0]; ctx.setLineDash([]);
        if (dragGuides.x) { ctx.beginPath(); ctx.moveTo(dragGuides.x.x, dragGuides.x.y0); ctx.lineTo(dragGuides.x.x, dragGuides.x.y1); ctx.stroke(); }
        if (dragGuides.y) { ctx.beginPath(); ctx.moveTo(dragGuides.y.x0, dragGuides.y.y); ctx.lineTo(dragGuides.y.x1, dragGuides.y.y); ctx.stroke(); }
      }
      if (penBuild && penBuild.pts.length) {
        ctx.strokeStyle = '#ef6a2d'; ctx.lineWidth = 1.4 / v[0]; ctx.setLineDash([]);
        ctx.beginPath();
        penBuild.pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        const r = 3.5 / v[0];
        penBuild.pts.forEach((p, i) => {
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7);
          if (i === 0) { ctx.fillStyle = '#ef6a2d'; ctx.fill(); } else { ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#ef6a2d'; ctx.lineWidth = 1.2 / v[0]; ctx.stroke(); }
        });
      }
      ctx.restore();
    };
    ed.fc.on('after:render', drawOverlays);
    // Fabric's own click-to-select (no edit made) doesn't go through commit()/activate(), so
    // 'change' alone misses it — without these, layers() (and activeLayer/Fill below) stay stale
    // after a plain click on the canvas.
    const refreshLayers = () => setLayers(ed.layers());
    // Same refresh contract as the vanilla demo's refreshPropsPanel: 'selection'/'change' cover
    // activation and edits committed to history; the raw fabric object:moving/scaling/rotating
    // events keep X/Y/W/H/angle live while a drag is still in progress (before object:modified).
    const refreshProps = () => setProps(readProps(ed));
    ed.fc.on('selection:created', refreshLayers);
    ed.fc.on('selection:updated', refreshLayers);
    ed.fc.on('selection:cleared', refreshLayers);
    ed.fc.on('selection:created', refreshProps);
    ed.fc.on('selection:updated', refreshProps);
    ed.fc.on('selection:cleared', refreshProps);
    ed.fc.on('object:moving', refreshProps);
    ed.fc.on('object:scaling', refreshProps);
    ed.fc.on('object:rotating', refreshProps);
    // Extend-background nudge banner — see showExtendBanner's declaration for the full rationale.
    let extendCheckTimer = null;
    const refreshExtendBanner = () => {
      clearTimeout(extendCheckTimer);
      extendCheckTimer = setTimeout(async () => {
        const provider = ed.ai.provider();
        if (ed.tool === 'crop' || !provider || !provider.hasKey || !provider.hasKey()) { setShowExtendBanner(false); return; }
        const frac = await ed.backgroundGapFraction();
        setShowExtendBanner(frac >= 0.12);
      }, 400);
    };
    const offs = [
      ed.on('tool', t => { setTool(t); if (t !== 'aiinsert') setAiInsert(null); if (t !== 'crop') ed.setToolOptions({ cropRatio: 0 }); refreshExtendBanner(); }),
      ed.on('history', h => setHist(h)),
      ed.on('change', () => {
        thumbVerRef.current++; setLayers(ed.layers()); refreshProps();
        if (!compareSnapshotRef.current) { compareSnapshotRef.current = ed.exportPNG(); setCompareReady(true); }
        refreshExtendBanner();
      }),
      ed.on('tooloptions', o => setOpts({ size: o.size, opacity: o.opacity, color: o.color, tolerance: o.tolerance, addMode: o.addMode, gradientType: o.gradientType, gradientStops: o.gradientStops, cropRatio: o.cropRatio || 0 })),
      ed.on('guides', g => { dragGuides = g; ed.fc.requestRenderAll(); }),
      ed.on('selection', s => { refreshProps(); setSelMsg(''); setObjselectBusy(false); setSelCount(s ? (selectionPolys(s) || []).length : 0); ed.fc.requestRenderAll(); startAntsLoopIfNeeded(); }),
      ed.on('crop', () => ed.fc.requestRenderAll()),
      ed.on('pen', build => { penBuild = build; ed.fc.requestRenderAll(); }),
      ed.on('maskedit', m => { setMaskEdit(m); setLayers(ed.layers()); }),
      ed.on('aiinsert', ({ pt, region }) => setAiInsert({ pt, region, prompt: '', busy: false, msg: '' })),
      ed.on('hover', h => { hoverPreview = h; ed.fc.requestRenderAll(); setObjselectBusy(false); }),
      ed.on('error', () => setObjselectBusy(false)),
      ed.on('zoom', z => setZoomPct(Math.round((z || ed.fc.getZoom() || 1) * 100))),
      ed.on('resize', () => fitToScreen()),
    ];
    const onObjselectDown = () => {
      if (ed.tool !== 'objectselect' && ed.tool !== 'hoverselect' && ed.tool !== 'magicwand') return;
      setObjselectBusy(true);
      setTimeout(() => setObjselectBusy(b => (ed.tool === 'objectselect' || ed.tool === 'hoverselect' || ed.tool === 'magicwand') ? false : b), 4000);
    };
    ed.fc.on('mouse:down', onObjselectDown);
    if (ai === 'gemini') {
      const p = new GeminiProvider();
      ed.ai.register(p);
      setNeedKey(!p.hasKey());
    } else if (ai && typeof ai === 'object') {
      ed.ai.register(ai);
    }
    const stops = [installKeybindings(ed)];
    if (bridge) {
      stops.push(installBridge(src => { ed.openImage(src); trackAsset(src, 'Opened image'); }));
      stops.push(installDropImport(stageRef.current, src => { ed.addImage(src); trackAsset(src, 'Dropped image'); }));
    }
    if (image) { ed.openImage(image); trackAsset(image, 'Opened image'); }
    setLayers(ed.layers());
    onReady && onReady(ed);
    requestAnimationFrame(() => fitToScreen());
    const onWindowResize = () => setZoomPct(Math.round((ed.fc.getZoom() || 1) * 100));
    window.addEventListener('resize', onWindowResize);
    // +/-/0 zoom shortcuts — no modifier, same guard (not typing, no Cmd/Ctrl/Alt) as the vanilla
    // demo's own zoom keydown listener, kept separate from installKeybindings (core) since zoom is
    // shell-owned UI state (the pill's displayed percentage), not editor state.
    const onZoomKey = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomAtCenter(ed.fc.getZoom() * 1.2); }
      else if (e.key === '-') { e.preventDefault(); setZoomAtCenter(ed.fc.getZoom() * 0.83); }
      else if (e.key === '0') { e.preventDefault(); fitToScreen(); }
    };
    document.addEventListener('keydown', onZoomKey);
    return () => {
      offs.forEach(f2 => f2()); stops.forEach(f2 => f2()); ed.destroy();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('keydown', onZoomKey);
      clearTimeout(extendCheckTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const ed = () => edRef.current;
  const pick = useCallback((t) => ed().setTool(t), []);
  const activeLayer = layers.find(l => l.active);
  const align = (edge) => activeLayer && ed().alignLayer(activeLayer.id, edge);
  const duplicate = () => activeLayer && ed().duplicateLayer(activeLayer.id);
  const toggleSnap = () => { const on = !snapOn; setSnapOn(on); ed().setSnapEnabled(on); };

  // ── zoom pill + fit-to-screen — ports the vanilla demo's setZoomAtCenter/fitToScreen exactly.
  // Fabric's canvas element keeps its DOM size fixed at W×H; "zoom" is purely the viewport
  // transform's scale, applied around the stage's own center.
  const [zoomPct, setZoomPct] = useState(100);
  const setZoomAtCenter = (z) => {
    z = Math.min(5, Math.max(0.1, z));
    const stage = stageRef.current; if (!stage) return;
    ed().fc.zoomToPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }, z);
    ed().fc.requestRenderAll();
    setZoomPct(Math.round(z * 100));
  };
  const fitToScreen = useCallback(() => {
    const e = edRef.current, stage = stageRef.current; if (!e || !stage) return;
    const pad = 48;
    const availW = Math.max(50, stage.clientWidth - pad), availH = Math.max(50, stage.clientHeight - pad);
    const z = Math.min(2, Math.max(0.05, Math.min(availW / e.W, availH / e.H)));
    e.fc.setZoom(z);
    const vpt = e.fc.viewportTransform.slice();
    vpt[4] = (stage.clientWidth - e.W * z) / 2;
    vpt[5] = (stage.clientHeight - e.H * z) / 2;
    e.fc.setViewportTransform(vpt);
    e.fc.requestRenderAll();
    setZoomPct(Math.round(z * 100));
  }, []);

  // ── Properties panel actions — mirrors the vanilla demo's wiring 1:1 so both UIs behave the
  // same; refreshProps() (via the 'change'/'selection' events already wired above) keeps `props`
  // in sync after each call, so handlers here don't need to update state themselves.
  const showSelResult = (r) => setSelMsg(r.status === 'ok' ? '' : (r.message || SEL_REASON_MSG[r.reason] || r.reason));
  const stack = (dir) => activeLayer && ed().moveLayer(activeLayer.id, dir);
  const groupSel = () => showSelResult(ed().groupSelection());
  const ungroupSel = () => showSelResult(ed().ungroupSelection());
  const setAdjust = (patch) => {
    if (props.isAdjustment) ed().setAdjustmentParams(activeLayer?.id, patch);
    else ed().setImageFilters(patch);
  };
  const setText = (patch) => ed().setTextProps(patch);
  // Fill-gradient editor: angle isn't retrievable from a Fabric gradient object (it's baked into
  // absolute coords), so it's tracked locally the same way the demo tracks it — kept across
  // stop/type edits on the same shape, reset only implicitly (a freshly-selected shape's own
  // angle is unknown, so this just starts back at 0 for it).
  const [fgAngle, setFgAngle] = useState(0);
  const DEFAULT_GRADIENT_STOPS = [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }];
  const setSolidFillMode = () => setFillColor(props.fill);
  const setGradientFillMode = () => ed().setShapeGradient((props.shapeGradient && props.shapeGradient.stops) || DEFAULT_GRADIENT_STOPS, 'linear', fgAngle);
  const setShapeGradientPatch = (patch) => {
    const cur = props.shapeGradient || { type: 'linear', stops: DEFAULT_GRADIENT_STOPS };
    const next = { ...cur, ...patch };
    if ('angle' in patch) setFgAngle(patch.angle);
    ed().setShapeGradient(next.stops, next.type, 'angle' in patch ? patch.angle : fgAngle);
  };
  // ── Compare: side-by-side view of the first meaningful state vs. the live render — see the
  // compareSnapshotRef declaration above (near the other refs) for the snapshot-capture rationale.
  const openCompare = () => {
    if (!compareSnapshotRef.current) return;
    setCompareAfter(ed().exportPNG());
    setCompareOpen(true);
  };
  const closeCompare = () => setCompareOpen(false);
  useEffect(() => {
    if (compareOpen) {
      const onKey = (e) => { if (e.key === 'Escape') closeCompare(); };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareOpen]);

  // ── ⌘K command palette — ports the vanilla demo's cmdk implementation onto React state. Tool
  // items come from GROUPS (already the single source of truth for the tool rail); action items
  // are React-shell equivalents of the demo's Edit/Select/View/Insert/Export groups, using only
  // capabilities that actually exist in this shell (no video/catalogue-specific actions).
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const [cmdkIdx, setCmdkIdx] = useState(0);
  const cmdkInputRef = useRef(null);
  const ALL_TOOL_ITEMS = GROUPS.flatMap(g => g.tools).map(([id, label]) => ({ group: 'Tool', icon: id, label, run: () => ed().setTool(id) }));
  const buildActionItems = () => [
    { group: 'Edit', icon: 'undo', label: 'Undo', run: () => ed().undo() },
    { group: 'Edit', icon: 'redo', label: 'Redo', run: () => ed().redo() },
    { group: 'Edit', icon: 'duplicate', label: 'Duplicate layer', run: duplicate },
    { group: 'Edit', icon: 'close', label: 'Delete layer', run: () => activeLayer && ed().removeLayer(activeLayer.id) },
    { group: 'Select', icon: 'box', label: 'Group selection', run: groupSel },
    { group: 'Select', icon: 'duplicate', label: 'Ungroup', run: ungroupSel },
    { group: 'Select', icon: 'close', label: 'Deselect', run: () => ed().clearSelection() },
    { group: 'View', icon: 'plus', label: 'Zoom in', run: () => setZoomAtCenter(ed().fc.getZoom() * 1.2) },
    { group: 'View', icon: 'minus', label: 'Zoom out', run: () => setZoomAtCenter(ed().fc.getZoom() * 0.83) },
    { group: 'View', icon: 'maximize', label: 'Fit to screen', run: fitToScreen },
    { group: 'View', icon: 'search', label: 'Compare with original', run: openCompare },
    { group: 'View', icon: mode_ === 'dark' ? 'sun' : 'moon', label: 'Toggle light/dark theme', run: () => setMode(m => m === 'dark' ? 'light' : 'dark') },
    { group: 'View', icon: 'chevron', label: leftCollapsed ? 'Show side panel' : 'Hide side panel', run: () => setLeftCollapsed(s => !s) },
    { group: 'View', icon: 'chevron', label: sideCollapsed ? 'Show Properties panel' : 'Hide Properties panel', run: () => setSideCollapsed(s => !s) },
    { group: 'Insert', icon: 'type', label: 'Add text', run: () => ed().setTool('type') },
    { group: 'Insert', icon: 'box', label: 'Add rectangle', run: () => ed().setTool('rect') },
    { group: 'Insert', icon: 'eye', label: 'Add ellipse', run: () => ed().setTool('ellipse') },
    { group: 'Insert', icon: 'duplicate', label: 'Add image…', run: addImagePick },
    { group: 'Insert', icon: 'spark', label: 'Add CTA button', run: () => { ed().addCTA(null, { text: 'Shop now' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'hoverselect', label: 'Add badge', run: () => { ed().addBadge(null, { text: 'Sale' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'box', label: 'Add price', run: () => { ed().addPrice(null, { current: '$29', original: '$40', save: 'Save 27%' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'box', label: 'Add brand lockup', run: () => { ed().addBrandLockup(null, { text: 'Brand' }); ed().setTool('select'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export PNG', run: () => { const u = ed().exportPNG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.png'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export JPG', run: () => { const u = ed().exportJPEG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.jpg'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export SVG', run: exportSvg },
  ];
  const cmdkAllItems = () => ALL_TOOL_ITEMS.concat(buildActionItems());
  const cmdkFilteredItems = () => {
    const q = cmdkQuery.trim().toLowerCase();
    const all = cmdkAllItems();
    return q ? all.filter(it => it.label.toLowerCase().includes(q) || it.group.toLowerCase().includes(q)) : all;
  };
  const openCmdk = () => { setCmdkQuery(''); setCmdkIdx(0); setCmdkOpen(true); requestAnimationFrame(() => cmdkInputRef.current && cmdkInputRef.current.focus()); };
  const closeCmdk = () => setCmdkOpen(false);
  const runCmdkItem = (it) => { closeCmdk(); if (it) it.run(); };
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBlend = (blend) => activeLayer && ed().setLayer(activeLayer.id, { blend });
  const setOpacity = (opacity) => activeLayer && ed().setLayer(activeLayer.id, { opacity });
  const setFillColor = (color) => ed().setFill(color);
  const setStroke = (patch) => ed().setStroke(patch);
  const setNumeric = (patch) => ed().setNumeric(patch);
  const flip = (axis) => ed().flipLayer(axis);
  const centerH = () => ed().fc.getActiveObject() && ed().alignActiveSelection('center');
  const centerV = () => ed().fc.getActiveObject() && ed().alignActiveSelection('middle');
  const setShadow = (patch) => ed().setShadow({ ...props.shadow, ...patch });
  const clearShadow = () => ed().setShadow({ blur: 0, offsetX: 0, offsetY: 0 });
  const expandSel = async () => showSelResult(await ed().expandSelection(6));
  const contractSel = async () => showSelResult(await ed().contractSelection(6));
  const selectSimilar = async () => showSelResult(await ed().selectSimilar());
  const recolorSel = (hex) => { const id = ed().recolorSelection(hex); setSelMsg(id ? '' : 'Make a selection first.'); };
  // Clip/unclip the active layer to the current selection — non-destructive: hides pixels
  // outside the selection via a clipPath, doesn't touch layer size/position/data. Needs BOTH an
  // active layer and a selection, unlike Expand/Contract/Select similar/Recolor which only need
  // a selection — ported from the vanilla demo's sel-clip/sel-unclip, previously absent here.
  // clipLayerToSelection/clearLayerClip (editor.js) already resolve a fallback active layer via
  // _lastActiveId when a drawing tool has discarded Fabric's own active object — checking
  // fc.getActiveObject() directly here would re-introduce that exact bug in the UI guard even
  // though the underlying call would have succeeded, so this checks the SAME resolved layer the
  // editor methods themselves use.
  const hasResolvableLayer = () => !!(ed().fc.getActiveObject() || (ed()._lastActiveId && ed()._byId(ed()._lastActiveId)));
  const clipToSel = () => { if (!hasResolvableLayer()) { setSelMsg('Select a layer to clip first.'); return; } ed().clipLayerToSelection(); setSelMsg(''); };
  const clearClip = () => { if (!hasResolvableLayer()) { setSelMsg('Select a layer first.'); return; } ed().clearLayerClip(); setSelMsg(''); };
  const [detectResults, setDetectResults] = useState([]);
  const detectObjects = async () => {
    setDetectResults([]);
    setSelMsg('Detecting…');
    const r = await ed().detectObjects();
    if (r.status !== 'ok') { showSelResult(r); return; }
    setSelMsg(r.result.boxes.length ? '' : 'No objects detected.');
    setDetectResults(r.result.boxes);
  };
  const selectDetected = (box) => ed().selectDetectedBox(box);
  const [csOpen, setCsOpen] = useState(false);
  const [csW, setCsW] = useState(width);
  const [csH, setCsH] = useState(height);
  const [csLock, setCsLock] = useState(true);
  const openCanvasSize = () => { setCsW(ed().W); setCsH(ed().H); setCsOpen(o => !o); };
  const applyCanvasSize = () => { if (csW > 0 && csH > 0) ed().resizeCanvas(csW, csH); setCsOpen(false); };
  const runAI = async () => {
    if (!aiPrompt.trim()) return;
    setAiBusy(true); setAiMsg('');
    const r = await ed().aiEdit(aiPrompt.trim());
    setAiBusy(false);
    setAiMsg(r.status === 'ok' ? 'Applied ✓ (undo to revert)' : r.message || r.reason);
  };
  // "Replace background" — aiBgSwap() — previously absent from the React shell entirely (the
  // vanilla demo has it as its own prompt+button, separate from the general "Apply AI edit"
  // magic-edit box). Shares the AI tab's aiBusy/aiMsg state, same "every AI action in this tab
  // disables while any one is in flight" contract runAI already has.
  const [aiBgPrompt, setAiBgPrompt] = useState('');
  const runAiBgSwap = async () => {
    if (!aiBgPrompt.trim()) return;
    setAiBusy(true); setAiMsg('');
    const r = await ed().aiBgSwap(aiBgPrompt.trim());
    setAiBusy(false);
    setAiMsg(r.status === 'ok' ? 'Applied ✓ (undo to revert)' : r.message || r.reason);
  };
  const saveKey = (k) => { ed().ai.provider().setKey(k); setNeedKey(!k); };

  // ── Design tab: canvas-level background/fill tools and add-element shortcuts ────────────
  const [designBusy, setDesignBusy] = useState(false);
  // Extend-background nudge: a floating banner over the canvas that appears once enough of the
  // artboard is still empty, offering the same AI-extend action as the Design tab's own button —
  // debounced (400ms) since it re-samples the flattened canvas and 'change' events can fire in
  // bursts. Ported from the vanilla demo's extend-banner/refreshExtendBanner, previously absent
  // from the React shell entirely.
  const [showExtendBanner, setShowExtendBanner] = useState(false);
  const [designMsg, setDesignMsg] = useState('');
  const extendBackground = () => setDesignMsg(ed().extendBackgroundToCanvas() ? '' : 'No background image to extend.');
  const aiExtendBackground = async () => {
    setDesignBusy(true); setDesignMsg('');
    const r = await ed().aiExtendBackground();
    setDesignBusy(false);
    setDesignMsg(r.status === 'ok' ? '' : r.message || r.reason);
  };
  const onExtendBannerClick = async () => {
    setShowExtendBanner(false);
    const r = await ed().aiExtendBackground();
    if (r.status !== 'ok') setDesignMsg(r.message || r.reason);
  };
  const fillWithColor = (color) => ed().fillWithColor(color);
  const pickImage = (onPicked) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = (ev) => onPicked(ev.target.result);
      rd.readAsDataURL(f);
    };
    inp.click();
  };
  const fillWithImagePick = () => pickImage(src => ed().fillWithImage(src));
  const addImagePick = () => pickImage(src => { ed().addImage(src); trackAsset(src, 'Image'); });
  // Vector export — exportSVG() returns a plain SVG string (not a dataURL, unlike PNG/JPEG), so
  // it needs wrapping in a Blob URL before it can be downloaded — same as the vanilla demo's own
  // svg.onclick. Previously absent from the React shell entirely (only PNG/JPG existed here).
  const exportSvg = () => {
    const blob = new Blob([ed().exportSVG()], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    if (onExport) onExport(url); else downloadURL(url, 'canvasmith.svg');
    URL.revokeObjectURL(url);
  };

  // ── Convert to layers: guided review-box overlay over the canvas ────────────────────────
  // review = { flat, boxes: [{id, type, x, y, w, h} in scene px] } | null. Box positions are
  // stored in scene (artboard) px and converted to screen px at render time via the live
  // viewportTransform, so panning/zooming while reviewing just re-renders in place — same
  // contract as the vanilla demo's openReview/sceneToScreen.
  const [review, setReview] = useState(null);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertMsg, setConvertMsg] = useState('');
  const sceneToScreen = (pt) => {
    const v = ed().fc.viewportTransform;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const stageRect = stageRef.current.getBoundingClientRect();
    return { x: canvasRect.left - stageRect.left + pt.x * v[0] + v[4], y: canvasRect.top - stageRect.top + pt.y * v[3] + v[5] };
  };
  const screenDeltaToScene = (dx, dy) => {
    const v = ed().fc.viewportTransform;
    return { dx: dx / v[0], dy: dy / v[3] };
  };
  const openReview = (flat, regions) => {
    const boxes = regions.map((rg, i) => {
      const bbox = rg.bbox || {};
      return {
        id: 'rv' + i, type: REGION_COLOR[rg.type] ? rg.type : 'decorative',
        x: (bbox.x || 0) / 100 * ed().W, y: (bbox.y || 0) / 100 * ed().H,
        w: Math.max(12, (bbox.width || 0) / 100 * ed().W), h: Math.max(12, (bbox.height || 0) / 100 * ed().H),
      };
    });
    setReview({ flat, boxes });
    ed().setTool('select');
  };
  const closeReview = () => { setReview(null); setConvertMsg(''); };
  const addReviewBox = () => setReview(r => r && ({ ...r, boxes: [...r.boxes, { id: 'rv' + Date.now(), type: 'decorative', x: ed().W * 0.35, y: ed().H * 0.35, w: ed().W * 0.3, h: ed().H * 0.3 }] }));
  const removeReviewBox = (id) => setReview(r => r && ({ ...r, boxes: r.boxes.filter(b => b.id !== id) }));
  const setReviewBoxType = (id, type) => setReview(r => r && ({ ...r, boxes: r.boxes.map(b => b.id === id ? { ...b, type } : b) }));
  const detectAndConvert = async () => {
    if (needKey) { setSideTab('ai'); return; }
    setConvertBusy(true);
    setConvertMsg('');
    try {
      const r = await ed().detectRegions();
      if (r.status === 'ok') { openReview(r.result.flat, r.result.regions); return; }
      // Every failure reason (no_provider / rate_limited / provider_failed / no_regions) now
      // surfaces to the user instead of the button silently resetting with no explanation —
      // previously detectAndConvert() just swallowed a non-'ok' status entirely.
      setConvertMsg(r.message || AI_REASON_MSG[r.reason] || r.reason || 'Detect failed — try again.');
    } catch (e) {
      setConvertMsg((e && e.message) ? e.message.slice(0, 120) : 'Detect failed — try again.');
    } finally {
      setConvertBusy(false);
    }
  };
  const selectOneManually = () => { openReview(ed().exportPNG(), []); addReviewBox(); };
  const commitReview = async () => {
    if (!review || !review.boxes.length) { closeReview(); return; }
    const regions = review.boxes.map(b => ({
      type: b.type,
      bbox: { x: b.x / ed().W * 100, y: b.y / ed().H * 100, width: b.w / ed().W * 100, height: b.h / ed().H * 100 },
    }));
    const flat = review.flat;
    closeReview();
    await ed().commitRegions(flat, regions);
  };
  const reviewDragRef = useRef(null);
  const onReviewBoxMouseDown = (e, box, mode) => {
    e.preventDefault();
    reviewDragRef.current = { id: box.id, mode, lastX: e.clientX, lastY: e.clientY };
  };
  useEffect(() => {
    const onMove = (e) => {
      const d = reviewDragRef.current; if (!d) return;
      const dx = e.clientX - d.lastX, dy = e.clientY - d.lastY;
      d.lastX = e.clientX; d.lastY = e.clientY;
      const { dx: sdx, dy: sdy } = screenDeltaToScene(dx, dy);
      setReview(r => {
        if (!r) return r;
        return { ...r, boxes: r.boxes.map(b => {
          if (b.id !== d.id) return b;
          return d.mode === 'move' ? { ...b, x: b.x + sdx, y: b.y + sdy } : { ...b, w: Math.max(12, b.w + sdx), h: Math.max(12, b.h + sdy) };
        }) };
      });
    };
    const onUp = () => { reviewDragRef.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Re-render box screen positions on pan/zoom/resize — box state itself (scene px) is unchanged.
  const [, bumpReview] = useState(0);
  useEffect(() => {
    if (!review) return;
    const off = ed().on('zoom', () => bumpReview(n => n + 1));
    const onResize = () => bumpReview(n => n + 1);
    window.addEventListener('resize', onResize);
    return () => { off(); window.removeEventListener('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);
  // Re-render the AI-insert popover's screen position on pan/zoom/resize — same contract as review.
  const [, bumpAiInsert] = useState(0);
  useEffect(() => {
    if (!aiInsert) return;
    const off = ed().on('zoom', () => bumpAiInsert(n => n + 1));
    const onResize = () => bumpAiInsert(n => n + 1);
    window.addEventListener('resize', onResize);
    return () => { off(); window.removeEventListener('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiInsert]);
  const submitAiInsert = async () => {
    const ai = aiInsert; if (!ai || !ai.prompt.trim() || ai.busy) return;
    if (needKey) { setAiInsert(null); ed().setTool('select'); setSideTab('ai'); return; }
    setAiInsert(a => a && ({ ...a, busy: true, msg: '' }));
    const r = await ed().aiInsertAt(ai.prompt.trim(), ai.pt);
    if (r.status === 'ok') { setAiInsert(null); ed().setTool('select'); }
    else setAiInsert(a => a && ({ ...a, busy: false, msg: r.message || r.reason || 'Could not generate that.' }));
  };

  // ── layer panel: thumbnails, rename, drag-to-reorder — ports the vanilla demo's layerThumb/
  // layerSubtitle/renderLayers click+drag handling onto React state instead of direct DOM writes.
  const layerThumb = (id) => {
    const o = ed().fc.getObjects().find(x => x.id === id);
    if (!o || !o.toDataURL) return null;
    const cached = thumbCacheRef.current.get(id);
    if (cached && cached.ver === thumbVerRef.current) return cached.url;
    try {
      const br = o.getBoundingRect ? o.getBoundingRect(true) : null;
      const dim = br ? Math.max(br.width || 1, br.height || 1) : 1;
      const mult = Math.max(0.03, Math.min(1, 56 / dim));
      const url = o.toDataURL({ format: 'png', multiplier: mult, enableRetinaScaling: false });
      thumbCacheRef.current.set(id, { ver: thumbVerRef.current, url });
      return url;
    } catch (e) { return null; }
  };
  const layerSubtitle = (l) => {
    const o = ed().fc.getObjects().find(x => x.id === l.id);
    if (!o) return l.role;
    const w = Math.round(o.getScaledWidth ? o.getScaledWidth() : (o.width || 0));
    const h = Math.round(o.getScaledHeight ? o.getScaledHeight() : (o.height || 0));
    return w && h ? `${w}×${h} ${l.role}` : l.role;
  };
  const commitRename = (id, value) => {
    setRenamingId(null);
    const v = value.trim();
    if (v) ed().setLayer(id, { name: v });
  };
  const onLayerRowClick = (l) => {
    // Manual double-click detection keyed on the layer id (not the DOM node), same reasoning as
    // the vanilla demo: activate() re-renders the row via React state on selection change, so a
    // native 'dblclick' (which needs both clicks on the SAME node) would miss the common
    // "click an unselected layer, then again to rename" gesture.
    const now = Date.now();
    const last = lastLayerClickRef.current;
    if (last && last.id === l.id && now - last.t < 400) {
      setRenamingId(l.id); lastLayerClickRef.current = null; return;
    }
    lastLayerClickRef.current = { id: l.id, t: now };
    if (!l.active) ed().activate(l.id);
  };
  const onLayerDragStart = (e, l) => {
    if (l.role === 'bg') { e.preventDefault(); return; }
    setDragLayerId(l.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', l.id);
  };
  const onLayerDragOver = (e, l) => {
    if (!dragLayerId || l.id === dragLayerId) return;
    e.preventDefault();
    if (dragOverId !== l.id) setDragOverId(l.id);
  };
  const onLayerDrop = (e, l) => {
    e.preventDefault();
    if (dragLayerId && l.id !== dragLayerId) ed().reorderLayerTo(dragLayerId, l.id, { after: false });
    setDragLayerId(null); setDragOverId(null);
  };
  const onLayerDragEnd = () => { setDragLayerId(null); setDragOverId(null); };

  const palette = THEMES[mode_] || THEMES.dark;
  const style = Object.fromEntries(Object.entries({ ...palette, 'accent-ink': palette.accentInk, ...theme })
    .filter(([k]) => k !== 'accentInk').map(([k, v]) => ['--cm-' + k, v]));
  return (
    <div className="cm-root" style={style} data-cm-mode={mode_}>
      <style>{CSS}</style>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs><linearGradient id="cm-grad-icon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--cm-accent)" /><stop offset="1" stopColor="var(--cm-ink)" />
        </linearGradient></defs>
      </svg>
      <div className="cm-top">
        <strong style={{ fontSize: 13 }}>Canvasmith</strong>
        <button className="cm-btn" disabled={hist.past < 2} onClick={() => ed().undo()}><Icon name="undo" /> Undo</button>
        <button className="cm-btn" disabled={!hist.future} onClick={() => ed().redo()}><Icon name="redo" /> Redo</button>
        <span style={{ width: 1, height: 20, background: 'var(--cm-line)' }} />
        <label>Size <input type="range" min="2" max="220" value={opts.size} onChange={e => ed().setToolOptions({ size: +e.target.value })} /></label>
        <label>Opacity <input type="range" min="0.05" max="1" step="0.05" value={opts.opacity} onChange={e => ed().setToolOptions({ opacity: +e.target.value })} /></label>
        <input type="color" value={opts.color} onChange={e => ed().setToolOptions({ color: e.target.value, fill: e.target.value })} title="Colour" />
        {tool === 'crop' && <button className="cm-btn" onClick={() => ed().applyCrop()}>✓ Apply crop</button>}
        <span style={{ position: 'relative' }}>
          <button className="cm-btn" onClick={openCanvasSize}>Canvas size</button>
          {csOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 60, width: 220,
              background: 'var(--cm-panel)', border: '1px solid var(--cm-line)', borderRadius: 10,
              padding: 14, boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            }}>
              <h4 style={{ margin: '0 0 10px', fontSize: 12 }}>Canvas size</h4>
              <select className="cm-select" style={{ width: '100%', marginBottom: 8 }} defaultValue=""
                onChange={e => {
                  if (!e.target.value) return;
                  const [w, h] = e.target.value.split('x').map(Number);
                  setCsW(w); setCsH(h);
                  e.target.value = '';
                }}>
                <option value="">Preset…</option>
                {CANVAS_PRESETS.map(([group, sizes]) => (
                  <optgroup key={group} label={group}>
                    {sizes.map(([name, w, h]) => (
                      <option key={name} value={`${w}x${h}`}>{name} — {w}×{h}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ flex: 1, fontSize: 11 }}>W
                  <input type="number" min="1" max="8000" value={csW} style={{ width: '100%' }}
                    onChange={e => { const w = +e.target.value; setCsW(w); if (csLock) setCsH(Math.round(w * (ed().H / ed().W)) || ''); }} />
                </label>
                <label style={{ flex: 1, fontSize: 11 }}>H
                  <input type="number" min="1" max="8000" value={csH} style={{ width: '100%' }}
                    onChange={e => { const h = +e.target.value; setCsH(h); if (csLock) setCsW(Math.round(h * (ed().W / ed().H)) || ''); }} />
                </label>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11.5 }}>
                <input type="checkbox" checked={csLock} onChange={e => setCsLock(e.target.checked)} /> Lock aspect ratio
              </label>
              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setCsOpen(false)}>Cancel</button>
                <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={applyCanvasSize}>Apply</button>
              </div>
            </div>
          )}
        </span>
        <span style={{ flex: 1 }} />
        <div className="cm-zoom-pill">
          <button className="cm-icon-btn" title="Zoom out (-)" onClick={() => setZoomAtCenter(ed().fc.getZoom() * 0.83)}><Icon name="minus" size={13} /></button>
          <button className="cm-btn" style={{ minWidth: 44, justifyContent: 'center' }} title="Fit to screen (0)" onClick={fitToScreen}>{zoomPct}%</button>
          <button className="cm-icon-btn" title="Zoom in (+)" onClick={() => setZoomAtCenter(ed().fc.getZoom() * 1.2)}><Icon name="plus" size={13} /></button>
          <button className="cm-icon-btn" title="Fit to screen (0)" onClick={fitToScreen}><Icon name="maximize" size={13} /></button>
        </div>
        <button className="cm-btn" disabled={!compareReady} title="Compare with the first-loaded version" onClick={openCompare}>
          <Icon name="search" size={13} />Compare
        </button>
        <button className="cm-icon-btn" title={mode_ === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setMode(mode_ === 'dark' ? 'light' : 'dark')}>
          <Icon name={mode_ === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="cm-btn" onClick={() => { const u = ed().exportPNG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.png'); }}>⬇ PNG</button>
        <button className="cm-btn" onClick={() => { const u = ed().exportJPEG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.jpg'); }}>⬇ JPG</button>
        <button className="cm-btn" onClick={exportSvg}>⬇ SVG</button>
      </div>
      <div className="cm-rail">
        {GROUPS.map(g => (
          <React.Fragment key={g.label}>
            <div className="cm-grp">{g.label}</div>
            {g.tools.map(([id, label]) => (
              <button key={id} data-on={tool === id} title={label} onClick={() => pick(id)}><Icon name={id} /></button>
            ))}
          </React.Fragment>
        ))}
      </div>
      <button className="cm-collapse-left" data-flip={leftCollapsed} title={leftCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setLeftCollapsed(s => !s)}>
        <Icon name="chevron" size={13} />
      </button>
      <div className="cm-left">
        {!leftCollapsed && (
          <React.Fragment>
            <div className="cm-tabs">
              <button data-on={leftTab === 'tool'} onClick={() => setLeftTab('tool')}><Icon name="tool" size={13} /> Tool</button>
              <button data-on={leftTab === 'layers'} onClick={() => setLeftTab('layers')}><Icon name="layers" size={13} /> Layers {layers.length ? <span style={{ color: 'var(--cm-dim)' }}>{layers.length}</span> : null}</button>
            </div>

            {leftTab === 'tool' && (
              <div>
                {maskEdit && (
                  <div style={{ background: 'var(--cm-accent)', color: 'var(--cm-accent-ink)', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12, fontWeight: 600 }}>
                    Editing layer mask — paint white to reveal, black to hide.
                    <div className="cm-row" style={{ marginTop: 8 }}>
                      <button className="cm-btn" style={{ flex: 1, justifyContent: 'center', background: 'var(--cm-panel)', color: 'var(--cm-ink)' }} onClick={() => ed().invertMask(maskEdit.layerId)} title="Swap hidden/visible across the whole mask">
                        Invert mask
                      </button>
                      <button className="cm-btn" style={{ flex: 1, justifyContent: 'center', background: 'var(--cm-panel)', color: 'var(--cm-ink)' }} onClick={() => ed().exitMaskEdit()}>
                        Done editing mask
                      </button>
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Icon name={tool} />
                  <strong style={{ textTransform: 'capitalize' }}>{tool}</strong>
                </div>
                <div className="cm-note" style={{ marginTop: 0 }}>
                  {tool === 'select' ? 'Click a layer on the canvas, or drag to move the selected layer.'
                    : tool === 'crop' ? 'Drag the handles, then Apply crop in the top bar.'
                    : tool === 'aiinsert' ? 'Click a spot to draw there — or make a selection first and click inside it: the AI fills exactly that shape.'
                    : tool === 'pen' ? 'Click to place points; click near the start (or press Enter) to close, Escape to cancel.'
                    : 'Drag on the canvas to use this tool.'}
                </div>
                {tool === 'pen' && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => ed().finishPen()}>✓ Finish path</button>
                    <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => ed().cancelPen()}>Cancel</button>
                  </div>
                )}
                {tool === 'crop' && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {CROP_RATIOS.map(([label, r]) => {
                      const ratio = r === 'orig' ? ed().W / ed().H : r;
                      const on = r === 'orig' ? opts.cropRatio === (ed().W / ed().H) : opts.cropRatio === r;
                      return (
                        <button key={label} className="cm-chip" data-on={on} onClick={() => ed().setToolOptions({ cropRatio: ratio })}>{label}</button>
                      );
                    })}
                  </div>
                )}
                <button className="cm-toggle" data-on={snapOn} onClick={toggleSnap} style={{ marginTop: 10 }}>
                  {snapOn ? 'Snap: on' : 'Snap: off'}
                </button>

                {(tool === 'objectselect' || tool === 'hoverselect' || tool === 'magicwand') && (
                  <React.Fragment>
                    <div className="cm-note" style={{ marginTop: 8 }}>
                      {objselectBusy ? 'Finding object…'
                        : selCount > 1 ? selCount + ' selected · ⇧-click (or Add) to keep combining'
                        : selCount === 1 ? 'Selected · ⇧-click to add more, ⌥-click to subtract'
                        : (tool === 'hoverselect' ? 'Hover to preview, click to select' : 'Click an object to select it')}
                    </div>
                    <button className="cm-toggle" data-on={opts.addMode} style={{ marginTop: 8 }}
                      onClick={() => ed().setToolOptions({ addMode: !opts.addMode })}>
                      Add{opts.addMode ? ' ✓' : ''}
                    </button>
                    <label style={{ display: 'block', marginTop: 8, fontSize: 11, color: 'var(--cm-dim)' }}>Tolerance
                      <input type="range" min="4" max="128" value={opts.tolerance} style={{ width: '100%' }}
                        onChange={e => ed().setToolOptions({ tolerance: +e.target.value })} />
                    </label>
                    <div className="cm-note" style={{ marginTop: 8 }}>⇧ add · ⌥ subtract · [ ] tolerance</div>
                  </React.Fragment>
                )}

                {tool === 'gradient' && (
                  <React.Fragment>
                    <div className="cm-grp" style={{ marginTop: 16 }}>Gradient</div>
                    <div className="cm-row">
                      <button className="cm-btn" data-on={opts.gradientType === 'linear'} onClick={() => ed().setToolOptions({ gradientType: 'linear' })}>Linear</button>
                      <button className="cm-btn" data-on={opts.gradientType === 'radial'} onClick={() => ed().setToolOptions({ gradientType: 'radial' })}>Radial</button>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {opts.gradientStops.map((stop, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input type="color" value={stop.color} onChange={e => {
                            const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, color: e.target.value } : s);
                            ed().setToolOptions({ gradientStops: stops });
                          }} />
                          <input type="range" min="0" max="1" step="0.01" value={stop.offset} style={{ flex: 1 }} title="Position" onChange={e => {
                            const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, offset: +e.target.value } : s);
                            ed().setToolOptions({ gradientStops: stops });
                          }} />
                          <input type="range" min="0" max="1" step="0.01" value={stop.alpha ?? 1} style={{ flex: 1 }} title="Opacity" onChange={e => {
                            const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, alpha: +e.target.value } : s);
                            ed().setToolOptions({ gradientStops: stops });
                          }} />
                          <button className="cm-icon-btn" disabled={opts.gradientStops.length <= 2} title="Remove stop"
                            onClick={() => ed().setToolOptions({ gradientStops: opts.gradientStops.filter((_, si) => si !== i) })}>
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="cm-row" style={{ marginTop: 6 }}>
                      <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => {
                        const last = opts.gradientStops[opts.gradientStops.length - 1];
                        ed().setToolOptions({ gradientStops: [...opts.gradientStops, { offset: Math.min(1, last?.offset ?? 1), color: last?.color || '#ffffff', alpha: last?.alpha ?? 1 }] });
                      }}>+ Add stop</button>
                      <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} title="Reverse stop order"
                        onClick={() => ed().setToolOptions({ gradientStops: opts.gradientStops.map(s => ({ ...s, offset: 1 - s.offset })).sort((a, b) => a.offset - b.offset) })}>
                        <Icon name="flip" size={13} /> Reverse
                      </button>
                    </div>
                  </React.Fragment>
                )}

                <h4>Align to canvas</h4>
                <div className="cm-align">
                  {[
                    ['left', 'align-left'], ['center', 'align-h-center'], ['right', 'align-right'],
                    ['top', 'align-top'], ['middle', 'align-v-center'], ['bottom', 'align-bottom'],
                  ].map(([edge, icon]) => (
                    <button key={edge} disabled={!activeLayer} title={'Align ' + edge} onClick={() => align(edge)}>
                      <Icon name={icon} size={16} />
                    </button>
                  ))}
                </div>
                {props.hasFill && (
                  <>
                    <h4>Fill</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="color" value={props.fill} title="Fill colour"
                        onChange={e => setFillColor(e.target.value)} />
                      <span className="cm-note" style={{ margin: 0 }}>Colour of the selected shape or text.</span>
                    </div>
                  </>
                )}
                <button className="cm-btn" disabled={!activeLayer} onClick={duplicate}>
                  <Icon name="duplicate" /> Duplicate
                </button>

                <div className="cm-grp">Auto-detect</div>
                <button className="cm-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={detectObjects}>
                  <Icon name="wand" size={13} /> Detect objects
                </button>
                {detectResults.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
                    {detectResults.map((b, i) => (
                      <button key={i} className="cm-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => selectDetected(b)}>
                        <Icon name="objectselect" size={13} /> Object {i + 1}
                      </button>
                    ))}
                  </div>
                )}

                <div className="cm-grp">Selection (needs a marquee/lasso/wand selection)</div>
                <div className="cm-row">
                  <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={expandSel}><Icon name="expand" size={13} /> Expand</button>
                  <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={contractSel}><Icon name="contract" size={13} /> Contract</button>
                </div>
                <button className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }} disabled={!props.hasSelectionPixels} onClick={selectSimilar}>
                  <Icon name="similar" size={13} /> Select similar
                </button>
                <label className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center', opacity: props.hasSelectionPixels ? 1 : 0.4, pointerEvents: props.hasSelectionPixels ? 'auto' : 'none' }}>
                  <Icon name="eyedropper" size={13} /> Recolor selection…
                  <input type="color" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
                    onChange={e => recolorSel(e.target.value)} />
                </label>
                <div className="cm-row" style={{ marginTop: 6 }}>
                  <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={clipToSel}><Icon name="crop" size={13} /> Clip layer to selection</button>
                  <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={clearClip}><Icon name="close" size={13} /> Clear clip</button>
                </div>
                {selMsg && <div className="cm-note">{selMsg}</div>}
              </div>
            )}

            {leftTab === 'layers' && (
              <div>
                {layers.map(l => {
                  const thumb = layerThumb(l.id);
                  return (
                    <div key={l.id} className="cm-layer" data-on={l.active} data-dragover={dragOverId === l.id} data-dragging={dragLayerId === l.id}
                      draggable={l.role !== 'bg'}
                      onDragStart={e => onLayerDragStart(e, l)} onDragOver={e => onLayerDragOver(e, l)}
                      onDragLeave={() => setDragOverId(id => id === l.id ? null : id)} onDrop={e => onLayerDrop(e, l)} onDragEnd={onLayerDragEnd}
                      onClick={() => { if (renamingId !== l.id) onLayerRowClick(l); }}>
                      <span className="cm-layer-thumb">
                        {thumb ? <img src={thumb} alt="" /> : <Icon name={l.role === 'text' ? 'type' : l.role === 'bg' ? 'duplicate' : 'box'} size={14} />}
                      </span>
                      <span className="cm-eye" onClick={e => { e.stopPropagation(); ed().setLayer(l.id, { visible: !l.visible }); }}><Icon name={l.visible ? 'eye' : 'eyeOff'} size={13} /></span>
                      <span className="cm-eye" title={l.locked ? 'Unlock' : 'Lock'} style={{ opacity: l.locked ? 1 : 0.5 }} onClick={e => { e.stopPropagation(); ed().setLayer(l.id, { locked: !l.locked }); }}><Icon name="lock" size={13} /></span>
                      {renamingId === l.id ? (
                        <input className="cm-layer-rename" defaultValue={l.name} autoFocus
                          onClick={e => e.stopPropagation()}
                          onFocus={e => e.target.select()}
                          onKeyDown={e => { if (e.key === 'Enter') commitRename(l.id, e.target.value); else if (e.key === 'Escape') setRenamingId(null); }}
                          onBlur={e => commitRename(l.id, e.target.value)} />
                      ) : (
                        <span style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: l.visible ? 1 : 0.4 }}>{l.name}</span>
                          <span style={{ fontSize: 10, color: 'var(--cm-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{layerSubtitle(l)}</span>
                        </span>
                      )}
                      {l.maskable && (l.hasMask ? (
                        <React.Fragment>
                          <span className="cm-eye" title={l.editingMask ? 'Stop editing mask' : 'Edit mask'}
                            style={{ opacity: (l.editingMask || !l.maskEnabled) ? 1 : 0.7, color: l.editingMask ? 'var(--cm-accent)' : undefined }}
                            onClick={e => { e.stopPropagation(); if (l.editingMask) ed().exitMaskEdit(); else { ed().activate(l.id); ed().enterMaskEdit(l.id); } }}>
                            <Icon name="mask" size={13} />
                          </span>
                          <span className="cm-eye" title="Delete mask" onClick={e => { e.stopPropagation(); ed().removeMask(l.id); }}><Icon name="close" size={13} /></span>
                        </React.Fragment>
                      ) : (
                        <span className="cm-eye" title="Add layer mask" onClick={e => { e.stopPropagation(); ed().addMask(l.id); ed().enterMaskEdit(l.id); }}>
                          <Icon name="mask" size={13} />
                        </span>
                      ))}
                      <span className="cm-eye" title="Up" onClick={e => { e.stopPropagation(); ed().moveLayer(l.id, 'up'); }}><Icon name="up" size={13} /></span>
                      {l.role !== 'bg' && <span className="cm-eye" title="Delete" onClick={e => { e.stopPropagation(); ed().removeLayer(l.id); }}><Icon name="close" size={13} /></span>}
                    </div>
                  );
                })}
                <button className="cm-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => ed().addAdjustmentLayer()}>
                  <Icon name="contrast" size={13} /> Add adjustment layer
                </button>
              </div>
            )}
          </React.Fragment>
        )}
      </div>
      <div className="cm-stage" ref={stageRef} onDragOver={onStageDragOver} onDrop={onStageDrop}>
        <canvas ref={canvasRef} />
        {showExtendBanner && (
          <button className="cm-extend-banner" onClick={onExtendBannerClick}>
            <Icon name="search" size={13} />Background doesn't fill the canvas — AI-extend it
          </button>
        )}
        {review && (
          <React.Fragment>
            <div className="cm-review-overlay">
              {review.boxes.map(b => {
                const p = sceneToScreen({ x: b.x, y: b.y });
                const v = ed().fc.viewportTransform;
                const color = REGION_COLOR[b.type] || REGION_COLOR.decorative;
                return (
                  <div key={b.id} className="cm-review-box" data-type={b.type}
                    style={{ left: p.x, top: p.y, width: b.w * v[0], height: b.h * v[3], borderColor: color, background: color + '1f' }}
                    onMouseDown={e => onReviewBoxMouseDown(e, b, 'move')}>
                    <div className="cm-review-tag" onMouseDown={e => e.stopPropagation()}>
                      <select value={b.type} onChange={e => setReviewBoxType(b.id, e.target.value)}>
                        {Object.entries(REGION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <button onClick={() => removeReviewBox(b.id)} title="Remove"><Icon name="close" size={10} /></button>
                    </div>
                    <div className="cm-review-handle" onMouseDown={e => { e.stopPropagation(); onReviewBoxMouseDown(e, b, 'resize'); }} />
                  </div>
                );
              })}
            </div>
            <div className="cm-review-toolbar">
              <span className="cm-note" style={{ margin: 0 }}>{review.boxes.length} region{review.boxes.length === 1 ? '' : 's'}</span>
              <span className="cm-review-sep" />
              <button className="cm-btn" onClick={addReviewBox}>+ Add box</button>
              <button className="cm-btn" onClick={closeReview}>Cancel</button>
              <button className="cm-btn cm-btn-accent" disabled={!review.boxes.length} onClick={commitReview}>
                <Icon name="wand" size={13} />Create {review.boxes.length} layer{review.boxes.length === 1 ? '' : 's'}
              </button>
            </div>
          </React.Fragment>
        )}
        {aiInsert && (() => {
          const p = sceneToScreen(aiInsert.pt);
          const stageW = stageRef.current ? stageRef.current.clientWidth : 0;
          const stageH = stageRef.current ? stageRef.current.clientHeight : 0;
          const left = Math.max(8, Math.min(p.x - 10, stageW - 276));
          const top = Math.max(8, Math.min(p.y + 12, stageH - 150));
          return (
            <React.Fragment>
              <div style={{ position: 'absolute', left: p.x - 5, top: p.y - 5, width: 10, height: 10, borderRadius: '50%', background: 'var(--cm-accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--cm-accent) 35%, transparent)', zIndex: 21, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left, top, zIndex: 22, width: 260, background: 'var(--cm-panel)', border: '1px solid var(--cm-line)', borderRadius: 14, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
                <div className="cm-row" style={{ gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                  <Icon name="spark" size={13} style={{ color: 'var(--cm-accent)' }} />
                  <span style={{ flex: 1 }}>{aiInsert.region ? 'Fill the selection with AI' : 'Draw here with AI'}</span>
                  <button className="cm-icon-btn" onClick={() => setAiInsert(null)}><Icon name="close" size={12} /></button>
                </div>
                {aiInsert.region && <div className="cm-note" style={{ fontSize: 10.5, marginBottom: 6 }}>The result is clipped to your selection — the AI draws only inside that shape.</div>}
                {aiInsert.msg && <div className="cm-note" style={{ fontSize: 10.5, marginBottom: 6, color: '#e0607a' }}>{aiInsert.msg}</div>}
                <input autoFocus style={{ width: '100%', marginTop: 8, boxSizing: 'border-box', background: 'var(--cm-bg)', border: '1px solid var(--cm-line)', borderRadius: 8, color: 'var(--cm-ink)', padding: '7px 9px', fontSize: 12, fontFamily: 'inherit' }}
                  placeholder={aiInsert.region ? 'Describe what fills this shape…' : 'Describe what to draw here…'}
                  value={aiInsert.prompt} disabled={aiInsert.busy}
                  onChange={e => setAiInsert(a => a && ({ ...a, prompt: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitAiInsert(); } else if (e.key === 'Escape') { e.preventDefault(); setAiInsert(null); } }} />
                <button className="cm-btn cm-btn-accent" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
                  disabled={aiInsert.busy || !aiInsert.prompt.trim()} onClick={submitAiInsert}>
                  {aiInsert.busy ? 'Generating…' : <React.Fragment><Icon name="spark" size={13} />{aiInsert.region ? 'Generate in selection' : 'Generate here'}</React.Fragment>}
                </button>
              </div>
            </React.Fragment>
          );
        })()}
      </div>
      <button className="cm-collapse" data-flip={sideCollapsed} title={sideCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setSideCollapsed(s => !s)}>
        <Icon name="chevron" size={13} />
      </button>
      <div className="cm-side">
        {!sideCollapsed && (
          <React.Fragment>
            <div className="cm-tabs">
              <button data-on={sideTab === 'layer'} onClick={() => setSideTab('layer')}><Icon name="layers" size={13} /> Layer</button>
              <button data-on={sideTab === 'design'} onClick={() => setSideTab('design')}><Icon name="palette" size={13} /> Design</button>
              <button data-on={sideTab === 'stickers'} onClick={() => setSideTab('stickers')}><Icon name="star" size={13} /> Stickers</button>
              <button data-on={sideTab === 'ai'} onClick={() => setSideTab('ai')}><Icon name="spark" size={13} /> AI</button>
            </div>

            {sideTab === 'layer' && (
              <div>
                {!props.active ? (
                  <div className="cm-note">Select a layer on the canvas or from the Layers tab to see and edit its properties.</div>
                ) : (
                  <React.Fragment>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 4 }}>
                      <strong>{props.title}</strong>
                    </div>

                    <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Stacking</div>
                    <div className="cm-row">
                      <button className="cm-icon-btn" title="Bring to front" style={{ width: 'auto', flex: 1 }} onClick={() => stack('top')}><Icon name="chevronD" size={14} style={{ transform: 'rotate(180deg)' }} /></button>
                      <button className="cm-icon-btn" title="Bring forward" style={{ width: 'auto', flex: 1 }} onClick={() => stack('up')}><Icon name="chevron" size={14} style={{ transform: 'rotate(90deg)' }} /></button>
                      <button className="cm-icon-btn" title="Send backward" style={{ width: 'auto', flex: 1 }} onClick={() => stack('down')}><Icon name="chevron" size={14} style={{ transform: 'rotate(-90deg)' }} /></button>
                      <button className="cm-icon-btn" title="Send to back" style={{ width: 'auto', flex: 1 }} onClick={() => stack('bottom')}><Icon name="chevronD" size={14} /></button>
                    </div>
                    <div className="cm-row" style={{ marginTop: 6 }}>
                      <button className="cm-btn" disabled={!props.canGroup} onClick={groupSel}><Icon name="box" size={13} /> Group</button>
                      <button className="cm-btn" disabled={!props.canUngroup} onClick={ungroupSel}><Icon name="grid" size={13} /> Ungroup</button>
                    </div>

                    {(props.isImage || props.isAdjustment) && (
                      <React.Fragment>
                        <div className="cm-grp">{props.isAdjustment ? 'Adjustment layer' : 'Adjust'}</div>
                        {props.isAdjustment && <div className="cm-note" style={{ marginTop: 0 }}>Affects every layer below this one in the stack.</div>}
                        <div className="cm-slider-row"><Icon name="sun" size={13} /> Brightness <input type="range" min="50" max="150" value={props.fx.brightness} onChange={e => setAdjust({ brightness: +e.target.value })} /></div>
                        <div className="cm-slider-row"><Icon name="contrast" size={13} /> Contrast <input type="range" min="50" max="150" value={props.fx.contrast} onChange={e => setAdjust({ contrast: +e.target.value })} /></div>
                        <div className="cm-slider-row"><Icon name="droplet" size={13} /> Saturation <input type="range" min="0" max="200" value={props.fx.saturate} onChange={e => setAdjust({ saturate: +e.target.value })} /></div>
                        <div className="cm-slider-row"><Icon name="blurfilter" size={13} /> Blur <input type="range" min="0" max="12" step="0.5" value={props.fx.blur} onChange={e => setAdjust({ blur: +e.target.value })} /></div>
                        <div className="cm-slider-row"><Icon name="hue" size={13} /> Hue <input type="range" min="-180" max="180" value={props.fx.hue} onChange={e => setAdjust({ hue: +e.target.value })} /></div>
                        <div className="cm-slider-row"><Icon name="vibrance" size={13} /> Vibrance <input type="range" min="-100" max="100" value={props.fx.vibrance} onChange={e => setAdjust({ vibrance: +e.target.value })} /></div>
                        <label className="cm-slider-row" style={{ cursor: 'pointer' }}>
                          <Icon name="invert" size={13} /> Invert
                          <input type="checkbox" checked={!!props.fx.invert} onChange={e => setAdjust({ invert: e.target.checked })} style={{ marginLeft: 'auto' }} />
                        </label>
                      </React.Fragment>
                    )}

                    {props.text && (
                      <React.Fragment>
                        <div className="cm-grp">Typography</div>
                        <select className="cm-select" value={props.text.fontFamily} onChange={e => setText({ fontFamily: e.target.value })}>
                          {FONT_GROUPS.map(g => (
                            <optgroup key={g.label} label={g.label}>
                              {g.fonts.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
                            </optgroup>
                          ))}
                        </select>
                        <div className="cm-field-grid">
                          <label className="cm-field">Size <input type="number" min="1" max="800" value={props.text.fontSize} onChange={e => setText({ fontSize: Math.max(1, +e.target.value) })} /></label>
                          <label className="cm-field">Weight
                            <select className="cm-select" value={props.text.fontWeight} onChange={e => setText({ fontWeight: +e.target.value })}>
                              <option value={300}>Light</option><option value={400}>Regular</option><option value={500}>Medium</option>
                              <option value={600}>Semibold</option><option value={700}>Bold</option><option value={800}>Extrabold</option>
                            </select>
                          </label>
                        </div>
                        <div className="cm-row" style={{ marginTop: 8 }}>
                          <button className="cm-icon-btn" data-active={props.text.fontStyle === 'italic'} title="Italic" onClick={() => setText({ fontStyle: props.text.fontStyle === 'italic' ? 'normal' : 'italic' })}><i>I</i></button>
                          <button className="cm-icon-btn" data-active={props.text.underline} title="Underline" onClick={() => setText({ underline: !props.text.underline })}><u>U</u></button>
                          <button className="cm-icon-btn" data-active={props.text.linethrough} title="Strikethrough" onClick={() => setText({ linethrough: !props.text.linethrough })}><s>S</s></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'left'} title="Align left" onClick={() => setText({ textAlign: 'left' })}><Icon name="align-left" size={14} /></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'center'} title="Align center" onClick={() => setText({ textAlign: 'center' })}><Icon name="align-h-center" size={14} /></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'right'} title="Align right" onClick={() => setText({ textAlign: 'right' })}><Icon name="align-right" size={14} /></button>
                        </div>
                        <div className="cm-slider-row">Line height <input type="range" min="0.8" max="2.5" step="0.05" value={props.text.lineHeight} onChange={e => setText({ lineHeight: +e.target.value })} /></div>
                        <div className="cm-slider-row">Letter spacing <input type="range" min="-100" max="800" step="10" value={props.text.charSpacing} onChange={e => setText({ charSpacing: +e.target.value })} /></div>
                      </React.Fragment>
                    )}

                    {props.hasFill && (
                      <React.Fragment>
                        <div className="cm-grp">Fill</div>
                        <div className="cm-row">
                          <button className="cm-btn" data-on={!props.shapeGradient} onClick={setSolidFillMode}>Solid</button>
                          <button className="cm-btn" data-on={!!props.shapeGradient} onClick={setGradientFillMode}>Gradient</button>
                        </div>
                        {!props.shapeGradient ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <input type="color" value={props.fill} title="Fill colour" onChange={e => setFillColor(e.target.value)} />
                            <span className="cm-note" style={{ margin: 0 }}>Colour of the selected shape or text.</span>
                          </div>
                        ) : (
                          <React.Fragment>
                            <div className="cm-row" style={{ marginTop: 8 }}>
                              <button className="cm-btn" data-on={props.shapeGradient.type === 'linear'} onClick={() => setShapeGradientPatch({ type: 'linear' })}>Linear</button>
                              <button className="cm-btn" data-on={props.shapeGradient.type === 'radial'} onClick={() => setShapeGradientPatch({ type: 'radial' })}>Radial</button>
                            </div>
                            {props.shapeGradient.type === 'linear' && (
                              <div className="cm-slider-row">Angle <input type="range" min="0" max="360" value={fgAngle} onChange={e => setShapeGradientPatch({ angle: +e.target.value })} /></div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                              {props.shapeGradient.stops.map((stop, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <input type="color" value={stop.color} onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, color: e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <input type="range" min="0" max="1" step="0.01" value={stop.offset} style={{ flex: 1 }} title="Position" onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, offset: +e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <input type="range" min="0" max="1" step="0.01" value={stop.alpha ?? 1} style={{ flex: 1 }} title="Opacity" onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, alpha: +e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <button className="cm-icon-btn" disabled={props.shapeGradient.stops.length <= 2} title="Remove stop"
                                    onClick={() => setShapeGradientPatch({ stops: props.shapeGradient.stops.filter((_, si) => si !== i) })}>
                                    <Icon name="close" size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="cm-row" style={{ marginTop: 6 }}>
                              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => {
                                const last = props.shapeGradient.stops[props.shapeGradient.stops.length - 1];
                                setShapeGradientPatch({ stops: [...props.shapeGradient.stops, { offset: Math.min(1, last?.offset ?? 1), color: last?.color || '#ffffff', alpha: last?.alpha ?? 1 }] });
                              }}>+ Add stop</button>
                              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} title="Reverse stop order"
                                onClick={() => setShapeGradientPatch({ stops: props.shapeGradient.stops.map(s => ({ ...s, offset: 1 - s.offset })).sort((a, b) => a.offset - b.offset) })}>
                                <Icon name="flip" size={13} /> Reverse
                              </button>
                            </div>
                          </React.Fragment>
                        )}
                      </React.Fragment>
                    )}

                    {props.hasBorder && (
                      <React.Fragment>
                        <div className="cm-grp">Border</div>
                        <div className="cm-slider-row">Width <input type="range" min="0" max="40" value={props.strokeWidth} onChange={e => setStroke({ width: +e.target.value })} /></div>
                        {props.strokeWidth > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                            <input type="color" value={props.stroke} title="Border colour" onChange={e => setStroke({ color: e.target.value })} />
                            <span className="cm-note" style={{ margin: 0 }}>Colour of the border/outline.</span>
                          </div>
                        )}
                      </React.Fragment>
                    )}

                    <div className="cm-grp">Blend &amp; opacity</div>
                    <select className="cm-select" value={props.blend} onChange={e => setBlend(e.target.value)}>
                      {BLEND_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <div className="cm-slider-row">Opacity <input type="range" min="0" max="1" step="0.05" value={props.opacity} onChange={e => setOpacity(+e.target.value)} /></div>

                    <div className="cm-grp">Transform</div>
                    <div className="cm-slider-row">Rotation <input type="range" min="0" max="360" value={props.angle} onChange={e => setNumeric({ angle: +e.target.value })} /></div>
                    <div className="cm-field-grid">
                      <label className="cm-field">X <input type="number" value={props.x} onChange={e => setNumeric({ x: +e.target.value })} /></label>
                      <label className="cm-field">Y <input type="number" value={props.y} onChange={e => setNumeric({ y: +e.target.value })} /></label>
                    </div>
                    <div className="cm-field-grid">
                      <label className="cm-field">W <input type="number" value={props.w} onChange={e => setNumeric({ w: +e.target.value })} /></label>
                      <label className="cm-field">H <input type="number" value={props.h} onChange={e => setNumeric({ h: +e.target.value })} /></label>
                    </div>
                    {props.isRect && (
                      <div className="cm-slider-row">Corner radius <input type="range" min="0" max={Math.max(1, Math.round(Math.min(props.w, props.h) / 2))} value={props.rx} onChange={e => setNumeric({ rx: +e.target.value })} /></div>
                    )}
                    <div className="cm-field-grid">
                      <label className="cm-field">Skew X <input type="number" value={props.skewX} onChange={e => setNumeric({ skewX: +e.target.value })} /></label>
                      <label className="cm-field">Skew Y <input type="number" value={props.skewY} onChange={e => setNumeric({ skewY: +e.target.value })} /></label>
                    </div>
                    <div className="cm-row" style={{ marginTop: 8 }}>
                      <button className="cm-btn" onClick={() => flip('x')}><Icon name="flip" size={13} /> Flip H</button>
                      <button className="cm-btn" onClick={() => flip('y')}><Icon name="flip" size={13} /> Flip V</button>
                    </div>
                    <div className="cm-row" style={{ marginTop: 6 }}>
                      <button className="cm-btn" onClick={centerH}><Icon name="move" size={13} /> Center H</button>
                      <button className="cm-btn" onClick={centerV}><Icon name="move" size={13} /> Center V</button>
                    </div>

                    <div className="cm-grp">Shadow</div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input type="color" value={props.shadow.color} title="Shadow colour" onChange={e => setShadow({ color: e.target.value })} />
                      <div className="cm-slider-row" style={{ flex: 1, marginTop: 0 }}>Blur <input type="range" min="0" max="60" value={props.shadow.blur} onChange={e => setShadow({ blur: +e.target.value })} /></div>
                    </div>
                    <div className="cm-field-grid">
                      <label className="cm-field">Offset X <input type="number" value={props.shadow.offsetX} onChange={e => setShadow({ offsetX: +e.target.value })} /></label>
                      <label className="cm-field">Offset Y <input type="number" value={props.shadow.offsetY} onChange={e => setShadow({ offsetY: +e.target.value })} /></label>
                    </div>
                    <button className="cm-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={clearShadow}>Clear shadow</button>
                  </React.Fragment>
                )}
              </div>
            )}

            {sideTab === 'design' && (
              <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Background &amp; fill</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="cm-btn" onClick={extendBackground}><Icon name="expand" size={13} />Extend background to canvas</button>
                  <button className="cm-btn" disabled={designBusy} onClick={aiExtendBackground}>
                    <Icon name="spark" size={13} />{designBusy ? 'Extending…' : 'AI extend background'}
                  </button>
                  <label className="cm-btn" style={{ position: 'relative' }}>
                    <Icon name="bucket" size={13} />Fill {props.hasSelectionPixels ? 'selection' : 'canvas'} with colour
                    <input type="color" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} onChange={e => fillWithColor(e.target.value)} />
                  </label>
                  <button className="cm-btn" onClick={fillWithImagePick}><Icon name="box" size={13} />Fill {props.hasSelectionPixels ? 'selection' : 'canvas'} with image</button>
                  <span className="cm-note" style={{ marginTop: 0 }}>Tip: pick the marquee / lasso tool (Tool tab) to target a region first.</span>
                  {designMsg && <div className="cm-note">{designMsg}</div>}
                </div>

                <div className="cm-grp">Add element</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="cm-btn" onClick={() => ed().setTool('type')}><Icon name="type" size={13} />Text</button>
                  <button className="cm-btn" onClick={() => ed().setTool('rect')}><Icon name="box" size={13} />Rectangle</button>
                  <button className="cm-btn" onClick={() => ed().setTool('ellipse')}><Icon name="eye" size={13} />Ellipse</button>
                  <button className="cm-btn" onClick={() => ed().setTool('line')}><Icon name="move" size={13} />Line</button>
                  <button className="cm-btn" onClick={addImagePick}><Icon name="duplicate" size={13} />Image</button>
                  <button className="cm-btn" onClick={() => ed().setTool('brush')}><Icon name="wand" size={13} />Brush</button>
                </div>
                <div className="cm-note">Drag any layer to move · pull the handles to resize · grab the top handle to rotate.</div>

                <div className="cm-grp">Ad copy</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="cm-btn" onClick={() => { ed().addCTA(null, { text: 'Shop now' }); ed().setTool('select'); }}><Icon name="spark" size={13} />CTA button</button>
                  <button className="cm-btn" onClick={() => { ed().addBadge(null, { text: 'Sale' }); ed().setTool('select'); }}><Icon name="hoverselect" size={13} />Badge</button>
                  <button className="cm-btn" onClick={() => { ed().addPrice(null, { current: '$29', original: '$40', save: 'Save 27%' }); ed().setTool('select'); }}><Icon name="box" size={13} />Price</button>
                  <button className="cm-btn" onClick={() => { ed().addBrandLockup(null, { text: 'Brand' }); ed().setTool('select'); }}><Icon name="box" size={13} />Brand lockup</button>
                </div>

                {assets.length > 0 && (
                  <React.Fragment>
                    <div className="cm-grp">Assets · click or drag in</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {assets.map(a => (
                        <div key={a.id} className="cm-asset-thumb" title={'Drag onto the canvas, or click to add · ' + a.name}
                          draggable
                          onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/x-canvasmith-asset', a.src); e.dataTransfer.setData('text/plain', a.src); }}
                          onClick={() => ed().addImage(a.src)}>
                          <img src={a.src} alt="" />
                          <span>{a.name}</span>
                        </div>
                      ))}
                    </div>
                  </React.Fragment>
                )}
              </div>
            )}

            {sideTab === 'stickers' && (
              <div>
                <p className="cm-note" style={{ marginTop: 0 }}>Click to add — it's a vector layer you can move, scale, rotate, recolour and (for text) restyle.</p>
                {STICKER_GROUPS.map(g => (
                  <React.Fragment key={g.label}>
                    <div className="cm-grp">{g.label}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      {g.keys.map(key => (
                        <button key={key} title={key} className="cm-icon-btn" style={{ width: '100%', height: 44 }} onClick={() => ed().addSticker(key)}>
                          <StickerPreview shapeKey={key} />
                        </button>
                      ))}
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}

            {sideTab === 'ai' && (
              <React.Fragment>
                <div className="cm-ai-card">
                  <div className="cm-ai-card-title"><Icon name="spark" size={15} style={{ color: 'var(--cm-accent)' }} />Magic edit</div>
                  <p>Describe a change in plain words — Canvasmith restyles the layers.</p>
                </div>
                {needKey ? (
                  <div className="cm-note">
                    AI runs on your own free Gemini key (Google includes free daily usage — no card).
                    Get one at <b>aistudio.google.com/apikey</b>, then paste it:
                    <input style={{ width: '100%', marginTop: 6 }} className="cm-ai-key" placeholder="AIza…" onKeyDown={e => { if (e.key === 'Enter') saveKey(e.target.value.trim()); }} />
                  </div>
                ) : (
                  <React.Fragment>
                    <textarea className="cm-ai-textarea" rows={3} placeholder={'e.g. "warmer accent, bigger headline" or set a headline in "quotes"'}
                      value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} />
                    <button className="cm-btn cm-btn-accent" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled={aiBusy || !aiPrompt.trim()} onClick={runAI}>
                      {aiBusy ? 'Working…' : <React.Fragment><Icon name="wand" size={14} />Apply magic edit</React.Fragment>}
                    </button>
                    {aiMsg && <div className="cm-note">{aiMsg}</div>}
                    <h4>Try</h4>
                    <div className="cm-ai-suggestions">
                      {['Warmer accent colour', 'Make the headline bigger', 'Set headline to "Big sale"'].map(s => (
                        <button key={s} className="cm-chip" onClick={() => setAiPrompt(s)}><Icon name="spark" size={11} />{s}</button>
                      ))}
                    </div>

                    <h4>Replace background</h4>
                    <input className="cm-ai-textarea" style={{ width: '100%' }} placeholder='e.g. "marble table, warm light"'
                      value={aiBgPrompt} onChange={e => setAiBgPrompt(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') runAiBgSwap(); }} />
                    <button className="cm-btn cm-btn-accent" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled={aiBusy || !aiBgPrompt.trim()} onClick={runAiBgSwap}>
                      {aiBusy ? 'Working…' : <React.Fragment><Icon name="spark" size={14} />Replace background</React.Fragment>}
                    </button>
                  </React.Fragment>
                )}

                <h4>Convert to layers</h4>
                <div className="cm-ai-card">
                  <div className="cm-ai-card-title"><Icon name="layers" size={15} style={{ color: 'var(--cm-accent)' }} />Convert to layers<span className="cm-chip" style={{ padding: '1px 7px', fontSize: 9.5 }}>guided</span></div>
                  <p>Detects objects and shows them as boxes — adjust, add or remove any, then create editable layers.</p>
                </div>
                <button className="cm-btn cm-btn-accent" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled={convertBusy || !!review} onClick={detectAndConvert}>
                  {convertBusy ? 'Detecting…' : <React.Fragment><Icon name="layers" size={14} />Detect &amp; convert to layers</React.Fragment>}
                </button>
                <button className="cm-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={convertBusy || !!review} onClick={selectOneManually}>
                  <Icon name="lasso" size={13} />Select one object manually
                </button>
                {convertMsg && <div className="cm-note" style={{ color: 'var(--cm-accent)' }}>{convertMsg}</div>}
                <div className="cm-note">Auto-detect everything, or draw one box yourself — adjust, add or remove boxes, then create layers.</div>
              </React.Fragment>
            )}
          </React.Fragment>
        )}
      </div>
      {compareOpen && (
        <div className="cm-compare-backdrop">
          <div className="cm-compare-header">
            <div>
              <strong>Compare</strong>
              <p>Compare your edited canvas with the first version you opened</p>
            </div>
            <button className="cm-btn" onClick={closeCompare}><Icon name="close" size={14} />Close</button>
          </div>
          <div className="cm-compare-panes">
            <div className="cm-compare-pane"><span className="cm-compare-label">Original</span><img src={compareSnapshotRef.current} alt="Original" /></div>
            <div className="cm-compare-pane"><span className="cm-compare-label">Current</span><img src={compareAfter} alt="Current" /></div>
          </div>
        </div>
      )}
      {cmdkOpen && (
        <div className="cm-cmdk-backdrop" onClick={e => { if (e.target === e.currentTarget) closeCmdk(); }}>
          <div className="cm-cmdk-box">
            <div className="cm-cmdk-search-row">
              <Icon name="search" size={16} />
              <input ref={cmdkInputRef} className="cm-cmdk-input" placeholder="Search tools & actions…" autoComplete="off"
                value={cmdkQuery}
                onChange={e => { setCmdkQuery(e.target.value); setCmdkIdx(0); }}
                onKeyDown={e => {
                  const items = cmdkFilteredItems();
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdkIdx(i => Math.min(items.length - 1, i + 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdkIdx(i => Math.max(0, i - 1)); }
                  else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(items[cmdkIdx]); }
                  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
                }} />
              <span className="cm-tag mono">Esc</span>
            </div>
            <div className="cm-cmdk-list">
              {cmdkFilteredItems().length === 0 ? (
                <div className="cm-cmdk-empty">No matching commands</div>
              ) : cmdkFilteredItems().map((it, i) => (
                <div key={it.group + it.label} className="cm-cmdk-item" data-on={i === cmdkIdx}
                  onMouseMove={() => { if (i !== cmdkIdx) setCmdkIdx(i); }}
                  onClick={() => runCmdkItem(it)}>
                  <Icon name={it.icon} size={15} />
                  <span className="lbl">{it.label}</span>
                  <span className="grp">{it.group}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function downloadURL(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export default CanvasmithEditor;
