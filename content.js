(() => {
  const dict = globalThis.KOTOBA_DICT || {};
  const jp = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  const marked = new WeakSet();
  let seen = {};
  let settings = { autoMark: true, highlight: true, ocr: false, ocrEngine: 'paddle' };
  let activeOverlay;
  const pageId = crypto.randomUUID();
  let tokenizer = null;
  let ready = false;

  function toHiragana(reading) {
    return [...reading].map(char => {
      const code = char.codePointAt(0);
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
    }).join('');
  }

  function tokenize(text) {
    if (tokenizer) {
      let offset = 0;
      const raw = tokenizer.tokenize(text).map(token => {
        const start = text.indexOf(token.surface_form, offset);
        const found = start >= 0 ? start : offset;
        offset = found + token.surface_form.length;
        return { word: token.surface_form, start: found, end: found + token.surface_form.length, reading: token.reading && token.reading !== '*' ? toHiragana(token.reading) : '' };
      }).filter(token => token.end > token.start && jp.test(token.word));
      const merged = [];
      for (let i = 0; i < raw.length;) {
        let combined = raw[i].word;
        let best = null;
        let bestEnd = i;
        for (let j = i + 1; j < Math.min(raw.length, i + 6); j++) {
          if (raw[j - 1].end !== raw[j].start) break;
          combined += raw[j].word;
          if (dict[combined]) { best = combined; bestEnd = j; }
        }
        if (best) {
          merged.push({ word: best, start: raw[i].start, end: raw[bestEnd].end, reading: dict[best][0] });
          i = bestEnd + 1;
        } else {
          merged.push(raw[i]);
          i++;
        }
      }
      return merged;
    }
    if (seg) return [...seg.segment(text)].filter(x => x.isWordLike && jp.test(x.segment)).map(x => ({ word: x.segment, start: x.index, end: x.index + x.segment.length, reading: '' }));
    return [...text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)].map(m => ({ word: m[0], start: m.index, end: m.index + m[0].length, reading: '' }));
  }
  function eligible(textNode) {
    const p = textNode.parentElement;
    if (!p || marked.has(p) || p.closest('script,style,noscript,textarea,input,select,button,code,pre,[contenteditable="true"],.kotoba-word,.kotoba-panel,.kotoba-ocr-layer')) return false;
    return jp.test(textNode.nodeValue || '');
  }
  function processNode(node) {
    if (!ready) return;
    if (node.nodeType === Node.TEXT_NODE) { if (eligible(node)) processText(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.kotoba-panel,.kotoba-ocr-layer')) return;
    if (ocrViewport) { if (node instanceof HTMLImageElement) watchImage(node); else for (const img of node.getElementsByTagName('img')) watchImage(img); }
    for (const child of [...node.childNodes]) processNode(child);
  }
  function processText(textNode) {
    const text = textNode.nodeValue;
    const tokens = tokenize(text);
    if (!tokens.length) return;
    const frag = document.createDocumentFragment(); let offset = 0;
    for (const t of tokens) {
      if (t.start < offset) continue;
      frag.append(document.createTextNode(text.slice(offset, t.start)));
      frag.append(createWordSpan(t)); offset = t.end;
    }
    frag.append(document.createTextNode(text.slice(offset)));
    textNode.replaceWith(frag);
  }
  function createWordSpan(t) {
    const span = document.createElement('span'); span.className = 'kotoba-word'; span.dataset.word = t.word;
    const reading = dict[t.word]?.[0] || (/[\p{Script=Han}]/u.test(t.word) && t.reading !== t.word ? t.reading : '');
    if (reading) span.dataset.reading = reading;
    const newWord = settings.autoMark && !seen[t.word];
    if (newWord) {
      span.classList.add('kotoba-new');
      if (reading) { const ruby = document.createElement('ruby'); ruby.append(document.createTextNode(t.word)); const rt = document.createElement('rt'); rt.textContent = reading; ruby.append(rt); span.append(ruby); }
      else span.textContent = t.word;
    } else span.textContent = t.word;
    span.title = newWord ? `New word · ${t.word}` : t.word;
    span.addEventListener('click', event => {
      event.stopPropagation();
      if (suppressClick === span) { suppressClick = null; return; }
      showPanel(span);
    });
    span.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        suppressClick = span;
        showPanel(span);
        setTimeout(() => { if (suppressClick === span) suppressClick = null; }, 1200);
      }, 450);
    });
    span.addEventListener('contextmenu', event => {
      if (suppressClick === span) event.preventDefault();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
      span.addEventListener(eventName, () => {
        clearTimeout(longPressTimer);
      });
    }
    span.addEventListener('pointerenter', () => {
      clearTimeout(hoverTimer);
      const sequence = ++hoverSequence;
      hoverTimer = setTimeout(() => showPanel(span, true, sequence), 3000);
    });
    span.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); hoverSequence++; });
    return span;
  }
  // --- Image text recognition (OCR) ---
  // Recognized words are overlaid on the image as transparent, clickable word spans.
  let ocrGeneration = 0;
  let ocrQueue = [];
  let ocrBusy = false;
  let ocrViewport = null;
  let ocrImages = new WeakMap();
  const ocrLayers = new Map();
  const ocrResize = new ResizeObserver(() => repositionLayers());
  function startOcr() {
    if (!ready || !settings.ocr || ocrViewport) return;
    ocrViewport = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { ocrViewport.unobserve(entry.target); queueOcr(entry.target); }
    }, { rootMargin: '300px' });
    for (const img of document.images) watchImage(img);
  }
  function stopOcr() {
    ocrGeneration++;
    ocrViewport?.disconnect(); ocrViewport = null;
    ocrQueue = []; ocrImages = new WeakMap();
    for (const layer of [...ocrLayers.keys()]) removeLayer(layer);
  }
  function watchImage(img) {
    if (!ocrViewport || ocrImages.has(img) || img.closest('.kotoba-panel')) return;
    ocrImages.set(img, { src: null, layer: null });
    ocrViewport.observe(img);
  }
  function queueOcr(img) {
    ocrQueue.push(img);
    if (!ocrBusy) drainOcr();
  }
  async function drainOcr() {
    ocrBusy = true;
    // Firefox suspends an idle background page after ~30 s, which would cut off a slow scan
    // or a model download; regular messages keep it awake while work is pending.
    const keepAlive = setInterval(() => (globalThis.browser ?? chrome).runtime.sendMessage({ type: 'keepAlive' }).catch(() => {}), 20000);
    while (ocrQueue.length) {
      const img = ocrQueue.shift();
      try { await recognizeImage(img); } catch (error) { console.debug('Kotoba: image recognition failed', error); }
    }
    clearInterval(keepAlive);
    ocrBusy = false;
  }
  function worthOcr(img) {
    return img.isConnected && img.naturalWidth * img.naturalHeight >= 48 * 24 && img.clientWidth >= 32 && img.clientHeight >= 16;
  }
  async function recognizeImage(img) {
    const generation = ocrGeneration;
    const state = ocrImages.get(img);
    if (!state) return;
    if (!img.complete) await new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); });
    const src = img.currentSrc || img.src;
    if (!src || state.src === src || !worthOcr(img)) return;
    state.src = src;
    const result = await (globalThis.browser ?? chrome).runtime.sendMessage({ type: 'ocr', src, dataUrl: await readableImageData(img, src), engine: settings.ocrEngine });
    if (generation !== ocrGeneration || state.src !== src) return;
    if (result?.error) throw new Error(result.error);
    removeLayer(state.layer);
    state.layer = renderOcrLayer(img, result?.lines || []);
  }
  // The extension can fetch normal URLs itself; page-local images (blob:, data:, same origin
  // behind cookies) are copied from the page instead.
  async function readableImageData(img, src) {
    let local = /^(data|blob):/.test(src);
    try { local ||= new URL(src).origin === location.origin; } catch {}
    if (!local) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      // toBlob encodes off the main thread, unlike toDataURL, so large images don't stall the page.
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return null;
      return await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  }
  function renderOcrLayer(img, lines) {
    const layer = document.createElement('span'); layer.className = 'kotoba-ocr-layer';
    for (const line of lines) {
      for (const t of tokenize(line.text)) {
        const boxes = line.boxes.slice(t.start, t.end);
        if (!boxes.length) continue;
        const x0 = Math.min(...boxes.map(b => b[0])), y0 = Math.min(...boxes.map(b => b[1]));
        const x1 = Math.max(...boxes.map(b => b[2])), y1 = Math.max(...boxes.map(b => b[3]));
        const span = createWordSpan(t); span.classList.add('kotoba-ocr-word');
        // Size the transparent text to fit the box so furigana sits centered beside the word:
        // above it for horizontal lines, to its right for vertical columns.
        const w = (x1 - x0) * 100, h = (y1 - y0) * 100;
        Object.assign(span.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${w}%`, height: `${h}%` });
        if (line.vertical) {
          span.classList.add('kotoba-ocr-vertical');
          Object.assign(span.style, { lineHeight: `${w}cqw`, fontSize: `min(${w * 0.85}cqw, ${h / t.word.length}cqh)` });
        } else {
          Object.assign(span.style, { lineHeight: `${h}cqh`, fontSize: `min(${h * 0.85}cqh, ${w / t.word.length}cqw)` });
        }
        // Words over a linked image should open the word panel, not follow the link.
        span.addEventListener('click', event => event.preventDefault());
        layer.append(span);
      }
    }
    if (!layer.childElementCount) return null;
    // A sibling shares the image's containing block, so it follows the image when the page scrolls.
    const anchor = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : img;
    anchor.after(layer);
    ocrLayers.set(layer, img);
    ocrResize.observe(img);
    positionLayer(layer, img);
    markVisible();
    return layer;
  }
  function removeLayer(layer) {
    if (!layer) return;
    const img = ocrLayers.get(layer);
    layer.remove(); ocrLayers.delete(layer);
    if (img && ![...ocrLayers.values()].includes(img)) ocrResize.unobserve(img);
  }
  function positionLayer(layer, img) {
    if (!img.isConnected) { removeLayer(layer); return; }
    const style = getComputedStyle(img);
    const px = name => parseFloat(style[name]) || 0;
    layer.style.zIndex = style.zIndex;
    layer.style.left = '0px'; layer.style.top = '0px';
    const origin = layer.getBoundingClientRect();
    const rect = img.getBoundingClientRect();
    layer.style.left = `${rect.left - origin.left + px('borderLeftWidth') + px('paddingLeft')}px`;
    layer.style.top = `${rect.top - origin.top + px('borderTopWidth') + px('paddingTop')}px`;
    layer.style.width = `${Math.max(0, img.clientWidth - px('paddingLeft') - px('paddingRight'))}px`;
    layer.style.height = `${Math.max(0, img.clientHeight - px('paddingTop') - px('paddingBottom'))}px`;
  }
  let repositionFrame = 0;
  function repositionLayers() {
    if (repositionFrame || !ocrLayers.size) return;
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0;
      for (const [layer, img] of [...ocrLayers]) positionLayer(layer, img);
    });
  }
  // Re-run recognition when an image's source changes (lazy loading, carousels).
  document.addEventListener('load', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !ocrViewport) return;
    const state = ocrImages.get(img);
    if (!state) { watchImage(img); return; }
    if (state.src && state.src !== (img.currentSrc || img.src)) queueOcr(img);
  }, true);
  function visibleWords() {
    const words = [];
    for (const el of document.querySelectorAll('.kotoba-word')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) words.push(el.dataset.word);
    }
    return words;
  }
  let timer;
  let hoverTimer;
  let longPressTimer;
  let suppressClick = null;
  let hoverSequence = 0;
  function markVisible() {
    clearTimeout(timer); timer = setTimeout(async () => {
      const words = visibleWords(); if (!words.length) return;
      const result = await (globalThis.browser ?? chrome).runtime.sendMessage({ type: 'recordVisible', words, pageId });
      // Recording a word should affect its next encounter, not erase the learning cue
      // from the page the user is currently reading.
      if (result) seen = result;
    }, 450);
  }
  async function showPanel(clickedEl, forceFurigana = false, sequence = null) {
    if (sequence !== null && sequence !== hoverSequence) return;
    activeOverlay?.remove();
    const word = clickedEl.dataset.word;
    const local = dict[word];
    let remote = null;
    if (!local) remote = await (globalThis.browser ?? chrome).runtime.sendMessage({ type: 'lookup', word });
    const reading = clickedEl.dataset.reading || local?.[0] || remote?.reading || '';
    const meanings = local ? [local[1]] : remote?.meanings || [];
    if (sequence !== null && sequence !== hoverSequence) return;
    if (forceFurigana && reading && !clickedEl.querySelector('ruby')) {
      const ruby = document.createElement('ruby'); ruby.textContent = word;
      const rt = document.createElement('rt'); rt.textContent = reading; ruby.append(rt);
      clickedEl.replaceChildren(ruby);
    }
    const panel = document.createElement('div'); panel.className = 'kotoba-panel';
    const header = document.createElement('div'); header.className = 'kotoba-head';
    const title = document.createElement('strong'); title.textContent = word; header.append(title);
    if (reading) { const r = document.createElement('span'); r.textContent = reading; r.className = 'kotoba-reading'; header.append(r); }
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label','Close'); close.onclick = () => panel.remove(); header.append(close); panel.append(header);
    const meaning = document.createElement('div'); meaning.className = 'kotoba-meaning'; meaning.textContent = meanings.join(' · ') || 'Meaning unavailable. Check your connection and try again.'; panel.append(meaning);
    const toggle = document.createElement('button'); toggle.className='kotoba-toggle'; toggle.textContent = clickedEl.querySelector('ruby') ? 'Hide furigana' : 'Show furigana';
    toggle.onclick = () => {
      const ruby = clickedEl.querySelector('ruby');
      if (ruby) { ruby.replaceWith(document.createTextNode(word)); toggle.textContent='Show furigana'; }
      else if (reading) { const ru=document.createElement('ruby'); ru.textContent=word; const rt=document.createElement('rt'); rt.textContent=reading; ru.append(rt); clickedEl.replaceChildren(ru); toggle.textContent='Hide furigana'; }
      else { toggle.textContent='Reading unavailable'; }
    };
    panel.append(toggle);
    const count = seen[word]?.count || 0; const meta = document.createElement('small');
    meta.textContent = count
      ? `Seen ${count} time${count===1?'':'s'} · first seen ${new Date(seen[word].firstSeen).toLocaleDateString(undefined, { dateStyle: 'medium' })} · last seen ${new Date(seen[word].lastSeen).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
      : 'Not yet counted as seen';
    panel.append(meta);
    document.body.append(panel); activeOverlay=panel;
    positionPanel(panel, clickedEl);
  }
  function positionPanel(panel, anchor) {
    const margin = 8;
    const gap = 8;
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = document.documentElement.clientHeight || innerHeight;
    panel.style.left = '0px';
    panel.style.top = '0px';
    panel.style.maxHeight = `${Math.max(80, viewportHeight - margin * 2)}px`;
    const panelRect = panel.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const width = panelRect.width;
    const height = panelRect.height;
    const minX = margin;
    const maxX = Math.max(minX, viewportWidth - width - margin);
    const minY = margin;
    const maxY = Math.max(minY, viewportHeight - height - margin);
    const alignX = Math.min(Math.max(minX, anchorRect.left), maxX);
    const belowY = anchorRect.bottom + gap;
    const aboveY = anchorRect.top - height - gap;
    let left = alignX;
    let top;

    if (belowY + height <= viewportHeight - margin) top = belowY;
    else if (aboveY >= margin) top = aboveY;
    else {
      const rightX = anchorRect.right + gap;
      const leftX = anchorRect.left - width - gap;
      if (rightX + width <= viewportWidth - margin) left = rightX;
      else if (leftX >= margin) left = leftX;
      top = Math.min(Math.max(minY, anchorRect.top + (anchorRect.height - height) / 2), maxY);
    }
    panel.style.left = `${Math.min(Math.max(minX, left), maxX)}px`;
    panel.style.top = `${Math.min(Math.max(minY, top), maxY)}px`;
  }
  document.addEventListener('click', e => { if (!e.target.closest('.kotoba-panel,.kotoba-word')) activeOverlay?.remove(); }, true);
  const settingsReady = new Promise(resolve => chrome.storage.local.get({ seen: {}, settings: { autoMark: true, highlight: true, ocr: false, ocrEngine: 'paddle' } }, data => { seen=data.seen||{}; settings={...settings,...data.settings}; resolve(); }));
  const analyzerReady = new Promise((resolve, reject) => {
    if (!globalThis.kuromoji) { reject(new Error('Kuromoji bundle did not load')); return; }
    kuromoji.builder({ dicPath: chrome.runtime.getURL('vendor/dict/') }).build((error, builtTokenizer) => {
      if (error) reject(error); else { tokenizer = builtTokenizer; resolve(); }
    });
  });
  Promise.all([settingsReady, analyzerReady]).then(() => {
    ready = true;
    processNode(document.body);
    markVisible();
    startOcr();
  }).catch(error => {
    console.warn('Kotoba: offline analyzer could not load; using browser segmentation.', error);
    settingsReady.then(() => { ready = true; processNode(document.body); markVisible(); startOcr(); });
  });
  const observer = new MutationObserver(records => { for (const rec of records) for (const node of rec.addedNodes) processNode(node); markVisible(); repositionLayers(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', markVisible, { passive:true }); addEventListener('resize', markVisible, { passive:true }); addEventListener('resize', repositionLayers, { passive:true });
  chrome.storage.onChanged.addListener((changes, area) => { if (area==='local' && changes.seen) seen=changes.seen.newValue||{};
    if (area==='local' && changes.settings) {
      const previousEngine = settings.ocrEngine;
      settings={...settings,...changes.settings.newValue};
      // A different engine reads images differently, so rescan them from scratch.
      if (settings.ocrEngine !== previousEngine) stopOcr();
      if (settings.ocr) startOcr(); else stopOcr();
    }
  });
})();
