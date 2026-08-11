/**
 * Vendor lifecycle domain-event payloads (Slice 7, Master Context §3 rule #9).
 */

export interface VendorInvitedEvent {
  vendorId: string;
  onboardingId: string;
  source: string;
  email: string;
}

export interface VendorSelfRegisteredEvent {
  vendorId: string;
  onboardingId: string;
  email: string;
}

export interface OnboardingCancelledEvent {
  vendorId: string;
  onboardingId: string;
  cancelledBy: string;
  reason: string;
}

export interface VendorActivatedEvent {
  vendorId: string;
  activatedBy: string;
}

export interface VendorSuspendedEvent {
  vendorId: string;
  suspensionId: string;
  reasonCode: string;
  type: string;
}

export interface VendorBlacklistedEvent {
  vendorId: string;
  suspensionId: string;
}

export interface ScreeningCompletedEvent {
  vendorId: string;
  screeningId: string;
  screeningType: string;
  status: string;
}

export interface ScreeningFlaggedEvent {
  vendorId: string;
  screeningId: string;
  screeningType: string;
  severity: string;
}

export interface DocumentExpiringWarningEvent {
  vendorId: string;
  documentId: string;
  docType: string;
  validTo: string;
  daysRemaining: number;
}

export interface DocumentExpiredEvent {
  vendorId: string;
  documentId: string;
  docType: string;
  wasMandatory: boolean;
}

export interface VendorScorecardComputedEvent {
  vendorId: string;
  categoryKey: string;
  score: number | null;
  grade: string;
}

export const VENDOR_EVENTS = {
  VENDOR_INVITED: 'VendorInvited',
  VENDOR_SELF_REGISTERED: 'VendorSelfRegistered',
  ONBOARDING_CANCELLED: 'OnboardingCancelled',
  VENDOR_ACTIVATED: 'VendorActivated',
  VENDOR_SUSPENDED: 'VendorSuspended',
  VENDOR_BLACKLISTED: 'VendorBlacklisted',
  SCREENING_COMPLETED: 'ScreeningCompleted',
  SCREENING_FLAGGED: 'ScreeningFlagged',
  DOCUMENT_EXPIRING_WARNING: 'DocumentExpiringWarning',
  DOCUMENT_EXPIRED: 'DocumentExpired',
  VENDOR_SCORECARD_COMPUTED: 'VendorScorecardComputed',
  VENDOR_CHANGE_REQUESTED: 'VendorChangeRequested',
} as const;
