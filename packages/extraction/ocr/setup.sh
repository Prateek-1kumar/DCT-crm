#!/bin/sh
# Installs the local OCR for scanned contracts (ocr.ts): a Python venv with hash-pinned packages (requirements.txt,
# from requirements.in by `uv pip compile --universal --generate-hashes`) and the model files, each checked against its
# SHA-256 in models.json. Run by `pnpm run setup`; safe to run again. The only step that uses the network: the OCR itself
# never does (it runs sandboxed, and a model file that doesn't match is refused).
set -eu
cd "$(dirname "$0")"
PY="${OCR_PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.13 python3.11; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
if [ -z "$PY" ]; then
  echo "The OCR needs Python 3.11, 3.12 or 3.13 (set OCR_PYTHON to its path). Scans will be read without it." >&2
  exit 1
fi
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --disable-pip-version-check --require-hashes --no-deps -r requirements.txt
mkdir -p models
.venv/bin/python -I - <<'PY'
import hashlib, json, urllib.request
from pathlib import Path
for name, m in json.loads(Path("models.json").read_text())["files"].items():
    f = Path("models") / name
    ok = lambda: f.exists() and hashlib.sha256(f.read_bytes()).hexdigest() == m["sha256"]
    if not ok():
        urllib.request.urlretrieve(m["url"], f)
    if not ok():
        f.unlink(missing_ok=True)
        raise SystemExit(f"{name} doesn't match its checksum in models.json: not installed")
print("OCR ready")
PY
