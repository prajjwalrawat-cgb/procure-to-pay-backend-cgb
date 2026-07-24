import { Injectable } from '@nestjs/common';
import {
  computeDocTax,
  computeLineTax,
  determineTaxKind,
  type TaxKind,
} from '@procureflow/shared';
import Decimal from 'decimal.js';

/**
 * RequisitionValidator (Slice 4) — PURE. No Prisma, no clock. Computes line and
 * document totals with the shared GST engine and reports validation issues.
 * Extracted so the money + tax logic is unit-tested independently of routing.
 */

export interface ValidatorLineInput {
  lineNo: number;
  itemId?: string | null;
  itemDesc: string;
  hsnCode?: string | null;
  uom: string;
  qty: string;
  unitPrice: string;
  discountPct?: string;
  taxRate: string;
  reasonCode?: string | null;
  /** Item-master GST rate, when catalogued — used for HSN/GST consistency. */
  expectedGstRate?: string | null;
  isImportDuty?: boolean;
}

export interface ValidatorContext {
  plantStateCode: string;
  vendorGstin?: string | null;
  isUrd?: boolean;
  /** PR without a vendor still shows a provisional intra-state estimate. */
  estimateWhenUnknown?: boolean;
}

export interface ValidatedLine {
  lineNo: number;
  lineSubtotal: string;
  taxRate: string;
  taxKind: TaxKind;
  taxAmount: string;
  lineTotal: string;
  isReverseCharge: boolean;
  isImportDuty: boolean;
}

export interface ValidationIssue {
  lineNo: number | null;
  code:
    | 'NON_POSITIVE_QTY'
    | 'NEGATIVE_PRICE'
    | 'MISSING_REASON_CODE'
    | 'HSN_GST_MISMATCH'
    | 'NO_LINES';
  message: string;
}

export interface ValidationResult {
  lines: ValidatedLine[];
  subtotal: string;
  taxAmount: string;
  total: string;
  taxKind: TaxKind;
  isReverseCharge: boolean;
  issues: ValidationIssue[];
}

@Injectable()
export class RequisitionValidator {
  /** Compute totals + collect issues for a set of requisition lines. */
  validate(lines: ValidatorLineInput[], ctx: ValidatorContext): ValidationResult {
    const issues: ValidationIssue[] = [];
    if (lines.length === 0) {
      issues.push({
        lineNo: null,
        code: 'NO_LINES',
        message: 'At least one line is required.',
      });
    }

    const validated: ValidatedLine[] = lines.map((line) => {
      if (!new Decimal(line.qty).greaterThan(0)) {
        issues.push({
          lineNo: line.lineNo,
          code: 'NON_POSITIVE_QTY',
          message: `Line ${line.lineNo}: quantity must be greater than zero.`,
        });
      }
      if (new Decimal(line.unitPrice).lessThan(0)) {
        issues.push({
          lineNo: line.lineNo,
          code: 'NEGATIVE_PRICE',
          message: `Line ${line.lineNo}: unit price cannot be negative.`,
        });
      }
      // Non-catalogued lines require a reason code.
      if (!line.itemId && !line.reasonCode) {
        issues.push({
          lineNo: line.lineNo,
          code: 'MISSING_REASON_CODE',
          message: `Line ${line.lineNo}: non-catalogued items require a reason code.`,
        });
      }
      // HSN/GST consistency against the item master (warning, not a hard block).
      if (
        line.expectedGstRate != null &&
        !new Decimal(line.taxRate).equals(line.expectedGstRate)
      ) {
        issues.push({
          lineNo: line.lineNo,
          code: 'HSN_GST_MISMATCH',
          message: `Line ${line.lineNo}: tax rate ${line.taxRate} differs from the item master GST ${line.expectedGstRate}.`,
        });
      }

      const tax = computeLineTax(
        {
          qty: line.qty,
          unitPrice: line.unitPrice,
          discountPct: line.discountPct,
          taxRate: line.taxRate,
        },
        ctx,
      );
      return {
        lineNo: line.lineNo,
        lineSubtotal: tax.lineSubtotal,
        taxRate: tax.taxRate,
        taxKind: tax.taxKind,
        taxAmount: tax.taxAmount,
        lineTotal: tax.lineTotal,
        isReverseCharge: tax.isReverseCharge,
        isImportDuty: line.isImportDuty ?? false,
      };
    });

    const doc = computeDocTax(
      lines.map((l) => ({
        qty: l.qty,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct,
        taxRate: l.taxRate,
      })),
      ctx,
    );

    return {
      lines: validated,
      subtotal: doc.subtotal,
      taxAmount: doc.taxAmount,
      total: doc.total,
      taxKind: determineTaxKind(ctx),
      isReverseCharge: doc.isReverseCharge,
      issues,
    };
  }

  /** True when no blocking issue was raised (HSN/GST mismatch is a warning). */
  isSubmittable(result: ValidationResult): boolean {
    return result.issues.every((i) => i.code === 'HSN_GST_MISMATCH');
  }
}
