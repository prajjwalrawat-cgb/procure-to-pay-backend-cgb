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

/** The signed-in user's own organisation. Every screen that names the buying
 *  org reads it from here — the name is tenant data, never a literal in the
 *  UI, so a second tenant sees its own name and not the first one's. */
export const SessionTenantSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type SessionTenant = z.infer<typeof SessionTenantSchema>;

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    roles: z.array(z.enum(ALL_ROLES as [string, ...string[]])),
    mfaEnabled: z.boolean(),
    tenant: SessionTenantSchema,
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

/** "I forgot my password" — the address to send a reset link to. The response
 *  is deliberately identical whether or not an account exists, so this can
 *  never be used to discover who has one. */
export const ForgotPasswordInputSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordInputSchema>;

/** Setting the new password from the emailed link. Same password rule as the
 *  invite flow, so a user meets one standard wherever they set a password. */
export const ResetPasswordInputSchema = z.object({
  token: z.string().min(10, 'This reset link is invalid or incomplete'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password cannot exceed 200 characters'),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordInputSchema>;

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
