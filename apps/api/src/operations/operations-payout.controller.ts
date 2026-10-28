import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsPayoutBatchService } from "./operations-payout-batch.service";
import { OperationsPayoutService } from "./operations-payout.service";

type MarkPaidBody = {
  week?: string;
  payeeKey?: string;
  mpesaCode?: string;
  note?: string;
  expectedAmountKsh?: number;
};

/** 周结付款: the weekly payout sheet, a hand-sent M-Pesa payment, and M-Pesa bulk files. */
@Controller("operations/payouts")
export class OperationsPayoutController {
  constructor(
    private readonly payouts: OperationsPayoutService,
    private readonly batches: OperationsPayoutBatchService,
    private readonly access: OperationsAccessService
  ) {}

  /** `week` is any Nairobi date (YYYY-MM-DD) inside the week; default last week. */
  @Get("sheet")
  async sheet(@Headers("authorization") authorization?: string, @Query("week") week?: string) {
    return this.payouts.weeklySheet({ adminUserId: await this.access.requireAccessToken(authorization), week });
  }

  /**
   * 导出: the payment list, every confirmed and unpaid promoter commission from every week.
   * `summary=true` returns only the people and amount. Read-only.
   */
  @Get("export")
  async exportList(@Headers("authorization") authorization?: string, @Query("summary") summary?: string) {
    return this.payouts.exportList({ adminUserId: await this.access.requireAccessToken(authorization), summaryOnly: summary });
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

  /** 导出 M-Pesa 批量付款文件: creates a batch and returns the file (base64). */
  @Post("batches")
  async exportBatch(@Headers("authorization") authorization: string | undefined, @Body() body: { week?: string; format?: string }) {
    return this.batches.exportBatch({ week: body?.week, format: body?.format, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  /** The same file again. */
  @Get("batches/:id/file")
  async batchFile(@Headers("authorization") authorization: string | undefined, @Param("id") id: string, @Query("format") format?: string) {
    return this.batches.batchFile({ batchId: id, format, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  /** 作废这批导出 (or, with pendingOnly, release the people still waiting). */
  @Post("batches/:id/cancel")
  async cancelBatch(@Headers("authorization") authorization: string | undefined, @Param("id") id: string, @Body() body: { pendingOnly?: boolean }) {
    return this.batches.cancelBatch({ batchId: id, pendingOnly: body?.pendingOnly === true, adminUserId: await this.access.requireAccessToken(authorization) });
  }

  /** 上传 M-Pesa 结果文件: `contentBase64` is the .xlsx / .csv the portal produced. */
  @Post("batches/:id/results")
  async reconcile(@Headers("authorization") authorization: string | undefined, @Param("id") id: string, @Body() body: { fileName?: string; contentBase64?: string }) {
    return this.batches.reconcile({
      batchId: id,
      fileName: body?.fileName,
      contentBase64: body?.contentBase64,
      adminUserId: await this.access.requireAccessToken(authorization)
    });
  }
}
