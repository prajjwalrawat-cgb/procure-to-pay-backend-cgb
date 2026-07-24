-- Pending-invite marker on User. Set when an admin invites a user and cleared
-- when they accept; a row with invited_at IS NOT NULL AND is_active = false is
-- a pending invitation. Nullable, no backfill needed (existing users = active).
ALTER TABLE "User" ADD COLUMN "invited_at" TIMESTAMPTZ(6);
