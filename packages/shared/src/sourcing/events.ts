/**
 * Typed sourcing domain-event payloads (Slice 6, Master Context §3 rule #9).
 * The bus persists `Record<string, unknown>`; these document the agreed shape.
 */

export interface RfqPublishedEvent {
  rfqId: string;
  number: string;
  invitationCount: number;
}

export interface QuoteSubmittedEvent {
  quoteId: string;
  rfqId: string;
  vendorId: string;
  submissionHash: string;
}

export interface QuoteOpenedEvent {
  rfqId: string;
  envelope: 'TECHNICAL' | 'COMMERCIAL' | 'SINGLE';
  quoteCount: number;
  participants: string[];
}

export interface AwardRecommendedEvent {
  awardId: string;
  rfqId: string;
  vendorIds: string[];
  totalValue: string;
}

export interface AwardApprovedEvent {
  awardId: string;
  rfqId: string;
}

export interface ReverseAuctionRoundStartedEvent {
  roundId: string;
  rfqId: string;
  roundNo: number;
  startingPrice: string;
}

export interface ReverseAuctionBidPlacedEvent {
  roundId: string;
  quoteId: string;
  vendorId: string;
  bidPrice: string;
  extended: boolean;
}

export const SOURCING_EVENTS = {
  RFQ_PUBLISHED: 'RfqPublished',
  RFQ_CANCELLED: 'RfqCancelled',
  RFQ_CORRIGENDUM_ISSUED: 'RfqCorrigendumIssued',
  QUOTE_SUBMITTED: 'QuoteSubmitted',
  QUOTE_OPENED: 'QuoteOpened',
  AWARD_RECOMMENDED: 'AwardRecommended',
  AWARD_APPROVED: 'AwardApproved',
  REVERSE_AUCTION_ROUND_STARTED: 'ReverseAuctionRoundStarted',
  REVERSE_AUCTION_BID_PLACED: 'ReverseAuctionBidPlaced',
} as const;
