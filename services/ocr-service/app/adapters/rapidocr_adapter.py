"""RapidOCR adapter (PP-OCR models via ONNX Runtime).

Ported from the bot's `rapidocr_adapter.py`. Raw text via RapidOCR (or the PDF
text layer when present), then structured fields via the shared LLM extraction
(`llm_extract_to_dto`) — now including line items.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from app.adapters.azure_doc_intel import llm_extract_to_dto
from app.config import OcrSettings
from app.models import IDocExtractor, ILLMProvider, ExtractedPage, InvoiceDTO

logger = logging.getLogger(__name__)


class RapidOCRExtractor(IDocExtractor):
    def __init__(self, llm: ILLMProvider, settings: OcrSettings):
        self._llm = llm
        self._settings = settings
        self._ocr: Any = None

    def _client(self) -> Any:
        if self._ocr is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError(
                    "rapidocr-onnxruntime is not installed. Run: pip install rapidocr-onnxruntime"
                ) from exc
            self._ocr = RapidOCR()
        return self._ocr

    async def extract(self, file_path: str, mime_type: Optional[str]) -> list[ExtractedPage]:
        text = await asyncio.to_thread(self._extract_text, file_path)
        return [ExtractedPage(page_number=1, text=text)]

    async def extract_invoice(self, file_path: str, mime_type: Optional[str]) -> InvoiceDTO:
        text = await asyncio.to_thread(self._extract_text, file_path)
        return await llm_extract_to_dto(self._llm, text, self._settings, base_confidence=0.55)

    def _extract_text(self, file_path: str) -> str:
        pdf_text = _extract_pdf_text(file_path)
        if pdf_text.strip():
            return pdf_text
        client = self._client()
        result, _elapsed = client(file_path)
        return "\n".join(_iter_rapid_text(result))


def _iter_rapid_text(result: Any):
    if not result:
        return
    for entry in result:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            text = entry[1]
            if isinstance(text, str) and text.strip():
                yield text


def _extract_pdf_text(file_path: str) -> str:
    """Return the embedded PDF text layer, or '' for images / scanned PDFs."""
    if not file_path.lower().endswith(".pdf"):
        return ""
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover
        logger.warning("pypdf not installed; skipping PDF text layer")
        return ""
    try:
        reader = PdfReader(file_path)
        pages = [p.extract_text() or "" for p in reader.pages]
        return "\n".join(t for t in pages if t.strip())
    except Exception as exc:  # noqa: BLE001
        logger.warning("PDF text extract failed: %s", exc)
        return ""
