# Bundled PaddleOCR models

- `det.onnx`: `PaddlePaddle/PP-OCRv5_mobile_det_onnx` (text detection).
- `rec.onnx`: `PaddlePaddle/PP-OCRv5_mobile_rec_onnx` (recognition; Chinese, Japanese and English).
- `dict.txt`: the recognizer's character list, extracted from that model's `inference.yml`.

Both models are published by PaddlePaddle on Hugging Face under the Apache License 2.0 (see `../LICENSE-2.0.txt`). They are loaded from the extension's own URL.
