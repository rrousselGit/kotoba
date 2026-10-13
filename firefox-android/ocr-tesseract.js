// Tesseract engines: horizontal (jpn), vertical (jpn_vert) and auto (runs both, keeps the better read).
(() => {
  const { register, getURL, drawToCanvas, hasJapanese, reportStatus } = kotobaOcr;
  const MIN_LINE_CONFIDENCE = 55;
  const workers = {};

  function getWorker(lang) {
    workers[lang] ??= (async () => {
      reportStatus('Loading Tesseract…');
      try {
        const worker = await Tesseract.createWorker(lang, 1 /* OEM.LSTM_ONLY */, {
          workerPath: getURL('vendor/tesseract/worker.min.js'),
          corePath: getURL('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
          langPath: getURL('vendor/tesseract'),
          workerBlobURL: false,
          cacheMethod: 'none',
          gzip: true,
        });
        // tesseract.js defaults to one horizontal block (PSM 6), which garbles vertical text
        // and images with several text areas; let Tesseract analyse the layout instead.
        await worker.setParameters({ tessedit_pageseg_mode: '3' });
        return worker;
      } finally {
        reportStatus('');
      }
    })().catch(error => { delete workers[lang]; throw error; });
    return workers[lang];
  }

  async function read(bitmap, lang) {
    const longest = Math.max(bitmap.width, bitmap.height);
    // Tesseract reads small glyphs poorly, so upscale small images and cap huge ones.
    const scale = longest < 1500 ? Math.min(2.5, 1500 / longest) : Math.min(1, 3000 / longest);
    const canvas = drawToCanvas(bitmap, bitmap.width * scale, bitmap.height * scale);
    const worker = await getWorker(lang);
    const { data } = await worker.recognize(await canvas.convertToBlob({ type: 'image/png' }), {}, { blocks: true });
    const lines = [];
    let score = 0;
    for (const block of data.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
      if (line.confidence < MIN_LINE_CONFIDENCE) continue;
      const lb = line.bbox;
      const symbols = line.words.flatMap(word => word.symbols).filter(symbol => symbol.text.trim());
      const vertical = lang === 'jpn_vert' && (lb.y1 - lb.y0) > (lb.x1 - lb.x0);
      // Tesseract sometimes stretches a CJK symbol's box to the end of its word or line,
      // so clamp each symbol to where the next one starts along the reading direction.
      const [start, end] = vertical ? ['y0', 'y1'] : ['x0', 'x1'];
      let text = '';
      const boxes = [];
      symbols.forEach((symbol, i) => {
        const next = symbols[i + 1]?.bbox[start];
        const from = symbol.bbox[start];
        const to = next > from ? Math.min(symbol.bbox[end], next) : symbol.bbox[end];
        // The line's cross extent gives every word in it the same size.
        const box = (vertical ? [lb.x0, from, lb.x1, to] : [from, lb.y0, to, lb.y1]).map(n => n / scale);
        for (const char of symbol.text) {
          if (/\s/.test(char)) continue;
          text += char;
          // One box per UTF-16 unit so analyzer offsets index straight into `boxes`.
          for (let j = 0; j < char.length; j++) boxes.push(box);
        }
      });
      if (!hasJapanese(text, 2)) continue;
      lines.push({ text, boxes, vertical });
      score += line.confidence * text.length;
    }
    return { lines, score };
  }

  // tesseract.js can only stop a running job by killing its worker; the next job starts a new one.
  kotobaOcr.cancelTesseract = () => {
    for (const lang of Object.keys(workers)) {
      workers[lang].then(worker => worker.terminate()).catch(() => {});
      delete workers[lang];
    }
  };

  register('tesseract', bitmap => read(bitmap, 'jpn'));
  register('tesseract-vertical', bitmap => read(bitmap, 'jpn_vert'));
  register('tesseract-auto', async bitmap => {
    const horizontal = await read(bitmap, 'jpn');
    const vertical = await read(bitmap, 'jpn_vert');
    return vertical.score > horizontal.score ? vertical : horizontal;
  });
})();
