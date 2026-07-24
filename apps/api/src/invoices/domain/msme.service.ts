import { Injectable } from '@nestjs/common';
import { addDaysUtc, type MsmeAgingBucket } from '@procureflow/shared';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Days-remaining at/under which an MSME invoice is "approaching" the cap. */
const APPROACHING_WINDOW_DAYS = 7;

/**
 * MSME Section 15 clock (Master Context §9). Due date = invoice date + the
 * tenant's payment cap (default 45 days). Buckets: SAFE (> 7 days left),
 * APPROACHING (0–7 days left), BREACH (past due).
 */
@Injectable()
export class MsmeService {
  static computeDueDate(invoiceDate: Date, capDays: number): Date {
    return addDaysUtc(invoiceDate, capDays);
  }

  /** Whole days from `now` until the due date (negative once overdue). */
  static daysRemaining(dueDate: Date, now: Date): number {
    return Math.ceil((dueDate.getTime() - now.getTime()) / MS_PER_DAY);
  }

  static agingBucket(dueDate: Date, now: Date): MsmeAgingBucket {
    const remaining = MsmeService.daysRemaining(dueDate, now);
    if (remaining < 0) return 'BREACH';
    if (remaining <= APPROACHING_WINDOW_DAYS) return 'APPROACHING';
    return 'SAFE';
  }

  computeDueDate(invoiceDate: Date, capDays: number): Date {
    return MsmeService.computeDueDate(invoiceDate, capDays);
  }

  agingBucket(
    dueDate: Date | null,
    isMsme: boolean,
    now = new Date(),
  ): MsmeAgingBucket | null {
    if (!isMsme || !dueDate) return null;
    return MsmeService.agingBucket(dueDate, now);
  }

  daysRemaining(dueDate: Date | null, now = new Date()): number | null {
    return dueDate ? MsmeService.daysRemaining(dueDate, now) : null;
  }
}
