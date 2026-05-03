from __future__ import annotations

import json
import re
import sys
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOK = ROOT.parent / "docs" / "现金会v3.0.xlsx"
STORE = ROOT / "data" / "store.json"
SESSIONS_DIR = ROOT / "data" / "sessions"
NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def value(cell):
    if cell.value is None:
        return ""
    return cell.value


def as_number(raw):
    if raw == "":
        return ""
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        return ""
    return int(parsed) if parsed.is_integer() else parsed


def col_to_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value


def shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall("main:si", NS):
        texts = [node.text or "" for node in si.findall(".//main:t", NS)]
        out.append("".join(texts))
    return out


def workbook_sheet_paths(zf: zipfile.ZipFile) -> dict[str, str]:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    targets = {}
    for rel in rels.findall("pkgrel:Relationship", NS):
        target = rel.attrib.get("Target", "")
        targets[rel.attrib["Id"]] = "xl/" + target.lstrip("/")
    paths = {}
    for sheet in wb.findall(".//main:sheet", NS):
        name = sheet.attrib["name"]
        rel_id = sheet.attrib[f"{{{NS['rel']}}}id"]
        paths[name] = targets[rel_id]
    return paths


def parse_sheet(zf: zipfile.ZipFile, path: str, strings: list[str]) -> dict[tuple[int, int], object]:
    root = ET.fromstring(zf.read(path))
    cells: dict[tuple[int, int], object] = {}
    for cell in root.findall(".//main:c", NS):
        ref = cell.attrib.get("r", "")
        if not ref:
            continue
        row_match = re.search(r"\d+", ref)
        if not row_match:
            continue
        row = int(row_match.group(0))
        col = col_to_index(ref)
        cell_type = cell.attrib.get("t")
        if cell_type == "inlineStr":
            texts = [node.text or "" for node in cell.findall(".//main:t", NS)]
            raw = "".join(texts)
        else:
            value_node = cell.find("main:v", NS)
            if value_node is None:
                continue
            raw = value_node.text or ""
            if cell_type == "s":
                raw = strings[int(raw)] if raw else ""
            elif cell_type == "b":
                raw = raw == "1"
            else:
                raw = as_number(raw)
        cells[(row, col)] = raw
    return cells


def cell(cells: dict[tuple[int, int], object], row: int, col: int):
    return cells.get((row, col), "")


def time_value(raw):
    if isinstance(raw, (int, float)) and 0 <= raw < 1:
        minutes = round(raw * 24 * 60)
        return f"{minutes // 60:02d}:{minutes % 60:02d}"
    return str(raw or "")


def import_with_xml(path: Path) -> dict:
    with zipfile.ZipFile(path) as zf:
        strings = shared_strings(zf)
        sheets = workbook_sheet_paths(zf)
        settings = parse_sheet(zf, sheets["设置"], strings)
        customers_sheet = parse_sheet(zf, sheets["信息登记"], strings)
        lots_sheet = parse_sheet(zf, sheets["成交登记"], strings)

    item_codes = []
    for row in range(2, 300):
        code, name = cell(settings, row, 6), cell(settings, row, 7)
        if code:
            item_codes.append({"code": str(code).strip().lower(), "name": str(name).strip()})

    seller_codes = []
    for row in range(2, 300):
        code, label = cell(settings, row, 8), cell(settings, row, 9)
        if code:
            seller_codes.append({"code": str(code).strip().lower(), "label": str(label).strip()})

    customers = []
    for row in range(2, 1000):
        bidder_no = as_number(cell(customers_sheet, row, 1))
        seller_label = str(cell(customers_sheet, row, 2)).strip()
        name = str(cell(customers_sheet, row, 3)).strip()
        if bidder_no == "" and not seller_label and not name:
            continue
        customers.append(
            {
                "id": str(uuid.uuid4()),
                "bidderNo": bidder_no,
                "sellerLabel": seller_label,
                "name": name,
                "actualSellerName": str(cell(customers_sheet, row, 4)).strip(),
                "phone": str(cell(customers_sheet, row, 5)).strip(),
                "sellerRate": as_number(cell(customers_sheet, row, 6)),
                "buyerRate": as_number(cell(customers_sheet, row, 7)),
                "returnRate": as_number(cell(customers_sheet, row, 8)),
            }
        )

    if not any(customer["bidderNo"] == -1 for customer in customers):
        customers.insert(
            0,
            {
                "id": str(uuid.uuid4()),
                "bidderNo": -1,
                "sellerLabel": "",
                "name": "流拍",
                "actualSellerName": "",
                "phone": "",
                "sellerRate": "",
                "buyerRate": "",
                "returnRate": "",
            },
        )

    lots = []
    for row in range(2, 5000):
        item_no = as_number(cell(lots_sheet, row, 1))
        seller_code = str(cell(lots_sheet, row, 2)).strip().lower()
        item_code = str(cell(lots_sheet, row, 3)).strip().lower()
        quantity = as_number(cell(lots_sheet, row, 4))
        buyer_no = as_number(cell(lots_sheet, row, 5))
        price_k = as_number(cell(lots_sheet, row, 6))
        if item_no == "" and not seller_code and not item_code:
            continue
        lots.append(
            {
                "id": str(uuid.uuid4()),
                "itemNo": item_no,
                "sellerCode": seller_code,
                "itemCode": item_code,
                "quantity": quantity,
                "buyerNo": buyer_no,
                "priceK": price_k,
                "buyerConfirmed": cell(lots_sheet, row, 25) == 1,
                "sellerConfirmed": cell(lots_sheet, row, 27) == 1,
                "returnConfirmed": cell(lots_sheet, row, 28) == 1,
                "note": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
            }
        )

    return {
        "id": "",
        "meta": {
            "eventName": str(cell(settings, 2, 1) or "现金拍卖会"),
            "sellerCommissionRate": as_number(cell(settings, 2, 2)) or 5,
            "buyerCommissionRate": as_number(cell(settings, 2, 3)) or 10,
            "returnCommissionRate": as_number(cell(settings, 2, 4)) or 5,
            "startTime": time_value(cell(settings, 2, 5) or "10:00"),
            "updatedAt": datetime.now().isoformat(),
            "sourceWorkbook": str(path),
        },
        "itemCodes": item_codes,
        "sellerCodes": seller_codes,
        "customers": customers,
        "lots": lots,
        "liveEntry": {},
        "audit": [
            {
                "id": str(uuid.uuid4()),
                "at": datetime.now().isoformat(),
                "action": "导入 Excel",
                "detail": path.name,
            }
        ],
    }


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def default_global_store(
    active_session_id: str = "",
    customer_book=None,
    item_codes=None,
    seller_codes=None,
    company_profile=None,
) -> dict:
    return {
        "version": 2,
        "activeSessionId": active_session_id,
        "customerBook": customer_book or [],
        "itemCodes": item_codes or [],
        "sellerCodes": seller_codes or [],
        "companyProfile": company_profile or {},
        "updatedAt": datetime.now().isoformat(),
    }


def ensure_active_session() -> tuple[dict, str]:
    ROOT.joinpath("data").mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    raw_store = read_json(STORE, {})
    if raw_store.get("version") == 2:
        store = default_global_store(
            raw_store.get("activeSessionId", ""),
            raw_store.get("customerBook", []),
            raw_store.get("itemCodes", []),
            raw_store.get("sellerCodes", []),
            raw_store.get("companyProfile", {}),
        )
    else:
        store = default_global_store(
            "",
            raw_store.get("customerBook", []) if isinstance(raw_store, dict) else [],
            raw_store.get("itemCodes", []) if isinstance(raw_store, dict) else [],
            raw_store.get("sellerCodes", []) if isinstance(raw_store, dict) else [],
            raw_store.get("companyProfile", {}) if isinstance(raw_store, dict) else {},
        )

    session_id = store.get("activeSessionId") or str(uuid.uuid4())
    store["activeSessionId"] = session_id
    return store, session_id


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_WORKBOOK
    if not path.exists():
        print(f"Workbook not found: {path}", file=sys.stderr)
        return 1

    store, session_id = ensure_active_session()
    session = import_with_xml(path)
    session["id"] = session_id
    session["createdAt"] = datetime.now().isoformat()
    session["updatedAt"] = session["meta"]["updatedAt"]
    store["itemCodes"] = session["itemCodes"]
    store["sellerCodes"] = session["sellerCodes"]
    store["updatedAt"] = datetime.now().isoformat()

    STORE.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    session_path = SESSIONS_DIR / f"{session_id}.json"
    session_path.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Imported {len(session['customers'])} customers, {len(session['lots'])} lots -> {session_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
