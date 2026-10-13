import { Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsPayoutService } from "./operations-payout.service";

type MarkPaidBody = {
  week?: string;
  payeeKey?: string;
  mpesaCode?: string;
  note?: string;
  expectedAmountKsh?: number;
};

/** 周结付款: the weekly payout sheet and recording a hand-sent M-Pesa payment. */
@Controller("operations/payouts")
export class OperationsPayoutController {
  constructor(
    private readonly payouts: OperationsPayoutService,
    private readonly access: OperationsAccessService
  ) {}

  /** `week` is any Nairobi date (YYYY-MM-DD) inside the week; default last week. */
  @Get("sheet")
  async sheet(@Headers("authorization") authorization?: string, @Query("week") week?: string) {
    return this.payouts.weeklySheet({ adminUserId: await this.access.requireAccessToken(authorization), week });
  }

  @Post("mark-paid")
  async markPaid(@Headers("authorization") authorization: string | undefined, @Body() body: MarkPaidBody) {
    return this.payouts.markPaid({
      week: body?.week,
      payeeKey: body?.payeeKey,
      mpesaCode: body?.mpesaCode,
      note: body?.note,
      expectedAmountKsh: body?.expectedAmountKsh,
      adminUserId: await this.access.requireAccessToken(authorization)
    });
  }
}
