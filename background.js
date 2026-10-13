// Firefox MV2 only returns promises from the `browser` namespace.
const ext = globalThis.browser ?? chrome;
const DEFAULTS = { seen: {}, settings: { autoMark: true, highlight: true, ocr: false, ocrEngine: 'paddle' } };
ext.runtime.onInstalled.addListener(async () => {
  const current = await ext.storage.local.get(DEFAULTS);
  await ext.storage.local.set({ seen: current.seen || {}, settings: { ...DEFAULTS.settings, ...(current.settings || {}) } });
});

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'lookup') {
    lookup(message.word).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === 'recordVisible') {
    recordVisible(message.words || [], message.pageId).then(sendResponse).catch(() => sendResponse({}));
    return true;
  }
  if (message.type === 'ocr') {
    recognizeImage(message).then(sendResponse).catch(error => sendResponse({ error: String(error?.message || error) }));
    return true;
  }
  // Relayed from the offscreen document, which cannot use extension storage itself.
  if (message.type === 'ocrStatus') {
    ext.storage.local.set({ ocrStatus: message.status || '' });
    return false;
  }
});

const lookupsInFlight = new Map();

async function recordVisible(words, pageId) {
  const { seen = {} } = await ext.storage.local.get('seen');
  const now = Date.now();
  for (const word of new Set(words)) {
    if (!word) continue;
    const row = seen[word] || { count: 0, firstSeen: now, lastSeen: 0 };
    // Count at most once per page session, even if scrolling repeatedly exposes the same word.
    const sessionKey = `page:${pageId || 'unknown'}:${word}`;
    const session = await ext.storage.session.get(sessionKey);
    if (!session[sessionKey]) {
      row.count += 1;
      await ext.storage.session.set({ [sessionKey]: true });
    }
    // Refresh the date on every viewport observation, without counting scroll repeats.
    row.lastSeen = now;
    seen[word] = row;
  }
  await ext.storage.local.set({ seen });
  return seen;
}

async function lookup(word) {
  if (!word || word.length > 40) return null;
  const { lexicon = {} } = await ext.storage.local.get('lexicon');
  if (Object.prototype.hasOwnProperty.call(lexicon, word)) return lexicon[word];
  if (lookupsInFlight.has(word)) return lookupsInFlight.get(word);
  const request = fetchLookup(word).then(async result => {
    if (result) {
      const current = await ext.storage.local.get({ lexicon: {} });
      await ext.storage.local.set({ lexicon: { ...current.lexicon, [word]: result } });
    }
    return result;
  }).finally(() => lookupsInFlight.delete(word));
  lookupsInFlight.set(word, request);
  return request;
}

async function fetchLookup(word) {
  try {
    const response = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    const item = payload.data?.find(x => x.japanese?.some(j => j.word === word || j.reading === word)) || payload.data?.[0];
    if (!item) return null;
    const exact = item.japanese?.find(j => j.word === word) || item.japanese?.[0];
    return { reading: exact?.reading || '', meanings: (item.senses || []).slice(0, 3).map(s => s.english_definitions?.join('; ')).filter(Boolean), forms: item.japanese || [] };
  } catch { return null; }
}

let offscreenCreating = null;

// Turning image recognition off, or switching engine, kills scans that are still running.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};
  const engine = settings => settings.ocrEngine || 'paddle';
  if (before.ocr && (!after.ocr || engine(before) !== engine(after))) cancelRecognition(after.ocr ? engine(after) : null);
});

async function cancelRecognition(keepEngine) {
  if (globalThis.kotobaOcr) { globalThis.kotobaOcr.cancel(keepEngine); return; }
  // Don't start an offscreen document just to cancel; if there is none, nothing is running.
  const contexts = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [ext.runtime.getURL('offscreen.html')] });
  if (contexts.length) ext.runtime.sendMessage({ target: 'offscreen', type: 'ocrCancel', keepEngine }).catch(() => {});
}

async function recognizeImage({ src, dataUrl, engine }) {
  const request = { src, dataUrl, engine };
  // Firefox loads the OCR engine into this background page directly.
  if (globalThis.kotobaOcr) return globalThis.kotobaOcr.recognize(request);
  await ensureOffscreenDocument();
  return ext.runtime.sendMessage({ target: 'offscreen', type: 'ocr', request });
}

async function ensureOffscreenDocument() {
  const url = ext.runtime.getURL('offscreen.html');
  const contexts = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length) return;
  offscreenCreating ??= ext.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Recognize Japanese text in page images',
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}
