"""LiteLLM-backed structured-extraction provider.

Ported near-verbatim from the bot's `litellm_adapter.py`, minus the usage-token
stashing (the OCR service does its own cost logging on the TS side via
IntegrationUsageLog). Only `complete()` is needed here; the bot's `stream()` was
for chat, which the OCR service does not do.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.models import ILLMProvider

logger = logging.getLogger(__name__)


class LiteLLMProvider(ILLMProvider):
    def __init__(
        self,
        model: str,
        api_key: Optional[str] = None,
        api_base: Optional[str] = None,
        api_version: Optional[str] = None,
        deployment_name: Optional[str] = None,
    ):
        import litellm  # deferred so azure-only deployments needn't install it

        self._litellm = litellm
        self._model = model
        self._api_key = api_key
        self._api_base = api_base
        self._api_version = api_version
        self._deployment_name = deployment_name

    def _kwargs(self) -> dict:
        kw: dict = {}
        if self._api_key:
            kw["api_key"] = self._api_key
        if self._api_base:
            kw["api_base"] = self._api_base
        if self._api_version:
            kw["api_version"] = self._api_version
        return kw

    def _model_name(self) -> str:
        if self._deployment_name:
            return f"azure/{self._deployment_name}"
        return self._model

    async def complete(
        self,
        system: str,
        user: str,
        temperature: float = 0,
        response_format: Optional[dict] = None,
    ) -> str:
        kw = self._kwargs()
        if response_format:
            kw["response_format"] = response_format
        resp = await self._litellm.acompletion(
            model=self._model_name(),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            **kw,
        )
        return resp.choices[0].message.content or ""
