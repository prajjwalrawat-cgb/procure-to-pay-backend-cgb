import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit key = authenticated user id, falling back to client IP for
 * unauthenticated (public) routes (Master Context §8 — "300 req/min per user").
 * Placed after JwtAuthGuard so `request.user` is populated for authed routes.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: {
    user?: { userId?: string };
    ip?: string;
  }): Promise<string> {
    return Promise.resolve(req.user?.userId ?? req.ip ?? 'anon');
  }
}
