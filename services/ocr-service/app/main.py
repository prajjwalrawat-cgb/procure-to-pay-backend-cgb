"""OCR service — FastAPI wrapper around the bot's OCR module.

Exposes `POST /extract` in exactly the shape procure-to-pay's `RealOcrProvider`
already expects (see apps/api/src/invoices/ocr/real-ocr.provider.ts):

    request : { "document_url": "<presigned GET url>" }
    response: {
        vendor_invoice_ref, invoice_date, irn, eway_bill_no,
        line_items: [ { description, uom, quantity, unit_price, tax_rate } ],
        confidence
    }

Set the tool's OCR_API_URL to this service's base URL and the existing invoice
pipeline (queue -> worker -> circuit-breaker -> applyOcr -> 3-way match) uses it
with no other changes.
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.download import download_to_temp
from app.models import IDocExtractor, InvoiceDTO

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ocr-service")

app = FastAPI(title="Procure-to-Pay OCR Service", version="1.0.0")

_extractor: IDocExtractor | None = None


def _get_extractor() -> IDocExtractor:
    global _extractor
    if _extractor is None:
        from app.adapters.factory import build_extractor

        _extractor = build_extractor(get_settings())
    return _extractor


class ExtractRequest(BaseModel):
    document_url: str


class OcrLineItem(BaseModel):
    description: str | None = None
    uom: str | None = None
    quantity: str | None = None
    unit_price: str | None = None
    tax_rate: str | None = None


class ExtractResponse(BaseModel):
    vendor_invoice_ref: str | None = None
    invoice_date: str | None = None
    vendor_name: str | None = None
    irn: str | None = None
    eway_bill_no: str | None = None
    hsn_code: str | None = None
    currency: str | None = None
    total_amount: float | None = None
    tax_amount: float | None = None
    line_items: list[OcrLineItem] = []
    confidence: float = 0.0


def _num(value) -> str | None:
    return None if value is None else str(value)


def _to_response(dto: InvoiceDTO) -> ExtractResponse:
    return ExtractResponse(
        vendor_invoice_ref=dto.invoice_number,
        invoice_date=dto.invoice_date,
        vendor_name=dto.vendor_name,
        irn=dto.irn,
        eway_bill_no=dto.eway_bill_no,
        hsn_code=dto.hsn_code,
        currency=dto.currency,
        total_amount=dto.total_amount,
        tax_amount=dto.tax_amount,
        line_items=[
            OcrLineItem(
                description=li.description,
                uom=li.uom,
                quantity=_num(li.quantity),
                unit_price=_num(li.unit_price),
                tax_rate=_num(li.tax_rate),
            )
            for li in dto.line_items
        ],
        confidence=max(0.0, min(1.0, float(dto.confidence or 0.0))),
    )


@app.get("/health")
async def health() -> dict:
    settings = get_settings()
    return {"status": "ok", "provider": settings.normalized_provider()}


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest) -> ExtractResponse:
    settings = get_settings()
    try:
        extractor = _get_extractor()
    except ValueError as exc:
        # Misconfiguration (e.g. azure selected without creds) — 500 so the
        # tool's circuit-breaker treats it as a provider failure -> OCR_FAILED.
        logger.error("OCR provider not configured: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        with download_to_temp(
            req.document_url,
            timeout=settings.download_timeout_seconds,
            max_mb=settings.max_document_mb,
        ) as (path, content_type):
            mime = content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
            dto = await extractor.extract_invoice(path, mime)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("OCR extraction failed")
        raise HTTPException(status_code=502, detail=f"OCR extraction failed: {exc}") from exc

    resp = _to_response(dto)
    logger.info(
        "extract done provider=%s vendor=%s lines=%d confidence=%.2f",
        settings.normalized_provider(),
        resp.vendor_name,
        len(resp.line_items),
        resp.confidence,
    )
    return resp
