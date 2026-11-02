"""Fill a golden file's grid rows from the sponsor's budget spreadsheet (exact values, no AI).

    python3 -I scripts/golden-grid-from-xlsx.py <budget.xlsx> <golden.json> [sheet number, default 1]

Reads the visit grid (header row with "Code" ... "Budget" then one column per visit), every row
with a printed amount in a visit column, and writes them as `rows` on the golden grid whose visit
totals equal the sheet's "Total ... Per Visit" row. Refuses if no golden grid matches, so a draft
budget that differs from the signed contract is never written as truth.
Stdlib only: an .xlsx is a zip of XML. ElementTree never fetches external entities and the bundled
expat (>= 2.4.1) caps entity expansion, so a hostile file cannot read local files or blow up memory.
"""

import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def col_index(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n


def read_sheet(path: str, sheet: int) -> list[dict[int, str]]:
    z = zipfile.ZipFile(path)
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            strings.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    rows = []
    for r in ET.fromstring(z.read(f"xl/worksheets/sheet{sheet}.xml")).iter(f"{{{NS['m']}}}row"):
        cells = {}
        for c in r.findall("m:c", NS):
            v = c.find("m:v", NS)
            if v is None:
                continue
            cells[col_index(c.get("r"))] = strings[int(v.text)] if c.get("t") == "s" else v.text
        rows.append(cells)
    return rows


def cents(v: str | None) -> int | None:
    try:
        return round(float(v) * 100)
    except (TypeError, ValueError):
        return None


def grid_rows(rows: list[dict[int, str]]):
    header = next(r for r in rows if "Code" in r.values() and "Budget" in r.values())
    code_col = next(k for k, v in header.items() if v == "Code")
    budget_col = next(k for k, v in header.items() if v == "Budget")
    visit_cols = sorted(k for k in header if k > budget_col)
    out, totals = [], None
    for r in rows:
        label = (r.get(code_col + 1) or "").strip()
        vals = [cents(r.get(k)) for k in visit_cols]
        if not any(vals) or r is header:
            continue
        if re.search(r"total cost per visit", label, re.I):
            totals = vals
        # Summary rows (subtotals, overhead, totals) have no code; procedure names can say "total" (spirometry).
        if not r.get(code_col, "").strip() and (not label or re.search(r"total|overhead", label, re.I)):
            continue
        out.append({
            "code": (r.get(code_col) or "").strip() or None,
            "name": " ".join(label.split()),
            "unitCents": cents(r.get(budget_col)),
            "cells": vals,
        })
    return [header[k] for k in visit_cols], out, totals


def main():
    xlsx, golden_path = sys.argv[1], sys.argv[2]
    sheet = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    visits, rows, totals = grid_rows(read_sheet(xlsx, sheet))
    golden = json.load(open(golden_path))
    grid = next((g for g in golden["grids"] if g["visitTotals"] == totals), None)
    if grid is None:
        sys.exit(f"No grid in {golden_path} has the sheet's {len(totals)} visit totals; refusing to write (draft budget?)")
    grid["rows"] = rows
    json.dump(golden, open(golden_path, "w"), indent=2)
    print(f"{golden_path}: {len(rows)} rows x {len(visits)} visits written to grid {golden['grids'].index(grid) + 1}")


if __name__ == "__main__":
    main()
