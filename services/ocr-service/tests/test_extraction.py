"""Unit tests for the ported OCR extraction logic.

Run from services/ocr-service after `pip install -r requirements.txt pytest`:
    pytest -q
"""
import asyncio
from types import SimpleNamespace

from app.adapters.azure_doc_intel import llm_extract_to_dto
from app.extraction_common import (
    find_eway_bill,
    find_hsn_code,
    find_irn,
    normalize_date,
    parse_tax_rate,
    to_float,
)


def _settings():
    # llm_extract_to_dto only reads these two knobs; a namespace keeps the test
    # free of pydantic/env setup.
    return SimpleNamespace(default_tax_rate=0.18, default_uom="NOS")


class _FakeLLM:
    def __init__(self, payload: str):
        self._payload = payload

    async def complete(self, system, user, temperature=0, response_format=None):
        return self._payload


def test_normalize_date():
    assert normalize_date("17/07/2026") == "2026-07-17"
    assert normalize_date("2026-07-17") == "2026-07-17"
    assert normalize_date("garbage") is None


def test_to_float_handles_labels_and_grouping():
    assert to_float("Rs. 1,76,800.00") == 176800.0
    assert to_float("No. 45") == 45.0
    assert to_float(None) is None
    assert to_float("n/a") is None


def test_parse_tax_rate_normalises_to_fraction():
    assert parse_tax_rate("18%") == 0.18
    assert parse_tax_rate(18) == 0.18
    assert parse_tax_rate(0.18) == 0.18
    assert parse_tax_rate(None) is None


def test_regex_extractors():
    assert find_hsn_code("HSN/SAC Code: 84821000") == "84821000"
    assert find_irn("IRN: " + "a" * 64) == "a" * 64
    assert find_eway_bill("E-Way Bill No: 123456789012") == "123456789012"


def test_llm_extract_maps_line_items_and_defaults():
    payload = (
        '{"DocumentDate":"17/07/2026","Currency":"INR","BillNumber":"PES/2026/4471",'
        '"VendorName":"Patel Engineering","InvoiceAmount":"1,76,800.00","TaxAmount":"26976",'
        '"HsnCode":"84821000","Irn":null,"EwayBillNo":null,"LineItems":['
        '{"Description":"SRB 22318","Quantity":"8","UnitPrice":"18900","Amount":"151200","Uom":"EA","TaxRate":"18%"},'
        '{"Description":"Freight","Quantity":null,"UnitPrice":null,"Amount":"1800","Uom":null,"TaxRate":null}]}'
    )
    dto = asyncio.run(llm_extract_to_dto(_FakeLLM(payload), "raw", _settings(), base_confidence=0.55))
    assert dto.invoice_date == "2026-07-17"
    assert dto.total_amount == 176800.0
    assert dto.hsn_code == "84821000"
    assert (dto.line_items[0].quantity, dto.line_items[0].unit_price) == (8.0, 18900.0)
    assert dto.line_items[0].uom == "EA" and dto.line_items[0].tax_rate == 0.18
    # Freight line: qty/unit_price missing -> qty=1, unit_price derived from amount, defaults applied.
    assert dto.line_items[1].quantity == 1.0 and dto.line_items[1].unit_price == 1800.0
    assert dto.line_items[1].uom == "NOS" and dto.line_items[1].tax_rate == 0.18


def test_llm_extract_synthesises_summary_line_when_no_items():
    dto = asyncio.run(
        llm_extract_to_dto(_FakeLLM('{"InvoiceAmount": 5000, "VendorName": "Acme"}'), "raw", _settings(), 0.55)
    )
    assert len(dto.line_items) == 1
    assert dto.line_items[0].unit_price == 5000.0


def test_llm_extract_survives_garbage_json():
    dto = asyncio.run(llm_extract_to_dto(_FakeLLM("not json"), "raw", _settings(), 0.55))
    assert dto.confidence == 0.3
    assert dto.line_items == []
