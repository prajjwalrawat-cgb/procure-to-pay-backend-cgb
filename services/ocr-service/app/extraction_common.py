"""Shared extraction helpers + prompts.

Ported from the bot's `azure_doc_intel.py` (the sibling paddle/rapid adapters
imported these names from there). Moved into a dedicated module so there is no
awkward cross-adapter import, and extended so the LLM extraction also returns
`LineItems` — the procure-to-pay match engine consumes per-line data that the
bot's header-only prompt never asked for.

Also holds best-effort regexes for HSN / IRN / e-way-bill, which are
GST-invoice specifics relevant to the procurement tool.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional


# Full-extract prompt for the self-hosted (raw-text -> LLM) adapters, and the
# Azure fallback path. Extended vs. the bot: now also asks for LineItems.
LLM_EXTRACT_SYSTEM = (
    "You extract structured invoice/bill data from OCR text. "
    "Return valid JSON only — no prose, no code fences."
)

LLM_EXTRACT_TEMPLATE = """Extract the following fields from the invoice OCR text below. Use null when a field cannot be found.

Header fields:
- DocumentDate: invoice/bill date (YYYY-MM-DD)
- Currency: ISO code or symbol (e.g. INR)
- BillNumber: invoice / bill number
- VendorName: supplier / vendor name
- InvoiceAmount: grand total (numeric, no symbols)
- TaxAmount: total tax (numeric, no symbols) or null
- HsnCode: first HSN/SAC code seen, or null
- Irn: 64-character Invoice Reference Number (GST e-invoice), or null
- EwayBillNo: e-way bill number, or null

LineItems: an array, one object per line row on the invoice. Each object:
- Description: item / service description
- Quantity: numeric quantity (default 1 if a total-only line)
- UnitPrice: price per unit (numeric)
- Amount: line total (numeric) or null
- Uom: unit of measure (e.g. NOS, EA, KG, LOT) or null
- TaxRate: tax rate as a FRACTION (0.18 for 18%), or null

All dates MUST be YYYY-MM-DD. Convert from any other format.

Output JSON only, exactly this shape:
{{"DocumentDate":null,"Currency":null,"BillNumber":null,"VendorName":null,"InvoiceAmount":0,"TaxAmount":null,"HsnCode":null,"Irn":null,"EwayBillNo":null,"LineItems":[]}}

OCR text:
{document_content}
"""


def normalize_date(date_str: Optional[str]) -> Optional[str]:
    if not date_str or not isinstance(date_str, str):
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%m/%d/%Y", "%B %d, %Y", "%d %B %Y", "%d-%b-%Y"):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date_str.strip()):
        return date_str.strip()
    return None


def to_float(value) -> Optional[float]:
    """Best-effort numeric coercion: strips currency symbols/labels, commas, spaces.

    Extracts the first signed decimal token so stray dots in labels ("Rs.",
    "No.") don't corrupt the parse.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).replace(",", "")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def parse_tax_rate(value) -> Optional[float]:
    """Normalise a tax rate to a fraction. '18%' -> 0.18, 18 -> 0.18, 0.18 -> 0.18."""
    if value is None:
        return None
    if isinstance(value, str) and "%" in value:
        num = to_float(value)
        return round(num / 100.0, 4) if num is not None else None
    num = to_float(value)
    if num is None:
        return None
    # Heuristic: a value > 1 is almost certainly a percentage (18 -> 0.18).
    return round(num / 100.0, 4) if num > 1 else round(num, 4)


def find_hsn_code(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    for pattern in (
        r"HSN\s*(?:/?\s*SAC)?\s*(?:code|no\.?)?\s*[:\-]?\s*(\d{4,8})",
        r"SAC\s*(?:code|no\.?)?\s*[:\-]?\s*(\d{4,8})",
    ):
        m = re.search(pattern, text, flags=re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def find_irn(text: Optional[str]) -> Optional[str]:
    """GST e-invoice IRN: a 64-char lowercase hex hash. Prefer a labelled one."""
    if not text:
        return None
    m = re.search(r"IRN\s*[:\-]?\s*([0-9a-fA-F]{64})", text)
    if m:
        return m.group(1).lower()
    m = re.search(r"\b([0-9a-f]{64})\b", text)
    return m.group(1) if m else None


def find_eway_bill(text: Optional[str]) -> Optional[str]:
    """E-way bill number: 12 digits, usually labelled."""
    if not text:
        return None
    m = re.search(r"(?:e-?way\s*bill|ewb)\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{12})", text, flags=re.IGNORECASE)
    if m:
        return m.group(1)
    return None
