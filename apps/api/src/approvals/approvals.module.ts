import { Module } from '@nestjs/common';

import { DomainEventsModule } from '../common/events/domain-event.service';
import { ApprovalContextService } from './approval-context.service';
import {
  ApprovalMatrixController,
  ApprovalSimulateController,
} from './approval-matrix.controller';
import { ApprovalMatrixService } from './approval-matrix.service';
import { ApprovalRoutingService } from './approval-routing.service';
import { ApproverResolver } from './approver-resolver.service';
import { DelegationService } from './delegation.service';
import { DelegationsController } from './delegations.controller';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';
import { SlaService } from './sla.service';

/**
 * The generic approval engine (Slice 2). Consumed by InvoicesModule now and by
 * payment runs / PRs in later slices. Exports the routing service so document
 * modules can call `submit`, and the read side for detail pages.
 */
@Module({
  imports: [DomainEventsModule],
  controllers: [
    ApprovalMatrixController,
    ApprovalSimulateController,
    InboxController,
    NotificationsController,
    DelegationsController,
  ],
  providers: [
    ApprovalContextService,
    ApproverResolver,
    ApprovalMatrixService,
    ApprovalRoutingService,
    InboxService,
    DelegationService,
    NotificationService,
    SlaService,
  ],
  exports: [ApprovalRoutingService, ApprovalMatrixService, NotificationService],
})
export class ApprovalsModule {}
