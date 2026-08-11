-- Buyer-side cancellation of an invitation that the vendor never submitted.
-- Distinct from REJECTED, which is a reviewer's verdict on a submitted
-- application, so the onboarding queue can tell "we withdrew this" apart from
-- "we turned it down".
ALTER TYPE "OnboardingReviewDecision" ADD VALUE IF NOT EXISTS 'CANCELLED';
