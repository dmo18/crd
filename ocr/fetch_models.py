"""Downloads the text reader models listed in models.txt into a folder.

Used only while the container image is built (never at run time). Every file
is checked against its sha256 in models.txt; a wrong or missing file stops
the build. Only https addresses on the list are fetched.

    python3 -I fetch_models.py /opt/ocr/models
"""

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

LIST = Path(__file__).resolve().parent / "models.txt"
MAX_BYTES = 64 * 1024 * 1024
ALLOWED_PREFIX = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/"


def entries():
    for raw in LIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        role, sha, name, url = line.split()
        yield role, sha, name, url


def fetch(url: str, dest: Path, sha: str) -> None:
    if not url.startswith(ALLOWED_PREFIX):
        raise SystemExit(f"not an allowed model address: {url}")
    digest = hashlib.sha256()
    part = dest.with_suffix(dest.suffix + ".part")
    size = 0
    with urllib.request.urlopen(url, timeout=120) as resp, open(part, "wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_BYTES:
                raise SystemExit(f"model too large: {dest.name}")
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != sha:
        part.unlink()
        raise SystemExit(f"sha256 mismatch for {dest.name}")
    os.chmod(part, 0o644)
    part.rename(dest)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: fetch_models.py <folder>")
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    for _role, sha, name, url in entries():
        fetch(url, folder / name, sha)
        print(f"ok {name}")


if __name__ == "__main__":
    main()
