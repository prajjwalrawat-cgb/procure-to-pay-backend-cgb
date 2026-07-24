# OCR Service

The invoice-OCR module lifted out of the bot project, running as a standalone
sidecar. It contains **only** the OCR extraction engine (Azure Document
Intelligence + self-hosted RapidOCR/PaddleOCR) — none of the bot's expense,
policy, employee, or handler code.

It plugs into the procure-to-pay tool through the OCR seam that already exists:
`apps/api/src/invoices/ocr/real-ocr.provider.ts` POSTs to `OCR_API_URL/extract`,
so the invoice pipeline (queue → worker → circuit-breaker → `applyOcr` → 3-way
match) uses it with **no pipeline changes**.

## Engines (configurable — `OCR_PROVIDER`)

| `OCR_PROVIDER`            | Engine                              | Needs                                   |
| ------------------------ | ----------------------------------- | --------------------------------------- |
| `azure_doc_intelligence` | Azure DI `prebuilt-invoice` (default) | `AZURE_DOC_INTEL_ENDPOINT` + `_KEY`     |
| `rapidocr`               | RapidOCR (ONNX) + LLM extraction    | `LLM_API_KEY` (or Azure OpenAI base)    |
| `paddleocr`              | PaddleOCR + LLM extraction          | `LLM_API_KEY`, `paddleocr` installed    |

Azure returns typed invoice fields **including line items**; the self-hosted
engines produce raw text and an LLM turns it into the same structured shape.
(The original bot discarded line items — this port maps them, because the tool's
3-way match needs per-line qty/uom/unit price/tax rate.)

## API

`POST /extract`

```json
{ "document_url": "https://…presigned-get-url…" }
```

Response (exactly what `RealOcrProvider` consumes):

```json
{
  "vendor_invoice_ref": "PES/2026/4471",
  "invoice_date": "2026-07-17",
  "vendor_name": "Patel Engineering",
  "irn": null,
  "eway_bill_no": null,
  "hsn_code": "84821000",
  "currency": "INR",
  "total_amount": 176800.0,
  "tax_amount": 26976.0,
  "line_items": [
    { "description": "SRB 22318", "uom": "EA", "quantity": "8", "unit_price": "18900", "tax_rate": "0.18" }
  ],
  "confidence": 0.94
}
```

`GET /health` → `{ "status": "ok", "provider": "azure" }`

## Run locally (without Docker)

```bash
cd services/ocr-service
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env   # fill in AZURE_DOC_INTEL_* or LLM_* + OCR_PROVIDER
uvicorn app.main:app --reload --port 8090
```

Then point the API at it: `OCR_API_URL=http://localhost:8090` in the repo `.env`,
and restart the API. Uploaded invoices now flow through real OCR.

## Run with Docker Compose

```bash
docker compose up ocr-service        # builds services/ocr-service
```

## ⚠️ Presigned-URL reachability

`RealOcrProvider` presigns an S3/MinIO GET URL and hands it to this service. The
URL's host must resolve **from wherever this service runs**:

- Service on host (uvicorn), MinIO on `localhost:9000` → works as-is.
- Service in the compose network → it cannot reach `localhost:9000`; the API must
  presign against `http://minio:9000`. Set the API's S3 public endpoint
  accordingly (or run the OCR service on the host during dev).

## Quick manual test

```bash
# Azure path — point document_url at any reachable invoice PDF/image URL:
curl -s localhost:8090/extract -H 'content-type: application/json' \
  -d '{"document_url":"https://example.com/some-invoice.pdf"}' | jq
```

A permanent failure here (bad config, provider down) returns HTTP 5xx, which the
tool's circuit-breaker turns into `OCR_FAILED` → manual data-entry fallback, so an
invoice is never lost.
