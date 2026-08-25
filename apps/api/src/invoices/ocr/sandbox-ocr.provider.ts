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
 *   • name contains 'badtotal' → a printed total that disagrees with the lines,
 *     as if a line item had been dropped (→ AMOUNT_MISMATCH)
 *   • name contains 'nototal'  → no printed total at all (→ check skipped, and
 *     the invoice reports as unverified rather than clean)
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

    /**
     * The total the simulated document claims to print. Faithful by default —
     * a simulator that always disagreed with itself would make the check look
     * broken — with two named branches so both failure modes are demonstrable:
     * a total that contradicts the lines, and no total at all.
     */
    const declared = (lineSum: string): string | undefined => {
      if (name.includes('nototal')) return undefined;
      if (name.includes('badtotal')) {
        // As if one line had been dropped from the extraction: the document
        // foots higher than the lines we managed to read.
        return (Number(lineSum) + 47_200).toFixed(2);
      }
      return lineSum;
    };

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
        // (8×18900 + 2×11200 + 8400) × 1.18
        declaredTotal: declared('214760.00'),
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
      // 10000 × 1.18
      declaredTotal: declared('11800.00'),
      confidence: lowConf ? 0.52 : 0.88,
    };
  }
}
