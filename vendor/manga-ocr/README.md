# manga-ocr

`vocab.txt` is the tokenizer vocabulary of `kha-white/manga-ocr-base` (Apache License 2.0, https://github.com/kha-white/manga-ocr).

The model itself (`onnx-community/manga-ocr-base-ONNX`, int8-quantized encoder and decoder, about 117 MB) is too large to bundle. When a user selects the manga-ocr engine, Kotoba downloads it once from Hugging Face and keeps it in the extension's Cache Storage. Only the model files are requested; no page content or images are sent.
