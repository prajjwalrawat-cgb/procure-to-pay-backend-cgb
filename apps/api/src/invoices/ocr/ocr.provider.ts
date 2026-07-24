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
  irn?: string;
  ewaybillNo?: string;
  lines: OcrLine[];
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
