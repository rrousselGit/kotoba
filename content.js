(() => {
  const dict = globalThis.KOTOBA_DICT || {};
  const jp = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
  const marked = new WeakSet();
  let seen = {};
  let settings = { autoMark: true, highlight: true };
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
    if (!p || marked.has(p) || p.closest('script,style,noscript,textarea,input,select,button,code,pre,[contenteditable="true"],.kotoba-word,.kotoba-panel')) return false;
    return jp.test(textNode.nodeValue || '');
  }
  function processNode(node) {
    if (!ready) return;
    if (node.nodeType === Node.TEXT_NODE) { if (eligible(node)) processText(node); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.kotoba-panel')) return;
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
      span.addEventListener('click', event => { event.stopPropagation(); showPanel(span); });
      span.addEventListener('pointerenter', () => {
        clearTimeout(hoverTimer);
        const sequence = ++hoverSequence;
        hoverTimer = setTimeout(() => showPanel(span, true, sequence), 3000);
      });
      span.addEventListener('pointerleave', () => { clearTimeout(hoverTimer); hoverSequence++; });
      frag.append(span); offset = t.end;
    }
    frag.append(document.createTextNode(text.slice(offset)));
    textNode.replaceWith(frag);
  }
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
  let hoverSequence = 0;
  function markVisible() {
    clearTimeout(timer); timer = setTimeout(async () => {
      const words = visibleWords(); if (!words.length) return;
      const result = await chrome.runtime.sendMessage({ type: 'recordVisible', words, pageId });
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
    if (!local) remote = await chrome.runtime.sendMessage({ type: 'lookup', word });
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
    const rect=clickedEl.getBoundingClientRect(); panel.style.left=`${Math.min(Math.max(8,rect.left),innerWidth-320)}px`; panel.style.top=`${Math.min(rect.bottom+8,innerHeight-160)}px`;
  }
  document.addEventListener('click', e => { if (!e.target.closest('.kotoba-panel,.kotoba-word')) activeOverlay?.remove(); }, true);
  const settingsReady = new Promise(resolve => chrome.storage.local.get({ seen: {}, settings: { autoMark: true, highlight: true } }, data => { seen=data.seen||{}; settings={...settings,...data.settings}; resolve(); }));
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
  }).catch(error => {
    console.warn('Kotoba: offline analyzer could not load; using browser segmentation.', error);
    settingsReady.then(() => { ready = true; processNode(document.body); markVisible(); });
  });
  const observer = new MutationObserver(records => { for (const rec of records) for (const node of rec.addedNodes) processNode(node); markVisible(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', markVisible, { passive:true }); addEventListener('resize', markVisible, { passive:true });
  chrome.storage.onChanged.addListener((changes, area) => { if (area==='local' && changes.seen) seen=changes.seen.newValue||{}; });
})();
