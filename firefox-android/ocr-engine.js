// Shared OCR helpers and the engine registry, loaded in two places:
// - the OCR Web Worker (ocr-worker.js), which runs PaddleOCR and manga-ocr off the main thread;
// - the host page (ocr-host.js), which drives Tesseract. tesseract.js already recognizes in its
//   own worker, and nested workers are not available everywhere, so it stays on the host.
(() => {
  const jp = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const inWorker = typeof WorkerGlobalScope !== 'undefined';
  const engines = {};
  const scripts = new Set();

  // Both contexts live at the extension root, and workers have no extension APIs to ask.
  function getURL(path) {
    return new URL(path, self.location.href).href;
  }

  // Draws (part of) an image onto a white canvas; transparent pixels would otherwise read as black.
  function drawToCanvas(source, width, height, crop = null) {
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    if (crop) ctx.drawImage(source, crop.x0, crop.y0, crop.x1 - crop.x0, crop.y1 - crop.y0, 0, 0, canvas.width, canvas.height);
    else ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  // Loads a vendored script into the worker once (used for the large ONNX runtime).
  function loadScript(path) {
    if (!scripts.has(path)) { importScripts(getURL(path)); scripts.add(path); }
  }

  // The popup shows this while a model loads. The worker hands it to the host page. Firefox's
  // background page can write storage itself; Chrome's offscreen document relays it through
  // the service worker.
  function reportStatus(status) {
    if (inWorker) { self.postMessage({ type: 'status', status }); return; }
    const ext = globalThis.browser ?? chrome;
    if (ext.storage?.local) ext.storage.local.set({ ocrStatus: status }).catch(() => {});
    else ext.runtime.sendMessage({ type: 'ocrStatus', status }).catch(() => {});
  }

  // Per-character boxes spread evenly along a text line, for engines that only return line text.
  function evenBoxes(text, box, vertical) {
    const chars = [...text];
    const boxes = [];
    chars.forEach((char, i) => {
      const a = i / chars.length, b = (i + 1) / chars.length;
      const charBox = vertical
        ? [box[0], box[1] + (box[3] - box[1]) * a, box[2], box[1] + (box[3] - box[1]) * b]
        : [box[0] + (box[2] - box[0]) * a, box[1], box[0] + (box[2] - box[0]) * b, box[3]];
      for (let j = 0; j < char.length; j++) boxes.push(charBox);
    });
    return boxes;
  }

  function hasJapanese(text, min = 1) {
    return (text.match(jp) || []).length >= min;
  }

  async function run(engineId, bitmap) {
    const engine = engines[engineId];
    try {
      if (!engine) throw new Error(`Unknown OCR engine: ${engineId}`);
      const { lines } = await engine(bitmap);
      const round = n => Math.round(n * 10000) / 10000;
      // Engines report pixel boxes; the page wants fractions of the image size.
      return {
        lines: lines.map(line => ({
          text: line.text,
          vertical: !!line.vertical,
          boxes: line.boxes.map(([x0, y0, x1, y1]) => [round(x0 / bitmap.width), round(y0 / bitmap.height), round(x1 / bitmap.width), round(y1 / bitmap.height)]),
        })),
      };
    } finally {
      bitmap.close();
    }
  }

  self.kotobaOcr = {
    run,
    register(id, engine) { engines[id] = engine; },
    has(id) { return id in engines; },
    getURL, drawToCanvas, loadScript, reportStatus, evenBoxes, hasJapanese,
  };
})();
