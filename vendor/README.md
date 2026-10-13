# Bundled Japanese analyzer

This directory contains the browser build and IPA dictionary from `kuromoji` 0.1.2, published under the Apache License 2.0. The package source is https://github.com/takuyaa/kuromoji.js. See `LICENSE-2.0.txt` and `NOTICE.md` for the license and attribution.

The `.dat.gz` dictionary files are loaded from this extension's own `chrome-extension://` URL. No analyzer code or dictionary is fetched from a remote server at runtime.
- Kotoba patches `BrowserDictionaryLoader.prototype.loadArrayBuffer` to repair extension URLs that `path.join` collapses (`moz-extension://` → `moz-extension:/`), so the dictionary loads in Firefox.
