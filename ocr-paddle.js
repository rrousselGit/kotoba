// PaddleOCR (PP-OCRv5 mobile) through ONNX Runtime: a DB text detector finds text regions,
// then a CTC recognizer reads each one. Vertical columns are rotated before recognition.
(() => {
  const { register, getURL, drawToCanvas, loadScript, reportStatus, hasJapanese } = kotobaOcr;
  const DET_LONG_SIDE = 960;
  const DET_THRESHOLD = 0.3;
  const DET_BOX_THRESHOLD = 0.6;
  const DET_UNCLIP_RATIO = 1.5;
  const REC_HEIGHT = 48;
  const REC_MIN_WIDTH = 320;
  const REC_MIN_SCORE = 0.5;
  // The converted models trigger harmless "unused initializer" warnings on every load.
  const QUIET = { logSeverityLevel: 3 };
  let models = null;

  async function loadOrt() {
    await loadScript('vendor/onnxruntime/ort.wasm.min.js');
    ort.env.wasm.wasmPaths = getURL('vendor/onnxruntime/');
    // Extension contexts are not cross-origin isolated, so ONNX threads are unavailable anyway;
    // the whole engine already runs in its own worker.
    ort.env.wasm.numThreads = 1;
    return ort;
  }

  function getModels() {
    models ??= (async () => {
      reportStatus('Loading PaddleOCR…');
      try {
        const ort = await loadOrt();
        const [det, rec, dict] = await Promise.all([
          ort.InferenceSession.create(getURL('vendor/paddleocr/det.onnx'), QUIET),
          ort.InferenceSession.create(getURL('vendor/paddleocr/rec.onnx'), QUIET),
          fetch(getURL('vendor/paddleocr/dict.txt')).then(r => r.text()),
        ]);
        // CTC class 0 is the blank; the dictionary follows, then a trailing space class.
        const chars = ['', ...dict.split('\n').filter((c, i, all) => c || i < all.length - 1), ' '];
        return { ort, det, rec, chars };
      } finally {
        reportStatus('');
      }
    })().catch(error => { models = null; throw error; });
    return models;
  }

  // Paddle models were trained on OpenCV images, so channels are fed in BGR order.
  function toTensor(ort, canvas, mean, std) {
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const plane = width * height;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) data[c * plane + i] = (pixels[i * 4 + 2 - c] / 255 - mean[c]) / std[c];
    }
    return new ort.Tensor('float32', data, [1, 3, height, width]);
  }

  // Returns text regions as pixel boxes of the original image.
  async function detect(bitmap) {
    const { ort, det } = await getModels();
    const scale = DET_LONG_SIDE / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(32, Math.round(bitmap.width * scale / 32) * 32);
    const height = Math.max(32, Math.round(bitmap.height * scale / 32) * 32);
    const canvas = drawToCanvas(bitmap, width, height);
    const input = toTensor(ort, canvas, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
    const output = await det.run({ [det.inputNames[0]]: input });
    const prob = output[det.outputNames[0]].data;

    // Connected components of the thresholded probability map are shrunken text kernels.
    const labels = new Int32Array(width * height);
    const stack = [];
    const boxes = [];
    for (let start = 0; start < prob.length; start++) {
      if (labels[start] || prob[start] <= DET_THRESHOLD) continue;
      let x0 = width, y0 = height, x1 = 0, y1 = 0, sum = 0, count = 0;
      labels[start] = 1;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        const x = i % width, y = (i / width) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        sum += prob[i]; count++;
        for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
          if (n >= 0 && !labels[n] && prob[n] > DET_THRESHOLD) { labels[n] = 1; stack.push(n); }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (Math.min(w, h) < 3 || sum / count < DET_BOX_THRESHOLD) continue;
      // Grow the kernel back to the full text extent, as DB's "unclip" step does.
      const d = (w * h * DET_UNCLIP_RATIO) / (2 * (w + h));
      const sx = bitmap.width / width, sy = bitmap.height / height;
      boxes.push({
        x0: Math.max(0, (x0 - d) * sx), y0: Math.max(0, (y0 - d) * sy),
        x1: Math.min(bitmap.width, (x1 + 1 + d) * sx), y1: Math.min(bitmap.height, (y1 + 1 + d) * sy),
      });
    }
    return boxes;
  }

  async function readRegion(bitmap, box) {
    const { ort, rec, chars } = await getModels();
    const cropW = box.x1 - box.x0, cropH = box.y1 - box.y0;
    const vertical = cropH >= cropW * 1.5;
    // Rotate vertical columns 90° counter-clockwise so the top of the column reads first.
    const lineW = vertical ? cropH : cropW, lineH = vertical ? cropW : cropH;
    const resizedW = Math.max(1, Math.ceil(REC_HEIGHT * lineW / lineH));
    const inputW = Math.max(REC_MIN_WIDTH, resizedW);
    const canvas = new OffscreenCanvas(inputW, REC_HEIGHT);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // Padding must normalize to 0, i.e. mid grey.
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(0, 0, inputW, REC_HEIGHT);
    const line = drawToCanvas(bitmap, vertical ? REC_HEIGHT : resizedW, vertical ? resizedW : REC_HEIGHT, box);
    if (vertical) {
      ctx.save();
      ctx.translate(0, REC_HEIGHT);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(line, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(line, 0, 0);
    }
    const input = toTensor(ort, canvas, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const output = await rec.run({ [rec.inputNames[0]]: input });
    const logits = output[rec.outputNames[0]];
    const [, steps, classes] = logits.dims;
    const data = logits.data;

    // Greedy CTC decoding, remembering at which step each character was emitted.
    const found = [];
    let previous = 0;
    for (let t = 0; t < steps; t++) {
      let best = 0, bestP = -Infinity;
      for (let c = 0; c < classes; c++) { const p = data[t * classes + c]; if (p > bestP) { bestP = p; best = c; } }
      if (best !== 0 && best !== previous && chars[best]?.trim()) found.push({ char: chars[best], step: t, p: bestP });
      previous = best;
    }
    if (!found.length) return null;
    const score = found.reduce((n, f) => n + f.p, 0) / found.length;
    const text = found.map(f => f.char).join('');
    if (score < REC_MIN_SCORE || !hasJapanese(text)) return null;

    // Map each emission step back to a position along the line, and split between neighbours.
    const along = vertical ? box.y0 : box.x0;
    const perStep = (inputW / steps) * (lineW / resizedW);
    const centers = found.map(f => along + (f.step + 0.5) * perStep);
    const half = Math.min(lineH, lineW / found.length) / 2;
    const boxes = [];
    found.forEach((f, i) => {
      const from = i ? (centers[i - 1] + centers[i]) / 2 : Math.max(along, centers[i] - half);
      const to = i < found.length - 1 ? (centers[i] + centers[i + 1]) / 2 : Math.min(along + lineW, centers[i] + half);
      const charBox = vertical ? [box.x0, from, box.x1, to] : [from, box.y0, to, box.y1];
      for (let j = 0; j < f.char.length; j++) boxes.push(charBox);
    });
    return { text, boxes, vertical };
  }

  register('paddle', async bitmap => {
    const lines = [];
    for (const box of await detect(bitmap)) {
      const line = await readRegion(bitmap, box);
      if (line) lines.push(line);
    }
    return { lines };
  });

  kotobaOcr.paddle = { detect, loadOrt, quiet: QUIET };
})();
