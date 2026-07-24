"""OCR adapter factory — picks the engine from OCR_PROVIDER.

Trimmed from the bot's `expense_engine/adapters/ocr/factory.py`: no master-data /
expense-type coupling, just the engine selection the procurement tool needs.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.config import OcrSettings
from app.models import IDocExtractor, ILLMProvider

logger = logging.getLogger(__name__)


def build_llm(settings: OcrSettings) -> Optional[ILLMProvider]:
    """Construct the LLM used for structured extraction, if configured."""
    if not settings.llm_api_key and not settings.llm_api_base:
        return None
    from app.llm import LiteLLMProvider

    return LiteLLMProvider(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        api_base=settings.llm_api_base,
        api_version=settings.llm_api_version,
        deployment_name=settings.llm_deployment_name,
    )


def build_extractor(settings: OcrSettings) -> IDocExtractor:
    provider = settings.normalized_provider()
    llm = build_llm(settings)

    if provider == "azure":
        from app.adapters.azure_doc_intel import AzureDocIntelOCR

        endpoint = settings.azure_doc_intel_endpoint
        key = settings.azure_doc_intel_key
        if not endpoint or not key:
            raise ValueError(
                "OCR_PROVIDER=azure requires AZURE_DOC_INTEL_ENDPOINT and AZURE_DOC_INTEL_KEY"
            )
        return AzureDocIntelOCR(endpoint=endpoint, key=key, llm=llm, settings=settings)

    if provider in ("rapidocr", "rapid"):
        from app.adapters.rapidocr_adapter import RapidOCRExtractor

        if llm is None:
            raise ValueError("OCR_PROVIDER=rapidocr requires an LLM (set LLM_API_KEY / LLM_API_BASE)")
        return RapidOCRExtractor(llm=llm, settings=settings)

    if provider in ("paddleocr", "paddle"):
        from app.adapters.paddleocr_adapter import PaddleOCRExtractor

        if llm is None:
            raise ValueError("OCR_PROVIDER=paddleocr requires an LLM (set LLM_API_KEY / LLM_API_BASE)")
        return PaddleOCRExtractor(llm=llm, settings=settings)

    raise ValueError(f"Unknown OCR_PROVIDER: {settings.ocr_provider!r}")
