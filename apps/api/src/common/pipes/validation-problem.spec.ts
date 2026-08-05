import { InviteVendorInputSchema, OnboardingStep1Schema } from '@procureflow/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import type { ZodSchema } from 'zod';

import { ProblemExceptionFilter } from '../filters/problem.filter';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Contract for the validation seam: a rejected body must leave the API as
 * problem+json carrying one issue per bad field, with a message a vendor can act
 * on. The client renders `context.issues` directly, so anything vague or
 * Zod-flavoured here ("Invalid email") is what the user ends up reading.
 */

interface ProblemBody {
  status: number;
  detail?: string;
  context?: { issues?: { path: string; message: string }[] };
}

/** Runs a body through the pipe and the global filter, returning the wire body. */
function reject(schema: ZodSchema, body: unknown): ProblemBody {
  const json = vi.fn();
  const res = {
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    json,
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ originalUrl: '/vendors/invite', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  try {
    new ZodValidationPipe(schema).transform(body, { type: 'body' } as never);
    throw new Error('expected the schema to reject this body');
  } catch (err) {
    new ProblemExceptionFilter().catch(err, host);
  }
  return json.mock.calls[0]?.[0] as ProblemBody;
}

describe('validation → problem+json', () => {
  it('reports the offending field and a fixable message for a malformed email', () => {
    const problem = reject(InviteVendorInputSchema, {
      legalEntityName: 'Sau Rang India',
      name: 'Kapil',
      // The real-world failure: the "@" is missing.
      email: 'saurangindia.gmail.com',
      categoryKey: 'packaging',
    });

    expect(problem.status).toBe(422);
    expect(problem.context?.issues).toEqual([
      { path: 'email', message: 'Enter a valid email address, e.g. name@company.com' },
    ]);
    // `detail` stays generic — which is exactly why the client must read `issues`.
    expect(problem.detail).toBe('Request validation failed');
  });

  it('tells a vendor who pasted their GSTIN into PAN where the PAN actually is', () => {
    const problem = reject(OnboardingStep1Schema, {
      legalEntityType: 'PVT_LTD',
      legalEntityName: 'Sau Rang India',
      businessPan: '07AFMFS3755D1ZS', // 15-char GSTIN, not a PAN
      addressLine1: 'B-66, Flatted Factory Complex, Jhandewalan',
      city: 'New Delhi',
      stateCode: 'DEL', // state name, not the 2-digit GST code
      pincode: '110055',
      primaryContactName: 'Kapil',
      primaryContactEmail: 'saurangindia@gmail.com',
      primaryContactPhone: '9212003772',
    });

    const byPath = Object.fromEntries(
      (problem.context?.issues ?? []).map((i) => [i.path, i.message]),
    );
    // Both bad fields are reported together, so one save surfaces every problem.
    expect(Object.keys(byPath).sort()).toEqual(['businessPan', 'stateCode']);
    expect(byPath.businessPan).toContain('characters 3–12');
    expect(byPath.stateCode).toContain('07 for Delhi');
  });

  it('emits one issue per field so a form can mark them all at once', () => {
    const problem = reject(InviteVendorInputSchema, {
      legalEntityName: 'X',
      name: 'Y',
      email: 'nope',
      categoryKey: '',
    });
    expect((problem.context?.issues ?? []).map((i) => i.path).sort()).toEqual([
      'categoryKey',
      'email',
      'legalEntityName',
      'name',
    ]);
  });
});
