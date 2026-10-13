// manga-ocr: a vision encoder-decoder trained on manga lettering. It only reads a text region,
// so PaddleOCR's detector finds the regions first. The model (~117 MB) is too large to bundle;
// it is downloaded from Hugging Face on first use and kept in the extension's Cache Storage.
(() => {
  const { register, getURL, drawToCanvas, reportStatus, evenBoxes, hasJapanese } = kotobaOcr;
  const MODEL_URL = 'https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/';
  const MODEL_FILES = { encoder: 'encoder_model_quantized.onnx', decoder: 'decoder_model_quantized.onnx' };
  const CACHE_NAME = 'kotoba-manga-ocr-v1';
  const SIZE = 224;
  const START_TOKEN = 2;
  const END_TOKEN = 3;
  const FIRST_TEXT_TOKEN = 5;
  const MAX_TOKENS = 100;
  let models = null;

  // Downloads a model file once, reporting progress, then serves it from Cache Storage.
  async function cachedModel(file, label) {
    const url = MODEL_URL + file;
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const response = await fetch(url);
    if (!response.ok) throw new Error(`manga-ocr download failed (${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (Date.now() - lastReport > 500) {
        lastReport = Date.now();
        const mb = n => Math.round(n / 1048576);
        reportStatus(`Downloading manga-ocr ${label}: ${mb(received)}${total ? ` / ${mb(total)}` : ''} MB`);
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
    return bytes;
  }

  function getModels() {
    models ??= (async () => {
      try {
        const ort = await kotobaOcr.paddle.loadOrt();
        const vocab = (await fetch(getURL('vendor/manga-ocr/vocab.txt')).then(r => r.text())).split('\n');
        const encoderBytes = await cachedModel(MODEL_FILES.encoder, 'encoder');
        const decoderBytes = await cachedModel(MODEL_FILES.decoder, 'decoder');
        reportStatus('Loading manga-ocr…');
        const encoder = await ort.InferenceSession.create(encoderBytes, kotobaOcr.paddle.quiet);
        const decoder = await ort.InferenceSession.create(decoderBytes, kotobaOcr.paddle.quiet);
        return { ort, vocab, encoder, decoder };
      } finally {
        reportStatus('');
      }
    })().catch(error => { models = null; throw error; });
    return models;
  }

  async function readRegion(bitmap, box) {
    const { ort, vocab, encoder, decoder } = await getModels();
    // Like manga-ocr's preprocessing: greyscale, stretched to 224×224, normalized to [-1, 1].
    const canvas = drawToCanvas(bitmap, SIZE, SIZE, box);
    const pixels = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE;
    const data = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const grey = (0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]) / 255;
      data[i] = data[plane + i] = data[2 * plane + i] = (grey - 0.5) / 0.5;
    }
    const encoded = await encoder.run({ [encoder.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
    const hidden = encoded[encoder.outputNames[0]];

    // Greedy decoding without a key/value cache; text regions are short, so this stays cheap.
    const tokens = [START_TOKEN];
    const probabilities = [];
    while (tokens.length < MAX_TOKENS) {
      const feeds = {};
      for (const name of decoder.inputNames) {
        if (name.includes('input_ids')) feeds[name] = new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
        else if (name.includes('encoder_hidden_states')) feeds[name] = hidden;
        else if (name.includes('attention_mask')) feeds[name] = new ort.Tensor('int64', new BigInt64Array(hidden.dims[1]).fill(1n), [1, hidden.dims[1]]);
      }
      const output = await decoder.run(feeds);
      const logits = output[decoder.outputNames[0]];
      const size = logits.dims[2];
      const last = logits.data.subarray((tokens.length - 1) * size, tokens.length * size);
      let best = 0;
      for (let i = 1; i < size; i++) if (last[i] > last[best]) best = i;
      if (best === END_TOKEN) break;
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.exp(last[i] - last[best]);
      probabilities.push(1 / sum);
      tokens.push(best);
    }
    const text = tokens.slice(1).filter(t => t >= FIRST_TEXT_TOKEN).map(t => (vocab[t] || '').replace(/^##/, '')).join('').replace(/\s+/g, '');
    const score = probabilities.reduce((n, p) => n + p, 0) / (probabilities.length || 1);
    if (!text || score < 0.4 || !hasJapanese(text)) return null;
    const vertical = (box.y1 - box.y0) > (box.x1 - box.x0);
    return { text, vertical, boxes: evenBoxes(text, [box.x0, box.y0, box.x1, box.y1], vertical) };
  }

  register('manga-ocr', async bitmap => {
    await getModels();
    const lines = [];
    for (const box of await kotobaOcr.paddle.detect(bitmap)) {
      const line = await readRegion(bitmap, box);
      if (line) lines.push(line);
    }
    return { lines };
  });
})();
