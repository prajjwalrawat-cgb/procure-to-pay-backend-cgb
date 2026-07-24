"""Fetch the presigned document URL to a temp file for the OCR adapters.

`RealOcrProvider` (TS side) passes a short-lived presigned GET URL. Adapters need
a real local path (paddle/rapid read the file; azure base64-encodes it), and a
correct extension so PaddleOCR/RapidOCR pick the right decoder.
"""
from __future__ import annotations

import mimetypes
import os
import tempfile
from contextlib import contextmanager
from typing import Iterator, Optional
from urllib.parse import urlparse

import httpx

_CT_EXT = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
}


def _suffix(url: str, content_type: Optional[str]) -> str:
    path = urlparse(url).path
    _, ext = os.path.splitext(path)
    if ext:
        return ext
    ct = (content_type or "").split(";")[0].strip().lower()
    return _CT_EXT.get(ct) or mimetypes.guess_extension(ct) or ".bin"


@contextmanager
def download_to_temp(url: str, timeout: float, max_mb: float) -> Iterator[tuple[str, str]]:
    """Yield (local_path, content_type). Deletes the temp file on exit."""
    max_bytes = int(max_mb * 1024 * 1024)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            suffix = _suffix(url, content_type)
            fd, path = tempfile.mkstemp(suffix=suffix, prefix="ocr_")
            total = 0
            try:
                with os.fdopen(fd, "wb") as fh:
                    for chunk in resp.iter_bytes(chunk_size=65536):
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError(f"Document exceeds {max_mb} MB limit")
                        fh.write(chunk)
            except BaseException:
                _safe_unlink(path)
                raise
    try:
        yield path, content_type
    finally:
        _safe_unlink(path)


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
