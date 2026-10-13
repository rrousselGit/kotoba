# Kotoba for Firefox for Android

This is the Firefox for Android port of Kotoba, a local-first Japanese vocabulary learning extension. It carries over the Chrome build's bundled Kuromoji tokenizer and IPA dictionary, so word segmentation and furigana work offline without downloading dictionary data.

## Features

- Detects and segments Japanese words on web pages automatically.
- Highlights new vocabulary and displays furigana for new kanji words.
- Records encounters when words enter the visible viewport, avoiding duplicate counts from scrolling on one page. Stores first-seen and last-seen dates.
- Hides default furigana for previously encountered words while retaining new-word cues on the current page.
- Tap a word to open its meaning and encounter history, and toggle furigana. A three-second pointer hover also opens the same details panel on devices that support hover.
- Optional image text recognition: when enabled from the toolbar popup, Japanese text inside images becomes tappable with the same highlights, furigana, and details panel. Choose the recognition engine in the popup:
  - **PaddleOCR** (default): PP-OCRv5 text detection and recognition, bundled. Handles horizontal and vertical text and busy backgrounds. Fast.
  - **manga-ocr**: a model trained on manga lettering. Most accurate on speech bubbles. Its ~117 MB model is downloaded from Hugging Face on first use, then cached for offline use. Slow on phones.
  - **Tesseract**: lightweight and bundled, in horizontal, vertical, and auto (tries both) modes. Best on clean printed text.
- Search, export, and clear vocabulary history from the extension's vocabulary page.
- Runs analysis and stores history locally. If a word has no bundled English meaning, Kotoba sends only that word to Jisho when you open its details; it does not send the page URL or surrounding text.

## Install on Firefox for Android

Firefox for Android only installs signed extensions. To make a personal build:

1. Submit this directory as an unlisted add-on in [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and download the signed XPI after review/signing.
2. In Firefox for Android, open **Settings → About Firefox** and tap the Firefox logo five times to enable the secret menu.
3. Return to **Settings**, open **Install Extension from File**, and select the signed XPI.

For development, Mozilla's `web-ext` tool can build and temporarily install this extension on a connected Android device. See [Mozilla's Android extension guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/).

## Compatibility notes

This port uses Manifest V2 with a non-persistent background event page because Firefox for Android does not support extension service workers. Its add-on metadata declares page-text access because a word selected for a Jisho lookup is taken from website content. Image recognition runs in that background page; its content security policy allows WebAssembly (`wasm-unsafe-eval`) for the OCR engines. Recognition runs in Web Workers started from that page, so it never blocks the browser. While a scan or model download is running, open pages ping the background page so Firefox does not suspend it mid-scan. It requires Firefox 140 or newer for the current AMO data-collection declaration format.

## Licensing

Kotoba's original code is MIT-licensed. The bundled Kuromoji analyzer, IPA dictionary, OCR engines (Tesseract, ONNX Runtime) and models (Tesseract, PaddleOCR) retain their separate notices in `vendor/`.
