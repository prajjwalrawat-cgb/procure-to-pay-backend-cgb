"""Core OCR data models.

Lifted from the bot's `expense_engine/core/models.py`, trimmed to just the
invoice-extraction shapes the OCR service needs (no employee / policy / rule
models — those belong to the bot's expense engine, not to OCR).

The one deliberate addition over the bot: `LineItem` is now actually populated
by the adapters. The bot always returned `line_items=[]` because its expense
flow only needed header fields; the procure-to-pay 3-way match needs per-line
qty / uom / unit price / tax rate, so we map them here.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class LineItem:
    description: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None
    amount: Optional[float] = None
    uom: Optional[str] = None
    tax_rate: Optional[float] = None  # fractional, e.g. 0.18 for 18% GST


@dataclass
class InvoiceDTO:
    vendor_name: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None  # YYYY-MM-DD
    total_amount: float = 0.0
    currency: Optional[str] = None
    tax_amount: Optional[float] = None
    line_items: list[LineItem] = field(default_factory=list)
    raw_text: Optional[str] = None
    hsn_code: Optional[str] = None
    irn: Optional[str] = None
    eway_bill_no: Optional[str] = None
    confidence: float = 0.0  # 0..1, drives the tool's low-confidence routing


@dataclass
class ExtractedPage:
    page_number: int
    text: str
    confidence: Optional[float] = None


class ILLMProvider(ABC):
    """Structured-extraction contract used by the self-hosted OCR adapters."""

    @abstractmethod
    async def complete(
        self,
        system: str,
        user: str,
        temperature: float = 0,
        response_format: Optional[dict] = None,
    ) -> str:
        ...


class IDocExtractor(ABC):
    """Stage contract: file path -> structured invoice."""

    @abstractmethod
    async def extract(self, file_path: str, mime_type: Optional[str]) -> list[ExtractedPage]:
        ...

    @abstractmethod
    async def extract_invoice(self, file_path: str, mime_type: Optional[str]) -> InvoiceDTO:
        ...
