// Entry point for OCR requests. Runs in Chrome's offscreen document or Firefox's background page.
// It downloads and decodes images (both asynchronous) and caches results; recognition itself
// happens in workers so this page never blocks: PaddleOCR and manga-ocr in ocr-worker.js,
// Tesseract in the worker tesseract.js manages (see ocr-tesseract.js).
(() => {
  const ext = globalThis.browser ?? chrome;
  const DEFAULT_ENGINE = 'paddle';
  const WORKER_ENGINES = ['paddle', 'manga-ocr'];
  const MAX_CACHE = 100;
  const cache = new Map();
  const pending = new Map();
  const active = new Set();
  let worker = null;
  let nextId = 0;

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(ext.runtime.getURL('ocr-worker.js'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') { kotobaOcr.reportStatus(data.status); return; }
      const call = pending.get(data.id);
      if (!call) return;
      pending.delete(data.id);
      if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
    };
    // A crashed worker (e.g. out of memory) fails its jobs; the next request starts a fresh one.
    worker.onerror = event => {
      event.preventDefault();
      for (const call of pending.values()) call.reject(new Error(event.message || 'OCR worker crashed'));
      pending.clear();
      worker = null;
      kotobaOcr.reportStatus('');
    };
    return worker;
  }

  async function start({ src, dataUrl }, engine, signal) {
    const response = await fetch(dataUrl || src, { credentials: 'include', signal });
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const bitmap = await createImageBitmap(await response.blob());
    if (signal.aborted) { bitmap.close(); throw new Error('Recognition cancelled'); }
    if (!WORKER_ENGINES.includes(engine)) return kotobaOcr.run(engine, bitmap);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Transferring the bitmap hands it to the worker without copying the pixels.
      getWorker().postMessage({ type: 'recognize', id, engine, bitmap }, [bitmap]);
    });
  }

  // Runs (or reruns) a job. Only the latest attempt may settle it, so a killed worker's
  // leftovers cannot resolve a job that was cancelled or restarted.
  function attempt(job) {
    const token = {};
    job.attempt = token;
    job.controller = new AbortController();
    start(job.request, job.engine, job.controller.signal).then(
      result => { if (job.attempt === token) { active.delete(job); job.resolve(result); } },
      error => { if (job.attempt === token) { active.delete(job); job.reject(error); } },
    );
  }

  function run(request, engine) {
    return new Promise((resolve, reject) => {
      const job = { request, engine, resolve, reject };
      active.add(job);
      attempt(job);
    });
  }

  // Kills every job not using `keepEngine` (all jobs when it is null). Engines can only be
  // interrupted by terminating their worker, so jobs for the kept engine that shared that
  // worker are restarted on a fresh one.
  function cancel(keepEngine = null) {
    const doomed = [...active].filter(job => job.engine !== keepEngine);
    if (!doomed.length) return;
    for (const job of doomed) {
      active.delete(job);
      job.attempt = null;
      job.controller.abort();
      job.reject(new Error('Recognition cancelled'));
    }
    const inWorker = job => WORKER_ENGINES.includes(job.engine);
    if (doomed.some(inWorker) && worker) {
      worker.terminate();
      worker = null;
      pending.clear();
      for (const job of active) if (inWorker(job)) attempt(job);
    }
    if (doomed.some(job => !inWorker(job))) {
      kotobaOcr.cancelTesseract();
      for (const job of active) if (!inWorker(job)) attempt(job);
    }
    kotobaOcr.reportStatus('');
  }

  function recognize(request) {
    const engine = WORKER_ENGINES.includes(request.engine) || kotobaOcr.has(request.engine) ? request.engine : DEFAULT_ENGINE;
    const key = `${engine}|${request.src || request.dataUrl}`;
    if (cache.has(key)) return cache.get(key);
    const result = run(request, engine);
    cache.set(key, result);
    result.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return result;
  }

  kotobaOcr.recognize = recognize;
  kotobaOcr.cancel = cancel;
})();
