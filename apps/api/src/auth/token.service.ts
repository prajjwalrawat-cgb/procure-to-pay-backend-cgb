import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenPayloadSchema, type Portal, type TokenPayload } from '@procureflow/shared';

import { decodePem, type Env } from '../config/env';

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
