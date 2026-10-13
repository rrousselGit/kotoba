# Bundled OCR engine

This directory contains the files Kotoba needs to recognize Japanese text in images:

- `tesseract.min.js` and `worker.min.js` from `tesseract.js` 7.0.0 (Apache License 2.0, see `LICENSE-tesseract.js.md`).
- `tesseract-core-simd-lstm.wasm.js` from `tesseract.js-core` 7.0.0 (Apache License 2.0, see `LICENSE-tesseract.js-core`).
- `jpn.traineddata.gz` and `jpn_vert.traineddata.gz` from `@tesseract.js-data/jpn` and `@tesseract.js-data/jpn_vert` 1.0.0 (`4.0.0_best_int`), derived from the Tesseract `tessdata` models (Apache License 2.0).

All files are loaded from the extension's own URL. No OCR code, model or image data is sent to a remote server.
