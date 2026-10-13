// Chrome service workers cannot start Web Workers, so this offscreen document hosts the OCR worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;
  if (message.type === 'ocrCancel') { kotobaOcr.cancel(message.keepEngine); return false; }
  if (message.type !== 'ocr') return false;
  kotobaOcr.recognize(message.request)
    .then(sendResponse)
    .catch(error => sendResponse({ error: String(error?.message || error) }));
  return true;
});
