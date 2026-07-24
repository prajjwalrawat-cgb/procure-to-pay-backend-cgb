import { z } from 'zod';

/** Split an optional comma-separated query param into a string array. */
const csv = z
  .string()
  .nullish()
  .transform((v) => (v ? v.split(',').filter(Boolean) : undefined));

export const AuditQueryInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
  from: z.string().datetime().nullish(),
  to: z.string().datetime().nullish(),
  actorId: z.string().nullish(),
  action: csv.pipe(z.array(z.string()).optional()),
  entityType: csv.pipe(z.array(z.string()).optional()),
  entityId: z.string().nullish(),
  ip: z.string().nullish(),
  search: z.string().nullish(),
});
export type AuditQueryInput = z.infer<typeof AuditQueryInputSchema>;

export const AuditVerifyInputSchema = z.object({
  from: z.string().datetime().nullish(),
  to: z.string().datetime().nullish(),
});
export type AuditVerifyInput = z.infer<typeof AuditVerifyInputSchema>;

export interface AuditVerifyResult {
  verified: boolean;
  eventsChecked: number;
  firstBreakAt: string | null;
  from: string | null;
  to: string | null;
}

export interface AuditRecordView {
  id: string;
  timestamp: string;
  actorId: string | null;
  actorName: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  hashCurrent: string;
  hashPrevious: string | null;
}

export interface AuditListResponse {
  items: AuditRecordView[];
  nextCursor: string | null;
  totalEstimate: number;
}
