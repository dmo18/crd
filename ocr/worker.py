"""Card Vault text reader worker: RapidOCR (PP-OCR models on onnxruntime).

Started by the app (src/lib/free/ocr-worker.ts) as one long-lived child
process. It reads one job at a time and never uses the network.

Protocol, one JSON object per line:
- The worker writes {"ready": true} once its models are loaded.
- The app writes {"id": <int>, "image": "<path to a PNG in the job folder>"}.
- The worker answers {"id": <int>, "width": w, "height": h, "lines": [...]},
  each line {"text", "score", "box": [[x, y] x 4], "turned"}, where "turned"
  means the line was printed upside down within its box (for sideways cards),
  or {"id": <int>, "error": "<short code>"}.

Settings come from the environment: CRD_OCR_JOB_DIR (the only folder images
are read from, required), CRD_OCR_MODELS_DIR (default: RapidOCR's own models
folder), CRD_OCR_THREADS (default 4).

`worker.py --self-test` reads a small drawn picture and fails if the text is
not found. The container build runs it to prove the reader works.

Never prints image data or read text anywhere except the answer line.
"""

import hashlib
import json
import os
import socket
import sys
import unicodedata
from pathlib import Path

# The answer channel is a private copy of stdout. Anything else that prints
# (libraries, warnings) goes to stderr, so it can never break the protocol.
_PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


class _NoNetwork(socket.socket):
    """The reader never needs the network. Any attempt fails at once."""

    def __init__(self, *args, **kwargs):  # noqa: D401
        raise OSError("network use is switched off in the text reader")


def _deny(*args, **kwargs):
    raise OSError("network use is switched off in the text reader")


# onnxruntime's own (C++) usage telemetry sends to Microsoft and does not go
# through Python's socket module, so it is switched off before it loads.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
socket.socket = _NoNetwork  # type: ignore[misc]
socket.create_connection = _deny  # type: ignore[assignment]
socket.getaddrinfo = _deny  # type: ignore[assignment]

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime  # noqa: E402
from rapidocr import RapidOCR  # noqa: E402
from rapidocr.utils.process_img import map_boxes_to_original  # noqa: E402

MODEL_LIST = Path(__file__).resolve().parent / "models.txt"
MAX_SIDE = 4000
MAX_LINES = 400
MAX_TEXT = 200
MAX_REQUEST = 4096
MIN_SCORE = 0.5


def _models_dir() -> Path:
    given = os.environ.get("CRD_OCR_MODELS_DIR", "").strip()
    if given:
        return Path(given)
    import rapidocr

    return Path(rapidocr.__file__).resolve().parent / "models"


def _checked_models() -> dict:
    """Paths of the three models, each checked against models.txt."""
    folder = _models_dir()
    found = {}
    for raw in MODEL_LIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        role, sha, name, _url = line.split()
        path = folder / name
        digest = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != sha:
            raise SystemExit(f"model file does not match its checksum: {name}")
        found[role] = str(path)
    if set(found) != {"det", "cls", "rec"}:
        raise SystemExit("models.txt must list det, cls and rec")
    return found


def make_engine() -> RapidOCR:
    onnxruntime.disable_telemetry_events()
    models = _checked_models()
    threads = int(os.environ.get("CRD_OCR_THREADS", "4"))
    threads = max(1, min(threads, 8))
    engine = RapidOCR(
        params={
            "Global.log_level": "error",
            "Global.text_score": MIN_SCORE,
            "Global.model_root_dir": str(_models_dir()),
            "Det.model_path": models["det"],
            "Cls.model_path": models["cls"],
            "Rec.model_path": models["rec"],
            "EngineConfig.onnxruntime.intra_op_num_threads": threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    # Load all three models now, so "ready" means the reader can read.
    engine._load_det_model()
    engine._load_cls_model()
    engine._load_rec_model()
    return engine


def _clean(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if ch.isprintable())
    return " ".join(text.split())[:MAX_TEXT]


def read(engine: RapidOCR, img: np.ndarray) -> list:
    """The steps of RapidOCR.__call__ (pinned 3.10.0), keeping the direction
    classifier's answer per line, which the plain call drops."""
    ori_h, ori_w = img.shape[:2]
    pre, op_record = engine.preprocess_img(img)
    det, cls, rec, _crops = engine.run_ocr_steps(pre, op_record)
    if det.boxes is None or rec.txts is None or rec.scores is None:
        return []
    boxes = map_boxes_to_original(det.boxes, op_record, ori_h, ori_w)
    angles = [c[0] for c in (cls.cls_res or [])]
    out = []
    for i, (box, txt, score) in enumerate(zip(boxes, rec.txts, rec.scores)):
        text = _clean(str(txt))
        if not text or float(score) < MIN_SCORE:
            continue
        pts = [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in np.asarray(box).reshape(-1, 2)[:4]]
        if len(pts) != 4:
            continue
        out.append({
            "text": text,
            "score": round(min(1.0, max(0.0, float(score))), 4),
            "box": pts,
            "turned": i < len(angles) and str(angles[i]) == "180",
        })
        if len(out) >= MAX_LINES:
            break
    return out


def _load(path_text: object, job_dir: Path):
    if not isinstance(path_text, str) or len(path_text) > 1024:
        return None
    path = Path(path_text).resolve()
    if path.parent != job_dir or path.suffix != ".png" or not path.is_file():
        return None
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None or img.ndim != 3:
        return None
    h, w = img.shape[:2]
    if h < 1 or w < 1 or h > MAX_SIDE or w > MAX_SIDE:
        return None
    return img


def _answer(obj: dict) -> None:
    _PROTO.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    _PROTO.flush()


def serve() -> None:
    job_dir_text = os.environ.get("CRD_OCR_JOB_DIR", "").strip()
    if not job_dir_text:
        raise SystemExit("CRD_OCR_JOB_DIR is not set")
    job_dir = Path(job_dir_text).resolve()
    engine = make_engine()
    _answer({"ready": True})
    for raw in sys.stdin.buffer:
        job_id = None
        try:
            if len(raw) > MAX_REQUEST:
                raise ValueError("request too long")
            job = json.loads(raw.decode("utf-8"))
            job_id = job.get("id") if isinstance(job, dict) else None
            if not isinstance(job_id, int) or isinstance(job_id, bool):
                raise ValueError("bad id")
            img = _load(job.get("image"), job_dir)
            if img is None:
                _answer({"id": job_id, "error": "bad_image"})
                continue
            lines = read(engine, img)
            _answer({"id": job_id, "width": int(img.shape[1]), "height": int(img.shape[0]), "lines": lines})
        except Exception:  # noqa: BLE001
            if isinstance(job_id, int) and not isinstance(job_id, bool):
                _answer({"id": job_id, "error": "read_failed"})
            else:
                _answer({"id": -1, "error": "bad_request"})


def self_test() -> None:
    img = np.full((160, 520, 3), 255, dtype=np.uint8)
    cv2.putText(img, "CARD 24", (20, 110), cv2.FONT_HERSHEY_SIMPLEX, 2.6, (20, 20, 20), 7, cv2.LINE_AA)
    lines = read(make_engine(), img)
    text = " ".join(line["text"] for line in lines).upper()
    if "CARD" not in text or "24" not in text:
        raise SystemExit("text reader self test failed")
    print("text reader self test ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        serve()
