Text reader worker (task 12R.2)

worker.py       the reader: RapidOCR with PP-OCR models on onnxruntime. Started
                by the app (src/lib/free/ocr-worker.ts), one job at a time,
                no network. "--self-test" reads a drawn picture.
requirements.txt  exact versions with sha256 hashes (pip --require-hashes).
models.txt      the three model files with sha256 and where they come from.
                Fetched once at image build (fetch_models.py), checked again
                every time the worker starts. Never downloaded at run time.

Local use: make a venv with Python 3.11 and the requirements (or any Python
with rapidocr 3.10.0), then set OCR_PYTHON in .env.local (see .env.example).

Licences (all allow commercial use):
- rapidocr 3.10.0: Apache-2.0. PP-OCRv6 det and rec small and the
  ch_ppocr_mobile_v2.0 cls models: Apache-2.0 (Baidu / PaddleOCR, converted by
  RapidOCR; notice in rapidocr's MODEL_LICENSES.md, kept in the venv).
- onnxruntime: MIT. opencv-python-headless: Apache-2.0 (bundled libraries in
  its LICENSE-3RD-PARTY.txt). numpy: BSD-3-Clause and permissive parts.
  shapely: BSD-3-Clause (GEOS: LGPL-2.1, as a shared library). pyclipper,
  six, PyYAML, charset-normalizer, urllib3, colorlog: MIT. pillow: MIT-CMU.
  omegaconf, idna, protobuf: BSD-3-Clause. requests, flatbuffers: Apache-2.0.
  packaging: Apache-2.0 or BSD-2-Clause. tqdm: MPL-2.0 and MIT. certifi:
  MPL-2.0.
The licence files stay inside each package's dist-info folder in the image.
