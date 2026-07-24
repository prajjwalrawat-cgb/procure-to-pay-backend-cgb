import { amount2dp, ddmmyyyy, sanitizeField, toOutput } from './format-utils';
import type { BankFileInput, BankFileOutput, IBankFileFormatter } from './types';

/**
 * ICICI Corporate Internet Banking (`ICICI_CINB`). A named-column CSV with LF
 * line endings (no trailer), payment mode fixed to NEFT, and a per-row value
 * date in dd/mm/yyyy. A trailing newline terminates the last record.
 */
const HEADER = 'PYMT_MODE,BENE_NAME,BENE_ACCT,IFSC,AMOUNT,VALUE_DATE,REMARKS';

export const iciciCinbFormatter: IBankFileFormatter = {
  key: 'ICICI_CINB',

  format(input: BankFileInput): BankFileOutput {
    const { meta, payees } = input;
    const rows: string[] = [HEADER];

    for (const p of payees) {
      rows.push(
        [
          'NEFT',
          sanitizeField(p.beneficiaryName),
          sanitizeField(p.beneficiaryAccount),
          sanitizeField(p.ifsc),
          amount2dp(p.amount),
          ddmmyyyy(meta.cycleDate, '/'),
          sanitizeField(p.narration),
        ].join(','),
      );
    }

    const content = rows.join('\n') + '\n';
    return toOutput(`ICICI_CINB_${meta.runNumber}.csv`, content, payees.length);
  },
};
