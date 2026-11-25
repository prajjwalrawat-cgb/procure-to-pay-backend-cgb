-- Move vendors whose latest onboarding was rejected off UNDER_REVIEW.
-- Only the latest onboarding counts, and only vendors still parked at
-- UNDER_REVIEW are touched — anyone since activated, suspended, blacklisted
-- or archived keeps the status they have.
UPDATE "Vendor" v
SET lifecycle_status = 'REJECTED', "updatedAt" = now()
FROM (
  SELECT DISTINCT ON (vendor_id) vendor_id, review_decision
  FROM "VendorOnboarding"
  ORDER BY vendor_id, started_at DESC
) latest
WHERE latest.vendor_id = v.id
  AND latest.review_decision = 'REJECTED'
  AND v.lifecycle_status = 'UNDER_REVIEW';
