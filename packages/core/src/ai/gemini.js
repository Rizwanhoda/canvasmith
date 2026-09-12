/* GeminiProvider — AI features on Google's FREE daily quota.

   Google gives every Google account a free Gemini API key (aistudio.google.com/apikey) with a
   daily free-tier allowance — no card required. That is the "no token? use Google's free daily
   credits" path: the user pastes their free key once and the editor's AI tools light up. The key
   lives in the browser (localStorage) and requests go straight from the user's browser to Google,
   so an open-source deployment never proxies or pays for anyone's usage.

   Free-tier keys rate-limit rather than bill, so 429s are expected mid-day — they surface as
   'rate_limited' with the reset hint, never as a broken tool.

   SECURITY NOTE for hosts: this provider is for personal/self-hosted use. A SaaS should register
   its own server-side provider instead (see adapters/ditto) so no key ever ships to the client. */

const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const IMAGE_MODEL = 'gemini-2.5-flash-image';   // free-tier eligible image generation + editing
const TEXT_MODEL = 'gemini-2.5-flash';          // free-tier eligible vision/text
const STORE_KEY = 'canvasmith.gemini.key';

const dataUrlParts = (d) => {
  const m = /^data:([^;]+);base64,(.*)$/.exec(d || '');
  return m ? { mime: m[1], b64: m[2] } : null;
};

async function call(key, model, body) {
  const r = await fetch(API + model + ':generateContent?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(r.status === 429
      ? 'Free daily quota hit — it resets within 24h, or add billing to the key.'
      : 'Gemini error ' + r.status + ': ' + text.slice(0, 200));
    err.code = r.status;
    throw err;
  }
  return r.json();
}

const firstImage = (res) => {
  for (const part of (((res || {}).candidates || [{}])[0].content || {}).parts || []) {
    const d = part.inlineData || part.inline_data;
    if (d && String(d.mimeType || d.mime_type || '').startsWith('image')) {
      return 'data:' + (d.mimeType || d.mime_type) + ';base64,' + d.data;
    }
  }
  return null;
};

const firstText = (res) => {
  for (const part of (((res || {}).candidates || [{}])[0].content || {}).parts || []) {
    if (part.text) return part.text;
  }
  return '';
};

/* Some browser contexts (blocked third-party storage, certain privacy/incognito modes, sandboxed
   iframes) throw on ANY access to `localStorage`, not just typeof — `typeof localStorage` alone
   still throws in those cases, so every read/write here goes through a try/catch that treats a
   throw the same as "storage unavailable" instead of letting it crash the caller (module init, a
   key paste, ...). */
function safeStorageGet(k) { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; } }
function safeStorageSet(k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* storage unavailable — key just won't persist */ } }
function safeStorageRemove(k) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }

export class GeminiProvider {
  /* key: pass explicitly, or omit to read/persist from localStorage (personal use). */
  constructor({ key, persist = true } = {}) {
    this._persist = persist;
    this._key = key || (persist ? safeStorageGet(STORE_KEY) : null) || null;
  }

  setKey(key) {
    this._key = key || null;
    if (this._persist) {
      if (key) safeStorageSet(STORE_KEY, key);
      else safeStorageRemove(STORE_KEY);
    }
  }

  hasKey() { return !!this._key; }

  /* Where a user gets their free key — surfaced by UIs when hasKey() is false. */
  static keyInstructions() {
    return 'Get a free Gemini API key (no card needed): open aistudio.google.com/apikey, sign in '
         + 'with any Google account, and click "Create API key". Google includes a free daily '
         + 'usage allowance with every key.';
  }

  _need() {
    if (!this._key) {
      const e = new Error('No Gemini key set. ' + GeminiProvider.keyInstructions());
      e.code = 401;
      throw e;
    }
    return this._key;
  }

  /* maskDataURL is optional — Gemini's image model has no literal pixel-mask input channel (no
     guaranteed "only touch white-masked pixels"), so a mask is passed as a SECOND image part with
     explanatory text asking the model to treat it as an editing guide, rather than silently
     dropping the 3rd argument a caller (Editor#aiBgSwap/#aiExtendBackground) may supply. This is
     best-effort guidance, not a hard pixel guarantee the way a real inpainting API's mask channel
     would be — a host that needs pixel-exact masked edits should register a provider backed by a
     model with true mask support instead. */
  async magicEdit(imageDataURL, instruction, maskDataURL) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('magicEdit needs a dataURL image.');
    const mask = maskDataURL ? dataUrlParts(maskDataURL) : null;
    const parts = [
      { text: 'Edit this image. Apply exactly this instruction and change nothing else: ' + instruction },
      { inlineData: { mimeType: img.mime, data: img.b64 } },
    ];
    if (mask) {
      parts.push(
        { text: 'Use this second image as an editing mask: white areas may be changed, black areas must stay pixel-identical to the first image.' },
        { inlineData: { mimeType: mask.mime, data: mask.b64 } },
      );
    }
    const res = await call(key, IMAGE_MODEL, { contents: [{ parts }] });
    const out = firstImage(res);
    if (!out) throw new Error('The model returned no image (safety filter or refusal).');
    return out;
  }

  async generateImage(prompt, opts = {}) {
    const key = this._need();
    const res = await call(key, IMAGE_MODEL, {
      contents: [{ parts: [{ text: prompt + (opts.transparent ? ' On a plain solid white background, single subject centered.' : '') }] }],
    });
    const out = firstImage(res);
    if (!out) throw new Error('The model returned no image (safety filter or refusal).');
    return out;
  }

  async removeBackground(imageDataURL) {
    /* Image models can't emit real alpha reliably; ask for a clean solid background instead and
       let the host chroma-key it, or swap in a dedicated cutout provider for production use. */
    return this.magicEdit(imageDataURL,
      'Cut out the main subject perfectly and place it on a pure solid #00FF00 green background. '
      + 'Keep the subject pixels IDENTICAL — no relighting, no restyling.');
  }

  async describe(imageDataURL) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('describe needs a dataURL image.');
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [
        { text: 'Describe this image in one short sentence suitable as a layer name.' },
        { inlineData: { mimeType: img.mime, data: img.b64 } },
      ] }],
    });
    return firstText(res).trim();
  }

  async detectRegions(imageDataURL) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('detectRegions needs a dataURL image.');
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [
        { text: 'Detect the distinct visual regions of this image (product, logo, text, decorative). '
              + 'Reply with JSON ONLY: [{"type":"product|logo|text|decorative","content":"","bbox":{"x":0,"y":0,"width":0,"height":0}}] '
              + 'where bbox values are PERCENTAGES of the image size.' },
        { inlineData: { mimeType: img.mime, data: img.b64 } },
      ] }],
    });
    const text = firstText(res).replace(/```json|```/g, '').trim();
    try { const arr = JSON.parse(text); return Array.isArray(arr) ? arr : []; }
    catch (e) { return []; }
  }
}
