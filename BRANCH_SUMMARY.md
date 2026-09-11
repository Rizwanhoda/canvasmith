# `feat/opencv-selection-tools` — what this branch adds

Base: `main` @ `4df3694`. 5 commits, 26 files, +5136/-162.

## 1. OpenCV-backed selection tools (`f6d45c1`)

- New `packages/core/src/cv/` module: `client.js` (CvEngine, runs OpenCV in a Web Worker) and `worker.js` (the worker itself, loads `opencv.js` and exposes flood-fill / GrabCut-style segmentation over RPC).
- New selection tools wired into the editor (`selection.js`, `editor.js`): object-select and hover-preview select, backed by `CvEngine`, falling back to plain flood-fill wand select when CV isn't available.
- `pixels.js` (new): selection-clipping and pixel extraction helpers (`selectionClipObject`, `renderSelectedPixels`) shared by fills, gradients, and filters.
- `color.js` (new): color/gradient utilities — recoloring pixels under a selection, gradient stop normalization, filter-spec construction.
- Properties panel added to both the vanilla demo (`apps/demo/index.html`) and the React wrapper (`CanvasmithEditor.jsx`) for inspecting/editing selection and layer state.
- `layout.js` gains alignment/layout helpers; `io.js` extended for the new layer types.

## 2. Click-drag shape sizing + multi-select alignment (`c499f40`)

- Shapes (`shapes.js`) can now be sized by click-and-drag instead of only click-to-place-default-size.
- Multi-select alignment actions (align left/right/top/bottom/center, distribute) added to the editor and demo toolbar.

## 3. Housekeeping (`e24c35b`)

- Removed two broken git submodule links (`.claude/worktrees/agent-*`) that had been committed by accident in `f6d45c1` with no `.gitmodules` entry — this broke `git clone` for anyone else. Added `.claude/worktrees/` to `.gitignore`.

## 4. Vendored OpenCV + Tier-1/Tier-2 features (`34b209c`)

**Tier 1 — audit fixes:**
- Vendored `opencv.js` locally under `packages/core/vendor/opencv/` (single-file UMD build, WASM embedded as base64) instead of fetching from `unpkg.com` at runtime. Fixes an absolute-URL resolution bug in the CV worker and removes an external runtime dependency so the no-build static site can serve everything from disk.
- React package's Properties panel brought to parity with the vanilla demo's.
- Wired up the previously-unused `CvEngine#detect()` into an actual "Auto-detect objects" tool.
- Unified keyboard shortcuts into a shared `installKeybindings()` (new `keybindings.js`) — adds tool-switch letter shortcuts and arrow-key nudging, used by both the demo and the React wrapper.
- Added a real Playwright browser-test suite (`test/editor.browser.test.mjs`, `test/fixtures/browser-editor.html`) covering the DOM/Fabric-dependent Editor/PaintEngine code paths that the existing Node test suite couldn't reach.

**Tier 2 — new features:**
- Typography panel: font family (curated system + Google Fonts list), size, weight, style, alignment, and letter-spacing controls for text layers.
- Multi-stop linear/radial gradients — for both the paint-tool gradient (previously non-functional; the drag handler was never actually wired up) and vector shape fills.
- Non-destructive, paintable layer masks for image/paint layers (new `mask.js`: mask canvas creation, stamp/line painting, serialize/deserialize).
- Non-destructive adjustment layers that composite everything below them in the stack via a scoped Fabric render capture.

**Bug fixes bundled in this commit:**
- Hardness-1 brush painted nothing (Canvas2D's radial gradient degenerates when inner/outer radius are equal).
- Forced Canvas2D filtering over WebGL so custom filters (masks, adjustments) can't silently no-op.

## 5. Refactor: bug fixes (`fd8078e`)

- Race-condition guards added via monotonic sequence tokens (`_wandSeq`, `_edgeMapSeq`), matching the existing `_hoverSeq` pattern:
  - A rapid double-click could let an earlier `wandPick` CV RPC resolve after a later one and clobber the newer selection — now the stale result is dropped.
  - An in-flight `buildMagneticEdgeMap()` can no longer land after a resize/crop invalidates it.
- `removeLayer()` now correctly tears down in-flight mask-edit state (cancels pending rAF mask refresh, clears `_maskEdit`/`_maskDrag`, emits `maskedit: null`) when the layer being deleted is the one currently being mask-painted.
- Additional fixes across `color.js`, `mask.js`, and the React wrapper (mask inversion support added: `invertMaskCanvas`), with corresponding test coverage added to `core.test.mjs`.

## Net result

Starting from a headless Fabric.js-based image editor, this branch adds: CV-backed smart selection (wand/object-select/hover-preview/auto-detect), a properties panel, typography controls, working gradients, non-destructive layer masks and adjustment layers, click-drag shape sizing, multi-select alignment, unified keybindings, a vendored offline-capable OpenCV runtime, a Playwright browser test suite, and several race-condition/rendering bug fixes — taking the editor from "basic drawing tool" toward "Photoshop-grade" selection and layer editing.
