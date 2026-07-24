import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  PERMISSIONS,
  QuoteAttachmentInputSchema,
  QuoteCreateInputSchema,
  QuoteUpdateInputSchema,
  QuoteWithdrawInputSchema,
  ReverseAuctionBidInputSchema,
  RfqDeclineInputSchema,
  RfqQuestionInputSchema,
  type QuoteAttachmentInput,
  type QuoteCreateInput,
  type QuoteUpdateInput,
  type QuoteView,
  type QuoteWithdrawInput,
  type ReverseAuctionBidInput,
  type RfqDeclineInput,
  type RfqDetailResponse,
  type RfqQuestionInput,
  type RfqQuestionView,
  type VendorRfqListResponse,
} from '@procureflow/shared';
import type { Observable } from 'rxjs';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequireAudience, RequirePermission } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { QuoteService } from './quote.service';
import { ReverseAuctionService } from './reverse-auction.service';
import { RfqQaService } from './rfq-qa.service';
import { VendorRfqService } from './vendor-rfq.service';

/** Vendor-portal sourcing endpoints — vendor JWT audience only (§3 rule #11). */
@Controller('vendor')
@RequireAudience('vendor')
export class VendorSourcingController {
  constructor(
    private readonly vendorRfq: VendorRfqService,
    private readonly quotes: QuoteService,
    private readonly qa: RfqQaService,
    private readonly reverseAuction: ReverseAuctionService,
  ) {}

  @Get('rfq')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async list(@CurrentUser() user: AuthUser): Promise<VendorRfqListResponse> {
    return this.vendorRfq.listInvited(user.userId);
  }

  @Get('rfq/:id')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RfqDetailResponse> {
    return this.vendorRfq.detail(user.userId, id);
  }

  @Get('rfq/:id/questions')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async questions(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<RfqQuestionView[]> {
    return this.qa.listQuestions(id, { isVendor: true, userId: user.userId });
  }

  @Post('rfq/:id/acknowledge')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async acknowledge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.vendorRfq.acknowledge(user.userId, id);
  }

  @Post('rfq/:id/decline')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqDeclineInputSchema)) dto: RfqDeclineInput,
  ): Promise<{ ok: true }> {
    return this.vendorRfq.decline(user.userId, id, dto.reason);
  }

  @Post('rfq/:id/questions')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async ask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RfqQuestionInputSchema)) dto: RfqQuestionInput,
  ): Promise<{ id: string }> {
    return this.qa.askQuestion(id, dto, user.userId);
  }

  @Get('quotes')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async myQuotes(@CurrentUser() user: AuthUser): Promise<QuoteView[]> {
    return this.vendorRfq.myQuotes(user.userId);
  }

  @Get('quotes/:id')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async quote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<QuoteView> {
    return this.vendorRfq.myQuote(user.userId, id);
  }

  @Post('quotes')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async createQuote(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(QuoteCreateInputSchema)) dto: QuoteCreateInput,
  ): Promise<{ id: string }> {
    return this.quotes.createDraft(dto, user.userId);
  }

  @Patch('quotes/:id')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async updateQuote(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteUpdateInputSchema)) dto: QuoteUpdateInput,
  ): Promise<{ ok: true }> {
    return this.quotes.updateDraft(id, dto, user.userId);
  }

  @Post('quotes/:id/attachments')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async attach(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteAttachmentInputSchema)) dto: QuoteAttachmentInput,
  ): Promise<{ id: string }> {
    return this.quotes.attachFile(id, dto, user.userId);
  }

  @Post('quotes/:id/submit')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ submissionHash: string; short: string }> {
    return this.quotes.submit(id, user.userId);
  }

  @Post('quotes/:id/withdraw')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(QuoteWithdrawInputSchema)) dto: QuoteWithdrawInput,
  ): Promise<{ ok: true }> {
    return this.quotes.withdraw(id, dto.reason, user.userId);
  }

  @Post('rfq/:id/reverse-auction/bid')
  @RequirePermission(PERMISSIONS.VENDOR_QUOTE_MANAGE)
  async bid(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ReverseAuctionBidInputSchema))
    dto: ReverseAuctionBidInput,
    @Param('id') _id: string,
  ): Promise<{ accepted: true; extended: boolean }> {
    return this.reverseAuction.submitBidAsUser(dto.roundId, dto, user.userId);
  }

  @Sse('rfq/:id/reverse-auction/:roundId/leaderboard/stream')
  @RequireAudience('vendor')
  @RequirePermission(PERMISSIONS.VENDOR_RFQ_READ)
  stream(
    @CurrentUser() user: AuthUser,
    @Param('roundId') roundId: string,
  ): Observable<MessageEvent> {
    return this.reverseAuction.streamForUser(
      roundId,
      user.userId,
    ) as unknown as Observable<MessageEvent>;
  }
}
