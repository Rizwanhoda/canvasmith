/* installKeybindings(editor, target?) — the one shortcut set both the vanilla demo and the React
   shell wire up, so they can't drift the way the Properties panel once did. Attaches to `target`
   (default: document) and returns a teardown function.

   Covers: undo/redo, copy/paste, duplicate (⌘D), delete-active-layer, select all (⌘A) / invert
   selection (⌘⇧I), tolerance scrub ([ / ]) for the wand/object/hover-select tools, Enter/Escape
   for the in-progress polygon/magnetic lasso or pen build, single-letter tool-switch shortcuts
   (Photoshop-standard where one exists), and arrow-key nudge (Shift = 10px) of the active
   layer/selection.

   Every handler skips while typing in a form field or editing text on the canvas (IText owns
   Backspace/arrows/Cmd+C/V there) — same guard the demo already used for undo/redo/copy/paste,
   now shared instead of copy-pasted. */

const TOOL_KEYS = {
  v: 'select', h: 'hand', c: 'crop',
  b: 'brush', n: 'pencil', e: 'eraser', s: 'clone', j: 'heal', o: 'dodge', u: 'burn', r: 'redeye',
  m: 'marquee', l: 'lasso', w: 'wand', q: 'objectselect', x: 'hoverselect',
  t: 'type', k: 'bucket', g: 'gradient', i: 'eyedropper', p: 'pen',
};

function isTypingTarget(editor) {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const active = editor.fc.getActiveObject();
  return !!(active && active.isEditing);
}

export function installKeybindings(editor, target = (typeof document !== 'undefined' ? document : null)) {
  if (!target) return () => {};

  const onKeyDown = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    // Polygon/magnetic lasso build: Enter commits, Escape cancels. Checked first and unconditionally
    // (no isTypingTarget guard) since a lasso build only exists mid-gesture on the canvas itself.
    if (['lasso-poly', 'lasso-mag'].includes(editor.tool) && editor._polyBuild) {
      if (e.key === 'Enter') { e.preventDefault(); editor.finishPolyLasso(); return; }
      if (e.key === 'Escape') { e.preventDefault(); editor.cancelPolyLasso(); return; }
    }

    // Pen tool build: Enter commits the path, Escape cancels it. Same unconditional/first-checked
    // treatment as the lasso build above — it only exists mid-gesture on the canvas.
    if (editor.tool === 'pen' && editor._penBuild) {
      if (e.key === 'Enter') { e.preventDefault(); editor.finishPen(); return; }
      if (e.key === 'Escape') { e.preventDefault(); editor.cancelPen(); return; }
    }

    // Escape cascade: back out of whatever's "live" one step at a time, most-specific first —
    // cancel an in-progress crop, else clear a pixel selection (marquee/lasso/wand), else deselect
    // the active object. Each branch returns after acting so a single Escape press only ever
    // backs out one level, matching how the reference editor's own Escape handling layers.
    if (e.key === 'Escape') {
      if (editor.tool === 'crop' && editor.crop) { e.preventDefault(); editor.setTool('select'); return; }
      if (editor.selection) { e.preventDefault(); editor.clearSelection(); return; }
      if (editor.fc.getActiveObject()) { e.preventDefault(); editor.fc.discardActiveObject(); editor.fc.renderAll(); return; }
    }

    if (isTypingTarget(editor)) return;

    // Undo/redo — Cmd+Z / Cmd+Shift+Z on Mac, Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) elsewhere.
    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); return; }
    if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) { e.preventDefault(); editor.redo(); return; }

    // Copy/paste — clipboard lives on the Editor (see copySelection/pasteClipboard).
    if (mod && key === 'c') {
      if (editor.fc.getActiveObject()) { e.preventDefault(); editor.copySelection(); }
      return;
    }
    if (mod && key === 'v') {
      if (editor._clipboard) { e.preventDefault(); editor.pasteClipboard(); }
      // else: fall through to the browser's native paste (an OS-clipboard image via
      // installDropImport's paste listener), same contract as before this was shared.
      return;
    }

    // Duplicate active layer — ⌘D/Ctrl+D.
    if (mod && key === 'd') {
      const layer = editor.layers().find(l => l.active);
      if (layer) { e.preventDefault(); editor.duplicateLayer(layer.id); }
      return;
    }

    // Pixel-selection commands: select all (⌘A), invert (⌘⇧I) — mirror the reference editor's
    // shortcuts for the marquee/lasso/wand selection system (distinct from object selection).
    if (mod && key === 'a') { e.preventDefault(); editor.selectAll(); return; }
    if (mod && e.shiftKey && key === 'i') { e.preventDefault(); editor.invertSelection(); return; }

    // Tolerance scrub: [ / ] nudge the wand/object/hover-select tolerance by 4, live, while one of
    // those tools is active — lets you fine-tune a pick without reaching for the slider.
    if ((e.key === '[' || e.key === ']') && ['wand', 'objectselect', 'hoverselect'].includes(editor.tool)) {
      e.preventDefault();
      const cur = editor.toolOpts.tolerance || 0;
      const next = Math.max(0, Math.min(128, cur + (e.key === ']' ? 4 : -4)));
      editor.setToolOptions({ tolerance: next });
      return;
    }

    // Delete/Backspace: remove the active layer (or every layer in a multi-selection).
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const active = editor.fc.getActiveObject();
      if (!active) return;
      e.preventDefault();
      if (active.type === 'activeSelection') {
        active.getObjects().slice().forEach(o => o.id && editor.removeLayer(o.id));
        editor.fc.discardActiveObject(); editor.fc.renderAll();
      } else {
        const layer = editor.layers().find(l => l.active);
        if (layer) editor.removeLayer(layer.id);
      }
      return;
    }

    // Arrow-key nudge: 1px, or 10px with Shift — moves the active object/activeSelection.
    if (e.key.startsWith('Arrow')) {
      const active = editor.fc.getActiveObject();
      if (!active) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      active.set({ left: (active.left || 0) + dx, top: (active.top || 0) + dy });
      active.setCoords();
      editor.fc.renderAll();
      editor.commit('nudge');
      return;
    }

    // Single-letter tool switch (no modifier — Cmd/Ctrl+<letter> stays a browser/OS shortcut).
    if (!mod && !e.altKey && TOOL_KEYS[key]) { e.preventDefault(); editor.setTool(TOOL_KEYS[key]); return; }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

export { TOOL_KEYS };
