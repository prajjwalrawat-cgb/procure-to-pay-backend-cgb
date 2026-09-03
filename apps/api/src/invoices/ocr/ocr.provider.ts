import { Injectable } from '@nestjs/common';

export interface OcrLine {
  itemDesc: string;
  uom: string;
  qty: string;
  unitPrice: string;
  taxRate: string;
}

export interface OcrExtraction {
  vendorInvoiceRef?: string;
  invoiceDate?: string;
  /**
   * Supplier name printed on the document.
   *
   * The OCR service has always returned this — it even logs it — and the
   * adapter dropped it on the floor, so nothing ever asked whether the
   * document came from the vendor the PO was raised against. Quantities,
   * prices and dates can all be correct on somebody else's letterhead.
   */
  vendorName?: string;
  irn?: string;
  ewaybillNo?: string;
  lines: OcrLine[];
  /**
   * Grand total as PRINTED on the document, incl. tax. Kept separate from the
   * lines on purpose: the invoice's stored gross is computed by summing them,
   * so it corroborates a bad extraction as readily as a good one. This is the
   * one number that can contradict them, and the matcher's AMOUNT_MISMATCH
   * check is the only thing standing between a misread line item and a payment
   * for the wrong amount.
   *
   * Omitted when the provider did not return a total — downstream the check is
   * skipped and the invoice is reported as unverified, never as agreeing.
   */
  declaredTotal?: string;
  confidence: number; // 0..1
}

/** Swap-in interface for a real OCR provider later (Master Context §12 Slice 10). */
export interface IOcrProvider {
  extract(s3Key: string): Promise<OcrExtraction>;
}

/**
 * Mock OCR provider (Slice 1). Returns canned structured data for known demo
 * filenames, else a generic low-confidence result.
 */
@Injectable()
export class MockOcrProvider implements IOcrProvider {
  async extract(s3Key: string): Promise<OcrExtraction> {
    const name = s3Key.toLowerCase();
    if (name.includes('patel') && name.includes('4471')) {
      return {
        vendorInvoiceRef: 'PES/2026/4471',
        lines: [
          {
            itemDesc: 'SRB 22318',
            uom: 'EA',
            qty: '8',
            unitPrice: '18900',
            taxRate: '0.18',
          },
          {
            itemDesc: 'SNL 518',
            uom: 'EA',
            qty: '2',
            unitPrice: '11200',
            taxRate: '0.18',
          },
          {
            itemDesc: 'Grease 15kg',
            uom: 'EA',
            qty: '1',
            unitPrice: '8400',
            taxRate: '0.18',
          },
          {
            itemDesc: 'Freight',
            uom: 'LOT',
            qty: '1',
            unitPrice: '1800',
            taxRate: '0.18',
          },
        ],
        vendorName: 'Patel Engineering Services',
        // (8×18900 + 2×11200 + 8400 + 1800) × 1.18
        declaredTotal: '216884.00',
        confidence: 0.97,
      };
    }
    if (name.includes('patel')) {
      return {
        lines: [
          {
            itemDesc: 'SRB 22318',
            uom: 'EA',
            qty: '8',
            unitPrice: '18900',
            taxRate: '0.18',
          },
          {
            itemDesc: 'SNL 518',
            uom: 'EA',
            qty: '2',
            unitPrice: '10800',
            taxRate: '0.18',
          },
          {
            itemDesc: 'Grease 15kg',
            uom: 'EA',
            qty: '1',
            unitPrice: '8400',
            taxRate: '0.18',
          },
        ],
        vendorName: 'Patel Engineering Services',
        // (8×18900 + 2×10800 + 8400) × 1.18
        declaredTotal: '213816.00',
        confidence: 0.95,
      };
    }
    // Unknown document → generic, low-confidence extraction.
    return {
      lines: [
        {
          itemDesc: 'Unrecognised line',
          uom: 'EA',
          qty: '1',
          unitPrice: '0',
          taxRate: '0.18',
        },
      ],
      confidence: 0.4,
    };
  }
}
