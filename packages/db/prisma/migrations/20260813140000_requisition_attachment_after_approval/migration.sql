-- =============================================================================
-- Mark attachments that were added after the PR was already approved.
--
-- Policy: a late document (typically a vendor PI) does NOT reopen the approval,
-- but it must never read as evidence the approver acted on. This flag drives the
-- "Added after approval" marker on the PR and the audit record.
--
-- Existing rows default to false: everything attached before this migration
-- predates the post-approval upload restriction.
-- =============================================================================

ALTER TABLE "RequisitionAttachment"
  ADD COLUMN "added_after_approval" BOOLEAN NOT NULL DEFAULT false;
