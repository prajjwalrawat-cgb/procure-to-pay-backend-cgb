import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

import { ZodValidationError } from '../errors/domain-error';

/**
 * Global Zod validation (Master Context §3 rule #8 — never trust req.body).
 * Registered globally as a no-op guard; controllers attach a schema per param,
 * e.g. `@Body(new ZodValidationPipe(LoginInputSchema))`.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema?: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!this.schema || (metadata.type !== 'body' && metadata.type !== 'query')) {
      return value;
    }
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ZodValidationError('Request validation failed', {
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
