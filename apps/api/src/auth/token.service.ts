import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  PortalSchema,
  TokenPayloadSchema,
  type Portal,
  type TokenPayload,
} from '@procureflow/shared';

import { decodePem, type Env } from '../config/env';

/** Short digest of the stored password hash. Not a secret (the token is signed
 *  and the digest is one-way) — it only has to change when the password does. */
export function passwordFingerprint(argonHash: string): string {
  return createHash('sha256').update(argonHash).digest('hex').slice(0, 16);
}

type TokenType = 'access' | 'refresh';

interface IssueInput {
  userId: string;
  tenantId: string;
  audience: Portal;
  roles: string[];
  perms: string[];
}

/**
 * RS256 JWTs (Master Context §3 rule #11 / Slice 0). 15-min access, 7-day
 * refresh. Buyer and vendor tokens carry different audiences and are not
 * interchangeable. Keys are base64-encoded PEMs from env.
 */
@Injectable()
export class TokenService {
  private readonly privateKey: string;
  private readonly publicKey: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.privateKey = decodePem(
      this.config.get('JWT_PRIVATE_KEY_BASE64', { infer: true }),
    );
    this.publicKey = decodePem(this.config.get('JWT_PUBLIC_KEY_BASE64', { infer: true }));
  }

  async issueAccess(input: IssueInput): Promise<{ token: string; expiresIn: number }> {
    const ttl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const token = await this.sign(input, 'access', ttl);
    return { token, expiresIn: 15 * 60 };
  }

  async issueRefresh(input: IssueInput): Promise<string> {
    const ttl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    return this.sign({ ...input, perms: [] }, 'refresh', ttl);
  }

  async verify(token: string, expectedAudience?: Portal): Promise<TokenPayload> {
    const raw = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      publicKey: this.publicKey,
      algorithms: ['RS256'],
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: expectedAudience,
    });
    return TokenPayloadSchema.parse(raw);
  }

  /**
   * Single-use-ish invite token for a newly-created (inactive) user. Carries the
   * user + tenant so the public accept-invite endpoint can open the right RLS
   * context and set the password. Uses a dedicated `invite` audience and a
   * `purpose` claim so it can never satisfy the buyer/vendor access-token guard
   * (which expects `type: access` and a buyer/vendor audience). 7-day validity.
   */
  async issueUserInvite(userId: string, tenantId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, tid: tenantId, purpose: 'user_invite' },
      {
        privateKey: this.privateKey,
        algorithm: 'RS256',
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: 'invite',
        expiresIn: '7d',
      },
    );
  }

  async verifyUserInvite(token: string): Promise<{ userId: string; tenantId: string }> {
    const raw = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      publicKey: this.publicKey,
      algorithms: ['RS256'],
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: 'invite',
    });
    if (
      raw.purpose !== 'user_invite' ||
      typeof raw.sub !== 'string' ||
      typeof raw.tid !== 'string'
    ) {
      throw new Error('Not a user invite token');
    }
    return { userId: raw.sub, tenantId: raw.tid };
  }

  /**
   * Password-reset link token. Short-lived (1 hour) and effectively single-use:
   * `pv` fingerprints the password hash it was issued against, so the moment the
   * password changes every outstanding link for that user stops verifying — a
   * reset link that has been used, or superseded by a newer request, is dead.
   * Its own `reset` audience and `purpose` claim keep it useless as an access
   * token. `portal` decides which sign-in page the user lands back on.
   */
  async issuePasswordReset(input: {
    userId: string;
    tenantId: string;
    portal: Portal;
    passwordHash: string;
  }): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: input.userId,
        tid: input.tenantId,
        portal: input.portal,
        pv: passwordFingerprint(input.passwordHash),
        purpose: 'password_reset',
      },
      {
        privateKey: this.privateKey,
        algorithm: 'RS256',
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: 'reset',
        expiresIn: '1h',
      },
    );
  }

  async verifyPasswordReset(token: string): Promise<{
    userId: string;
    tenantId: string;
    portal: Portal;
    passwordFingerprint: string;
  }> {
    const raw = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      publicKey: this.publicKey,
      algorithms: ['RS256'],
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: 'reset',
    });
    if (
      raw.purpose !== 'password_reset' ||
      typeof raw.sub !== 'string' ||
      typeof raw.tid !== 'string' ||
      typeof raw.pv !== 'string'
    ) {
      throw new Error('Not a password reset token');
    }
    return {
      userId: raw.sub,
      tenantId: raw.tid,
      portal: PortalSchema.catch('buyer').parse(raw.portal),
      passwordFingerprint: raw.pv,
    };
  }

  private async sign(input: IssueInput, type: TokenType, ttl: string): Promise<string> {
    const payload: TokenPayload = {
      sub: input.userId,
      tid: input.tenantId,
      aud: input.audience,
      roles: input.roles,
      perms: input.perms,
      type,
    };
    // `aud` is set on the payload; jsonwebtoken reads it directly.
    return this.jwt.signAsync(payload, {
      privateKey: this.privateKey,
      algorithm: 'RS256',
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      expiresIn: ttl,
    });
  }
}
