// Dedicated worker that runs the ONNX engines (PaddleOCR, manga-ocr) off the main thread.
importScripts('ocr-engine.js', 'ocr-paddle.js', 'ocr-manga.js');

// ONNX sessions cannot run two inferences at once, so jobs from several tabs run one at a time.
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data.type !== 'recognize') return;
  queue = queue.then(() => kotobaOcr.run(data.engine, data.bitmap))
    .then(result => self.postMessage({ type: 'result', id: data.id, result }))
    .catch(error => self.postMessage({ type: 'result', id: data.id, error: String(error?.message || error) }));
};
