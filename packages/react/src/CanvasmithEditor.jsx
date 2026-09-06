/* <CanvasmithEditor/> — the batteries-included UI over @canvasmith/core.
   Everything it does goes through the public Editor API, so anything you see here you can also
   build yourself against the core. Theme via the `theme` prop (CSS custom properties) layers on
   top of the built-in light/dark palettes, which the toolbar toggle switches between. */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Editor, ALL_TOOLS, PAINT_TOOLS, SEL_TOOLS, SHAPE_TOOLS, GeminiProvider, installBridge, installDropImport, installKeybindings, FONT_GROUPS, FONT_STYLESHEET_URL } from '@canvasmith/core';

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

const GROUPS = [
  { label: 'Move', tools: [['select', 'Select'], ['hand', 'Pan'], ['crop', 'Crop']] },
  { label: 'Paint', tools: [['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser'], ['clone', 'Clone'], ['heal', 'Heal'], ['dodge', 'Dodge'], ['burn', 'Burn'], ['sponge', 'Sponge'], ['redeye', 'Red-eye']] },
  { label: 'Select', tools: [['marquee', 'Marquee'], ['marquee-ellipse', 'Ellipse'], ['lasso', 'Lasso'], ['lasso-poly', 'Polygon lasso'], ['lasso-mag', 'Magnetic lasso'], ['wand', 'Wand'], ['objectselect', 'Object select'], ['hoverselect', 'Hover select']] },
  { label: 'Draw', tools: [['rect', 'Rect'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['triangle', 'Triangle'], ['polygon', 'Polygon'], ['star', 'Star'], ['type', 'Text'], ['bucket', 'Fill'], ['gradient', 'Gradient'], ['eyedropper', 'Pick']] },
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

const EMPTY_PROPS = {
  active: false, title: 'Properties', isImage: false, isAdjustment: false, fx: { brightness: 100, contrast: 100, saturate: 100, blur: 0, hue: 0, vibrance: 0, invert: false },
  text: null,
  hasFill: false, fill: '#d4ff45', shapeGradient: null, blend: 'source-over', opacity: 1,
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
  const fill = solidFill ? (fillTarget.fill.length === 4 ? '#' + [...fillTarget.fill.slice(1)].map(c => c + c).join('') : fillTarget.fill) : '#d4ff45';
  return {
    active: true,
    title: o.type === 'activeSelection' ? (o._objects ? o._objects.length + ' layers' : 'Selection') : (ed.layers().find(l => l.active)?.name || o.type || 'Layer'),
    isImage, isAdjustment,
    fx: isAdjustment ? ed.getAdjustmentParams(o.id) : isImage ? ed.getImageFilters() : EMPTY_PROPS.fx,
    text: ed.getTextProps(),
    hasFill, fill, shapeGradient,
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
  dark: { bg: '#141417', panel: '#1b1b20', line: '#2a2a31', ink: '#eceae4', dim: '#9a978f', accent: '#d4ff45', accentInk: '#111', stage: '#0e0e11' },
  light: { bg: '#f4f3ef', panel: '#ffffff', line: '#dedbd2', ink: '#1c1b18', dim: '#726f66', accent: '#6f6a00', accentInk: '#fff', stage: '#e4e2da' },
};

const CSS = `
.cm-root{--cm-bg:#141417;--cm-panel:#1b1b20;--cm-line:#2a2a31;--cm-ink:#eceae4;--cm-dim:#9a978f;--cm-accent:#d4ff45;--cm-accent-ink:#111;--cm-stage:#0e0e11;
  display:grid;grid-template-columns:52px 1fr 230px;grid-template-rows:44px 1fr;height:100%;min-height:480px;
  background:var(--cm-bg);color:var(--cm-ink);font:13px/1.45 system-ui,sans-serif;position:relative}
.cm-root[data-side-collapsed=true]{grid-template-columns:52px 1fr 0px}
.cm-top{grid-column:1/4;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--cm-line);background:var(--cm-panel)}
.cm-rail{display:flex;flex-direction:column;gap:2px;padding:6px 4px;border-right:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto}
.cm-rail button{all:unset;cursor:pointer;text-align:center;display:flex;align-items:center;justify-content:center;padding:9px 0;border-radius:7px;color:var(--cm-dim)}
.cm-rail button:hover{background:var(--cm-bg);color:var(--cm-ink)}
.cm-rail button[data-on=true]{background:var(--cm-accent);color:var(--cm-accent-ink)}
.cm-rail .cm-grp{font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--cm-dim);text-align:center;margin-top:8px}
.cm-stage{position:relative;overflow:hidden;display:grid;place-items:center;background:var(--cm-stage)}
.cm-side{border-left:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto;overflow-x:hidden;padding:10px;transition:padding .15s}
.cm-root[data-side-collapsed=true] .cm-side{padding:0;width:0}
.cm-side h4{margin:8px 0 6px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cm-dim)}
.cm-tabs{display:flex;gap:4px;margin-bottom:10px}
.cm-tabs button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;font-size:12.5px;font-weight:600;color:var(--cm-dim)}
.cm-tabs button:hover{background:var(--cm-bg)}
.cm-tabs button[data-on=true]{background:var(--cm-bg);color:var(--cm-ink)}
.cm-collapse{position:absolute;top:50%;right:229px;transform:translateY(-50%);width:22px;height:36px;border-radius:8px;
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
.cm-layer .cm-eye{cursor:pointer;opacity:.7;display:flex}
.cm-btn{all:unset;cursor:pointer;padding:5px 11px;border-radius:7px;border:1px solid var(--cm-line);font-size:12px;display:inline-flex;align-items:center;gap:6px}
.cm-btn:hover{border-color:var(--cm-accent)}.cm-btn:disabled{opacity:.4;cursor:default}
.cm-icon-btn{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid var(--cm-line);color:var(--cm-ink)}
.cm-icon-btn:hover{border-color:var(--cm-accent)}
.cm-icon-btn[data-active=true]{background:var(--cm-accent);color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-top input[type=range]{width:90px}.cm-top input[type=color]{width:26px;height:26px;border:none;background:none;cursor:pointer}
.cm-ai{display:flex;gap:6px;margin-top:6px}.cm-ai input{flex:1;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;color:var(--cm-ink);padding:5px 8px;font-size:12px}
.cm-note{font-size:11px;color:var(--cm-dim);margin-top:6px;line-height:1.5}
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
  const [opts, setOpts] = useState({ size: 30, opacity: 1, color: '#d4ff45', gradientType: 'linear', gradientStops: [{ offset: 0, color: '#d4ff45' }, { offset: 1, color: '#7c3aed' }] });
  const [layers, setLayers] = useState([]);
  const [maskEdit, setMaskEdit] = useState(null);
  const [hist, setHist] = useState({ past: 1, future: 0 });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [needKey, setNeedKey] = useState(false);
  const [mode_, setMode] = useState(mode || 'dark');
  const [sideTab, setSideTab] = useState('tool');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [snapOn, setSnapOn] = useState(true);
  const [props, setProps] = useState(EMPTY_PROPS);
  const [selMsg, setSelMsg] = useState('');

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
    // Figma-style smart guides while dragging — thin magenta lines showing what a layer just
    // snapped to. Drawn on fabric's shared top context, so it must redraw fabric's own top layer
    // (marquee box / control handles) first — clearContext wipes contextTop wholesale.
    let dragGuides = null;
    const drawGuides = () => {
      const ctx = ed.fc.contextTop; if (!ctx) return;
      ed.fc.clearContext(ctx);
      ed.fc.renderTopLayer(ctx);
      if (!dragGuides) return;
      const v = ed.fc.viewportTransform;
      ctx.save(); ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
      ctx.strokeStyle = '#ff2fc0'; ctx.lineWidth = 1 / v[0]; ctx.setLineDash([]);
      if (dragGuides.x) { ctx.beginPath(); ctx.moveTo(dragGuides.x.x, dragGuides.x.y0); ctx.lineTo(dragGuides.x.x, dragGuides.x.y1); ctx.stroke(); }
      if (dragGuides.y) { ctx.beginPath(); ctx.moveTo(dragGuides.y.x0, dragGuides.y.y); ctx.lineTo(dragGuides.y.x1, dragGuides.y.y); ctx.stroke(); }
      ctx.restore();
    };
    ed.fc.on('after:render', drawGuides);
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
    const offs = [
      ed.on('tool', setTool),
      ed.on('history', h => setHist(h)),
      ed.on('change', () => { setLayers(ed.layers()); refreshProps(); }),
      ed.on('tooloptions', o => setOpts({ size: o.size, opacity: o.opacity, color: o.color, gradientType: o.gradientType, gradientStops: o.gradientStops })),
      ed.on('guides', g => { dragGuides = g; ed.fc.requestRenderAll(); }),
      ed.on('selection', () => { refreshProps(); setSelMsg(''); }),
      ed.on('maskedit', m => { setMaskEdit(m); setLayers(ed.layers()); }),
    ];
    if (ai === 'gemini') {
      const p = new GeminiProvider();
      ed.ai.register(p);
      setNeedKey(!p.hasKey());
    } else if (ai && typeof ai === 'object') {
      ed.ai.register(ai);
    }
    const stops = [installKeybindings(ed)];
    if (bridge) {
      stops.push(installBridge(src => ed.openImage(src)));
      stops.push(installDropImport(stageRef.current, src => ed.addImage(src)));
    }
    if (image) ed.openImage(image);
    setLayers(ed.layers());
    onReady && onReady(ed);
    return () => { offs.forEach(f2 => f2()); stops.forEach(f2 => f2()); ed.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const ed = () => edRef.current;
  const pick = useCallback((t) => ed().setTool(t), []);
  const activeLayer = layers.find(l => l.active);
  const align = (edge) => activeLayer && ed().alignLayer(activeLayer.id, edge);
  const duplicate = () => activeLayer && ed().duplicateLayer(activeLayer.id);
  const toggleSnap = () => { const on = !snapOn; setSnapOn(on); ed().setSnapEnabled(on); };

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
  const DEFAULT_GRADIENT_STOPS = [{ offset: 0, color: '#d4ff45' }, { offset: 1, color: '#7c3aed' }];
  const setSolidFillMode = () => setFillColor(props.fill);
  const setGradientFillMode = () => ed().setShapeGradient((props.shapeGradient && props.shapeGradient.stops) || DEFAULT_GRADIENT_STOPS, 'linear', fgAngle);
  const setShapeGradientPatch = (patch) => {
    const cur = props.shapeGradient || { type: 'linear', stops: DEFAULT_GRADIENT_STOPS };
    const next = { ...cur, ...patch };
    if ('angle' in patch) setFgAngle(patch.angle);
    ed().setShapeGradient(next.stops, next.type, 'angle' in patch ? patch.angle : fgAngle);
  };
  const setBlend = (blend) => activeLayer && ed().setLayer(activeLayer.id, { blend });
  const setOpacity = (opacity) => activeLayer && ed().setLayer(activeLayer.id, { opacity });
  const setFillColor = (color) => ed().setFill(color);
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
  const saveKey = (k) => { ed().ai.provider().setKey(k); setNeedKey(!k); };

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
        <button className="cm-icon-btn" title={mode_ === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setMode(mode_ === 'dark' ? 'light' : 'dark')}>
          <Icon name={mode_ === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="cm-btn" onClick={() => { const u = ed().exportPNG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.png'); }}>⬇ PNG</button>
        <button className="cm-btn" onClick={() => { const u = ed().exportJPEG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.jpg'); }}>⬇ JPG</button>
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
      <div className="cm-stage" ref={stageRef}><canvas ref={canvasRef} /></div>
      <button className="cm-collapse" data-flip={sideCollapsed} title={sideCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setSideCollapsed(s => !s)}>
        <Icon name="chevron" size={13} />
      </button>
      <div className="cm-side">
        {!sideCollapsed && (
          <React.Fragment>
            <div className="cm-tabs">
              <button data-on={sideTab === 'tool'} onClick={() => setSideTab('tool')}><Icon name="tool" size={13} /> Tool</button>
              <button data-on={sideTab === 'props'} onClick={() => setSideTab('props')}><Icon name="box" size={13} /> Properties</button>
              <button data-on={sideTab === 'layers'} onClick={() => setSideTab('layers')}><Icon name="layers" size={13} /> Layers {layers.length ? <span style={{ color: 'var(--cm-dim)' }}>{layers.length}</span> : null}</button>
            </div>

            {sideTab === 'tool' && (
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
                    : 'Drag on the canvas to use this tool.'}
                </div>
                <button className="cm-toggle" data-on={snapOn} onClick={toggleSnap} style={{ marginTop: 10 }}>
                  {snapOn ? 'Snap: on' : 'Snap: off'}
                </button>

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
                {selMsg && <div className="cm-note">{selMsg}</div>}
              </div>
            )}

            {sideTab === 'props' && (
              <div>
                {!props.active ? (
                  <div className="cm-note" style={{ marginTop: 0 }}>Select a layer on the canvas or from the Layers panel to see and edit its properties.</div>
                ) : (
                  <React.Fragment>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
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

            {sideTab === 'layers' && (
              <React.Fragment>
                {layers.map(l => (
                  <div key={l.id} className="cm-layer" data-on={l.active} onClick={() => ed().activate(l.id)}>
                    <span className="cm-eye" onClick={e => { e.stopPropagation(); ed().setLayer(l.id, { visible: !l.visible }); }}><Icon name={l.visible ? 'eye' : 'eyeOff'} size={13} /></span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: l.visible ? 1 : 0.4 }}>{l.name}</span>
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
                    <span className="cm-eye" title="Delete" onClick={e => { e.stopPropagation(); ed().removeLayer(l.id); }}><Icon name="close" size={13} /></span>
                  </div>
                ))}
                <button className="cm-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => ed().addAdjustmentLayer()}>
                  <Icon name="contrast" size={13} /> Add adjustment layer
                </button>
                <h4>AI</h4>
                {needKey ? (
                  <div className="cm-note">
                    AI runs on your own free Gemini key (Google includes free daily usage — no card).
                    Get one at <b>aistudio.google.com/apikey</b>, then paste it:
                    <input style={{ width: '100%', marginTop: 6 }} className="cm-ai-key" placeholder="AIza…" onKeyDown={e => { if (e.key === 'Enter') saveKey(e.target.value.trim()); }} />
                  </div>
                ) : (
                  <React.Fragment>
                    <div className="cm-ai">
                      <input placeholder="e.g. make the background sunset" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runAI(); }} />
                      <button className="cm-btn" disabled={aiBusy} onClick={runAI}>{aiBusy ? '…' : '✦'}</button>
                    </div>
                    {aiMsg && <div className="cm-note">{aiMsg}</div>}
                  </React.Fragment>
                )}
              </React.Fragment>
            )}
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

function downloadURL(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export default CanvasmithEditor;
