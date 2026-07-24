"""OCR service settings.

A trimmed version of the bot's `EngineSettings` — only the OCR + LLM knobs the
extraction path needs. Everything else (employee dir, master data, policy,
storage) belonged to the bot's expense engine and is intentionally dropped.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class OcrSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Which engine. azure_doc_intelligence (default) | azure | paddleocr | rapidocr
    ocr_provider: str = Field("azure", alias="OCR_PROVIDER")

    # Azure Document Intelligence
    azure_doc_intel_endpoint: Optional[str] = Field(None, alias="AZURE_DOC_INTEL_ENDPOINT")
    azure_doc_intel_key: Optional[str] = Field(None, alias="AZURE_DOC_INTEL_KEY")

    # Self-hosted OCR (paddle / rapid)
    paddleocr_lang: str = Field("en", alias="PADDLEOCR_LANG")
    paddleocr_use_angle_cls: bool = Field(True, alias="PADDLEOCR_USE_ANGLE_CLS")
    paddleocr_use_gpu: bool = Field(False, alias="PADDLEOCR_USE_GPU")

    # LLM for structured extraction (required for paddle/rapid; Azure fallback).
    # Uses litellm, so LLM_MODEL can be any provider litellm supports.
    llm_model: str = Field("gpt-4o", alias="LLM_MODEL")
    llm_api_key: Optional[str] = Field(None, alias="LLM_API_KEY")
    llm_api_base: Optional[str] = Field(None, alias="LLM_API_BASE")
    llm_api_version: Optional[str] = Field(None, alias="LLM_API_VERSION")
    llm_deployment_name: Optional[str] = Field(None, alias="LLM_DEPLOYMENT_NAME")

    # Extraction defaults. GST invoices frequently omit a per-line tax rate; the
    # tool recomputes totals from these, and anything shaky is routed to manual
    # review, so a sensible default is safe. Override per deployment.
    default_tax_rate: float = Field(0.18, alias="OCR_DEFAULT_TAX_RATE")
    default_uom: str = Field("NOS", alias="OCR_DEFAULT_UOM")

    # Download limits for the presigned document URL.
    download_timeout_seconds: float = Field(30.0, alias="OCR_DOWNLOAD_TIMEOUT_SECONDS")
    max_document_mb: float = Field(25.0, alias="OCR_MAX_DOCUMENT_MB")

    def normalized_provider(self) -> str:
        p = (self.ocr_provider or "").strip().lower()
        return {"azure_doc_intelligence": "azure"}.get(p, p)


@lru_cache
def get_settings() -> OcrSettings:
    return OcrSettings()
