"""Local OCR of scanned contract pages: PaddleOCR PP-OCRv5 (mobile) through RapidOCR, ONNX on the CPU.

    python -I worker.py <models dir> <models.json>

Checks every model file against its SHA-256 in models.json before reading anything, then answers one JSON line on
stdout per request line on stdin ({"id", "png": base64}):

    {"id", "turned": 0|90|270, "words": [{text, conf, bbox, line}], "unread": [[x0, y0, x1, y1]], "ms"}

bbox and unread are pixels of the image as read (the page turned clockwise by `turned`). `unread`: areas with ink no
word covers (a stamp, handwriting, a picture, text too blurred to read), table rulings left out. An error is answered
as {"id", "error": "<class name>"}: never any of the page's text, here or on stderr. The caller runs this with no
network (ocr.ts); nothing here opens one: the models are local files.
"""

import base64
import hashlib
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from rapidocr import ModelType, OCRVersion, RapidOCR

# A page read upright whose text boxes mostly stand taller than wide, or that yields few confident words, is read
# turned both ways too; the reading with the most confident words wins.
CONFIDENT = 0.8
# An unread area counts when it covers 5% of the page in the body, or 15% in the top or bottom tenth (letterheads),
# the same sizes a picture on a text page must reach (textlayer.ts largePicture). Signatures and initials are smaller.
BODY_AREA, EDGE_AREA = 0.05, 0.15


def check_models(models: Path, manifest: Path) -> dict:
    files = json.loads(manifest.read_text())["files"]
    for name, meta in files.items():
        if hashlib.sha256((models / name).read_bytes()).hexdigest() != meta["sha256"]:
            raise ValueError("model checksum")
    return files


def engine(models: Path, files: dict):
    p = lambda role: str(models / next(n for n, m in files.items() if m["role"] == role))
    # the settings the bake-off measured (PP-OCRv5 mobile): the model files alone leave the engine's own defaults for
    # its newer version in place, which read the same pages differently
    v5, mobile = OCRVersion.PPOCRV5, ModelType.MOBILE
    return RapidOCR(params={
        "Det.ocr_version": v5, "Det.model_type": mobile, "Det.model_path": p("det"),
        "Rec.ocr_version": v5, "Rec.model_type": mobile, "Rec.model_path": p("rec"),
        "Cls.model_path": p("cls"),
        "Global.log_level": "critical",
        # No downscaling of the page. The engine's default shrinks anything over 2000 px on its long side, so a 300 DPI
        # page (3300 px) is read at about 180 DPI; on a condensed-type price table that made the recogniser drop the
        # last character of 44 of 250 amounts ("$38.00" read "$38.0", "$144.00" "$14.0"; their confidence stayed
        # about 0.92, so confidence can't flag them). Not clipped boxes: the ink ends inside the box. At the page's own
        # size 3 of them remain. Not monotonic: 2400 gave 88 and 2800 gave 48, so do not "split the difference".
        # Cost, measured on 95 scanned pages: about 1 GB more memory at its peak (3.2 GB, was 2.6) and more time
        # per page. 4200 = a legal page at 300 DPI; a bigger page is shrunk as before.
        "Global.max_side_len": 4200,
        # The text-line angle classifier is off. Its job is to turn upside-down lines, and ocr.ts already turns a whole
        # page when it is sideways. On our pages it only did harm: on 95 scanned pages it flipped short numbers
        # upside down ("930.00" read "00006", "39.00" "006E"; 12 of them on one contract) and lost about 750
        # words of one contract's ordinary text (744 at conf >= 0.8 came back once it was off; most likely read flipped, so under the engine's 0.5 floor). With it
        # off, no complete amount changed against the same settings with it on, and no flipped-looking token remained.
        "Global.use_cls": False,
    })


def read(img) -> list:
    r = ENGINE(img, return_word_box=True)
    words = []
    for li, (box, txt, score) in enumerate(zip(r.boxes if r.boxes is not None else [], r.txts or [], r.scores or [])):
        parts = r.word_results[li] if r.word_results else None
        for t, s, b in (parts if parts else [(txt, score, box)]):
            xs, ys = [float(q[0]) for q in b], [float(q[1]) for q in b]
            # a table rule at the edge of a cell reads as "|" ("$100.00|"): not part of the amount. A lone "|" stays a word
            text = str(t).strip("|").strip() or str(t)
            if text.strip():
                words.append({"text": text, "conf": float(s), "bbox": [min(xs), min(ys), max(xs), max(ys)], "line": li})
    return words


def sideways(words: list) -> bool:
    if not words:
        return True
    tall = sum(1 for w in words if len(w["text"]) >= 3 and (w["bbox"][3] - w["bbox"][1]) > 1.5 * (w["bbox"][2] - w["bbox"][0]))
    sure = sum(1 for w in words if w["conf"] >= CONFIDENT)
    return tall > 0.3 * len(words) or sure < 0.5 * len(words)


def unread(img, words: list) -> list:
    h, w = img.shape[:2]
    ink = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    # table rulings are ink no word covers, but they say nothing
    lines = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, w // 30), 1)))
    lines |= cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(1, h // 30))))
    ink &= ~lines
    for wd in words:
        x0, y0, x1, y1 = (int(round(v)) for v in wd["bbox"])
        ink[max(0, y0 - 3):y1 + 3, max(0, x0 - 3):x1 + 3] = 0
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))  # specks and scan noise
    blobs = cv2.dilate(ink, np.ones((25, 25), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(blobs)
    out = []
    for x, y, bw, bh, _ in stats[1:n]:
        cy = (y + bh / 2) / h
        edge = cy < 0.1 or cy > 0.9
        if bw * bh >= (EDGE_AREA if edge else BODY_AREA) * w * h:
            out.append([int(x), int(y), int(x + bw), int(y + bh)])
    return out


def answer(req: dict) -> dict:
    t = time.time()
    img = cv2.imdecode(np.frombuffer(base64.b64decode(req["png"]), np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("not an image")
    best = (0, img, read(img))
    if sideways(best[2]):
        for turned, code in ((90, cv2.ROTATE_90_CLOCKWISE), (270, cv2.ROTATE_90_COUNTERCLOCKWISE)):
            im = cv2.rotate(img, code)
            ws = read(im)
            if sum(w["conf"] >= CONFIDENT for w in ws) > sum(w["conf"] >= CONFIDENT for w in best[2]):
                best = (turned, im, ws)
    turned, im, words = best
    return {"id": req["id"], "turned": turned, "words": words, "unread": unread(im, words), "ms": round((time.time() - t) * 1000)}


if __name__ == "__main__":
    try:
        FILES = check_models(Path(sys.argv[1]), Path(sys.argv[2]))
        ENGINE = engine(Path(sys.argv[1]), FILES)
    except Exception as e:  # noqa: BLE001 (reported by class only, so no file name or text leaks)
        print(json.dumps({"fatal": type(e).__name__}), flush=True)
        sys.exit(1)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        req = None
        try:
            req = json.loads(line)
            out = answer(req)
        except Exception as e:  # noqa: BLE001
            out = {"id": req.get("id") if isinstance(req, dict) else None, "error": type(e).__name__}
        print(json.dumps(out), flush=True)
