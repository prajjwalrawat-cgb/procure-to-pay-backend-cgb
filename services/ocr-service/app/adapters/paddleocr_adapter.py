"""PaddleOCR adapter.

Ported from the bot's `paddleocr_adapter.py`, including the Windows-CPU PIR/oneDNN
workaround env flags and the 2.x/3.x client-construction compatibility shim.
Structured extraction is delegated to the shared `llm_extract_to_dto`.

Prefer `rapidocr` unless you specifically need PaddlePaddle — it avoids the
PaddlePaddle PIR executor crash on Windows CPU.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import os
from typing import Any, Optional

# Must be set BEFORE any paddle import — avoids the Windows CPU PIR/oneDNN crash.
os.environ.setdefault("FLAGS_use_mkldnn", "False")
os.environ.setdefault("FLAGS_use_onednn", "False")
os.environ.setdefault("FLAGS_enable_pir_api", "0")
os.environ.setdefault("FLAGS_enable_pir_in_executor", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from app.adapters.azure_doc_intel import llm_extract_to_dto
from app.adapters.rapidocr_adapter import _extract_pdf_text
from app.config import OcrSettings
from app.models import IDocExtractor, ILLMProvider, ExtractedPage, InvoiceDTO

logger = logging.getLogger(__name__)


class PaddleOCRExtractor(IDocExtractor):
    def __init__(self, llm: ILLMProvider, settings: OcrSettings):
        self._llm = llm
        self._settings = settings
        self._lang = settings.paddleocr_lang
        self._use_angle_cls = settings.paddleocr_use_angle_cls
        self._use_gpu = settings.paddleocr_use_gpu
        self._ocr: Any = None

    def _client(self) -> Any:
        if self._ocr is None:
            try:
                from paddleocr import PaddleOCR
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError("paddleocr is not installed. Run: pip install paddleocr") from exc
            self._ocr = self._create_paddle_client(PaddleOCR)
        return self._ocr

    def _create_paddle_client(self, paddle_cls: Any) -> Any:
        base_kwargs: dict[str, Any] = {"lang": self._lang}
        modern_kwargs: dict[str, Any] = {
            "device": "gpu" if self._use_gpu else "cpu",
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "ocr_version": "PP-OCRv4",
        }
        legacy_kwargs: dict[str, Any] = {
            "use_angle_cls": self._use_angle_cls,
            "use_gpu": self._use_gpu,
        }
        try:
            sig = inspect.signature(paddle_cls)
            params = set(sig.parameters)
            if not any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
                modern_kwargs = {k: v for k, v in modern_kwargs.items() if k in params}
                legacy_kwargs = {k: v for k, v in legacy_kwargs.items() if k in params}
        except (TypeError, ValueError):
            pass

        attempts = [
            {**base_kwargs, **modern_kwargs},
            {
                **base_kwargs,
                "use_doc_orientation_classify": False,
                "use_doc_unwarping": False,
                "use_textline_orientation": False,
            },
            {**base_kwargs, **legacy_kwargs},
            {**base_kwargs, "device": "gpu" if self._use_gpu else "cpu"},
            base_kwargs,
        ]
        last_error: Exception | None = None
        for kwargs in attempts:
            try:
                return paddle_cls(**kwargs)
            except (TypeError, ValueError) as exc:
                message = str(exc).lower()
                if "unknown argument" not in message and "unexpected keyword" not in message:
                    raise
                last_error = exc
        if last_error:
            raise last_error
        return paddle_cls(**base_kwargs)

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
        try:
            result = client.ocr(file_path, cls=self._use_angle_cls)
        except (TypeError, ValueError):
            result = client.ocr(file_path)
        return "\n".join(_iter_paddle_text(result))


def _iter_paddle_text(result: Any):
    if result is None:
        return
    if isinstance(result, dict):
        for key in ("rec_texts", "texts"):
            values = result.get(key)
            if isinstance(values, list):
                for value in values:
                    if value:
                        yield str(value)
        for value in result.values():
            yield from _iter_paddle_text(value)
        return
    if isinstance(result, str):
        yield result
        return
    if isinstance(result, tuple) and len(result) >= 2:
        text_part = result[1]
        if isinstance(text_part, tuple) and text_part:
            yield str(text_part[0])
            return
        if isinstance(text_part, str):
            yield text_part
            return
    if isinstance(result, list):
        for item in result:
            yield from _iter_paddle_text(item)
