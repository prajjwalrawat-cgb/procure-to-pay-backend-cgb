import { z } from 'zod';

import { ALL_ROLES } from '../constants/roles';

/** Portal discriminator sent by the frontends; decides JWT audience. */
export const PortalSchema = z.enum(['buyer', 'vendor']);
export type Portal = z.infer<typeof PortalSchema>;

export const LoginInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
  // Optional TOTP code, required only once MFA is enabled for the user.
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'MFA code must be 6 digits')
    .optional(),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    roles: z.array(z.enum(ALL_ROLES as [string, ...string[]])),
    mfaEnabled: z.boolean(),
  }),
  tokens: TokenPairSchema,
  // Present when MFA is required but no code was supplied.
  mfaRequired: z.boolean().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof RefreshInputSchema>;

export const MfaVerifyInputSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'MFA code must be 6 digits'),
});
export type MfaVerifyInput = z.infer<typeof MfaVerifyInputSchema>;

export const MfaSetupResponseSchema = z.object({
  provisioningUri: z.string(),
  qrSvg: z.string(),
});
export type MfaSetupResponse = z.infer<typeof MfaSetupResponseSchema>;

/**
 * JWT payload shape. `aud` separates buyer vs vendor tokens (Master Context
 * §3 rule #11). `tid` is the tenant id injected into `SET LOCAL app.tenant_id`.
 */
export const TokenPayloadSchema = z.object({
  sub: z.string(), // user id (ULID)
  tid: z.string().uuid(), // tenant id
  aud: PortalSchema,
  roles: z.array(z.string()),
  perms: z.array(z.string()),
  type: z.enum(['access', 'refresh']),
});
export type TokenPayload = z.infer<typeof TokenPayloadSchema>;
