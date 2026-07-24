import { amount2dp, sanitizeField, sum2dp, toOutput, yyyymmdd } from './format-utils';
import type { BankFileInput, BankFileOutput, IBankFileFormatter } from './types';

/**
 * HDFC NEFT bulk upload (`NEFT_BULK`). CRLF line endings with a trailing CRLF
 * (an HDFC quirk). Header row carries the tenant onboarding code; data rows use
 * HDFC's published column order: account_id, ifsc, name, amount, ref, narration.
 * A trailer row repeats the count + total for the bank's reconciliation.
 */
export const hdfcNeftBulkFormatter: IBankFileFormatter = {
  key: 'NEFT_BULK',

  format(input: BankFileInput): BankFileOutput {
    const { meta, payees } = input;
    const rows: string[] = [];
    const total = sum2dp(payees.map((p) => p.amount));

    rows.push(
      [
        'H',
        sanitizeField(meta.tenantCode),
        sanitizeField(meta.runNumber),
        yyyymmdd(meta.cycleDate),
        String(payees.length),
        total,
      ].join(','),
    );

    for (const p of payees) {
      rows.push(
        [
          sanitizeField(p.beneficiaryAccount),
          sanitizeField(p.ifsc),
          sanitizeField(p.beneficiaryName),
          amount2dp(p.amount),
          sanitizeField(p.ref),
          sanitizeField(p.narration),
        ].join(','),
      );
    }

    rows.push(['T', String(payees.length), total].join(','));

    // CRLF between rows and a trailing CRLF at end of file.
    const content = rows.join('\r\n') + '\r\n';
    return toOutput(`HDFC_NEFT_${meta.runNumber}.csv`, content, payees.length);
  },
};
