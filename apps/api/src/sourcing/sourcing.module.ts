import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module';
import { DomainEventsModule } from '../common/events/domain-event.service';
import { StorageModule } from '../common/storage/storage.service';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { AwardJustificationService } from './award-justification.service';
import { AwardService } from './award.service';
import { QuoteEvaluationService } from './quote-evaluation.service';
import { QuoteOpenService } from './quote-open.service';
import { QuoteService } from './quote.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { RfqController } from './rfq.controller';
import { RfqQaService } from './rfq-qa.service';
import { RfqQueryService } from './rfq-query.service';
import { RfqService } from './rfq.service';
import { SourcingAuditService } from './sourcing-audit.service';
import { VendorRfqService } from './vendor-rfq.service';
import { VendorResolverService } from './vendor-resolver.service';
import { VendorScorecardService } from './vendor-scorecard.service';
import { VendorSourcingController } from './vendor-sourcing.controller';

/**
 * Sourcing / RFQ (Slice 6). The full competitive-quote lifecycle: draft →
 * invite → publish → Q&A/corrigenda → sealed quotes → witnessed open ceremony →
 * landed-cost normalisation → weighted evaluation → split award → approval →
 * PO(s). Reuses the Slice 2 approval engine (RFQ_AWARD) and Slice 4's
 * createFromRequisition; reads Slice 5 GRN data for vendor scorecards.
 */
@Module({
  imports: [ApprovalsModule, DomainEventsModule, StorageModule, PurchaseOrdersModule],
  controllers: [RfqController, VendorSourcingController],
  providers: [
    RfqService,
    RfqQueryService,
    RfqQaService,
    QuoteService,
    QuoteOpenService,
    QuoteEvaluationService,
    ReverseAuctionService,
    AwardService,
    AwardJustificationService,
    SourcingAuditService,
    VendorRfqService,
    VendorResolverService,
    VendorScorecardService,
  ],
  exports: [VendorScorecardService, AwardService],
})
export class SourcingModule {}
