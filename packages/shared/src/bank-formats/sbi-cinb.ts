import { amount2dp, ddmmyyyy, sanitizeField, sum2dp, toOutput } from './format-utils';
import type { BankFileInput, BankFileOutput, IBankFileFormatter } from './types';

/**
 * SBI Corporate Internet Banking bulk (`SBI_CINB`). LF line endings, a control
 * header carrying the debit account + value date (dd-mm-yyyy) + count, then
 * 1-based serial-numbered beneficiary rows.
 */
export const sbiCinbFormatter: IBankFileFormatter = {
  key: 'SBI_CINB',

  format(input: BankFileInput): BankFileOutput {
    const { meta, payees } = input;
    const rows: string[] = [];

    rows.push(
      [
        'SBBULK',
        sanitizeField(meta.debitAccountLast4),
        sanitizeField(meta.runNumber),
        ddmmyyyy(meta.cycleDate, '-'),
        String(payees.length),
        sum2dp(payees.map((p) => p.amount)),
      ].join(','),
    );

    payees.forEach((p, i) => {
      rows.push(
        [
          String(i + 1),
          sanitizeField(p.beneficiaryName),
          sanitizeField(p.beneficiaryAccount),
          sanitizeField(p.ifsc),
          amount2dp(p.amount),
          sanitizeField(p.narration),
        ].join(','),
      );
    });

    const content = rows.join('\n') + '\n';
    return toOutput(`SBI_CINB_${meta.runNumber}.csv`, content, payees.length);
  },
};
