const DEFAULTS = { seen: {}, settings: { autoMark: true, highlight: true } };
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULTS);
  await chrome.storage.local.set({ seen: current.seen || {}, settings: { ...DEFAULTS.settings, ...(current.settings || {}) } });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'lookup') {
    lookup(message.word).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
  if (message.type === 'recordVisible') {
    recordVisible(message.words || [], message.pageId).then(sendResponse).catch(() => sendResponse({}));
    return true;
  }
});

const lookupsInFlight = new Map();

async function recordVisible(words, pageId) {
  const { seen = {} } = await chrome.storage.local.get('seen');
  const now = Date.now();
  for (const word of new Set(words)) {
    if (!word) continue;
    const row = seen[word] || { count: 0, firstSeen: now, lastSeen: 0 };
    // Count at most once per page session, even if scrolling repeatedly exposes the same word.
    const sessionKey = `page:${pageId || 'unknown'}:${word}`;
    const session = await chrome.storage.session.get(sessionKey);
    if (!session[sessionKey]) {
      row.count += 1;
      await chrome.storage.session.set({ [sessionKey]: true });
    }
    // Refresh the date on every viewport observation, without counting scroll repeats.
    row.lastSeen = now;
    seen[word] = row;
  }
  await chrome.storage.local.set({ seen });
  return seen;
}

async function lookup(word) {
  if (!word || word.length > 40) return null;
  const { lexicon = {} } = await chrome.storage.local.get('lexicon');
  if (Object.prototype.hasOwnProperty.call(lexicon, word)) return lexicon[word];
  if (lookupsInFlight.has(word)) return lookupsInFlight.get(word);
  const request = fetchLookup(word).then(async result => {
    if (result) {
      const current = await chrome.storage.local.get({ lexicon: {} });
      await chrome.storage.local.set({ lexicon: { ...current.lexicon, [word]: result } });
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
