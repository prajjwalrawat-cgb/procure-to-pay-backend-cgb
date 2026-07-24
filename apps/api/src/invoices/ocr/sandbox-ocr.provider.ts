import { Injectable } from '@nestjs/common';

import type { IOcrProvider, OcrExtraction } from './ocr.provider';

/**
 * SandboxOcrProvider (Slice 10a). The clearly-labelled deterministic simulator
 * that stands in for a real document-AI OCR vendor until a contract is signed.
 * It exercises every branch the orchestrator must handle, keyed off the file name
 * so demos + tests are reproducible:
 *   • name contains 'ocrfail'  → throws (permanent provider failure → OCR_FAILED)
 *   • name contains 'lowconf' / 'blurry' → confidence 0.55 (→ manual review)
 *   • name contains 'patel'    → high-confidence canned invoice data
 *   • otherwise                → a generic high-confidence single-line extraction
 * Swapping in the real provider is a config change (`OCR_API_URL`), not a code one.
 */
@Injectable()
export class SandboxOcrProvider implements IOcrProvider {
  async extract(s3Key: string): Promise<OcrExtraction> {
    const name = s3Key.toLowerCase();

    if (name.includes('ocrfail')) {
      throw new Error('OCR provider sandbox: simulated permanent extraction failure');
    }

    const lowConf = name.includes('lowconf') || name.includes('blurry');

    if (name.includes('patel')) {
      return {
        vendorInvoiceRef: name.includes('4471') ? 'PES/2026/4471' : undefined,
        invoiceDate: new Date().toISOString(),
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
        ],
        confidence: lowConf ? 0.55 : 0.96,
      };
    }

    return {
      invoiceDate: new Date().toISOString(),
      lines: [
        {
          itemDesc: 'Supply as per invoice',
          uom: 'LOT',
          qty: '1',
          unitPrice: '10000',
          taxRate: '0.18',
        },
      ],
      confidence: lowConf ? 0.52 : 0.88,
    };
  }
}
