import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';
import { StorageService } from '../../common/storage/storage.service';
import type { IOcrProvider, OcrExtraction } from './ocr.provider';

interface OcrApiResponse {
  vendor_invoice_ref?: string;
  invoice_date?: string;
  irn?: string;
  eway_bill_no?: string;
  line_items?: {
    description?: string | null;
    uom?: string | null;
    quantity?: string | null;
    unit_price?: string | null;
    tax_rate?: string | null;
  }[];
  confidence?: number;
}

/**
 * Minimal shape of the `fetch` Response we consume. Annotated explicitly so the
 * build never depends on the ambient global `Response` type, which — under
 * `lib: ["ES2022"]` (no DOM) — resolves to `{}` in environments where DOM-ish
 * globals leak onto `globalThis`, dropping `ok`/`status`/`json` (breaks the
 * Vercel build while compiling fine locally).
 */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * RealOcrProvider (Slice 10a). Calls a configured commercial document-AI OCR
 * endpoint (`OCR_API_URL`) and normalises its response into the unchanged
 * `IOcrProvider` contract — so `MatchEngine` and the rest of the invoice pipeline
 * require zero changes. Selected by the OCR provider factory only when
 * `OCR_API_URL` is set; retry/circuit-breaker/cost-logging are applied by the
 * OcrProcessor orchestrator (ADR-032), not here — this stays a thin adapter.
 *
 * No signed OCR contract exists in this environment, so this path is wired but
 * unexercised; the sandbox simulator runs by default.
 */
@Injectable()
export class RealOcrProvider implements IOcrProvider {
  private readonly logger = new Logger(RealOcrProvider.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly storage: StorageService,
  ) {}

  async extract(s3Key: string): Promise<OcrExtraction> {
    const baseUrl = this.config.get('OCR_API_URL', { infer: true });
    // The document is fetched via a short-lived presigned URL and handed to the
    // provider (or streamed — provider-specific). Kept generic behind the interface.
    const url = await this.storage.presignedGetUrl(s3Key).catch(() => '');
    const res = (await fetch(`${baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_url: url }),
    })) as FetchResponse;
    if (!res.ok) {
      throw new Error(`OCR provider returned ${res.status}`);
    }
    const body = (await res.json()) as OcrApiResponse;
    return this.normalise(body);
  }

  private normalise(body: OcrApiResponse): OcrExtraction {
    // The provider may omit fields on partial extractions; the invoice pipeline
    // feeds qty/unitPrice/taxRate straight into Decimal math, so coerce every
    // numeric line field to a safe numeric string and clamp confidence to 0..1.
    const num = (v: string | null | undefined, fallback: string): string => {
      const n = Number(v);
      return v != null && v !== '' && Number.isFinite(n) ? String(n) : fallback;
    };
    return {
      vendorInvoiceRef: body.vendor_invoice_ref,
      invoiceDate: body.invoice_date,
      irn: body.irn,
      ewaybillNo: body.eway_bill_no,
      lines: (body.line_items ?? []).map((l) => ({
        itemDesc: l.description?.trim() || 'Unrecognised line',
        uom: l.uom?.trim() || 'NOS',
        qty: num(l.quantity, '1'),
        unitPrice: num(l.unit_price, '0'),
        taxRate: num(l.tax_rate, '0'),
      })),
      confidence: Math.max(0, Math.min(1, body.confidence ?? 0)),
    };
  }
}
