"""Azure Document Intelligence adapter (`prebuilt-invoice`).

Ported from the bot's `expense_engine/adapters/ocr/azure_doc_intel.py`. Same
core: prebuilt-invoice -> typed fields, with an LLM fallback only when the scan
is unusable. Two deliberate changes for procure-to-pay:

  1. Line items are mapped from the invoice model's `Items` array (the bot
     dropped them; the 3-way match needs them).
  2. A document-level `confidence` is derived from field confidences so the
     tool's low-confidence routing has a real signal to act on.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any, Optional

from app.config import OcrSettings
from app.extraction_common import (
    LLM_EXTRACT_SYSTEM,
    LLM_EXTRACT_TEMPLATE,
    find_eway_bill,
    find_hsn_code,
    find_irn,
    normalize_date,
    parse_tax_rate,
    to_float,
)
from app.models import IDocExtractor, ILLMProvider, ExtractedPage, InvoiceDTO, LineItem

logger = logging.getLogger(__name__)


def _field_value(field_obj: Any) -> Any:
    if field_obj is None:
        return None
    for attr in ("value", "value_string", "value_number", "value_date", "content"):
        v = getattr(field_obj, attr, None)
        if v is not None:
            return v
    return field_obj


def _money_field(field_obj: Any) -> tuple[Optional[float], Optional[str]]:
    if field_obj is None:
        return (None, None)
    v = getattr(field_obj, "value", None)
    amount = getattr(v, "amount", None) if v is not None else None
    currency = getattr(v, "currency_code", None) if v is not None else None
    if amount is None:
        amount = getattr(field_obj, "value_number", None)
        if amount is None and isinstance(v, (int, float)):
            amount = float(v)
    if amount is None:
        return (None, currency)
    return (to_float(amount), currency)


def _date_field(field_obj: Any) -> Optional[str]:
    if field_obj is None:
        return None
    v = getattr(field_obj, "value", None)
    if v is None:
        v = getattr(field_obj, "value_date", None)
    if v is None:
        return normalize_date(getattr(field_obj, "content", None))
    if hasattr(v, "strftime"):
        return v.strftime("%Y-%m-%d")
    return normalize_date(str(v))


def _confidence(invoice_doc: Any, fields: dict) -> float:
    """Document confidence: prefer the model's own, else mean of key fields."""
    doc_conf = getattr(invoice_doc, "confidence", None)
    if isinstance(doc_conf, (int, float)) and doc_conf > 0:
        return round(float(doc_conf), 4)
    confs = [
        getattr(fields.get(k), "confidence", None)
        for k in ("VendorName", "InvoiceId", "InvoiceTotal", "InvoiceDate")
    ]
    confs = [c for c in confs if isinstance(c, (int, float))]
    return round(sum(confs) / len(confs), 4) if confs else 0.6


class AzureDocIntelOCR(IDocExtractor):
    _client_cache: dict[tuple, Any] = {}

    def __init__(self, endpoint: str, key: str, llm: Optional[ILLMProvider], settings: OcrSettings):
        self._endpoint = endpoint
        self._key = key
        self._llm = llm
        self._settings = settings

    def _get_client(self):
        cache_key = (self._endpoint, self._key)
        client = self._client_cache.get(cache_key)
        if client is None:
            from azure.ai.documentintelligence import DocumentIntelligenceClient
            from azure.core.credentials import AzureKeyCredential

            client = DocumentIntelligenceClient(
                endpoint=self._endpoint,
                credential=AzureKeyCredential(self._key),
            )
            self._client_cache[cache_key] = client
        return client

    async def extract(self, file_path: str, mime_type: Optional[str]) -> list[ExtractedPage]:
        content, _ = await self._analyze_invoice(file_path)
        return [ExtractedPage(page_number=1, text=content)]

    async def extract_invoice(self, file_path: str, mime_type: Optional[str]) -> InvoiceDTO:
        document_content, invoice_doc = await self._analyze_invoice(file_path)

        if invoice_doc is None:
            return await self._fallback_full_extract(document_content)

        fields = getattr(invoice_doc, "fields", None) or {}

        vendor = _field_value(fields.get("VendorName"))
        invoice_number = _field_value(fields.get("InvoiceId"))
        invoice_date_iso = _date_field(fields.get("InvoiceDate"))
        amount, currency_code = _money_field(fields.get("InvoiceTotal"))
        if amount is None:
            amount, currency_code = _money_field(fields.get("AmountDue"))
        if amount is None:
            amount, currency_code = _money_field(fields.get("SubTotal"))
        tax_amount, _ = _money_field(fields.get("TotalTax"))

        # Both vendor AND amount missing => bad scan; fall back to LLM-from-text.
        if not vendor and amount is None:
            return await self._fallback_full_extract(document_content)

        line_items = self._map_line_items(fields.get("Items"))
        # If the invoice model found no line rows, degrade to a single summary
        # line so the tool still has something to match / totals to compute.
        if not line_items and amount is not None:
            line_items = [
                LineItem(
                    description=str(vendor) if vendor else "Supply as per invoice",
                    quantity=1.0,
                    unit_price=float(amount),
                    amount=float(amount),
                    uom=self._settings.default_uom,
                    tax_rate=self._settings.default_tax_rate,
                )
            ]

        return InvoiceDTO(
            vendor_name=str(vendor) if vendor else None,
            invoice_number=str(invoice_number) if invoice_number else None,
            invoice_date=invoice_date_iso,
            total_amount=float(amount) if amount is not None else 0.0,
            currency=currency_code,
            tax_amount=tax_amount,
            line_items=line_items,
            raw_text=document_content,
            hsn_code=find_hsn_code(document_content),
            irn=find_irn(document_content),
            eway_bill_no=find_eway_bill(document_content),
            confidence=_confidence(invoice_doc, fields),
        )

    def _map_line_items(self, items_field: Any) -> list[LineItem]:
        """Map prebuilt-invoice `Items` (an array of objects) -> LineItem list."""
        if items_field is None:
            return []
        values = getattr(items_field, "value", None) or []
        out: list[LineItem] = []
        for item in values:
            obj = getattr(item, "value", None) or getattr(item, "value_object", None) or {}
            if not isinstance(obj, dict):
                continue
            qty = to_float(_field_value(obj.get("Quantity")))
            unit_price, _ = _money_field(obj.get("UnitPrice"))
            line_amt, _ = _money_field(obj.get("Amount"))
            desc = _field_value(obj.get("Description"))
            uom = _field_value(obj.get("Unit")) or self._settings.default_uom
            tax_rate = parse_tax_rate(_field_value(obj.get("TaxRate")))

            # Derive unit price from amount/qty when the model omitted it.
            if unit_price is None and line_amt is not None and qty:
                unit_price = round(line_amt / qty, 4)

            out.append(
                LineItem(
                    description=str(desc) if desc else None,
                    quantity=qty if qty is not None else 1.0,
                    unit_price=unit_price if unit_price is not None else (line_amt or 0.0),
                    amount=line_amt,
                    uom=str(uom),
                    tax_rate=tax_rate if tax_rate is not None else self._settings.default_tax_rate,
                )
            )
        return out

    async def _analyze_invoice(self, file_path: str) -> tuple[str, Any]:
        client = self._get_client()
        loop = asyncio.get_event_loop()

        def _read_b64() -> str:
            with open(file_path, "rb") as fh:
                return base64.b64encode(fh.read()).decode("utf-8")

        b64 = await loop.run_in_executor(None, _read_b64)
        poller = await loop.run_in_executor(
            None,
            lambda: client.begin_analyze_document("prebuilt-invoice", body={"base64Source": b64}),
        )
        result = await loop.run_in_executor(None, poller.result)
        raw_text = result.content or ""
        documents = getattr(result, "documents", None) or []
        return (raw_text, documents[0] if documents else None)

    async def _fallback_full_extract(self, document_content: str) -> InvoiceDTO:
        logger.warning("prebuilt-invoice returned no usable fields; falling back to LLM extract")
        if self._llm is None:
            # No LLM configured — return whatever regexes can salvage.
            return InvoiceDTO(
                raw_text=document_content,
                hsn_code=find_hsn_code(document_content),
                irn=find_irn(document_content),
                eway_bill_no=find_eway_bill(document_content),
                confidence=0.2,
            )
        return await llm_extract_to_dto(self._llm, document_content, self._settings, base_confidence=0.5)


async def llm_extract_to_dto(
    llm: ILLMProvider,
    text: str,
    settings: OcrSettings,
    base_confidence: float,
) -> InvoiceDTO:
    """Shared raw-text -> InvoiceDTO via LLM. Used by Azure fallback + paddle/rapid."""
    prompt = LLM_EXTRACT_TEMPLATE.format(document_content=text)
    try:
        raw = await asyncio.wait_for(
            llm.complete(
                system=LLM_EXTRACT_SYSTEM,
                user=prompt,
                temperature=0,
                response_format={"type": "json_object"},
            ),
            timeout=60,
        )
    except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
        logger.error("LLM extraction failed: %s", exc)
        raw = "{}"

    try:
        structured = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        structured = {}
    if isinstance(structured, list):
        structured = structured[0] if structured and isinstance(structured[0], dict) else {}
    if not isinstance(structured, dict):
        structured = {}

    line_items: list[LineItem] = []
    for row in structured.get("LineItems") or []:
        if not isinstance(row, dict):
            continue
        qty = to_float(row.get("Quantity"))
        unit_price = to_float(row.get("UnitPrice"))
        line_amt = to_float(row.get("Amount"))
        if unit_price is None and line_amt is not None and qty:
            unit_price = round(line_amt / qty, 4)
        tax_rate = parse_tax_rate(row.get("TaxRate"))
        line_items.append(
            LineItem(
                description=(str(row["Description"]) if row.get("Description") else None),
                quantity=qty if qty is not None else 1.0,
                unit_price=unit_price if unit_price is not None else (line_amt or 0.0),
                amount=line_amt,
                uom=str(row.get("Uom") or settings.default_uom),
                tax_rate=tax_rate if tax_rate is not None else settings.default_tax_rate,
            )
        )

    total = to_float(structured.get("InvoiceAmount")) or 0.0
    if not line_items and total:
        line_items = [
            LineItem(
                description=structured.get("VendorName") or "Supply as per invoice",
                quantity=1.0,
                unit_price=total,
                amount=total,
                uom=settings.default_uom,
                tax_rate=settings.default_tax_rate,
            )
        ]

    # Confidence: start from the caller's base, penalise missing key fields.
    have = sum(1 for k in ("VendorName", "BillNumber", "InvoiceAmount") if structured.get(k))
    confidence = round(min(base_confidence + 0.1 * have, 0.9), 4) if structured else 0.3

    return InvoiceDTO(
        vendor_name=structured.get("VendorName"),
        invoice_number=structured.get("BillNumber"),
        invoice_date=normalize_date(structured.get("DocumentDate")),
        total_amount=total,
        currency=structured.get("Currency"),
        tax_amount=to_float(structured.get("TaxAmount")),
        line_items=line_items,
        raw_text=text,
        hsn_code=structured.get("HsnCode") or find_hsn_code(text),
        irn=structured.get("Irn") or find_irn(text),
        eway_bill_no=structured.get("EwayBillNo") or find_eway_bill(text),
        confidence=confidence,
    )
